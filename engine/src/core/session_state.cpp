#include "noveltea/core/session_state.hpp"

#include <algorithm>
#include <atomic>
#include <bit>
#include <cmath>
#include <limits>
#include <type_traits>
#include <utility>

namespace noveltea::core {
namespace {

std::atomic<std::uint64_t> g_next_presentation_session_id{1};
std::atomic<std::uint64_t> g_next_shell_presentation_scope_id{1};
std::atomic<std::uint64_t> g_next_room_visit_instance_id{1};

template<class Id>
std::optional<Id> allocate_process_identity(std::atomic<std::uint64_t>& next) noexcept
{
    std::uint64_t current = next.load(std::memory_order_relaxed);
    while (current != std::numeric_limits<std::uint64_t>::max()) {
        if (next.compare_exchange_weak(current, current + 1, std::memory_order_relaxed,
                                       std::memory_order_relaxed))
            return Id::from_number(current);
    }
    return std::nullopt;
}

Diagnostics variable_error(std::string code, const VariableId& id, std::string message)
{
    return Diagnostics{Diagnostic{.code = std::move(code),
                                  .message = "Variable '" + id.text() + "' " + std::move(message)}};
}

Diagnostics feature_error(std::string code, std::string message)
{
    return Diagnostics{Diagnostic{.code = std::move(code), .message = std::move(message)}};
}

template<class Variant, class Id>
bool variant_has_id(const std::vector<Variant>& values, const Id& id) noexcept
{
    return std::any_of(values.begin(), values.end(), [&id](const Variant& value) {
        return std::visit([&id](const auto& item) { return item.id == id; }, value);
    });
}

const compiled::ActorCueInstruction* find_actor_cue(const compiled::SceneDefinition& scene,
                                                    const SceneActorKey& key,
                                                    const CharacterId& character) noexcept
{
    for (const auto& instruction : scene.program.instructions) {
        const auto* cue = std::get_if<compiled::ActorCueInstruction>(&instruction);
        if (cue != nullptr && cue->slot_id == key.slot && cue->character == character)
            return cue;
    }
    return nullptr;
}

bool valid_character_state(const compiled::CharacterDefinition& character,
                           const DesiredActorPresentation& actor) noexcept
{
    const auto pose = std::find_if(
        character.poses.begin(), character.poses.end(),
        [&actor](const compiled::CharacterPose& item) { return item.id == actor.pose; });
    const auto expression = std::find_if(character.expressions.begin(), character.expressions.end(),
                                         [&actor](const compiled::CharacterExpression& item) {
                                             return item.id == actor.expression;
                                         });
    const bool idle_valid =
        !actor.idle || std::any_of(character.idles.begin(), character.idles.end(),
                                   [&actor](const compiled::CharacterIdle& item) {
                                       return item.id == *actor.idle;
                                   });
    return pose != character.poses.end() && expression != character.expressions.end() &&
           idle_valid && (!expression->pose_id || *expression->pose_id == actor.pose) &&
           actor.placement.position <= compiled::ActorPosition::Custom &&
           std::isfinite(actor.placement.offset.x) && std::isfinite(actor.placement.offset.y) &&
           std::isfinite(actor.placement.scale) && actor.placement.scale > 0.0;
}

bool valid_interactable_location(const CompiledProject& project,
                                 const compiled::InteractableLocation& location) noexcept
{
    const auto* placement = std::get_if<compiled::RoomPlacementRef>(&location);
    if (placement == nullptr)
        return true;
    const auto* room = project.find_room(placement->room);
    return room != nullptr && std::any_of(room->placements.begin(), room->placements.end(),
                                          [placement](const compiled::RoomPlacement& item) {
                                              return item.id == placement->placement_id;
                                          });
}

const compiled::DialogueLineSegment*
find_dialogue_line(const compiled::DialogueDefinition& dialogue,
                   const DialogueSegmentId& segment) noexcept
{
    for (const auto& block : dialogue.program.blocks) {
        const auto* sequence = std::get_if<compiled::DialogueSequenceBlock>(&block);
        if (sequence == nullptr)
            continue;
        for (const auto& item : sequence->segments) {
            const auto* line = std::get_if<compiled::DialogueLineSegment>(&item);
            if (line != nullptr && line->id == segment)
                return line;
        }
    }
    return nullptr;
}

bool has_dialogue_choice_edge(const compiled::DialogueDefinition& dialogue,
                              const DialogueEdgeId& edge) noexcept
{
    return std::any_of(dialogue.program.edges.begin(), dialogue.program.edges.end(),
                       [&edge](const compiled::DialogueEdge& item) {
                           const auto* choice = std::get_if<compiled::DialogueChoiceEdge>(&item);
                           return choice != nullptr && choice->id == edge;
                       });
}

template<class Key>
std::uint64_t history_count(const std::vector<std::pair<Key, std::uint64_t>>& values,
                            const Key& key) noexcept
{
    const auto found = std::find_if(values.begin(), values.end(),
                                    [&key](const auto& item) { return item.first == key; });
    return found == values.end() ? 0 : found->second;
}

template<class Key>
Result<void, Diagnostics> increment_history(std::vector<std::pair<Key, std::uint64_t>>& values,
                                            const Key& key)
{
    const auto found = std::find_if(values.begin(), values.end(),
                                    [&key](const auto& item) { return item.first == key; });
    if (found == values.end()) {
        values.emplace_back(key, 1);
        return Result<void, Diagnostics>::success();
    }
    if (found->second == std::numeric_limits<std::uint64_t>::max())
        return Result<void, Diagnostics>::failure(feature_error(
            "runtime.history_overflow", "Feature history counter cannot be incremented"));
    ++found->second;
    return Result<void, Diagnostics>::success();
}

bool valid_scene_log_origin(const CompiledProject& project,
                            const SceneTextLogOrigin& origin) noexcept
{
    const auto* scene = project.find_scene(origin.scene);
    if (scene == nullptr)
        return false;
    return std::any_of(scene->program.instructions.begin(), scene->program.instructions.end(),
                       [&origin](const compiled::SceneInstruction& instruction) {
                           const auto* text =
                               std::get_if<compiled::ShowTextInstruction>(&instruction);
                           return text != nullptr && text->id == origin.step;
                       });
}

bool valid_dialogue_line_origin(const CompiledProject& project,
                                const DialogueLineTextLogOrigin& origin) noexcept
{
    const auto* dialogue = project.find_dialogue(origin.dialogue);
    return dialogue != nullptr && find_dialogue_line(*dialogue, origin.segment) != nullptr;
}

bool valid_dialogue_choice_origin(const CompiledProject& project,
                                  const DialogueChoiceTextLogOrigin& origin) noexcept
{
    const auto* dialogue = project.find_dialogue(origin.dialogue);
    return dialogue != nullptr && has_dialogue_choice_edge(*dialogue, origin.edge);
}

bool valid_interaction_log_origin(const CompiledProject& project,
                                  const InteractionTextLogOrigin& origin) noexcept
{
    const auto* interaction = project.find_interaction(origin.interaction);
    if (interaction == nullptr)
        return false;
    return std::any_of(interaction->rules.begin(), interaction->rules.end(),
                       [&origin](const compiled::InteractionRule& rule) {
                           return std::any_of(
                               rule.program.instructions.begin(), rule.program.instructions.end(),
                               [&origin](const compiled::InteractionInstruction& instruction) {
                                   const auto* notification =
                                       std::get_if<compiled::NotifyInstruction>(&instruction);
                                   return notification != nullptr &&
                                          notification->id == origin.instruction;
                               });
                       });
}

bool text_log_kind_matches_origin(TextLogEntryKind kind, const TextLogOrigin& origin) noexcept
{
    switch (kind) {
    case TextLogEntryKind::Line:
        return std::holds_alternative<SceneTextLogOrigin>(origin) ||
               std::holds_alternative<DialogueLineTextLogOrigin>(origin);
    case TextLogEntryKind::Choice:
        return std::holds_alternative<DialogueChoiceTextLogOrigin>(origin);
    case TextLogEntryKind::Notification:
        return std::holds_alternative<InteractionTextLogOrigin>(origin) ||
               std::holds_alternative<SystemTextLogOrigin>(origin);
    }
    return false;
}

bool valid_text_log_origin(const CompiledProject& project, const TextLogOrigin& origin) noexcept
{
    return std::visit(
        [&project](const auto& value) {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, SceneTextLogOrigin>)
                return valid_scene_log_origin(project, value);
            else if constexpr (std::is_same_v<T, DialogueLineTextLogOrigin>)
                return valid_dialogue_line_origin(project, value);
            else if constexpr (std::is_same_v<T, DialogueChoiceTextLogOrigin>)
                return valid_dialogue_choice_origin(project, value);
            else if constexpr (std::is_same_v<T, InteractionTextLogOrigin>)
                return valid_interaction_log_origin(project, value);
            else
                return true;
        },
        origin);
}

bool valid_background(const CompiledProject& project,
                      const compiled::BackgroundPresentation& background) noexcept
{
    return background.fit <= compiled::BackgroundFit::Center &&
           (!background.asset || project.find_asset(*background.asset) != nullptr);
}

bool valid_plane(PresentationPlane plane) noexcept { return plane <= PresentationPlane::Debug; }

bool valid_layout_policy(const MountedLayoutPolicy& policy) noexcept
{
    return valid_plane(policy.plane) && policy.clock <= LayoutClockDomain::UnscaledPresentation &&
           (!policy.scale_overrides.ui ||
            *policy.scale_overrides.ui <= LayoutScaleInheritance::Ignore) &&
           (!policy.scale_overrides.text ||
            *policy.scale_overrides.text <= LayoutScaleInheritance::Ignore) &&
           policy.input <= LayoutInputMode::Modal &&
           policy.gameplay_pause <= GameplayPausePolicy::PauseWhileVisible &&
           policy.visibility <= LayoutVisibility::Visible &&
           policy.escape_dismissal <= EscapeDismissalPolicy::Dismiss &&
           !policy.entrance_operation && !policy.exit_operation;
}

MountedLayoutPolicy reserved_layout_policy(compiled::LayoutSlot slot, bool visible = true) noexcept
{
    const PresentationPlane plane = slot == compiled::LayoutSlot::Overlay
                                        ? PresentationPlane::WorldOverlay
                                        : PresentationPlane::GameUi;
    return MountedLayoutPolicy{.plane = plane,
                               .scale_overrides = {},
                               .local_order = 0,
                               .clock = LayoutClockDomain::Gameplay,
                               .input = LayoutInputMode::Normal,
                               .gameplay_pause = GameplayPausePolicy::Continue,
                               .visibility =
                                   visible ? LayoutVisibility::Visible : LayoutVisibility::Hidden,
                               .escape_dismissal = EscapeDismissalPolicy::Ignore,
                               .entrance_operation = std::nullopt,
                               .exit_operation = std::nullopt};
}

MountedLayoutPolicy room_overlay_policy(std::int32_t order, bool visible) noexcept
{
    return MountedLayoutPolicy{.plane = PresentationPlane::WorldOverlay,
                               .scale_overrides = {},
                               .local_order = order,
                               .clock = LayoutClockDomain::Gameplay,
                               .input = LayoutInputMode::None,
                               .gameplay_pause = GameplayPausePolicy::Continue,
                               .visibility =
                                   visible ? LayoutVisibility::Visible : LayoutVisibility::Hidden,
                               .escape_dismissal = EscapeDismissalPolicy::Ignore,
                               .entrance_operation = std::nullopt,
                               .exit_operation = std::nullopt};
}

bool owner_matches_scene_key(const PresentationOwner& owner, const SceneActorKey& key) noexcept
{
    const auto* scene_owner = std::get_if<ScenePresentationOwner>(&owner);
    return scene_owner != nullptr && *scene_owner == key.owner;
}

bool valid_prop_bounds(const compiled::NormalizedRect& bounds) noexcept
{
    return std::isfinite(bounds.x) && std::isfinite(bounds.y) && std::isfinite(bounds.width) &&
           std::isfinite(bounds.height) && bounds.width >= 0.0 && bounds.height >= 0.0;
}

bool valid_scene_choice(const CompiledProject& project, const SceneChoiceState& state) noexcept
{
    const auto* scene = project.find_scene(state.scene);
    if (scene == nullptr || state.options.empty())
        return false;
    const compiled::ChoiceSceneInstruction* choice = nullptr;
    for (const auto& instruction : scene->program.instructions) {
        const auto* candidate = std::get_if<compiled::ChoiceSceneInstruction>(&instruction);
        if (candidate != nullptr && candidate->id == state.step) {
            choice = candidate;
            break;
        }
    }
    if (choice == nullptr)
        return false;
    std::vector<SceneChoiceOptionId> seen;
    for (const auto& option : state.options) {
        if (std::find(seen.begin(), seen.end(), option.option) != seen.end() ||
            std::none_of(choice->options.begin(), choice->options.end(),
                         [&option](const compiled::SceneChoiceOption& item) {
                             return item.id == option.option;
                         }))
            return false;
        seen.push_back(option.option);
    }
    return true;
}

bool valid_dialogue_choice(const CompiledProject& project,
                           const DialogueChoiceState& state) noexcept
{
    const auto* dialogue = project.find_dialogue(state.dialogue);
    if (dialogue == nullptr || state.options.empty())
        return false;
    const bool choice_block =
        std::any_of(dialogue->program.blocks.begin(), dialogue->program.blocks.end(),
                    [&state](const compiled::DialogueBlock& block) {
                        const auto* choice = std::get_if<compiled::DialogueChoiceBlock>(&block);
                        return choice != nullptr && choice->id == state.block;
                    });
    if (!choice_block)
        return false;
    std::vector<DialogueEdgeId> seen;
    for (const auto& option : state.options) {
        const bool exists =
            std::any_of(dialogue->program.edges.begin(), dialogue->program.edges.end(),
                        [&state, &option](const compiled::DialogueEdge& edge) {
                            const auto* choice = std::get_if<compiled::DialogueChoiceEdge>(&edge);
                            return choice != nullptr && choice->id == option.edge &&
                                   choice->from_block_id == state.block;
                        });
        if (!exists || option.markup > TextMarkup::ActiveText ||
            std::find(seen.begin(), seen.end(), option.edge) != seen.end())
            return false;
        seen.push_back(option.edge);
    }
    return true;
}

bool variable_value_matches(const compiled::VariableDefinition& definition,
                            const RuntimeValue& value) noexcept
{
    if (!runtime_value_is_finite(value) || std::holds_alternative<std::monostate>(value))
        return false;
    return std::visit(
        [&value](const auto& type) {
            using T = std::decay_t<decltype(type)>;
            if constexpr (std::is_same_v<T, BooleanPropertyType>)
                return std::holds_alternative<bool>(value);
            else if constexpr (std::is_same_v<T, IntegerPropertyType>)
                return std::holds_alternative<std::int64_t>(value);
            else if constexpr (std::is_same_v<T, NumberPropertyType>)
                return std::holds_alternative<std::int64_t>(value) ||
                       std::holds_alternative<double>(value);
            else if constexpr (std::is_same_v<T, StringPropertyType>)
                return std::holds_alternative<std::string>(value);
            else {
                const auto* text = std::get_if<std::string>(&value);
                return text != nullptr && std::find(type.values.begin(), type.values.end(),
                                                    *text) != type.values.end();
            }
        },
        definition.value_type);
}

std::optional<SceneStepId> first_scene_step(const compiled::SceneDefinition& scene)
{
    if (scene.program.instructions.empty())
        return std::nullopt;
    return std::visit([](const auto& instruction) { return instruction.id; },
                      scene.program.instructions.front());
}

Result<FlowStack, Diagnostics> initial_flow_stack(const CompiledProject& project,
                                                  const FlowFrameId& frame_id)
{
    FlowStack stack;
    const bool valid = std::visit(
        [&project, &stack, &frame_id](const auto& id) {
            using T = std::decay_t<decltype(id)>;
            if constexpr (std::is_same_v<T, RoomId>) {
                if (project.find_room(id) == nullptr)
                    return false;
                stack.emplace_back(RoomTransitionFrame{
                    .frame_id = frame_id,
                    .source_room = std::nullopt,
                    .target_room = id,
                    .selected_exit = std::nullopt,
                    .position = {RoomTransitionStage::TargetCanEnter, 0},
                });
                return true;
            } else if constexpr (std::is_same_v<T, SceneId>) {
                const auto* scene = project.find_scene(id);
                if (scene == nullptr)
                    return false;
                stack.emplace_back(SceneFrame{
                    frame_id, id, {first_scene_step(*scene), {}}, NoReturnDestination{}});
                return true;
            } else {
                const auto* dialogue = project.find_dialogue(id);
                if (dialogue == nullptr)
                    return false;
                stack.emplace_back(
                    DialogueFrame{frame_id,
                                  id,
                                  {dialogue->program.entry_block_id, std::nullopt, std::nullopt,
                                   DialogueFramePosition::Stage::EnterBlock, 0},
                                  NoReturnDestination{}});
                return true;
            }
        },
        project.entrypoint());
    if (!valid)
        return Result<FlowStack, Diagnostics>::failure(Diagnostics{
            Diagnostic{.code = "execution.invalid_entrypoint",
                       .message = "Compiled project entrypoint cannot initialize a flow frame"}});
    return Result<FlowStack, Diagnostics>::success(std::move(stack));
}

} // namespace

