#include "noveltea/runtime/flow_prediction.hpp"

#include <algorithm>
#include <cmath>
#include <functional>
#include <string>
#include <type_traits>
#include <utility>
#include <vector>

namespace noveltea::runtime {
namespace {

enum class KnownCondition : std::uint8_t {
    False,
    True,
    Unknown,
};

struct ProjectedProperty {
    core::PropertyId property;
    core::RuntimeValue value;
};
using ProjectedProperties = std::vector<ProjectedProperty>;

void add_invalid_index(core::Diagnostics& diagnostics, std::string kind, std::size_t index)
{
    diagnostics.push_back({.code = "assets.flow_prediction_invalid_index",
                           .message = "Flow Prediction Index references invalid " +
                                      std::move(kind) + " index " + std::to_string(index),
                           .severity = core::ErrorSeverity::Warning});
}

const core::RuntimeValue* find_property(const ProjectedProperties& properties,
                                        const core::PropertyId& property) noexcept
{
    const auto found = std::find_if(properties.begin(), properties.end(),
                                    [&](const auto& item) { return item.property == property; });
    return found == properties.end() ? nullptr : &found->value;
}

void set_property(ProjectedProperties& properties, const core::PropertyId& property,
                  core::RuntimeValue value)
{
    const auto found = std::find_if(properties.begin(), properties.end(),
                                    [&](const auto& item) { return item.property == property; });
    if (found == properties.end())
        properties.push_back({property, std::move(value)});
    else
        found->value = std::move(value);
}

void invalidate_property(ProjectedProperties& properties, const core::PropertyId& property)
{
    std::erase_if(properties, [&](const auto& item) { return item.property == property; });
}

bool numeric(const core::RuntimeValue& value) noexcept
{
    return std::holds_alternative<std::int64_t>(value) || std::holds_alternative<double>(value);
}

long double numeric_value(const core::RuntimeValue& value) noexcept
{
    if (const auto* integer = std::get_if<std::int64_t>(&value))
        return static_cast<long double>(*integer);
    return static_cast<long double>(*std::get_if<double>(&value));
}

KnownCondition compare_values(const core::RuntimeValue& current,
                              core::ValueComparisonOperator operation,
                              const core::RuntimeValue& expected) noexcept
{
    if (const auto* number = std::get_if<double>(&current);
        number != nullptr && !std::isfinite(*number))
        return KnownCondition::Unknown;
    if (const auto* number = std::get_if<double>(&expected);
        number != nullptr && !std::isfinite(*number))
        return KnownCondition::Unknown;

    const bool equality = numeric(current) && numeric(expected)
                              ? numeric_value(current) == numeric_value(expected)
                              : current == expected;
    if (operation == core::ValueComparisonOperator::Equal)
        return equality ? KnownCondition::True : KnownCondition::False;
    if (operation == core::ValueComparisonOperator::NotEqual)
        return equality ? KnownCondition::False : KnownCondition::True;

    int order = 0;
    if (numeric(current) && numeric(expected)) {
        const auto left = numeric_value(current);
        const auto right = numeric_value(expected);
        order = left < right ? -1 : (left > right ? 1 : 0);
    } else if (const auto* left = std::get_if<std::string>(&current)) {
        const auto* right = std::get_if<std::string>(&expected);
        if (right == nullptr)
            return KnownCondition::Unknown;
        order = *left < *right ? -1 : (*left > *right ? 1 : 0);
    } else {
        return KnownCondition::Unknown;
    }

    bool result = false;
    switch (operation) {
    case core::ValueComparisonOperator::Less:
        result = order < 0;
        break;
    case core::ValueComparisonOperator::LessEqual:
        result = order <= 0;
        break;
    case core::ValueComparisonOperator::Greater:
        result = order > 0;
        break;
    case core::ValueComparisonOperator::GreaterEqual:
        result = order >= 0;
        break;
    default:
        return KnownCondition::Unknown;
    }
    return result ? KnownCondition::True : KnownCondition::False;
}

KnownCondition evaluate_condition(const core::Condition& condition,
                                  const ProjectedProperties& properties)
{
    return std::visit(
        [&](const auto& value) -> KnownCondition {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, core::Always>) {
                return KnownCondition::True;
            } else if constexpr (std::is_same_v<T, core::AllCondition>) {
                bool unknown = false;
                for (const auto& child : value.conditions) {
                    const auto result = evaluate_condition(child, properties);
                    if (result == KnownCondition::False)
                        return KnownCondition::False;
                    unknown |= result == KnownCondition::Unknown;
                }
                return unknown ? KnownCondition::Unknown : KnownCondition::True;
            } else if constexpr (std::is_same_v<T, core::AnyCondition>) {
                bool unknown = false;
                for (const auto& child : value.conditions) {
                    const auto result = evaluate_condition(child, properties);
                    if (result == KnownCondition::True)
                        return KnownCondition::True;
                    unknown |= result == KnownCondition::Unknown;
                }
                return unknown ? KnownCondition::Unknown : KnownCondition::False;
            } else if constexpr (std::is_same_v<T, core::NotCondition>) {
                if (value.condition.size() != 1)
                    return KnownCondition::Unknown;
                const auto result = evaluate_condition(value.condition.front(), properties);
                if (result == KnownCondition::Unknown)
                    return result;
                return result == KnownCondition::True ? KnownCondition::False
                                                      : KnownCondition::True;
            } else if constexpr (std::is_same_v<T, core::GlobalPropertyComparison>) {
                return std::visit(
                    [&](const auto& comparison) -> KnownCondition {
                        const auto* current = find_property(properties, comparison.property_id);
                        if (current == nullptr)
                            return KnownCondition::Unknown;
                        using Comparison = std::decay_t<decltype(comparison)>;
                        if constexpr (std::is_same_v<Comparison, core::GlobalPropertyTruthiness>) {
                            const auto* boolean = std::get_if<bool>(current);
                            if (boolean == nullptr)
                                return KnownCondition::Unknown;
                            const bool expected =
                                comparison.operation == core::TruthinessOperator::Truthy;
                            return *boolean == expected ? KnownCondition::True
                                                        : KnownCondition::False;
                        } else {
                            return compare_values(*current, comparison.operation, comparison.value);
                        }
                    },
                    value);
            } else {
                // Lua and typed facts outside the deliberately admitted projection subset are
                // opaque to prediction. Unknown means widen rather than execute gameplay.
                return KnownCondition::Unknown;
            }
        },
        condition.value);
}

ProjectedProperties merge_properties(const ProjectedProperties& left,
                                     const ProjectedProperties& right)
{
    ProjectedProperties merged;
    for (const auto& item : left) {
        const auto* other = find_property(right, item.property);
        if (other != nullptr && *other == item.value)
            merged.push_back(item);
    }
    return merged;
}

std::optional<std::size_t> find_slice(const core::compiled::FlowPredictionIndex& index,
                                      const core::compiled::FlowPredictionPoint& point)
{
    for (std::size_t slice_index = 0; slice_index < index.slices.size(); ++slice_index) {
        if (index.slices[slice_index].point == point)
            return slice_index;
    }
    return std::nullopt;
}

core::compiled::FlowPredictionPoint entry_point(const core::SceneId& scene)
{
    return core::compiled::SceneEntryPredictionPoint{scene};
}

core::compiled::FlowPredictionPoint entry_point(const core::DialogueId& dialogue)
{
    return core::compiled::DialogueEntryPredictionPoint{dialogue};
}

ProjectedProperties initial_properties(const FlowPredictionContext& context)
{
    ProjectedProperties properties;
    properties.reserve(context.global_properties.size());
    for (const auto& value : context.global_properties)
        set_property(properties, value.property, value.value);
    return properties;
}

class PredictionTraversal {
public:
    PredictionTraversal(const core::compiled::FlowPredictionIndex& index,
                        FlowPredictionProjection& result,
                        FlowPredictionRootKind root_kind = FlowPredictionRootKind::FlowExecution,
                        std::optional<core::RoomId> root_room = std::nullopt)
        : m_index(index), m_result(result), m_root_kind(root_kind),
          m_root_room(std::move(root_room))
    {
    }

