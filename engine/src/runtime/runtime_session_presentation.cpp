#include "noveltea/runtime/runtime_session.hpp"

#include "noveltea/runtime/runtime_executor.hpp"

#include <cmath>
#include <limits>
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
core::Result<void, core::Diagnostics> RuntimeSession::set_gameplay_cursor(std::string name)
{
    static constexpr std::array<std::string_view, 13> system_names{
        "default",     "pointer",   "text",      "wait",        "progress",    "crosshair", "move",
        "not-allowed", "ns-resize", "ew-resize", "nesw-resize", "nwse-resize", "none"};
    const bool system = std::ranges::find(system_names, name) != system_names.end();
    const bool named = std::ranges::any_of(m_project.settings().cursors.named,
                                           [&](const auto& cursor) { return cursor.id == name; });
    if (!system && !named) {
        return core::Result<void, core::Diagnostics>::failure(core::Diagnostics{diagnostic(
            "runtime.cursor.invalid_name", "Unknown gameplay cursor name '" + name + "'")});
    }
    return m_presentation.set_gameplay_cursor(std::move(name));
}

core::Result<void, core::Diagnostics>
RuntimeSession::set_gameplay_cursor_image(core::AssetId asset,
                                          std::optional<std::uint32_t> hotspot_x,
                                          std::optional<std::uint32_t> hotspot_y)
{
    if (hotspot_x.has_value() != hotspot_y.has_value()) {
        return core::Result<void, core::Diagnostics>::failure(core::Diagnostics{
            diagnostic("runtime.cursor.invalid_hotspot",
                       "Cursor hotspot_x and hotspot_y must be provided together")});
    }
    const auto* definition = m_project.find_asset(asset);
    if (definition == nullptr || definition->kind != core::compiled::AssetKind::Image ||
        !definition->width || !definition->height || *definition->width == 0 ||
        *definition->height == 0) {
        return core::Result<void, core::Diagnostics>::failure(core::Diagnostics{diagnostic(
            "runtime.cursor.invalid_image_asset",
            "Gameplay cursor images require an existing Image Asset ID with dimensions")});
    }
    if (hotspot_x && (*hotspot_x >= *definition->width || *hotspot_y >= *definition->height)) {
        return core::Result<void, core::Diagnostics>::failure(core::Diagnostics{
            diagnostic("runtime.cursor.invalid_hotspot",
                       "Gameplay cursor hotspot must be inside the source image")});
    }
    if (!hotspot_x) {
        hotspot_x = *definition->width / 2;
        hotspot_y = *definition->height / 2;
    }
    return m_presentation.set_gameplay_cursor_image(std::move(asset), hotspot_x, hotspot_y);
}

