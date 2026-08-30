#include "noveltea/runtime/runtime_session.hpp"

#include "noveltea/runtime/runtime_executor.hpp"

#include "noveltea/core/runtime_diagnostic_context.hpp"

#include <algorithm>
#include <cassert>
#include <chrono>
#include <limits>
#include <cmath>
#include <type_traits>

namespace noveltea::runtime {
namespace {

template<class> inline constexpr bool always_false = false;

bool has_blocking_diagnostic(const core::Diagnostics& diagnostics) noexcept
{
    return std::ranges::any_of(diagnostics, [](const core::Diagnostic& diagnostic) {
        return diagnostic.severity == core::ErrorSeverity::Error ||
               diagnostic.severity == core::ErrorSeverity::Fatal;
    });
}

core::Diagnostics as_diagnostics(RuntimeExecutionError error)
{
    if (auto* diagnostics = std::get_if<core::Diagnostics>(&error))
        return std::move(*diagnostics);
    return {core::Diagnostic{.code = "runtime.script_failed",
                             .message = std::get<ScriptInvocationError>(error).message}};
}

core::Diagnostics run_on_game_ready(ScriptInvocationPort& scripts, RuntimeExecutor& kernel)
{
    RuntimeCapabilityIssuer issuer(kernel.gateway(), kernel.gateway().generation());
    const auto capabilities = issuer.issue(RuntimeCapabilityProfile::OnGameReady);
    if (!capabilities)
        return {core::Diagnostic{.code = "runtime.on_game_ready_capability_failed",
                                 .message = "On Game Ready capability profile is unavailable"}};
    auto ready = scripts.run_project_on_game_ready(*capabilities);
    if (ready)
        return {};
    return {core::Diagnostic{.code = "runtime.on_game_ready_failed",
                             .message = ready.error().message,
                             .source_path = ready.error().chunk}};
}

template<class T> const T* active_blocker(const RuntimeExecutor& kernel)
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
                   std::is_same_v<T, core::FastForwardInput> ||
                   std::is_same_v<T, core::AdvanceDialogueRevealInput> ||
                   std::is_same_v<T, core::SelectSceneChoiceInput> ||
                   std::is_same_v<T, core::SelectDialogueChoiceInput> ||
                   std::is_same_v<T, core::NavigateRoomInput> ||
                   std::is_same_v<T, core::PrimaryActivateInput> ||
                   std::is_same_v<T, core::OpenVerbMenuInput> ||
                   std::is_same_v<T, core::PresentInventoryInput> ||
                   std::is_same_v<T, core::InvokeInteractionInput> ||
                   std::is_same_v<T, core::BeginCommandBuilderInput> ||
                   std::is_same_v<T, core::CommandBuilderSubjectPressInput> ||
                   std::is_same_v<T, core::UpdateCommandBuilderWatchInput> ||
                   std::is_same_v<T, core::SubmitCommandBuilderInput> ||
                   std::is_same_v<T, core::CancelCommandBuilderInput> ||
                   std::is_same_v<T, core::LayoutSignalInput> ||
                   std::is_same_v<T, core::CommitLayoutStateInput> ||
                   std::is_same_v<T, core::ClearLayoutStateInput> ||
                   std::is_same_v<T, core::DismissLayoutInput>;
        },
        input);
}

const core::compiled::SceneInstruction*
active_scene_instruction(const core::CompiledProject& project, const core::SceneFrame& frame)
{
    if (!frame.position.next_step)
        return nullptr;
    const auto* scene = project.find_scene(frame.scene);
    if (scene == nullptr)
        return nullptr;
    const auto found = std::ranges::find_if(
        scene->program.instructions, [&](const core::compiled::SceneInstruction& instruction) {
            return std::visit(
                [&](const auto& value) { return value.id == *frame.position.next_step; },
                instruction);
        });
    return found == scene->program.instructions.end() ? nullptr : &*found;
}

bool active_scene_wait_skippable(const core::CompiledProject& project,
                                 const core::SceneFrame& frame) noexcept
{
    const auto* instruction = active_scene_instruction(project, frame);
    if (instruction == nullptr)
        return false;
    return std::visit(
        [](const auto& value) {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, core::compiled::ShowTextInstruction>)
                return true;
            else if constexpr (std::is_same_v<T, core::compiled::WaitDurationInstruction> ||
                               std::is_same_v<T, core::compiled::WaitInputInstruction> ||
                               std::is_same_v<T, core::compiled::WaitConditionInstruction> ||
                               std::is_same_v<T, core::compiled::WaitOperationInstruction> ||
                               std::is_same_v<T, core::compiled::WaitAudioInstruction> ||
                               std::is_same_v<T, core::compiled::WaitLayoutSignalInstruction>)
                return value.skippable;
            else
                return false;
        },
        *instruction);
}

void attach_runtime_context(core::Diagnostics& diagnostics, const RuntimeExecutor& kernel)
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

std::optional<core::PresentationFlowCompletion>
pending_completion(const PendingPresentationOperation& operation)
{
    return std::visit(
        [](const auto& value) -> std::optional<core::PresentationFlowCompletion> {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, PendingRoomNavigationOperation>)
                return value.completion;
            else
                return value.completion;
        },
        operation);
}

bool pending_is_room_navigation(const PendingPresentationOperation& operation) noexcept
{
    return std::holds_alternative<PendingRoomNavigationOperation>(operation);
}

core::PresentationOperation materialize_operation(const PendingPresentationOperation& pending,
                                                  core::PresentationOperationId operation,
                                                  core::PresentationSnapshotRevision source,
                                                  core::PresentationSnapshotRevision target)
{
    const core::PresentationRevisionBinding revisions{source, target};
    return std::visit(
        [&](const auto& value) -> core::PresentationOperation {
            using T = std::decay_t<decltype(value)>;
            const core::FinitePresentationOperationCommon common{
                operation, value.duration, value.skippable, core::LayoutClockDomain::Gameplay,
                revisions};
            if constexpr (std::is_same_v<T, PendingSceneTransitionGroupOperation>) {
                return core::SceneTransitionGroupOperation{common, value.kind, value.color,
                                                           value.completion};
            } else if constexpr (std::is_same_v<T, PendingRoomNavigationOperation>) {
                return core::RoomNavigationTransitionOperation{
                    common,
                    core::RoomNavigationOperationTarget{value.source_room, value.target_room},
                    value.kind, value.color, value.completion};
            } else if constexpr (std::is_same_v<T, PendingBackgroundOperation>) {
                return core::BackgroundPresentationOperation{
                    common, core::BackgroundOperationKind::CrossFade, value.completion};
            } else if constexpr (std::is_same_v<T, PendingActorOperation>) {
                return core::ActorPresentationOperation{
                    common, {value.target}, value.kind, value.completion};
            } else if constexpr (std::is_same_v<T, PendingLayoutOperation>) {
                return core::LayoutFinitePresentationOperation{common,
                                                               {value.target, value.owner},
                                                               core::LayoutOperationKind::Fade,
                                                               value.completion};
            } else {
                auto material_common = common;
                material_common.clock = value.clock == core::MaterialClockPolicy::Gameplay
                                            ? core::LayoutClockDomain::Gameplay
                                            : core::LayoutClockDomain::UnscaledPresentation;
                material_common.easing = value.easing;
                return core::MaterialParameterTransitionOperation{
                    material_common, value.target, value.source_value, value.target_value,
                    value.completion};
            }
        },
        pending);
}

bool same_snapshot_value(const core::RuntimePresentationSnapshot& left,
                         const core::RuntimePresentationSnapshot& right)
{
    auto normalized_left = left;
    auto normalized_right = right;
    normalized_left.revision = core::PresentationSnapshotRevision::from_number(1);
    normalized_right.revision = core::PresentationSnapshotRevision::from_number(1);
    return normalized_left == normalized_right;
}

} // namespace

RuntimeSession::RuntimeSession(const core::CompiledProject& project, ScriptInvocationPort& scripts,
                               PresentationModelPort& presentation_model,
                               PresentationRuntimePort& presentation,
                               core::TypedSaveSlotStore& saves,
                               const core::SaveStateCodecPort& save_codec,
                               std::unique_ptr<RuntimeExecutor> kernel, std::string runtime_locale,
                               RuntimeBudgetConfiguration runtime_budget) noexcept
    : m_project(project), m_scripts(scripts), m_presentation_model(presentation_model),
      m_presentation(presentation), m_checkpoint_service(project, saves, save_codec),
      m_kernel(std::move(kernel)), m_runtime_budget(runtime_budget),
      m_runtime_locale(std::move(runtime_locale)), m_owner_thread(std::this_thread::get_id())
{
    m_kernel->gateway().bind_services(this);
    m_kernel->bind_scene_event_dependency_checker([this](const core::FlowFrameId& owner,
                                                         const core::SceneId& scene,
                                                         const core::SceneStepId& event) {
        return scene_event_dependency_pending(owner, scene, event);
    });
    m_kernel->bind_scene_event_operation_checkers(
        [this](const core::FlowFrameId& owner, const core::SceneId& scene,
               const core::SceneStepId& event) {
            return scene_event_presentation_operation_active(owner, scene, event);
        },
        [this](const core::FlowFrameId& owner, const core::SceneId& scene,
               const core::SceneStepId& event) {
            return scene_event_audio_operation_active(owner, scene, event);
        });
}

RuntimeSession::~RuntimeSession()
{
    assert_owner_thread();
    m_presentation.terminate(core::PresentationCancellationReason::OwnerEnded);
    invalidate_kernel(runtime::ScriptCancellationReason::RunningGameDestroyed);
}

void RuntimeSession::assert_owner_thread() const noexcept
{
    assert(std::this_thread::get_id() == m_owner_thread &&
           "RuntimeSession must be used only from its owning thread");
}

std::size_t RuntimeSession::pending_command_count() const noexcept
{
    assert_owner_thread();
    return m_kernel->gateway().command_queue().size();
}

RuntimeCommandGateway& RuntimeSession::gateway() noexcept
{
    assert_owner_thread();
    return m_kernel->gateway();
}

const RuntimeCommandGateway& RuntimeSession::gateway() const noexcept
{
    assert_owner_thread();
    return m_kernel->gateway();
}

void RuntimeSession::record_structural_mutation() noexcept
{
    m_transaction_impacts.record(runtime::MutationImpact::StructuralStateChanged);
    m_transaction_impacts.record(runtime::MutationImpact::GameplayUiInvalidated);
    m_transaction_impacts.record(runtime::MutationImpact::PresentationInvalidated);
    m_transaction_impacts.record(runtime::MutationImpact::CheckpointReadinessInvalidated);
    m_transaction_impacts.record(runtime::MutationImpact::ObservationInvalidated);
}

void RuntimeSession::record_time_mutation(std::chrono::milliseconds elapsed) noexcept
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

bool RuntimeSession::scene_event_dependency_pending(const core::FlowFrameId& owner,
                                                    const core::SceneId& scene,
                                                    const core::SceneStepId& event) const noexcept
{
    const auto* definition = m_project.find_scene(scene);
    if (definition == nullptr)
        return false;
    const auto metadata =
        std::find_if(definition->program.events.begin(), definition->program.events.end(),
                     [&event](const core::compiled::SceneEventMetadata& candidate) {
                         return candidate.id == event;
                     });
    if (metadata == definition->program.events.end())
        return false;
    return std::ranges::any_of(
        metadata->completion_dependencies, [&](const core::SceneStepId& dependency) {
            return std::ranges::any_of(
                m_scene_event_presentation_operations,
                [&](const SceneEventPresentationOperation& operation) {
                    return operation.owner == owner && operation.scene == scene &&
                           operation.event == dependency &&
                           m_presentation.presentation_operation_active(operation.operation);
                });
        });
}

bool RuntimeSession::scene_event_presentation_operation_active(
    const core::FlowFrameId& owner, const core::SceneId& scene,
    const core::SceneStepId& event) const noexcept
{
    return std::ranges::any_of(m_scene_event_presentation_operations,
                               [&](const SceneEventPresentationOperation& operation) {
                                   return operation.owner == owner && operation.scene == scene &&
                                          operation.event == event &&
                                          m_presentation.presentation_operation_active(
                                              operation.operation);
                               });
}

bool RuntimeSession::scene_event_audio_operation_active(
    const core::FlowFrameId& owner, const core::SceneId& scene,
    const core::SceneStepId& event) const noexcept
{
    return std::ranges::any_of(
        m_scene_event_audio_operations, [&](const SceneEventAudioOperation& operation) {
            return operation.owner == owner && operation.scene == scene && operation.event == event;
        });
}

void RuntimeSession::record_scene_event_presentation_operation(
    core::PresentationOperationId operation)
{
    const auto* source = m_kernel->pending_presentation_source_state();
    if (source == nullptr || source->flow_stack().empty())
        return;
    const auto* frame = std::get_if<core::SceneFrame>(&source->flow_stack().back());
    if (frame == nullptr || !frame->position.next_step)
        return;
    const auto event = *frame->position.next_step;
    std::erase_if(m_scene_event_presentation_operations,
                  [&](const SceneEventPresentationOperation& candidate) {
                      return candidate.owner == frame->frame_id &&
                             candidate.scene == frame->scene && candidate.event == event;
                  });
    m_scene_event_presentation_operations.push_back(
        {frame->frame_id, frame->scene, event, operation});
}

void RuntimeSession::prune_scene_event_presentation_operations()
{
    std::erase_if(m_scene_event_presentation_operations,
                  [this](const SceneEventPresentationOperation& operation) {
                      return !m_presentation.presentation_operation_active(operation.operation);
                  });
}