    struct Result {
        ProjectedProperties properties;
        std::size_t max_distance = 0;
    };

    Result run_slice(std::size_t slice_index, std::size_t distance,
                     FlowPredictionConfidence confidence, ProjectedProperties properties,
                     bool detached_root = false)
    {
        if (slice_index >= m_index.slices.size()) {
            add_invalid_index(m_result.diagnostics, "slice", slice_index);
            return {std::move(properties), distance};
        }
        if (std::find(m_active_slices.begin(), m_active_slices.end(), slice_index) !=
            m_active_slices.end())
            return {std::move(properties), distance};

        m_active_slices.push_back(slice_index);
        const auto& slice = m_index.slices[slice_index];
        const auto condition = slice.condition ? evaluate_condition(*slice.condition, properties)
                                               : KnownCondition::True;
        if (condition == KnownCondition::False) {
            auto result = run_false_successor(slice, distance, confidence, std::move(properties));
            m_active_slices.pop_back();
            return result;
        }

        const auto local_confidence = condition == KnownCondition::Unknown
                                          ? FlowPredictionConfidence::Alternative
                                          : confidence;
        const auto condition_properties = properties;
        append_dependencies(slice, distance, local_confidence);
        run_point_hints(slice_index, distance, local_confidence, properties);
        auto program =
            run_program(slice.program, distance + 1, local_confidence, std::move(properties));
        auto followed = run_control(slice, std::move(program), local_confidence, detached_root);

        if (condition == KnownCondition::Unknown && slice.condition_false_successor) {
            auto skipped = run_target(*slice.condition_false_successor, distance + 1,
                                      FlowPredictionConfidence::Alternative, condition_properties);
            followed.max_distance = std::max(followed.max_distance, skipped.max_distance);
            followed.properties = merge_properties(followed.properties, skipped.properties);
        }
        m_active_slices.pop_back();
        return followed;
    }

