#include "noveltea/script/compiled_runtime_loader.hpp"

#include "noveltea/core/compiled_package_codec.hpp"
#include "noveltea/core/compiled_project_codec.hpp"

#include <algorithm>
#include <utility>

namespace noveltea::script {

core::Result<std::unique_ptr<CompiledRuntime>, core::Diagnostics>
load_compiled_runtime(CompiledRuntimeLoadInput input, ScriptRuntime& scripts,
                      core::TypedSaveSlotStore& saves)
{
    auto project = core::decode_compiled_project(input.gameplay, input.gameplay_source_path);
    if (!project) {
        return core::Result<std::unique_ptr<CompiledRuntime>, core::Diagnostics>::failure(
            std::move(project).error());
    }
    auto manifest =
        core::decode_runtime_package_manifest(input.manifest, input.manifest_source_path);
    if (!manifest) {
        return core::Result<std::unique_ptr<CompiledRuntime>, core::Diagnostics>::failure(
            std::move(manifest).error());
    }

    std::optional<ShaderMaterialProject> shader_materials;
    if (input.shader_materials) {
        auto decoded = core::decode_shader_material_manifest(*input.shader_materials,
                                                             input.shader_materials_source_path);
        if (!decoded) {
            return core::Result<std::unique_ptr<CompiledRuntime>, core::Diagnostics>::failure(
                std::move(decoded).error());
        }
        shader_materials = std::move(*decoded.value_if());
    }

    auto package = core::assemble_compiled_package(
        std::move(*project.value_if()), std::move(*manifest.value_if()),
        std::move(shader_materials), std::move(input.files));
    if (!package) {
        return core::Result<std::unique_ptr<CompiledRuntime>, core::Diagnostics>::failure(
            std::move(package).error());
    }
    return CompiledRuntime::create(std::move(*package.value_if()), scripts, saves,
                                   std::move(input.runtime_locale));
}

core::Result<std::unique_ptr<CompiledRuntime>, core::Diagnostics> load_compiled_runtime_preview(
    nlohmann::json gameplay, std::optional<nlohmann::json> shader_materials, ScriptRuntime& scripts,
    core::TypedSaveSlotStore& saves, std::string runtime_locale)
{
    auto decoded_project = core::decode_compiled_project(gameplay, "game");
    if (!decoded_project) {
        return core::Result<std::unique_ptr<CompiledRuntime>, core::Diagnostics>::failure(
            std::move(decoded_project).error());
    }

    nlohmann::json entries = nlohmann::json::array({{{"path", "game"}, {"size", 0}}});
    std::vector<core::RuntimePackageFile> files{{"game", 0, std::nullopt}};
    for (const auto& asset : decoded_project.value_if()->assets()) {
        entries.push_back({{"path", asset.path}, {"size", 0}});
        files.push_back({asset.path, 0, std::nullopt});
    }

    nlohmann::json manifest = {
        {"format", "noveltea.runtime-package"},
        {"format_version", 1},
        {"kind", "runtime"},
        {"created_by", "noveltea-preview"},
        {"project",
         {{"name", decoded_project.value_if()->identity().name},
          {"version", decoded_project.value_if()->identity().version}}},
        {"shader_variants", nlohmann::json::array()},
        {"entries", entries},
    };

    if (shader_materials) {
        auto decoded_materials =
            core::decode_shader_material_manifest(*shader_materials, "shader-materials.json");
        if (!decoded_materials) {
            return core::Result<std::unique_ptr<CompiledRuntime>, core::Diagnostics>::failure(
                std::move(decoded_materials).error());
        }
        std::vector<std::string> variants;
        for (const auto& shader : decoded_materials.value_if()->shaders) {
            for (const auto& stage : shader.stages) {
                for (const auto& binary : stage.compiled) {
                    if (std::find(variants.begin(), variants.end(), binary.variant) ==
                        variants.end()) {
                        variants.push_back(binary.variant);
                    }
                    entries.push_back({{"path", binary.path}, {"size", 0}});
                    files.push_back({binary.path, 0, std::nullopt});
                }
            }
        }
        entries.push_back({{"path", "shader-materials.json"}, {"size", 0}});
        files.push_back({"shader-materials.json", 0, std::nullopt});
        manifest["entries"] = std::move(entries);
        manifest["shader_variants"] = std::move(variants);
        manifest["shader_materials"] = {{"entry", "shader-materials.json"},
                                        {"schema", "noveltea.shader-materials.v1"},
                                        {"sources_stripped", true}};
    }

    return load_compiled_runtime(
        CompiledRuntimeLoadInput{.gameplay = std::move(gameplay),
                                 .manifest = std::move(manifest),
                                 .shader_materials = std::move(shader_materials),
                                 .files = std::move(files),
                                 .runtime_locale = std::move(runtime_locale)},
        scripts, saves);
}

} // namespace noveltea::script
