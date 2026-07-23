#pragma once

#include "noveltea/assets/structured_prefetch.hpp"
#include "noveltea/core/loading_progress.hpp"
#include "noveltea/core/runtime_messages.hpp"

#include <chrono>
#include <cstddef>
#include <memory>
#include <optional>
#include <variant>
#include <vector>

namespace noveltea::assets {

using StructuredAssetLease =
    std::variant<AssetLease<FontAsset>, AssetLease<TextureAsset>, AssetLease<ShaderProgramAsset>,
                 AssetLease<MaterialAsset>, AssetLease<AudioAsset>>;

struct StructuredAssetLeaseRecord {
    StructuredAssetRequestDescriptor descriptor;
    StructuredAssetLease lease;
};

class StructuredAssetLeaseSet {
public:
    StructuredAssetLeaseSet() = default;
    explicit StructuredAssetLeaseSet(std::vector<StructuredAssetLeaseRecord> records) noexcept;

    StructuredAssetLeaseSet(const StructuredAssetLeaseSet&) = delete;
    StructuredAssetLeaseSet& operator=(const StructuredAssetLeaseSet&) = delete;
    StructuredAssetLeaseSet(StructuredAssetLeaseSet&&) noexcept = default;
    StructuredAssetLeaseSet& operator=(StructuredAssetLeaseSet&&) noexcept = default;

    [[nodiscard]] std::size_t size() const noexcept;
    [[nodiscard]] bool empty() const noexcept;

    [[nodiscard]] const AssetLease<FontAsset>* find_font(const AssetCacheKey& key) const noexcept;
    [[nodiscard]] const AssetLease<TextureAsset>*
    find_texture(const AssetCacheKey& key) const noexcept;
    [[nodiscard]] const AssetLease<ShaderProgramAsset>*
    find_shader_program(const AssetCacheKey& key) const noexcept;
    [[nodiscard]] const AssetLease<MaterialAsset>*
    find_material(const AssetCacheKey& key) const noexcept;
    [[nodiscard]] const AssetLease<AudioAsset>* find_audio(const AssetCacheKey& key) const noexcept;

private:
    std::vector<StructuredAssetLeaseRecord> m_records;
};

enum class MandatoryAssetGroupState : std::uint8_t {
    Pending,
    Ready,
    Failed,
    Canceled,
};

struct MandatoryAssetGroupOptions {
    core::LoadingPhase phase = core::LoadingPhase::LoadingRuntimeDemand;
    AssetRequestReason reason = AssetRequestReason::Demand;
    std::chrono::milliseconds overlay_grace{100};
    bool show_overlay_immediately = false;
    bool retryable = true;
};

class MandatoryAssetRequestGroup {
public:
    using Clock = std::chrono::steady_clock;

    MandatoryAssetRequestGroup(AssetManager& assets,
                               std::vector<StructuredAssetRequestDescriptor> requests,
                               MandatoryAssetGroupOptions options = {},
                               Clock::time_point started_at = Clock::now()) noexcept;
    ~MandatoryAssetRequestGroup();

    MandatoryAssetRequestGroup(const MandatoryAssetRequestGroup&) = delete;
    MandatoryAssetRequestGroup& operator=(const MandatoryAssetRequestGroup&) = delete;
    MandatoryAssetRequestGroup(MandatoryAssetRequestGroup&&) noexcept;
    MandatoryAssetRequestGroup& operator=(MandatoryAssetRequestGroup&&) noexcept;

    void poll_on_owner(Clock::time_point now = Clock::now()) noexcept;
    [[nodiscard]] bool retry_on_owner(Clock::time_point now = Clock::now()) noexcept;
    void cancel_on_owner() noexcept;
    void show_overlay_immediately_on_owner() noexcept;

    [[nodiscard]] MandatoryAssetGroupState state_on_owner() const noexcept;
    [[nodiscard]] const core::LoadingProgress& progress_on_owner() const noexcept;
    [[nodiscard]] bool
    overlay_visible_on_owner(Clock::time_point now = Clock::now()) const noexcept;
    [[nodiscard]] std::optional<StructuredAssetLeaseSet> take_ready_leases_on_owner() noexcept;

private:
    struct Impl;
    std::unique_ptr<Impl> m_impl;
};

enum class MandatoryAssetGateDisposition : std::uint8_t {
    Ready,
    Pending,
    Failed,
    Canceled,
};

struct MandatoryAssetGateResult {
    MandatoryAssetGateDisposition disposition = MandatoryAssetGateDisposition::Ready;
    core::Diagnostics diagnostics;
};

// Owner-thread controller for one loaded package. It collects current mandatory dependencies,
// retains their typed request handles until every request is Ready, stages the resulting leases
// for atomic backend realization, and rotates speculative prefetch generations only after commit.
class MandatoryAssetGate {
public:
    explicit MandatoryAssetGate(AssetManager& assets) noexcept;
    ~MandatoryAssetGate();

    MandatoryAssetGate(const MandatoryAssetGate&) = delete;
    MandatoryAssetGate& operator=(const MandatoryAssetGate&) = delete;
    MandatoryAssetGate(MandatoryAssetGate&&) noexcept;
    MandatoryAssetGate& operator=(MandatoryAssetGate&&) noexcept;

    void bind_package_on_owner(const core::LoadedCompiledPackage& package,
                               std::string_view active_renderer_variant,
                               AssetSourceGeneration generation);
    void clear_package_on_owner() noexcept;

    [[nodiscard]] MandatoryAssetGateResult
    begin_on_owner(const core::RuntimePresentationSnapshot& snapshot,
                   MandatoryAssetRequestGroup::Clock::time_point now =
                       MandatoryAssetRequestGroup::Clock::now()) noexcept;
    [[nodiscard]] MandatoryAssetGateResult
    poll_on_owner(MandatoryAssetRequestGroup::Clock::time_point now =
                      MandatoryAssetRequestGroup::Clock::now()) noexcept;
    [[nodiscard]] core::Result<void, core::Diagnostics>
    include_audio_operation_on_owner(const core::AudioOperation& operation,
                                     MandatoryAssetRequestGroup::Clock::time_point now =
                                         MandatoryAssetRequestGroup::Clock::now()) noexcept;
    [[nodiscard]] bool activate_candidate_on_owner() noexcept;
    void commit_candidate_on_owner() noexcept;
    void rollback_candidate_on_owner() noexcept;
    [[nodiscard]] bool retry_on_owner(MandatoryAssetRequestGroup::Clock::time_point now =
                                          MandatoryAssetRequestGroup::Clock::now()) noexcept;
    void cancel_on_owner() noexcept;
    void show_overlay_immediately_on_owner() noexcept;

    [[nodiscard]] bool active_on_owner() const noexcept;
    [[nodiscard]] bool failed_on_owner() const noexcept;
    [[nodiscard]] bool
    overlay_visible_on_owner(MandatoryAssetRequestGroup::Clock::time_point now =
                                 MandatoryAssetRequestGroup::Clock::now()) const noexcept;
    [[nodiscard]] const core::LoadingProgress* progress_on_owner() const noexcept;
    [[nodiscard]] std::optional<PrefetchGenerationId>
    active_prefetch_generation_on_owner() const noexcept;

private:
    struct Impl;
    std::unique_ptr<Impl> m_impl;
};

} // namespace noveltea::assets