    Result run_choice_effect(std::size_t slice_index, const core::SceneChoiceOptionId& option_id,
                             std::size_t next_effect, std::size_t distance,
                             FlowPredictionConfidence confidence, ProjectedProperties properties)
    {
        if (slice_index >= m_index.slices.size()) {
            add_invalid_index(m_result.diagnostics, "slice", slice_index);
            return {std::move(properties), distance};
        }
        const auto* choice = std::get_if<core::compiled::FlowPredictionChoiceControl>(
            &m_index.slices[slice_index].control);
        if (choice == nullptr)
            return {std::move(properties), distance};
        const auto option = std::ranges::find_if(
            choice->options, [&](const auto& candidate) { return candidate.option == option_id; });
        if (option == choice->options.end())
            return {std::move(properties), distance};
        auto program = run_programs(option->programs, next_effect, distance, confidence,
                                    std::move(properties));
        return run_target(option->target, program.next_distance, confidence,
                          std::move(program.properties));
    }

    Result run_dialogue_effect(std::size_t slice_index,
                               const std::optional<core::InteractionInstructionId>& command_id,
                               bool awaiting_completion, std::size_t distance,
                               FlowPredictionConfidence confidence, ProjectedProperties properties)
    {
        if (slice_index >= m_index.slices.size()) {
            add_invalid_index(m_result.diagnostics, "slice", slice_index);
            return {std::move(properties), distance};
        }
        const auto& slice = m_index.slices[slice_index];
        if (!command_id) {
            if (!awaiting_completion)
                return run_slice(slice_index, distance, confidence, std::move(properties));
            if (slice.frontier == core::compiled::FlowPredictionFrontier::Normal)
                distance += 3;
            return run_control(slice, {std::move(properties), distance},
                               FlowPredictionConfidence::Alternative, false);
        }

        auto resumed = run_program_from_command(slice.program, *command_id, awaiting_completion,
                                                distance, confidence, properties);
        if (!resumed) {
            m_result.diagnostics.push_back(
                {.code = "assets.flow_prediction_missing_dialogue_command",
                 .message = "Flow Prediction Index cannot resume Dialogue effect command '" +
                            command_id->text() + "' from the active execution position",
                 .severity = core::ErrorSeverity::Warning});
            return {std::move(properties), distance};
        }
        if (awaiting_completion) {
            if (slice.frontier == core::compiled::FlowPredictionFrontier::Normal)
                resumed->next_distance += 3;
            confidence = FlowPredictionConfidence::Alternative;
        }
        return run_control(slice, std::move(*resumed), confidence, false);
    }

    Result run_room_entry(const core::RoomId& room, std::size_t distance,
                          FlowPredictionConfidence confidence, ProjectedProperties properties)
    {
        Result result{std::move(properties), distance};
        for (const auto stage : {core::compiled::RoomLifecyclePredictionStage::BeforeEnter,
                                 core::compiled::RoomLifecyclePredictionStage::Presentation,
                                 core::compiled::RoomLifecyclePredictionStage::AfterEnter}) {
            const auto slice =
                find_slice(m_index, core::compiled::RoomLifecyclePredictionPoint{room, stage});
            if (slice) {
                result = run_slice(*slice, result.max_distance, confidence,
                                   std::move(result.properties));
            }
            ++result.max_distance;
        }
        return result;
    }

private:
    struct ProgramResult {
        ProjectedProperties properties;
        std::size_t next_distance = 0;
    };

    void append_dependencies(const core::compiled::FlowPredictionSlice& slice, std::size_t distance,
                             FlowPredictionConfidence confidence)
    {
        const std::size_t execution_order = m_next_execution_order++;
        std::vector<core::compiled::FlowPredictionPoint> provenance_points;
        provenance_points.reserve(m_active_slices.size());
        for (const auto active : m_active_slices) {
            if (active < m_index.slices.size())
                provenance_points.push_back(m_index.slices[active].point);
        }
        std::size_t dependency_priority = 0;
        for (const std::size_t group_index : slice.dependency_groups) {
            if (group_index >= m_index.dependency_groups.size()) {
                add_invalid_index(m_result.diagnostics, "dependency-group", group_index);
                continue;
            }
            for (const auto& dependency : m_index.dependency_groups[group_index]) {
                m_result.entries.push_back(
                    {.dependency = dependency,
                     .execution_distance = distance,
                     .confidence = confidence,
                     .execution_order = execution_order,
                     .dependency_priority = dependency_priority++,
                     .provenance = {.points = provenance_points,
                                    .root_kind = m_root_kind,
                                    .room = m_root_room,
                                    .supplemental_hint_id = m_supplemental_hint_id}});
            }
        }
    }

    std::vector<core::compiled::FlowPredictionPoint> provenance_points() const
    {
        std::vector<core::compiled::FlowPredictionPoint> points;
        points.reserve(m_active_slices.size());
        for (const auto active : m_active_slices) {
            if (active < m_index.slices.size())
                points.push_back(m_index.slices[active].point);
        }
        return points;
    }

    void append_hint_dependency(core::compiled::FlowPredictionDependency dependency,
                                std::size_t distance, FlowPredictionConfidence confidence)
    {
        m_result.entries.push_back(
            {.dependency = std::move(dependency),
             .execution_distance = distance,
             .confidence = confidence,
             .execution_order = m_next_execution_order++,
             .dependency_priority = 0,
             .provenance = {.points = provenance_points(),
                            .root_kind = m_root_kind,
                            .room = m_root_room,
                            .supplemental_hint_id = m_supplemental_hint_id}});
    }

