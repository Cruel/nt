#pragma once

#include "noveltea/assets/asset_request_orchestrator.hpp"
#include "noveltea/assets/asset_source.hpp"
#include "noveltea/assets/resource_aliases.hpp"
#include "noveltea/assets/typed_assets.hpp"
#include "noveltea/runtime/runtime_ports.hpp"

#include <filesystem>
#include <map>
#include <optional>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

namespace noveltea::core {
class EditorAssetProfilerService;
}

namespace noveltea::assets {

class AssetProgressOrchestrator;
class MandatoryPublicationScope;

class StructuredAssetLeaseSet;

class AssetManager : public runtime::ScriptSourcePort {
public:
    using NamespaceMounts = std::vector<AssetSourcePtr>;

    AssetManager();
    ~AssetManager();

    AssetManager(const AssetManager&) = delete;
    AssetManager& operator=(const AssetManager&) = delete;
    AssetManager(AssetManager&&) noexcept;
    AssetManager& operator=(AssetManager&&) noexcept;

    void mount(std::string namespace_name, AssetSourcePtr source);
    void clear_namespace(std::string_view namespace_name);
    [[nodiscard]] NamespaceMounts replace_namespace(std::string namespace_name,
                                                    NamespaceMounts sources);
    void mount_directory(std::string namespace_name, std::filesystem::path root,
                         bool writable = false);

    [[nodiscard]] AssetResult<AssetReaderPtr> open(std::string_view logical_path) const;
    [[nodiscard]] AssetResult<AssetReaderFactory>
    reader_factory(std::string_view logical_path) const;
    [[nodiscard]] AssetResult<AssetEntryMetadata> stat(std::string_view logical_path) const;
    [[nodiscard]] AssetResult<AssetBlob> read_binary(std::string_view logical_path) const;
    [[nodiscard]] AssetResult<AssetText> read_text(std::string_view logical_path) const;
    [[nodiscard]] core::Result<std::string, runtime::ScriptSourceError>
    read_script_source(std::string_view logical_path) const override;

    void set_default_font_alias(std::string alias);
    void configure_fonts(FontAssetConfig config);
    [[nodiscard]] const FontAssetConfig& font_config() const noexcept;
    [[nodiscard]] const std::string& default_font_alias() const noexcept;
    void configure_resource_aliases(ResourceAliasRegistry aliases);
    [[nodiscard]] AssetLoadResult<ResourceAliasRegistry>
    load_resource_aliases(std::string_view logical_path);
    [[nodiscard]] const ResourceAliasRegistry& resource_aliases() const noexcept;
    void bind_font_loader(FontAssetLoader* loader) const;
    void bind_texture_loader(TextureAssetLoader* loader) const;
    void bind_hotspot_mask_loader(HotspotMaskAssetLoader* loader) const;
    void bind_shader_program_loader(ShaderProgramAssetLoader* loader) const;
    void bind_material_loader(MaterialAssetLoader* loader) const;
    void bind_audio_loader(AudioAssetLoader* loader) const;
    [[nodiscard]] std::optional<AudioAssetRequest>
    resolve_audio_alias(std::string_view alias) const;

    [[nodiscard]] core::DiagnosticResult<void>
    configure_async_requests(jobs::JobExecutor& executor,
                             std::shared_ptr<ResidencyManager> residency,
                             core::AssetTelemetrySink* telemetry = nullptr) noexcept;
    [[nodiscard]] AssetSourceGeneration source_generation_on_owner() const noexcept;
    [[nodiscard]] core::Result<AssetSourceGeneration, core::Diagnostic>
    refresh_namespace_on_owner(std::string_view namespace_name) noexcept;
    [[nodiscard]] core::Result<PrefetchGenerationId, core::Diagnostic>
    create_prefetch_generation_on_owner() const noexcept;
    [[nodiscard]] core::Result<AssetRequestHandle<FontAsset>, core::Diagnostic>
    request_font(const FontAssetRequest& request, AssetRequestReason reason) noexcept;
    [[nodiscard]] core::Result<AssetRequestHandle<TextureAsset>, core::Diagnostic>
    request_texture(const TextureAssetRequest& request, AssetRequestReason reason) noexcept;
    [[nodiscard]] core::Result<AssetRequestHandle<HotspotMaskAsset>, core::Diagnostic>
    request_hotspot_mask(const HotspotMaskAssetRequest& request,
                         AssetRequestReason reason) noexcept;
    [[nodiscard]] core::Result<AssetRequestHandle<ShaderProgramAsset>, core::Diagnostic>
    request_shader_program(const ShaderProgramAssetRequest& request,
                           AssetRequestReason reason) noexcept;
    [[nodiscard]] core::Result<AssetRequestHandle<MaterialAsset>, core::Diagnostic>
    request_material(const MaterialAssetRequest& request, AssetRequestReason reason) noexcept;
    [[nodiscard]] core::Result<AssetRequestHandle<AudioAsset>, core::Diagnostic>
    request_audio(const AudioAssetRequest& request, AssetRequestReason reason) noexcept;

    [[nodiscard]] core::Result<PrefetchTicket, core::Diagnostic>
    prefetch_font(const FontAssetRequest& request, PrefetchGenerationId generation) noexcept;
    [[nodiscard]] core::Result<PrefetchTicket, core::Diagnostic>
    prefetch_texture(const TextureAssetRequest& request, PrefetchGenerationId generation) noexcept;
    [[nodiscard]] core::Result<PrefetchTicket, core::Diagnostic>
    prefetch_hotspot_mask(const HotspotMaskAssetRequest& request,
                          PrefetchGenerationId generation) noexcept;
    [[nodiscard]] core::Result<PrefetchTicket, core::Diagnostic>
    prefetch_shader_program(const ShaderProgramAssetRequest& request,
                            PrefetchGenerationId generation) noexcept;
    [[nodiscard]] core::Result<PrefetchTicket, core::Diagnostic>
    prefetch_material(const MaterialAssetRequest& request,
                      PrefetchGenerationId generation) noexcept;
    [[nodiscard]] core::Result<PrefetchTicket, core::Diagnostic>
    prefetch_audio(const AudioAssetRequest& request, PrefetchGenerationId generation) noexcept;