Result<SessionState, Diagnostics> SessionState::create(const CompiledProject& project)
{
    const auto presentation_session =
        allocate_process_identity<PresentationSessionId>(g_next_presentation_session_id);
    const auto shell_presentation_scope =
        allocate_process_identity<ShellPresentationScopeId>(g_next_shell_presentation_scope_id);
    if (!presentation_session || !shell_presentation_scope)
        return Result<SessionState, Diagnostics>::failure(
            feature_error("runtime.presentation_identity_exhausted",
                          "Presentation session or shell-scope identities are exhausted"));

    std::unordered_map<VariableId, RuntimeValue> variables;
    variables.reserve(project.variables().size());
    for (const auto& declaration : project.variables()) {
        const bool inserted = variables.emplace(declaration.id, declaration.default_value).second;
        if (!inserted)
            return Result<SessionState, Diagnostics>::failure(variable_error(
                "runtime.duplicate_variable", declaration.id, "was initialized more than once"));
    }
    auto stack = initial_flow_stack(project, FlowFrameId{1});
    auto* initial_stack = stack.value_if();
    if (initial_stack == nullptr)
        return Result<SessionState, Diagnostics>::failure(stack.error());
    std::vector<InteractableState> interactables;
    interactables.reserve(project.interactables().size());
    for (const auto& definition : project.interactables()) {
        if (!valid_interactable_location(project, definition.initial_state.location))
            return Result<SessionState, Diagnostics>::failure(
                feature_error("runtime.invalid_interactable_location",
                              "Interactable initial Room placement does not exist"));
        interactables.push_back(
            InteractableState{definition.identity.id, definition.initial_state.location,
                              definition.initial_state.enabled, definition.initial_state.visible});
    }
    std::vector<CharacterWorldState> characters;
    characters.reserve(project.characters().size());
    for (const auto& definition : project.characters()) {
        if (const auto* placed =
                std::get_if<compiled::RoomPlacementRef>(&definition.initial_world_state.location)) {
            const auto* room = project.find_room(placed->room);
            if (room == nullptr || std::none_of(room->placements.begin(), room->placements.end(),
                                                [placed](const compiled::RoomPlacement& candidate) {
                                                    return candidate.id == placed->placement_id;
                                                }))
                return Result<SessionState, Diagnostics>::failure(
                    feature_error("runtime.invalid_character_location",
                                  "Character initial Room placement does not exist"));
        }
        characters.push_back(CharacterWorldState{
            definition.identity.id, definition.initial_world_state.location,
            definition.initial_world_state.enabled, definition.initial_world_state.visible});
    }
    return Result<SessionState, Diagnostics>::success(SessionState(
        FlowMode{}, std::move(*initial_stack), std::move(variables), std::move(characters),
        std::move(interactables), 2, *presentation_session, *shell_presentation_scope));
}

