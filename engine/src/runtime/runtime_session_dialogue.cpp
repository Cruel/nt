#include "noveltea/runtime/runtime_session.hpp"

#include "noveltea/runtime/runtime_executor.hpp"

#include "noveltea/core/message_realization.hpp"

#include <algorithm>

namespace noveltea::runtime {
namespace {

std::uint64_t utf8_codepoint_count(std::string_view value) noexcept
{
    std::uint64_t count = 0;
    for (const unsigned char byte : value)
        if ((byte & 0xc0u) != 0x80u)
            ++count;
    return count;
}

core::DialogueCueId dialogue_cue_id(const core::compiled::DialogueSemanticCue& cue)
{
    return std::visit([](const auto& value) { return value.id; }, cue);
}

const core::compiled::DialogueLineSegment* find_dialogue_line(const core::CompiledProject& project,
                                                              const core::DialogueFrame& frame)
{
    if (!frame.position.segment)
        return nullptr;
    const auto* dialogue = project.find_dialogue(frame.dialogue);
    if (!dialogue)
        return nullptr;
    for (const auto& candidate : dialogue->program.blocks) {
        const auto* sequence = std::get_if<core::compiled::DialogueSequenceBlock>(&candidate);
        if (!sequence || sequence->id != frame.position.block)
            continue;
        for (const auto& segment : sequence->segments) {
            const auto* line = std::get_if<core::compiled::DialogueLineSegment>(&segment);
            if (line && line->id == *frame.position.segment)
                return line;
        }
    }
    return nullptr;
}

double dialogue_cue_progress(const core::compiled::DialogueSemanticCue& cue,
                             const core::CompiledProject& project, std::string_view locale,
                             std::optional<core::MessageId> message_id,
                             std::string_view realized_text)
{
    std::uint64_t offset = std::visit([](const auto& value) { return value.position.offset; }, cue);
    if (message_id) {
        const core::MessageRealizer realizer(project.localization());
        if (const auto* entry = realizer.resolved_entry(*message_id, locale)) {
            const auto id = dialogue_cue_id(cue);
            const auto placement = std::ranges::find_if(
                entry->dialogue_cues,
                [&](const core::compiled::LocalizedDialogueCuePlacement& candidate) {
                    return candidate.id == id;
                });
            if (placement != entry->dialogue_cues.end())
                offset = placement->offset;
        }
    }
    const auto length = utf8_codepoint_count(realized_text);
    if (length == 0)
        return 0.0;
    return std::clamp(static_cast<double>(offset) / static_cast<double>(length), 0.0, 1.0);
}

} // namespace

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
    if (!std::isfinite(input.progress) || input.progress < 0.0 || input.progress > 1.0 ||
        input.progress < frame->position.reveal_progress)
        return {diagnostic("runtime.invalid_dialogue_reveal_progress",
                           "Dialogue reveal progress must be finite, normalized, and monotonic")};

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
    const auto presented_text = m_kernel->state().presented_text();
    const auto realized_text =
        presented_text ? std::string_view{presented_text->text} : std::string_view{};
    std::optional<core::MessageId> message_id;
    if (presented_text && presented_text->localized_message)
        message_id = presented_text->localized_message->message_id;
    else if (const auto* message = std::get_if<core::MessageRef>(&line->text.source))
        message_id = message->id;

