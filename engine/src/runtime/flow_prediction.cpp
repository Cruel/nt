#include "noveltea/runtime/flow_prediction.hpp"

#include <deque>
#include <string>
#include <type_traits>
#include <unordered_set>

namespace noveltea::runtime {
namespace {

void add_invalid_index(core::Diagnostics& diagnostics, std::string kind, std::size_t index)
{
    diagnostics.push_back({.code = "assets.flow_prediction_invalid_index",
                           .message = "Flow Prediction Index references invalid " +
                                      std::move(kind) + " index " + std::to_string(index),
                           .severity = core::ErrorSeverity::Warning});
}

} // namespace

FlowPredictionProjection FlowPredictor::predict(const core::compiled::Entrypoint& root) const
{
    FlowPredictionProjection result;
    const auto& optional_index = m_project->flow_prediction();
    if (!optional_index)
        return result;
    const auto& index = *optional_index;

    const auto* scene = std::get_if<core::SceneId>(&root);
    if (!scene)
        return result;

    std::optional<std::size_t> root_slice;
    for (std::size_t slice_index = 0; slice_index < index.slices.size(); ++slice_index) {
        const auto* point = std::get_if<core::compiled::SceneEntryPredictionPoint>(
            &index.slices[slice_index].point);
        if (point && point->scene == *scene) {
            root_slice = slice_index;
            break;
        }
    }
    if (!root_slice)
        return result;

    std::deque<std::pair<std::size_t, std::size_t>> frontier;
    frontier.emplace_back(*root_slice, 0);
    std::unordered_set<std::size_t> visited;
    while (!frontier.empty()) {
        const auto [slice_index, distance] = frontier.front();
        frontier.pop_front();
        if (!visited.insert(slice_index).second)
            continue;
        if (slice_index >= index.slices.size()) {
            add_invalid_index(result.diagnostics, "slice", slice_index);
            continue;
        }

        const auto& slice = index.slices[slice_index];
        for (const std::size_t group_index : slice.dependency_groups) {
            if (group_index >= index.dependency_groups.size()) {
                add_invalid_index(result.diagnostics, "dependency-group", group_index);
                continue;
            }
            for (const auto& dependency : index.dependency_groups[group_index])
                result.entries.push_back(
                    {.dependency = dependency, .execution_distance = distance});
        }
        for (const std::size_t successor : slice.successors) {
            if (successor >= index.slices.size()) {
                add_invalid_index(result.diagnostics, "successor", successor);
                continue;
            }
            frontier.emplace_back(successor, distance + 1);
        }
    }
    return result;
}

} // namespace noveltea::runtime