Result<RoomVisitInstanceId, Diagnostics> SessionState::allocate_room_visit_instance_id()
{
    const auto id = allocate_process_identity<RoomVisitInstanceId>(g_next_room_visit_instance_id);
    return id ? Result<RoomVisitInstanceId, Diagnostics>::success(*id)
              : Result<RoomVisitInstanceId, Diagnostics>::failure(
                    feature_error("runtime.room_visit_instance_exhausted",
                                  "Room visit instance identities are exhausted"));
}

std::uint64_t SessionState::next_random_u64() noexcept
{
    // SplitMix64 is fully specified in terms of unsigned 64-bit arithmetic and therefore produces
    // the same stream on every supported target.
    m_random_state += 0x9e3779b97f4a7c15ULL;
    std::uint64_t value = m_random_state;
    value = (value ^ (value >> 30U)) * 0xbf58476d1ce4e5b9ULL;
    value = (value ^ (value >> 27U)) * 0x94d049bb133111ebULL;
    return value ^ (value >> 31U);
}

double SessionState::next_random_unit() noexcept
{
    constexpr double denominator = 9007199254740992.0; // 2^53
    return static_cast<double>(next_random_u64() >> 11U) / denominator;
}

Result<std::int64_t, Diagnostics> SessionState::next_random_integer(std::int64_t minimum,
                                                                    std::int64_t maximum)
{
    if (minimum > maximum)
        return Result<std::int64_t, Diagnostics>::failure(feature_error(
            "runtime.invalid_random_range", "Random integer minimum cannot exceed maximum"));

    constexpr std::uint64_t sign_bit = std::uint64_t{1} << 63U;
    const auto ordered = [](std::int64_t value) {
        return std::bit_cast<std::uint64_t>(value) ^ sign_bit;
    };
    const std::uint64_t lower = ordered(minimum);
    const std::uint64_t upper = ordered(maximum);
    const std::uint64_t span = upper - lower + 1U;
    if (span == 0U)
        return Result<std::int64_t, Diagnostics>::success(
            std::bit_cast<std::int64_t>(next_random_u64()));

    const std::uint64_t threshold = (std::uint64_t{0} - span) % span;
    std::uint64_t draw = 0;
    do {
        draw = next_random_u64();
    } while (draw < threshold);
    const std::uint64_t result_bits = (lower + draw % span) ^ sign_bit;
    return Result<std::int64_t, Diagnostics>::success(std::bit_cast<std::int64_t>(result_bits));
}

Result<void, Diagnostics> SessionState::advance_time(std::chrono::milliseconds elapsed)
{
    if (elapsed.count() < 0)
        return Result<void, Diagnostics>::failure(feature_error(
            "runtime.invalid_elapsed_time", "Elapsed logical time cannot be negative"));
    if (elapsed.count() > std::chrono::milliseconds::max().count() - m_play_time.count())
        return Result<void, Diagnostics>::failure(
            feature_error("runtime.elapsed_time_overflow", "Logical play time would overflow"));

    auto timers = m_logical_timers;
    auto completions = m_pending_timer_completions;
    for (auto& timer : timers) {
        if (elapsed < timer.remaining) {
            timer.remaining -= elapsed;
            continue;
        }

        if (!timer.repeat_interval) {
            completions.push_back(LogicalTimerCompletion{timer.id, 1});
            timer.remaining = std::chrono::milliseconds{-1};
            continue;
        }

        const auto beyond_first = elapsed - timer.remaining;
        const auto interval = *timer.repeat_interval;
        const auto extra = static_cast<std::uint64_t>(beyond_first.count() / interval.count());
        if (extra == std::numeric_limits<std::uint64_t>::max())
            return Result<void, Diagnostics>::failure(feature_error(
                "runtime.timer_completion_overflow", "Logical timer occurrence count overflowed"));
        const auto occurrences = extra + 1;
        const auto remainder = beyond_first.count() % interval.count();
        timer.remaining =
            remainder == 0 ? interval : std::chrono::milliseconds{interval.count() - remainder};
        const auto existing = std::find_if(
            completions.begin(), completions.end(),
            [&timer](const LogicalTimerCompletion& item) { return item.id == timer.id; });
        if (existing != completions.end()) {
            if (occurrences > std::numeric_limits<std::uint64_t>::max() - existing->occurrences)
                return Result<void, Diagnostics>::failure(
                    feature_error("runtime.timer_completion_overflow",
                                  "Logical timer occurrence count overflowed"));
            existing->occurrences += occurrences;
        } else {
            completions.push_back(LogicalTimerCompletion{timer.id, occurrences});
        }
    }
    timers.erase(
        std::remove_if(timers.begin(), timers.end(),
                       [](const LogicalTimer& timer) { return timer.remaining.count() < 0; }),
        timers.end());

    m_play_time += elapsed;
    m_logical_timers = std::move(timers);
    m_pending_timer_completions = std::move(completions);
    return Result<void, Diagnostics>::success();
}

