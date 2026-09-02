#pragma once

#include "noveltea/core/compiled_project.hpp"
#include "noveltea/core/diagnostic.hpp"

#include <cstddef>
#include <vector>

namespace noveltea::runtime {

struct FlowPredictionProjectionEntry {
    core::compiled::FlowPredictionDependency dependency;
    std::size_t execution_distance = 0;
};

// Read-only tooling/runtime view over one prediction root. It intentionally exposes semantic
// dependencies and distance, not the generated index's serialized storage representation.
struct FlowPredictionProjection {
    std::vector<FlowPredictionProjectionEntry> entries;
    core::Diagnostics diagnostics;
};

class FlowPredictor {
public:
    explicit FlowPredictor(const core::CompiledProject& project) noexcept : m_project(&project) {}

    [[nodiscard]] FlowPredictionProjection predict(const core::compiled::Entrypoint& root) const;

private:
    const core::CompiledProject* m_project;
};

} // namespace noveltea::runtime