const core::SessionState& RuntimeSession::presentation_state() const noexcept
{
    assert_owner_thread();
    return m_kernel->state();
}

core::Diagnostics RuntimeSession::settle_transaction()
{
    // The execution fault is already reported. Re-projecting the same unsaveable state every frame
    // only repeats save.execution_fault and cannot produce a usable checkpoint.
    if (m_kernel->state().execution_fault())
        return {};
    RuntimeCheckpointFacts facts{
        .input_queue_settled = true,
        .output_queue_settled = true,
        .script_input_queue_settled = m_script_inputs.empty(),
        .deferred_command_queue_settled = m_kernel->gateway().command_queue().empty(),
        .presentation_acknowledgements_settled = true,
        .immediate_script_invocation_active = false,
        .flow_blocker = m_kernel->state().blocker(),
        .detached_flow_blockers =
            [&]() {
                std::vector<std::optional<core::FlowBlocker>> blockers;
                blockers.reserve(m_kernel->state().m_detached_flow_executions.size());
                for (const auto& execution : m_kernel->state().m_detached_flow_executions)
                    blockers.push_back(execution.context.blocker);
                return blockers;
            }(),
        .presentation_status = m_presentation.checkpoint_status(),
        .presentation_revision = m_current_publication
                                     ? std::optional{m_current_publication->presentation.revision}
                                     : std::nullopt,
    };
    const RuntimeTransactionMutations mutations{
        .structural =
            m_transaction_impacts.contains(runtime::MutationImpact::StructuralStateChanged),
        .time = m_transaction_impacts.contains(runtime::MutationImpact::TimeStateChanged),
        .elapsed = m_transaction_elapsed};
    auto settled = m_checkpoint_service.settle(m_kernel->state(), facts, mutations);
    return settled ? core::Diagnostics{} : std::move(settled).error();
}

void RuntimeSession::queue_input(core::RuntimeInputMessage input)
{
    m_script_inputs.push_back(std::move(input));
}

core::Result<void, core::Diagnostics> RuntimeSession::request_audio(
    core::compiled::AudioAction action, core::compiled::AudioPurpose purpose,
    std::optional<core::AssetId> asset, std::chrono::milliseconds fade, double gain, double pan,
    bool await_completion, core::compiled::AudioCausality causality,
    core::compiled::AudioPausePolicy pause_policy, core::compiled::AudioSkipBehavior skip_behavior)
{
    if (action > core::compiled::AudioAction::FadeOut ||
        purpose > core::compiled::AudioPurpose::UiSound ||
        pause_policy > core::compiled::AudioPausePolicy::Unscaled ||
        causality > core::compiled::AudioCausality::Disposable ||
        skip_behavior > core::compiled::AudioSkipBehavior::Play || fade.count() < 0 ||
        !std::isfinite(gain) || gain < 0.0 || gain > 1.0 || !std::isfinite(pan) || pan < -1.0 ||
        pan > 1.0) {
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
                           "Typed audio playback requires an existing Audio Asset ID")});
        }
        if (m_pending_audio) {
            return core::Result<void, core::Diagnostics>::failure(core::Diagnostics{diagnostic(
                "runtime.audio_operation_pending",
                "A blocking audio operation must finish before starting replacement playback")});
        }
    }
    if ((await_completion || skip_behavior == core::compiled::AudioSkipBehavior::Play) &&
        causality != core::compiled::AudioCausality::Causal) {
        return core::Result<void, core::Diagnostics>::failure(core::Diagnostics{diagnostic(
            "runtime.invalid_audio_causality", "Awaited and play-on-skip audio must be causal")});
    }
    if (purpose == core::compiled::AudioPurpose::UiSound &&
        (!playing || await_completion || causality != core::compiled::AudioCausality::Disposable ||
         pause_policy != core::compiled::AudioPausePolicy::Unscaled)) {
        return core::Result<void, core::Diagnostics>::failure(core::Diagnostics{
            diagnostic("runtime.invalid_ui_sound",
                       "UI Sound is disposable, unscaled playback and cannot control gameplay")});
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

    core::PresentationOwner owner{m_kernel->state().session_presentation_owner()};
    if (!m_kernel->state().flow_stack().empty()) {
        const auto& top = m_kernel->state().flow_stack().back();
        if (const auto* scene = std::get_if<core::SceneFrame>(&top))
            owner = core::ScenePresentationOwner{scene->frame_id, scene->scene};
        else if (const auto* dialogue = std::get_if<core::DialogueFrame>(&top))
            owner = core::DialoguePresentationOwner{dialogue->frame_id, dialogue->dialogue};
    }
    core::AudioOperation operation{
        .id = core::AudioOperationId::from_number(m_next_audio_id++),
        .action = action,
        .purpose = purpose,
        .pause_policy = pause_policy,
        .audio_owner = owner,
        .asset = std::move(asset),
        .fade = fade,
        .gain = gain,
        .pan = pan,
        .pan_source = std::nullopt,
        .completion_owner =
            script_blocker ? std::optional<core::FlowFrameId>{script_blocker->owner} : std::nullopt,
        .completion = script_blocker
                          ? std::optional<core::AudioCompletionHandle>{core::AudioCompletionHandle{
                                script_blocker->handle}}
                          : std::nullopt,
        .target =
            playing ? core::AudioOperationTarget{core::NewAudioPlaybackTarget{}}
                    : core::AudioOperationTarget{core::AudioPurposeOperationTarget{purpose, owner}},
        .causality = causality,
        .synchronized = false,
        .skip_behavior = skip_behavior};

    auto accepted = accept_audio(operation);
    if (!accepted)
        return core::Result<void, core::Diagnostics>::failure(std::move(accepted).error());

    if (script_blocker)
        m_pending_audio = operation;
    return core::Result<void, core::Diagnostics>::success();
}

core::Result<std::unique_ptr<RuntimeSession>, core::Diagnostics>
RuntimeSession::create(const core::CompiledProject& project, runtime::ScriptInvocationPort& scripts,
                       runtime::PresentationModelPort& presentation_model,
                       runtime::PresentationRuntimePort& presentation,
                       core::TypedSaveSlotStore& saves, const core::SaveStateCodecPort& save_codec,
                       std::string runtime_locale,
                       runtime::RuntimeBudgetConfiguration runtime_budget)
{
    if (runtime_budget.instruction_limit == 0 || runtime_budget.command_limit == 0) {
        return core::Result<std::unique_ptr<RuntimeSession>, core::Diagnostics>::failure(
            {core::Diagnostic{.code = "runtime.invalid_budget",
                              .message =
                                  "Runtime instruction and command budgets must be positive"}});
    }
    auto kernel = RuntimeExecutor::create(project, scripts, presentation_model);
    if (!kernel)
        return core::Result<std::unique_ptr<RuntimeSession>, core::Diagnostics>::failure(
            std::move(kernel).error());
    auto ready_diagnostics = run_on_game_ready(scripts, **kernel.value_if());
    if (!ready_diagnostics.empty())
        return core::Result<std::unique_ptr<RuntimeSession>, core::Diagnostics>::failure(
            std::move(ready_diagnostics));
    auto session = std::unique_ptr<RuntimeSession>(new RuntimeSession(
        project, scripts, presentation_model, presentation, saves, save_codec,
        std::move(*kernel.value_if()), std::move(runtime_locale), runtime_budget));
    auto checkpoint = session->m_checkpoint_service.publish_candidate(session->m_kernel->state());
    if (!checkpoint)
        return core::Result<std::unique_ptr<RuntimeSession>, core::Diagnostics>::failure(
            std::move(checkpoint).error());
    return core::Result<std::unique_ptr<RuntimeSession>, core::Diagnostics>::success(
        std::move(session));
}

core::Result<std::unique_ptr<RuntimeSession>, core::Diagnostics> RuntimeSession::restore(
    const core::CompiledProject& project, runtime::ScriptInvocationPort& scripts,
    runtime::PresentationModelPort& presentation_model,
    runtime::PresentationRuntimePort& presentation, core::TypedSaveSlotStore& saves,
    const core::SaveStateCodecPort& save_codec, core::TypedSaveSlotId slot,
    std::string runtime_locale, runtime::RuntimeBudgetConfiguration runtime_budget)
{
    if (runtime_budget.instruction_limit == 0 || runtime_budget.command_limit == 0) {
        return core::Result<std::unique_ptr<RuntimeSession>, core::Diagnostics>::failure(
            {core::Diagnostic{.code = "runtime.invalid_budget",
                              .message =
                                  "Runtime instruction and command budgets must be positive"}});
    }

    auto stored = saves.read_checkpoint(slot);
    if (!stored)
        return core::Result<std::unique_ptr<RuntimeSession>, core::Diagnostics>::failure(
            std::move(stored).error());
    auto decoded = save_codec.decode(project, stored.value_if()->encoded_save, "save-slot");
    if (!decoded)
        return core::Result<std::unique_ptr<RuntimeSession>, core::Diagnostics>::failure(
            std::move(decoded).error());

    auto kernel = RuntimeExecutor::restore(project, scripts, presentation_model,
                                           *decoded.value_if(), save_codec);
    if (!kernel)
        return core::Result<std::unique_ptr<RuntimeSession>, core::Diagnostics>::failure(
            std::move(kernel).error());
    auto ready_diagnostics = run_on_game_ready(scripts, **kernel.value_if());
    if (!ready_diagnostics.empty())
        return core::Result<std::unique_ptr<RuntimeSession>, core::Diagnostics>::failure(
            std::move(ready_diagnostics));

    auto session = std::unique_ptr<RuntimeSession>(new RuntimeSession(
        project, scripts, presentation_model, presentation, saves, save_codec,
        std::move(*kernel.value_if()), std::move(runtime_locale), runtime_budget));
    auto checkpoint = session->m_checkpoint_service.prepare_loaded_checkpoint(
        std::move(stored.value_if()->encoded_save), *decoded.value_if(),
        std::move(stored.value_if()->metadata), std::move(stored.value_if()->thumbnail));
    if (!checkpoint)
        return core::Result<std::unique_ptr<RuntimeSession>, core::Diagnostics>::failure(
            std::move(checkpoint).error());
    session->m_checkpoint_service.commit_loaded_checkpoint(std::move(*checkpoint.value_if()));
    return core::Result<std::unique_ptr<RuntimeSession>, core::Diagnostics>::success(
        std::move(session));
}

core::Result<runtime::PresentationAcceptance, core::Diagnostics>
RuntimeSession::accept_presentation(const core::PresentationOperation& operation)
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
RuntimeSession::accept_audio(const core::AudioOperation& operation)
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

core::Diagnostic RuntimeSession::diagnostic(std::string code, std::string message) const
{
    return core::Diagnostic{.code = std::move(code), .message = std::move(message)};
}

core::Diagnostics
RuntimeSession::capture_command_builder_subject(const core::compiled::InteractionSubject& subject)
{
    auto reference = m_kernel->command_builder_reference(subject, m_runtime_locale);
    if (!reference)
        return as_diagnostics(std::move(reference).error());
    const auto& state = *reference.value_if();
    if (!state.live || !state.available || !state.enabled || !state.visible) {
        return {diagnostic("runtime.command_builder_subject_unavailable",
                           "Command Builder subject press is not currently available")};
    }
    m_command_builder->captured_subject = subject;
    if (std::find(m_command_builder->captured_subjects.begin(),
                  m_command_builder->captured_subjects.end(),
                  subject) == m_command_builder->captured_subjects.end())
        m_command_builder->captured_subjects.push_back(subject);
    ++m_command_builder->capture_revision;
    m_transaction_impacts.record(runtime::MutationImpact::GameplayUiInvalidated);
    return {};
}

void RuntimeSession::invalidate_kernel(ScriptCancellationReason reason) noexcept
{
    if (!m_kernel)
        return;
    for (auto& execution : m_kernel->state().m_detached_flow_executions) {
        auto foreground = m_kernel->flow().take_execution_context();
        m_kernel->flow().install_execution_context(std::move(execution.context));
        (void)m_kernel->flow().discard_detached();
        execution.context = m_kernel->flow().take_execution_context();
        m_kernel->flow().install_execution_context(std::move(foreground));
    }
    m_kernel->state().m_detached_flow_executions.clear();
    if (const auto* blocker = active_blocker<core::ScriptFlowBlocker>(*m_kernel))
        m_scripts.cancel(blocker->handle, reason);
    const auto generation = m_kernel->gateway().generation();
    m_kernel->gateway().clear_transient_state();
    m_kernel->gateway().invalidate();
    m_scripts.invalidate_capabilities(generation);
}

core::Diagnostics RuntimeSession::run_kernel(std::vector<runtime::RuntimeEvent>& events,
                                             std::vector<core::RuntimeObservation>& observations,
                                             bool fast_forward)
{
    auto semantic_wait = m_kernel->resume_scene_semantic_wait_if_ready();
    if (!semantic_wait)
        return semantic_wait.error();
    if (*semantic_wait.value_if())
        record_structural_mutation();
    auto diagnostics = run_kernel_once(events, observations, fast_forward);
    if (!has_blocking_diagnostic(diagnostics)) {
        drain_deferred_commands(events, observations, diagnostics);
    } else {
        m_kernel->gateway().command_queue().clear();
    }
    if (!has_blocking_diagnostic(diagnostics) && !m_running_detached_flows)
        run_detached_flows(events, observations, diagnostics);
    if (m_kernel->state().flow_stack().empty()) {
        m_kernel->clear_trigger_context();
        m_kernel->clear_trigger_presentation_parent();
    }
    return diagnostics;
}

