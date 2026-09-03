#pragma once

#include "noveltea/core/compiled_project.hpp"
#include "noveltea/core/diagnostic.hpp"
#include "noveltea/core/flow.hpp"

#include <cstddef>
#include <optional>
#include <vector>

namespace noveltea::runtime {

enum class FlowPredictionConfidence : std::uint8_t {
    Expected,
    Alternative,
};

struct FlowPredictionProvenance {
    // Semantic execution points traversed to reach the dependency. Keep this projection in domain
    // terms rather than leaking generated slice indexes to runtime/tooling consumers.
    std::vector<core::compiled::FlowPredictionPoint> points;

    bool operator==(const FlowPredictionProvenance&) const = default;
};

struct FlowPredictionProjectionEntry {
    core::compiled::FlowPredictionDependency dependency;
    std::size_t execution_distance = 0;
    FlowPredictionConfidence confidence = FlowPredictionConfidence::Expected;
    // Dependencies emitted by one execution slice share an order. This preserves semantic slice
    // order while still allowing the planner to sub-rank dependencies within that slice.
    std::size_t execution_order = 0;
    std::size_t dependency_priority = 0;
    FlowPredictionProvenance provenance;
};

// Read-only tooling/runtime view over one prediction root. It intentionally exposes semantic
// dependencies and distance, not the generated index's serialized storage representation.
struct FlowPredictionProjection {
    std::vector<FlowPredictionProjectionEntry> entries;
    core::Diagnostics diagnostics;
};

struct FlowPredictionGlobalProperty {
    core::PropertyId property;
    core::RuntimeValue value;
};

// Deliberately narrow authoritative state supplied to speculative prediction. This is not a
// Runtime Session clone and grows only when prediction-relevant typed facts need admission.
struct FlowPredictionContext {
    std::vector<FlowPredictionGlobalProperty> global_properties;
};

struct ProspectiveRoomEntryPredictionRoot {
    std::optional<core::RoomId> source_room;
    core::RoomId target_room;
};

struct ActiveScenePredictionRoot {
    core::SceneId scene;
    core::SceneFramePosition position;
};

struct ActiveDialoguePredictionRoot {
    core::DialogueId dialogue;
    core::DialogueFramePosition position;
};

class FlowPredictor {
public:
    explicit FlowPredictor(const core::CompiledProject& project) noexcept : m_project(&project) {}

    [[nodiscard]] FlowPredictionProjection predict(const core::compiled::Entrypoint& root) const;
    [[nodiscard]] FlowPredictionProjection predict(const core::compiled::Entrypoint& root,
                                                   const FlowPredictionContext& context) const;
    [[nodiscard]] FlowPredictionProjection
    predict(const ProspectiveRoomEntryPredictionRoot& root) const;
    [[nodiscard]] FlowPredictionProjection predict(const ProspectiveRoomEntryPredictionRoot& root,
                                                   const FlowPredictionContext& context) const;
    [[nodiscard]] FlowPredictionProjection predict(const ActiveScenePredictionRoot& root) const;
    [[nodiscard]] FlowPredictionProjection predict(const ActiveScenePredictionRoot& root,
                                                   const FlowPredictionContext& context) const;
    [[nodiscard]] FlowPredictionProjection predict(const ActiveDialoguePredictionRoot& root) const;
    [[nodiscard]] FlowPredictionProjection predict(const ActiveDialoguePredictionRoot& root,
                                                   const FlowPredictionContext& context) const;

private:
    const core::CompiledProject* m_project;
};

} // namespace noveltea::runtime
