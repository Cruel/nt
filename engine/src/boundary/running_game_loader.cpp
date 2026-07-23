#include "noveltea/boundary/running_game_loader.hpp"

#include "noveltea/assets/asset_source.hpp"
#include "noveltea/core/compiled_package_codec.hpp"
#include "noveltea/core/compiled_project_codec.hpp"
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

core::Result<nlohmann::json, core::Diagnostics>
read_package_json(const assets::ZipAssetSource& source, std::string_view entry_path,
                  std::string_view package_path)
{
    const auto parsed = assets::AssetPath::parse(entry_path);
    if (!parsed) {
        return core::Result<nlohmann::json, core::Diagnostics>::failure(load_failure(
            "content.runtime_package_unsafe_path",
            "Runtime package metadata entry has an unsafe path: " + std::string(entry_path),
            std::string(package_path)));
    }
    auto blob = source.read_binary(*parsed);
    if (!blob) {
        return core::Result<nlohmann::json, core::Diagnostics>::failure(
            package_source_failure(blob.error, package_path));
    }
    auto document =
        nlohmann::json::parse(blob.value->bytes.begin(), blob.value->bytes.end(), nullptr, false);
    if (document.is_discarded()) {
        return core::Result<nlohmann::json, core::Diagnostics>::failure(
            load_failure("content.runtime_package_json_invalid",
                         "Runtime package JSON entry is malformed: " + std::string(entry_path),
                         package_entry_source(package_path, entry_path)));
    }
    return core::Result<nlohmann::json, core::Diagnostics>::success(std::move(document));
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

    auto manifest_document = read_package_json(source, "manifest.json", logical_path);
    if (!manifest_document)
        return core::Result<core::LoadedCompiledPackage, core::Diagnostics>::failure(
            std::move(manifest_document).error());
    auto manifest = core::decode_runtime_package_manifest(
        *manifest_document.value_if(), package_entry_source(logical_path, "manifest.json"));
    if (!manifest)
        return core::Result<core::LoadedCompiledPackage, core::Diagnostics>::failure(
            std::move(manifest).error());
    *manifest_document.value_if() = nlohmann::json{};

    auto gameplay_document = read_package_json(source, "game", logical_path);
    if (!gameplay_document)
        return core::Result<core::LoadedCompiledPackage, core::Diagnostics>::failure(
            std::move(gameplay_document).error());
    auto project = core::decode_compiled_project(*gameplay_document.value_if(),
                                                 package_entry_source(logical_path, "game"));
    if (!project)
        return core::Result<core::LoadedCompiledPackage, core::Diagnostics>::failure(
            std::move(project).error());
    *gameplay_document.value_if() = nlohmann::json{};

    std::optional<ShaderMaterialProject> shader_materials;
    if (manifest.value_if()->shader_materials) {
        const auto& entry_path = manifest.value_if()->shader_materials->entry;
        auto shader_document = read_package_json(source, entry_path, logical_path);
        if (!shader_document)
            return core::Result<core::LoadedCompiledPackage, core::Diagnostics>::failure(
                std::move(shader_document).error());
        auto decoded = core::decode_shader_material_manifest(
            *shader_document.value_if(), package_entry_source(logical_path, entry_path));
        if (!decoded)
            return core::Result<core::LoadedCompiledPackage, core::Diagnostics>::failure(
                std::move(decoded).error());
        shader_materials = std::move(*decoded.value_if());
        *shader_document.value_if() = nlohmann::json{};
    }

    return core::assemble_compiled_package(
        std::move(*project.value_if()), std::move(*manifest.value_if()),
        std::move(shader_materials), package_inventory(*indexed_entries.value));
}

