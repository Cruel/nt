#include "noveltea/script/typed_runtime_session.hpp"

#include "noveltea/script/typed_execution_kernel.hpp"

#include "noveltea/core/runtime_diagnostic_context.hpp"
#include "noveltea/core/save_state_codec.hpp"

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
    const core::CompiledProject& project, runtime::ScriptInvocationPort& scripts,
    runtime::PresentationRuntimePort& presentation, core::TypedSaveSlotStore& saves,
    std::unique_ptr<TypedExecutionKernel> kernel, std::string runtime_locale,
    runtime::RuntimeBudgetConfiguration runtime_budget) noexcept
    : m_project(project), m_scripts(scripts), m_presentation(presentation), m_saves(saves),
      m_checkpoint_service(project, saves), m_kernel(std::move(kernel)),
      m_runtime_budget(runtime_budget), m_runtime_locale(std::move(runtime_locale))
{
    m_kernel->gateway().bind_services(this);
}

TypedRuntimeSession::~TypedRuntimeSession()
{
    m_presentation.terminate(core::PresentationCancellationReason::OwnerEnded);
    invalidate_kernel(runtime::ScriptCancellationReason::RunningGameDestroyed);
}

std::size_t TypedRuntimeSession::pending_command_count() const noexcept
{
    return m_kernel->gateway().command_queue().size();
}

runtime::RuntimeCommandGateway& TypedRuntimeSession::gateway() noexcept
{
    return m_kernel->gateway();
}

const runtime::RuntimeCommandGateway& TypedRuntimeSession::gateway() const noexcept
{
    return m_kernel->gateway();
}

void TypedRuntimeSession::record_structural_mutation() noexcept
{
    m_transaction_impacts.record(runtime::MutationImpact::StructuralStateChanged);
    m_transaction_impacts.record(runtime::MutationImpact::GameplayUiInvalidated);
    m_transaction_impacts.record(runtime::MutationImpact::PresentationInvalidated);
    m_transaction_impacts.record(runtime::MutationImpact::CheckpointReadinessInvalidated);
    m_transaction_impacts.record(runtime::MutationImpact::ObservationInvalidated);
}

void TypedRuntimeSession::record_time_mutation(std::chrono::milliseconds elapsed) noexcept
{
    if (elapsed.count() <= 0)
        return;
    m_transaction_impacts.record(runtime::MutationImpact::TimeStateChanged);
    m_transaction_impacts.record(runtime::MutationImpact::GameplayUiInvalidated);
    m_transaction_impacts.record(runtime::MutationImpact::PresentationInvalidated);
    m_transaction_impacts.record(runtime::MutationImpact::CheckpointReadinessInvalidated);
    m_transaction_impacts.record(runtime::MutationImpact::ObservationInvalidated);
    if (elapsed.count() <= std::numeric_limits<std::int64_t>::max() - m_transaction_elapsed.count())
        m_transaction_elapsed += elapsed;
}

const core::SessionState& TypedRuntimeSession::presentation_state() const noexcept
{
    return m_kernel->state();
}

core::Diagnostics TypedRuntimeSession::settle_transaction()
{
    if (m_skip_next_checkpoint_settlement) {
        m_skip_next_checkpoint_settlement = false;
        return {};
    }
    RuntimeCheckpointFacts facts{
        .input_queue_settled = true,
        .output_queue_settled = true,
        .script_input_queue_settled = m_script_inputs.empty(),
        .deferred_command_queue_settled = m_kernel->gateway().command_queue().empty(),
        .presentation_acknowledgements_settled = true,
        .immediate_script_invocation_active = false,
        .flow_blocker = m_kernel->state().blocker(),
        .presentation_status = m_presentation.checkpoint_status(),
    };
    const RuntimeTransactionMutations mutations{
        .structural =
            m_transaction_impacts.contains(runtime::MutationImpact::StructuralStateChanged),
        .time = m_transaction_impacts.contains(runtime::MutationImpact::TimeStateChanged),
        .elapsed = m_transaction_elapsed};
    auto settled = m_checkpoint_service.settle(m_kernel->state(), facts, mutations);
    return settled ? core::Diagnostics{} : std::move(settled).error();
}