    void append_opaque_frontier()
    {
        if (m_active_slices.empty())
            return;
        const auto slice_index = m_active_slices.back();
        if (slice_index >= m_index.slices.size())
            return;
        FlowPredictionOpaqueFrontier frontier{
            .attachment_point = m_index.slices[slice_index].point,
            .provenance = {.points = provenance_points(),
                           .root_kind = m_root_kind,
                           .room = m_root_room,
                           .supplemental_hint_id = m_supplemental_hint_id},
        };
        if (std::ranges::find(m_result.opaque_frontiers, frontier) ==
            m_result.opaque_frontiers.end())
            m_result.opaque_frontiers.push_back(std::move(frontier));
    }

    bool hint_active(const core::compiled::FlowPredictionSupplementalHint& hint) const noexcept
    {
        return std::find(m_active_hints.begin(), m_active_hints.end(), &hint) !=
               m_active_hints.end();
    }

    void run_hint(const core::compiled::FlowPredictionSupplementalHint& hint, std::size_t distance,
                  FlowPredictionConfidence confidence, const ProjectedProperties& properties)
    {
        if (hint_active(hint))
            return;
        m_active_hints.push_back(&hint);
        const auto previous_hint = m_supplemental_hint_id;
        m_supplemental_hint_id = hint.id;
        std::visit(
            [&](const auto& target) {
                using T = std::decay_t<decltype(target)>;
                if constexpr (std::is_same_v<T, core::compiled::FlowPredictionHintAssetTarget>) {
                    append_hint_dependency(
                        core::compiled::FlowPredictionAssetDependency{target.asset}, distance,
                        confidence);
                } else if constexpr (std::is_same_v<
                                         T, core::compiled::FlowPredictionHintLayoutTarget>) {
                    append_hint_dependency(
                        core::compiled::FlowPredictionLayoutDependency{target.layout}, distance,
                        confidence);
                } else if constexpr (std::is_same_v<
                                         T, core::compiled::FlowPredictionHintSceneTarget>) {
                    (void)run_child(entry_point(target.scene), distance, confidence, properties,
                                    false);
                } else if constexpr (std::is_same_v<
                                         T, core::compiled::FlowPredictionHintDialogueTarget>) {
                    (void)run_child(entry_point(target.dialogue), distance, confidence, properties,
                                    false);
                } else if constexpr (std::is_same_v<T,
                                                    core::compiled::FlowPredictionHintRoomTarget>) {
                    (void)run_room_entry(target.room, distance, confidence, properties);
                }
            },
            hint.target);
        m_supplemental_hint_id = previous_hint;
        m_active_hints.pop_back();
    }

    void run_point_hints(std::size_t slice_index, std::size_t distance,
                         FlowPredictionConfidence confidence, const ProjectedProperties& properties)
    {
        for (const auto& hint : m_index.supplemental_hints) {
            const auto* attachment =
                std::get_if<core::compiled::FlowPredictionHintPointAttachment>(&hint.attachment);
            if (attachment != nullptr && attachment->slice == slice_index)
                run_hint(hint, distance, confidence, properties);
        }
    }

public:
    void run_room_hints(const core::RoomId& room, core::compiled::FlowPredictionRoomHintScope scope,
                        std::size_t distance, FlowPredictionConfidence confidence,
                        const ProjectedProperties& properties)
    {
        for (const auto& hint : m_index.supplemental_hints) {
            const auto* attachment =
                std::get_if<core::compiled::FlowPredictionHintRoomAttachment>(&hint.attachment);
            if (attachment != nullptr && attachment->room == room && attachment->scope == scope)
                run_hint(hint, distance, confidence, properties);
        }
    }

private:
    ProgramResult
    run_program_from(const std::vector<core::compiled::FlowPredictionCommand>& program,
                     std::size_t start, std::size_t distance, FlowPredictionConfidence confidence,
                     ProjectedProperties properties)
    {
        std::size_t next_distance = distance;
        for (std::size_t index = start; index < program.size(); ++index) {
            const auto& command = program[index];
            auto command_result = std::visit(
                [&](const auto& value) -> ProgramResult {
                    using T = std::decay_t<decltype(value)>;
                    if constexpr (std::is_same_v<T,
                                                 core::compiled::FlowPredictionSetGlobalProperty>) {
                        set_property(properties, value.property, value.value);
                    } else if constexpr (
                        std::is_same_v<T, core::compiled::FlowPredictionInvalidateGlobalProperty>) {
                        invalidate_property(properties, value.property);
                    } else if constexpr (std::is_same_v<T, core::compiled::FlowPredictionOpaque>) {
                        // Arbitrary Lua can mutate any gameplay fact. Do not execute or analyze it;
                        // discard knowledge and continue through statically known Flow.
                        append_opaque_frontier();
                        properties.clear();
                    } else if constexpr (std::is_same_v<T,
                                                        core::compiled::FlowPredictionCallScene>) {
                        auto child = run_child(entry_point(value.scene), next_distance, confidence,
                                               properties, false);
                        next_distance = std::max(next_distance, child.max_distance + 1);
                        properties.clear();
                    } else if constexpr (std::is_same_v<
                                             T, core::compiled::FlowPredictionStartDetachedScene>) {
                        (void)run_child(entry_point(value.scene), next_distance, confidence,
                                        properties, true);
                    } else if constexpr (std::is_same_v<
                                             T, core::compiled::FlowPredictionCallDialogue>) {
                        auto child = run_child(entry_point(value.dialogue), next_distance,
                                               confidence, properties, false);
                        next_distance = std::max(next_distance, child.max_distance + 1);
                        properties.clear();
                    } else if constexpr (std::is_same_v<T,
                                                        core::compiled::FlowPredictionEnterRoom>) {
                        auto room =
                            run_room_entry(value.room, next_distance, confidence, properties);
                        next_distance = std::max(next_distance, room.max_distance);
                        properties.clear();
                    } else if constexpr (std::is_same_v<T, core::compiled::FlowPredictionIf>) {
                        const auto evaluated = evaluate_condition(value.condition, properties);
                        if (evaluated == KnownCondition::True) {
                            return run_program(value.then_commands, next_distance + 1, confidence,
                                               std::move(properties));
                        }
                        if (evaluated == KnownCondition::False) {
                            return run_program(value.else_commands, next_distance + 1, confidence,
                                               std::move(properties));
                        }
                        auto then_result =
                            run_program(value.then_commands, next_distance + 1,
                                        FlowPredictionConfidence::Alternative, properties);
                        auto else_result =
                            run_program(value.else_commands, next_distance + 1,
                                        FlowPredictionConfidence::Alternative, properties);
                        return {merge_properties(then_result.properties, else_result.properties),
                                std::max(then_result.next_distance, else_result.next_distance)};
                    }
                    return {std::move(properties), next_distance};
                },
                command.value);
            properties = std::move(command_result.properties);
            next_distance = command_result.next_distance;
        }
        return {std::move(properties), next_distance};
    }

