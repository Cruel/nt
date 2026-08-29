#include "noveltea/boundary/running_game_loader.hpp"

#include "noveltea/assets/asset_source.hpp"
#include "noveltea/core/compiled_package_codec.hpp"
#include "noveltea/core/compiled_project_codec.hpp"
#include "noveltea/core/player_bootstrap.hpp"
#include "noveltea/core/save_state_codec.hpp"
#include "noveltea/presentation/runtime_presentation_model.hpp"

#include <algorithm>
#include <cstdint>
#include <filesystem>
#include <iomanip>
#include <limits>
#include <memory>
#include <sstream>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace noveltea::runtime {
namespace {

core::Diagnostics load_failure(std::string code, std::string message, std::string source_path)
{
    return {{.code = std::move(code),
             .message = std::move(message),
             .source_path = std::move(source_path)}};
}

std::string package_entry_source(std::string_view package_path, std::string_view entry_path)
{
    return std::string(package_path) + "!/" + std::string(entry_path);
}

std::string package_source_code(const assets::AssetSourceError& error)
{
    if (error.code == assets::asset_source_error_code::unsafe_path)
        return "content.runtime_package_unsafe_path";
    if (error.code == assets::asset_source_error_code::unsupported_storage)
        return "content.runtime_package_unsupported_storage";
    if (error.code == assets::asset_source_error_code::not_found)
        return "content.runtime_package_entries_missing";
    if (error.code == assets::asset_source_error_code::corrupt)
        return "content.runtime_package_invalid";
    return "content.runtime_package_entry_read_failed";
}

core::Diagnostics package_source_failure(const assets::AssetSourceError& error,
                                         std::string_view package_path)
{
    return load_failure(package_source_code(error), error.message + " [" + error.code + "]",
                        std::string(package_path));
}

bool is_runtime_package_path(std::string_view logical_path)
{
    const auto parsed = assets::AssetPath::parse(logical_path);
    return parsed && std::filesystem::path(parsed->relative_path()).extension() == ".ntpkg";
}

core::Result<std::shared_ptr<assets::ZipAssetSource>, core::Diagnostics>
open_runtime_package_source(assets::AssetManager& assets, std::string_view logical_path)
{
    auto opened = assets.open(logical_path);
    if (!opened) {
        return core::Result<std::shared_ptr<assets::ZipAssetSource>, core::Diagnostics>::failure(
            load_failure("content.compiled_project_read_failed", opened.error.message,
                         std::string(logical_path)));
    }

    assets::AssetReader& reader = **opened.value;
    if (auto native_path = reader.native_path()) {
        return core::Result<std::shared_ptr<assets::ZipAssetSource>, core::Diagnostics>::success(
            std::make_shared<assets::ZipAssetSource>(std::move(*native_path)));
    }

    auto size = reader.size();
    if (!size) {
        return core::Result<std::shared_ptr<assets::ZipAssetSource>, core::Diagnostics>::failure(
            package_source_failure(size.error, logical_path));
    }
    if (*size.value > static_cast<std::uint64_t>(std::numeric_limits<std::size_t>::max())) {
        return core::Result<std::shared_ptr<assets::ZipAssetSource>, core::Diagnostics>::failure(
            load_failure("content.runtime_package_unsupported_storage",
                         "Runtime package is too large for immutable-memory backing",
                         std::string(logical_path)));
    }

    auto archive_bytes = std::make_shared<assets::AssetBytes>(static_cast<std::size_t>(*size.value),
                                                              std::uint8_t{0});
    std::size_t total = 0;
    while (total < archive_bytes->size()) {
        auto read = reader.read(archive_bytes->data() + total, archive_bytes->size() - total);
        if (!read) {
            return core::Result<std::shared_ptr<assets::ZipAssetSource>,
                                core::Diagnostics>::failure(package_source_failure(read.error,
                                                                                   logical_path));
        }
        if (*read.value == 0) {
            return core::Result<std::shared_ptr<assets::ZipAssetSource>, core::Diagnostics>::
                failure(load_failure("content.runtime_package_entry_read_failed",
                                     "Runtime package ended before its advertised size",
                                     std::string(logical_path)));
        }
        total += *read.value;
    }
    std::shared_ptr<const assets::AssetBytes> immutable_archive = std::move(archive_bytes);
    return core::Result<std::shared_ptr<assets::ZipAssetSource>, core::Diagnostics>::success(
        std::make_shared<assets::ZipAssetSource>(std::move(immutable_archive)));
}

core::Result<assets::AssetBlob, core::Diagnostics>
read_package_blob(const assets::ZipAssetSource& source, std::string_view entry_path,
                  std::string_view package_path)
{
    const auto parsed = assets::AssetPath::parse(entry_path);
    if (!parsed) {
        return core::Result<assets::AssetBlob, core::Diagnostics>::failure(load_failure(
            "content.runtime_package_unsafe_path",
            "Runtime package metadata entry has an unsafe path: " + std::string(entry_path),
            std::string(package_path)));
    }
    auto blob = source.read_binary(*parsed);
    if (!blob) {
        return core::Result<assets::AssetBlob, core::Diagnostics>::failure(
            package_source_failure(blob.error, package_path));
    }
    return core::Result<assets::AssetBlob, core::Diagnostics>::success(std::move(*blob.value));
}

std::vector<core::RuntimePackageFile>
package_inventory(const std::vector<assets::ZipAssetSource::EntryInventory>& inventory)
{
    std::vector<core::RuntimePackageFile> files;
    files.reserve(inventory.size());
    for (const auto& entry : inventory) {
        std::ostringstream checksum;
        checksum << std::hex << std::setfill('0') << std::setw(8) << entry.crc32;
        files.push_back({entry.path, entry.metadata.uncompressed_size, checksum.str()});
    }
    return files;
}

core::Result<core::LoadedCompiledPackage, core::Diagnostics>
decode_indexed_runtime_package(const assets::ZipAssetSource& source, std::string_view logical_path)
{
    auto indexed_entries = source.inventory();
    if (!indexed_entries) {
        return core::Result<core::LoadedCompiledPackage, core::Diagnostics>::failure(
            package_source_failure(indexed_entries.error, logical_path));
    }

    auto manifest_blob = read_package_blob(source, "manifest.json", logical_path);
    if (!manifest_blob)
        return core::Result<core::LoadedCompiledPackage, core::Diagnostics>::failure(
            std::move(manifest_blob).error());
    const auto& manifest_bytes = manifest_blob.value_if()->bytes;
    const std::string_view manifest_text(reinterpret_cast<const char*>(manifest_bytes.data()),
                                         manifest_bytes.size());
    auto manifest = core::decode_runtime_package_manifest_json(
        manifest_text, package_entry_source(logical_path, "manifest.json"));
    if (!manifest)
        return core::Result<core::LoadedCompiledPackage, core::Diagnostics>::failure(
            std::move(manifest).error());

    auto gameplay_blob = read_package_blob(source, "game", logical_path);
    if (!gameplay_blob)
        return core::Result<core::LoadedCompiledPackage, core::Diagnostics>::failure(
            std::move(gameplay_blob).error());
    const auto& gameplay_bytes = gameplay_blob.value_if()->bytes;
    const std::string_view gameplay_text(reinterpret_cast<const char*>(gameplay_bytes.data()),
                                         gameplay_bytes.size());
    auto project = core::decode_compiled_project_json(gameplay_text,
                                                      package_entry_source(logical_path, "game"));
    if (!project)
        return core::Result<core::LoadedCompiledPackage, core::Diagnostics>::failure(
            std::move(project).error());

    std::optional<ShaderMaterialProject> shader_materials;
    if (manifest.value_if()->shader_materials) {
        const auto& entry_path = manifest.value_if()->shader_materials->entry;
        auto shader_blob = read_package_blob(source, entry_path, logical_path);
        if (!shader_blob)
            return core::Result<core::LoadedCompiledPackage, core::Diagnostics>::failure(
                std::move(shader_blob).error());
        const auto& shader_bytes = shader_blob.value_if()->bytes;
        const std::string_view shader_text(reinterpret_cast<const char*>(shader_bytes.data()),
                                           shader_bytes.size());
        auto decoded = core::decode_shader_material_manifest_json(
            shader_text, package_entry_source(logical_path, entry_path));
        if (!decoded)
            return core::Result<core::LoadedCompiledPackage, core::Diagnostics>::failure(
                std::move(decoded).error());
        shader_materials = std::move(*decoded.value_if());
    }

    return core::assemble_compiled_package(
        std::move(*project.value_if()), std::move(*manifest.value_if()),
        std::move(shader_materials), package_inventory(*indexed_entries.value));
}

core::Result<ResolvedRunningGameSource, core::Diagnostics>
resolve_indexed_runtime_package(std::shared_ptr<assets::ZipAssetSource> package_source,
                                std::string_view logical_path, std::string runtime_locale)
{
    if (!package_source) {
        return core::Result<ResolvedRunningGameSource, core::Diagnostics>::failure(
            load_failure("content.runtime_package_invalid", "Runtime package source is unavailable",
                         std::string(logical_path)));
    }

    auto decoded_package = decode_indexed_runtime_package(*package_source, logical_path);
    if (!decoded_package)
        return core::Result<ResolvedRunningGameSource, core::Diagnostics>::failure(
            std::move(decoded_package).error());

    assets::AssetManager::NamespaceMounts project_mounts;
    project_mounts.push_back(std::move(package_source));
    RunningGameLoadInput input{.package = std::move(*decoded_package.value_if()),
                               .runtime_locale = std::move(runtime_locale)};
    return core::Result<ResolvedRunningGameSource, core::Diagnostics>::success(
        ResolvedRunningGameSource{.input = std::move(input),
                                  .project_mounts = std::move(project_mounts),
                                  .replaces_project_namespace = true});
}

core::Result<RunningGameLoadInput, core::Diagnostics>
make_loose_project_load_input(core::CompiledProject project,
                              std::optional<ShaderMaterialProject> shader_materials,
                              std::string runtime_locale)
{
    std::vector<core::RuntimePackageFile> files{{"game", 0, std::nullopt}};
    core::RuntimePackageManifest manifest{
        .kind = core::RuntimePackageKind::Runtime,
        .created_by = "noveltea-loose-project",
        .project = {.name = project.identity().name, .version = project.identity().version},
        .display =
            core::RuntimePackageDisplay{
                .reference_resolution = project.settings().display.reference_resolution,
                .world_raster_policy = project.settings().display.world_raster_policy,
                .bar_color = project.settings().display.bar_color},
        .accessibility =
            core::RuntimePackageAccessibility{.ui_scale = project.settings().accessibility.ui_scale,
                                              .text_scale =
                                                  project.settings().accessibility.text_scale},
        .platform = std::nullopt,
        .shader_variants = {},
        .shader_materials = std::nullopt,
        .entries = {{"game", 0, std::nullopt}},
    };
    for (const auto& asset : project.assets()) {
        manifest.entries.push_back({asset.path, 0, std::nullopt});
        files.push_back({asset.path, 0, std::nullopt});
    }
    if (shader_materials) {
        std::vector<std::string> variants;
        for (const auto& shader : shader_materials->shaders) {
            for (const auto& stage : shader.stages) {
                for (const auto& binary : stage.compiled) {
                    if (std::find(variants.begin(), variants.end(), binary.variant) ==
                        variants.end()) {
                        variants.push_back(binary.variant);
                    }
                    manifest.entries.push_back({binary.path, 0, std::nullopt});
                    files.push_back({binary.path, 0, std::nullopt});
                }
            }
        }
        manifest.entries.push_back({"shader-materials.json", 0, std::nullopt});
        files.push_back({"shader-materials.json", 0, std::nullopt});
        manifest.shader_variants = std::move(variants);
        manifest.shader_materials =
            core::RuntimePackageShaderMaterials{.entry = "shader-materials.json",
                                                .schema = "noveltea.shader-materials",
                                                .sources_stripped = true};
    }

    auto package = core::assemble_compiled_package(std::move(project), std::move(manifest),
                                                   std::move(shader_materials), std::move(files));
    if (!package) {
        return core::Result<RunningGameLoadInput, core::Diagnostics>::failure(
            std::move(package).error());
    }
    return core::Result<RunningGameLoadInput, core::Diagnostics>::success(RunningGameLoadInput{
        .package = std::move(*package.value_if()), .runtime_locale = std::move(runtime_locale)});
}

} // namespace

