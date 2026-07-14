#include "noveltea/core/session_state.hpp"

#include <algorithm>
#include <bit>
#include <cmath>
#include <limits>
#include <type_traits>
#include <utility>

namespace noveltea::core {
namespace {

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
                                                    const ActorSlotKey& key,
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
                           const ActorState& actor) noexcept
{
    const auto pose = std::find_if(
        character.poses.begin(), character.poses.end(),
        [&actor](const compiled::CharacterPose& item) { return item.id == actor.pose; });
    const auto expression = std::find_if(character.expressions.begin(), character.expressions.end(),
                                         [&actor](const compiled::CharacterExpression& item) {
                                             return item.id == actor.expression;
                                         });
    return pose != character.poses.end() && expression != character.expressions.end() &&
           (!expression->pose_id || *expression->pose_id == actor.pose) &&
           actor.placement.position <= compiled::ActorPosition::Custom &&
           std::isfinite(actor.placement.offset.x) && std::isfinite(actor.placement.offset.y) &&
           std::isfinite(actor.placement.scale) && actor.placement.scale > 0.0;
}

bool valid_interactable_location(const CompiledProject& project, const InteractableId& interactable,
                                 const compiled::InteractableLocation& location) noexcept
{
    const auto* placement = std::get_if<compiled::RoomPlacementRef>(&location);
    if (placement == nullptr)
        return true;
    const auto* room = project.find_room(placement->room);
    return room != nullptr &&
           std::any_of(room->placements.begin(), room->placements.end(),
                       [&interactable, placement](const compiled::RoomPlacement& item) {
                           return item.id == placement->placement_id &&
                                  item.interactable == interactable;
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
        interactables.push_back(
            InteractableState{definition.identity.id, definition.initial_state.location,
                              definition.initial_state.enabled, definition.initial_state.visible});
    }
    return Result<SessionState, Diagnostics>::success(SessionState(
        FlowMode{}, std::move(*initial_stack), std::move(variables), std::move(interactables), 2));
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

const ActorState* SessionState::actor(const ActorSlotKey& key) const noexcept
{
    const auto found = std::find_if(m_actors.begin(), m_actors.end(),
                                    [&key](const ActorState& value) { return value.key == key; });
    return found == m_actors.end() ? nullptr : &*found;
}

Result<void, Diagnostics> SessionState::set_actor(const CompiledProject& project, ActorState value)
{
    const auto* scene = project.find_scene(value.key.scene);
    const auto* character = project.find_character(value.character);
    if (scene == nullptr || character == nullptr ||
        find_actor_cue(*scene, value.key, value.character) == nullptr ||
        !valid_character_state(*character, value))
        return Result<void, Diagnostics>::failure(feature_error(
            "runtime.invalid_actor_state",
            "Actor state must reference one valid Scene slot, Character, pose, and expression"));
    const auto found =
        std::find_if(m_actors.begin(), m_actors.end(),
                     [&value](const ActorState& current) { return current.key == value.key; });
    if (found == m_actors.end())
        m_actors.push_back(std::move(value));
    else
        *found = std::move(value);
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics> SessionState::remove_actor(const CompiledProject& project,
                                                     const ActorSlotKey& key)
{
    if (project.find_scene(key.scene) == nullptr)
        return Result<void, Diagnostics>::failure(
            feature_error("runtime.unknown_scene", "Actor slot Scene does not exist"));
    const auto found = std::find_if(m_actors.begin(), m_actors.end(),
                                    [&key](const ActorState& value) { return value.key == key; });
    if (found == m_actors.end())
        return Result<void, Diagnostics>::failure(
            feature_error("runtime.unknown_actor", "Actor slot has no live state"));
    m_actors.erase(found);
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics>
SessionState::set_actor_presentation_complete(const CompiledProject& project,
                                              const ActorSlotKey& key, bool complete)
{
    if (project.find_scene(key.scene) == nullptr)
        return Result<void, Diagnostics>::failure(
            feature_error("runtime.unknown_scene", "Actor slot Scene does not exist"));
    const auto found = std::find_if(m_actors.begin(), m_actors.end(),
                                    [&key](const ActorState& value) { return value.key == key; });
    if (found == m_actors.end())
        return Result<void, Diagnostics>::failure(
            feature_error("runtime.unknown_actor", "Actor slot has no live state"));
    found->presentation_complete = complete;
    return Result<void, Diagnostics>::success();
}

const InteractableState* SessionState::interactable(const InteractableId& id) const noexcept
{
    const auto found =
        std::find_if(m_interactables.begin(), m_interactables.end(),
                     [&id](const InteractableState& value) { return value.interactable == id; });
    return found == m_interactables.end() ? nullptr : &*found;
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
    if (!valid_interactable_location(project, id, location))
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

Result<void, Diagnostics> SessionState::commit_room_entry(const CompiledProject& project,
                                                          const RoomId& room)
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

    std::vector<RoomOverlayState> overlays = m_overlays;
    for (const auto& overlay : definition->overlays) {
        if (project.find_layout(overlay.layout) == nullptr)
            return Result<void, Diagnostics>::failure(feature_error(
                "runtime.invalid_room_overlay", "Room entry overlay references a missing Layout"));
        const auto found = std::find_if(
            overlays.begin(), overlays.end(), [&room, &overlay](const RoomOverlayState& state) {
                return state.room == room && state.overlay == overlay.id;
            });
        if (found == overlays.end())
            overlays.push_back(RoomOverlayState{room, overlay.id, overlay.enabled});
    }

    if (visit == m_room_visits.end())
        m_room_visits.emplace(room, 1);
    else
        ++visit->second;
    m_background = definition->background;
    m_overlays = std::move(overlays);
    m_presented_text.reset();
    m_active_choice.reset();
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
    const auto found =
        std::find_if(m_layouts.begin(), m_layouts.end(),
                     [slot](const LayoutSlotState& state) { return state.slot == slot; });
    return Result<std::optional<LayoutId>, Diagnostics>::success(
        found == m_layouts.end() ? std::nullopt : std::optional<LayoutId>{found->layout});
}

Result<void, Diagnostics> SessionState::set_background(const CompiledProject& project,
                                                       compiled::BackgroundPresentation background)
{
    if (!valid_background(project, background))
        return Result<void, Diagnostics>::failure(feature_error(
            "runtime.invalid_background", "Background contains an invalid fit or Asset reference"));
    m_background = std::move(background);
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics> SessionState::set_layout(const CompiledProject& project,
                                                   compiled::LayoutSlot slot, LayoutId layout)
{
    if (slot > compiled::LayoutSlot::Custom || project.find_layout(layout) == nullptr)
        return Result<void, Diagnostics>::failure(feature_error(
            "runtime.invalid_layout", "Layout state contains an invalid slot or Layout reference"));
    const auto found =
        std::find_if(m_layouts.begin(), m_layouts.end(),
                     [slot](const LayoutSlotState& state) { return state.slot == slot; });
    if (found == m_layouts.end())
        m_layouts.push_back(LayoutSlotState{slot, std::move(layout)});
    else
        found->layout = std::move(layout);
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics> SessionState::clear_layout(compiled::LayoutSlot slot)
{
    if (slot > compiled::LayoutSlot::Custom)
        return Result<void, Diagnostics>::failure(
            feature_error("runtime.invalid_layout_slot", "Layout slot is invalid"));
    const auto found =
        std::find_if(m_layouts.begin(), m_layouts.end(),
                     [slot](const LayoutSlotState& state) { return state.slot == slot; });
    if (found != m_layouts.end())
        m_layouts.erase(found);
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics> SessionState::set_overlay(const CompiledProject& project, RoomId room,
                                                    RoomOverlayId overlay, bool visible)
{
    const auto* definition = project.find_room(room);
    if (definition == nullptr ||
        std::none_of(definition->overlays.begin(), definition->overlays.end(),
                     [&overlay](const compiled::RoomOverlay& item) { return item.id == overlay; }))
        return Result<void, Diagnostics>::failure(feature_error(
            "runtime.invalid_room_overlay", "Room overlay state references a missing overlay"));
    const auto found = std::find_if(m_overlays.begin(), m_overlays.end(),
                                    [&room, &overlay](const RoomOverlayState& state) {
                                        return state.room == room && state.overlay == overlay;
                                    });
    if (found == m_overlays.end())
        m_overlays.push_back(RoomOverlayState{std::move(room), std::move(overlay), visible});
    else
        found->visible = visible;
    return Result<void, Diagnostics>::success();
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

Result<void, Diagnostics> SessionState::set_transition(LogicalTransitionState transition)
{
    if (transition.kind > compiled::TransitionKind::Dissolve)
        return Result<void, Diagnostics>::failure(
            feature_error("runtime.invalid_transition", "Logical transition kind is invalid"));
    m_transition = std::move(transition);
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics> SessionState::set_audio_channel(const CompiledProject& project,
                                                          AudioChannelState audio)
{
    if (audio.channel > compiled::AudioChannel::Ambient || !std::isfinite(audio.volume) ||
        audio.volume < 0.0 || audio.volume > 1.0 ||
        (audio.asset && project.find_asset(*audio.asset) == nullptr) ||
        (audio.playing && !audio.asset))
        return Result<void, Diagnostics>::failure(feature_error(
            "runtime.invalid_audio_state", "Audio channel contains invalid logical state"));
    const auto found = std::find_if(
        m_audio_channels.begin(), m_audio_channels.end(),
        [&audio](const AudioChannelState& current) { return current.channel == audio.channel; });
    if (found == m_audio_channels.end())
        m_audio_channels.push_back(std::move(audio));
    else
        *found = std::move(audio);
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