    ProgramResult run_program(const std::vector<core::compiled::FlowPredictionCommand>& program,
                              std::size_t distance, FlowPredictionConfidence confidence,
                              ProjectedProperties properties)
    {
        return run_program_from(program, 0, distance, confidence, std::move(properties));
    }

    std::optional<ProgramResult>
    run_program_from_command(const std::vector<core::compiled::FlowPredictionCommand>& program,
                             const core::InteractionInstructionId& command_id, bool completed,
                             std::size_t distance, FlowPredictionConfidence confidence,
                             const ProjectedProperties& properties)
    {
        for (std::size_t index = 0; index < program.size(); ++index) {
            const auto& command = program[index];
            if (command.command_id && *command.command_id == command_id)
                return run_program_from(program, index + (completed ? 1U : 0U), distance,
                                        confidence, properties);

            const auto* branch = std::get_if<core::compiled::FlowPredictionIf>(&command.value);
            if (branch == nullptr)
                continue;
            if (auto nested = run_program_from_command(branch->then_commands, command_id, completed,
                                                       distance, confidence, properties))
                return run_program_from(program, index + 1, nested->next_distance, confidence,
                                        std::move(nested->properties));
            if (auto nested = run_program_from_command(branch->else_commands, command_id, completed,
                                                       distance, confidence, properties))
                return run_program_from(program, index + 1, nested->next_distance, confidence,
                                        std::move(nested->properties));
        }
        return std::nullopt;
    }

    ProgramResult
    run_programs(const std::vector<std::vector<core::compiled::FlowPredictionCommand>>& programs,
                 std::size_t start, std::size_t distance, FlowPredictionConfidence confidence,
                 ProjectedProperties properties)
    {
        ProgramResult result{std::move(properties), distance};
        for (std::size_t index = start; index < programs.size(); ++index) {
            result = run_program(programs[index], result.next_distance, confidence,
                                 std::move(result.properties));
        }
        return result;
    }

    Result run_child(const core::compiled::FlowPredictionPoint& point, std::size_t distance,
                     FlowPredictionConfidence confidence, const ProjectedProperties& properties,
                     bool detached_root)
    {
        const auto child = find_slice(m_index, point);
        if (child)
            return run_slice(*child, distance, confidence, properties, detached_root);
        return {properties, distance};
    }

    Result run_target(std::size_t target, std::size_t distance, FlowPredictionConfidence confidence,
                      ProjectedProperties properties, bool detached_root = false)
    {
        if (target >= m_index.slices.size()) {
            add_invalid_index(m_result.diagnostics, "successor", target);
            return {std::move(properties), distance};
        }
        return run_slice(target, distance, confidence, std::move(properties), detached_root);
    }

    Result run_false_successor(const core::compiled::FlowPredictionSlice& slice,
                               std::size_t distance, FlowPredictionConfidence confidence,
                               ProjectedProperties properties)
    {
        if (!slice.condition_false_successor)
            return {std::move(properties), distance};
        return run_target(*slice.condition_false_successor, distance + 1, confidence,
                          std::move(properties));
    }

