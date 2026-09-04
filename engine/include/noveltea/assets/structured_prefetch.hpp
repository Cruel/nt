#pragma once

#include "noveltea/assets/asset_request.hpp"
#include "noveltea/assets/asset_manager.hpp"
#include "noveltea/assets/typed_assets.hpp"
#include "noveltea/core/compiled_package.hpp"
#include "noveltea/core/diagnostic.hpp"
#include "noveltea/core/result.hpp"
#include "noveltea/core/runtime_presentation_contracts.hpp"
#include "noveltea/runtime/flow_prediction.hpp"

#include <cstddef>
#include <memory>
#include <optional>
#include <string_view>
#include <variant>
#include <vector>

namespace noveltea::assets {

enum class PrefetchPredictionKind : std::uint8_t {
    ExpectedNext,
    PossibleNext,
};

class AssetManager;
struct PrefetchPlan;

using StructuredAssetRequest =
    std::variant<FontAssetRequest, TextureAssetRequest, HotspotMaskAssetRequest,
                 ShaderProgramAssetRequest, MaterialAssetRequest, AudioAssetRequest>;

struct StructuredAssetRequestDescriptor {
    StructuredAssetRequest request;
    AssetCacheKey cache_key;
};

struct MandatoryAssetDependencyClosure {
    std::vector<StructuredAssetRequestDescriptor> requests;
    core::Diagnostics diagnostics;
};

struct MandatoryAssetDependencyContext {
    const core::RuntimePresentationSnapshot* current_presentation = nullptr;
    std::vector<core::compiled::SystemLayoutRole> required_system_layouts;
};

// Immutable lookup data over one loaded package and one renderer-selected shader variant. The
// loaded package must outlive every copy of this index and every collector created from it.
class StructuredAssetDependencyIndex {
public:
    struct Impl;

    [[nodiscard]] static StructuredAssetDependencyIndex
    build(const core::LoadedCompiledPackage& package, std::string_view active_renderer_variant,
          AssetSourceGeneration source_generation);

    StructuredAssetDependencyIndex(const StructuredAssetDependencyIndex&) noexcept = default;
    StructuredAssetDependencyIndex&
    operator=(const StructuredAssetDependencyIndex&) noexcept = default;
    StructuredAssetDependencyIndex(StructuredAssetDependencyIndex&&) noexcept = default;
    StructuredAssetDependencyIndex& operator=(StructuredAssetDependencyIndex&&) noexcept = default;

    [[nodiscard]] AssetSourceGeneration source_generation() const noexcept;
    [[nodiscard]] const core::Diagnostics& diagnostics() const noexcept;

private:
    explicit StructuredAssetDependencyIndex(std::shared_ptr<const Impl> impl) noexcept;

    std::shared_ptr<const Impl> m_impl;

    friend class MandatoryAssetDependencyCollector;
    friend PrefetchPlan resolve_flow_prediction(const StructuredAssetDependencyIndex&,
                                                const runtime::FlowPredictionProjection&);
};

class MandatoryAssetDependencyCollector {
public:
    explicit MandatoryAssetDependencyCollector(StructuredAssetDependencyIndex index) noexcept;