void TypedRuntimeSession::queue_input(core::RuntimeInputMessage input)
{
    m_script_inputs.push_back(std::move(input));
}

core::Result<void, core::Diagnostics>
TypedRuntimeSession::present_map(core::MapId map,
                                 std::optional<core::compiled::InitialMapMode> mode, bool visible,
                                 std::optional<core::MapLocationId> focused_location)
{
    return m_kernel->present_map(map, mode, visible, std::move(focused_location));
}

core::Result<void, core::Diagnostics> TypedRuntimeSession::hide_map()
{
    return m_kernel->hide_map();
}

core::Result<void, core::Diagnostics>
TypedRuntimeSession::select_map_location(core::MapLocationId location)
{
    auto selected = m_kernel->select_map_location(location, m_runtime_locale);
    return selected ? core::Result<void, core::Diagnostics>::success()
                    : core::Result<void, core::Diagnostics>::failure(
                          as_diagnostics(std::move(selected).error()));
}

core::Result<void, core::Diagnostics>
TypedRuntimeSession::activate_map_connection(core::MapConnectionId connection)
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
    return m_kernel->gateway().request_navigation(selected->exit);
}

core::Result<void, core::Diagnostics> TypedRuntimeSession::request_audio(
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

    auto accepted = accept_audio(operation);
    if (!accepted)
        return core::Result<void, core::Diagnostics>::failure(std::move(accepted).error());

    auto changed = m_kernel->state().set_audio_channel(
        m_project, core::AudioChannelState{channel, playing ? operation.asset : std::nullopt,
                                           volume, loop, playing});
    if (!changed)
        return changed;
    if (script_blocker)
        m_pending_audio = operation;
    record_structural_mutation();
    return core::Result<void, core::Diagnostics>::success();
}

core::Result<std::unique_ptr<TypedRuntimeSession>, core::Diagnostics> TypedRuntimeSession::create(
    const core::CompiledProject& project, runtime::ScriptInvocationPort& scripts,
    runtime::PresentationRuntimePort& presentation, core::TypedSaveSlotStore& saves,
    std::string runtime_locale, runtime::RuntimeBudgetConfiguration runtime_budget)
{
    if (runtime_budget.instruction_limit == 0 || runtime_budget.command_limit == 0) {
        return core::Result<std::unique_ptr<TypedRuntimeSession>, core::Diagnostics>::failure(
            {core::Diagnostic{.code = "runtime.invalid_budget",
                              .message =
                                  "Runtime instruction and command budgets must be positive"}});
    }
    auto kernel = TypedExecutionKernel::create(project, scripts);
    if (!kernel)
        return core::Result<std::unique_ptr<TypedRuntimeSession>, core::Diagnostics>::failure(
            std::move(kernel).error());
    return core::Result<std::unique_ptr<TypedRuntimeSession>, core::Diagnostics>::success(
        std::unique_ptr<TypedRuntimeSession>(new TypedRuntimeSession(
            project, scripts, presentation, saves, std::move(*kernel.value_if()),
            std::move(runtime_locale), runtime_budget)));
}

core::Result<runtime::PresentationAcceptance, core::Diagnostics>
TypedRuntimeSession::accept_presentation(const core::PresentationOperation& operation)
{
    auto accepted = m_presentation.accept(operation);
    if (!accepted)
        return accepted;
    if (!accepted.value_if()->accepted) {
        return core::Result<runtime::PresentationAcceptance, core::Diagnostics>::failure(
            {diagnostic("runtime.presentation_rejected",
                        "Presentation service rejected the runtime operation")});
    }
    return accepted;
}

core::Result<runtime::PresentationAcceptance, core::Diagnostics>
TypedRuntimeSession::accept_audio(const core::AudioOperation& operation)
{
    auto accepted = m_presentation.accept(operation);
    if (!accepted)
        return accepted;
    if (!accepted.value_if()->accepted) {
        return core::Result<runtime::PresentationAcceptance, core::Diagnostics>::failure(
            {diagnostic("runtime.audio_rejected",
                        "Presentation service rejected the audio operation")});
    }
    return accepted;
}