    Result run_control(const core::compiled::FlowPredictionSlice& slice, ProgramResult program,
                       FlowPredictionConfidence confidence, bool detached_root)
    {
        std::size_t distance = program.next_distance;
        auto continuation_confidence = confidence;
        switch (slice.frontier) {
        case core::compiled::FlowPredictionFrontier::Normal:
            break;
        case core::compiled::FlowPredictionFrontier::ShortWait:
            distance += 1;
            break;
        case core::compiled::FlowPredictionFrontier::StrongWait:
        case core::compiled::FlowPredictionFrontier::Decision:
            distance += 3;
            continuation_confidence = FlowPredictionConfidence::Alternative;
            break;
        }
        if (detached_root) {
            distance += 2;
            continuation_confidence = FlowPredictionConfidence::Alternative;
        }

        return std::visit(
            [&](const auto& control) -> Result {
                using T = std::decay_t<decltype(control)>;
                if constexpr (std::is_same_v<T, core::compiled::FlowPredictionSequentialControl>) {
                    if (!control.successor)
                        return {std::move(program.properties), distance};
                    return run_target(*control.successor, distance, continuation_confidence,
                                      std::move(program.properties));
                } else if constexpr (std::is_same_v<T,
                                                    core::compiled::FlowPredictionBranchControl>) {
                    bool widened = false;
                    std::vector<Result> alternatives;
                    for (const auto& branch : control.branches) {
                        const auto evaluated =
                            evaluate_condition(branch.condition, program.properties);
                        if (evaluated == KnownCondition::False)
                            continue;
                        if (evaluated == KnownCondition::True) {
                            auto selected =
                                run_target(branch.target, distance,
                                           widened ? FlowPredictionConfidence::Alternative
                                                   : continuation_confidence,
                                           program.properties);
                            if (!widened)
                                return selected;
                            alternatives.push_back(std::move(selected));
                            break;
                        }
                        widened = true;
                        alternatives.push_back(run_target(branch.target, distance,
                                                          FlowPredictionConfidence::Alternative,
                                                          program.properties));
                    }
                    if (alternatives.empty() || widened)
                        alternatives.push_back(
                            run_target(control.fallback, distance,
                                       widened ? FlowPredictionConfidence::Alternative
                                               : continuation_confidence,
                                       program.properties));
                    Result merged = std::move(alternatives.front());
                    for (std::size_t index = 1; index < alternatives.size(); ++index) {
                        merged.max_distance =
                            std::max(merged.max_distance, alternatives[index].max_distance);
                        merged.properties =
                            merge_properties(merged.properties, alternatives[index].properties);
                    }
                    return merged;
                } else {
                    std::vector<Result> alternatives;
                    for (const auto& option : control.options) {
                        if (option.condition &&
                            evaluate_condition(*option.condition, program.properties) ==
                                KnownCondition::False)
                            continue;
                        auto option_program =
                            run_programs(option.programs, 0, distance,
                                         FlowPredictionConfidence::Alternative, program.properties);
                        alternatives.push_back(run_target(option.target,
                                                          option_program.next_distance,
                                                          FlowPredictionConfidence::Alternative,
                                                          std::move(option_program.properties)));
                    }
                    if (alternatives.empty())
                        return {std::move(program.properties), distance};
                    Result merged = std::move(alternatives.front());
                    for (std::size_t index = 1; index < alternatives.size(); ++index) {
                        merged.max_distance =
                            std::max(merged.max_distance, alternatives[index].max_distance);
                        merged.properties =
                            merge_properties(merged.properties, alternatives[index].properties);
                    }
                    return merged;
                }
            },
            slice.control);
    }

    const core::compiled::FlowPredictionIndex& m_index;
    FlowPredictionProjection& m_result;
    FlowPredictionRootKind m_root_kind = FlowPredictionRootKind::FlowExecution;
    std::optional<core::RoomId> m_root_room;
    std::vector<std::size_t> m_active_slices;
    std::vector<const core::compiled::FlowPredictionSupplementalHint*> m_active_hints;
    std::optional<std::string> m_supplemental_hint_id;
    std::size_t m_next_execution_order = 0;
};

std::optional<std::size_t> find_room_stage(const core::compiled::FlowPredictionIndex& index,
                                           const core::RoomId& room,
                                           core::compiled::RoomLifecyclePredictionStage stage)
{
    return find_slice(index, core::compiled::RoomLifecyclePredictionPoint{room, stage});
}

} // namespace

FlowPredictionProjection FlowPredictor::predict(const core::compiled::Entrypoint& root) const
{
    return predict(root, {});
}

FlowPredictionProjection FlowPredictor::predict(const core::compiled::Entrypoint& root,
                                                const FlowPredictionContext& context) const
{
    return std::visit(
        [&](const auto& value) -> FlowPredictionProjection {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, core::RoomId>) {
                return predict(ProspectiveRoomEntryPredictionRoot{std::nullopt, value}, context);
            } else {
                FlowPredictionProjection result;
                const auto& optional_index = m_project->flow_prediction();
                if (!optional_index)
                    return result;
                const auto root_slice = find_slice(*optional_index, entry_point(value));
                if (!root_slice)
                    return result;
                PredictionTraversal traversal(*optional_index, result);
                (void)traversal.run_slice(*root_slice, 0, FlowPredictionConfidence::Expected,
                                          initial_properties(context));
                return result;
            }
        },
        root);
}