core::Diagnostics
RuntimeSession::run_kernel_once(std::vector<runtime::RuntimeEvent>& events,
                                std::vector<core::RuntimeObservation>& observations,
                                bool fast_forward)
{
    core::Diagnostics diagnostics;
    prune_scene_event_presentation_operations();
    const bool execution_can_advance =
        std::holds_alternative<core::FlowMode>(m_kernel->state().mode()) &&
        !m_kernel->state().blocker() && !m_kernel->state().gameplay_paused();
    const auto outcome = m_kernel->run_until_blocked(m_runtime_budget.instruction_limit,
                                                     m_runtime_locale, fast_forward);
    core::append_diagnostics(diagnostics, m_kernel->take_flow_diagnostics());
    if (const auto* fault = std::get_if<core::FlowFaultOutcome>(&outcome)) {
        core::append_diagnostics(diagnostics, fault->diagnostics);
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
    drain_pending_events(events);

    drain_script_inputs(events, observations, diagnostics);
    if (!has_blocking_diagnostic(diagnostics) && execution_can_advance)
        record_structural_mutation();
    return diagnostics;
}

void RuntimeSession::stage_gateway_events()
{
    for (auto& event : m_kernel->gateway().take_events())
        m_pending_events.emplace_back(std::move(event));
}

void RuntimeSession::drain_pending_events(std::vector<runtime::RuntimeEvent>& events)
{
    events.insert(events.end(), std::make_move_iterator(m_pending_events.begin()),
                  std::make_move_iterator(m_pending_events.end()));
    m_pending_events.clear();
}

void RuntimeSession::drain_script_inputs(std::vector<runtime::RuntimeEvent>& events,
                                         std::vector<core::RuntimeObservation>& observations,
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
            events.insert(events.end(), std::make_move_iterator(applied.events.begin()),
                          std::make_move_iterator(applied.events.end()));
            observations.insert(observations.end(),
                                std::make_move_iterator(applied.observations.begin()),
                                std::make_move_iterator(applied.observations.end()));
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

void RuntimeSession::collect_runtime_actions(core::Diagnostics& diagnostics)
{
    for (auto& pending : m_kernel->take_pending_audio_operations()) {
        core::AudioOperation operation{
            .id = core::AudioOperationId::from_number(m_next_audio_id++),
            .action = pending.action,
            .purpose = pending.purpose,
            .pause_policy = pending.pause_policy,
            .audio_owner = pending.owner,
            .asset = std::move(pending.asset),
            .fade = pending.fade,
            .gain = pending.gain,
            .pan = pending.pan,
            .pan_source = std::move(pending.pan_source),
            .completion_owner = pending.completion
                                    ? std::optional<core::FlowFrameId>{pending.completion->owner}
                                    : std::nullopt,
            .completion =
                pending.completion
                    ? std::optional<core::AudioCompletionHandle>{core::AudioCompletionHandle{
                          pending.completion->blocker}}
                    : std::nullopt,
            .target = std::move(pending.target),
            .causality = pending.causality,
            .synchronized = pending.synchronized,
            .skip_behavior = pending.skip_behavior};
        auto accepted = accept_audio(operation);
        if (!accepted) {
            core::append_diagnostics(diagnostics, std::move(accepted).error());
            if (pending.completion) {
                auto cancelled =
                    m_kernel->cancel(pending.completion->owner,
                                     core::AnyFlowBlockerHandle{pending.completion->blocker});
                if (!cancelled)
                    core::append_diagnostics(diagnostics, std::move(cancelled).error());
            }
            continue;
        }
        if (pending.scene_source) {
            std::erase_if(m_scene_event_audio_operations,
                          [&](const SceneEventAudioOperation& candidate) {
                              return candidate.owner == pending.scene_source->invocation &&
                                     candidate.scene == pending.scene_source->scene &&
                                     candidate.event == pending.scene_source->event;
                          });
            m_scene_event_audio_operations.push_back({pending.scene_source->invocation,
                                                      pending.scene_source->scene,
                                                      pending.scene_source->event, operation.id});
        }
        if (pending.completion)
            m_pending_audio = operation;
    }
    stage_gateway_events();
    const auto impacts = m_kernel->gateway().take_mutation_impacts();
    m_transaction_impacts.merge(impacts);
}

bool RuntimeSession::source_owner_is_current(
    const runtime::DeferredRuntimeCommand& command) const noexcept
{
    if (std::holds_alternative<runtime::RequestAutosaveCommand>(command.payload) ||
        !command.source.frame)
        return true;
    return !m_kernel->state().flow_stack().empty() &&
           core::flow_frame_id(m_kernel->state().flow_stack().back()) == *command.source.frame;
}

bool RuntimeSession::flow_frame_alive(const core::FlowFrameId& frame) const noexcept
{
    if (std::ranges::any_of(m_kernel->state().flow_stack(), [&](const core::FlowFrame& candidate) {
            return core::flow_frame_id(candidate) == frame;
        }))
        return true;
    return std::ranges::any_of(
        m_kernel->state().m_detached_flow_executions, [&](const core::DetachedFlowExecution& item) {
            return std::ranges::any_of(item.context.flow_stack,
                                       [&](const core::FlowFrame& candidate) {
                                           return core::flow_frame_id(candidate) == frame;
                                       });
        });
}

bool RuntimeSession::detached_owner_alive(
    const core::DetachedFlowExecution& execution) const noexcept
{
    switch (execution.owner) {
    case core::compiled::DetachedSceneOwner::Flow:
        return execution.flow_owner && flow_frame_alive(*execution.flow_owner);
    case core::compiled::DetachedSceneOwner::ActiveRoom:
        return m_kernel->state().room_visit() &&
               m_kernel->state().room_entry_sequence() == execution.room_entry_sequence;
    case core::compiled::DetachedSceneOwner::RuntimeSession:
        return true;
    }
    return false;
}

core::Diagnostics RuntimeSession::start_detached_scene(const StartDetachedSceneCommand& command,
                                                       const RuntimeSourceContext& source)
{
    if (command.owner == core::compiled::DetachedSceneOwner::Flow && !source.frame)
        return {diagnostic("runtime.detached_owner_unavailable",
                           "Flow-owned detached Scene requires an initiating Flow frame")};

    auto foreground = m_kernel->flow().take_execution_context();
    m_kernel->flow().install_execution_context(core::FlowExecutor::ExecutionContext{
        core::FlowMode{}, {}, std::nullopt, std::nullopt, false, true});
    auto started = m_kernel->flow().start_detached(command.scene, command.inputs, source.frame);
    auto detached = m_kernel->flow().take_execution_context();
    m_kernel->flow().install_execution_context(std::move(foreground));
    if (!started)
        return std::move(started).error();

    m_kernel->state().m_detached_flow_executions.push_back(core::DetachedFlowExecution{
        command.owner, source.frame, m_kernel->state().room_entry_sequence(), std::move(detached)});
    record_structural_mutation();
    return {};
}

void RuntimeSession::run_detached_flows(std::vector<runtime::RuntimeEvent>& events,
                                        std::vector<core::RuntimeObservation>& observations,
                                        core::Diagnostics& diagnostics,
                                        std::chrono::milliseconds elapsed)
{
    auto& detached_executions = m_kernel->state().m_detached_flow_executions;
    if (m_running_detached_flows || detached_executions.empty())
        return;

    m_running_detached_flows = true;
    for (std::size_t index = 0; index < detached_executions.size();) {
        if (!detached_owner_alive(detached_executions[index])) {
            auto foreground = m_kernel->flow().take_execution_context();
            m_kernel->flow().install_execution_context(
                std::move(detached_executions[index].context));
            (void)m_kernel->flow().discard_detached();
            detached_executions[index].context = m_kernel->flow().take_execution_context();
            m_kernel->flow().install_execution_context(std::move(foreground));
            detached_executions.erase(detached_executions.begin() + index);
            record_structural_mutation();
            continue;
        }

        auto foreground = m_kernel->flow().take_execution_context();
        m_kernel->flow().install_execution_context(std::move(detached_executions[index].context));

        bool can_run = true;
        bool branch_failed = false;
        if (elapsed.count() > 0) {
            if (const auto* blocker = active_blocker<core::DurationFlowBlocker>(*m_kernel)) {
                auto advanced = m_kernel->advance(blocker->owner, blocker->handle, elapsed);
                if (!advanced) {
                    core::append_diagnostics(diagnostics, std::move(advanced).error());
                    can_run = false;
                    branch_failed = true;
                } else {
                    can_run = *advanced.value_if();
                    if (can_run)
                        record_structural_mutation();
                }
            }
        }

        core::Diagnostics branch_diagnostics;
        if (can_run && !m_kernel->state().blocker() &&
            std::holds_alternative<core::FlowMode>(m_kernel->state().mode()))
            branch_diagnostics = run_kernel(events, observations);

        const bool finished = !std::holds_alternative<core::FlowMode>(m_kernel->state().mode()) ||
                              m_kernel->state().flow_stack().empty();
        branch_failed = branch_failed || !branch_diagnostics.empty();
        if (branch_failed) {
            (void)m_kernel->flow().discard_detached();
        }
        auto stored_context = m_kernel->flow().take_execution_context();
        m_kernel->flow().install_execution_context(std::move(foreground));
        detached_executions[index].context = std::move(stored_context);

        if (!branch_diagnostics.empty()) {
            core::append_diagnostics(diagnostics, std::move(branch_diagnostics));
            detached_executions.erase(detached_executions.begin() + index);
            continue;
        }
        if (branch_failed || finished) {
            detached_executions.erase(detached_executions.begin() + index);
            record_structural_mutation();
            continue;
        }
        ++index;
    }
    m_running_detached_flows = false;
}

void RuntimeSession::attach_command_context(core::Diagnostics& diagnostics,
                                            const runtime::DeferredRuntimeCommand& command) const
{
    if (!command.source.diagnostic)
        return;
    for (auto& item : diagnostics) {
        if (!item.runtime_context)
            item.runtime_context =
                std::make_shared<const core::RuntimeDiagnosticContext>(*command.source.diagnostic);
    }
}

core::Diagnostics RuntimeSession::execute_deferred_command(const DeferredRuntimeCommand& command)
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
                auto changed =
                    m_kernel->world().move_interactable(payload.interactable, payload.target);
                if (!changed)
                    diagnostics = std::move(changed).error();
            } else if constexpr (std::is_same_v<T, runtime::SetInteractableWorldStateCommand>) {
                if (payload.location) {
                    auto changed = m_kernel->world().move_interactable(payload.interactable,
                                                                       *payload.location);
                    if (!changed)
                        diagnostics = std::move(changed).error();
                }
                if (diagnostics.empty() && payload.enabled) {
                    auto changed = m_kernel->world().set_interactable_enabled(payload.interactable,
                                                                              *payload.enabled);
                    if (!changed)
                        diagnostics = std::move(changed).error();
                }
                if (diagnostics.empty() && payload.visible) {
                    auto changed = m_kernel->world().set_interactable_visible(payload.interactable,
                                                                              *payload.visible);
                    if (!changed)
                        diagnostics = std::move(changed).error();
                }
            } else if constexpr (std::is_same_v<T, runtime::SetCharacterWorldStateCommand>) {
                if (payload.location) {
                    auto changed =
                        m_kernel->world().move_character(payload.character, *payload.location);
                    if (!changed)
                        diagnostics = std::move(changed).error();
                }
                if (diagnostics.empty() && payload.enabled) {
                    auto changed = m_kernel->world().set_character_enabled(payload.character,
                                                                           *payload.enabled);
                    if (!changed)
                        diagnostics = std::move(changed).error();
                }
                if (diagnostics.empty() && payload.visible) {
                    auto changed = m_kernel->world().set_character_visible(payload.character,
                                                                           *payload.visible);
                    if (!changed)
                        diagnostics = std::move(changed).error();
                }
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
            } else if constexpr (std::is_same_v<T, runtime::StartDetachedSceneCommand>) {
                diagnostics = start_detached_scene(payload, command.source);
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
            } else if constexpr (std::is_same_v<T, runtime::UpsertBackgroundOverrideCommand>) {
                auto changed =
                    m_kernel->state().upsert_background_override(m_project, payload.value);
                if (!changed)
                    diagnostics = std::move(changed).error();
            } else if constexpr (std::is_same_v<T, runtime::RemoveBackgroundOverrideCommand>) {
                auto changed = m_kernel->state().remove_background_override(payload.owner);
                if (!changed)
                    diagnostics = std::move(changed).error();
            } else if constexpr (std::is_same_v<T, runtime::UpsertActorPresentationCommand>) {
                auto changed = m_kernel->state().set_actor(m_project, payload.value);
                if (!changed)
                    diagnostics = std::move(changed).error();
            } else if constexpr (std::is_same_v<T, runtime::RemoveActorPresentationCommand>) {
                auto changed =
                    m_kernel->state().remove_actor(m_project, payload.key, payload.owner);
                if (!changed)
                    diagnostics = std::move(changed).error();
            } else if constexpr (std::is_same_v<T, runtime::UpsertPresentationPropCommand>) {
                auto changed = m_kernel->state().upsert_presentation_prop(m_project, payload.value);
                if (!changed)
                    diagnostics = std::move(changed).error();
            } else if constexpr (std::is_same_v<T, runtime::RemovePresentationPropCommand>) {
                auto changed =
                    m_kernel->state().remove_presentation_prop(payload.instance, payload.owner);
                if (!changed)
                    diagnostics = std::move(changed).error();
            } else if constexpr (std::is_same_v<T, runtime::UpsertPresentationEnvironmentCommand>) {
                auto changed =
                    m_kernel->state().upsert_presentation_environment(m_project, payload.value);
                if (!changed)
                    diagnostics = std::move(changed).error();
            } else if constexpr (std::is_same_v<T, runtime::RemovePresentationEnvironmentCommand>) {
                auto changed = m_kernel->state().remove_presentation_environment(payload.instance,
                                                                                 payload.owner);
                if (!changed)
                    diagnostics = std::move(changed).error();
            } else if constexpr (std::is_same_v<
                                     T, runtime::RemovePresentationEnvironmentsByStopKeyCommand>) {
                auto changed = m_kernel->state().remove_presentation_environments(payload.stop_key,
                                                                                  payload.owner);
                if (!changed)
                    diagnostics = std::move(changed).error();
            } else if constexpr (std::is_same_v<T, runtime::UpsertMaterialParameterCommand>) {
                auto changed =
                    m_kernel->state().upsert_material_parameter(m_project, payload.value);
                if (!changed)
                    diagnostics = std::move(changed).error();
            } else if constexpr (std::is_same_v<T, runtime::RemoveMaterialParameterCommand>) {
                auto changed = m_kernel->state().remove_material_parameter(
                    payload.occurrence, payload.owner, payload.material, payload.parameter);
                if (!changed)
                    diagnostics = std::move(changed).error();
            } else if constexpr (std::is_same_v<T, runtime::UpsertPostprocessEffectCommand>) {
                auto changed =
                    m_kernel->state().upsert_postprocess_effect(m_project, payload.value);
                if (!changed)
                    diagnostics = std::move(changed).error();
            } else if constexpr (std::is_same_v<T, runtime::RemovePostprocessEffectCommand>) {
                auto changed =
                    m_kernel->state().remove_postprocess_effect(payload.instance, payload.owner);
                if (!changed)
                    diagnostics = std::move(changed).error();
            } else if constexpr (std::is_same_v<T, runtime::UpsertDesiredAudioCommand>) {
                auto changed = m_kernel->state().upsert_desired_audio(m_project, payload.value);
                if (!changed)
                    diagnostics = std::move(changed).error();
            } else if constexpr (std::is_same_v<T, runtime::RemoveDesiredAudioCommand>) {
                auto changed =
                    m_kernel->state().remove_desired_audio(payload.instance, payload.owner);
                if (!changed)
                    diagnostics = std::move(changed).error();
            } else if constexpr (std::is_same_v<T, runtime::RemoveDesiredAudioPurposeCommand>) {
                auto changed =
                    m_kernel->state().remove_desired_audio_purpose(payload.purpose, payload.owner);
                if (!changed)
                    diagnostics = std::move(changed).error();
            } else if constexpr (std::is_same_v<T, runtime::UpsertMountedLayoutCommand>) {
                if (payload.entrance && m_kernel->pending_presentation_operation()) {
                    diagnostics.push_back(diagnostic(
                        "runtime.presentation_operation_already_pending",
                        "Only one finite presentation operation may be staged per runtime input"));
                    return;
                }
                const auto source_state = m_kernel->state();
                std::optional<core::RoomPresentationResolution> source_room;
                if (payload.entrance && m_kernel->room_presentation())
                    source_room = *m_kernel->room_presentation();
                auto changed = m_kernel->state().upsert_mounted_layout(m_project, payload.value);
                if (!changed) {
                    diagnostics = std::move(changed).error();
                } else if (payload.entrance &&
                           source_state.mounted_layouts() != m_kernel->state().mounted_layouts()) {
                    m_kernel->stage_pending_presentation(
                        PendingLayoutOperation{payload.value.key, payload.value.owner,
                                               payload.entrance->duration,
                                               payload.entrance->skippable, std::nullopt},
                        source_state, std::move(source_room));
                }
            } else if constexpr (std::is_same_v<T, runtime::RemoveMountedLayoutCommand>) {
                if (payload.exit && m_kernel->pending_presentation_operation()) {
                    diagnostics.push_back(diagnostic(
                        "runtime.presentation_operation_already_pending",
                        "Only one finite presentation operation may be staged per runtime input"));
                    return;
                }
                const auto source_state = m_kernel->state();
                std::optional<core::RoomPresentationResolution> source_room;
                if (payload.exit && m_kernel->room_presentation())
                    source_room = *m_kernel->room_presentation();
                auto changed = m_kernel->state().remove_mounted_layout(payload.key, payload.owner);
                if (!changed) {
                    diagnostics = std::move(changed).error();
                } else if (payload.exit &&
                           source_state.mounted_layouts() != m_kernel->state().mounted_layouts()) {
                    m_kernel->stage_pending_presentation(
                        PendingLayoutOperation{payload.key, payload.owner, payload.exit->duration,
                                               payload.exit->skippable, std::nullopt},
                        source_state, std::move(source_room));
                }
            } else if constexpr (std::is_same_v<T, runtime::SetReservedLayoutCommand>) {
                auto changed = m_kernel->state().set_layout(m_project, payload.owner, payload.slot,
                                                            payload.layout);
                if (!changed)
                    diagnostics = std::move(changed).error();
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

void RuntimeSession::drain_deferred_commands(std::vector<runtime::RuntimeEvent>& events,
                                             std::vector<core::RuntimeObservation>& observations,
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
            auto continued = run_kernel_once(events, observations);
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

core::Diagnostics RuntimeSession::complete_presentation(
    core::PresentationOperationId operation, const core::FlowFrameId& owner,
    const core::PresentationFlowBlockerHandle& completion, bool cancel)
{
    if (!m_pending_presentation || m_pending_presentation->operation != operation ||
        m_pending_presentation->owner != owner || m_pending_presentation->completion != completion)
        return {diagnostic("runtime.stale_presentation_completion",
                           "Presentation completion does not match the pending operation")};
    if (m_dialogue_presentation_wait && m_dialogue_presentation_wait->frame == owner &&
        m_dialogue_presentation_wait->completion == completion) {
        const auto wait = *m_dialogue_presentation_wait;
        m_pending_presentation.reset();
        m_dialogue_presentation_wait.reset();
        record_structural_mutation();
        if (cancel)
            return {};
        return advance_dialogue_reveal(core::AdvanceDialogueRevealInput{
            wait.frame, wait.dialogue, wait.segment, wait.target_offset, wait.skipping});
    }
    auto result = cancel ? m_kernel->cancel(owner, core::AnyFlowBlockerHandle{completion})
                         : m_kernel->complete(owner, core::AnyFlowBlockerHandle{completion});
    if (!result)
        return std::move(result).error();
    const bool room_navigation = m_pending_presentation->room_navigation;
    m_pending_presentation.reset();
    if (cancel) {
        auto failed = m_kernel->fail_pending_presentation(
            room_navigation ? "execution.room_navigation_presentation_failed"
                            : "execution.presentation_operation_cancelled",
            room_navigation
                ? "Room navigation presentation failed after the destination was committed"
                : "Awaited presentation operation was cancelled without completion");
        return failed ? core::Diagnostics{} : std::move(failed).error();
    }
    record_structural_mutation();
    return {};
}

core::Diagnostics RuntimeSession::complete_audio(core::AudioOperationId operation,
                                                 const core::FlowFrameId& owner,
                                                 const core::AudioCompletionHandle& completion,
                                                 bool cancel)
{
    if (!m_pending_audio || m_pending_audio->id != operation || !m_pending_audio->completion ||
        !m_pending_audio->completion_owner || *m_pending_audio->completion_owner != owner ||
        *m_pending_audio->completion != completion)
        return {diagnostic("runtime.stale_audio_completion",
                           "Audio completion does not match the pending operation")};
    std::erase_if(m_scene_event_audio_operations, [&](const SceneEventAudioOperation& candidate) {
        return candidate.operation == operation;
    });
    if (m_dialogue_audio_wait) {
        const auto* flow = std::get_if<core::AudioFlowBlockerHandle>(&completion);
        if (flow && m_dialogue_audio_wait->frame == owner &&
            m_dialogue_audio_wait->completion == *flow) {
            const auto wait = *m_dialogue_audio_wait;
            m_pending_audio.reset();
            m_dialogue_audio_wait.reset();
            record_structural_mutation();
            if (cancel)
                return {};
            return advance_dialogue_reveal(core::AdvanceDialogueRevealInput{
                wait.frame, wait.dialogue, wait.segment, wait.target_offset, wait.skipping});
        }
    }
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
                    diagnostics = as_diagnostics(RuntimeExecutionError{result.error()});
            } else {
                auto result = m_kernel->resume_script(owner, handle);
                if (!result)
                    diagnostics = as_diagnostics(RuntimeExecutionError{result.error()});
            }
        },
        completion);
    if (!diagnostics.empty())
        return diagnostics;
    record_structural_mutation();
    return {};
}