core::Result<void, core::Diagnostics> RuntimeSession::clear_gameplay_cursor()
{
    return m_presentation.clear_gameplay_cursor();
}
core::Result<void, core::Diagnostics> RuntimeSession::request_motion(MotionRequest request)
{
    using Result = core::Result<void, core::Diagnostics>;
    const auto reject = [this](std::string message) {
        return Result::failure(
            core::Diagnostics{diagnostic("runtime.motion_request_invalid", std::move(message))});
    };
    if (!m_current_publication || m_kernel->pending_presentation_operation() ||
        m_pending_presentation)
        return reject("Motion requires a published occurrence and no pending presentation request");
    const auto& snapshot = m_current_publication->presentation;
    const core::PresentationInteractable* selected = nullptr;
    for (const auto& entry : snapshot.interactables) {
        if (entry.interactable != request.interactable)
            continue;
        if (selected)
            return reject("Motion requires one unambiguous Interactable occurrence");
        selected = &entry;
    }
    if (!selected || !selected->visible || !selected->visual)
        return reject("Motion requires a visible placed Interactable occurrence");
    const auto* visual = std::get_if<core::compiled::AnimationVisual>(&*selected->visual);
    const auto* animation = visual ? m_project.find_animation(visual->animation) : nullptr;
    if (!animation || request.playback.repeat != core::MotionRepeat::Once ||
        request.playback.loop_range)
        return reject("Finite motion requires an Animation and once-only playback");
    const auto motion = std::ranges::find_if(
        animation->motions, [&](const auto& candidate) { return candidate.id == request.motion; });
    if (motion == animation->motions.end())
        return reject("The requested Animation motion does not exist");
    const auto prepared_duration = m_motion_duration_lookup
                                       ? m_motion_duration_lookup(visual->animation, request.motion)
                                       : std::nullopt;
    const auto initial =
        core::compiled::motion_initial_time(*motion, request.playback, prepared_duration);
    const auto endpoint = core::compiled::motion_duration_ms(*motion, prepared_duration);
    if (!initial || !endpoint || *initial >= *endpoint)
        return reject("Invalid finite motion policy, marker, or unresolved endpoint");
    const long double duration =
        std::ceil(static_cast<long double>(*endpoint - *initial) / request.playback.rate);
    if (duration <= 0 || duration > std::numeric_limits<std::int64_t>::max())
        return reject("Finite motion requires a representable positive endpoint duration");
    const auto* script =
        request.await_completion ? active_blocker<core::ScriptFlowBlocker>(*m_kernel) : nullptr;
    if (request.await_completion && !script)
        return reject("Awaited motion requires an active yield-capable Lua invocation");
    auto candidate = m_kernel->state();
    if (request.transition_target) {
        if (request.transition_target->target !=
            core::MotionSelectionTarget{core::InteractableMotionTarget{request.interactable}})
            return reject("Transition target must select the exact requested Interactable");
        auto changed = candidate.upsert_motion_selection(m_project, *request.transition_target);
        if (!changed)
            return changed;
    }
    std::optional<core::PresentationFlowCompletion> completion;
    if (script) {
        auto handle = m_kernel->flow().allocate_presentation_completion_handle();
        if (!handle)
            return Result::failure(handle.error());
        completion = core::PresentationFlowCompletion{script->owner, *handle.value_if()};
    }
    core::InteractableMotionOperationTarget target{request.interactable, selected->placement};
    if (selected->occurrence)
        target.occurrence = std::visit(
            [](const auto& value) -> core::InteractableMotionOperationOccurrence {
                using T = std::decay_t<decltype(value)>;
                if constexpr (std::is_same_v<T, core::RoomInteractableEntryId>)
                    return value;
                else if constexpr (std::is_same_v<T, core::DynamicRoomInteractableOccurrenceId>)
                    return core::DynamicInteractableMotionOccurrence{value.interactable};
                else
                    return core::FallbackInteractableMotionOccurrence{value.interactable};
            },
            *selected->occurrence);
    const auto source = m_kernel->state();
    std::optional<core::RoomPresentationResolution> source_room;
    if (m_kernel->room_presentation())
        source_room = *m_kernel->room_presentation();
    m_kernel->state() = std::move(candidate);
    m_kernel->stage_pending_presentation(
        PendingMotionOperation{
            target, request.motion,
            request.transition_target ? std::optional{request.transition_target->motion}
                                      : std::nullopt,
            request.playback, std::chrono::milliseconds{static_cast<std::int64_t>(duration)},
            request.skippable, completion, script ? std::optional{script->handle} : std::nullopt},
        source, std::move(source_room));
    record_structural_mutation();
    return Result::success();
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
core::Diagnostics RuntimeSession::complete_presentation(
    core::PresentationOperationId operation, const core::FlowFrameId& owner,
    const core::PresentationFlowBlockerHandle& completion, bool cancel)
{
    if (!m_pending_presentation || m_pending_presentation->operation != operation ||
        m_pending_presentation->owner != owner || m_pending_presentation->completion != completion)
        return {diagnostic("runtime.stale_presentation_completion",
                           "Presentation completion does not match the pending operation")};
    if (m_pending_presentation->script) {
        const auto script = *m_pending_presentation->script;
        m_pending_presentation.reset();
        core::Diagnostics diagnostics;
        if (cancel) {
            auto result = m_kernel->cancel_script(owner, script);
            if (!result)
                diagnostics = as_diagnostics(result.error());
        } else {
            auto result = m_kernel->resume_script(owner, script);
            if (!result)
                diagnostics = as_diagnostics(result.error());
        }
        if (!diagnostics.empty())
            return diagnostics;
        record_structural_mutation();
        return {};
    }
    if (m_dialogue_presentation_wait && m_dialogue_presentation_wait->frame == owner &&
        m_dialogue_presentation_wait->completion == completion) {
        const auto wait = *m_dialogue_presentation_wait;
        m_pending_presentation.reset();
        m_dialogue_presentation_wait.reset();
        record_structural_mutation();
        if (cancel)
            return {};
        return advance_dialogue_reveal(core::AdvanceDialogueRevealInput{
            wait.frame, wait.dialogue, wait.segment, wait.target_progress, wait.skipping});
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

} // namespace noveltea::runtime