FlowPredictionProjection
FlowPredictor::predict(const ProspectiveRoomEntryPredictionRoot& root) const
{
    return predict(root, {});
}

FlowPredictionProjection FlowPredictor::predict(const ProspectiveRoomEntryPredictionRoot& root,
                                                const FlowPredictionContext& context) const
{
    FlowPredictionProjection result;
    const auto& optional_index = m_project->flow_prediction();
    if (!optional_index)
        return result;
    const auto& index = *optional_index;
    PredictionTraversal traversal(index, result, FlowPredictionRootKind::ProspectiveRoomEntry,
                                  root.target_room);
    auto properties = initial_properties(context);
    std::size_t distance = 0;
    traversal.run_room_hints(root.target_room,
                             core::compiled::FlowPredictionRoomHintScope::EntryPath, distance,
                             FlowPredictionConfidence::Expected, properties);

    auto run_stage = [&](const core::RoomId& room,
                         core::compiled::RoomLifecyclePredictionStage stage) {
        if (const auto slice = find_room_stage(index, room, stage)) {
            properties = traversal
                             .run_slice(*slice, distance, FlowPredictionConfidence::Expected,
                                        std::move(properties))
                             .properties;
        }
        ++distance;
    };

    // Mirror the successful runtime transition sequence. Rejection programs deliberately have no
    // prospective-entry slices and therefore cannot leak into this normal-success prediction root.
    if (root.source_room)
        run_stage(*root.source_room, core::compiled::RoomLifecyclePredictionStage::BeforeLeave);
    run_stage(root.target_room, core::compiled::RoomLifecyclePredictionStage::BeforeEnter);
    run_stage(root.target_room, core::compiled::RoomLifecyclePredictionStage::Presentation);
    if (root.source_room)
        run_stage(*root.source_room, core::compiled::RoomLifecyclePredictionStage::AfterLeave);
    run_stage(root.target_room, core::compiled::RoomLifecyclePredictionStage::AfterEnter);
    return result;
}

FlowPredictionProjection FlowPredictor::predict(const ResidentRoomPredictionRoot& root) const
{
    return predict(root, {});
}

FlowPredictionProjection FlowPredictor::predict(const ResidentRoomPredictionRoot& root,
                                                const FlowPredictionContext& context) const
{
    FlowPredictionProjection result;
    const auto& optional_index = m_project->flow_prediction();
    if (!optional_index)
        return result;
    const auto& index = *optional_index;
    PredictionTraversal traversal(index, result, FlowPredictionRootKind::ResidentRoomContext,
                                  root.room);
    const auto properties = initial_properties(context);
    traversal.run_room_hints(root.room, core::compiled::FlowPredictionRoomHintScope::Resident, 0,
                             FlowPredictionConfidence::Alternative, properties);
    for (const auto& program : root.programs) {
        const auto point = std::visit(
            [](const auto& value) -> core::compiled::FlowPredictionPoint {
                using T = std::decay_t<decltype(value)>;
                if constexpr (std::is_same_v<T, core::InteractionRuleProgramRef>) {
                    return core::compiled::InteractionRulePredictionPoint{value.interaction,
                                                                          value.rule};
                } else if constexpr (std::is_same_v<T, core::VerbDefaultProgramRef>) {
                    return core::compiled::VerbDefaultPredictionPoint{value.verb};
                } else {
                    return core::compiled::UndefinedInteractionPredictionPoint{};
                }
            },
            program);
        if (const auto slice = find_slice(index, point)) {
            (void)traversal.run_slice(*slice, 0, FlowPredictionConfidence::Alternative, properties);
        }
    }
    for (const auto& layout : root.layouts) {
        if (const auto slice =
                find_slice(index, core::compiled::ResidentLayoutPredictionPoint{layout})) {
            (void)traversal.run_slice(*slice, 0, FlowPredictionConfidence::Alternative, properties);
        }
    }
    return result;
}

FlowPredictionProjection FlowPredictor::predict(const ActiveScenePredictionRoot& root) const
{
    return predict(root, {});
}