    while (frame->position.next_cue < line->cues.size()) {
        const std::size_t cue_index = frame->position.next_cue;
        const auto& cue = line->cues[cue_index];
        const auto cue_progress =
            dialogue_cue_progress(cue, m_project, m_runtime_locale, message_id, realized_text);
        if (cue_progress > input.progress)
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
            std::max(frame->position.reveal_progress, cue_progress));
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
                m_dialogue_audio_wait =
                    DialogueAudioWait{{frame->frame_id, frame->dialogue, input.segment,
                                       input.progress, input.skipping},
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
                m_dialogue_audio_wait =
                    DialogueAudioWait{{frame->frame_id, frame->dialogue, input.segment,
                                       input.progress, input.skipping},
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
                {frame->frame_id, frame->dialogue, input.segment, input.progress, input.skipping},
                *completion};
            return {};
        }
    }

    if (frame->position.reveal_progress < input.progress) {
        auto advanced = m_kernel->flow().advance_dialogue_reveal(
            frame->dialogue, frame->position, frame->position.next_cue, input.progress);
        if (!advanced)
            return std::move(advanced).error();
        record_structural_mutation();
    }
    return {};
}
RuntimeDispatchResult RuntimeSession::commit_locale(std::string locale)
{
    assert_owner_thread();
    runtime::RuntimeDispatchResult result;
    if (m_dispatch_active) {
        result.disposition = runtime::RuntimeInputDisposition::Failed;
        result.diagnostics.push_back(diagnostic("runtime.reentrant_locale_commit",
                                                "Runtime locale cannot commit during dispatch"));
        return result;
    }
    const auto supported = std::ranges::find_if(
        m_project.localization().locales, [&](const core::compiled::LocaleDefinition& candidate) {
            return candidate.supported && candidate.locale == locale;
        });
    if (supported == m_project.localization().locales.end()) {
        result.disposition = runtime::RuntimeInputDisposition::Failed;
        result.diagnostics.push_back(diagnostic(
            "runtime.locale_unsupported", "Requested locale is not a packaged Supported locale"));
        return result;
    }
    if (locale == m_runtime_locale) {
        result.disposition = runtime::RuntimeInputDisposition::Handled;
        return result;
    }

    const auto previous_locale = m_runtime_locale;
    const auto previous_presented_text = m_kernel->state().presented_text();
    const auto previous_active_choice = m_kernel->state().active_choice();
    const auto previous_text_log = m_kernel->state().text_log();
    m_pending_locale_cue_reconciliation.reset();
    m_dispatch_active = true;
    m_transaction_budget_outcome = {};
    m_session_replacement_request.reset();
    m_runtime_locale = std::move(locale);
    m_scripts.set_runtime_locale(m_runtime_locale);

    const core::MessageRealizer realizer(m_project.localization());
    const auto realize_occurrence =
        [&](const core::CapturedMessageOccurrence& occurrence) -> std::optional<std::string> {
        const auto realized =
            realizer.realize({occurrence.message_id, m_runtime_locale, occurrence.arguments});
        return realized ? std::optional<std::string>{realized->text} : std::nullopt;
    };

    if (auto presented = m_kernel->state().presented_text();
        presented && presented->localized_message) {
        if (auto text = realize_occurrence(*presented->localized_message)) {
            presented->text = std::move(*text);
            auto refreshed = m_kernel->state().present_text(m_project, *presented);
            if (!refreshed)
                core::append_diagnostics(result.diagnostics, std::move(refreshed).error());
        } else {
            result.diagnostics.push_back(
                diagnostic("runtime.localized_message_unavailable",
                           "Active localized text could not be realized for the requested locale"));
        }
    }

    if (result.diagnostics.empty() && m_kernel->state().active_choice()) {
        auto choice = *m_kernel->state().active_choice();
        bool choice_ok = true;
        std::visit(
            [&](auto& value) {
                using T = std::decay_t<decltype(value)>;
                if constexpr (std::is_same_v<T, core::SceneChoiceState>) {
                    if (value.localized_prompt) {
                        auto text = realize_occurrence(*value.localized_prompt);
                        if (text)
                            value.prompt = std::move(*text);
                        else
                            choice_ok = false;
                    }
                }
                for (auto& option : value.options) {
                    if (!option.localized_message)
                        continue;
                    auto text = realize_occurrence(*option.localized_message);
                    if (text)
                        option.label = std::move(*text);
                    else
                        choice_ok = false;
                }
            },
            choice);
        if (!choice_ok) {
            result.diagnostics.push_back(diagnostic(
                "runtime.localized_choice_unavailable",
                "Active localized choice text could not be realized for the requested locale"));
        } else {
            auto refreshed = m_kernel->state().present_choice(m_project, std::move(choice));
            if (!refreshed)
                core::append_diagnostics(result.diagnostics, std::move(refreshed).error());
        }
    }

    if (result.diagnostics.empty()) {
        for (auto& entry : m_kernel->state().m_text_log) {
            if (!entry.localized_message)
                continue;
            auto text = realize_occurrence(*entry.localized_message);
            if (!text) {
                result.diagnostics.push_back(diagnostic(
                    "runtime.localized_text_log_unavailable",
                    "Localized Text Log entry could not be realized for the requested locale"));
                break;
            }
            entry.text = std::move(*text);
        }
    }

    if (result.diagnostics.empty() && !m_kernel->state().flow_stack().empty()) {
        if (auto* frame =
                std::get_if<core::DialogueFrame>(&m_kernel->state().flow_stack().back())) {
            const auto* line = find_dialogue_line(m_project, *frame);
            if (line &&
                frame->position.stage == core::DialogueFramePosition::Stage::ApplySegmentEffects)
                m_pending_locale_cue_reconciliation = core::AdvanceDialogueRevealInput{
                    frame->frame_id, frame->dialogue, *frame->position.segment,
                    frame->position.reveal_progress, false};
        }
    }

    m_force_publication = true;
    WorkResult work;
    if (result.diagnostics.empty())
        project_publication(work, result);
    core::append_diagnostics(result.diagnostics, settle_transaction());
    result.events = std::move(work.events);
    if (result.publication)
        result.publication->observations.values.emplace_back(
            m_checkpoint_service.observation(m_kernel->state()));
    if (!result.diagnostics.empty()) {
        m_runtime_locale = previous_locale;
        m_scripts.set_runtime_locale(m_runtime_locale);
        m_pending_locale_cue_reconciliation.reset();
        if (previous_presented_text)
            (void)m_kernel->state().present_text(m_project, *previous_presented_text);
        if (previous_active_choice)
            (void)m_kernel->state().present_choice(m_project, *previous_active_choice);
        m_kernel->state().m_text_log = previous_text_log;
        m_force_publication = true;
        result.publication.reset();
        result.disposition = runtime::RuntimeInputDisposition::Failed;
    } else {
        result.disposition = runtime::RuntimeInputDisposition::Handled;
        if (result.publication)
            m_current_publication = *result.publication;
    }
    result.budget = m_transaction_budget_outcome;
    m_transaction_impacts.clear();
    m_transaction_elapsed = std::chrono::milliseconds{0};
    m_dispatch_active = false;
    return result;
}
RuntimeDispatchResult RuntimeSession::reconcile_committed_locale_cues()
{
    assert_owner_thread();
    runtime::RuntimeDispatchResult result;
    if (m_dispatch_active) {
        result.disposition = runtime::RuntimeInputDisposition::Failed;
        result.diagnostics.push_back(
            diagnostic("runtime.reentrant_locale_cue_reconciliation",
                       "Locale cue reconciliation cannot run during dispatch"));
        return result;
    }
    if (!m_pending_locale_cue_reconciliation) {
        result.disposition = runtime::RuntimeInputDisposition::Handled;
        return result;
    }

    const auto input = *m_pending_locale_cue_reconciliation;
    m_pending_locale_cue_reconciliation.reset();
    m_dispatch_active = true;
    m_transaction_budget_outcome = {};
    m_session_replacement_request.reset();

    result.diagnostics = advance_dialogue_reveal(input);
    WorkResult work;
    if (result.diagnostics.empty())
        project_publication(work, result);
    core::append_diagnostics(result.diagnostics, settle_transaction());
    result.events = std::move(work.events);
    if (result.publication)
        result.publication->observations.values.emplace_back(
            m_checkpoint_service.observation(m_kernel->state()));
    if (result.diagnostics.empty()) {
        result.disposition = runtime::RuntimeInputDisposition::Handled;
        if (result.publication)
            m_current_publication = *result.publication;
    } else {
        result.disposition = runtime::RuntimeInputDisposition::Failed;
    }
    result.budget = m_transaction_budget_outcome;
    m_transaction_impacts.clear();
    m_transaction_elapsed = std::chrono::milliseconds{0};
    m_dispatch_active = false;
    return result;
}

} // namespace noveltea::runtime
