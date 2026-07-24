#pragma once

#include "noveltea/assets/asset_request_orchestrator.hpp"
#include "noveltea/assets/asset_source.hpp"
#include "noveltea/assets/resource_aliases.hpp"
#include "noveltea/assets/typed_assets.hpp"
#include "noveltea/runtime/runtime_ports.hpp"

#include <filesystem>
#include <optional>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

namespace noveltea::core {
class EditorAssetProfilerService;
}

namespace noveltea::assets {

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
    [[nodiscard]] core::Result<PrefetchGenerationId, core::Diagnostic>
    create_prefetch_generation_on_owner() const noexcept;
    [[nodiscard]] std::size_t retry_deferred_asset_requests_on_owner() noexcept;
    [[nodiscard]] core::Result<AssetRequestHandle<FontAsset>, core::Diagnostic>
    request_font(const FontAssetRequest& request, AssetRequestReason reason) noexcept;
    [[nodiscard]] core::Result<AssetRequestHandle<TextureAsset>, core::Diagnostic>
    request_texture(const TextureAssetRequest& request, AssetRequestReason reason) noexcept;
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
    prefetch_shader_program(const ShaderProgramAssetRequest& request,
                            PrefetchGenerationId generation) noexcept;
    [[nodiscard]] core::Result<PrefetchTicket, core::Diagnostic>
    prefetch_material(const MaterialAssetRequest& request,
                      PrefetchGenerationId generation) noexcept;
    [[nodiscard]] core::Result<PrefetchTicket, core::Diagnostic>
    prefetch_audio(const AudioAssetRequest& request, PrefetchGenerationId generation) noexcept;

    // Mandatory publication candidates are visible to typed consumers only while the owner thread
    // realizes that candidate. Commit atomically replaces the published lease set; rollback leaves
    // the previous publication pinned and releases candidate-only leases.
    void stage_candidate_leases_on_owner(StructuredAssetLeaseSet leases) noexcept;
    void commit_candidate_leases_on_owner() noexcept;
    void rollback_candidate_leases_on_owner() noexcept;
    void clear_published_leases_on_owner() noexcept;
    // Tooling-only demand assets are layered behind candidate/published runtime leases so
    // diagnostics and acceptance fixtures can exercise the same asynchronous preparation path
    // without replacing the runtime package's atomic publication set.
    void set_supplemental_leases_on_owner(StructuredAssetLeaseSet leases) noexcept;
    void clear_supplemental_leases_on_owner() noexcept;
    [[nodiscard]] bool has_candidate_leases_on_owner() const noexcept;
    [[nodiscard]] bool has_published_leases_on_owner() const noexcept;
    [[nodiscard]] bool has_supplemental_leases_on_owner() const noexcept;

    [[nodiscard]] const AssetLease<FontAsset>*
    leased_font_on_owner(const FontAssetRequest& request) const noexcept;
    [[nodiscard]] const AssetLease<TextureAsset>*
    leased_texture_on_owner(const TextureAssetRequest& request) const noexcept;
    [[nodiscard]] const AssetLease<ShaderProgramAsset>*
    leased_shader_program_on_owner(const ShaderProgramAssetRequest& request) const noexcept;
    [[nodiscard]] const AssetLease<MaterialAsset>*
    leased_material_on_owner(const MaterialAssetRequest& request) const noexcept;
    [[nodiscard]] const AssetLease<AudioAsset>*
    leased_audio_on_owner(const AudioAssetRequest& request) const noexcept;

    [[nodiscard]] bool exists(std::string_view logical_path) const;
    [[nodiscard]] bool has_namespace(std::string_view namespace_name) const;

    [[nodiscard]] std::vector<std::string> describe_mounts() const;

private:
#if NOVELTEA_ENABLE_EDITOR_ASSET_PROFILER
    friend class core::EditorAssetProfilerService;

    [[nodiscard]] std::vector<core::AssetProfilerEntry> asset_profiler_inventory_on_owner() const;
    [[nodiscard]] std::pair<ResidencyAccountingSnapshot, ResidencyCost>
    asset_profiler_memory_on_owner() const;
#endif

    struct AsyncState;
    struct LeaseState;

    [[nodiscard]] const std::vector<AssetSourcePtr>* sources_for(const AssetPath& path) const;
    [[nodiscard]] std::string namespace_for(const AssetPath& path) const;
    void bump_source_generation_on_owner() const noexcept;

    std::unordered_map<std::string, std::vector<AssetSourcePtr>> m_mounts;
    FontAssetConfig m_font_config{};
    ResourceAliasRegistry m_resource_aliases{};
    mutable FontAssetLoader* m_font_loader = nullptr;
    mutable TextureAssetLoader* m_texture_loader = nullptr;
    mutable ShaderProgramAssetLoader* m_shader_program_loader = nullptr;
    mutable MaterialAssetLoader* m_material_loader = nullptr;
    mutable AudioAssetLoader* m_audio_loader = nullptr;
    mutable AssetSourceGeneration m_source_generation;
    std::shared_ptr<AsyncState> m_async;
    std::unique_ptr<LeaseState> m_leases;
};

} // namespace noveltea::assets