core::Diagnostics
RuntimeSession::advance_dialogue_reveal(const core::AdvanceDialogueRevealInput& input)
{
    if (m_dialogue_audio_wait || m_dialogue_presentation_wait)
        return {};
    if (m_kernel->state().flow_stack().empty())
        return {diagnostic("runtime.dialogue_reveal_unavailable",
                           "Dialogue reveal progress requires an active Dialogue line")};
    auto* frame = std::get_if<core::DialogueFrame>(&m_kernel->state().flow_stack().back());
    if (frame == nullptr || frame->frame_id != input.frame || frame->dialogue != input.dialogue ||
        !frame->position.segment || *frame->position.segment != input.segment ||
        frame->position.stage != core::DialogueFramePosition::Stage::ApplySegmentEffects)
        return {diagnostic("runtime.stale_dialogue_reveal",
                           "Dialogue reveal progress targets a stale line occurrence")};
    if (input.offset < frame->position.reveal_offset)
        return {diagnostic("runtime.invalid_dialogue_reveal_progress",
                           "Dialogue reveal progress must be monotonic")};

    const auto* dialogue = m_project.find_dialogue(frame->dialogue);
    if (dialogue == nullptr)
        return {diagnostic("runtime.dialogue_reveal_unavailable",
                           "Active Dialogue definition is unavailable")};
    const core::compiled::DialogueSequenceBlock* sequence = nullptr;
    for (const auto& candidate : dialogue->program.blocks) {
        const auto* value = std::get_if<core::compiled::DialogueSequenceBlock>(&candidate);
        if (value != nullptr && value->id == frame->position.block) {
            sequence = value;
            break;
        }
    }
    if (sequence == nullptr)
        return {diagnostic("runtime.dialogue_reveal_unavailable",
                           "Active Dialogue sequence is unavailable")};
    const core::compiled::DialogueLineSegment* line = nullptr;
    for (const auto& candidate : sequence->segments) {
        const auto* value = std::get_if<core::compiled::DialogueLineSegment>(&candidate);
        if (value != nullptr && value->id == input.segment) {
            line = value;
            break;
        }
    }
    if (line == nullptr)
        return {diagnostic("runtime.dialogue_reveal_unavailable",
                           "Active Dialogue line is unavailable")};
    const auto speaker = line->speaker ? line->speaker
                                       : (sequence->default_speaker ? sequence->default_speaker
                                                                    : dialogue->default_speaker);

    while (frame->position.next_cue < line->cues.size()) {
        const std::size_t cue_index = frame->position.next_cue;
        const auto& cue = line->cues[cue_index];
        const auto cue_offset =
            std::visit([](const auto& value) { return value.position.offset; }, cue);
        if (cue_offset > input.offset)
            break;

        const bool suppress = std::visit(
            [&](const auto& value) {
                using C = std::decay_t<decltype(value)>;
                if constexpr (std::is_same_v<C, core::compiled::DialogueSoundEffectCue>)
                    return input.skipping &&
                           (value.causality == core::compiled::AudioCausality::Disposable ||
                            value.skip_behavior != core::compiled::AudioSkipBehavior::Play);
                else if constexpr (std::is_same_v<C, core::compiled::DialogueVoiceCue>)
                    return input.skipping &&
                           value.skip_behavior != core::compiled::AudioSkipBehavior::Play;
                else if constexpr (std::is_same_v<C, core::compiled::DialogueGestureCue>)
                    return input.skipping && value.skippable;
                else if constexpr (std::is_same_v<C, core::compiled::DialogueCameraCue>)
                    return input.skipping &&
                           std::visit([](const auto& emphasis) { return emphasis.skippable; },
                                      value.emphasis);
                else
                    return false;
            },
            cue);

        if (!suppress &&
            (std::holds_alternative<core::compiled::DialogueSpeakerExpressionCue>(cue) ||
             std::holds_alternative<core::compiled::DialogueStageCue>(cue) ||
             std::holds_alternative<core::compiled::DialogueMediaCue>(cue) ||
             std::holds_alternative<core::compiled::DialogueGestureCue>(cue))) {
            auto applied = m_kernel->flow().apply_dialogue_cues(
                frame->dialogue, frame->position, speaker,
                std::vector<core::compiled::DialogueSemanticCue>{cue});
            if (!applied)
                return std::move(applied).error();
        }

        const auto before = frame->position;
        auto advanced = m_kernel->flow().advance_dialogue_reveal(
            frame->dialogue, before, cue_index + 1,
            std::max(frame->position.reveal_offset, cue_offset));
        if (!advanced)
            return std::move(advanced).error();
        record_structural_mutation();
        frame = std::get_if<core::DialogueFrame>(&m_kernel->state().flow_stack().back());
        if (frame == nullptr)
            return {diagnostic("runtime.dialogue_reveal_unavailable",
                               "Dialogue frame ended while crossing a cue")};
        if (suppress)
            continue;

        if (const auto* voice = std::get_if<core::compiled::DialogueVoiceCue>(&cue)) {
            std::optional<core::AudioFlowBlockerHandle> completion;
            if (voice->wait_for_completion) {
                auto allocated = m_kernel->flow().allocate_audio_completion_handle();
                if (!allocated)
                    return std::move(allocated).error();
                completion = *allocated.value_if();
            }
            const core::PresentationOwner owner{
                core::DialoguePresentationOwner{frame->frame_id, frame->dialogue}};
            core::AudioOperation operation{
                .id = core::AudioOperationId::from_number(m_next_audio_id++),
                .action = core::compiled::AudioAction::Play,
                .purpose = core::compiled::AudioPurpose::Voice,
                .pause_policy = voice->pause_policy,
                .audio_owner = owner,
                .asset = voice->asset,
                .fade = std::chrono::milliseconds{0},
                .gain = voice->gain,
                .pan = voice->pan,
                .pan_source = std::nullopt,
                .completion_owner = completion ? std::optional{frame->frame_id} : std::nullopt,
                .completion = completion ? std::optional<core::AudioCompletionHandle>{*completion}
                                         : std::nullopt,
                .target = core::NewAudioPlaybackTarget{},
                .causality = core::compiled::AudioCausality::Causal,
                .synchronized = false,
                .skip_behavior = voice->skip_behavior};
            auto accepted = accept_audio(operation);
            if (!accepted)
                return std::move(accepted).error();
            if (completion) {
                m_pending_audio = operation;
                m_dialogue_audio_wait = DialogueAudioWait{
                    {frame->frame_id, frame->dialogue, input.segment, input.offset, input.skipping},
                    *completion};
                return {};
            }
            continue;
        }
        if (const auto* effect = std::get_if<core::compiled::DialogueSoundEffectCue>(&cue)) {
            std::optional<core::AudioFlowBlockerHandle> completion;
            if (effect->wait_for_completion) {
                auto allocated = m_kernel->flow().allocate_audio_completion_handle();
                if (!allocated)
                    return std::move(allocated).error();
                completion = *allocated.value_if();
            }
            const core::PresentationOwner owner{
                core::DialoguePresentationOwner{frame->frame_id, frame->dialogue}};
            core::AudioOperation operation{
                .id = core::AudioOperationId::from_number(m_next_audio_id++),
                .action = core::compiled::AudioAction::Play,
                .purpose = core::compiled::AudioPurpose::SoundEffect,
                .pause_policy = effect->pause_policy,
                .audio_owner = owner,
                .asset = effect->asset,
                .fade = std::chrono::milliseconds{0},
                .gain = effect->gain,
                .pan = effect->pan,
                .pan_source = std::nullopt,
                .completion_owner = completion ? std::optional{frame->frame_id} : std::nullopt,
                .completion = completion ? std::optional<core::AudioCompletionHandle>{*completion}
                                         : std::nullopt,
                .target = core::NewAudioPlaybackTarget{},
                .causality = effect->causality,
                .synchronized = effect->synchronized,
                .skip_behavior = effect->skip_behavior};
            auto accepted = accept_audio(operation);
            if (!accepted)
                return std::move(accepted).error();
            if (completion) {
                m_pending_audio = operation;
                m_dialogue_audio_wait = DialogueAudioWait{
                    {frame->frame_id, frame->dialogue, input.segment, input.offset, input.skipping},
                    *completion};
                return {};
            }
            continue;
        }

        std::optional<core::PresentationFlowBlockerHandle> completion;
        bool wait_for_completion = false;
        if (const auto* gesture = std::get_if<core::compiled::DialogueGestureCue>(&cue))
            wait_for_completion = gesture->wait_for_completion;
        else if (const auto* camera = std::get_if<core::compiled::DialogueCameraCue>(&cue))
            wait_for_completion =
                std::visit([](const auto& emphasis) { return emphasis.wait_for_completion; },
                           camera->emphasis);
        else
            continue;
        if (wait_for_completion) {
            auto allocated = m_kernel->flow().allocate_presentation_completion_handle();
            if (!allocated)
                return std::move(allocated).error();
            completion = *allocated.value_if();
        }
        if (!m_current_publication || m_current_publication->presentation.revision.number() ==
                                          std::numeric_limits<std::uint64_t>::max())
            return {diagnostic("presentation.snapshot_revision_exhausted",
                               "Dialogue cue presentation revision space is exhausted")};
        const auto source_revision = m_current_publication->presentation.revision;
        const auto target_revision =
            core::PresentationSnapshotRevision::from_number(source_revision.number() + 1);
        auto target_snapshot = m_current_publication->presentation;
        target_snapshot.revision = target_revision;

        std::optional<core::PresentationOperation> operation;
        if (const auto* gesture = std::get_if<core::compiled::DialogueGestureCue>(&cue)) {
            const auto instance = core::StrongId<core::ScopedActorInstanceTag>::create(
                "dialogue-" + std::to_string(frame->frame_id.number()) + "-" +
                gesture->slot_id.text());
            if (!instance)
                return instance.error();
            const core::ActorPresentationKey actor{core::ScopedActorKey{*instance.value_if()}};
            auto built = core::make_character_gesture_operation(
                m_project, m_current_publication->presentation, actor, gesture->gesture_id,
                core::PresentationOperationId::from_number(m_next_presentation_id++),
                completion
                    ? std::optional{core::PresentationFlowCompletion{frame->frame_id, *completion}}
                    : std::nullopt,
                gesture->skippable);
            if (!built)
                return std::move(built).error();
            built.value_if()->common.revisions = {source_revision, target_revision};
            operation = std::move(*built.value_if());
        } else if (const auto* camera = std::get_if<core::compiled::DialogueCameraCue>(&cue)) {
            const auto operation_id =
                core::PresentationOperationId::from_number(m_next_presentation_id++);
            const auto make_common = [&](std::uint64_t duration_ms, bool skippable) {
                return core::FinitePresentationOperationCommon{
                    operation_id,
                    std::chrono::milliseconds{static_cast<std::int64_t>(duration_ms)},
                    skippable,
                    core::LayoutClockDomain::Gameplay,
                    {source_revision, target_revision},
                    core::PresentationEasing::Linear};
            };
            operation = std::visit(
                [&](const auto& emphasis) -> core::PresentationOperation {
                    using E = std::decay_t<decltype(emphasis)>;
                    const auto common = make_common(emphasis.duration_ms, emphasis.skippable);
                    const auto completed =
                        completion ? std::optional{core::PresentationFlowCompletion{frame->frame_id,
                                                                                    *completion}}
                                   : std::nullopt;
                    if constexpr (std::is_same_v<E, core::compiled::DialogueCameraShakeEmphasis>)
                        return core::CameraShakeOperation{
                            common, {}, emphasis.amplitude, emphasis.frequency_hz, completed};
                    else if constexpr (std::is_same_v<E,
                                                      core::compiled::DialogueCameraPunchEmphasis>)
                        return core::CameraPunchOperation{common,
                                                          {},
                                                          emphasis.translation,
                                                          emphasis.zoom_delta,
                                                          emphasis.rotation_degrees,
                                                          completed};
                    else
                        return core::CameraFlashOperation{
                            common, {}, emphasis.color, emphasis.opacity, completed};
                },
                camera->emphasis);
        }
        if (!operation)
            continue;
        auto reconciled = m_presentation.reconcile_snapshot(target_snapshot);
        if (!reconciled)
            return std::move(reconciled).error();
        m_current_publication->presentation = target_snapshot;
        auto accepted = accept_presentation(*operation);
        if (!accepted)
            return std::move(accepted).error();
        if (completion) {
            const auto operation_id =
                std::visit([](const auto& value) { return value.common.id; }, *operation);
            m_pending_presentation =
                PendingPresentationCompletion{operation_id, frame->frame_id, *completion, false};
            m_dialogue_presentation_wait = DialoguePresentationWait{
                {frame->frame_id, frame->dialogue, input.segment, input.offset, input.skipping},
                *completion};
            return {};
        }
    }

    if (frame->position.reveal_offset < input.offset) {
        auto advanced = m_kernel->flow().advance_dialogue_reveal(
            frame->dialogue, frame->position, frame->position.next_cue, input.offset);
        if (!advanced)
            return std::move(advanced).error();
        record_structural_mutation();
    }
    return {};
}

