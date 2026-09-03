#pragma once

#include "noveltea/assets/structured_prefetch.hpp"
#include "noveltea/core/loading_progress.hpp"
#include "noveltea/core/runtime_messages.hpp"

#include <chrono>
#include <cstddef>
#include <memory>
#include <optional>
#include <string>
#include <variant>
#include <vector>

namespace noveltea::runtime {
struct ActiveScenePredictionRoot;
struct ActiveDialoguePredictionRoot;
} // namespace noveltea::runtime

namespace noveltea::assets {

using StructuredAssetLease =
    std::variant<AssetLease<FontAsset>, AssetLease<TextureAsset>, AssetLease<HotspotMaskAsset>,
                 AssetLease<ShaderProgramAsset>, AssetLease<MaterialAsset>, AssetLease<AudioAsset>>;

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
    [[nodiscard]] const AssetLease<FontAsset>*
    find_font_by_identity(std::string_view stable_identity) const noexcept;
    [[nodiscard]] const AssetLease<TextureAsset>*
    find_texture(const AssetCacheKey& key) const noexcept;
    [[nodiscard]] const AssetLease<TextureAsset>*
    find_texture_by_identity(std::string_view stable_identity) const noexcept;
    [[nodiscard]] const AssetLease<HotspotMaskAsset>*
    find_hotspot_mask(const AssetCacheKey& key) const noexcept;
    [[nodiscard]] const AssetLease<HotspotMaskAsset>*
    find_hotspot_mask_by_identity(std::string_view stable_identity) const noexcept;
    [[nodiscard]] const AssetLease<ShaderProgramAsset>*
    find_shader_program(const AssetCacheKey& key) const noexcept;
    [[nodiscard]] const AssetLease<ShaderProgramAsset>*
    find_shader_program_by_identity(std::string_view stable_identity) const noexcept;
    [[nodiscard]] const AssetLease<MaterialAsset>*
    find_material(const AssetCacheKey& key) const noexcept;
    [[nodiscard]] const AssetLease<MaterialAsset>*
    find_material_by_identity(std::string_view stable_identity) const noexcept;
    [[nodiscard]] const AssetLease<AudioAsset>* find_audio(const AssetCacheKey& key) const noexcept;
    [[nodiscard]] const AssetLease<AudioAsset>*
    find_audio_by_identity(std::string_view stable_identity) const noexcept;
    [[nodiscard]] std::string describe_texture_keys() const;

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
    std::optional<core::PresentationSnapshotRevision> presentation_revision;
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

enum class MandatoryPublicationScopeKind : std::uint8_t {
    Runtime,
    FocusedPreview,
};

class MandatoryPublicationScope;
class MandatoryAssetGate;

class MandatoryPublicationTransaction {
public:
    MandatoryPublicationTransaction() = default;
    ~MandatoryPublicationTransaction();

    MandatoryPublicationTransaction(const MandatoryPublicationTransaction&) = delete;
    MandatoryPublicationTransaction& operator=(const MandatoryPublicationTransaction&) = delete;
    MandatoryPublicationTransaction(MandatoryPublicationTransaction&&) noexcept;
    MandatoryPublicationTransaction& operator=(MandatoryPublicationTransaction&&) noexcept;

    [[nodiscard]] core::DiagnosticResult<void>
    commit_on_owner(bool retain_predecessor = false) noexcept;
    void rollback_on_owner() noexcept;
    [[nodiscard]] bool active_on_owner() const noexcept;

private:
    friend class MandatoryPublicationScope;
    MandatoryPublicationTransaction(MandatoryPublicationScope& scope,
                                    AssetSourceGeneration source_generation) noexcept;

    MandatoryPublicationScope* m_scope = nullptr;
    AssetSourceGeneration m_source_generation{};
};

// Independent owner-thread lease-publication scope. A ready candidate is staged only through a
// move-only transaction; abandoning that transaction rolls the candidate back automatically.
class MandatoryPublicationScope {
public:
    MandatoryPublicationScope(AssetManager& assets, MandatoryPublicationScopeKind kind) noexcept;
    ~MandatoryPublicationScope();

    MandatoryPublicationScope(const MandatoryPublicationScope&) = delete;
    MandatoryPublicationScope& operator=(const MandatoryPublicationScope&) = delete;

    [[nodiscard]] MandatoryPublicationTransaction
    begin_transaction_on_owner(StructuredAssetLeaseSet leases,
                               AssetSourceGeneration source_generation) noexcept;
    void release_predecessor_on_owner() noexcept;
    void clear_on_owner() noexcept;

private:
    friend class MandatoryPublicationTransaction;
    friend class MandatoryAssetGate;
    [[nodiscard]] core::DiagnosticResult<void>
    commit_candidate_on_owner(AssetSourceGeneration source_generation,
                              bool retain_predecessor) noexcept;
    void rollback_candidate_on_owner() noexcept;

    AssetManager& m_assets;
    MandatoryPublicationScopeKind m_kind;
    bool m_candidate_active = false;
};

class RuntimeMandatoryPublicationTransaction {
public:
    RuntimeMandatoryPublicationTransaction() = default;
    ~RuntimeMandatoryPublicationTransaction();
    RuntimeMandatoryPublicationTransaction(const RuntimeMandatoryPublicationTransaction&) = delete;
    RuntimeMandatoryPublicationTransaction&
    operator=(const RuntimeMandatoryPublicationTransaction&) = delete;
    RuntimeMandatoryPublicationTransaction(RuntimeMandatoryPublicationTransaction&&) noexcept;
    RuntimeMandatoryPublicationTransaction&
    operator=(RuntimeMandatoryPublicationTransaction&&) noexcept;

    [[nodiscard]] core::DiagnosticResult<void> commit_on_owner(bool retain_predecessor) noexcept;
    void rollback_on_owner() noexcept;

private:
    friend class MandatoryAssetGate;
    RuntimeMandatoryPublicationTransaction(MandatoryAssetGate& gate,
                                           MandatoryPublicationTransaction transaction) noexcept;
    MandatoryAssetGate* m_gate = nullptr;
    std::optional<MandatoryPublicationTransaction> m_transaction;
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

    [[nodiscard]] core::DiagnosticResult<void>
    bind_package_on_owner(const core::LoadedCompiledPackage& package,
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
    [[nodiscard]] core::Diagnostics update_active_scene_prediction_on_owner(
        const runtime::ActiveScenePredictionRoot* root) noexcept;
    [[nodiscard]] core::Diagnostics update_active_dialogue_prediction_on_owner(
        const runtime::ActiveDialoguePredictionRoot* root) noexcept;
    [[nodiscard]] std::optional<RuntimeMandatoryPublicationTransaction>
    take_ready_transaction_on_owner() noexcept;
    void release_previous_publication_on_owner() noexcept;
    void rollback_candidate_on_owner() noexcept;
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
    friend class RuntimeMandatoryPublicationTransaction;
    void commit_ready_transaction_on_owner() noexcept;
    void abandon_ready_transaction_on_owner() noexcept;
    struct Impl;
    std::unique_ptr<Impl> m_impl;
};

} // namespace noveltea::assets