FlowPredictionProjection FlowPredictor::predict(const ActiveScenePredictionRoot& root,
                                                const FlowPredictionContext& context) const
{
    FlowPredictionProjection result;
    const auto& optional_index = m_project->flow_prediction();
    if (!optional_index)
        return result;
    const auto& index = *optional_index;
    PredictionTraversal traversal(index, result);
    auto properties = initial_properties(context);

    if (!root.position.stage_initialized) {
        if (const auto entry =
                find_slice(index, core::compiled::SceneEntryPredictionPoint{root.scene}))
            (void)traversal.run_slice(*entry, 0, FlowPredictionConfidence::Expected,
                                      std::move(properties));
        return result;
    }

    const auto step_slice = [&](const core::SceneStepId& step) {
        return find_slice(index, core::compiled::SceneStepPredictionPoint{root.scene, step});
    };
    const auto run_position = [&](const std::optional<core::SceneStepId>& step,
                                  std::size_t distance, FlowPredictionConfidence confidence,
                                  ProjectedProperties projected) {
        const auto point =
            step ? core::compiled::FlowPredictionPoint{core::compiled::SceneStepPredictionPoint{
                       root.scene, *step}}
                 : core::compiled::FlowPredictionPoint{
                       core::compiled::SceneTerminalPredictionPoint{root.scene}};
        if (const auto slice = find_slice(index, point))
            (void)traversal.run_slice(*slice, distance, confidence, std::move(projected));
    };

    if (const auto* effects =
            std::get_if<core::SceneChoiceEffectPosition>(&root.position.substate)) {
        if (root.position.next_step) {
            if (const auto slice = step_slice(*root.position.next_step)) {
                (void)traversal.run_choice_effect(*slice, effects->option, effects->next_effect, 0,
                                                  FlowPredictionConfidence::Expected,
                                                  std::move(properties));
            }
        }
        return result;
    }

    if (const auto* completion =
            std::get_if<core::SceneInstructionCompletionPosition>(&root.position.substate)) {
        std::size_t distance = 0;
        auto confidence = FlowPredictionConfidence::Expected;
        if (root.position.next_step) {
            if (const auto current = step_slice(*root.position.next_step)) {
                switch (index.slices[*current].frontier) {
                case core::compiled::FlowPredictionFrontier::Normal:
                    break;
                case core::compiled::FlowPredictionFrontier::ShortWait:
                    distance = 1;
                    break;
                case core::compiled::FlowPredictionFrontier::StrongWait:
                case core::compiled::FlowPredictionFrontier::Decision:
                    distance = 3;
                    confidence = FlowPredictionConfidence::Alternative;
                    break;
                }
            }
        }
        run_position(completion->next_step, distance, confidence, std::move(properties));
        return result;
    }

    if (const auto* pending =
            std::get_if<core::SceneAutosavePendingPosition>(&root.position.substate)) {
        run_position(pending->next_step, 0, FlowPredictionConfidence::Expected,
                     std::move(properties));
        return result;
    }

    run_position(root.position.next_step, 0, FlowPredictionConfidence::Expected,
                 std::move(properties));
    return result;
}

FlowPredictionProjection FlowPredictor::predict(const ActiveDialoguePredictionRoot& root) const
{
    return predict(root, {});
}

FlowPredictionProjection FlowPredictor::predict(const ActiveDialoguePredictionRoot& root,
                                                const FlowPredictionContext& context) const
{
    FlowPredictionProjection result;
    const auto& optional_index = m_project->flow_prediction();
    if (!optional_index)
        return result;
    const auto& index = *optional_index;
    PredictionTraversal traversal(index, result);

    core::compiled::FlowPredictionPoint point =
        core::compiled::DialogueTerminalPredictionPoint{root.dialogue};
    if (root.position.stage != core::DialogueFramePosition::Stage::Complete) {
        core::compiled::DialoguePredictionStage stage =
            core::compiled::DialoguePredictionStage::EnterBlock;
        std::size_t cursor = 0;
        switch (root.position.stage) {
        case core::DialogueFramePosition::Stage::EnterBlock:
            stage = core::compiled::DialoguePredictionStage::EnterBlock;
            break;
        case core::DialogueFramePosition::Stage::PresentSegment:
            stage = core::compiled::DialoguePredictionStage::PresentSegment;
            cursor = root.position.next_cue;
            break;
        case core::DialogueFramePosition::Stage::ApplySegmentEffects:
            stage = core::compiled::DialoguePredictionStage::ApplySegmentEffects;
            cursor = root.position.next_effect;
            break;
        case core::DialogueFramePosition::Stage::PresentChoices:
            stage = core::compiled::DialoguePredictionStage::PresentChoices;
            break;
        case core::DialogueFramePosition::Stage::ApplyChoiceEffects:
            stage = core::compiled::DialoguePredictionStage::ApplyChoiceEffects;
            cursor = root.position.next_effect;
            break;
        case core::DialogueFramePosition::Stage::FollowEdge:
            stage = core::compiled::DialoguePredictionStage::FollowEdge;
            break;
        case core::DialogueFramePosition::Stage::Complete:
            break;
        }
        point = core::compiled::DialoguePositionPredictionPoint{
            root.dialogue, root.position.block, root.position.segment, root.position.edge, stage,
            cursor};
    }
    if (const auto slice = find_slice(index, point)) {
        auto properties = initial_properties(context);
        if (root.position.stage == core::DialogueFramePosition::Stage::ApplySegmentEffects ||
            root.position.stage == core::DialogueFramePosition::Stage::ApplyChoiceEffects) {
            (void)traversal.run_dialogue_effect(
                *slice, root.position.effect_command, root.position.awaiting_completion, 0,
                FlowPredictionConfidence::Expected, std::move(properties));
        } else if (root.position.stage == core::DialogueFramePosition::Stage::PresentSegment &&
                   root.position.awaiting_completion) {
            (void)traversal.run_dialogue_effect(*slice, std::nullopt, true, 0,
                                                FlowPredictionConfidence::Expected,
                                                std::move(properties));
        } else {
            (void)traversal.run_slice(*slice, 0, FlowPredictionConfidence::Expected,
                                      std::move(properties));
        }
    }
    return result;
}

} // namespace noveltea::runtime