void RuntimeSession::project_publication(WorkResult& work, runtime::RuntimeDispatchResult& result)
{
    if (m_transaction_impacts.contains(runtime::MutationImpact::RoomPresentationInvalidated) ||
        m_transaction_impacts.contains(runtime::MutationImpact::StructuralStateChanged) ||
        m_transaction_impacts.contains(runtime::MutationImpact::TimeStateChanged))
        m_kernel->invalidate_room_presentation();
    auto refreshed_room = m_kernel->refresh_room_presentation(m_runtime_locale);
    if (!refreshed_room) {
        core::append_diagnostics(result.diagnostics,
                                 as_diagnostics(std::move(refreshed_room).error()));
        result.disposition = runtime::RuntimeInputDisposition::Failed;
        return;
    }
    auto refreshed_stages = m_kernel->refresh_scene_stage_presentations(m_runtime_locale);
    if (!refreshed_stages) {
        core::append_diagnostics(result.diagnostics,
                                 as_diagnostics(std::move(refreshed_stages).error()));
        result.disposition = runtime::RuntimeInputDisposition::Failed;
        return;
    }
    auto view = m_kernel->runtime_ui_view(m_runtime_locale);
    if (!view) {
        core::append_diagnostics(result.diagnostics, as_diagnostics(std::move(view).error()));
        result.disposition = runtime::RuntimeInputDisposition::Failed;
        return;
    }
    auto gameplay_ui = std::move(*view.value_if());
    auto room_diagnostics = m_kernel->take_room_presentation_diagnostics();
    const bool retain_previous_presentation = !room_diagnostics.empty();
    if (!room_diagnostics.empty()) {
        if (!m_current_publication || !m_kernel->state().room_visit()) {
            core::append_diagnostics(result.diagnostics, std::move(room_diagnostics));
            result.disposition = runtime::RuntimeInputDisposition::Failed;
            return;
        }
        m_transaction_impacts.record(runtime::MutationImpact::ObservationInvalidated);
        work.observations.emplace_back(core::RoomPresentationDiagnosticObservation{
            m_kernel->state().room_visit()->room, std::move(room_diagnostics)});
        gameplay_ui = m_current_publication->gameplay_ui;
    } else {
        if (m_verb_menu_open && m_selection.size() == 1) {
            auto reference =
                m_kernel->command_builder_reference(m_selection.front(), m_runtime_locale);
            if (!reference) {
                core::append_diagnostics(result.diagnostics,
                                         as_diagnostics(std::move(reference).error()));
                result.disposition = runtime::RuntimeInputDisposition::Failed;
                return;
            }
            const auto& target = *reference.value_if();
            if (!target.live || !target.available || !target.enabled || !target.visible) {
                (void)m_kernel->dismiss_verb_menu();
                m_selection.clear();
                m_verb_menu_open = false;
                m_interaction_trigger_context.reset();
                m_interaction_presentation_parent.reset();
                m_transaction_impacts.record(runtime::MutationImpact::GameplayUiInvalidated);
            }
        }
        gameplay_ui.selected_subjects = m_selection;
        gameplay_ui.verb_menu_open = m_verb_menu_open;
        gameplay_ui.verb_offers.clear();
        if (m_selection.size() == 1) {
            auto offers = m_kernel->verb_offers(m_selection.front(), m_runtime_locale);
            if (!offers) {
                core::append_diagnostics(result.diagnostics,
                                         as_diagnostics(std::move(offers).error()));
                result.disposition = runtime::RuntimeInputDisposition::Failed;
                return;
            }
            gameplay_ui.verb_offers = std::move(*offers.value_if());
        }
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
        if (gameplay_ui.room) {
            const RoomDescriptionVisit visit{gameplay_ui.room->room, gameplay_ui.room->visits};
            if (!m_room_description_visit || *m_room_description_visit != visit) {
                m_room_description_visit = visit;
                m_room_description_visible = !gameplay_ui.room->description.empty();
            }
            const bool room_transition_active = !m_kernel->state().flow_stack().empty() &&
                                                std::holds_alternative<core::RoomTransitionFrame>(
                                                    m_kernel->state().flow_stack().front());
            // Keep the newly committed Room description pending while its lifecycle/visual
            // transition is still active. Suppressing the published copy must not consume the
            // per-visit description before the settled Room publication can display it.
            if (!m_room_description_visible || room_transition_active)
                gameplay_ui.room->description.clear();
        }
        const bool has_choice = (gameplay_ui.scene && gameplay_ui.scene->choice) ||
                                (gameplay_ui.dialogue && gameplay_ui.dialogue->choice);
        const bool room_transition_active = !m_kernel->state().flow_stack().empty() &&
                                            std::holds_alternative<core::RoomTransitionFrame>(
                                                m_kernel->state().flow_stack().front());
        const bool room_description_pending =
            gameplay_ui.room && m_room_description_visible && !room_transition_active;
        gameplay_ui.can_continue =
            ((active_blocker<core::InputFlowBlocker>(*m_kernel) != nullptr && !has_choice) ||
             room_description_pending) &&
            !m_dialogue_audio_wait && !m_dialogue_presentation_wait;
    }

    if (m_command_builder) {
        const bool owner_alive = gameplay_ui.mode == "room" && gameplay_ui.room &&
                                 m_command_builder->room &&
                                 gameplay_ui.room->room == *m_command_builder->room &&
                                 m_kernel->state().flow_stack().empty();
        if (!owner_alive) {
            m_command_builder.reset();
            m_transaction_impacts.record(runtime::MutationImpact::GameplayUiInvalidated);
        }
    }
    if (m_command_builder) {
        gameplay_ui.command_builder.active = true;
        gameplay_ui.command_builder.occurrence = m_command_builder->occurrence;
        gameplay_ui.command_builder.capture_revision = m_command_builder->capture_revision;
        gameplay_ui.command_builder.captured_subject = m_command_builder->captured_subject;
        for (const auto& subject : m_command_builder->watched_subjects) {
            auto watched = m_kernel->command_builder_reference(subject, m_runtime_locale);
            if (!watched) {
                core::append_diagnostics(result.diagnostics,
                                         as_diagnostics(std::move(watched).error()));
                result.disposition = runtime::RuntimeInputDisposition::Failed;
                return;
            }
            gameplay_ui.command_builder.watched.push_back(std::move(*watched.value_if()));
        }
    }
    m_script_view = gameplay_ui;

    const auto* room_resolution = m_kernel->room_presentation();
    core::Result<core::RuntimePresentationSnapshot, core::Diagnostics> presentation =
        retain_previous_presentation && m_current_publication
            ? core::Result<core::RuntimePresentationSnapshot, core::Diagnostics>::success(
                  m_current_publication->presentation)
            : m_presentation_model.project(
                  m_project, m_kernel->world(), m_kernel->state(),
                  room_resolution == nullptr ? nullptr : &room_resolution->presentation,
                  &m_kernel->scene_stage_presentations());
    if (!presentation) {
        core::append_diagnostics(result.diagnostics, std::move(presentation).error());
        result.disposition = runtime::RuntimeInputDisposition::Failed;
        return;
    }

    runtime::RuntimeObservationSnapshot observations{work.observations};

    auto presentation_value = std::move(*presentation.value_if());
    const auto& pending = m_kernel->pending_presentation_operation();
    std::optional<core::RuntimePresentationSnapshot> source_snapshot;
    if (pending) {
        if (m_current_publication) {
            source_snapshot = m_current_publication->presentation;
        } else {
            const auto* source_state = m_kernel->pending_presentation_source_state();
            if (source_state == nullptr) {
                result.diagnostics.push_back(
                    diagnostic("runtime.presentation_source_missing",
                               "Finite presentation operation has no rollback/source state"));
                result.disposition = runtime::RuntimeInputDisposition::Failed;
                m_kernel->rollback_pending_presentation();
                return;
            }
            const auto* source_room = m_kernel->pending_presentation_source_room();
            auto projected_source = m_presentation_model.project(
                m_project, m_kernel->world(), *source_state,
                source_room == nullptr ? nullptr : &source_room->presentation);
            if (!projected_source) {
                core::append_diagnostics(result.diagnostics, std::move(projected_source).error());
                result.disposition = runtime::RuntimeInputDisposition::Failed;
                m_kernel->rollback_pending_presentation();
                return;
            }
            source_snapshot = std::move(*projected_source.value_if());
            source_snapshot->revision = core::PresentationSnapshotRevision::from_number(1);
            auto reconciled_source = m_presentation.reconcile_snapshot(*source_snapshot);
            if (!reconciled_source) {
                core::append_diagnostics(result.diagnostics, std::move(reconciled_source).error());
                result.disposition = runtime::RuntimeInputDisposition::Failed;
                m_kernel->rollback_pending_presentation();
                return;
            }
        }
    }

    bool presentation_changed = true;
    if (m_current_publication) {
        presentation_value.revision = m_current_publication->presentation.revision;
        presentation_changed = presentation_value != m_current_publication->presentation;
    } else if (source_snapshot) {
        presentation_value.revision = source_snapshot->revision;
        presentation_changed = !same_snapshot_value(presentation_value, *source_snapshot);
    }

    if (pending && source_snapshot && same_snapshot_value(presentation_value, *source_snapshot)) {
        const auto completion = pending_completion(*pending);
        if (completion) {
            auto completed = m_kernel->complete(completion->owner,
                                                core::AnyFlowBlockerHandle{completion->blocker});
            if (!completed) {
                core::append_diagnostics(result.diagnostics, std::move(completed).error());
                result.disposition = runtime::RuntimeInputDisposition::Failed;
                m_kernel->rollback_pending_presentation();
                return;
            }
            record_structural_mutation();
        }
        m_kernel->commit_pending_presentation();
        auto continued = run_kernel(work.events, work.observations);
        if (!continued.empty()) {
            core::append_diagnostics(result.diagnostics, std::move(continued));
            result.disposition = runtime::RuntimeInputDisposition::Failed;
            return;
        }
        project_publication(work, result);
        return;
    }

    const bool changed =
        pending.has_value() || !m_current_publication || m_force_publication ||
        m_transaction_impacts.contains(runtime::MutationImpact::GameplayUiInvalidated) ||
        m_transaction_impacts.contains(runtime::MutationImpact::PresentationInvalidated) ||
        m_transaction_impacts.contains(runtime::MutationImpact::ObservationInvalidated) ||
        presentation_changed;
    if (!changed)
        return;

    if (pending) {
        if (!source_snapshot ||
            source_snapshot->revision.number() == std::numeric_limits<std::uint64_t>::max()) {
            result.diagnostics.push_back(
                diagnostic("presentation.snapshot_revision_exhausted",
                           "Runtime presentation snapshot revision space is exhausted"));
            result.disposition = runtime::RuntimeInputDisposition::Failed;
            m_kernel->rollback_pending_presentation();
            return;
        }
        presentation_value.revision =
            core::PresentationSnapshotRevision::from_number(source_snapshot->revision.number() + 1);
    } else if (!m_current_publication) {
        presentation_value.revision = core::PresentationSnapshotRevision::from_number(1);
    } else if (presentation_changed) {
        if (m_current_publication->presentation.revision.number() ==
            std::numeric_limits<std::uint64_t>::max()) {
            result.diagnostics.push_back(
                diagnostic("presentation.snapshot_revision_exhausted",
                           "Runtime presentation snapshot revision space is exhausted"));
            result.disposition = runtime::RuntimeInputDisposition::Failed;
            return;
        }
        presentation_value.revision = core::PresentationSnapshotRevision::from_number(
            m_current_publication->presentation.revision.number() + 1);
    }

    const auto subsequent = m_next_publication_revision.next();
    if (!subsequent) {
        result.diagnostics.push_back(diagnostic("runtime.publication_revision_exhausted",
                                                "Runtime publication revision space is exhausted"));
        result.disposition = runtime::RuntimeInputDisposition::Failed;
        if (pending)
            m_kernel->rollback_pending_presentation();
        return;
    }

    auto reconciled = m_presentation.reconcile_snapshot(presentation_value);
    if (!reconciled) {
        core::append_diagnostics(result.diagnostics, std::move(reconciled).error());
        result.disposition = runtime::RuntimeInputDisposition::Failed;
        if (pending)
            m_kernel->rollback_pending_presentation();
        return;
    }

    if (pending) {
        const auto operation_id =
            core::PresentationOperationId::from_number(m_next_presentation_id++);
        auto operation = materialize_operation(*pending, operation_id, source_snapshot->revision,
                                               presentation_value.revision);
        auto accepted = accept_presentation(operation);
        if (!accepted) {
            core::append_diagnostics(result.diagnostics, std::move(accepted).error());
            result.disposition = runtime::RuntimeInputDisposition::Failed;
            m_kernel->rollback_pending_presentation();
            auto restored = m_presentation.reconcile_snapshot(*source_snapshot);
            if (!restored)
                core::append_diagnostics(result.diagnostics, std::move(restored).error());
            return;
        }
        if (const auto completion = pending_completion(*pending)) {
            m_pending_presentation =
                PendingPresentationCompletion{operation_id, completion->owner, completion->blocker,
                                              pending_is_room_navigation(*pending)};
        } else {
            record_scene_event_presentation_operation(operation_id);
        }
        // The host may have rebound or reset its realization backend since this source revision was
        // published. Re-prime the exact predecessor before every finite operation.
        result.presentation_predecessor = *source_snapshot;
        m_kernel->commit_pending_presentation();
    }

    std::vector<runtime::RuntimeGameplayInstanceSnapshot> gameplay_instances;
    const auto& session_state = m_kernel->state();
    gameplay_instances.reserve(session_state.runtime_rooms().size() +
                               session_state.runtime_characters().size() +
                               session_state.runtime_interactables().size());
    for (const auto& instance : session_state.runtime_rooms())
        gameplay_instances.push_back(runtime::RuntimeGameplayInstanceSnapshot{
            core::GameplayInstanceRef{instance.id}, instance.declared, instance.provenance});
    for (const auto& instance : session_state.runtime_characters())
        gameplay_instances.push_back(runtime::RuntimeGameplayInstanceSnapshot{
            core::GameplayInstanceRef{instance.id}, instance.declared, instance.provenance});
    for (const auto& instance : session_state.runtime_interactables())
        gameplay_instances.push_back(runtime::RuntimeGameplayInstanceSnapshot{
            core::GameplayInstanceRef{instance.id}, instance.declared, instance.provenance});

    runtime::RuntimePublication publication{.revision = m_next_publication_revision,
                                            .gameplay_ui = std::move(gameplay_ui),
                                            .presentation = std::move(presentation_value),
                                            .observations = std::move(observations),
                                            .gameplay_instances = std::move(gameplay_instances)};
    m_next_publication_revision = *subsequent;
    m_current_publication = publication;
    result.publication = std::move(publication);
    m_force_publication = false;
}

