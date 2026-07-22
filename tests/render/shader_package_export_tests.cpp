#include <catch2/catch_test_macros.hpp>

#include <nlohmann/json.hpp>

#include <noveltea/core/package_export.hpp>
#include <noveltea/render/material.hpp>
#include <noveltea/render/material_codec.hpp>
#include <noveltea/render/shader_manifest.hpp>

#include <algorithm>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <set>
#include <span>
#include <string>
#include <vector>

#define MINIZ_NO_ZLIB_APIS
#if __has_include(<miniz/miniz.h>)
#include <miniz/miniz.h>
#else
#include <miniz.h>
#endif

using namespace noveltea;
using namespace noveltea::core;

namespace {

std::filesystem::path unique_temp_dir(std::string_view prefix)
{
    const auto now = std::chrono::steady_clock::now().time_since_epoch().count();
    auto path =
        std::filesystem::temp_directory_path() / (std::string(prefix) + "-" + std::to_string(now));
    std::filesystem::create_directories(path);
    return path;
}

void write_file(const std::filesystem::path& path, std::string_view text)
{
    std::filesystem::create_directories(path.parent_path());
    std::ofstream file(path, std::ios::binary);
    REQUIRE(file.good());
    file.write(text.data(), static_cast<std::streamsize>(text.size()));
    REQUIRE(file.good());
}

nlohmann::json make_material_metadata()
{
    return nlohmann::json::parse(R"json({
      "schema":"noveltea.shader-materials.v1",
      "shaders":{
        "ui/noise_panel":{
          "display_name":"Packaged RmlUi Noise Panel",
          "roles":["rmlui-decorator"],
          "stages":{
            "vertex":{
              "source":"shaders/source/noise.vs.sc",
              "source_text":"void main() {}",
              "compiled":{
                "glsl-120":"shaders/bgfx/glsl-120/ui/noise_panel.vs.bin",
                "essl-300":"shaders/bgfx/essl-300/ui/noise_panel.vs.bin"
              }
            },
            "fragment":{
              "source":"shaders/source/noise.fs.sc",
              "source_text":"void main() {}",
              "compiled":{
                "glsl-120":"shaders/bgfx/glsl-120/ui/noise_panel.fs.bin",
                "essl-300":"shaders/bgfx/essl-300/ui/noise_panel.fs.bin"
              }
            }
          },
          "uniforms":{
            "u_dimensions":{"type":"vec2","binding":"rmlui.paint_dimensions"}
          }
        }
      },
      "materials":{
        "ui/noise_panel":{"role":"rmlui-decorator","shader":"ui/noise_panel"}
      }
    })json");
}

std::set<std::string> required_paths_for(const ShaderMaterialProject& project,
                                         std::initializer_list<std::string_view> variants)
{
    std::set<std::string> required;
    for (const auto& material : project.materials) {
        for (std::string_view variant : variants) {
            auto resolved = resolve_material_shader_program(project, material.id, variant);
            REQUIRE(resolved.program.has_value());
            required.insert(resolved.program->vertex.path);
            required.insert(resolved.program->fragment.path);
        }
    }
    return required;
}

void write_required_shader_bins(const std::filesystem::path& root,
                                const std::set<std::string>& required)
{
    for (const std::string& path : required) {
        write_file(root / path, "shader-bytes:" + path);
    }
}

nlohmann::json make_project()
{
    std::ifstream fixture(std::filesystem::path(NOVELTEA_SOURCE_DIR) /
                          "editor/src/renderer/test/fixtures/compiled-project-golden/minimal.json");
    REQUIRE(fixture.good());
    auto project = nlohmann::json::parse(fixture, nullptr, false);
    REQUIRE_FALSE(project.is_discarded());
    return project;
}

std::map<std::string, std::vector<std::byte>> read_package_entries(std::span<const std::byte> bytes)
{
    mz_zip_archive archive{};
    REQUIRE(mz_zip_reader_init_mem(&archive, bytes.data(), bytes.size(), 0));
    std::map<std::string, std::vector<std::byte>> entries;
    const auto count = mz_zip_reader_get_num_files(&archive);
    for (mz_uint index = 0; index < count; ++index) {
        mz_zip_archive_file_stat stat{};
        REQUIRE(mz_zip_reader_file_stat(&archive, index, &stat));
        size_t size = 0;
        void* data = mz_zip_reader_extract_to_heap(&archive, index, &size, 0);
        REQUIRE(data != nullptr);
        const auto* first = static_cast<const std::byte*>(data);
        entries.emplace(stat.m_filename, std::vector<std::byte>(first, first + size));
        mz_free(data);
    }
    REQUIRE(mz_zip_reader_end(&archive));
    return entries;
}

} // namespace