    [[nodiscard]] MandatoryAssetDependencyClosure
    collect(const MandatoryAssetDependencyContext& context) const;

private:
    StructuredAssetDependencyIndex m_index;
};

struct PrefetchSubmissionFailure {
    AssetCacheKey cache_key;
    PrefetchPredictionKind prediction = PrefetchPredictionKind::ExpectedNext;
    core::Diagnostic diagnostic;
};

struct PrefetchSubmissionEntry {
    AssetCacheKey cache_key;
    PrefetchPredictionKind prediction = PrefetchPredictionKind::ExpectedNext;
    std::vector<runtime::FlowPredictionProvenance> provenance;
};

struct PrefetchAdmissionRejection {
    AssetCacheKey cache_key;
    PrefetchPredictionKind prediction = PrefetchPredictionKind::ExpectedNext;
    ResidencyCost estimated_cost;
    std::vector<runtime::FlowPredictionProvenance> provenance;
    core::Diagnostic diagnostic;
};

enum class PrefetchCostEstimateKind : std::uint8_t {
    Metadata,
    Conservative,
};

struct PrefetchCandidate {
    StructuredAssetRequestDescriptor descriptor;
    PrefetchPredictionKind prediction = PrefetchPredictionKind::ExpectedNext;
    std::size_t execution_distance = 0;
    std::size_t execution_order = 0;
    std::size_t dependency_priority = 0;
    ResidencyCost estimated_cost;
    PrefetchCostEstimateKind cost_estimate = PrefetchCostEstimateKind::Conservative;
    std::vector<runtime::FlowPredictionProvenance> provenance;
};

struct PrefetchSubmissionReport {
    PrefetchGenerationId generation;
    std::size_t expected_submitted = 0;
    std::size_t possible_submitted = 0;
    std::size_t expected_retained = 0;
    std::size_t possible_retained = 0;
    std::size_t expected_count = 0;
    std::size_t possible_count = 0;
    std::vector<PrefetchSubmissionEntry> submitted_entries;
    std::vector<PrefetchSubmissionEntry> retained_entries;
    std::vector<AssetCacheKey> submitted_keys;
    std::vector<PrefetchSubmissionFailure> failures;
    std::vector<PrefetchAdmissionRejection> admission_rejections;
#if NOVELTEA_ENABLE_EDITOR_ASSET_PROFILER
    // Exact normalized ranking consumed by the planner for this logical generation. Tooling may
    // inspect this read-only projection, but it is not an authoring or persistence contract.
    std::vector<PrefetchCandidate> ranked_candidates;
    std::vector<runtime::FlowPredictionOpaqueFrontier> opaque_frontiers;
#endif
    bool budget_exhausted = false;
    bool structural_limit_reached = false;
};

struct PrefetchPlan {
    std::vector<PrefetchCandidate> candidates;
#if NOVELTEA_ENABLE_EDITOR_ASSET_PROFILER
    std::vector<runtime::FlowPredictionOpaqueFrontier> opaque_frontiers;
#endif
    core::Diagnostics diagnostics;
    bool structural_limit_reached = false;
};

[[nodiscard]] PrefetchPlan
resolve_flow_prediction(const StructuredAssetDependencyIndex& index,
                        const runtime::FlowPredictionProjection& projection);

// Compares the normalized planner-visible meaning of two plans. This is intentionally narrower
// than persistence/wire equality: callers use it to avoid replacing a logical prediction
// generation when a re-evaluated root produces the same ranked speculative work.
[[nodiscard]] bool equivalent_prefetch_plans(const PrefetchPlan& left,
                                             const PrefetchPlan& right) noexcept;

class PrefetchPlanner {
public:
    explicit PrefetchPlanner(AssetManager& assets) noexcept;
    ~PrefetchPlanner();

    PrefetchPlanner(const PrefetchPlanner&) = delete;
    PrefetchPlanner& operator=(const PrefetchPlanner&) = delete;
    PrefetchPlanner(PrefetchPlanner&&) noexcept;
    PrefetchPlanner& operator=(PrefetchPlanner&&) noexcept;

    [[nodiscard]] core::Result<PrefetchSubmissionReport, core::Diagnostic>
    replace_generation_on_owner(const PrefetchPlan& plan) noexcept;

    // Read-only admission preview used to decide whether expanding a truncated Flow prediction
    // wave could still produce useful Warm work. It never creates generations or requests.
    [[nodiscard]] bool would_exhaust_warm_budget_on_owner(const PrefetchPlan& plan) const noexcept;

    void clear_on_owner() noexcept;
    [[nodiscard]] std::optional<PrefetchGenerationId> active_generation_on_owner() const noexcept;
    [[nodiscard]] std::size_t retained_ticket_count_on_owner() const noexcept;

private:
    struct Impl;
    std::unique_ptr<Impl> m_impl;
};

} // namespace noveltea::assets