Result<LogicalTimerId, Diagnostics>
SessionState::start_logical_timer(std::chrono::milliseconds initial_duration,
                                  std::optional<std::chrono::milliseconds> repeat_interval)
{
    if (initial_duration.count() < 0 || (repeat_interval && repeat_interval->count() <= 0))
        return Result<LogicalTimerId, Diagnostics>::failure(feature_error(
            "runtime.invalid_logical_timer",
            "Logical timers require a nonnegative duration and a positive repeat interval"));
    if (m_next_logical_timer_id == 0)
        return Result<LogicalTimerId, Diagnostics>::failure(feature_error(
            "runtime.logical_timer_id_exhausted", "Logical timer identifiers are exhausted"));
    const LogicalTimerId id{m_next_logical_timer_id++};
    m_logical_timers.push_back(LogicalTimer{id, initial_duration, repeat_interval});
    return Result<LogicalTimerId, Diagnostics>::success(id);
}

bool SessionState::cancel_logical_timer(const LogicalTimerId& id) noexcept
{
    const auto found = std::find_if(m_logical_timers.begin(), m_logical_timers.end(),
                                    [&id](const LogicalTimer& timer) { return timer.id == id; });
    if (found == m_logical_timers.end())
        return false;
    m_logical_timers.erase(found);
    return true;
}

std::vector<LogicalTimerCompletion> SessionState::take_timer_completions() noexcept
{
    auto completions = std::move(m_pending_timer_completions);
    m_pending_timer_completions.clear();
    return completions;
}

Result<RuntimeValue, Diagnostics> SessionState::variable(const CompiledProject& project,
                                                         const VariableId& id) const
{
    if (project.find_variable(id) == nullptr)
        return Result<RuntimeValue, Diagnostics>::failure(
            variable_error("runtime.unknown_variable", id, "is not declared"));
    const auto found = m_variables.find(id);
    if (found == m_variables.end())
        return Result<RuntimeValue, Diagnostics>::failure(
            variable_error("runtime.missing_variable", id, "has no session value"));
    return Result<RuntimeValue, Diagnostics>::success(found->second);
}

Result<void, Diagnostics> SessionState::set_variable(const CompiledProject& project,
                                                     const VariableId& id, RuntimeValue value)
{
    const auto* declaration = project.find_variable(id);
    if (declaration == nullptr)
        return Result<void, Diagnostics>::failure(
            variable_error("runtime.unknown_variable", id, "is not declared"));
    if (!variable_value_matches(*declaration, value))
        return Result<void, Diagnostics>::failure(variable_error(
            "runtime.invalid_variable_value", id, "cannot be assigned that runtime value"));

    const auto found = m_variables.find(id);
    if (found == m_variables.end())
        return Result<void, Diagnostics>::failure(
            variable_error("runtime.missing_variable", id, "has no session value"));
    found->second = std::move(value);
    return Result<void, Diagnostics>::success();
}

const RuntimeValue* SessionState::property_override(const PropertyOwnerRef& owner,
                                                    const PropertyId& property) const noexcept
{
    const auto found =
        std::find_if(m_property_overrides.begin(), m_property_overrides.end(),
                     [&owner, &property](const PropertyOverride& value) {
                         return value.owner() == owner && value.property_id() == property;
                     });
    return found == m_property_overrides.end() ? nullptr : &found->value();
}

void SessionState::store_property_override(PropertyOverride value)
{
    const auto found = std::find_if(m_property_overrides.begin(), m_property_overrides.end(),
                                    [&value](const PropertyOverride& current) {
                                        return current.owner() == value.owner() &&
                                               current.property_id() == value.property_id();
                                    });
    if (found == m_property_overrides.end())
        m_property_overrides.push_back(std::move(value));
    else
        *found = std::move(value);
}

void SessionState::erase_property_override(const PropertyOwnerRef& owner,
                                           const PropertyId& property) noexcept
{
    const auto found =
        std::find_if(m_property_overrides.begin(), m_property_overrides.end(),
                     [&owner, &property](const PropertyOverride& value) {
                         return value.owner() == owner && value.property_id() == property;
                     });
    if (found != m_property_overrides.end())
        m_property_overrides.erase(found);
}

std::optional<CurrentRoomPresentationOwner>
SessionState::current_room_presentation_owner() const noexcept
{
    if (!m_room_visit || !m_room_visit_instance)
        return std::nullopt;
    return CurrentRoomPresentationOwner{*m_room_visit_instance, m_room_visit->room};
}

bool SessionState::presentation_owner_is_active(const PresentationOwner& owner) const noexcept
{
    return std::visit(
        [this](const auto& value) {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, ScenePresentationOwner>) {
                return std::any_of(
                    m_flow_stack.begin(), m_flow_stack.end(), [&value](const auto& f) {
                        const auto* scene = std::get_if<SceneFrame>(&f);
                        return scene != nullptr && scene->frame_id == value.invocation &&
                               scene->scene == value.scene;
                    });
            } else if constexpr (std::is_same_v<T, CurrentRoomPresentationOwner>) {
                const auto current = current_room_presentation_owner();
                return current && *current == value;
            } else if constexpr (std::is_same_v<T, RoomPresentationOwner>) {
                return m_room_visit && m_room_visit->room == value.room;
            } else if constexpr (std::is_same_v<T, SessionPresentationOwner>) {
                return value.session == m_presentation_session;
            } else {
                return value.scope == m_shell_presentation_scope;
            }
        },
        owner);
}

Result<void, Diagnostics>
SessionState::validate_presentation_owner(const PresentationOwner& owner) const
{
    const bool valid = std::visit(
        [this](const auto& value) {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, RoomPresentationOwner>)
                return true;
            else if constexpr (std::is_same_v<T, SessionPresentationOwner>)
                return value.session == m_presentation_session;
            else if constexpr (std::is_same_v<T, ShellPresentationOwner>)
                return value.scope == m_shell_presentation_scope;
            else
                return presentation_owner_is_active(PresentationOwner{value});
        },
        owner);
    return valid ? Result<void, Diagnostics>::success()
                 : Result<void, Diagnostics>::failure(feature_error(
                       "runtime.invalid_presentation_owner",
                       "Presentation owner is stale, inactive, or belongs to another session"));
}

Result<void, Diagnostics>
SessionState::validate_presentation_owner(const CompiledProject& project,
                                          const PresentationOwner& owner) const
{
    auto valid = validate_presentation_owner(owner);
    if (!valid)
        return valid;
    const auto* room_owner = std::get_if<RoomPresentationOwner>(&owner);
    if (room_owner != nullptr && project.find_room(room_owner->room) == nullptr)
        return Result<void, Diagnostics>::failure(feature_error(
            "runtime.invalid_presentation_owner", "Presentation owner references a missing Room"));
    return Result<void, Diagnostics>::success();
}

void SessionState::remove_presentation_owned_by(const PresentationOwner& owner) noexcept
{
    std::erase_if(m_background_overrides,
                  [&owner](const auto& value) { return value.owner == owner; });
    std::erase_if(m_actors, [&owner](const auto& value) { return value.owner == owner; });
    std::erase_if(m_presentation_props,
                  [&owner](const auto& value) { return value.owner == owner; });
    std::erase_if(m_presentation_environments,
                  [&owner](const auto& value) { return value.owner == owner; });
    std::erase_if(m_mounted_layouts, [&owner](const auto& value) { return value.owner == owner; });
    std::erase_if(m_desired_audio, [&owner](const auto& value) { return value.owner == owner; });
}

void SessionState::remove_scene_presentation(const FlowFrame& frame) noexcept
{
    const auto* scene = std::get_if<SceneFrame>(&frame);
    if (scene != nullptr)
        remove_presentation_owned_by(ScenePresentationOwner{scene->frame_id, scene->scene});
}

