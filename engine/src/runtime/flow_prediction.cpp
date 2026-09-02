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
                        FlowPredictionProjection& result)
        : m_index(index), m_result(result)
    {
    }

    ProjectedProperties run_slice(std::size_t slice_index, std::size_t distance,
                                  FlowPredictionConfidence confidence,
                                  ProjectedProperties properties)
    {
        if (slice_index >= m_index.slices.size()) {
            add_invalid_index(m_result.diagnostics, "slice", slice_index);
            return properties;
        }
        if (std::find(m_active_slices.begin(), m_active_slices.end(), slice_index) !=
            m_active_slices.end())
            return properties;

        m_active_slices.push_back(slice_index);
        const auto& slice = m_index.slices[slice_index];
        append_dependencies(slice, distance, confidence);
        properties = run_program(slice.program, distance + 1, confidence, std::move(properties));
        for (const std::size_t successor : slice.successors) {
            if (successor >= m_index.slices.size()) {
                add_invalid_index(m_result.diagnostics, "successor", successor);
                continue;
            }
            properties = run_slice(successor, distance + 1, confidence, std::move(properties));
        }
        m_active_slices.pop_back();
        return properties;
    }

private:
    void append_dependencies(const core::compiled::FlowPredictionSlice& slice, std::size_t distance,
                             FlowPredictionConfidence confidence)
    {
        for (const std::size_t group_index : slice.dependency_groups) {
            if (group_index >= m_index.dependency_groups.size()) {
                add_invalid_index(m_result.diagnostics, "dependency-group", group_index);
                continue;
            }
            for (const auto& dependency : m_index.dependency_groups[group_index]) {
                m_result.entries.push_back({.dependency = dependency,
                                            .execution_distance = distance,
                                            .confidence = confidence});
            }
        }
    }

    ProjectedProperties
    run_program(const std::vector<core::compiled::FlowPredictionCommand>& program,
                std::size_t distance, FlowPredictionConfidence confidence,
                ProjectedProperties properties)
    {
        for (const auto& command : program) {
            properties = std::visit(
                [&](const auto& value) -> ProjectedProperties {
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
                        properties.clear();
                    } else if constexpr (std::is_same_v<T,
                                                        core::compiled::FlowPredictionCallScene>) {
                        run_child(entry_point(value.scene), distance, confidence, properties);
                        properties.clear();
                    } else if constexpr (std::is_same_v<
                                             T, core::compiled::FlowPredictionCallDialogue>) {
                        run_child(entry_point(value.dialogue), distance, confidence, properties);
                        properties.clear();
                    } else if constexpr (std::is_same_v<T, core::compiled::FlowPredictionIf>) {
                        const auto evaluated = evaluate_condition(value.condition, properties);
                        if (evaluated == KnownCondition::True) {
                            return run_program(value.then_commands, distance + 1, confidence,
                                               std::move(properties));
                        }
                        if (evaluated == KnownCondition::False) {
                            return run_program(value.else_commands, distance + 1, confidence,
                                               std::move(properties));
                        }
                        auto then_properties =
                            run_program(value.then_commands, distance + 1,
                                        FlowPredictionConfidence::Alternative, properties);
                        auto else_properties =
                            run_program(value.else_commands, distance + 1,
                                        FlowPredictionConfidence::Alternative, properties);
                        return merge_properties(then_properties, else_properties);
                    }
                    return std::move(properties);
                },
                command.value);
        }
        return properties;
    }

    void run_child(const core::compiled::FlowPredictionPoint& point, std::size_t distance,
                   FlowPredictionConfidence confidence, const ProjectedProperties& properties)
    {
        const auto child = find_slice(m_index, point);
        if (child)
            (void)run_slice(*child, distance, confidence, properties);
    }

    const core::compiled::FlowPredictionIndex& m_index;
    FlowPredictionProjection& m_result;
    std::vector<std::size_t> m_active_slices;
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
    PredictionTraversal traversal(index, result);
    auto properties = initial_properties(context);
    std::size_t distance = 0;

    auto run_stage = [&](const core::RoomId& room,
                         core::compiled::RoomLifecyclePredictionStage stage) {
        if (const auto slice = find_room_stage(index, room, stage)) {
            properties = traversal.run_slice(*slice, distance, FlowPredictionConfidence::Expected,
                                             std::move(properties));
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

} // namespace noveltea::runtime
