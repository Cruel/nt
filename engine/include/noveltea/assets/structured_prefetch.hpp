#pragma once

#include "noveltea/assets/asset_request.hpp"
#include "noveltea/assets/typed_assets.hpp"
#include "noveltea/core/compiled_package.hpp"
#include "noveltea/core/diagnostic.hpp"
#include "noveltea/core/result.hpp"
#include "noveltea/core/runtime_presentation_contracts.hpp"

#include <cstddef>
#include <memory>
#include <optional>
#include <string_view>
#include <variant>
#include <vector>

namespace noveltea::assets {

class AssetManager;

using StructuredAssetRequest =
    std::variant<FontAssetRequest, TextureAssetRequest, ShaderProgramAssetRequest,
                 MaterialAssetRequest, AudioAssetRequest>;

struct StructuredAssetRequestDescriptor {
    StructuredAssetRequest request;
    AssetCacheKey cache_key;
};

struct StructuredAssetDependencyBuckets {
    std::vector<StructuredAssetRequestDescriptor> current_mandatory;
    std::vector<StructuredAssetRequestDescriptor> direct_next;
    std::vector<StructuredAssetRequestDescriptor> adjacent_alternatives;
    core::Diagnostics diagnostics;
};

struct StructuredAssetDependencyContext {
    const core::RuntimePresentationSnapshot* current_presentation = nullptr;
    std::optional<core::compiled::Entrypoint> direct_next;
    std::vector<core::compiled::Entrypoint> adjacent_alternatives;
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

    friend class StructuredAssetDependencyCollector;
};

class StructuredAssetDependencyCollector {
public:
    explicit StructuredAssetDependencyCollector(StructuredAssetDependencyIndex index) noexcept;

    [[nodiscard]] StructuredAssetDependencyBuckets
    collect(const StructuredAssetDependencyContext& context) const;

private:
    StructuredAssetDependencyIndex m_index;
};

struct PrefetchSubmissionFailure {
    AssetCacheKey cache_key;
    core::Diagnostic diagnostic;
};

struct PrefetchSubmissionReport {
    PrefetchGenerationId generation;
    std::size_t direct_next_submitted = 0;
    std::size_t adjacent_submitted = 0;
    std::vector<AssetCacheKey> submitted_keys;
    std::vector<PrefetchSubmissionFailure> failures;
};

class PrefetchPlanner {
public:
    explicit PrefetchPlanner(AssetManager& assets) noexcept;
    ~PrefetchPlanner();

    PrefetchPlanner(const PrefetchPlanner&) = delete;
    PrefetchPlanner& operator=(const PrefetchPlanner&) = delete;
    PrefetchPlanner(PrefetchPlanner&&) noexcept;
    PrefetchPlanner& operator=(PrefetchPlanner&&) noexcept;

    [[nodiscard]] core::Result<PrefetchSubmissionReport, core::Diagnostic>
    replace_generation_on_owner(const StructuredAssetDependencyBuckets& dependencies) noexcept;

    void clear_on_owner() noexcept;
    [[nodiscard]] std::optional<PrefetchGenerationId> active_generation_on_owner() const noexcept;
    [[nodiscard]] std::size_t retained_ticket_count_on_owner() const noexcept;

private:
    struct Impl;
    std::unique_ptr<Impl> m_impl;
};

} // namespace noveltea::assets