core::Result<ResolvedRunningGameSource, core::Diagnostics>
resolve_running_game_source(assets::AssetManager& assets, std::string_view logical_path,
                            std::string runtime_locale)
{
    if (is_runtime_package_path(logical_path)) {
        auto package_source = open_runtime_package_source(assets, logical_path);
        if (!package_source)
            return core::Result<ResolvedRunningGameSource, core::Diagnostics>::failure(
                std::move(package_source).error());

        return resolve_indexed_runtime_package(std::move(*package_source.value_if()), logical_path,
                                               std::move(runtime_locale));
    }

    auto blob = assets.read_binary(logical_path);
    if (!blob) {
        return core::Result<ResolvedRunningGameSource, core::Diagnostics>::failure(load_failure(
            "content.compiled_project_read_failed", blob.error.message, std::string(logical_path)));
    }

    const auto& bytes = blob.value->bytes;
    const std::string_view gameplay_text(reinterpret_cast<const char*>(bytes.data()), bytes.size());
    auto project = core::decode_compiled_project_json(gameplay_text, std::string(logical_path));
    if (!project) {
        return core::Result<ResolvedRunningGameSource, core::Diagnostics>::failure(
            std::move(project).error());
    }

    std::optional<ShaderMaterialProject> shader_materials;
    auto shader_text = assets.read_text("project:/shader-materials.json");
    if (shader_text) {
        auto parsed = core::decode_shader_material_manifest_json(*shader_text.value,
                                                                 "project:/shader-materials.json");
        if (!parsed)
            return core::Result<ResolvedRunningGameSource, core::Diagnostics>::failure(
                std::move(parsed).error());
        shader_materials = std::move(*parsed.value_if());
    }
    auto input = make_loose_project_load_input(
        std::move(*project.value_if()), std::move(shader_materials), std::move(runtime_locale));
    if (!input)
        return core::Result<ResolvedRunningGameSource, core::Diagnostics>::failure(
            std::move(input).error());
    return core::Result<ResolvedRunningGameSource, core::Diagnostics>::success(
        ResolvedRunningGameSource{.input = std::move(*input.value_if()),
                                  .project_mounts = {},
                                  .replaces_project_namespace = false});
}

