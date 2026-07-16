#include "noveltea/script/typed_runtime_session.hpp"

#include "noveltea/script/typed_execution_kernel.hpp"

#include "noveltea/core/runtime_diagnostic_context.hpp"
#include "noveltea/core/save_state_codec.hpp"
#include "noveltea/script/script_runtime.hpp"

#include <algorithm>
#include <chrono>
#include <limits>
#include <cmath>
#include <type_traits>

namespace noveltea::script {
namespace {

template<class> inline constexpr bool always_false = false;

core::Diagnostics as_diagnostics(TypedExecutionError error)
{
    if (auto* diagnostics = std::get_if<core::Diagnostics>(&error))
        return std::move(*diagnostics);
    return {core::Diagnostic{.code = "runtime.script_failed",
                             .message = std::get<ScriptError>(error).message}};
}

template<class T> const T* active_blocker(const TypedExecutionKernel& kernel)
{
    return kernel.state().blocker() ? std::get_if<T>(&*kernel.state().blocker()) : nullptr;
}

bool is_gameplay_advancement(const core::RuntimeInputMessage& input) noexcept
{
    return std::visit(
        [](const auto& value) {
            using T = std::decay_t<decltype(value)>;
            return std::is_same_v<T, core::StartRuntimeInput> ||
                   std::is_same_v<T, core::AdvanceTimeInput> ||
                   std::is_same_v<T, core::ContinueInput> ||
                   std::is_same_v<T, core::SelectSceneChoiceInput> ||
                   std::is_same_v<T, core::SelectDialogueChoiceInput> ||
                   std::is_same_v<T, core::NavigateRoomInput> ||
                   std::is_same_v<T, core::InvokeInteractionInput>;
        },
        input);
}

void attach_runtime_context(core::Diagnostics& diagnostics, const TypedExecutionKernel& kernel)
{
    if (kernel.state().flow_stack().empty())
        return;
    const auto frame = core::flow_frame_id(kernel.state().flow_stack().back());
    for (auto& diagnostic : diagnostics) {
        if (!diagnostic.runtime_context)
            diagnostic.runtime_context = std::make_shared<const core::RuntimeDiagnosticContext>(
                core::RuntimeDiagnosticContext{
                    core::RuntimeDiagnosticContextValue{core::FlowFrameRuntimeContext{frame}}});
    }
}

} // namespace

TypedRuntimeSession::TypedRuntimeSession(
    const core::CompiledProject& project, ScriptRuntime& runtime, core::TypedSaveSlotStore& saves,
    std::unique_ptr<TypedExecutionKernel> kernel, std::string runtime_locale,
    runtime::RuntimeBudgetConfiguration runtime_budget) noexcept
    : m_project(project), m_runtime(runtime), m_saves(saves), m_checkpoint_service(project, saves),
      m_kernel(std::move(kernel)), m_runtime_budget(runtime_budget),
      m_runtime_locale(std::move(runtime_locale))
{
    m_script_api.replace_target(this);
    m_runtime.bind_runtime_script_api(&m_script_api);
}

TypedRuntimeSession::~TypedRuntimeSession()
{
    m_deferred_commands.clear();
    m_script_api.clear_target();
    m_runtime.clear_typed_host();
}

void TypedRuntimeSession::begin_dispatch_transaction() noexcept { ++m_dispatch_transaction_depth; }

void TypedRuntimeSession::record_structural_mutation() noexcept
{
    m_transaction_mutations.structural = true;
}

void TypedRuntimeSession::record_time_mutation(std::chrono::milliseconds elapsed) noexcept
{
    if (elapsed.count() <= 0)
        return;
    m_transaction_mutations.time = true;
    if (elapsed.count() <=
        std::numeric_limits<std::int64_t>::max() - m_transaction_mutations.elapsed.count())
        m_transaction_mutations.elapsed += elapsed;
}

const core::SessionState& TypedRuntimeSession::presentation_state() const noexcept
{
    return m_kernel->state();
}

core::Diagnostics TypedRuntimeSession::settle_dispatch_transaction()
{
    if (m_dispatch_transaction_depth == 0)
        return {diagnostic("checkpoint.transaction_not_active",
                           "Runtime dispatch transaction is not active")};
    if (--m_dispatch_transaction_depth != 0)
        return {};
    if (m_skip_next_checkpoint_settlement) {
        m_skip_next_checkpoint_settlement = false;
        m_transaction_mutations = {};
        return {};
    }
    RuntimeCheckpointFacts facts{
        .input_queue_settled = true,
        .output_queue_settled = true,
        .script_input_queue_settled = m_script_inputs.empty(),
        .deferred_command_queue_settled = m_deferred_commands.empty(),
        .presentation_acknowledgements_settled = true,
        .immediate_script_invocation_active = false,
        .flow_blocker = m_kernel->state().blocker(),
        .presentation_status =
            m_presentation_status_provider
                ? m_presentation_status_provider()
                : core::PresentationCheckpointStatus{core::CheckpointStatusRevision::from_number(1),
                                                     {}},
    };
    const auto mutations = m_transaction_mutations;
    m_transaction_mutations = {};
    auto settled = m_checkpoint_service.settle(m_kernel->state(), facts, mutations);
    return settled ? core::Diagnostics{} : std::move(settled).error();
}

void TypedRuntimeSession::queue_script_input(core::RuntimeInputMessage input)
{
    m_script_inputs.push_back(std::move(input));
}

core::Result<core::ProjectDefinitionSummary, core::Diagnostics>
TypedRuntimeSession::script_definition(core::ProjectDefinitionKind kind, std::string id) const
{
    return m_kernel->host().definition(kind, std::move(id));
}

core::Result<core::RuntimeValue, core::Diagnostics>
TypedRuntimeSession::script_variable(const core::VariableId& id) const
{
    return m_kernel->host().variable(id);
}

core::Result<void, core::Diagnostics>
TypedRuntimeSession::script_set_variable(const core::VariableId& id, core::RuntimeValue value)
{
    const auto before = m_kernel->host().variable(id);
    auto changed = m_kernel->host().set_variable(id, std::move(value));
    if (changed) {
        const auto after = m_kernel->host().variable(id);
        const auto* before_value = before.value_if();
        const auto* after_value = after.value_if();
        if (before_value == nullptr || after_value == nullptr || *after_value != *before_value)
            record_structural_mutation();
    }
    return changed;
}

core::Result<core::PropertyLookupResult, core::Diagnostics>
TypedRuntimeSession::script_property(const core::PropertyOwnerRef& owner,
                                     const core::PropertyId& property) const
{
    return m_kernel->host().property(owner, property);
}

core::Result<void, core::Diagnostics>
TypedRuntimeSession::script_set_property(core::PropertyOwnerRef owner, core::PropertyId property,
                                         core::RuntimeValue value)
{
    const auto* before = m_kernel->state().property_override(owner, property);
    const auto before_value = before ? std::optional<core::RuntimeValue>{*before} : std::nullopt;
    auto changed = m_kernel->host().set_property(owner, property, std::move(value));
    const auto* after = m_kernel->state().property_override(owner, property);
    if (changed &&
        before_value != (after ? std::optional<core::RuntimeValue>{*after} : std::nullopt))
        record_structural_mutation();
    return changed;
}

core::Result<void, core::Diagnostics>
TypedRuntimeSession::script_unset_property(const core::PropertyOwnerRef& owner,
                                           const core::PropertyId& property)
{
    const bool existed = m_kernel->state().property_override(owner, property) != nullptr;
    auto changed = m_kernel->host().unset_property(owner, property);
    if (changed && existed)
        record_structural_mutation();
    return changed;
}

core::Result<core::compiled::InteractableLocation, core::Diagnostics>
TypedRuntimeSession::script_interactable_location(const core::InteractableId& interactable) const
{
    return m_kernel->host().interactable_location(interactable);
}

core::Result<void, core::Diagnostics> TypedRuntimeSession::script_request_interactable_location(
    core::InteractableId interactable, core::compiled::InteractableLocation target)
{
    return m_kernel->host().request_interactable_location(std::move(interactable),
                                                          std::move(target));
}

core::Result<void, core::Diagnostics>
TypedRuntimeSession::script_request_navigation(core::compiled::RoomExitRef exit)
{
    return m_kernel->host().request_navigation(std::move(exit));
}

core::Result<void, core::Diagnostics>
TypedRuntimeSession::script_request_transient(core::SceneId scene)
{
    return m_kernel->host().request_transient(std::move(scene));
}

core::Result<void, core::Diagnostics>
TypedRuntimeSession::script_request_transient(core::DialogueId dialogue)
{
    return m_kernel->host().request_transient(std::move(dialogue));
}

core::Result<void, core::Diagnostics> TypedRuntimeSession::script_request_child(core::SceneId scene)
{
    return m_kernel->host().request_child(std::move(scene));
}

core::Result<void, core::Diagnostics>
TypedRuntimeSession::script_request_child(core::DialogueId dialogue)
{
    return m_kernel->host().request_child(std::move(dialogue));
}

core::Result<void, core::Diagnostics>
TypedRuntimeSession::script_request_tail_replacement(core::FlowTarget target)
{
    return m_kernel->host().request_tail_replacement(std::move(target));
}

core::Result<void, core::Diagnostics>
TypedRuntimeSession::script_request_notification(std::string message)
{
    auto requested = m_kernel->host().request_notification(std::move(message));
    if (!requested)
        return requested;
    stage_host_events();
    return core::Result<void, core::Diagnostics>::success();
}

core::Result<void, core::Diagnostics> TypedRuntimeSession::script_seed_random(std::uint64_t seed)
{
    const auto before = m_kernel->state().random_state();
    m_kernel->state().seed_random(seed);
    if (before != seed)
        record_structural_mutation();
    return core::Result<void, core::Diagnostics>::success();
}

core::Result<std::int64_t, core::Diagnostics>
TypedRuntimeSession::script_random_integer(std::int64_t minimum, std::int64_t maximum)
{
    auto result = m_kernel->state().next_random_integer(minimum, maximum);
    if (result)
        record_structural_mutation();
    return result;
}

core::Result<double, core::Diagnostics> TypedRuntimeSession::script_random_unit()
{
    const auto value = m_kernel->state().next_random_unit();
    record_structural_mutation();
    return core::Result<double, core::Diagnostics>::success(value);
}

core::Result<void, core::Diagnostics> TypedRuntimeSession::script_present_map(
    core::MapId map, std::optional<core::compiled::InitialMapMode> mode, bool visible,
    std::optional<core::MapLocationId> focused_location)
{
    const auto before = m_kernel->state().map_presentation();
    auto changed = m_kernel->present_map(map, mode, visible, std::move(focused_location));
    const auto& after = m_kernel->state().map_presentation();
    const auto equal = [](const auto& left, const auto& right) {
        return left.map == right.map && left.mode == right.mode && left.visible == right.visible &&
               left.focused_location == right.focused_location;
    };
    if (changed && (!before || !after || !equal(*before, *after)))
        record_structural_mutation();
    return changed;
}

core::Result<void, core::Diagnostics> TypedRuntimeSession::script_hide_map()
{
    const auto before = m_kernel->state().map_presentation();
    auto changed = m_kernel->hide_map();
    const auto& after = m_kernel->state().map_presentation();
    if (changed && before && after && before->visible != after->visible)
        record_structural_mutation();
    return changed;
}

core::Result<void, core::Diagnostics>
TypedRuntimeSession::script_select_map_location(core::MapLocationId location)
{
    const auto before = m_kernel->state().map_presentation();
    auto selected = m_kernel->select_map_location(location, m_runtime_locale);
    const auto& after = m_kernel->state().map_presentation();
    if (selected && before && after && before->focused_location != after->focused_location)
        record_structural_mutation();
    return selected ? core::Result<void, core::Diagnostics>::success()
                    : core::Result<void, core::Diagnostics>::failure(
                          as_diagnostics(std::move(selected).error()));
}

core::Result<void, core::Diagnostics>
TypedRuntimeSession::script_activate_map_connection(core::MapConnectionId connection)
{
    auto view = m_kernel->map_view(m_runtime_locale);
    auto* map = view.value_if();
    if (map == nullptr)
        return core::Result<void, core::Diagnostics>::failure(
            as_diagnostics(std::move(view).error()));
    const auto selected = std::find_if(map->connections.begin(), map->connections.end(),
                                       [&connection](const core::MapConnectionView& candidate) {
                                           return candidate.connection == connection;
                                       });
    if (!map->visible || !map->current_room || selected == map->connections.end() ||
        !selected->selectable) {
        return core::Result<void, core::Diagnostics>::failure(core::Diagnostics{
            diagnostic("runtime.map_connection_unavailable",
                       "Selected Map connection is not an enabled exit from the active Room")});
    }
    return m_kernel->host().request_navigation(selected->exit);
}

core::Result<core::MapPresentationState, core::Diagnostics>
TypedRuntimeSession::script_map_state() const
{
    if (!m_kernel->state().map_presentation())
        return core::Result<core::MapPresentationState, core::Diagnostics>::failure(
            core::Diagnostics{
                diagnostic("runtime.map_not_presented", "No typed Map presentation is active")});
    return core::Result<core::MapPresentationState, core::Diagnostics>::success(
        *m_kernel->state().map_presentation());
}

core::Result<std::optional<core::LayoutId>, core::Diagnostics>
TypedRuntimeSession::script_layout(core::compiled::LayoutSlot slot) const
{
    return m_kernel->state().layout(slot);
}

core::Result<void, core::Diagnostics>
TypedRuntimeSession::script_set_layout(core::compiled::LayoutSlot slot, core::LayoutId layout)
{
    const auto before = m_kernel->state().layout(slot);
    auto changed = m_kernel->state().set_layout(m_project, slot, std::move(layout));
    const auto after = m_kernel->state().layout(slot);
    if (changed && before && after && *before.value_if() != *after.value_if())
        record_structural_mutation();
    return changed;
}

core::Result<void, core::Diagnostics>
TypedRuntimeSession::script_clear_layout(core::compiled::LayoutSlot slot)
{
    const auto before = m_kernel->state().layout(slot);
    auto changed = m_kernel->state().clear_layout(slot);
    if (changed && before && before.value_if()->has_value())
        record_structural_mutation();
    return changed;
}

core::Result<bool, core::Diagnostics> TypedRuntimeSession::script_gameplay_paused() const
{
    return core::Result<bool, core::Diagnostics>::success(m_kernel->state().gameplay_paused());
}

core::Result<void, core::Diagnostics> TypedRuntimeSession::script_set_gameplay_paused(bool paused)
{
    m_kernel->state().set_gameplay_paused(paused);
    return core::Result<void, core::Diagnostics>::success();
}

core::Result<void, core::Diagnostics> TypedRuntimeSession::script_request_audio(
    core::compiled::AudioAction action, core::compiled::AudioChannel channel,
    std::optional<core::AssetId> asset, std::chrono::milliseconds fade, bool loop, double volume,
    bool await_completion)
{
    if (action > core::compiled::AudioAction::FadeOut ||
        channel > core::compiled::AudioChannel::Ambient || fade.count() < 0 ||
        !std::isfinite(volume) || volume < 0.0 || volume > 1.0) {
        return core::Result<void, core::Diagnostics>::failure(core::Diagnostics{diagnostic(
            "runtime.invalid_audio_request", "Typed audio request contains an invalid value")});
    }
    const bool playing = action == core::compiled::AudioAction::Play ||
                         action == core::compiled::AudioAction::FadeIn;
    if ((playing && !asset) || (!playing && asset)) {
        return core::Result<void, core::Diagnostics>::failure(core::Diagnostics{
            diagnostic("runtime.invalid_audio_request",
                       playing ? "Typed audio playback requires an Asset"
                               : "Typed audio stop requests must not include an Asset")});
    }
    if (playing) {
        const auto* definition = m_project.find_asset(*asset);
        if (definition == nullptr || definition->kind != core::compiled::AssetKind::Audio) {
            return core::Result<void, core::Diagnostics>::failure(core::Diagnostics{
                diagnostic("runtime.invalid_audio_asset",
                           "Typed audio playback requires an existing audio Asset ID")});
        }
        if (m_pending_audio) {
            return core::Result<void, core::Diagnostics>::failure(core::Diagnostics{diagnostic(
                "runtime.audio_operation_pending",
                "A blocking audio operation must finish before starting replacement playback")});
        }
    }

    const core::ScriptFlowBlocker* script_blocker = nullptr;
    if (await_completion) {
        script_blocker = active_blocker<core::ScriptFlowBlocker>(*m_kernel);
        if (script_blocker == nullptr || m_pending_audio) {
            return core::Result<void, core::Diagnostics>::failure(core::Diagnostics{diagnostic(
                "runtime.audio_wait_unavailable",
                "Awaited typed audio requires one active Lua invocation and no pending audio")});
        }
    }

    auto changed = m_kernel->state().set_audio_channel(
        m_project,
        core::AudioChannelState{channel, playing ? asset : std::nullopt, volume, loop, playing});
    if (!changed)
        return changed;
    record_structural_mutation();

    core::AudioOperation operation{
        .id = core::AudioOperationId::from_number(m_next_audio_id++),
        .action = action,
        .channel = channel,
        .asset = std::move(asset),
        .fade = fade,
        .loop = loop,
        .volume = volume,
        .owner =
            script_blocker ? std::optional<core::FlowFrameId>{script_blocker->owner} : std::nullopt,
        .completion = script_blocker
                          ? std::optional<core::AudioCompletionHandle>{core::AudioCompletionHandle{
                                script_blocker->handle}}
                          : std::nullopt};
    if (script_blocker)
        m_pending_audio = operation;
    stage_host_events();
    m_pending_emissions.emplace_back(core::RuntimeOutputMessage{std::move(operation)});
    return core::Result<void, core::Diagnostics>::success();
}

core::Result<std::optional<core::AudioChannelState>, core::Diagnostics>
TypedRuntimeSession::script_audio_channel(core::compiled::AudioChannel channel) const
{
    if (channel > core::compiled::AudioChannel::Ambient)
        return core::Result<std::optional<core::AudioChannelState>, core::Diagnostics>::failure(
            core::Diagnostics{
                diagnostic("runtime.invalid_audio_channel", "Typed audio channel is invalid")});
    const auto& channels = m_kernel->state().audio_channels();
    const auto found = std::find_if(
        channels.begin(), channels.end(),
        [channel](const core::AudioChannelState& value) { return value.channel == channel; });
    return core::Result<std::optional<core::AudioChannelState>, core::Diagnostics>::success(
        found == channels.end() ? std::nullopt : std::optional<core::AudioChannelState>{*found});
}

core::Result<void, core::Diagnostics>
TypedRuntimeSession::script_append_text_log(core::TextLogEntry entry)
{
    auto changed = m_kernel->state().append_text_log(m_project, std::move(entry));
    if (changed)
        record_structural_mutation();
    return changed;
}

core::Result<void, core::Diagnostics> TypedRuntimeSession::script_clear_text_log()
{
    const bool changed = !m_kernel->state().text_log().empty();
    m_kernel->state().clear_text_log();
    if (changed)
        record_structural_mutation();
    return core::Result<void, core::Diagnostics>::success();
}

core::Result<std::unique_ptr<TypedRuntimeSession>, core::Diagnostics>
TypedRuntimeSession::create(const core::CompiledProject& project, ScriptRuntime& runtime,
                            core::TypedSaveSlotStore& saves, std::string runtime_locale,
                            runtime::RuntimeBudgetConfiguration runtime_budget)
{
    if (runtime_budget.instruction_limit == 0 || runtime_budget.command_limit == 0) {
        return core::Result<std::unique_ptr<TypedRuntimeSession>, core::Diagnostics>::failure(
            {core::Diagnostic{.code = "runtime.invalid_budget",
                              .message =
                                  "Runtime instruction and command budgets must be positive"}});
    }
    auto kernel = TypedExecutionKernel::create(project, runtime);
    if (!kernel)
        return core::Result<std::unique_ptr<TypedRuntimeSession>, core::Diagnostics>::failure(
            std::move(kernel).error());
    return core::Result<std::unique_ptr<TypedRuntimeSession>, core::Diagnostics>::success(
        std::unique_ptr<TypedRuntimeSession>(
            new TypedRuntimeSession(project, runtime, saves, std::move(*kernel.value_if()),
                                    std::move(runtime_locale), runtime_budget)));
}

core::Diagnostic TypedRuntimeSession::diagnostic(std::string code, std::string message) const
{
    return core::Diagnostic{.code = std::move(code), .message = std::move(message)};
}

core::Diagnostics TypedRuntimeSession::run_kernel(std::vector<core::RuntimeOutputMessage>& outputs,
                                                  std::vector<runtime::RuntimeEvent>& events,
                                                  std::vector<std::size_t>& event_output_offsets)
{
    auto diagnostics = run_kernel_once(outputs, events, event_output_offsets);
    if (diagnostics.empty()) {
        drain_deferred_commands(outputs, events, event_output_offsets, diagnostics);
    } else {
        m_deferred_commands.clear();
    }
    return diagnostics;
}

core::Diagnostics
TypedRuntimeSession::run_kernel_once(std::vector<core::RuntimeOutputMessage>& outputs,
                                     std::vector<runtime::RuntimeEvent>& events,
                                     std::vector<std::size_t>& event_output_offsets)
{
    core::Diagnostics diagnostics;
    const bool execution_can_advance =
        std::holds_alternative<core::FlowMode>(m_kernel->state().mode()) &&
        !m_kernel->state().blocker() && !m_kernel->state().gameplay_paused();
    const auto outcome =
        m_kernel->run_until_blocked(m_runtime_budget.instruction_limit, m_runtime_locale);
    if (const auto* fault = std::get_if<core::FlowFaultOutcome>(&outcome))
        diagnostics = fault->diagnostics;

    collect_runtime_actions(diagnostics);
    drain_pending_emissions(outputs, events, event_output_offsets);

    if (const auto* blocker = active_blocker<core::PresentationFlowBlocker>(*m_kernel)) {
        if (const auto& transition = m_kernel->state().transition()) {
            const bool already_pending = m_pending_presentation &&
                                         m_pending_presentation->completion &&
                                         *m_pending_presentation->completion == blocker->handle;
            if (!already_pending) {
                core::TransitionPresentationOperation operation{
                    .id = core::PresentationOperationId::from_number(m_next_presentation_id++),
                    .kind = transition->kind,
                    .duration = std::chrono::milliseconds{0},
                    .color = transition->color,
                    .owner = blocker->owner,
                    .completion = blocker->handle};
                m_pending_presentation = operation;
                outputs.emplace_back(core::PresentationOperation{operation});
            }
        }
    }
    if (const auto* blocker = active_blocker<core::AudioFlowBlocker>(*m_kernel)) {
        const auto& channels = m_kernel->state().audio_channels();
        if (!channels.empty()) {
            const auto& channel = channels.back();
            const auto* pending_handle =
                m_pending_audio && m_pending_audio->completion
                    ? std::get_if<core::AudioFlowBlockerHandle>(&*m_pending_audio->completion)
                    : nullptr;
            const bool already_pending = pending_handle && *pending_handle == blocker->handle;
            if (!already_pending) {
                core::AudioOperation operation{
                    .id = core::AudioOperationId::from_number(m_next_audio_id++),
                    .action = channel.playing ? core::compiled::AudioAction::Play
                                              : core::compiled::AudioAction::Stop,
                    .channel = channel.channel,
                    .asset = channel.asset,
                    .loop = channel.loop,
                    .volume = channel.volume,
                    .owner = blocker->owner,
                    .completion = blocker->handle};
                m_pending_audio = operation;
                outputs.emplace_back(operation);
            }
        }
    }
    drain_script_inputs(outputs, events, event_output_offsets, diagnostics);
    if (diagnostics.empty() && execution_can_advance)
        record_structural_mutation();
    return diagnostics;
}

void TypedRuntimeSession::stage_host_events()
{
    for (auto& event : m_kernel->host().take_events())
        m_pending_emissions.emplace_back(std::move(event));
}

void TypedRuntimeSession::drain_pending_emissions(std::vector<core::RuntimeOutputMessage>& outputs,
                                                  std::vector<runtime::RuntimeEvent>& events,
                                                  std::vector<std::size_t>& event_output_offsets)
{
    for (auto& emission : m_pending_emissions) {
        std::visit(
            [&](auto&& value) {
                using T = std::decay_t<decltype(value)>;
                if constexpr (std::is_same_v<T, core::RuntimeOutputMessage>) {
                    outputs.push_back(std::move(value));
                } else if constexpr (std::is_same_v<T, runtime::RuntimeEvent>) {
                    events.push_back(std::move(value));
                    event_output_offsets.push_back(outputs.size());
                } else {
                    static_assert(always_false<T>, "Unhandled pending runtime emission");
                }
            },
            emission);
    }
    m_pending_emissions.clear();
}

void TypedRuntimeSession::drain_script_inputs(std::vector<core::RuntimeOutputMessage>& outputs,
                                              std::vector<runtime::RuntimeEvent>& events,
                                              std::vector<std::size_t>& event_output_offsets,
                                              core::Diagnostics& diagnostics)
{
    if (m_draining_script_inputs || m_script_inputs.empty())
        return;
    m_draining_script_inputs = true;
    constexpr std::size_t kScriptInputBudget = 1024;
    std::size_t processed = 0;
    while (!m_script_inputs.empty() && processed < kScriptInputBudget) {
        auto pending = std::move(m_script_inputs);
        m_script_inputs.clear();
        for (std::size_t index = 0; index < pending.size(); ++index) {
            if (processed >= kScriptInputBudget) {
                m_script_inputs.insert(m_script_inputs.begin(),
                                       std::make_move_iterator(pending.begin() + index),
                                       std::make_move_iterator(pending.end()));
                break;
            }
            ++processed;
            auto applied = apply(pending[index]);
            const auto output_base = outputs.size();
            outputs.insert(outputs.end(), std::make_move_iterator(applied.outputs.begin()),
                           std::make_move_iterator(applied.outputs.end()));
            for (const auto offset : applied.event_output_offsets)
                event_output_offsets.push_back(output_base + offset);
            events.insert(events.end(), std::make_move_iterator(applied.events.begin()),
                          std::make_move_iterator(applied.events.end()));
            core::append_diagnostics(diagnostics, std::move(applied.diagnostics));
        }
    }
    if (!m_script_inputs.empty()) {
        diagnostics.push_back(
            diagnostic("runtime.script_input_budget_exhausted",
                       "Script-issued runtime commands exceeded the per-drain operation budget"));
    }
    m_draining_script_inputs = false;
}

void TypedRuntimeSession::collect_runtime_actions(core::Diagnostics& diagnostics)
{
    for (auto& action : m_kernel->host().take_actions()) {
        std::visit(
            [&](auto&& value) {
                using T = std::decay_t<decltype(value)>;
                if constexpr (std::is_same_v<T, runtime::DeferredRuntimeCommandRequest>) {
                    auto queued = m_deferred_commands.enqueue(std::move(value));
                    if (!queued)
                        core::append_diagnostics(diagnostics, std::move(queued).error());
                } else if constexpr (std::is_same_v<T, runtime::RuntimeEvent>) {
                    m_pending_emissions.emplace_back(std::move(value));
                } else {
                    static_assert(always_false<T>, "Unhandled ScriptRuntimeAction");
                }
            },
            action);
    }
}

bool TypedRuntimeSession::source_owner_is_current(
    const runtime::DeferredRuntimeCommand& command) const noexcept
{
    if (std::holds_alternative<runtime::RequestAutosaveCommand>(command.payload) ||
        !command.source.frame)
        return true;
    return !m_kernel->state().flow_stack().empty() &&
           core::flow_frame_id(m_kernel->state().flow_stack().back()) == *command.source.frame;
}

void TypedRuntimeSession::attach_command_context(
    core::Diagnostics& diagnostics, const runtime::DeferredRuntimeCommand& command) const
{
    if (!command.source.diagnostic)
        return;
    for (auto& item : diagnostics) {
        if (!item.runtime_context)
            item.runtime_context =
                std::make_shared<const core::RuntimeDiagnosticContext>(*command.source.diagnostic);
    }
}

core::Diagnostics
TypedRuntimeSession::execute_deferred_command(const runtime::DeferredRuntimeCommand& command)
{
    if (!source_owner_is_current(command)) {
        core::Diagnostics diagnostics{
            diagnostic("runtime.stale_command_source",
                       "Deferred runtime command source frame is stale or no longer active")};
        attach_command_context(diagnostics, command);
        return diagnostics;
    }

    core::Diagnostics diagnostics;
    std::visit(
        [&](const auto& payload) {
            using T = std::decay_t<decltype(payload)>;
            if constexpr (std::is_same_v<T, runtime::MoveInteractableCommand>) {
                auto changed = m_kernel->state().move_interactable(m_project, payload.interactable,
                                                                   payload.target);
                if (!changed)
                    diagnostics = std::move(changed).error();
            } else if constexpr (std::is_same_v<T, runtime::NavigateRoomCommand>) {
                auto changed = m_kernel->navigate(payload.exit.exit_id);
                if (!changed)
                    diagnostics = std::move(changed).error();
            } else if constexpr (std::is_same_v<T, runtime::StartTransientSceneCommand>) {
                auto changed = m_kernel->start_transient(payload.scene);
                if (!changed)
                    diagnostics = std::move(changed).error();
            } else if constexpr (std::is_same_v<T, runtime::StartTransientDialogueCommand>) {
                auto changed = m_kernel->start_transient(payload.dialogue);
                if (!changed)
                    diagnostics = std::move(changed).error();
            } else if constexpr (std::is_same_v<T, runtime::CallChildSceneCommand>) {
                if (m_kernel->state().flow_stack().empty())
                    diagnostics.push_back(diagnostic("runtime.invalid_child_request",
                                                     "Child Scene requires an active flow frame"));
                else {
                    auto changed = m_kernel->flow().call_child(
                        payload.scene,
                        core::flow_frame_position(m_kernel->state().flow_stack().back()));
                    if (!changed)
                        diagnostics = std::move(changed).error();
                }
            } else if constexpr (std::is_same_v<T, runtime::CallChildDialogueCommand>) {
                if (m_kernel->state().flow_stack().empty())
                    diagnostics.push_back(
                        diagnostic("runtime.invalid_child_request",
                                   "Child Dialogue requires an active flow frame"));
                else {
                    auto changed = m_kernel->flow().call_child(
                        payload.dialogue, payload.start_block,
                        core::flow_frame_position(m_kernel->state().flow_stack().back()));
                    if (!changed)
                        diagnostics = std::move(changed).error();
                }
            } else if constexpr (std::is_same_v<T, runtime::TailReplaceFlowCommand>) {
                auto changed = m_kernel->flow().apply_target(payload.target);
                if (!changed)
                    diagnostics = std::move(changed).error();
            } else if constexpr (std::is_same_v<T, runtime::RequestAutosaveCommand>) {
                (void)m_checkpoint_service.request(core::DeferredAutosaveRequest{});
            } else {
                static_assert(always_false<T>, "Unhandled DeferredRuntimeCommandPayload");
            }
        },
        command.payload);
    if (!diagnostics.empty()) {
        attach_command_context(diagnostics, command);
        return diagnostics;
    }
    if (!std::holds_alternative<runtime::RequestAutosaveCommand>(command.payload))
        record_structural_mutation();
    return diagnostics;
}

void TypedRuntimeSession::drain_deferred_commands(std::vector<core::RuntimeOutputMessage>& outputs,
                                                  std::vector<runtime::RuntimeEvent>& events,
                                                  std::vector<std::size_t>& event_output_offsets,
                                                  core::Diagnostics& diagnostics)
{
    if (m_draining_deferred_commands || m_deferred_commands.empty())
        return;
    m_draining_deferred_commands = true;
    std::size_t processed = 0;
    while (!m_deferred_commands.empty() && processed < m_runtime_budget.command_limit) {
        auto command = m_deferred_commands.pop_front();
        if (!command)
            break;
        ++processed;
        auto executed = execute_deferred_command(*command);
        if (!executed.empty()) {
            core::append_diagnostics(diagnostics, std::move(executed));
            m_deferred_commands.clear();
            break;
        }
        if (!std::holds_alternative<runtime::RequestAutosaveCommand>(command->payload)) {
            auto continued = run_kernel_once(outputs, events, event_output_offsets);
            if (!continued.empty()) {
                core::append_diagnostics(diagnostics, std::move(continued));
                m_deferred_commands.clear();
                break;
            }
        }
    }
    if (!m_deferred_commands.empty()) {
        diagnostics.push_back(
            diagnostic("runtime.command_budget_exhausted",
                       "Deferred runtime commands exceeded the per-transaction command budget"));
        m_deferred_commands.clear();
    }
    m_draining_deferred_commands = false;
}

core::Diagnostics TypedRuntimeSession::complete_presentation(
    core::PresentationOperationId operation, const core::FlowFrameId& owner,
    const core::PresentationFlowBlockerHandle& completion, bool cancel)
{
    if (!m_pending_presentation || m_pending_presentation->id != operation ||
        !m_pending_presentation->completion || *m_pending_presentation->completion != completion)
        return {diagnostic("runtime.stale_presentation_completion",
                           "Presentation completion does not match the pending operation")};
    auto result = cancel ? m_kernel->cancel(owner, core::AnyFlowBlockerHandle{completion})
                         : m_kernel->complete(owner, core::AnyFlowBlockerHandle{completion});
    if (!result)
        return std::move(result).error();
    m_pending_presentation.reset();
    record_structural_mutation();
    return {};
}

core::Diagnostics TypedRuntimeSession::complete_audio(core::AudioOperationId operation,
                                                      const core::FlowFrameId& owner,
                                                      const core::AudioCompletionHandle& completion,
                                                      bool cancel)
{
    if (!m_pending_audio || m_pending_audio->id != operation || !m_pending_audio->completion ||
        !m_pending_audio->owner || *m_pending_audio->owner != owner ||
        *m_pending_audio->completion != completion)
        return {diagnostic("runtime.stale_audio_completion",
                           "Audio completion does not match the pending operation")};
    m_pending_audio.reset();
    core::Diagnostics diagnostics;
    std::visit(
        [&](const auto& handle) {
            using T = std::decay_t<decltype(handle)>;
            if constexpr (std::is_same_v<T, core::AudioFlowBlockerHandle>) {
                auto result = cancel
                                  ? m_kernel->cancel(owner, core::AnyFlowBlockerHandle{handle})
                                  : m_kernel->complete(owner, core::AnyFlowBlockerHandle{handle});
                if (!result)
                    diagnostics = std::move(result).error();
            } else if (cancel) {
                auto result = m_kernel->cancel_script(owner, handle);
                if (!result)
                    diagnostics = as_diagnostics(TypedExecutionError{result.error()});
            } else {
                auto result = m_kernel->resume_script(owner, handle);
                if (!result)
                    diagnostics = as_diagnostics(TypedExecutionError{result.error()});
            }
        },
        completion);
    if (!diagnostics.empty())
        return diagnostics;
    record_structural_mutation();
    return {};
}

void TypedRuntimeSession::append_view(TypedRuntimeSessionResult& result)
{
    auto view = m_kernel->runtime_ui_view(m_runtime_locale);
    if (!view) {
        core::append_diagnostics(result.diagnostics, as_diagnostics(std::move(view).error()));
        result.disposition = RuntimeInputDisposition::Failed;
        return;
    }
    result.view = std::move(*view.value_if());
    result.view.selected_interactables = m_selection;
    result.view.effective_gameplay_pause = m_effective_gameplay_pause;
    auto& pause_sources = result.view.effective_gameplay_pause.active_sources;
    std::erase_if(pause_sources, [](const core::GameplayPauseSource& source) {
        return source.kind == core::GameplayPauseSourceKind::ExplicitSession;
    });
    if (m_kernel->state().gameplay_paused()) {
        pause_sources.insert(pause_sources.begin(),
                             {.kind = core::GameplayPauseSourceKind::ExplicitSession,
                              .layout_instance = std::nullopt});
    }
    result.view.effective_gameplay_pause.paused = !pause_sources.empty();
    const bool has_choice = (result.view.scene && result.view.scene->choice) ||
                            (result.view.dialogue && result.view.dialogue->choice);
    result.view.can_continue =
        active_blocker<core::InputFlowBlocker>(*m_kernel) != nullptr && !has_choice;
    m_script_view = result.view;
    result.outputs.emplace_back(core::RuntimeViewPublication{result.view});
}

TypedRuntimeSessionResult TypedRuntimeSession::apply(const core::RuntimeInputMessage& input)
{
    TypedRuntimeSessionResult result;
    const bool externally_paused =
        std::any_of(m_effective_gameplay_pause.active_sources.begin(),
                    m_effective_gameplay_pause.active_sources.end(),
                    [](const core::GameplayPauseSource& source) {
                        return source.kind != core::GameplayPauseSourceKind::ExplicitSession;
                    });
    if ((m_kernel->state().gameplay_paused() || externally_paused) &&
        is_gameplay_advancement(input)) {
        result.disposition = RuntimeInputDisposition::Unhandled;
    } else
        std::visit(
            [&](const auto& value) {
                using T = std::decay_t<decltype(value)>;
                if constexpr (std::is_same_v<T, core::StartRuntimeInput>) {
                    m_running = true;
                    result.diagnostics =
                        run_kernel(result.outputs, result.events, result.event_output_offsets);
                } else if constexpr (std::is_same_v<T, core::StopRuntimeInput>) {
                    m_running = false;
                    m_deferred_commands.clear();
                    (void)m_kernel->host().take_actions();
                } else if constexpr (std::is_same_v<T, core::ResetRuntimeInput>) {
                    auto reset = TypedExecutionKernel::create(m_project, m_runtime);
                    if (reset) {
                        if (m_transient_reset_handler)
                            m_transient_reset_handler(
                                core::PresentationCancellationReason::RuntimeReset);
                        m_script_api.clear_target();
                        m_kernel = std::move(*reset.value_if());
                        m_script_api.replace_target(this);
                        m_selection.clear();
                        m_deferred_commands.clear();
                        m_pending_presentation.reset();
                        m_pending_audio.reset();
                        m_pending_emissions.clear();
                        m_checkpoint_service.reset();
                        m_skip_next_checkpoint_settlement = true;
                    } else
                        result.diagnostics = std::move(reset).error();
                } else if constexpr (std::is_same_v<T, core::AdvanceTimeInput>) {
                    const auto elapsed =
                        std::chrono::duration_cast<std::chrono::milliseconds>(value.elapsed);
                    auto advanced = m_kernel->state().advance_time(elapsed);
                    if (!advanced)
                        result.diagnostics = std::move(advanced).error();
                    else {
                        if (elapsed.count() > 0)
                            record_time_mutation(elapsed);
                        if (const auto* blocker =
                                active_blocker<core::DurationFlowBlocker>(*m_kernel)) {
                            auto completed =
                                m_kernel->advance(blocker->owner, blocker->handle, elapsed);
                            if (!completed)
                                result.diagnostics = std::move(completed).error();
                            else if (*completed.value_if()) {
                                record_structural_mutation();
                                result.diagnostics = run_kernel(result.outputs, result.events,
                                                                result.event_output_offsets);
                            }
                        } else
                            result.diagnostics = run_kernel(result.outputs, result.events,
                                                            result.event_output_offsets);
                    }
                } else if constexpr (std::is_same_v<T, core::ContinueInput>) {
                    const auto* blocker = active_blocker<core::InputFlowBlocker>(*m_kernel);
                    if (!blocker)
                        result.disposition = RuntimeInputDisposition::Unhandled;
                    else {
                        auto completed = m_kernel->complete(
                            blocker->owner, core::AnyFlowBlockerHandle{blocker->handle});
                        if (!completed)
                            result.diagnostics = std::move(completed).error();
                        else
                            result.diagnostics = run_kernel(result.outputs, result.events,
                                                            result.event_output_offsets);
                    }
                } else if constexpr (std::is_same_v<T, core::SelectSceneChoiceInput> ||
                                     std::is_same_v<T, core::SelectDialogueChoiceInput>) {
                    const auto* blocker = active_blocker<core::InputFlowBlocker>(*m_kernel);
                    if (!blocker)
                        result.disposition = RuntimeInputDisposition::Unhandled;
                    else if constexpr (std::is_same_v<T, core::SelectSceneChoiceInput>) {
                        auto chosen = m_kernel->choose_scene_option(blocker->owner, blocker->handle,
                                                                    value.option);
                        if (!chosen)
                            result.diagnostics = std::move(chosen).error();
                        else
                            result.diagnostics = run_kernel(result.outputs, result.events,
                                                            result.event_output_offsets);
                    } else {
                        auto chosen = m_kernel->choose_dialogue_option(blocker->owner,
                                                                       blocker->handle, value.edge);
                        if (!chosen)
                            result.diagnostics = std::move(chosen).error();
                        else
                            result.diagnostics = run_kernel(result.outputs, result.events,
                                                            result.event_output_offsets);
                    }
                } else if constexpr (std::is_same_v<T, core::NavigateRoomInput>) {
                    auto changed = m_kernel->navigate(value.exit);
                    if (!changed)
                        result.diagnostics = std::move(changed).error();
                    else
                        result.diagnostics =
                            run_kernel(result.outputs, result.events, result.event_output_offsets);
                } else if constexpr (std::is_same_v<T, core::SelectInteractablesInput>) {
                    m_selection = value.interactables;
                } else if constexpr (std::is_same_v<T, core::ClearInteractableSelectionInput>) {
                    m_selection.clear();
                } else if constexpr (std::is_same_v<T, core::InvokeInteractionInput>) {
                    auto operands = value.operands.empty() ? m_selection : value.operands;
                    auto invoked = m_kernel->interact(value.verb, std::move(operands));
                    if (!invoked)
                        result.diagnostics = as_diagnostics(std::move(invoked).error());
                    else
                        result.diagnostics =
                            run_kernel(result.outputs, result.events, result.event_output_offsets);
                } else if constexpr (std::is_same_v<T, core::SetVariableDebugInput>) {
                    auto changed = script_set_variable(value.variable, value.value);
                    if (!changed)
                        result.diagnostics = std::move(changed).error();
                } else if constexpr (std::is_same_v<T, core::SetPropertyDebugInput>) {
                    auto changed = script_set_property(value.owner, value.property, value.value);
                    if (!changed)
                        result.diagnostics = std::move(changed).error();
                } else if constexpr (std::is_same_v<T, core::SaveRuntimeInput>) {
                    if (value.slot.is_autosave()) {
                        auto requested = m_checkpoint_service.request(
                            core::ImmediateRetainedCheckpointWriteRequest{value.slot});
                        if (const auto* failed =
                                std::get_if<core::CheckpointSaveFailed>(&requested))
                            result.diagnostics = failed->diagnostics;
                        else
                            result.outputs.emplace_back(core::SaveOutcome{
                                value.slot, core::SaveOutcomeStatus::Saved, true});
                    } else {
                        auto requested =
                            m_checkpoint_service.request(core::ManualSaveRequest{value.slot});
                        if (!requested) {
                            const auto& outcome = requested.error();
                            if (const auto* failed =
                                    std::get_if<core::CheckpointSaveFailed>(&outcome))
                                result.diagnostics = failed->diagnostics;
                        }
                    }
                } else if constexpr (std::is_same_v<T, core::LoadRuntimeInput>) {
                    auto bytes = m_saves.read_slot(value.slot);
                    auto decoded = bytes
                                       ? core::decode_save_state_text(m_project, *bytes.value_if(),
                                                                      "save-slot")
                                       : core::Result<core::SaveState, core::Diagnostics>::failure(
                                             bytes.error());
                    auto loaded = decoded
                                      ? TypedExecutionKernel::restore(m_project, m_runtime,
                                                                      *decoded.value_if())
                                      : core::Result<std::unique_ptr<TypedExecutionKernel>,
                                                     core::Diagnostics>::failure(decoded.error());
                    auto checkpoint =
                        loaded
                            ? m_checkpoint_service.prepare_loaded_checkpoint(*bytes.value_if(),
                                                                             *decoded.value_if())
                            : core::Result<core::LatestSaveCheckpoint, core::Diagnostics>::failure(
                                  loaded.error());
                    if (checkpoint) {
                        if (m_transient_reset_handler)
                            m_transient_reset_handler(
                                core::PresentationCancellationReason::CheckpointLoad);
                        m_script_api.clear_target();
                        m_kernel = std::move(*loaded.value_if());
                        m_script_api.replace_target(this);
                        m_selection.clear();
                        m_deferred_commands.clear();
                        m_pending_presentation.reset();
                        m_pending_audio.reset();
                        m_pending_emissions.clear();
                        m_checkpoint_service.commit_loaded_checkpoint(
                            std::move(*checkpoint.value_if()));
                        result.outputs.emplace_back(core::SaveOutcome{
                            value.slot, core::SaveOutcomeStatus::Loaded, value.slot.is_autosave()});
                    } else
                        result.diagnostics = std::move(checkpoint).error();
                } else if constexpr (std::is_same_v<T, core::BeginPlaybackInput>) {
                    m_playback = true;
                    m_playback_step = 0;
                } else if constexpr (std::is_same_v<T, core::EndPlaybackInput>) {
                    m_playback = false;
                } else if constexpr (std::is_same_v<T, core::ClearPlaybackInput> ||
                                     std::is_same_v<T, core::ReplayPlaybackInput>) {
                    m_playback_step = 0;
                } else if constexpr (std::is_same_v<T, core::UndoPlaybackStepInput>) {
                    if (m_playback_step == 0)
                        result.disposition = RuntimeInputDisposition::Unhandled;
                    else
                        --m_playback_step;
                } else if constexpr (std::is_same_v<T, core::CompletePresentationInput> ||
                                     std::is_same_v<T, core::CancelPresentationInput>) {
                    result.diagnostics =
                        complete_presentation(value.operation, value.owner, value.completion,
                                              std::is_same_v<T, core::CancelPresentationInput>);
                    if (result.diagnostics.empty() &&
                        std::is_same_v<T, core::CompletePresentationInput>)
                        result.diagnostics =
                            run_kernel(result.outputs, result.events, result.event_output_offsets);
                } else if constexpr (std::is_same_v<T, core::CompleteAudioInput> ||
                                     std::is_same_v<T, core::CancelAudioInput>) {
                    result.diagnostics =
                        complete_audio(value.operation, value.owner, value.completion,
                                       std::is_same_v<T, core::CancelAudioInput>);
                    if (result.diagnostics.empty() && std::is_same_v<T, core::CompleteAudioInput>)
                        result.diagnostics =
                            run_kernel(result.outputs, result.events, result.event_output_offsets);
                } else if constexpr (std::is_same_v<T, core::AcknowledgeAudioTerminationInput>) {
                    result.diagnostics.clear();
                } else
                    static_assert(always_false<T>, "Unhandled RuntimeInputMessage alternative");
            },
            input);

    drain_script_inputs(result.outputs, result.events, result.event_output_offsets,
                        result.diagnostics);
    collect_runtime_actions(result.diagnostics);
    drain_pending_emissions(result.outputs, result.events, result.event_output_offsets);
    if (result.diagnostics.empty())
        drain_deferred_commands(result.outputs, result.events, result.event_output_offsets,
                                result.diagnostics);
    else
        m_deferred_commands.clear();
    attach_runtime_context(result.diagnostics, *m_kernel);
    if (!result.diagnostics.empty())
        result.disposition = RuntimeInputDisposition::Failed;
    result.outputs.emplace_back(core::RuntimeObservation{core::RuntimeStateObservation{
        .mode = m_kernel->state().mode(),
        .active_frame =
            m_kernel->state().flow_stack().empty()
                ? std::nullopt
                : std::optional{core::flow_frame_id(m_kernel->state().flow_stack().back())},
        .blocker = m_kernel->state().blocker()
                       ? std::optional{core::flow_blocker_kind(*m_kernel->state().blocker())}
                       : std::nullopt}});
    if (m_playback)
        result.outputs.emplace_back(core::RuntimeObservation{core::PlaybackObservation{
            m_playback_step++, result.disposition == RuntimeInputDisposition::Handled}});
    append_view(result);
    for (const auto& item : result.diagnostics)
        result.outputs.emplace_back(item);
    return result;
}

void TypedRuntimeSession::set_effective_gameplay_pause(core::EffectiveGameplayPause pause) noexcept
{
    m_effective_gameplay_pause = std::move(pause);
}

bool TypedRuntimeSession::explicit_gameplay_paused() const noexcept
{
    return m_kernel->state().gameplay_paused();
}

} // namespace noveltea::script
