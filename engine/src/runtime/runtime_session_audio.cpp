#include "noveltea/runtime/runtime_session.hpp"

#include "noveltea/runtime/runtime_executor.hpp"

#include <algorithm>
#include <cmath>
#include <type_traits>

namespace noveltea::runtime {
namespace {

core::Diagnostics as_diagnostics(RuntimeExecutionError error)
{
    if (auto* diagnostics = std::get_if<core::Diagnostics>(&error))
        return std::move(*diagnostics);
    return {core::Diagnostic{.code = "runtime.script_failed",
                             .message = std::get<ScriptInvocationError>(error).message}};
}

template<class T> const T* active_blocker(const RuntimeExecutor& kernel)
{
    return kernel.state().blocker() ? std::get_if<T>(&*kernel.state().blocker()) : nullptr;
}

} // namespace

bool RuntimeSession::scene_event_audio_operation_active(
    const core::FlowFrameId& owner, const core::SceneId& scene,
    const core::SceneStepId& event) const noexcept
{
    return std::ranges::any_of(
        m_scene_event_audio_operations, [&](const SceneEventAudioOperation& operation) {
            return operation.owner == owner && operation.scene == scene && operation.event == event;
        });
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
                wait.frame, wait.dialogue, wait.segment, wait.target_progress, wait.skipping});
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

} // namespace noveltea::runtime