core::Result<ResolvedRunningGameSource, core::Diagnostics>
resolve_running_game_package_source(std::shared_ptr<assets::ZipAssetSource> package_source,
                                    std::string_view logical_path, std::string runtime_locale)
{
    if (!is_runtime_package_path(logical_path)) {
        return core::Result<ResolvedRunningGameSource, core::Diagnostics>::failure(load_failure(
            "content.runtime_package_invalid",
            "Direct runtime package source requires a .ntpkg path", std::string(logical_path)));
    }
    return resolve_indexed_runtime_package(std::move(package_source), logical_path,
                                           std::move(runtime_locale));
}

core::Result<std::unique_ptr<RunningGame>, core::Diagnostics>
load_running_game(RunningGameLoadInput input, ScriptCertificationPort& script_certifier,
                  ScriptInvocationPort& scripts, PresentationRuntimePort& presentation,
                  core::TypedSaveSlotStore& saves)
{
    static presentation::RuntimePresentationModel presentation_model;
    static const core::JsonSaveStateCodec save_codec;
    return RunningGame::create(std::move(input.package), script_certifier, scripts,
                               presentation_model, presentation, saves, save_codec,
                               std::move(input.runtime_locale));
}

core::Result<std::unique_ptr<RunningGame>, core::Diagnostics>
load_running_game(RunningGameLoadInput input, ScriptRuntimePort& scripts,
                  PresentationRuntimePort& presentation, core::TypedSaveSlotStore& saves)
{
    return load_running_game(std::move(input), scripts, scripts, presentation, saves);
}

} // namespace noveltea::runtime