    // Tooling-only demand assets are layered behind candidate/published runtime leases so
    // diagnostics and acceptance fixtures can exercise the same asynchronous preparation path
    // without replacing the runtime package's atomic publication set.
    void set_supplemental_leases_on_owner(StructuredAssetLeaseSet leases) noexcept;
    void clear_supplemental_leases_on_owner() noexcept;
    [[nodiscard]] bool has_candidate_leases_on_owner() const noexcept;
    [[nodiscard]] bool has_published_leases_on_owner() const noexcept;
    [[nodiscard]] bool has_previous_published_leases_on_owner() const noexcept;
    [[nodiscard]] bool has_supplemental_leases_on_owner() const noexcept;
    [[nodiscard]] bool has_focused_candidate_leases_on_owner() const noexcept;
    [[nodiscard]] bool has_focused_published_leases_on_owner() const noexcept;

    [[nodiscard]] const AssetLease<FontAsset>*
    leased_font_on_owner(const FontAssetRequest& request) const noexcept;
    [[nodiscard]] const AssetLease<TextureAsset>*
    leased_texture_on_owner(const TextureAssetRequest& request) const noexcept;
    [[nodiscard]] const AssetLease<HotspotMaskAsset>*
    leased_hotspot_mask_on_owner(const HotspotMaskAssetRequest& request) const noexcept;
    [[nodiscard]] const AssetLease<ShaderProgramAsset>*
    leased_shader_program_on_owner(const ShaderProgramAssetRequest& request) const noexcept;
    [[nodiscard]] const AssetLease<MaterialAsset>*
    leased_material_on_owner(const MaterialAssetRequest& request) const noexcept;
    [[nodiscard]] const AssetLease<AudioAsset>*
    leased_audio_on_owner(const AudioAssetRequest& request) const noexcept;
    [[nodiscard]] std::string
    describe_texture_lease_lookup_on_owner(const TextureAssetRequest& request) const;

    [[nodiscard]] bool exists(std::string_view logical_path) const;
    [[nodiscard]] bool has_namespace(std::string_view namespace_name) const;

    [[nodiscard]] std::vector<std::string> describe_mounts() const;

private:
    friend class AssetProgressOrchestrator;
    friend class MandatoryPublicationScope;
    // Raw publication slots are an implementation detail of MandatoryPublicationScope. Production
    // consumers must use publication transactions instead of staging/committing these slots
    // directly.
    void stage_candidate_leases_on_owner(StructuredAssetLeaseSet leases) noexcept;
    void commit_candidate_leases_on_owner() noexcept;
    void rollback_candidate_leases_on_owner() noexcept;
    void clear_previous_published_leases_on_owner() noexcept;
    void clear_published_leases_on_owner() noexcept;
    void stage_focused_candidate_leases_on_owner(StructuredAssetLeaseSet leases) noexcept;
    void commit_focused_candidate_leases_on_owner() noexcept;
    void rollback_focused_candidate_leases_on_owner() noexcept;
    void clear_focused_published_leases_on_owner() noexcept;
#if NOVELTEA_ENABLE_EDITOR_ASSET_PROFILER
    friend class core::EditorAssetProfilerService;
    friend class MandatoryAssetGate;
    friend class MandatoryAssetRequestGroup;

    [[nodiscard]] std::vector<core::AssetProfilerEntry> asset_profiler_inventory_on_owner() const;
    [[nodiscard]] std::pair<ResidencyAccountingSnapshot, ResidencyCost>
    asset_profiler_memory_on_owner() const;
    [[nodiscard]] core::AssetTelemetrySink* asset_profiler_sink_on_owner() const noexcept;
#endif

    struct AsyncState;
    struct LeaseState;

    [[nodiscard]] core::AssetTelemetrySink* telemetry_sink_on_owner() const noexcept;
    void record_lifecycle_telemetry_on_owner(core::AssetTelemetryEventKind kind,
                                             std::string_view diagnostic_code) const noexcept;
    [[nodiscard]] const std::vector<AssetSourcePtr>* sources_for(const AssetPath& path) const;
    [[nodiscard]] std::string namespace_for(const AssetPath& path) const;
    void bump_source_generation_on_owner() const noexcept;

    std::unordered_map<std::string, std::vector<AssetSourcePtr>> m_mounts;
    FontAssetConfig m_font_config{};
    ResourceAliasRegistry m_resource_aliases{};
    mutable FontAssetLoader* m_font_loader = nullptr;
    mutable TextureAssetLoader* m_texture_loader = nullptr;
    mutable HotspotMaskAssetLoader* m_hotspot_mask_loader = nullptr;
    mutable ShaderProgramAssetLoader* m_shader_program_loader = nullptr;
    mutable MaterialAssetLoader* m_material_loader = nullptr;
    mutable AudioAssetLoader* m_audio_loader = nullptr;
    mutable AssetSourceGeneration m_source_generation;
    std::shared_ptr<AsyncState> m_async;
    std::unique_ptr<LeaseState> m_leases;
    mutable std::map<AssetCacheKey, HotspotMaskAssetRequest> m_hotspot_mask_requests;
};

} // namespace noveltea::assets