core::Result<RunningGameLoadInput, core::Diagnostics>
make_loose_project_load_input(nlohmann::json gameplay,
                              std::optional<nlohmann::json> shader_materials,
                              std::string runtime_locale)
{
    auto decoded_project = core::decode_compiled_project(gameplay, "game");
    if (!decoded_project) {
        return core::Result<RunningGameLoadInput, core::Diagnostics>::failure(
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
        {"format_version", 2},
        {"kind", "runtime"},
        {"created_by", "noveltea-loose-project"},
        {"project",
         {{"name", decoded_project.value_if()->identity().name},
          {"version", decoded_project.value_if()->identity().version}}},
        {"display",
         {{"reference_resolution",
           {{"width", decoded_project.value_if()->settings().display.reference_resolution.width},
            {"height",
             decoded_project.value_if()->settings().display.reference_resolution.height}}},
          {"world_raster_policy",
           decoded_project.value_if()->settings().display.world_raster_policy ==
                   core::compiled::WorldRasterPolicy::Native
               ? "native"
               : "capped"},
          {"bar_color", decoded_project.value_if()->settings().display.bar_color}}},
        {"accessibility",
         {{"ui_scale",
           {{"enabled", decoded_project.value_if()->settings().accessibility.ui_scale.enabled},
            {"minimum", decoded_project.value_if()->settings().accessibility.ui_scale.minimum},
            {"maximum", decoded_project.value_if()->settings().accessibility.ui_scale.maximum}}},
          {"text_scale",
           {{"enabled", decoded_project.value_if()->settings().accessibility.text_scale.enabled},
            {"minimum", decoded_project.value_if()->settings().accessibility.text_scale.minimum},
            {"maximum",
             decoded_project.value_if()->settings().accessibility.text_scale.maximum}}}}},
        {"shader_variants", nlohmann::json::array()},
        {"entries", entries},
    };

    std::optional<ShaderMaterialProject> typed_shader_materials;
    if (shader_materials) {
        auto decoded_materials =
            core::decode_shader_material_manifest(*shader_materials, "shader-materials.json");
        if (!decoded_materials) {
            return core::Result<RunningGameLoadInput, core::Diagnostics>::failure(
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
        typed_shader_materials = std::move(*decoded_materials.value_if());
    }

    auto typed_manifest = core::decode_runtime_package_manifest(manifest, "manifest.json");
    if (!typed_manifest) {
        return core::Result<RunningGameLoadInput, core::Diagnostics>::failure(
            std::move(typed_manifest).error());
    }
    gameplay = {};
    manifest = {};
    shader_materials.reset();

    auto package = core::assemble_compiled_package(
        std::move(*decoded_project.value_if()), std::move(*typed_manifest.value_if()),
        std::move(typed_shader_materials), std::move(files));
    if (!package) {
        return core::Result<RunningGameLoadInput, core::Diagnostics>::failure(
            std::move(package).error());
    }
    RunningGameLoadInput input;
    input.runtime_locale = std::move(runtime_locale);
    input.decoded_package.emplace(std::move(*package.value_if()));
    return core::Result<RunningGameLoadInput, core::Diagnostics>::success(std::move(input));
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

        auto decoded_package =
            decode_indexed_runtime_package(**package_source.value_if(), logical_path);
        if (!decoded_package)
            return core::Result<ResolvedRunningGameSource, core::Diagnostics>::failure(
                std::move(decoded_package).error());

        assets::AssetManager::NamespaceMounts project_mounts;
        project_mounts.push_back(*package_source.value_if());
        RunningGameLoadInput input;
        input.gameplay_source_path = package_entry_source(logical_path, "game");
        input.manifest_source_path = package_entry_source(logical_path, "manifest.json");
        input.runtime_locale = std::move(runtime_locale);
        input.decoded_package.emplace(std::move(*decoded_package.value_if()));
        return core::Result<ResolvedRunningGameSource, core::Diagnostics>::success(
            ResolvedRunningGameSource{.input = std::move(input),
                                      .project_mounts = std::move(project_mounts),
                                      .replaces_project_namespace = true});
    }

    auto blob = assets.read_binary(logical_path);
    if (!blob) {
        return core::Result<ResolvedRunningGameSource, core::Diagnostics>::failure(load_failure(
            "content.compiled_project_read_failed", blob.error.message, std::string(logical_path)));
    }

    const auto& bytes = blob.value->bytes;
    auto gameplay = nlohmann::json::parse(bytes.begin(), bytes.end(), nullptr, false);
    if (gameplay.is_discarded()) {
        return core::Result<ResolvedRunningGameSource, core::Diagnostics>::failure(
            load_failure("content.compiled_project_json_invalid",
                         "Compiled project JSON is malformed", std::string(logical_path)));
    }

    std::optional<nlohmann::json> shader_materials;
    auto shader_text = assets.read_text("project:/shader-materials.json");
    if (shader_text) {
        auto parsed = nlohmann::json::parse(*shader_text.value, nullptr, false);
        if (parsed.is_discarded()) {
            return core::Result<ResolvedRunningGameSource, core::Diagnostics>::failure(load_failure(
                "content.shader_materials_json_invalid",
                "project:/shader-materials.json is malformed", "project:/shader-materials.json"));
        }
        shader_materials = std::move(parsed);
    }
    auto input = make_loose_project_load_input(std::move(gameplay), std::move(shader_materials),
                                               std::move(runtime_locale));
    if (!input)
        return core::Result<ResolvedRunningGameSource, core::Diagnostics>::failure(
            std::move(input).error());
    return core::Result<ResolvedRunningGameSource, core::Diagnostics>::success(
        ResolvedRunningGameSource{.input = std::move(*input.value_if()),
                                  .project_mounts = {},
                                  .replaces_project_namespace = false});
}

core::Result<std::unique_ptr<RunningGame>, core::Diagnostics>
load_running_game(RunningGameLoadInput input, ScriptCertificationPort& script_certifier,
                  ScriptInvocationPort& scripts, PresentationRuntimePort& presentation,
                  core::TypedSaveSlotStore& saves)
{
    if (input.decoded_package) {
        auto package = std::move(*input.decoded_package);
        input.decoded_package.reset();
        input.gameplay = {};
        input.manifest = {};
        input.shader_materials.reset();
        input.files.clear();
        static presentation::RuntimePresentationModel presentation_model;
        static const core::JsonSaveStateCodec save_codec;
        return RunningGame::create(std::move(package), script_certifier, scripts,
                                   presentation_model, presentation, saves, save_codec,
                                   std::move(input.runtime_locale));
    }

    auto project = core::decode_compiled_project(input.gameplay, input.gameplay_source_path);
    if (!project) {
        return core::Result<std::unique_ptr<RunningGame>, core::Diagnostics>::failure(
            std::move(project).error());
    }
    auto manifest =
        core::decode_runtime_package_manifest(input.manifest, input.manifest_source_path);
    if (!manifest) {
        return core::Result<std::unique_ptr<RunningGame>, core::Diagnostics>::failure(
            std::move(manifest).error());
    }

    std::optional<ShaderMaterialProject> shader_materials;
    if (input.shader_materials) {
        auto decoded = core::decode_shader_material_manifest(*input.shader_materials,
                                                             input.shader_materials_source_path);
        if (!decoded) {
            return core::Result<std::unique_ptr<RunningGame>, core::Diagnostics>::failure(
                std::move(decoded).error());
        }
        shader_materials = std::move(*decoded.value_if());
    }

    input.gameplay = {};
    input.manifest = {};
    input.shader_materials.reset();

    auto package = core::assemble_compiled_package(
        std::move(*project.value_if()), std::move(*manifest.value_if()),
        std::move(shader_materials), std::move(input.files));
    if (!package) {
        return core::Result<std::unique_ptr<RunningGame>, core::Diagnostics>::failure(
            std::move(package).error());
    }
    static presentation::RuntimePresentationModel presentation_model;
    static const core::JsonSaveStateCodec save_codec;
    return RunningGame::create(std::move(*package.value_if()), script_certifier, scripts,
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