RuntimeDispatchResult RuntimeSession::dispatch(const core::RuntimeInputMessage& input)
{
    assert_owner_thread();
    runtime::RuntimeDispatchResult result;
    if (m_dispatch_active) {
        result.disposition = runtime::RuntimeInputDisposition::Failed;
        result.diagnostics.push_back(diagnostic(
            "runtime.reentrant_dispatch", "Public runtime dispatch cannot be called recursively"));
        return result;
    }

    m_dispatch_active = true;
    m_transaction_budget_outcome = {};
    m_session_replacement_request.reset();
    auto work = apply_input(input);
    result.disposition = work.disposition;
    core::append_diagnostics(result.diagnostics, std::move(work.diagnostics));
    project_publication(work, result);
    core::append_diagnostics(result.diagnostics, settle_transaction());
    result.events = std::move(work.events);
    const auto checkpoint_observation = m_checkpoint_service.observation(m_kernel->state());
    const bool checkpoint_observation_changed =
        !m_last_checkpoint_observation || *m_last_checkpoint_observation != checkpoint_observation;
    if (result.publication) {
        result.publication->observations.values.emplace_back(checkpoint_observation);
        m_current_publication = *result.publication;
    }
    if (checkpoint_observation_changed) {
        result.events.emplace_back(
            runtime::ObservationEvent{core::RuntimeObservation{checkpoint_observation}});
        m_last_checkpoint_observation = checkpoint_observation;
    }
    if (!result.diagnostics.empty()) {
        result.disposition = runtime::RuntimeInputDisposition::Failed;
        m_session_replacement_request.reset();
    } else {
        result.session_replacement_request = std::move(m_session_replacement_request);
    }
    result.budget = m_transaction_budget_outcome;
    m_transaction_impacts.clear();
    m_transaction_elapsed = std::chrono::milliseconds{0};
    m_dispatch_active = false;
    return result;
}

RuntimeDispatchResult RuntimeSession::publish_initial_state()
{
    assert_owner_thread();
    runtime::RuntimeDispatchResult result;
    if (m_dispatch_active) {
        result.disposition = runtime::RuntimeInputDisposition::Failed;
        result.diagnostics.push_back(diagnostic(
            "runtime.reentrant_dispatch", "Public runtime dispatch cannot be called recursively"));
        return result;
    }

    m_dispatch_active = true;
    m_transaction_budget_outcome = {};
    m_session_replacement_request.reset();
    m_force_publication = true;
    WorkResult work;
    project_publication(work, result);
    core::append_diagnostics(result.diagnostics, settle_transaction());
    result.events = std::move(work.events);
    const auto checkpoint_observation = m_checkpoint_service.observation(m_kernel->state());
    const bool checkpoint_observation_changed =
        !m_last_checkpoint_observation || *m_last_checkpoint_observation != checkpoint_observation;
    if (result.publication) {
        result.publication->observations.values.emplace_back(checkpoint_observation);
        m_current_publication = *result.publication;
    }
    if (checkpoint_observation_changed) {
        result.events.emplace_back(
            runtime::ObservationEvent{core::RuntimeObservation{checkpoint_observation}});
        m_last_checkpoint_observation = checkpoint_observation;
    }
    if (!result.diagnostics.empty())
        result.disposition = runtime::RuntimeInputDisposition::Failed;
    result.budget = m_transaction_budget_outcome;
    m_transaction_impacts.clear();
    m_transaction_elapsed = std::chrono::milliseconds{0};
    m_dispatch_active = false;
    return result;
}

