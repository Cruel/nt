#include "noveltea/runtime/runtime_executor.hpp"

#include <algorithm>
#include <limits>

namespace noveltea::core {
namespace {

Diagnostic diagnostic(std::string code, std::string message)
{
    return {.code = std::move(code), .message = std::move(message)};
}

} // namespace

Result<CharacterGestureOperation, Diagnostics> make_character_gesture_operation(
    const CompiledProject& project, const RuntimePresentationSnapshot& snapshot,
    const ActorPresentationKey& actor, const CharacterGestureId& gesture,
    PresentationOperationId operation, std::optional<PresentationFlowCompletion> completion,
    bool skippable)
{
    const auto actor_state =
        std::ranges::find_if(snapshot.actors, [&](const PresentationActor& candidate) {
            return candidate.key == actor;
        });
    if (actor_state == snapshot.actors.end() || !actor_state->enabled || !actor_state->visible)
        return Result<CharacterGestureOperation, Diagnostics>::failure(
            {diagnostic("presentation.character_gesture_actor_unavailable",
                        "Character Gesture requires a visible Actor occurrence")});
    const auto* character = project.find_character(actor_state->character);
    if (character == nullptr)
        return Result<CharacterGestureOperation, Diagnostics>::failure(
            {diagnostic("presentation.character_gesture_character_missing",
                        "Character Gesture Actor references a missing Character")});
    const auto gesture_definition = std::ranges::find_if(
        character->gestures, [&](const auto& candidate) { return candidate.id == gesture; });
    if (gesture_definition == character->gestures.end())
        return Result<CharacterGestureOperation, Diagnostics>::failure(
            {diagnostic("presentation.character_gesture_missing", "Character Gesture is missing")});
    const auto gesture_profile =
        std::ranges::find_if(gesture_definition->profiles, [&](const auto& candidate) {
            return candidate.profile_id == actor_state->profile;
        });
    if (gesture_profile == gesture_definition->profiles.end())
        return Result<CharacterGestureOperation, Diagnostics>::failure(
            {diagnostic("presentation.character_gesture_profile_missing",
                        "Character Gesture has no mapping for the Actor presentation Profile")});
    const auto profile = std::ranges::find_if(character->profiles, [&](const auto& candidate) {
        return candidate.id == actor_state->profile;
    });
    if (profile == character->profiles.end())
        return Result<CharacterGestureOperation, Diagnostics>::failure(
            {diagnostic("presentation.character_gesture_profile_missing",
                        "Character Gesture Actor presentation Profile is missing")});
    const auto clip = std::ranges::find_if(profile->animation_clips, [&](const auto& candidate) {
        return candidate.id == gesture_profile->clip_id;
    });
    if (clip == profile->animation_clips.end() || clip->frames.empty())
        return Result<CharacterGestureOperation, Diagnostics>::failure(
            {diagnostic("presentation.character_gesture_clip_missing",
                        "Character Gesture animation clip is missing or empty")});
    std::uint64_t duration_ms = 0;
    for (const auto& frame : clip->frames) {
        if (frame.duration_ms >
            static_cast<std::uint64_t>(std::numeric_limits<std::int64_t>::max()) - duration_ms)
            return Result<CharacterGestureOperation, Diagnostics>::failure(
                {diagnostic("presentation.character_gesture_duration_overflow",
                            "Character Gesture animation duration is too large")});
        duration_ms += frame.duration_ms;
    }
    return Result<CharacterGestureOperation, Diagnostics>::success(CharacterGestureOperation{
        {.id = operation,
         .duration = std::chrono::milliseconds{static_cast<std::int64_t>(duration_ms)},
         .skippable = skippable,
         .clock = clip->clock,
         .revisions = {snapshot.revision, snapshot.revision},
         .easing = PresentationEasing::Linear},
        {actor},
        actor_state->character,
        gesture,
        gesture_profile->clip_id,
        gesture_profile->cues,
        std::move(completion)});
}

} // namespace noveltea::core
