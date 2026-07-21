#include "noveltea/boundary/running_game_loader.hpp"

#include "noveltea/assets/asset_source.hpp"
#include "noveltea/core/compiled_package_codec.hpp"
#include "noveltea/core/compiled_project_codec.hpp"
#include "noveltea/core/save_state_codec.hpp"
#include "noveltea/presentation/runtime_presentation_model.hpp"

#include <algorithm>
#include <cstdint>
#include <iomanip>
#include <memory>
#include <sstream>
#include <span>
#include <string>
#include <string_view>
#include <utility>

#define MINIZ_NO_ZLIB_APIS
#if __has_include(<miniz/miniz.h>)
#include <miniz/miniz.h>
#else
#include <miniz.h>
#endif

namespace noveltea::runtime {
namespace {

struct ExtractedCompiledPackage {
    nlohmann::json gameplay;
    nlohmann::json manifest;
    std::optional<nlohmann::json> shader_materials;
    std::vector<core::RuntimePackageFile> files;
    std::shared_ptr<assets::MemoryAssetSource> assets;
};

core::Diagnostics load_failure(std::string code, std::string message, std::string source_path)
{
    return {{.code = std::move(code),
             .message = std::move(message),
             .source_path = std::move(source_path)}};
}

bool safe_package_path(std::string_view path)
{
    if (path.empty() || path.front() == '/' || path.find('\\') != path.npos ||
        path.find(':') != path.npos)
        return false;
    std::size_t begin = 0;
    while (begin <= path.size()) {
        const auto end = path.find('/', begin);
        const auto part = path.substr(begin, end == path.npos ? path.size() - begin : end - begin);
        if (part.empty() || part == "." || part == "..")
            return false;
        if (end == path.npos)
            return true;
        begin = end + 1;
    }
    return true;
}

core::Result<ExtractedCompiledPackage, core::Diagnostics>
extract_compiled_package(std::span<const std::uint8_t> bytes, std::string_view logical_path)
{
    mz_zip_archive archive{};
    if (!mz_zip_reader_init_mem(&archive, bytes.data(), bytes.size(), 0)) {
        return core::Result<ExtractedCompiledPackage, core::Diagnostics>::failure(
            load_failure("content.runtime_package_invalid",
                         "Runtime package is not a valid ZIP archive", std::string(logical_path)));
    }

    ExtractedCompiledPackage result;
    result.assets = std::make_shared<assets::MemoryAssetSource>();
    const auto count = mz_zip_reader_get_num_files(&archive);
    for (mz_uint index = 0; index < count; ++index) {
        mz_zip_archive_file_stat stat{};
        if (!mz_zip_reader_file_stat(&archive, index, &stat)) {
            mz_zip_reader_end(&archive);
            return core::Result<ExtractedCompiledPackage, core::Diagnostics>::failure(load_failure(
                "content.runtime_package_entry_metadata_failed",
                "Runtime package entry metadata cannot be read", std::string(logical_path)));
        }
        const std::string path = stat.m_filename;
        if (path.empty() || path.back() == '/')
            continue;
        if (!safe_package_path(path)) {
            mz_zip_reader_end(&archive);
            return core::Result<ExtractedCompiledPackage, core::Diagnostics>::failure(
                load_failure("content.runtime_package_unsafe_path",
                             "Runtime package contains an unsafe entry path: " + path,
                             std::string(logical_path)));
        }

        size_t size = 0;
        void* extracted = mz_zip_reader_extract_to_heap(&archive, index, &size, 0);
        if (!extracted) {
            mz_zip_reader_end(&archive);
            return core::Result<ExtractedCompiledPackage, core::Diagnostics>::failure(load_failure(
                "content.runtime_package_entry_read_failed",
                "Runtime package entry cannot be read: " + path, std::string(logical_path)));
        }

        const auto* first = static_cast<const std::uint8_t*>(extracted);
        assets::AssetBytes asset_bytes(first, first + size);
        if (path == "game" || path == "manifest.json" || path == "shader-materials.json") {
            auto document = nlohmann::json::parse(first, first + size, nullptr, false);
            if (document.is_discarded()) {
                mz_free(extracted);
                mz_zip_reader_end(&archive);
                return core::Result<ExtractedCompiledPackage, core::Diagnostics>::failure(
                    load_failure("content.runtime_package_json_invalid",
                                 "Runtime package JSON entry is malformed: " + path,
                                 std::string(logical_path)));
            }
            if (path == "game")
                result.gameplay = std::move(document);
            else if (path == "manifest.json")
                result.manifest = std::move(document);
            else
                result.shader_materials = std::move(document);
        } else {
            result.assets->add(path, asset_bytes, "runtime package");
        }
        std::ostringstream out;
        out << std::hex << std::setfill('0') << std::setw(8)
            << mz_crc32(MZ_CRC32_INIT, first, static_cast<size_t>(size));
        result.files.push_back({path, static_cast<std::uint64_t>(size), out.str()});
        mz_free(extracted);
    }
    mz_zip_reader_end(&archive);

    if (result.gameplay.is_null() || result.manifest.is_null()) {
        return core::Result<ExtractedCompiledPackage, core::Diagnostics>::failure(load_failure(
            "content.runtime_package_entries_missing",
            "Runtime package is missing game or manifest.json", std::string(logical_path)));
    }
    return core::Result<ExtractedCompiledPackage, core::Diagnostics>::success(std::move(result));
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
            {"height", decoded_project.value_if()->settings().display.reference_resolution.height}}},
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
            {"maximum", decoded_project.value_if()->settings().accessibility.text_scale.maximum}}}}},
        {"shader_variants", nlohmann::json::array()},
        {"entries", entries},
    };

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
    }

    return core::Result<RunningGameLoadInput, core::Diagnostics>::success(
        RunningGameLoadInput{.gameplay = std::move(gameplay),
                             .manifest = std::move(manifest),
                             .shader_materials = std::move(shader_materials),
                             .files = std::move(files),
                             .runtime_locale = std::move(runtime_locale)});
}

} // namespace

