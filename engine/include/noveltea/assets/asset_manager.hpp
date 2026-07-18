#pragma once

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

namespace noveltea::assets {

class AssetManager : public runtime::ScriptSourcePort {
public:
    using NamespaceMounts = std::vector<AssetSourcePtr>;

    void mount(std::string namespace_name, AssetSourcePtr source);
    void clear_namespace(std::string_view namespace_name);
    [[nodiscard]] NamespaceMounts replace_namespace(std::string namespace_name,
                                                    NamespaceMounts sources);
    void mount_directory(std::string namespace_name, std::filesystem::path root,
                         bool writable = false);

    [[nodiscard]] AssetResult<AssetReaderPtr> open(std::string_view logical_path) const;
    [[nodiscard]] AssetResult<AssetBlob> read_binary(std::string_view logical_path) const;
    [[nodiscard]] AssetResult<AssetText> read_text(std::string_view logical_path) const;
    [[nodiscard]] core::Result<std::string, runtime::ScriptSourceError>
    read_script_source(std::string_view logical_path) const override;

    void set_default_font_alias(std::string alias);
    void configure_fonts(FontAssetConfig config);
    [[nodiscard]] const FontAssetConfig& font_config() const noexcept;
    [[nodiscard]] const std::string& default_font_alias() const noexcept;
    void configure_resource_aliases(ResourceAliasRegistry aliases);
    [[nodiscard]] AssetResult<ResourceAliasRegistry>
    load_resource_aliases(std::string_view logical_path);
    [[nodiscard]] const ResourceAliasRegistry& resource_aliases() const noexcept;
    void bind_font_loader(FontAssetLoader* loader) const;
    void bind_texture_loader(TextureAssetLoader* loader) const;
    void bind_shader_program_loader(ShaderProgramAssetLoader* loader) const;
    void bind_material_loader(MaterialAssetLoader* loader) const;
    void bind_audio_loader(AudioAssetLoader* loader) const;
    [[nodiscard]] AssetResult<FontAsset> load_font(const FontAssetRequest& request) const;
    [[nodiscard]] AssetResult<TextureAsset> load_texture(const TextureAssetRequest& request) const;
    [[nodiscard]] AssetResult<ShaderProgramAsset>
    load_shader_program(const ShaderProgramAssetRequest& request) const;
    [[nodiscard]] AssetResult<MaterialAsset>
    load_material(const MaterialAssetRequest& request) const;
    [[nodiscard]] AssetResult<TextureAsset> load_texture_alias(std::string_view alias) const;
    [[nodiscard]] AssetResult<MaterialAsset> load_material_alias(std::string_view alias) const;
    [[nodiscard]] AssetResult<AudioAsset> load_audio(const AudioAssetRequest& request) const;
    [[nodiscard]] AssetResult<AudioAsset> load_audio_alias(std::string_view alias) const;
    [[nodiscard]] std::optional<AudioAssetRequest>
    resolve_audio_alias(std::string_view alias) const;

    [[nodiscard]] bool exists(std::string_view logical_path) const;
    [[nodiscard]] bool has_namespace(std::string_view namespace_name) const;

    [[nodiscard]] std::vector<std::string> describe_mounts() const;

private:
    [[nodiscard]] const std::vector<AssetSourcePtr>* sources_for(const AssetPath& path) const;
    [[nodiscard]] std::string namespace_for(const AssetPath& path) const;

    std::unordered_map<std::string, std::vector<AssetSourcePtr>> m_mounts;
    FontAssetConfig m_font_config{};
    ResourceAliasRegistry m_resource_aliases{};
    mutable FontAssetLoader* m_font_loader = nullptr;
    mutable TextureAssetLoader* m_texture_loader = nullptr;
    mutable ShaderProgramAssetLoader* m_shader_program_loader = nullptr;
    mutable MaterialAssetLoader* m_material_loader = nullptr;
    mutable AudioAssetLoader* m_audio_loader = nullptr;
};

} // namespace noveltea::assets