RuntimeSession::WorkResult RuntimeSession::apply_input(const core::RuntimeInputMessage& input)
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
                    result.diagnostics = run_kernel(result.events, result.observations);
                } else if constexpr (std::is_same_v<T, core::StopRuntimeInput>) {
                    m_running = false;
                    m_command_builder.reset();
                    for (auto& execution : m_kernel->state().m_detached_flow_executions) {
                        auto foreground = m_kernel->flow().take_execution_context();
                        m_kernel->flow().install_execution_context(std::move(execution.context));
                        (void)m_kernel->flow().discard_detached();
                        execution.context = m_kernel->flow().take_execution_context();
                        m_kernel->flow().install_execution_context(std::move(foreground));
                    }
                    m_kernel->state().m_detached_flow_executions.clear();
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
                    m_dialogue_presentation_wait.reset();
                    m_dialogue_audio_wait.reset();
                } else if constexpr (std::is_same_v<T, core::ResetRuntimeInput>) {
                    m_command_builder.reset();
                    m_dialogue_presentation_wait.reset();
                    m_dialogue_audio_wait.reset();
                    m_session_replacement_request = core::RuntimeInputMessage{value};
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
                                result.diagnostics = run_kernel(result.events, result.observations);
                            }
                        } else
                            result.diagnostics = run_kernel(result.events, result.observations);
                        if (result.diagnostics.empty())
                            run_detached_flows(result.events, result.observations,
                                               result.diagnostics, elapsed);
                    }
                } else if constexpr (std::is_same_v<T, core::ContinueInput>) {
                    const auto* blocker = active_blocker<core::InputFlowBlocker>(*m_kernel);
                    const auto* scene_frame =
                        !m_kernel->state().flow_stack().empty()
                            ? std::get_if<core::SceneFrame>(&m_kernel->state().flow_stack().back())
                            : nullptr;
                    const auto* scene_completion =
                        scene_frame ? std::get_if<core::SceneInstructionCompletionPosition>(
                                          &scene_frame->position.substate)
                                    : nullptr;
                    const bool semantic_scene_wait =
                        scene_completion != nullptr && scene_completion->semantic_wait.has_value();
                    if (blocker && (m_dialogue_audio_wait || m_dialogue_presentation_wait ||
                                    semantic_scene_wait)) {
                        result.disposition = runtime::RuntimeInputDisposition::Unhandled;
                    } else if (blocker) {
                        if (!m_kernel->state().flow_stack().empty()) {
                            const auto* dialogue = std::get_if<core::DialogueFrame>(
                                &m_kernel->state().flow_stack().back());
                            if (dialogue && dialogue->position.segment &&
                                dialogue->position.stage ==
                                    core::DialogueFramePosition::Stage::ApplySegmentEffects) {
                                result.diagnostics =
                                    advance_dialogue_reveal(core::AdvanceDialogueRevealInput{
                                        dialogue->frame_id, dialogue->dialogue,
                                        *dialogue->position.segment,
                                        std::numeric_limits<std::uint64_t>::max(), true});
                                if (!result.diagnostics.empty() || m_dialogue_audio_wait ||
                                    m_dialogue_presentation_wait)
                                    return;
                                blocker = active_blocker<core::InputFlowBlocker>(*m_kernel);
                            }
                        }
                        auto completed = m_kernel->complete(
                            blocker->owner, core::AnyFlowBlockerHandle{blocker->handle});
                        if (!completed)
                            result.diagnostics = std::move(completed).error();
                        else
                            result.diagnostics = run_kernel(result.events, result.observations);
                    } else if (m_room_description_visible && m_script_view.room) {
                        m_room_description_visible = false;
                        m_transaction_impacts.record(
                            runtime::MutationImpact::GameplayUiInvalidated);
                    } else {
                        result.disposition = runtime::RuntimeInputDisposition::Unhandled;
                    }
                } else if constexpr (std::is_same_v<T, core::FastForwardInput>) {
                    if (m_kernel->state().active_choice()) {
                        result.disposition = runtime::RuntimeInputDisposition::Unhandled;
                        return;
                    }
                    const auto* blocker =
                        m_kernel->state().blocker() ? &*m_kernel->state().blocker() : nullptr;
                    const auto* scene_frame =
                        !m_kernel->state().flow_stack().empty()
                            ? std::get_if<core::SceneFrame>(&m_kernel->state().flow_stack().back())
                            : nullptr;
                    const auto* scene_completion =
                        scene_frame ? std::get_if<core::SceneInstructionCompletionPosition>(
                                          &scene_frame->position.substate)
                                    : nullptr;
                    const bool operation_wait =
                        scene_completion && scene_completion->semantic_wait &&
                        (std::holds_alternative<core::ScenePresentationOperationWaitTarget>(
                             *scene_completion->semantic_wait) ||
                         std::holds_alternative<core::SceneAudioOperationWaitTarget>(
                             *scene_completion->semantic_wait));

                    if (blocker &&
                        (std::holds_alternative<core::PresentationFlowBlocker>(*blocker) ||
                         std::holds_alternative<core::AudioFlowBlocker>(*blocker) ||
                         std::holds_alternative<core::ScriptFlowBlocker>(*blocker) ||
                         operation_wait)) {
                        result.disposition = runtime::RuntimeInputDisposition::Unhandled;
                    } else if (const auto* input =
                                   blocker ? std::get_if<core::InputFlowBlocker>(blocker)
                                           : nullptr) {
                        const auto* dialogue = !m_kernel->state().flow_stack().empty()
                                                   ? std::get_if<core::DialogueFrame>(
                                                         &m_kernel->state().flow_stack().back())
                                                   : nullptr;
                        if (dialogue && dialogue->position.segment &&
                            dialogue->position.stage ==
                                core::DialogueFramePosition::Stage::ApplySegmentEffects) {
                            result.diagnostics =
                                advance_dialogue_reveal(core::AdvanceDialogueRevealInput{
                                    dialogue->frame_id, dialogue->dialogue,
                                    *dialogue->position.segment,
                                    std::numeric_limits<std::uint64_t>::max(), true});
                            if (!result.diagnostics.empty() || m_dialogue_audio_wait ||
                                m_dialogue_presentation_wait)
                                return;
                            input = active_blocker<core::InputFlowBlocker>(*m_kernel);
                            if (!input) {
                                result.diagnostics =
                                    run_kernel(result.events, result.observations, true);
                                return;
                            }
                        }
                        if (scene_frame && !active_scene_wait_skippable(m_project, *scene_frame)) {
                            result.disposition = runtime::RuntimeInputDisposition::Unhandled;
                            return;
                        }
                        auto completed = m_kernel->complete(
                            input->owner, core::AnyFlowBlockerHandle{input->handle});
                        if (!completed)
                            result.diagnostics = std::move(completed).error();
                        else
                            result.diagnostics =
                                run_kernel(result.events, result.observations, true);
                    } else if (const auto* duration =
                                   blocker ? std::get_if<core::DurationFlowBlocker>(blocker)
                                           : nullptr) {
                        if (!scene_frame || !active_scene_wait_skippable(m_project, *scene_frame)) {
                            result.disposition = runtime::RuntimeInputDisposition::Unhandled;
                            return;
                        }
                        auto completed = m_kernel->complete(
                            duration->owner, core::AnyFlowBlockerHandle{duration->handle});
                        if (!completed)
                            result.diagnostics = std::move(completed).error();
                        else
                            result.diagnostics =
                                run_kernel(result.events, result.observations, true);
                    } else if (!blocker) {
                        result.diagnostics = run_kernel(result.events, result.observations, true);
                    } else {
                        result.disposition = runtime::RuntimeInputDisposition::Unhandled;
                    }
                } else if constexpr (std::is_same_v<T, core::AdvanceDialogueRevealInput>) {
                    result.diagnostics = advance_dialogue_reveal(value);
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
                            result.diagnostics = run_kernel(result.events, result.observations);
                    } else {
                        auto chosen = m_kernel->choose_dialogue_option(blocker->owner,
                                                                       blocker->handle, value.edge);
                        if (!chosen)
                            result.diagnostics = std::move(chosen).error();
                        else
                            result.diagnostics = run_kernel(result.events, result.observations);
                    }
                } else if constexpr (std::is_same_v<T, core::NavigateRoomInput>) {
                    const bool room_transition_active =
                        !m_kernel->state().flow_stack().empty() &&
                        std::holds_alternative<core::RoomTransitionFrame>(
                            m_kernel->state().flow_stack().back());
                    if (room_transition_active) {
                        result.disposition = runtime::RuntimeInputDisposition::Unhandled;
                    } else {
                        auto changed = m_kernel->navigate(value.exit);
                        if (!changed)
                            result.diagnostics = std::move(changed).error();
                        else
                            result.diagnostics = run_kernel(result.events, result.observations);
                    }
                } else if constexpr (std::is_same_v<T, core::SelectInteractionSubjectsInput>) {
                    if (m_selection != value.subjects || m_verb_menu_open) {
                        m_selection = value.subjects;
                        if (m_verb_menu_open)
                            (void)m_kernel->dismiss_verb_menu();
                        m_verb_menu_open = false;
                        m_interaction_trigger_context.reset();
                        m_interaction_presentation_parent.reset();
                        m_transaction_impacts.record(
                            runtime::MutationImpact::GameplayUiInvalidated);
                    }
                } else if constexpr (std::is_same_v<T,
                                                    core::ClearInteractionSubjectSelectionInput>) {
                    if (!m_selection.empty() || m_verb_menu_open) {
                        m_selection.clear();
                        if (m_verb_menu_open)
                            (void)m_kernel->dismiss_verb_menu();
                        m_verb_menu_open = false;
                        m_interaction_trigger_context.reset();
                        m_interaction_presentation_parent.reset();
                        m_transaction_impacts.record(
                            runtime::MutationImpact::GameplayUiInvalidated);
                    }
                } else if constexpr (std::is_same_v<T, core::OpenVerbMenuInput>) {
                    if (m_command_builder) {
                        result.diagnostics = capture_command_builder_subject(value.subject);
                    } else {
                        auto offers = m_kernel->verb_offers(value.subject, m_runtime_locale);
                        if (!offers) {
                            result.diagnostics = as_diagnostics(std::move(offers).error());
                        } else {
                            auto presented =
                                m_kernel->present_verb_menu(value.subject, value.trigger_context);
                            if (!presented) {
                                result.diagnostics = std::move(presented).error();
                            } else {
                                m_selection = {value.subject};
                                m_verb_menu_open = true;
                                m_interaction_trigger_context = value.trigger_context;
                                m_interaction_presentation_parent = value.presentation_parent;
                                m_transaction_impacts.record(
                                    runtime::MutationImpact::GameplayUiInvalidated);
                            }
                        }
                    }
                } else if constexpr (std::is_same_v<T, core::PrimaryActivateInput>) {
                    if (m_command_builder) {
                        result.diagnostics = capture_command_builder_subject(value.subject);
                    } else {
                        auto offers = m_kernel->verb_offers(value.subject, m_runtime_locale);
                        if (!offers) {
                            result.diagnostics = as_diagnostics(std::move(offers).error());
                        } else {
                            m_selection = {value.subject};
                            const auto& values = *offers.value_if();
                            std::vector<const core::VerbOfferView*> primary;
                            for (const auto& offer : values)
                                if (offer.primary)
                                    primary.push_back(&offer);
                            if (primary.size() == 1 && primary.front()->binding_order.size() == 1 &&
                                primary.front()->slot == primary.front()->binding_order.front()) {
                                m_kernel->set_trigger_context(value.trigger_context);
                                m_kernel->set_trigger_presentation_parent(
                                    value.presentation_parent);
                                auto invoked =
                                    m_kernel->interact(primary.front()->verb,
                                                       {{primary.front()->slot, value.subject}});
                                if (!invoked)
                                    result.diagnostics = as_diagnostics(std::move(invoked).error());
                                else {
                                    (void)m_kernel->dismiss_verb_menu();
                                    m_verb_menu_open = false;
                                    m_interaction_trigger_context.reset();
                                    m_interaction_presentation_parent.reset();
                                    result.diagnostics =
                                        run_kernel(result.events, result.observations);
                                }
                            } else {
                                auto presented = m_kernel->present_verb_menu(value.subject,
                                                                             value.trigger_context);
                                if (!presented) {
                                    result.diagnostics = std::move(presented).error();
                                    return;
                                }
                                m_verb_menu_open = true;
                                m_interaction_trigger_context = value.trigger_context;
                                m_interaction_presentation_parent = value.presentation_parent;
                                if (primary.size() > 1) {
                                    std::vector<core::VerbId> primary_verbs;
                                    primary_verbs.reserve(primary.size());
                                    for (const auto* offer : primary)
                                        primary_verbs.push_back(offer->verb);
                                    result.events.emplace_back(
                                        runtime::ObservationEvent{core::RuntimeObservation{
                                            core::VerbOfferAmbiguityObservation{
                                                value.subject, std::move(primary_verbs)}}});
                                }
                            }
                            m_transaction_impacts.record(
                                runtime::MutationImpact::GameplayUiInvalidated);
                        }
                    }
                } else if constexpr (std::is_same_v<T, core::InvokeInteractionInput>) {
                    auto bindings = value.bindings;
                    if (bindings.empty()) {
                        const auto* verb = m_project.find_verb(value.verb);
                        if (verb && verb->binding_order.size() == m_selection.size())
                            for (std::size_t index = 0; index < m_selection.size(); ++index)
                                bindings.push_back(core::InteractionSubjectBinding{
                                    verb->binding_order[index], m_selection[index]});
                    }
                    m_kernel->set_trigger_context(m_interaction_trigger_context);
                    m_kernel->set_trigger_presentation_parent(m_interaction_presentation_parent);
                    auto invoked = m_kernel->interact(value.verb, std::move(bindings));
                    if (!invoked)
                        result.diagnostics = as_diagnostics(std::move(invoked).error());
                    else {
                        (void)m_kernel->dismiss_verb_menu();
                        m_verb_menu_open = false;
                        m_interaction_trigger_context.reset();
                        m_interaction_presentation_parent.reset();
                        if (m_command_builder) {
                            m_command_builder.reset();
                            m_transaction_impacts.record(
                                runtime::MutationImpact::GameplayUiInvalidated);
                        }
                        result.diagnostics = run_kernel(result.events, result.observations);
                    }
                } else if constexpr (std::is_same_v<T, core::BeginCommandBuilderInput>) {
                    const auto* room = std::get_if<core::RoomMode>(&m_kernel->state().mode());
                    if (room == nullptr || !m_kernel->state().flow_stack().empty()) {
                        result.diagnostics = {
                            diagnostic("runtime.command_builder_unavailable",
                                       "Command Builder requires settled Room exploration")};
                    } else if (m_next_command_builder_occurrence ==
                               std::numeric_limits<std::uint64_t>::max()) {
                        result.diagnostics = {
                            diagnostic("runtime.command_builder_occurrence_exhausted",
                                       "Command Builder occurrence identity space is exhausted")};
                    } else {
                        std::vector<core::compiled::InteractionSubject> initial_subjects;
                        initial_subjects.reserve(value.watched_subjects.size());
                        bool authorized = true;
                        for (const auto& subject : value.watched_subjects) {
                            if (std::find(m_selection.begin(), m_selection.end(), subject) ==
                                m_selection.end()) {
                                authorized = false;
                                break;
                            }
                            auto reference =
                                m_kernel->command_builder_reference(subject, m_runtime_locale);
                            if (!reference) {
                                result.diagnostics = as_diagnostics(std::move(reference).error());
                                authorized = false;
                                break;
                            }
                            const auto& state = *reference.value_if();
                            if (!state.live || !state.available || !state.enabled ||
                                !state.visible) {
                                result.diagnostics = {diagnostic(
                                    "runtime.command_builder_subject_unavailable",
                                    "Command Builder starting subject is not currently available")};
                                authorized = false;
                                break;
                            }
                            if (std::find(initial_subjects.begin(), initial_subjects.end(),
                                          subject) == initial_subjects.end())
                                initial_subjects.push_back(subject);
                        }
                        if (!authorized) {
                            if (result.diagnostics.empty())
                                result.diagnostics = {
                                    diagnostic("runtime.command_builder_unauthorized_subject",
                                               "Command Builder may begin only with "
                                               "runtime-selected subjects")};
                        } else {
                            m_command_builder = CommandBuilderState{
                                .occurrence = core::CommandBuilderOccurrenceId::from_number(
                                    m_next_command_builder_occurrence++),
                                .capture_revision = 0,
                                .captured_subject = std::nullopt,
                                .captured_subjects = initial_subjects,
                                .watched_subjects = std::move(initial_subjects),
                                .room = room->room};
                            m_selection.clear();
                            m_verb_menu_open = false;
                            m_transaction_impacts.record(
                                runtime::MutationImpact::GameplayUiInvalidated);
                        }
                    }
                } else if constexpr (std::is_same_v<T, core::CommandBuilderSubjectPressInput>) {
                    if (!m_command_builder || m_command_builder->occurrence != value.occurrence) {
                        result.diagnostics = {
                            diagnostic("runtime.stale_command_builder_occurrence",
                                       "Command Builder subject press targets a stale occurrence")};
                    } else {
                        result.diagnostics = capture_command_builder_subject(value.subject);
                    }
                } else if constexpr (std::is_same_v<T, core::UpdateCommandBuilderWatchInput>) {
                    if (!m_command_builder || m_command_builder->occurrence != value.occurrence) {
                        result.diagnostics = {
                            diagnostic("runtime.stale_command_builder_occurrence",
                                       "Command Builder watch update targets a stale occurrence")};
                    } else {
                        const bool authorized = std::all_of(
                            value.watched_subjects.begin(), value.watched_subjects.end(),
                            [&](const auto& subject) {
                                return std::find(m_command_builder->captured_subjects.begin(),
                                                 m_command_builder->captured_subjects.end(),
                                                 subject) !=
                                       m_command_builder->captured_subjects.end();
                            });
                        if (!authorized) {
                            result.diagnostics = {diagnostic(
                                "runtime.command_builder_unauthorized_subject",
                                "Command Builder may watch only runtime-captured subjects")};
                        } else {
                            m_command_builder->watched_subjects.clear();
                            for (const auto& subject : value.watched_subjects) {
                                if (std::find(m_command_builder->watched_subjects.begin(),
                                              m_command_builder->watched_subjects.end(),
                                              subject) == m_command_builder->watched_subjects.end())
                                    m_command_builder->watched_subjects.push_back(subject);
                            }
                            m_transaction_impacts.record(
                                runtime::MutationImpact::GameplayUiInvalidated);
                        }
                    }
                } else if constexpr (std::is_same_v<T, core::SubmitCommandBuilderInput>) {
                    if (!m_command_builder || m_command_builder->occurrence != value.occurrence) {
                        result.diagnostics = {
                            diagnostic("runtime.stale_command_builder_occurrence",
                                       "Command Builder submission targets a stale occurrence")};
                    } else {
                        const bool authorized = std::all_of(
                            value.bindings.begin(), value.bindings.end(), [&](const auto& binding) {
                                return std::find(m_command_builder->captured_subjects.begin(),
                                                 m_command_builder->captured_subjects.end(),
                                                 binding.subject) !=
                                       m_command_builder->captured_subjects.end();
                            });
                        if (!authorized) {
                            result.diagnostics = {
                                diagnostic("runtime.command_builder_unauthorized_subject",
                                           "Command Builder submission contains a subject that "
                                           "runtime did not capture")};
                        } else {
                            m_kernel->set_trigger_context(m_interaction_trigger_context);
                            m_kernel->set_trigger_presentation_parent(
                                m_interaction_presentation_parent);
                            auto invoked = m_kernel->interact(value.verb, value.bindings);
                            if (!invoked)
                                result.diagnostics = as_diagnostics(std::move(invoked).error());
                            else {
                                m_command_builder.reset();
                                m_interaction_trigger_context.reset();
                                m_interaction_presentation_parent.reset();
                                result.diagnostics = run_kernel(result.events, result.observations);
                                m_transaction_impacts.record(
                                    runtime::MutationImpact::GameplayUiInvalidated);
                            }
                        }
                    }
                } else if constexpr (std::is_same_v<T, core::CancelCommandBuilderInput>) {
                    if (!m_command_builder || m_command_builder->occurrence != value.occurrence) {
                        result.diagnostics = {
                            diagnostic("runtime.stale_command_builder_occurrence",
                                       "Command Builder cancellation targets a stale occurrence")};
                    } else {
                        m_command_builder.reset();
                        m_transaction_impacts.record(
                            runtime::MutationImpact::GameplayUiInvalidated);
                    }
                } else if constexpr (std::is_same_v<T, core::SetVariableDebugInput>) {
                    auto changed =
                        value.value
                            ? m_kernel->gateway().set_global_property(value.variable, *value.value)
                            : m_kernel->gateway().unset_global_property(value.variable);
                    if (!changed)
                        result.diagnostics = std::move(changed).error();
                } else if constexpr (std::is_same_v<T, core::SetPropertyDebugInput>) {
                    auto changed =
                        m_kernel->gateway().set_property(value.owner, value.property, value.value);
                    if (!changed)
                        result.diagnostics = std::move(changed).error();
                } else if constexpr (std::is_same_v<T, core::LayoutSignalInput>) {
                    auto validated = m_kernel->state().validate_layout_signal(
                        m_project, value.owner, value.key, value.occurrence, value.signal,
                        value.fields);
                    if (!validated)
                        result.diagnostics = std::move(validated).error();
                    else {
                        result.observations.emplace_back(core::LayoutSignalObservation{
                            value.owner, value.key, value.occurrence, value.signal, value.fields});
                        auto consumed = m_kernel->consume_layout_signal_wait(value);
                        if (!consumed)
                            result.diagnostics = std::move(consumed).error();
                        else if (*consumed.value_if()) {
                            record_structural_mutation();
                            result.diagnostics = run_kernel(result.events, result.observations);
                        }
                    }
                } else if constexpr (std::is_same_v<T, core::CommitLayoutStateInput>) {
                    auto committed = m_kernel->state().commit_layout_state(
                        m_project, value.owner, value.key, value.occurrence, value.scope,
                        value.value);
                    if (!committed)
                        result.diagnostics = std::move(committed).error();
                } else if constexpr (std::is_same_v<T, core::ClearLayoutStateInput>) {
                    auto cleared = m_kernel->state().clear_layout_state(
                        m_project, value.owner, value.key, value.occurrence, value.scope);
                    if (!cleared)
                        result.diagnostics = std::move(cleared).error();
                } else if constexpr (std::is_same_v<T, core::DismissLayoutInput>) {
                    const auto& mounted = m_kernel->state().mounted_layouts();
                    const auto found = std::find_if(mounted.begin(), mounted.end(),
                                                    [&](const core::DesiredMountedLayout& item) {
                                                        return item.owner == value.owner &&
                                                               item.key == value.key &&
                                                               item.occurrence &&
                                                               *item.occurrence == value.occurrence;
                                                    });
                    if (found == mounted.end()) {
                        result.diagnostics = {{.code = "execution.stale_layout_dismissal",
                                               .message = "Layout dismissal references a stale "
                                                          "Mount occurrence"}};
                    } else {
                        auto dismissed =
                            m_kernel->state().remove_mounted_layout(value.key, value.owner);
                        if (!dismissed)
                            result.diagnostics = std::move(dismissed).error();
                    }
                } else if constexpr (std::is_same_v<T, core::PresentInventoryInput>) {
                    auto presented = m_kernel->present_inventory(
                        value.inventory, value.layout, value.trigger_context,
                        value.presentation_parent, value.coexist);
                    if (!presented)
                        result.diagnostics = std::move(presented).error();
                } else if constexpr (std::is_same_v<T, core::PresentContextualLayoutInput>) {
                    auto presented = m_kernel->present_contextual_layout(
                        value.layout, value.instance, value.trigger_context,
                        value.presentation_parent);
                    if (!presented)
                        result.diagnostics = std::move(presented).error();
                } else if constexpr (std::is_same_v<T, core::SaveRuntimeInput>) {
                    if (value.slot.is_autosave()) {
                        (void)m_checkpoint_service.request(core::DeferredAutosaveRequest{});
                    } else {
                        auto requested =
                            m_checkpoint_service.request(core::ManualSaveRequest{value.slot});
                        if (const auto* failed =
                                std::get_if<core::CheckpointSaveFailed>(&requested))
                            result.diagnostics = failed->diagnostics;
                        else
                            result.events.emplace_back(runtime::SaveOutcomeEvent{core::SaveOutcome{
                                value.slot, core::SaveOutcomeStatus::Saved, false}});
                    }
                } else if constexpr (std::is_same_v<T, core::LoadRuntimeInput>) {
                    m_command_builder.reset();
                    m_session_replacement_request = core::RuntimeInputMessage{value};
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
                    if (result.diagnostics.empty())
                        result.diagnostics = run_kernel(result.events, result.observations);
                } else if constexpr (std::is_same_v<T, core::CompleteAudioInput> ||
                                     std::is_same_v<T, core::CancelAudioInput>) {
                    result.diagnostics =
                        complete_audio(value.operation, value.owner, value.completion,
                                       std::is_same_v<T, core::CancelAudioInput>);
                    if (result.diagnostics.empty())
                        result.diagnostics = run_kernel(result.events, result.observations);
                } else if constexpr (std::is_same_v<T, core::AcknowledgeAudioTerminationInput>) {
                    std::erase_if(m_scene_event_audio_operations,
                                  [&](const SceneEventAudioOperation& candidate) {
                                      return candidate.operation == value.operation;
                                  });
                    result.diagnostics = run_kernel(result.events, result.observations);
                } else
                    static_assert(always_false<T>, "Unhandled RuntimeInputMessage alternative");
            },
            input);

    drain_script_inputs(result.events, result.observations, result.diagnostics);
    collect_runtime_actions(result.diagnostics);
    drain_pending_events(result.events);
    if (result.diagnostics.empty())
        drain_deferred_commands(result.events, result.observations, result.diagnostics);
    else
        m_kernel->gateway().command_queue().clear();
    attach_runtime_context(result.diagnostics, *m_kernel);
    if (!result.diagnostics.empty())
        result.disposition = runtime::RuntimeInputDisposition::Failed;
    core::RuntimeObservation state_observation{core::RuntimeStateObservation{
        .mode = m_kernel->state().mode(),
        .active_frame =
            m_kernel->state().flow_stack().empty()
                ? std::nullopt
                : std::optional{core::flow_frame_id(m_kernel->state().flow_stack().back())},
        .blocker = m_kernel->state().blocker()
                       ? std::optional{core::flow_blocker_kind(*m_kernel->state().blocker())}
                       : std::nullopt,
        .game_completed = m_kernel->state().game_completed()}};
    result.observations.push_back(state_observation);
    result.events.emplace_back(runtime::ObservationEvent{std::move(state_observation)});
    if (m_playback) {
        core::RuntimeObservation playback_observation{core::PlaybackObservation{
            m_playback_step++, result.disposition == runtime::RuntimeInputDisposition::Handled}};
        result.observations.push_back(playback_observation);
        result.events.emplace_back(runtime::ObservationEvent{std::move(playback_observation)});
    }
    return result;
}

void RuntimeSession::set_effective_gameplay_pause(core::EffectiveGameplayPause pause) noexcept
{
    assert_owner_thread();
    if (m_effective_gameplay_pause == pause)
        return;
    m_effective_gameplay_pause = std::move(pause);
    m_force_publication = true;
}

bool RuntimeSession::explicit_gameplay_paused() const noexcept
{
    assert_owner_thread();
    return m_kernel->state().gameplay_paused();
}

} // namespace noveltea::runtime