Result<void, Diagnostics> SessionState::upsert_background_override(const CompiledProject& project,
                                                                   DesiredBackgroundOverride value)
{
    auto owner = validate_presentation_owner(project, value.owner);
    if (!owner || !valid_background(project, value.background))
        return Result<void, Diagnostics>::failure(
            !owner ? owner.error()
                   : feature_error("runtime.invalid_background_override",
                                   "Background override contains an invalid owner or resource"));
    const auto found = std::find_if(m_background_overrides.begin(), m_background_overrides.end(),
                                    [&value](const DesiredBackgroundOverride& current) {
                                        return current.owner == value.owner;
                                    });
    if (found == m_background_overrides.end())
        m_background_overrides.push_back(std::move(value));
    else
        *found = std::move(value);
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics> SessionState::remove_background_override(const PresentationOwner& owner)
{
    const auto found = std::find_if(
        m_background_overrides.begin(), m_background_overrides.end(),
        [&owner](const DesiredBackgroundOverride& value) { return value.owner == owner; });
    if (found != m_background_overrides.end())
        m_background_overrides.erase(found);
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics> SessionState::set_background(const CompiledProject& project,
                                                       PresentationOwner owner,
                                                       compiled::BackgroundPresentation background)
{
    return upsert_background_override(
        project, DesiredBackgroundOverride{std::move(owner), std::move(background)});
}

const DesiredActorPresentation* SessionState::actor(const ActorPresentationKey& key,
                                                    const PresentationOwner& owner) const noexcept
{
    const auto found = std::find_if(m_actors.begin(), m_actors.end(),
                                    [&key, &owner](const DesiredActorPresentation& value) {
                                        return value.key == key && value.owner == owner;
                                    });
    return found == m_actors.end() ? nullptr : &*found;
}

Result<void, Diagnostics> SessionState::set_actor(const CompiledProject& project,
                                                  DesiredActorPresentation value)
{
    const auto* character = project.find_character(value.character);
    auto owner = validate_presentation_owner(project, value.owner);
    bool key_valid = false;
    std::visit(
        [&](const auto& key) {
            using T = std::decay_t<decltype(key)>;
            if constexpr (std::is_same_v<T, CharacterActorKey>) {
                key_valid = key.character == value.character;
            } else if constexpr (std::is_same_v<T, RoomCastActorKey>) {
                const auto* room = project.find_room(key.room);
                const auto* found =
                    room == nullptr ? nullptr : [&]() -> const compiled::RoomCastEntry* {
                    const auto item = std::find_if(room->cast.begin(), room->cast.end(),
                                                   [&key](const compiled::RoomCastEntry& entry) {
                                                       return entry.id == key.entry;
                                                   });
                    return item == room->cast.end() ? nullptr : &*item;
                }();
                const auto* room_owner = std::get_if<RoomPresentationOwner>(&value.owner);
                key_valid = found != nullptr && found->character == value.character &&
                            room_owner != nullptr && room_owner->room == key.room;
            } else if constexpr (std::is_same_v<T, SceneActorKey>) {
                const auto* scene = project.find_scene(key.owner.scene);
                key_valid = scene != nullptr && owner_matches_scene_key(value.owner, key) &&
                            find_actor_cue(*scene, key, value.character) != nullptr;
            } else {
                key_valid = true;
            }
        },
        value.key);
    if (!owner || character == nullptr || !key_valid || !valid_character_state(*character, value))
        return Result<void, Diagnostics>::failure(feature_error(
            "runtime.invalid_actor_state", "Actor desired state must reference a valid owner, "
                                           "identity, Character, pose, expression, and idle"));
    const auto found = std::find_if(
        m_actors.begin(), m_actors.end(), [&value](const DesiredActorPresentation& current) {
            return current.key == value.key && current.owner == value.owner;
        });
    if (found == m_actors.end())
        m_actors.push_back(std::move(value));
    else
        *found = std::move(value);
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics> SessionState::remove_actor(const CompiledProject& project,
                                                     const ActorPresentationKey& key,
                                                     const PresentationOwner& owner)
{
    (void)project;
    const auto found = std::find_if(m_actors.begin(), m_actors.end(),
                                    [&key, &owner](const DesiredActorPresentation& value) {
                                        return value.key == key && value.owner == owner;
                                    });
    if (found == m_actors.end())
        return Result<void, Diagnostics>::failure(
            feature_error("runtime.unknown_actor", "Actor slot has no live state"));
    m_actors.erase(found);
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics>
SessionState::set_actor_presentation_complete(const CompiledProject& project,
                                              const ActorPresentationKey& key,
                                              const PresentationOwner& owner, bool complete)
{
    (void)project;
    const auto found = std::find_if(m_actors.begin(), m_actors.end(),
                                    [&key, &owner](const DesiredActorPresentation& value) {
                                        return value.key == key && value.owner == owner;
                                    });
    if (found == m_actors.end())
        return Result<void, Diagnostics>::failure(
            feature_error("runtime.unknown_actor", "Actor slot has no live state"));
    found->presentation_complete = complete;
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics> SessionState::upsert_presentation_prop(const CompiledProject& project,
                                                                 DesiredPresentationProp value)
{
    auto owner = validate_presentation_owner(project, value.owner);
    const bool resources_valid = !value.asset || project.find_asset(*value.asset) != nullptr;
    const bool placement_valid =
        !value.placement || valid_interactable_location(project, *value.placement);
    if (!owner || !resources_valid || !placement_valid || !valid_prop_bounds(value.bounds) ||
        !valid_plane(value.plane))
        return Result<void, Diagnostics>::failure(feature_error(
            "runtime.invalid_presentation_prop",
            "Presentation prop contains an invalid owner, resource, placement, bounds, or plane"));
    const auto found =
        std::find_if(m_presentation_props.begin(), m_presentation_props.end(),
                     [&value](const DesiredPresentationProp& current) {
                         return current.instance == value.instance && current.owner == value.owner;
                     });
    if (found == m_presentation_props.end())
        m_presentation_props.push_back(std::move(value));
    else
        *found = std::move(value);
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics>
SessionState::remove_presentation_prop(const PresentationPropInstanceId& instance,
                                       const PresentationOwner& owner)
{
    std::erase_if(m_presentation_props, [&instance, &owner](const DesiredPresentationProp& value) {
        return value.instance == instance && value.owner == owner;
    });
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics>
SessionState::upsert_presentation_environment(const CompiledProject& project,
                                              DesiredPresentationEnvironment value)
{
    auto owner = validate_presentation_owner(project, value.owner);
    const auto* asset = value.asset ? project.find_asset(*value.asset) : nullptr;
    const bool asset_valid =
        !value.asset || (asset != nullptr && asset->kind == compiled::AssetKind::Image);
    const bool environment_plane = value.plane >= PresentationPlane::WorldBackground &&
                                   value.plane <= PresentationPlane::WorldOverlay;
    if (!owner || !asset_valid || !valid_prop_bounds(value.bounds) || !environment_plane ||
        value.clock > LayoutClockDomain::UnscaledPresentation ||
        !std::isfinite(value.scroll_per_second.x) || !std::isfinite(value.scroll_per_second.y) ||
        !std::isfinite(value.opacity) || value.opacity < 0.0 || value.opacity > 1.0)
        return Result<void, Diagnostics>::failure(feature_error(
            "runtime.invalid_presentation_environment",
            "Presentation environment contains an invalid owner, resource, bounds, plane, clock, "
            "scroll rate, or opacity"));
    const auto found =
        std::find_if(m_presentation_environments.begin(), m_presentation_environments.end(),
                     [&value](const DesiredPresentationEnvironment& current) {
                         return current.instance == value.instance && current.owner == value.owner;
                     });
    if (found == m_presentation_environments.end())
        m_presentation_environments.push_back(std::move(value));
    else
        *found = std::move(value);
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics>
SessionState::remove_presentation_environment(const PresentationEnvironmentInstanceId& instance,
                                              const PresentationOwner& owner)
{
    std::erase_if(m_presentation_environments,
                  [&instance, &owner](const DesiredPresentationEnvironment& value) {
                      return value.instance == instance && value.owner == owner;
                  });
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics>
SessionState::remove_presentation_environments(const PresentationEnvironmentStopKey& stop_key,
                                               const PresentationOwner& owner)
{
    std::erase_if(m_presentation_environments,
                  [&stop_key, &owner](const DesiredPresentationEnvironment& value) {
                      return value.stop_key == stop_key && value.owner == owner;
                  });
    return Result<void, Diagnostics>::success();
}

const DesiredAudioInstance*
SessionState::desired_audio(const DesiredAudioInstanceId& instance,
                            const PresentationOwner& owner) const noexcept
{
    const auto found = std::find_if(m_desired_audio.begin(), m_desired_audio.end(),
                                    [&instance, &owner](const DesiredAudioInstance& value) {
                                        return value.instance == instance && value.owner == owner;
                                    });
    return found == m_desired_audio.end() ? nullptr : &*found;
}

Result<void, Diagnostics> SessionState::upsert_desired_audio(const CompiledProject& project,
                                                             DesiredAudioInstance value)
{
    auto owner = validate_presentation_owner(project, value.owner);
    const auto* asset = project.find_asset(value.asset);
    const bool bus_valid =
        value.bus == compiled::AudioChannel::Music || value.bus == compiled::AudioChannel::Ambient;
    if (!owner || !bus_valid || asset == nullptr || asset->kind != compiled::AssetKind::Audio ||
        !std::isfinite(value.volume) || value.volume < 0.0 || value.volume > 1.0 ||
        value.fade_in.count() < 0 || value.fade_out.count() < 0)
        return Result<void, Diagnostics>::failure(feature_error(
            "runtime.invalid_desired_audio",
            "Desired audio requires an active owner, Music or Ambient bus, audio Asset, valid "
            "volume, and nonnegative fade policy"));

    if (value.replacement_key) {
        std::erase_if(m_desired_audio, [&value](const DesiredAudioInstance& current) {
            return current.owner == value.owner &&
                   current.replacement_key == value.replacement_key &&
                   current.instance != value.instance;
        });
    }
    const auto found =
        std::find_if(m_desired_audio.begin(), m_desired_audio.end(),
                     [&value](const DesiredAudioInstance& current) {
                         return current.instance == value.instance && current.owner == value.owner;
                     });
    if (found == m_desired_audio.end())
        m_desired_audio.push_back(std::move(value));
    else
        *found = std::move(value);
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics> SessionState::remove_desired_audio(const DesiredAudioInstanceId& instance,
                                                             const PresentationOwner& owner)
{
    std::erase_if(m_desired_audio, [&instance, &owner](const DesiredAudioInstance& value) {
        return value.instance == instance && value.owner == owner;
    });
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics> SessionState::remove_desired_audio_bus(compiled::AudioChannel bus,
                                                                 const PresentationOwner& owner)
{
    if (bus != compiled::AudioChannel::Music && bus != compiled::AudioChannel::Ambient)
        return Result<void, Diagnostics>::failure(
            feature_error("runtime.invalid_desired_audio_bus",
                          "Only Music and Ambient are persistent desired-audio buses"));
    std::erase_if(m_desired_audio, [&bus, &owner](const DesiredAudioInstance& value) {
        return value.bus == bus && value.owner == owner;
    });
    return Result<void, Diagnostics>::success();
}

const InteractableState* SessionState::interactable(const InteractableId& id) const noexcept
{
    const auto found =
        std::find_if(m_interactables.begin(), m_interactables.end(),
                     [&id](const InteractableState& value) { return value.interactable == id; });
    return found == m_interactables.end() ? nullptr : &*found;
}

const CharacterWorldState* SessionState::character_world(const CharacterId& id) const noexcept
{
    const auto found =
        std::find_if(m_character_world.begin(), m_character_world.end(),
                     [&id](const CharacterWorldState& value) { return value.character == id; });
    return found == m_character_world.end() ? nullptr : &*found;
}

Result<void, Diagnostics> SessionState::move_character(const CompiledProject& project,
                                                       const CharacterId& id,
                                                       CharacterWorldLocation location)
{
    auto found =
        std::find_if(m_character_world.begin(), m_character_world.end(),
                     [&id](const CharacterWorldState& value) { return value.character == id; });
    if (project.find_character(id) == nullptr || found == m_character_world.end())
        return Result<void, Diagnostics>::failure(feature_error(
            "runtime.unknown_character", "Character has no definition or live world state"));
    if (const auto* placed = std::get_if<compiled::RoomPlacementRef>(&location)) {
        const auto* room = project.find_room(placed->room);
        if (room == nullptr || std::none_of(room->placements.begin(), room->placements.end(),
                                            [&placed](const compiled::RoomPlacement& candidate) {
                                                return candidate.id == placed->placement_id;
                                            }))
            return Result<void, Diagnostics>::failure(feature_error(
                "runtime.invalid_character_location", "Character Room placement does not exist"));
    }
    found->location = std::move(location);
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics> SessionState::set_character_enabled(const CompiledProject& project,
                                                              const CharacterId& id, bool enabled)
{
    auto found =
        std::find_if(m_character_world.begin(), m_character_world.end(),
                     [&id](const CharacterWorldState& value) { return value.character == id; });
    if (project.find_character(id) == nullptr || found == m_character_world.end())
        return Result<void, Diagnostics>::failure(feature_error(
            "runtime.unknown_character", "Character has no definition or live world state"));
    found->enabled = enabled;
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics> SessionState::set_character_visible(const CompiledProject& project,
                                                              const CharacterId& id, bool visible)
{
    auto found =
        std::find_if(m_character_world.begin(), m_character_world.end(),
                     [&id](const CharacterWorldState& value) { return value.character == id; });
    if (project.find_character(id) == nullptr || found == m_character_world.end())
        return Result<void, Diagnostics>::failure(feature_error(
            "runtime.unknown_character", "Character has no definition or live world state"));
    found->visible = visible;
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics> SessionState::move_interactable(const CompiledProject& project,
                                                          const InteractableId& id,
                                                          compiled::InteractableLocation location)
{
    auto found =
        std::find_if(m_interactables.begin(), m_interactables.end(),
                     [&id](const InteractableState& value) { return value.interactable == id; });
    if (project.find_interactable(id) == nullptr || found == m_interactables.end())
        return Result<void, Diagnostics>::failure(feature_error(
            "runtime.unknown_interactable", "Interactable has no definition or live state"));
    if (!valid_interactable_location(project, location))
        return Result<void, Diagnostics>::failure(
            feature_error("runtime.invalid_interactable_location",
                          "Room placement does not exist or belongs to another Interactable"));
    found->location = std::move(location);
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics> SessionState::set_interactable_enabled(const CompiledProject& project,
                                                                 const InteractableId& id,
                                                                 bool enabled)
{
    auto found =
        std::find_if(m_interactables.begin(), m_interactables.end(),
                     [&id](const InteractableState& value) { return value.interactable == id; });
    if (project.find_interactable(id) == nullptr || found == m_interactables.end())
        return Result<void, Diagnostics>::failure(feature_error(
            "runtime.unknown_interactable", "Interactable has no definition or live state"));
    found->enabled = enabled;
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics> SessionState::set_interactable_visible(const CompiledProject& project,
                                                                 const InteractableId& id,
                                                                 bool visible)
{
    auto found =
        std::find_if(m_interactables.begin(), m_interactables.end(),
                     [&id](const InteractableState& value) { return value.interactable == id; });
    if (project.find_interactable(id) == nullptr || found == m_interactables.end())
        return Result<void, Diagnostics>::failure(feature_error(
            "runtime.unknown_interactable", "Interactable has no definition or live state"));
    found->visible = visible;
    return Result<void, Diagnostics>::success();
}

std::uint64_t SessionState::room_visits(const RoomId& room) const noexcept
{
    const auto found = m_room_visits.find(room);
    return found == m_room_visits.end() ? 0 : found->second;
}

Result<void, Diagnostics> SessionState::record_room_visit(const CompiledProject& project,
                                                          const RoomId& room)
{
    if (project.find_room(room) == nullptr)
        return Result<void, Diagnostics>::failure(
            feature_error("runtime.unknown_room", "Room visit target does not exist"));
    auto found = m_room_visits.find(room);
    if (found == m_room_visits.end()) {
        m_room_visits.emplace(room, 1);
        return Result<void, Diagnostics>::success();
    }
    if (found->second == std::numeric_limits<std::uint64_t>::max())
        return Result<void, Diagnostics>::failure(
            feature_error("runtime.history_overflow", "Room visit counter cannot be incremented"));
    ++found->second;
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics>
SessionState::commit_room_entry(const CompiledProject& project, const RoomId& room,
                                std::optional<compiled::RoomExitRef> entry_exit)
{
    const auto* definition = project.find_room(room);
    if (definition == nullptr)
        return Result<void, Diagnostics>::failure(
            feature_error("runtime.unknown_room", "Room entry target does not exist"));
    if (!valid_background(project, definition->background))
        return Result<void, Diagnostics>::failure(
            feature_error("runtime.invalid_background",
                          "Room entry background contains an invalid Asset reference"));

    const auto visit = m_room_visits.find(room);
    if (visit != m_room_visits.end() && visit->second == std::numeric_limits<std::uint64_t>::max())
        return Result<void, Diagnostics>::failure(
            feature_error("runtime.history_overflow", "Room visit counter cannot be incremented"));

    std::vector<DesiredMountedLayout> mounted_layouts = m_mounted_layouts;
    for (const auto& overlay : definition->overlays) {
        if (project.find_layout(overlay.layout) == nullptr)
            return Result<void, Diagnostics>::failure(feature_error(
                "runtime.invalid_room_overlay", "Room entry overlay references a missing Layout"));
        const MountedLayoutPresentationKey key = RoomOverlayLayoutMountKey{room, overlay.id};
        const auto found =
            std::find_if(mounted_layouts.begin(), mounted_layouts.end(),
                         [&key](const DesiredMountedLayout& state) {
                             return state.key == key && presentation_authority(state.owner) ==
                                                            PresentationAuthority::Gameplay;
                         });
        if (found == mounted_layouts.end()) {
            mounted_layouts.push_back(
                DesiredMountedLayout{key, RoomPresentationOwner{room}, overlay.layout,
                                     room_overlay_policy(overlay.order, overlay.visible),
                                     PresentationCompositionGroup::World});
        }
    }

    const auto* previous_mode = std::get_if<RoomMode>(&m_mode);
    const std::optional<RoomId> source_room = previous_mode ? std::optional(previous_mode->room)
                                              : entry_exit  ? std::optional(entry_exit->room)
                                                            : std::nullopt;
    if (entry_exit) {
        const auto* source = project.find_room(entry_exit->room);
        const auto* exit = source == nullptr ? nullptr : [&]() -> const compiled::RoomExit* {
            const auto found = std::find_if(source->exits.begin(), source->exits.end(),
                                            [&entry_exit](const compiled::RoomExit& candidate) {
                                                return candidate.id == entry_exit->exit_id;
                                            });
            return found == source->exits.end() ? nullptr : &*found;
        }();
        if (source == nullptr || exit == nullptr || exit->target != room || !source_room ||
            *source_room != entry_exit->room)
            return Result<void, Diagnostics>::failure(
                feature_error("runtime.invalid_room_visit_context",
                              "Room entry exit does not match the source and target Rooms"));
    }
    auto visit_instance = allocate_room_visit_instance_id();
    if (!visit_instance)
        return Result<void, Diagnostics>::failure(visit_instance.error());
    if (visit == m_room_visits.end())
        m_room_visits.emplace(room, 1);
    else
        ++visit->second;
    if (const auto current_owner = current_room_presentation_owner())
        remove_presentation_owned_by(*current_owner);
    m_room_visit = RoomVisitContext{room, source_room, std::move(entry_exit), room_visits(room)};
    m_room_visit_instance = *visit_instance.value_if();
    m_mounted_layouts = std::move(mounted_layouts);
    m_presented_text.reset();
    m_active_choice.reset();
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics>
SessionState::commit_room_navigation(const CompiledProject& project,
                                     const RoomPresentationResolution& target)
{
    const auto& target_visit = target.presentation.visit;
    const auto* definition = project.find_room(target_visit.room);
    if (definition == nullptr)
        return Result<void, Diagnostics>::failure(
            feature_error("runtime.unknown_room", "Prepared Room target does not exist"));
    if (!valid_background(project, target.presentation.background))
        return Result<void, Diagnostics>::failure(
            feature_error("runtime.invalid_background",
                          "Prepared Room background contains an invalid Asset reference"));
    const auto expected_visit = room_visits(target_visit.room);
    if (expected_visit == std::numeric_limits<std::uint64_t>::max() ||
        target_visit.visit_index != expected_visit + 1)
        return Result<void, Diagnostics>::failure(feature_error(
            "runtime.invalid_room_visit_context",
            "Prepared Room navigation visit index does not follow the committed history"));

    if (target_visit.entry_exit) {
        const auto* source = project.find_room(target_visit.entry_exit->room);
        const auto* exit = source == nullptr ? nullptr : [&]() -> const compiled::RoomExit* {
            const auto found =
                std::find_if(source->exits.begin(), source->exits.end(),
                             [&target_visit](const compiled::RoomExit& candidate) {
                                 return candidate.id == target_visit.entry_exit->exit_id;
                             });
            return found == source->exits.end() ? nullptr : &*found;
        }();
        if (!target_visit.source_room || source == nullptr || exit == nullptr ||
            *target_visit.source_room != target_visit.entry_exit->room ||
            exit->target != target_visit.room)
            return Result<void, Diagnostics>::failure(
                feature_error("runtime.invalid_room_visit_context",
                              "Prepared Room exit does not match the source and target Rooms"));
    }

    SessionState candidate = *this;
    auto visit_instance = candidate.allocate_room_visit_instance_id();
    if (!visit_instance)
        return Result<void, Diagnostics>::failure(visit_instance.error());
    auto visit = candidate.m_room_visits.find(target_visit.room);
    if (visit == candidate.m_room_visits.end())
        candidate.m_room_visits.emplace(target_visit.room, target_visit.visit_index);
    else
        visit->second = target_visit.visit_index;
    if (const auto current_owner = candidate.current_room_presentation_owner())
        candidate.remove_presentation_owned_by(*current_owner);

    for (const auto& overlay : target.presentation.overlays) {
        const auto authored = std::find_if(
            definition->overlays.begin(), definition->overlays.end(),
            [&overlay](const compiled::RoomOverlay& value) { return value.id == overlay.overlay; });
        if (authored == definition->overlays.end() || authored->layout != overlay.layout)
            return Result<void, Diagnostics>::failure(
                feature_error("runtime.invalid_room_overlay",
                              "Prepared Room overlay does not match the compiled Room definition"));
        auto mounted = candidate.upsert_mounted_layout(
            project,
            DesiredMountedLayout{RoomOverlayLayoutMountKey{target_visit.room, overlay.overlay},
                                 RoomPresentationOwner{target_visit.room}, overlay.layout,
                                 room_overlay_policy(authored->order, overlay.visible),
                                 PresentationCompositionGroup::World});
        if (!mounted)
            return mounted;
    }

    candidate.m_room_visit = target_visit;
    candidate.m_room_visit_instance = *visit_instance.value_if();
    candidate.m_presented_text.reset();
    candidate.m_active_choice.reset();
    if (!candidate.m_room_visit || *candidate.m_room_visit != target_visit)
        return Result<void, Diagnostics>::failure(feature_error(
            "runtime.invalid_room_visit_context",
            "Committed Room navigation did not reproduce the prepared visit context"));
    *this = std::move(candidate);
    return Result<void, Diagnostics>::success();
}

std::uint64_t SessionState::dialogue_line_visits(const DialogueLineHistoryKey& key) const noexcept
{
    return history_count(m_dialogue_line_history, key);
}

std::uint64_t
SessionState::dialogue_choice_visits(const DialogueChoiceHistoryKey& key) const noexcept
{
    return history_count(m_dialogue_choice_history, key);
}

Result<void, Diagnostics> SessionState::record_dialogue_line(const CompiledProject& project,
                                                             const DialogueLineHistoryKey& key)
{
    const auto* dialogue = project.find_dialogue(key.dialogue);
    if (dialogue == nullptr || find_dialogue_line(*dialogue, key.segment) == nullptr)
        return Result<void, Diagnostics>::failure(feature_error(
            "runtime.invalid_dialogue_line", "Dialogue line history target does not exist"));
    return increment_history(m_dialogue_line_history, key);
}

Result<void, Diagnostics> SessionState::record_dialogue_choice(const CompiledProject& project,
                                                               const DialogueChoiceHistoryKey& key)
{
    const auto* dialogue = project.find_dialogue(key.dialogue);
    if (dialogue == nullptr || !has_dialogue_choice_edge(*dialogue, key.edge))
        return Result<void, Diagnostics>::failure(feature_error(
            "runtime.invalid_dialogue_choice", "Dialogue choice history target does not exist"));
    return increment_history(m_dialogue_choice_history, key);
}

Result<void, Diagnostics> SessionState::append_text_log(const CompiledProject& project,
                                                        TextLogEntry entry)
{
    if (entry.kind > TextLogEntryKind::Notification ||
        !text_log_kind_matches_origin(entry.kind, entry.origin) ||
        (entry.speaker && project.find_character(*entry.speaker) == nullptr) ||
        !valid_text_log_origin(project, entry.origin))
        return Result<void, Diagnostics>::failure(
            feature_error("runtime.invalid_text_log_entry",
                          "Text-log entry contains an invalid typed reference"));
    m_text_log.push_back(std::move(entry));
    return Result<void, Diagnostics>::success();
}

Result<std::optional<LayoutId>, Diagnostics> SessionState::layout(compiled::LayoutSlot slot) const
{
    if (slot > compiled::LayoutSlot::Custom)
        return Result<std::optional<LayoutId>, Diagnostics>::failure(
            feature_error("runtime.invalid_layout_slot", "Layout slot is invalid"));
    const MountedLayoutPresentationKey key = ReservedLayoutMountKey{slot};
    const auto found =
        std::find_if(m_mounted_layouts.begin(), m_mounted_layouts.end(),
                     [&key](const DesiredMountedLayout& state) {
                         return state.key == key && presentation_authority(state.owner) ==
                                                        PresentationAuthority::Gameplay;
                     });
    return Result<std::optional<LayoutId>, Diagnostics>::success(
        found == m_mounted_layouts.end() ? std::nullopt : std::optional<LayoutId>{found->layout});
}

Result<void, Diagnostics> SessionState::upsert_mounted_layout(const CompiledProject& project,
                                                              DesiredMountedLayout value)
{
    auto owner = validate_presentation_owner(project, value.owner);
    bool key_valid = false;
    std::visit(
        [&](const auto& key) {
            using T = std::decay_t<decltype(key)>;
            if constexpr (std::is_same_v<T, ReservedLayoutMountKey>) {
                key_valid = key.slot <= compiled::LayoutSlot::Custom;
            } else if constexpr (std::is_same_v<T, RoomOverlayLayoutMountKey>) {
                const auto* room = project.find_room(key.room);
                const auto found = room == nullptr
                                       ? static_cast<const compiled::RoomOverlay*>(nullptr)
                                       : [&]() -> const compiled::RoomOverlay* {
                    const auto item = std::find_if(room->overlays.begin(), room->overlays.end(),
                                                   [&key](const compiled::RoomOverlay& overlay) {
                                                       return overlay.id == key.overlay;
                                                   });
                    return item == room->overlays.end() ? nullptr : &*item;
                }();
                const auto* room_owner = std::get_if<RoomPresentationOwner>(&value.owner);
                key_valid = found != nullptr && found->layout == value.layout &&
                            room_owner != nullptr && room_owner->room == key.room &&
                            value.policy.plane == PresentationPlane::WorldOverlay &&
                            value.composition_group == PresentationCompositionGroup::World;
            } else {
                key_valid = true;
            }
        },
        value.key);
    if (!owner || project.find_layout(value.layout) == nullptr || !key_valid ||
        !valid_layout_policy(value.policy) ||
        value.composition_group > PresentationCompositionGroup::Debug)
        return Result<void, Diagnostics>::failure(feature_error(
            "runtime.invalid_mounted_layout",
            "Mounted Layout contains an invalid owner, key, Layout, policy, or composition group"));
    const auto found =
        std::find_if(m_mounted_layouts.begin(), m_mounted_layouts.end(),
                     [&value](const DesiredMountedLayout& current) {
                         return current.key == value.key && current.owner == value.owner;
                     });
    if (found == m_mounted_layouts.end())
        m_mounted_layouts.push_back(std::move(value));
    else
        *found = std::move(value);
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics>
SessionState::remove_mounted_layout(const MountedLayoutPresentationKey& key,
                                    const PresentationOwner& owner)
{
    std::erase_if(m_mounted_layouts, [&key, &owner](const DesiredMountedLayout& value) {
        return value.key == key && value.owner == owner;
    });
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics> SessionState::set_layout(const CompiledProject& project,
                                                   compiled::LayoutSlot slot, LayoutId layout,
                                                   LayoutScaleOverrides scale_overrides)
{
    return set_layout(project, session_presentation_owner(), slot, std::move(layout),
                      std::move(scale_overrides));
}

Result<void, Diagnostics> SessionState::set_layout(const CompiledProject& project,
                                                   PresentationOwner owner,
                                                   compiled::LayoutSlot slot, LayoutId layout,
                                                   LayoutScaleOverrides scale_overrides)
{
    auto policy = reserved_layout_policy(slot);
    policy.scale_overrides = std::move(scale_overrides);
    return upsert_mounted_layout(
        project, DesiredMountedLayout{ReservedLayoutMountKey{slot}, std::move(owner),
                                      std::move(layout), std::move(policy),
                                      slot == compiled::LayoutSlot::Overlay
                                          ? PresentationCompositionGroup::World
                                          : PresentationCompositionGroup::Interface});
}

Result<void, Diagnostics> SessionState::clear_layout(compiled::LayoutSlot slot)
{
    return clear_layout(session_presentation_owner(), slot);
}

Result<void, Diagnostics> SessionState::clear_layout(const PresentationOwner& owner,
                                                     compiled::LayoutSlot slot)
{
    if (slot > compiled::LayoutSlot::Custom)
        return Result<void, Diagnostics>::failure(
            feature_error("runtime.invalid_layout_slot", "Layout slot is invalid"));
    return remove_mounted_layout(ReservedLayoutMountKey{slot}, owner);
}

Result<void, Diagnostics>
SessionState::apply_presentation_target(const CompiledProject& project,
                                        const PresentationTargetDraft& target)
{
    SessionState candidate = *this;
    candidate.m_background_overrides.clear();
    candidate.m_actors.clear();
    candidate.m_mounted_layouts.clear();

    for (const auto& background : target.background_overrides) {
        auto applied = candidate.upsert_background_override(project, background);
        if (!applied)
            return applied;
    }
    for (const auto& actor : target.actors) {
        auto applied = candidate.set_actor(project, actor);
        if (!applied)
            return applied;
    }
    for (const auto& layout : target.layouts) {
        auto applied = candidate.upsert_mounted_layout(project, layout);
        if (!applied)
            return applied;
    }

    m_background_overrides = std::move(candidate.m_background_overrides);
    m_actors = std::move(candidate.m_actors);
    m_mounted_layouts = std::move(candidate.m_mounted_layouts);
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics> SessionState::set_overlay(const CompiledProject& project, RoomId room,
                                                    RoomOverlayId overlay, bool visible)
{
    const auto* definition = project.find_room(room);
    const auto found = definition == nullptr ? static_cast<const compiled::RoomOverlay*>(nullptr)
                                             : [&]() -> const compiled::RoomOverlay* {
        const auto item = std::find_if(
            definition->overlays.begin(), definition->overlays.end(),
            [&overlay](const compiled::RoomOverlay& candidate) { return candidate.id == overlay; });
        return item == definition->overlays.end() ? nullptr : &*item;
    }();
    if (found == nullptr)
        return Result<void, Diagnostics>::failure(feature_error(
            "runtime.invalid_room_overlay", "Room overlay state references a missing overlay"));
    return upsert_mounted_layout(project,
                                 DesiredMountedLayout{RoomOverlayLayoutMountKey{room, overlay},
                                                      RoomPresentationOwner{room}, found->layout,
                                                      room_overlay_policy(found->order, visible),
                                                      PresentationCompositionGroup::World});
}

Result<void, Diagnostics> SessionState::present_text(const CompiledProject& project,
                                                     PresentedTextState text)
{
    if ((text.speaker && project.find_character(*text.speaker) == nullptr) ||
        text.markup > TextMarkup::ActiveText)
        return Result<void, Diagnostics>::failure(feature_error(
            "runtime.invalid_presented_text", "Presented text contains invalid typed state"));
    m_presented_text = std::move(text);
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics> SessionState::present_choice(const CompiledProject& project,
                                                       ActiveChoiceState choice)
{
    const bool valid = std::visit(
        [&project](const auto& value) {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, SceneChoiceState>)
                return valid_scene_choice(project, value);
            else
                return valid_dialogue_choice(project, value);
        },
        choice);
    if (!valid)
        return Result<void, Diagnostics>::failure(feature_error(
            "runtime.invalid_choice", "Choice state does not match its compiled program"));
    m_active_choice = std::move(choice);
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics> SessionState::set_map_presentation(const CompiledProject& project,
                                                             MapPresentationState map)
{
    const auto* definition = project.find_map(map.map);
    const bool valid_focus =
        !map.focused_location ||
        (definition != nullptr &&
         std::any_of(definition->locations.begin(), definition->locations.end(),
                     [&map](const compiled::MapLocation& location) {
                         return location.id == *map.focused_location;
                     }));
    if (definition == nullptr || map.mode > compiled::InitialMapMode::FullMap || !valid_focus)
        return Result<void, Diagnostics>::failure(
            feature_error("runtime.invalid_map_presentation",
                          "Map presentation references invalid compiled data"));
    m_map_presentation = std::move(map);
    return Result<void, Diagnostics>::success();
}

} // namespace noveltea::core