core::Diagnostic TypedRuntimeSession::diagnostic(std::string code, std::string message) const
{
    return core::Diagnostic{.code = std::move(code), .message = std::move(message)};
}

void TypedRuntimeSession::invalidate_kernel(runtime::ScriptCancellationReason reason) noexcept
{
    if (!m_kernel)
        return;
    if (const auto* blocker = active_blocker<core::ScriptFlowBlocker>(*m_kernel))
        m_scripts.cancel(blocker->handle, reason);
    const auto generation = m_kernel->gateway().generation();
    m_kernel->gateway().clear_transient_state();
    m_kernel->gateway().invalidate();
    m_scripts.invalidate_capabilities(generation);
}

core::Diagnostics TypedRuntimeSession::run_kernel(std::vector<core::RuntimeOutputMessage>& outputs,
                                                  std::vector<runtime::RuntimeEvent>& events,
                                                  std::vector<std::size_t>& event_output_offsets)
{
    auto diagnostics = run_kernel_once(outputs, events, event_output_offsets);
    if (diagnostics.empty()) {
        drain_deferred_commands(outputs, events, event_output_offsets, diagnostics);
    } else {
        m_kernel->gateway().command_queue().clear();
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
    if (const auto* fault = std::get_if<core::FlowFaultOutcome>(&outcome)) {
        diagnostics = fault->diagnostics;
        if (m_transaction_budget_outcome.kind != runtime::RuntimeBudgetOutcomeKind::CycleRejected) {
            m_transaction_budget_outcome = {.kind = runtime::RuntimeBudgetOutcomeKind::Faulted,
                                            .exhausted = std::nullopt,
                                            .consumed = m_transaction_budget_outcome.consumed};
        }
    } else if (const auto* yielded = std::get_if<core::FlowBudgetYieldOutcome>(&outcome);
               yielded != nullptr &&
               yielded->executed_units >= m_runtime_budget.instruction_limit &&
               m_transaction_budget_outcome.kind ==
                   runtime::RuntimeBudgetOutcomeKind::WithinBudget) {
        m_transaction_budget_outcome = {.kind = runtime::RuntimeBudgetOutcomeKind::Yielded,
                                        .exhausted = runtime::RuntimeBudgetKind::Instruction,
                                        .consumed = yielded->executed_units};
    }

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
                auto accepted = accept_presentation(core::PresentationOperation{operation});
                if (!accepted) {
                    core::append_diagnostics(diagnostics, std::move(accepted).error());
                    auto cancelled = m_kernel->cancel(blocker->owner,
                                                      core::AnyFlowBlockerHandle{blocker->handle});
                    if (!cancelled)
                        core::append_diagnostics(diagnostics, std::move(cancelled).error());
                    else
                        record_structural_mutation();
                } else {
                    m_pending_presentation = operation;
                }
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
                auto accepted = accept_audio(operation);
                if (!accepted) {
                    core::append_diagnostics(diagnostics, std::move(accepted).error());
                    auto cancelled = m_kernel->cancel(blocker->owner,
                                                      core::AnyFlowBlockerHandle{blocker->handle});
                    if (!cancelled)
                        core::append_diagnostics(diagnostics, std::move(cancelled).error());
                    else
                        record_structural_mutation();
                } else {
                    m_pending_audio = operation;
                }
            }
        }
    }
    drain_script_inputs(outputs, events, event_output_offsets, diagnostics);
    if (diagnostics.empty() && execution_can_advance)
        record_structural_mutation();
    return diagnostics;
}

