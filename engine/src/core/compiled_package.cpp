#include "noveltea/core/compiled_package.hpp"

#include "noveltea/core/package_export.hpp"
#include "noveltea/render/shader_manifest.hpp"

#include <algorithm>
#include <optional>
#include <string>
#include <string_view>
#include <unordered_map>
#include <unordered_set>
#include <utility>

namespace noveltea::core {
namespace {

std::string normalized_package_path(std::string_view path)
{
    constexpr std::string_view prefix = "project:/";
    return path.starts_with(prefix) ? std::string(path.substr(prefix.size())) : std::string(path);
}

void add_assembly_error(Diagnostics& diagnostics, std::string code, std::string message,
                        std::string pointer)
{
    diagnostics.push_back(Diagnostic{.code = std::move(code),
                                     .message = std::move(message),
                                     .severity = ErrorSeverity::Error,
                                     .source_path = "manifest.json",
                                     .json_pointer = std::move(pointer)});
}

template<class Id, class Collection>
void index_collection(std::unordered_map<Id, std::size_t>& indexes, const Collection& collection,
                      auto&& id)
{
    for (std::size_t index = 0; index < collection.size(); ++index)
        indexes.emplace(id(collection[index]), index);
}

void collect_material_ids(const CompiledProject& project, std::unordered_set<std::string>& ids)
{
    const auto add = [&](const std::optional<MaterialId>& material) {
        if (material)
            ids.insert(material->text());
    };
    for (const auto& layout : project.layouts())
        for (const auto& material : layout.dependencies.materials)
            ids.insert(material.text());
    for (const auto& character : project.characters()) {
        for (const auto& pose : character.poses)
            add(pose.material);
        for (const auto& expression : character.expressions)
            add(expression.material);
    }
    for (const auto& room : project.rooms())
        add(room.background.material);
    for (const auto& interactable : project.interactables())
        add(interactable.presentation.material);
    for (const auto& scene : project.scenes()) {
        add(scene.default_background.material);
        for (const auto& instruction : scene.program.instructions) {
            if (const auto* background =
                    std::get_if<compiled::SetBackgroundInstruction>(&instruction))
                add(background->background.material);
        }
    }
}

} // namespace

const compiled::AssetResource*
PreparedResourceRegistries::find_asset(const AssetId& id) const noexcept
{
    if (!project)
        return nullptr;
    const auto found = asset_indexes.find(id);
    return found == asset_indexes.end() || found->second >= project->assets().size()
               ? nullptr
               : &project->assets()[found->second];
}

const compiled::LayoutResource*
PreparedResourceRegistries::find_layout(const LayoutId& id) const noexcept
{
    if (!project)
        return nullptr;
    const auto found = layout_indexes.find(id);
    return found == layout_indexes.end() || found->second >= project->layouts().size()
               ? nullptr
               : &project->layouts()[found->second];
}

const compiled::ScriptResource*
PreparedResourceRegistries::find_script(const ScriptId& id) const noexcept
{
    if (!project)
        return nullptr;
    const auto found = script_indexes.find(id);
    return found == script_indexes.end() || found->second >= project->scripts().size()
               ? nullptr
               : &project->scripts()[found->second];
}

const MaterialDefinition*
PreparedResourceRegistries::find_material(const MaterialId& id) const noexcept
{
    if (!shader_materials)
        return nullptr;
    const auto found = material_indexes.find(id.text());
    return found == material_indexes.end() || found->second >= shader_materials->materials.size()
               ? nullptr
               : &shader_materials->materials[found->second];
}

const compiled::AssetResource*
PreparedResourceRegistries::find_asset_by_alias(std::string_view alias) const noexcept
{
    if (!project)
        return nullptr;
    const auto found = asset_aliases.find(std::string(alias));
    return found == asset_aliases.end() || found->second >= project->assets().size()
               ? nullptr
               : &project->assets()[found->second];
}

LoadedCompiledPackage::LoadedCompiledPackage(CompiledProject project,
                                             RuntimePackageManifest manifest,
                                             std::optional<ShaderMaterialProject> shader_materials,
                                             PreparedResourceRegistries resources)
    : m_project(std::move(project)), m_manifest(std::move(manifest)),
      m_shader_materials(std::move(shader_materials)), m_resources(std::move(resources))
{
    rebind_registries();
}

LoadedCompiledPackage::LoadedCompiledPackage(LoadedCompiledPackage&& other) noexcept
    : m_project(std::move(other.m_project)), m_manifest(std::move(other.m_manifest)),
      m_shader_materials(std::move(other.m_shader_materials)),
      m_resources(std::move(other.m_resources))
{
    rebind_registries();
}

LoadedCompiledPackage& LoadedCompiledPackage::operator=(LoadedCompiledPackage&& other) noexcept
{
    if (this != &other) {
        m_project = std::move(other.m_project);
        m_manifest = std::move(other.m_manifest);
        m_shader_materials = std::move(other.m_shader_materials);
        m_resources = std::move(other.m_resources);
        rebind_registries();
    }
    return *this;
}

void LoadedCompiledPackage::rebind_registries() noexcept
{
    m_resources.project = &m_project;
    m_resources.shader_materials = m_shader_materials ? &*m_shader_materials : nullptr;
}

Result<LoadedCompiledPackage, Diagnostics>
assemble_compiled_package(CompiledProject project, RuntimePackageManifest manifest,
                          std::optional<ShaderMaterialProject> shader_materials,
                          std::vector<RuntimePackageFile> files)
{
    Diagnostics diagnostics;
    std::unordered_map<std::string, const RuntimePackageEntry*> declared;
    for (const auto& entry : manifest.entries)
        declared.emplace(entry.path, &entry);
    if (!declared.contains("game"))
        add_assembly_error(diagnostics, "runtime_package.missing_game",
                           "Package manifest must contain the compiled gameplay entry 'game'.",
                           "/entries");
    if (manifest.project.name != project.identity().name ||
        manifest.project.version != project.identity().version)
        add_assembly_error(diagnostics, "runtime_package.identity_mismatch",
                           "Package and gameplay project identities do not match.", "/project");

    std::unordered_map<std::string, const RuntimePackageFile*> actual;
    for (std::size_t index = 0; index < files.size(); ++index) {
        const auto& file = files[index];
        if (file.path != "manifest.json" &&
            !ProjectPackageWriter::is_allowed_package_path(file.path))
            add_assembly_error(
                diagnostics, "runtime_package.invalid_path",
                "Actual package entry path is unsafe or outside the runtime package layout.",
                "/files/" + std::to_string(index) + "/path");
        if (!actual.emplace(file.path, &file).second)
            add_assembly_error(diagnostics, "runtime_package.duplicate_entry",
                               "Actual package contains duplicate entry '" + file.path + "'.",
                               "/files/" + std::to_string(index) + "/path");
    }
    for (const auto& entry : manifest.entries) {
        const auto found = actual.find(entry.path);
        if (found == actual.end()) {
            add_assembly_error(diagnostics, "runtime_package.missing_entry",
                               "Declared package entry '" + entry.path + "' is missing.",
                               "/entries");
            continue;
        }
        if (found->second->size != entry.size)
            add_assembly_error(
                diagnostics, "runtime_package.size_mismatch",
                "Package entry size does not match manifest for '" + entry.path + "'.", "/entries");
        if (entry.checksum && found->second->checksum != entry.checksum)
            add_assembly_error(diagnostics, "runtime_package.checksum_mismatch",
                               "Package entry checksum does not match manifest for '" + entry.path +
                                   "'.",
                               "/checksums");
    }
    for (const auto& [path, file] : actual)
        if (!declared.contains(path) && path != "manifest.json")
            add_assembly_error(diagnostics, "runtime_package.undeclared_entry",
                               "Package contains undeclared entry '" + path + "'.", "/files");

    PreparedResourceRegistries registries;
    index_collection(registries.asset_indexes, project.assets(),
                     [](const auto& asset) { return asset.id; });
    index_collection(registries.layout_indexes, project.layouts(),
                     [](const auto& layout) { return layout.id; });
    index_collection(registries.script_indexes, project.scripts(),
                     [](const auto& script) { return script.id; });
    for (std::size_t asset_index = 0; asset_index < project.assets().size(); ++asset_index) {
        const auto& asset = project.assets()[asset_index];
        const std::string path = normalized_package_path(asset.path);
        if (!ProjectPackageWriter::is_allowed_package_path(path))
            add_assembly_error(
                diagnostics, "runtime_package.invalid_asset_path",
                "Gameplay asset path is unsafe or outside the runtime package layout for asset '" +
                    asset.id.text() + "'.",
                "/resources/assets");
        else if (manifest.kind != RuntimePackageKind::Runtime ||
                 asset.kind != compiled::AssetKind::ShaderSource) {
            if (!declared.contains(path))
                add_assembly_error(diagnostics, "runtime_package.missing_asset",
                                   "Gameplay asset '" + asset.id.text() +
                                       "' is missing package entry '" + path + "'.",
                                   "/resources/assets");
        }
        for (const auto& alias : asset.aliases) {
            if (alias.empty() || !registries.asset_aliases.emplace(alias, asset_index).second)
                add_assembly_error(diagnostics, "runtime_package.duplicate_asset_alias",
                                   "Asset alias is empty or duplicated: '" + alias + "'.",
                                   "/resources/assets");
        }
    }

    if (manifest.shader_materials.has_value() != shader_materials.has_value())
        add_assembly_error(diagnostics, "runtime_package.shader_manifest_mismatch",
                           "Package shader/material declaration and decoded document must both be "
                           "present or absent.",
                           "/shader_materials");
    if (manifest.shader_materials && !declared.contains(manifest.shader_materials->entry))
        add_assembly_error(diagnostics, "runtime_package.missing_shader_manifest",
                           "Declared shader/material document is missing from package entries.",
                           "/shader_materials/entry");
    if (manifest.kind == RuntimePackageKind::Runtime && manifest.shader_materials &&
        !manifest.shader_materials->sources_stripped)
        add_assembly_error(diagnostics, "runtime_package.runtime_shader_sources",
                           "Runtime packages must declare stripped shader sources.",
                           "/shader_materials/sources_stripped");

    if (shader_materials) {
        for (std::size_t index = 0; index < shader_materials->materials.size(); ++index) {
            const auto& material = shader_materials->materials[index];
            if (!registries.material_indexes.emplace(material.id.string(), index).second)
                add_assembly_error(diagnostics, "runtime_package.duplicate_material",
                                   "Duplicate material ID '" + material.id.string() + "'.",
                                   "/materials");
        }
        std::unordered_set<std::string> shader_ids;
        for (const auto& shader : shader_materials->shaders) {
            if (manifest.shader_materials && manifest.shader_materials->sources_stripped) {
                for (const auto& stage : shader.stages) {
                    if (!stage.source.empty() || !stage.source_text.empty())
                        add_assembly_error(
                            diagnostics, "runtime_package.unstripped_shader_source",
                            "Shader source remains although the manifest declares it stripped.",
                            "/shaders");
                }
            }
            if (!shader_ids.insert(shader.id.string()).second)
                add_assembly_error(diagnostics, "runtime_package.duplicate_shader",
                                   "Duplicate shader ID '" + shader.id.string() + "'.", "/shaders");
            for (const auto& binding : shader.role_bindings) {
                if ((binding.vertex_shader &&
                     !find_shader(*shader_materials, *binding.vertex_shader)) ||
                    (binding.fragment_shader &&
                     !find_shader(*shader_materials, *binding.fragment_shader)))
                    add_assembly_error(diagnostics, "runtime_package.unknown_shader_binding",
                                       "Shader role binding references an unknown shader.",
                                       "/shaders");
            }
            for (const auto& stage : shader.stages) {
                for (const auto& binary : stage.compiled) {
                    const std::string path = normalized_package_path(binary.path);
                    if (std::find(manifest.shader_variants.begin(), manifest.shader_variants.end(),
                                  binary.variant) == manifest.shader_variants.end())
                        add_assembly_error(diagnostics, "runtime_package.undeclared_shader_variant",
                                           "Compiled shader variant '" + binary.variant +
                                               "' is not declared by the package.",
                                           "/shader_variants");
                    if (!ProjectPackageWriter::is_allowed_package_path(path) ||
                        !declared.contains(path))
                        add_assembly_error(diagnostics, "runtime_package.missing_shader_binary",
                                           "Compiled shader binary is missing or unsafe: '" + path +
                                               "'.",
                                           "/shaders");
                }
            }
        }
        for (const auto& material : shader_materials->materials) {
            for (const auto& variant : manifest.shader_variants) {
                const auto resolution =
                    resolve_material_shader_program(*shader_materials, material.id, variant);
                if (!resolution.ok())
                    add_assembly_error(diagnostics, "runtime_package.incomplete_material_variant",
                                       "Material '" + material.id.string() +
                                           "' cannot resolve compiled shader variant '" + variant +
                                           "'.",
                                       "/materials");
            }
        }
    }

    std::unordered_set<std::string> required_materials;
    collect_material_ids(project, required_materials);
    for (const auto& material : required_materials) {
        if (!registries.material_indexes.contains(material))
            add_assembly_error(diagnostics, "runtime_package.missing_gameplay_material",
                               "Gameplay references missing material '" + material + "'.",
                               "/materials");
    }

    if (!diagnostics.empty())
        return Result<LoadedCompiledPackage, Diagnostics>::failure(std::move(diagnostics));
    return Result<LoadedCompiledPackage, Diagnostics>::success(
        LoadedCompiledPackage(std::move(project), std::move(manifest), std::move(shader_materials),
                              std::move(registries)));
}

} // namespace noveltea::core