core::Result<ResolvedRunningGameSource, core::Diagnostics>
resolve_running_game_source(assets::AssetManager& assets, std::string_view logical_path,
                            std::string runtime_locale)
{
    auto blob = assets.read_binary(logical_path);
    if (!blob) {
        return core::Result<ResolvedRunningGameSource, core::Diagnostics>::failure(load_failure(
            "content.compiled_project_read_failed", blob.error, std::string(logical_path)));
    }

    const auto& bytes = blob.value->bytes;
    auto gameplay = nlohmann::json::parse(bytes.begin(), bytes.end(), nullptr, false);
    if (!gameplay.is_discarded()) {
        std::optional<nlohmann::json> shader_materials;
        auto shader_text = assets.read_text("project:/shader-materials.json");
        if (shader_text) {
            auto parsed = nlohmann::json::parse(*shader_text.value, nullptr, false);
            if (parsed.is_discarded()) {
                return core::Result<ResolvedRunningGameSource, core::Diagnostics>::failure(
                    load_failure("content.shader_materials_json_invalid",
                                 "project:/shader-materials.json is malformed",
                                 "project:/shader-materials.json"));
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

    auto package = extract_compiled_package(
        std::span<const std::uint8_t>(bytes.data(), bytes.size()), logical_path);
    if (!package)
        return core::Result<ResolvedRunningGameSource, core::Diagnostics>::failure(
            std::move(package).error());

    auto extracted = std::move(*package.value_if());
    assets::AssetManager::NamespaceMounts project_mounts;
    project_mounts.push_back(extracted.assets);
    return core::Result<ResolvedRunningGameSource, core::Diagnostics>::success(
        ResolvedRunningGameSource{
            .input = RunningGameLoadInput{.gameplay = std::move(extracted.gameplay),
                                          .manifest = std::move(extracted.manifest),
                                          .shader_materials = std::move(extracted.shader_materials),
                                          .files = std::move(extracted.files),
                                          .runtime_locale = std::move(runtime_locale)},
            .project_mounts = std::move(project_mounts),
            .replaces_project_namespace = true});
}

core::Result<std::unique_ptr<RunningGame>, core::Diagnostics>
load_running_game(RunningGameLoadInput input, ScriptCertificationPort& script_certifier,
                  ScriptInvocationPort& scripts, PresentationRuntimePort& presentation,
                  core::TypedSaveSlotStore& saves)
{
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