void TypedRuntimeSession::stage_gateway_events()
{
    for (auto& event : m_kernel->gateway().take_events())
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
            auto applied = apply_input(pending[index]);
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
    (void)diagnostics;
    stage_gateway_events();
    const auto impacts = m_kernel->gateway().take_mutation_impacts();
    m_transaction_impacts.merge(impacts);
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
    auto& commands = m_kernel->gateway().command_queue();
    if (m_draining_deferred_commands || commands.empty())
        return;
    m_draining_deferred_commands = true;
    std::size_t processed = 0;
    while (!commands.empty() && processed < m_runtime_budget.command_limit) {
        auto command = commands.pop_front();
        if (!command)
            break;
        ++processed;
        auto executed = execute_deferred_command(*command);
        if (!executed.empty()) {
            core::append_diagnostics(diagnostics, std::move(executed));
            commands.clear();
            break;
        }
        if (!std::holds_alternative<runtime::RequestAutosaveCommand>(command->payload)) {
            auto continued = run_kernel_once(outputs, events, event_output_offsets);
            if (!continued.empty()) {
                core::append_diagnostics(diagnostics, std::move(continued));
                commands.clear();
                break;
            }
        }
    }
    if (!commands.empty()) {
        m_transaction_budget_outcome = {.kind = runtime::RuntimeBudgetOutcomeKind::CycleRejected,
                                        .exhausted = runtime::RuntimeBudgetKind::Command,
                                        .consumed = processed};
        diagnostics.push_back(
            diagnostic("runtime.command_budget_exhausted",
                       "Deferred runtime commands exceeded the per-transaction command budget"));
        commands.clear();
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

void TypedRuntimeSession::project_publication(WorkResult& work,
                                              runtime::RuntimeDispatchResult& result)
{
    auto view = m_kernel->runtime_ui_view(m_runtime_locale);
    if (!view) {
        core::append_diagnostics(result.diagnostics, as_diagnostics(std::move(view).error()));
        result.disposition = runtime::RuntimeInputDisposition::Failed;
        return;
    }
    auto gameplay_ui = std::move(*view.value_if());
    gameplay_ui.selected_interactables = m_selection;
    gameplay_ui.effective_gameplay_pause = m_effective_gameplay_pause;
    auto& pause_sources = gameplay_ui.effective_gameplay_pause.active_sources;
    std::erase_if(pause_sources, [](const core::GameplayPauseSource& source) {
        return source.kind == core::GameplayPauseSourceKind::ExplicitSession;
    });
    if (m_kernel->state().gameplay_paused()) {
        pause_sources.insert(pause_sources.begin(),
                             {.kind = core::GameplayPauseSourceKind::ExplicitSession,
                              .layout_instance = std::nullopt});
    }
    gameplay_ui.effective_gameplay_pause.paused = !pause_sources.empty();
    const bool has_choice = (gameplay_ui.scene && gameplay_ui.scene->choice) ||
                            (gameplay_ui.dialogue && gameplay_ui.dialogue->choice);
    gameplay_ui.can_continue =
        active_blocker<core::InputFlowBlocker>(*m_kernel) != nullptr && !has_choice;
    m_script_view = gameplay_ui;

    auto presentation = core::PresentationProjector::project(m_project, m_kernel->state());
    if (!presentation) {
        core::append_diagnostics(result.diagnostics, std::move(presentation).error());
        result.disposition = runtime::RuntimeInputDisposition::Failed;
        return;
    }

    runtime::RuntimeObservationSnapshot observations;
    for (const auto& output : work.outputs) {
        if (const auto* observation = std::get_if<core::RuntimeObservation>(&output))
            observations.values.push_back(*observation);
    }

    auto presentation_value = std::move(*presentation.value_if());
    const bool changed =
        !m_current_publication || m_force_publication ||
        m_transaction_impacts.contains(runtime::MutationImpact::GameplayUiInvalidated) ||
        m_transaction_impacts.contains(runtime::MutationImpact::PresentationInvalidated) ||
        m_transaction_impacts.contains(runtime::MutationImpact::ObservationInvalidated);
    if (!changed)
        return;

    const auto subsequent = m_next_publication_revision.next();
    if (!subsequent) {
        result.diagnostics.push_back(diagnostic("runtime.publication_revision_exhausted",
                                                "Runtime publication revision space is exhausted"));
        result.disposition = runtime::RuntimeInputDisposition::Failed;
        return;
    }
    presentation_value.revision = m_next_publication_revision.number();
    runtime::RuntimePublication publication{.revision = m_next_publication_revision,
                                            .gameplay_ui = std::move(gameplay_ui),
                                            .presentation = std::move(presentation_value),
                                            .observations = std::move(observations)};
    m_next_publication_revision = *subsequent;
    m_current_publication = publication;
    result.publication = std::move(publication);
    m_force_publication = false;
}

void TypedRuntimeSession::commit_work_events(WorkResult& work,
                                             runtime::RuntimeDispatchResult& result)
{
    const bool valid_order =
        work.events.size() == work.event_output_offsets.size() &&
        std::is_sorted(work.event_output_offsets.begin(), work.event_output_offsets.end()) &&
        (work.event_output_offsets.empty() ||
         work.event_output_offsets.back() <= work.outputs.size());
    if (!valid_order) {
        result.diagnostics.push_back(diagnostic("runtime.invalid_event_order",
                                                "Runtime event ordering metadata is malformed"));
        result.disposition = runtime::RuntimeInputDisposition::Failed;
    }

    const auto append_output = [&](const core::RuntimeOutputMessage& output) {
        std::visit(
            [&](const auto& value) {
                using T = std::decay_t<decltype(value)>;
                if constexpr (std::is_same_v<T, core::UserCommunicationOutput>) {
                    if (const auto* notification = std::get_if<core::NotificationOutput>(&value))
                        result.events.emplace_back(
                            runtime::NotificationEvent{notification->message});
                } else if constexpr (std::is_same_v<T, core::SaveOutcome>) {
                    result.events.emplace_back(runtime::SaveOutcomeEvent{value});
                } else if constexpr (std::is_same_v<T, core::RuntimeObservation>) {
                    result.events.emplace_back(runtime::ObservationEvent{value});
                } else if constexpr (std::is_same_v<T, core::Diagnostic> ||
                                     std::is_same_v<T, core::RuntimeViewPublication>) {
                } else if constexpr (std::is_same_v<T, core::PresentationOperation> ||
                                     std::is_same_v<T, core::AudioOperation>) {
                    result.diagnostics.push_back(diagnostic(
                        "runtime.legacy_operation_output",
                        "Presentation and audio operations must use PresentationRuntimePort"));
                    result.disposition = runtime::RuntimeInputDisposition::Failed;
                } else {
                    static_assert(always_false<T>, "Unhandled runtime work output");
                }
            },
            output);
    };

    if (!valid_order) {
        result.events.insert(result.events.end(), std::make_move_iterator(work.events.begin()),
                             std::make_move_iterator(work.events.end()));
        for (const auto& output : work.outputs)
            append_output(output);
        return;
    }

    std::size_t event_index = 0;
    for (std::size_t output_index = 0; output_index <= work.outputs.size(); ++output_index) {
        while (event_index < work.events.size() &&
               work.event_output_offsets[event_index] == output_index) {
            result.events.push_back(std::move(work.events[event_index++]));
        }
        if (output_index < work.outputs.size())
            append_output(work.outputs[output_index]);
    }
}

runtime::RuntimeDispatchResult TypedRuntimeSession::dispatch(const core::RuntimeInputMessage& input)
{
    runtime::RuntimeDispatchResult result;
    if (m_dispatch_active) {
        result.disposition = runtime::RuntimeInputDisposition::Failed;
        result.diagnostics.push_back(diagnostic(
            "runtime.reentrant_dispatch", "Public runtime dispatch cannot be called recursively"));
        return result;
    }

    m_dispatch_active = true;
    m_transaction_budget_outcome = {};
    auto work = apply_input(input);
    result.disposition = work.disposition;
    core::append_diagnostics(result.diagnostics, std::move(work.diagnostics));
    core::append_diagnostics(result.diagnostics, settle_transaction());
    project_publication(work, result);
    commit_work_events(work, result);
    if (!result.diagnostics.empty())
        result.disposition = runtime::RuntimeInputDisposition::Failed;
    result.budget = m_transaction_budget_outcome;
    m_transaction_impacts.clear();
    m_transaction_elapsed = std::chrono::milliseconds{0};
    m_dispatch_active = false;
    return result;
}

TypedRuntimeSession::WorkResult
TypedRuntimeSession::apply_input(const core::RuntimeInputMessage& input)
{
    WorkResult result;
    const bool externally_paused =
        std::any_of(m_effective_gameplay_pause.active_sources.begin(),
                    m_effective_gameplay_pause.active_sources.end(),
                    [](const core::GameplayPauseSource& source) {
                        return source.kind != core::GameplayPauseSourceKind::ExplicitSession;
                    });
    if ((m_kernel->state().gameplay_paused() || externally_paused) &&
        is_gameplay_advancement(input)) {
        result.disposition = runtime::RuntimeInputDisposition::Unhandled;
    } else
        std::visit(
            [&](const auto& value) {
                using T = std::decay_t<decltype(value)>;
                if constexpr (std::is_same_v<T, core::StartRuntimeInput>) {
                    m_running = true;
                    m_force_publication = true;
                    result.diagnostics =
                        run_kernel(result.outputs, result.events, result.event_output_offsets);
                } else if constexpr (std::is_same_v<T, core::StopRuntimeInput>) {
                    m_running = false;
                    if (const auto* blocker = active_blocker<core::ScriptFlowBlocker>(*m_kernel)) {
                        m_scripts.cancel(blocker->handle,
                                         runtime::ScriptCancellationReason::RuntimeStop);
                        (void)m_kernel->flow().cancel_blocker(blocker->owner, blocker->handle);
                    }
                    // Transient queues are cancelled by Stop, but mutations already committed
                    // through capabilities must still participate in this dispatch's checkpoint and
                    // publication.
                    m_transaction_impacts.merge(m_kernel->gateway().take_mutation_impacts());
                    m_kernel->gateway().clear_transient_state();
                    m_presentation.terminate(core::PresentationCancellationReason::OwnerEnded);
                    m_pending_presentation.reset();
                    m_pending_audio.reset();
                } else if constexpr (std::is_same_v<T, core::ResetRuntimeInput>) {
                    const auto subsequent_generation = m_next_capability_generation.next();
                    if (!subsequent_generation) {
                        result.diagnostics = core::Diagnostics{
                            diagnostic("runtime.capability_generation_exhausted",
                                       "Runtime capability generation space is exhausted")};
                    } else {
                        auto reset = TypedExecutionKernel::create(m_project, m_scripts,
                                                                  m_next_capability_generation);
                        if (reset) {
                            m_presentation.terminate(
                                core::PresentationCancellationReason::RuntimeReset);
                            invalidate_kernel(runtime::ScriptCancellationReason::RuntimeReset);
                            m_kernel = std::move(*reset.value_if());
                            m_next_capability_generation = *subsequent_generation;
                            m_kernel->gateway().bind_services(this);
                            m_selection.clear();
                            m_pending_presentation.reset();
                            m_pending_audio.reset();
                            m_pending_emissions.clear();
                            m_checkpoint_service.reset();
                            m_skip_next_checkpoint_settlement = true;
                            m_force_publication = true;
                        } else
                            result.diagnostics = std::move(reset).error();
                    }
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
                        result.disposition = runtime::RuntimeInputDisposition::Unhandled;
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
                        result.disposition = runtime::RuntimeInputDisposition::Unhandled;
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
                    if (m_selection != value.interactables) {
                        m_selection = value.interactables;
                        m_transaction_impacts.record(
                            runtime::MutationImpact::GameplayUiInvalidated);
                    }
                } else if constexpr (std::is_same_v<T, core::ClearInteractableSelectionInput>) {
                    if (!m_selection.empty()) {
                        m_selection.clear();
                        m_transaction_impacts.record(
                            runtime::MutationImpact::GameplayUiInvalidated);
                    }
                } else if constexpr (std::is_same_v<T, core::InvokeInteractionInput>) {
                    auto operands = value.operands.empty() ? m_selection : value.operands;
                    auto invoked = m_kernel->interact(value.verb, std::move(operands));
                    if (!invoked)
                        result.diagnostics = as_diagnostics(std::move(invoked).error());
                    else
                        result.diagnostics =
                            run_kernel(result.outputs, result.events, result.event_output_offsets);
                } else if constexpr (std::is_same_v<T, core::SetVariableDebugInput>) {
                    auto changed = m_kernel->gateway().set_variable(value.variable, value.value);
                    if (!changed)
                        result.diagnostics = std::move(changed).error();
                } else if constexpr (std::is_same_v<T, core::SetPropertyDebugInput>) {
                    auto changed =
                        m_kernel->gateway().set_property(value.owner, value.property, value.value);
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
                    if (!decoded) {
                        result.diagnostics = std::move(decoded).error();
                    } else {
                        const auto subsequent_generation = m_next_capability_generation.next();
                        if (!subsequent_generation) {
                            result.diagnostics = core::Diagnostics{
                                diagnostic("runtime.capability_generation_exhausted",
                                           "Runtime capability generation space is exhausted")};
                        } else {
                            auto loaded = TypedExecutionKernel::restore(
                                m_project, m_scripts, *decoded.value_if(),
                                m_next_capability_generation);
                            auto checkpoint =
                                loaded ? m_checkpoint_service.prepare_loaded_checkpoint(
                                             *bytes.value_if(), *decoded.value_if())
                                       : core::Result<core::LatestSaveCheckpoint,
                                                      core::Diagnostics>::failure(loaded.error());
                            if (checkpoint) {
                                m_presentation.terminate(
                                    core::PresentationCancellationReason::CheckpointLoad);
                                invalidate_kernel(
                                    runtime::ScriptCancellationReason::CheckpointLoad);
                                m_kernel = std::move(*loaded.value_if());
                                m_next_capability_generation = *subsequent_generation;
                                m_kernel->gateway().bind_services(this);
                                m_selection.clear();
                                m_pending_presentation.reset();
                                m_pending_audio.reset();
                                m_pending_emissions.clear();
                                m_checkpoint_service.commit_loaded_checkpoint(
                                    std::move(*checkpoint.value_if()));
                                result.outputs.emplace_back(
                                    core::SaveOutcome{value.slot, core::SaveOutcomeStatus::Loaded,
                                                      value.slot.is_autosave()});
                                m_force_publication = true;
                            } else
                                result.diagnostics = std::move(checkpoint).error();
                        }
                    }
                } else if constexpr (std::is_same_v<T, core::BeginPlaybackInput>) {
                    m_playback = true;
                    m_playback_step = 0;
                    m_transaction_impacts.record(runtime::MutationImpact::ObservationInvalidated);
                } else if constexpr (std::is_same_v<T, core::EndPlaybackInput>) {
                    m_playback = false;
                    m_transaction_impacts.record(runtime::MutationImpact::ObservationInvalidated);
                } else if constexpr (std::is_same_v<T, core::ClearPlaybackInput> ||
                                     std::is_same_v<T, core::ReplayPlaybackInput>) {
                    m_playback_step = 0;
                    m_transaction_impacts.record(runtime::MutationImpact::ObservationInvalidated);
                } else if constexpr (std::is_same_v<T, core::UndoPlaybackStepInput>) {
                    if (m_playback_step == 0)
                        result.disposition = runtime::RuntimeInputDisposition::Unhandled;
                    else {
                        --m_playback_step;
                        m_transaction_impacts.record(
                            runtime::MutationImpact::ObservationInvalidated);
                    }
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
        m_kernel->gateway().command_queue().clear();
    attach_runtime_context(result.diagnostics, *m_kernel);
    if (!result.diagnostics.empty())
        result.disposition = runtime::RuntimeInputDisposition::Failed;
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
            m_playback_step++, result.disposition == runtime::RuntimeInputDisposition::Handled}});
    for (const auto& item : result.diagnostics)
        result.outputs.emplace_back(item);
    return result;
}

void TypedRuntimeSession::set_effective_gameplay_pause(core::EffectiveGameplayPause pause) noexcept
{
    if (m_effective_gameplay_pause == pause)
        return;
    m_effective_gameplay_pause = std::move(pause);
    m_force_publication = true;
}

bool TypedRuntimeSession::explicit_gameplay_paused() const noexcept
{
    return m_kernel->state().gameplay_paused();
}

} // namespace noveltea::script
