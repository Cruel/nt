#include "noveltea/boundary/running_game_loader.hpp"

#include "noveltea/assets/asset_source.hpp"
#include "noveltea/core/compiled_package_codec.hpp"
#include "noveltea/core/compiled_project_codec.hpp"
#include "noveltea/core/player_bootstrap.hpp"
#include "noveltea/core/package_export.hpp"
#include "noveltea/core/save_state_codec.hpp"
#include "noveltea/core/json_access.hpp"
#include "noveltea/presentation/runtime_presentation_model.hpp"

#include <algorithm>
#include <cctype>
#include <cstdint>
#include <filesystem>
#include <iomanip>
#include <limits>
#include <memory>
#include <span>
#include <nlohmann/json.hpp>
#include <set>
#include <sstream>
#include <string>
#include <string_view>
#include <unordered_set>
#include <utility>
#include <vector>

namespace noveltea::runtime {
namespace {

std::string startup_runtime_locale(const core::compiled::Localization& localization,
                                   std::string_view requested_locale)
{
    std::string startup_catalog_locale = localization.default_locale;
    if (!requested_locale.empty()) {
        auto candidate = requested_locale;
        while (!candidate.empty()) {
            const auto definition = std::ranges::find_if(
                localization.locales, [&](const core::compiled::LocaleDefinition& locale) {
                    return locale.locale == candidate && locale.supported;
                });
            if (definition != localization.locales.end()) {
                startup_catalog_locale = definition->locale;
                break;
            }
            const auto separator = candidate.rfind('-');
            if (separator == std::string_view::npos)
                break;
            candidate = candidate.substr(0, separator);
        }
    }
    return startup_catalog_locale;
}

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
decode_indexed_runtime_package(const assets::ZipAssetSource& source, std::string_view logical_path,
                               std::string_view requested_runtime_locale)
{
    auto indexed_entries = source.inventory();
    if (!indexed_entries) {
        return core::Result<core::LoadedCompiledPackage, core::Diagnostics>::failure(
            package_source_failure(indexed_entries.error, logical_path));
    }
    for (const auto& entry : *indexed_entries.value)
        if (entry.path.starts_with("licenses/") && entry.metadata.uncompressed_size > 1024 * 1024)
            return core::Result<core::LoadedCompiledPackage, core::Diagnostics>::failure(
                load_failure("content.runtime_notice_invalid",
                             "Notice payload exceeds the size limit.", std::string(logical_path)));

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

    const bool has_notices = std::ranges::any_of(*indexed_entries.value, [](const auto& entry) {
        return entry.path.starts_with("licenses/");
    });
    if (!has_notices)
        return core::Result<core::LoadedCompiledPackage, core::Diagnostics>::failure(
            load_failure("content.runtime_notice_index_missing",
                         "Runtime Package is missing the required licenses/index.json catalog.",
                         std::string(logical_path)));
    {
        auto index_blob = read_package_blob(source, "licenses/index.json", logical_path);
        if (!index_blob)
            return core::Result<core::LoadedCompiledPackage, core::Diagnostics>::failure(
                std::move(index_blob).error());
        const auto& bytes = index_blob.value_if()->bytes;
        if (bytes.size() > 1024 * 1024)
            return core::Result<core::LoadedCompiledPackage, core::Diagnostics>::failure(
                load_failure("content.runtime_notice_invalid",
                             "Notice index exceeds the size limit.", std::string(logical_path)));
        const auto index = nlohmann::json::parse(bytes.begin(), bytes.end(), nullptr, false);
        bool valid = index.is_object() && index.size() == 2 && index.contains("schema") &&
                     index["schema"].is_string() && index["schema"] == "noveltea.project-notices" &&
                     index.contains("notices") && index["notices"].is_array();
        std::set<std::string> declared_notices{"licenses/index.json"};
        std::string previous_source_path;
        if (valid) {
            // Keep package validation within the runtime viewer's bounded catalog contract.
            valid = index["notices"].size() <= 512;
        }
        if (valid) {
            for (const auto& notice : index["notices"]) {
                if (!notice.is_object() || notice.size() != 4 || !notice.contains("path") ||
                    !notice["path"].is_string() || !notice.contains("source") ||
                    !notice["source"].is_string() || !notice.contains("displayName") ||
                    !notice["displayName"].is_string() || !notice.contains("contentHash") ||
                    !notice["contentHash"].is_string()) {
                    valid = false;
                    break;
                }
                const auto entry_path =
                    core::json_access::value_or<std::string>(notice, "path", "");
                const auto source_path =
                    core::json_access::value_or<std::string>(notice, "source", "");
                const auto hash =
                    core::json_access::value_or<std::string>(notice, "contentHash", "");
                auto extension = std::filesystem::path(source_path).extension().string();
                std::transform(
                    extension.begin(), extension.end(), extension.begin(),
                    [](unsigned char value) { return static_cast<char>(std::tolower(value)); });
                if (entry_path != "licenses/" + source_path ||
                    !core::ProjectPackageWriter::is_safe_package_path(source_path) ||
                    (extension != ".txt" && extension != ".md") ||
                    (!previous_source_path.empty() && source_path <= previous_source_path) ||
                    core::json_access::value_or<std::string>(notice, "displayName", "").empty() ||
                    hash.size() != 71 || !hash.starts_with("sha256:") ||
                    !declared_notices.insert(entry_path).second) {
                    valid = false;
                    break;
                }
                previous_source_path = source_path;
                auto document = read_package_blob(source, entry_path, logical_path);
                if (!document || document.value_if()->bytes.size() > 1024 * 1024 ||
                    !core::ProjectPackageWriter::is_valid_distribution_notice_text(
                        std::as_bytes(std::span(document.value_if()->bytes))) ||
                    "sha256:" + core::sha256_hex(
                                    std::as_bytes(std::span(document.value_if()->bytes))) !=
                        hash) {
                    valid = false;
                    break;
                }
            }
        }
        for (const auto& entry : *indexed_entries.value)
            if (entry.path.starts_with("licenses/") && !declared_notices.contains(entry.path))
                valid = false;
        if (!valid)
            return core::Result<core::LoadedCompiledPackage, core::Diagnostics>::failure(
                load_failure("content.runtime_notice_invalid",
                             "Runtime Package distribution notice inventory is invalid.",
                             std::string(logical_path)));
    }

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

    // Locale catalogs outside the startup source/default pair are package-local payloads. Validate
    // each detached document against the resident source Message contract, then immediately return
    // to the bounded startup residency set rather than retaining every packaged language.
    const auto startup_catalog_locale =
        startup_runtime_locale(project.value_if()->localization(), requested_runtime_locale);
    for (const auto& locale : project.value_if()->localization().locales) {
        if (!locale.catalog_path)
            continue;
        auto catalog_blob = read_package_blob(source, *locale.catalog_path, logical_path);
        if (!catalog_blob)
            return core::Result<core::LoadedCompiledPackage, core::Diagnostics>::failure(
                std::move(catalog_blob).error());
        const auto& catalog_bytes = catalog_blob.value_if()->bytes;
        const std::string_view catalog_text(reinterpret_cast<const char*>(catalog_bytes.data()),
                                            catalog_bytes.size());
        auto catalog = core::decode_localization_catalog_json(
            catalog_text, package_entry_source(logical_path, *locale.catalog_path));
        if (!catalog)
            return core::Result<core::LoadedCompiledPackage, core::Diagnostics>::failure(
                std::move(catalog).error());
        if (catalog.value_if()->locale != locale.locale)
            return core::Result<core::LoadedCompiledPackage, core::Diagnostics>::failure(
                load_failure(
                    "content.runtime_locale_catalog_mismatch",
                    "Locale catalog identity does not match its compiled locale definition.",
                    package_entry_source(logical_path, *locale.catalog_path)));
        auto installed = project.value_if()->install_runtime_localization_catalog(
            std::move(*catalog.value_if()));
        if (!installed)
            return core::Result<core::LoadedCompiledPackage, core::Diagnostics>::failure(
                std::move(installed).error());
        project.value_if()->retain_runtime_localization_catalogs(startup_catalog_locale);
    }

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

    core::PreparedMediaCatalog prepared_media;
    constexpr std::string_view prepared_media_entry = "assets/.prepared-media/manifest.json";
    if (std::ranges::any_of(*indexed_entries.value, [prepared_media_entry](const auto& entry) {
            return entry.path == prepared_media_entry;
        })) {
        auto prepared_blob = read_package_blob(source, prepared_media_entry, logical_path);
        if (!prepared_blob)
            return core::Result<core::LoadedCompiledPackage, core::Diagnostics>::failure(
                std::move(prepared_blob).error());
        const auto& prepared_bytes = prepared_blob.value_if()->bytes;
        const std::string_view prepared_text(reinterpret_cast<const char*>(prepared_bytes.data()),
                                             prepared_bytes.size());
        auto decoded = core::decode_prepared_media_catalog_json(
            prepared_text, package_entry_source(logical_path, prepared_media_entry));
        if (!decoded)
            return core::Result<core::LoadedCompiledPackage, core::Diagnostics>::failure(
                std::move(decoded).error());
        prepared_media = std::move(*decoded.value_if());
    }

    return core::assemble_compiled_package(
        std::move(*project.value_if()), std::move(*manifest.value_if()),
        std::move(shader_materials), package_inventory(*indexed_entries.value),
        std::move(prepared_media));
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

    auto decoded_package =
        decode_indexed_runtime_package(*package_source, logical_path, runtime_locale);
    if (!decoded_package)
        return core::Result<ResolvedRunningGameSource, core::Diagnostics>::failure(
            std::move(decoded_package).error());

    runtime_locale = startup_runtime_locale(decoded_package.value_if()->project().localization(),
                                            runtime_locale);
    assets::AssetManager::NamespaceMounts project_mounts;
    project_mounts.push_back(std::move(package_source));
    RunningGameLoadInput input{.package = std::move(*decoded_package.value_if()),
                               .runtime_locale = std::move(runtime_locale)};
    return core::Result<ResolvedRunningGameSource, core::Diagnostics>::success(
        ResolvedRunningGameSource{.input = std::move(input),
                                  .project_mounts = std::move(project_mounts),
                                  .replaces_project_namespace = true});
}

void strip_loose_runtime_shader_sources(ShaderMaterialProject& shader_materials)
{
    for (auto& shader : shader_materials.shaders) {
        for (auto& stage : shader.stages) {
            stage.source.path.clear();
            stage.source_text.clear();
        }
    }
}

std::string loose_runtime_package_path(std::string_view path)
{
    constexpr std::string_view project_prefix = "project:/";
    return path.starts_with(project_prefix) ? std::string(path.substr(project_prefix.size()))
                                            : std::string(path);
}

core::Result<RunningGameLoadInput, core::Diagnostics>
make_loose_project_load_input(core::CompiledProject project,
                              std::optional<ShaderMaterialProject> shader_materials,
                              std::string runtime_locale)
{
    if (shader_materials)
        strip_loose_runtime_shader_sources(*shader_materials);
    runtime_locale = startup_runtime_locale(project.localization(), runtime_locale);
    std::vector<core::RuntimePackageFile> files{{"game", 0, std::nullopt}};
    std::unordered_set<std::string> file_paths{"game"};
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
    const auto add_file = [&](std::string package_path) {
        if (!file_paths.insert(package_path).second)
            return;
        manifest.entries.push_back({package_path, 0, std::nullopt});
        files.push_back({std::move(package_path), 0, std::nullopt});
    };
    for (const auto& asset : project.assets())
        add_file(loose_runtime_package_path(asset.path));
    for (const auto& locale : project.localization().locales) {
        if (locale.catalog_path)
            add_file(loose_runtime_package_path(*locale.catalog_path));
    }
    if (shader_materials) {
        std::vector<std::string> variants;
        for (const auto& shader : shader_materials->shaders) {
            for (const auto& stage : shader.stages) {
                for (const auto& binary : stage.compiled) {
                    if (binary.path.starts_with("system:/"))
                        continue;
                    if (std::find(variants.begin(), variants.end(), binary.variant) ==
                        variants.end()) {
                        variants.push_back(binary.variant);
                    }
                    add_file(loose_runtime_package_path(binary.path));
                }
            }
        }
        add_file("shader-materials.json");
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
                               std::move(input.runtime_locale), std::move(input.startup_context));
}

core::Result<std::unique_ptr<RunningGame>, core::Diagnostics>
load_running_game(RunningGameLoadInput input, ScriptRuntimePort& scripts,
                  PresentationRuntimePort& presentation, core::TypedSaveSlotStore& saves)
{
    return load_running_game(std::move(input), scripts, scripts, presentation, saves);
}

} // namespace noveltea::runtime
