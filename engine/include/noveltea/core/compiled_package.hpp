#pragma once

#include "noveltea/core/compiled_project.hpp"
#include "noveltea/core/result.hpp"
#include "noveltea/render/material.hpp"

#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

#include <nlohmann/json_fwd.hpp>

namespace noveltea::core {

enum class RuntimePackageKind : std::uint8_t {
    Runtime,
    Editable
};

struct RuntimePackageEntry {
    std::string path;
    std::uint64_t size = 0;
    std::optional<std::string> checksum;
};

struct RuntimePackageProjectIdentity {
    std::string name;
    std::string version;
};

struct RuntimePackageDisplay {
    compiled::AspectRatio aspect_ratio;
    compiled::DisplayOrientation orientation;
    std::string bar_color;
};

struct RuntimePackageDesktopLaunch {
    std::uint32_t initial_width = 0;
    std::uint32_t initial_height = 0;
    std::vector<std::string> arguments;
};

struct RuntimePackageWebLaunch {
    compiled::DisplayOrientation orientation;
    std::string query;
};

struct RuntimePackageAndroidLaunch {
    compiled::DisplayOrientation orientation;
    std::string gradle_property;
    std::string screen_orientation;
};

struct RuntimePackagePlatformLaunch {
    compiled::DisplayOrientation orientation;
    RuntimePackageDesktopLaunch desktop;
    RuntimePackageWebLaunch web;
    RuntimePackageAndroidLaunch android;
};

struct RuntimePackageShaderMaterials {
    std::string entry;
    std::string schema;
    bool sources_stripped = true;
};

struct RuntimePackageManifest {
    RuntimePackageKind kind = RuntimePackageKind::Runtime;
    std::string created_by;
    RuntimePackageProjectIdentity project;
    std::optional<RuntimePackageDisplay> display;
    std::optional<RuntimePackagePlatformLaunch> platform;
    std::vector<std::string> shader_variants;
    std::optional<RuntimePackageShaderMaterials> shader_materials;
    std::vector<RuntimePackageEntry> entries;
};

// Archive readers calculate this inventory from actual package entries. The manifest decoder does
// not trust manifest sizes or checksums as evidence about archive contents.
struct RuntimePackageFile {
    std::string path;
    std::uint64_t size = 0;
    std::optional<std::string> checksum;
};

class LoadedCompiledPackage;

class PreparedResourceRegistries {
public:
    [[nodiscard]] const compiled::AssetResource* find_asset(const AssetId& id) const noexcept;
    [[nodiscard]] const compiled::LayoutResource* find_layout(const LayoutId& id) const noexcept;
    [[nodiscard]] const compiled::ScriptResource* find_script(const ScriptId& id) const noexcept;
    [[nodiscard]] const MaterialDefinition* find_material(const MaterialId& id) const noexcept;
    [[nodiscard]] const compiled::AssetResource*
    find_asset_by_alias(std::string_view alias) const noexcept;

private:
    friend class LoadedCompiledPackage;
    friend Result<LoadedCompiledPackage, Diagnostics>
        assemble_compiled_package(CompiledProject, RuntimePackageManifest,
                                  std::optional<ShaderMaterialProject>,
                                  std::vector<RuntimePackageFile>);
    std::unordered_map<AssetId, std::size_t> asset_indexes;
    std::unordered_map<LayoutId, std::size_t> layout_indexes;
    std::unordered_map<ScriptId, std::size_t> script_indexes;
    std::unordered_map<std::string, std::size_t> material_indexes;
    std::unordered_map<std::string, std::size_t> asset_aliases;
    const CompiledProject* project = nullptr;
    const ShaderMaterialProject* shader_materials = nullptr;
};

class LoadedCompiledPackage {
public:
    LoadedCompiledPackage() = delete;
    LoadedCompiledPackage(const LoadedCompiledPackage&) = delete;
    LoadedCompiledPackage& operator=(const LoadedCompiledPackage&) = delete;
    LoadedCompiledPackage(LoadedCompiledPackage&& other) noexcept;
    LoadedCompiledPackage& operator=(LoadedCompiledPackage&& other) noexcept;

    [[nodiscard]] const CompiledProject& project() const noexcept { return m_project; }
    [[nodiscard]] const RuntimePackageManifest& manifest() const noexcept { return m_manifest; }
    [[nodiscard]] const std::optional<ShaderMaterialProject>& shader_materials() const noexcept
    {
        return m_shader_materials;
    }
    [[nodiscard]] const PreparedResourceRegistries& resources() const noexcept
    {
        return m_resources;
    }

private:
    friend Result<LoadedCompiledPackage, Diagnostics>
        assemble_compiled_package(CompiledProject, RuntimePackageManifest,
                                  std::optional<ShaderMaterialProject>,
                                  std::vector<RuntimePackageFile>);
    LoadedCompiledPackage(CompiledProject project, RuntimePackageManifest manifest,
                          std::optional<ShaderMaterialProject> shader_materials,
                          PreparedResourceRegistries resources);
    void rebind_registries() noexcept;

    CompiledProject m_project;
    RuntimePackageManifest m_manifest;
    std::optional<ShaderMaterialProject> m_shader_materials;
    PreparedResourceRegistries m_resources;
};

[[nodiscard]] Result<RuntimePackageManifest, Diagnostics>
decode_runtime_package_manifest(const nlohmann::json& value,
                                std::string source_path = "manifest.json");

[[nodiscard]] Result<ShaderMaterialProject, Diagnostics>
decode_shader_material_manifest(const nlohmann::json& value,
                                std::string source_path = "shader-materials.json");

[[nodiscard]] Result<LoadedCompiledPackage, Diagnostics>
assemble_compiled_package(CompiledProject project, RuntimePackageManifest manifest,
                          std::optional<ShaderMaterialProject> shader_materials,
                          std::vector<RuntimePackageFile> files);

} // namespace noveltea::core