TEST_CASE("ProjectPackageWriter exports runtime shader material metadata and required variants")
{
    const nlohmann::json metadata = make_material_metadata();
    const auto parsed = parse_shader_material_project_json_value(metadata);
    REQUIRE(parsed.project.has_value());
    REQUIRE_FALSE(parsed.has_errors());

    const auto temp = unique_temp_dir("material-package-export");
    const auto required = required_paths_for(*parsed.project, {"glsl-120", "essl-300"});
    write_required_shader_bins(temp / "shaders", required);

    PackageExportOptions options;
    options.project_name = "Material Package";
    options.project_version = "1.0";
    options.created_by = "test";
    options.display = nlohmann::json{{"reference_resolution", {{"width", 1920}, {"height", 1080}}},
                                     {"world_raster_policy", "capped"},
                                     {"bar_color", "#000000"}};
    options.accessibility =
        nlohmann::json{{"ui_scale", {{"enabled", true}, {"minimum", 1.0}, {"maximum", 2.0}}},
                       {"text_scale", {{"enabled", true}, {"minimum", 1.0}, {"maximum", 2.0}}}};
    options.shader_asset_root = temp / "shaders";
    options.shader_variants = {"glsl-120", "essl-300"};
    options.shader_material_metadata = metadata;
    options.required_shader_binary_paths = required;

    std::vector<std::byte> bytes;
    const auto exported = ProjectPackageWriter::write_to_memory(make_project(), options, bytes);
    REQUIRE(exported.success);
    CHECK(exported.diagnostics.empty());
    CHECK(exported.checksums.contains("shader-materials.json"));
    CHECK(exported.manifest["shader_materials"]["entry"] == "shader-materials.json");
    CHECK(exported.manifest["shader_materials"]["sources_stripped"] == true);

    const auto entries = read_package_entries(bytes);
    REQUIRE(entries.contains("shader-materials.json"));
    for (const std::string& path : required) {
        CHECK(entries.contains(path));
    }

    const auto& metadata_bytes = entries.at("shader-materials.json");
    const std::string metadata_text(reinterpret_cast<const char*>(metadata_bytes.data()),
                                    metadata_bytes.size());
    const auto runtime_metadata = nlohmann::json::parse(metadata_text);
    CHECK(runtime_metadata["shaders"]["ui/noise_panel"]["stages"]["vertex"].find("source") ==
          runtime_metadata["shaders"]["ui/noise_panel"]["stages"]["vertex"].end());
    CHECK(runtime_metadata["shaders"]["ui/noise_panel"]["stages"]["vertex"].find("source_text") ==
          runtime_metadata["shaders"]["ui/noise_panel"]["stages"]["vertex"].end());

    const auto reparsed = parse_shader_material_project_json(metadata_text);
    REQUIRE(reparsed.project.has_value());
    CHECK_FALSE(reparsed.has_errors());
    const auto resolved = resolve_material_shader_program(*reparsed.project,
                                                          MaterialId("ui/noise_panel"), "essl-300");
    REQUIRE(resolved.program.has_value());
    CHECK(resolved.program->vertex.path == "shaders/bgfx/essl-300/ui/noise_panel.vs.bin");

    std::filesystem::remove_all(temp);
}

TEST_CASE("ProjectPackageWriter fails when required material shader binaries are missing")
{
    const nlohmann::json metadata = make_material_metadata();
    const auto parsed = parse_shader_material_project_json_value(metadata);
    REQUIRE(parsed.project.has_value());

    const auto temp = unique_temp_dir("material-package-missing");
    const auto required = required_paths_for(*parsed.project, {"glsl-120", "essl-300"});
    for (const std::string& path : required) {
        if (path != "shaders/bgfx/essl-300/ui/noise_panel.fs.bin") {
            write_file(temp / "shaders" / path, "shader-bytes:" + path);
        }
    }

    PackageExportOptions options;
    options.project_name = "Material Package";
    options.project_version = "1.0";
    options.display = nlohmann::json{{"reference_resolution", {{"width", 1920}, {"height", 1080}}},
                                     {"world_raster_policy", "capped"},
                                     {"bar_color", "#000000"}};
    options.accessibility =
        nlohmann::json{{"ui_scale", {{"enabled", true}, {"minimum", 1.0}, {"maximum", 2.0}}},
                       {"text_scale", {{"enabled", true}, {"minimum", 1.0}, {"maximum", 2.0}}}};
    options.shader_asset_root = temp / "shaders";
    options.shader_variants = {"glsl-120", "essl-300"};
    options.shader_material_metadata = metadata;
    options.required_shader_binary_paths = required;

    std::vector<std::byte> bytes;
    const auto exported = ProjectPackageWriter::write_to_memory(make_project(), options, bytes);
    CHECK_FALSE(exported.success);
    CHECK(bytes.empty());
    REQUIRE_FALSE(exported.diagnostics.empty());
    CHECK(std::any_of(exported.diagnostics.begin(), exported.diagnostics.end(),
                      [](const auto& diagnostic) {
                          return diagnostic.category == "shader" &&
                                 diagnostic.path == "shaders/bgfx/essl-300/ui/noise_panel.fs.bin";
                      }));

    std::filesystem::remove_all(temp);
}
