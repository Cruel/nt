#include <catch2/catch_test_macros.hpp>

#include <noveltea/core/compiled_package.hpp>
#include <noveltea/core/compiled_project_codec.hpp>
#include <noveltea/core/json_access.hpp>

#include <nlohmann/json.hpp>

#include <fstream>
#include <iterator>
#include <string>
#include <string_view>
#include <vector>

using namespace noveltea;
using namespace noveltea::core;

namespace {

nlohmann::json read_json(std::string_view name)
{
    const std::string path = std::string(NOVELTEA_SOURCE_DIR) +
                             "/editor/src/renderer/test/fixtures/compiled-project-golden/" +
                             std::string(name) + ".json";
    std::ifstream file(path, std::ios::binary);
    REQUIRE(file.good());
    const std::string text((std::istreambuf_iterator<char>(file)),
                           std::istreambuf_iterator<char>());
    auto value = nlohmann::json::parse(text, nullptr, false);
    REQUIRE_FALSE(value.is_discarded());
    return value;
}

CompiledProject decode_project(std::string_view name)
{
    auto decoded = decode_compiled_project(read_json(name), std::string(name) + ".json");
    REQUIRE(decoded.has_value());
    return std::move(decoded).value();
}

nlohmann::json shader_manifest()
{
    return nlohmann::json::parse(R"json({
      "schema":"noveltea.shader-materials.v1",
      "shaders":{
        "sprite-shader":{
          "display_name":"Sprite",
          "roles":["engine-2d"],
          "stages":{
            "vertex":{"compiled":{"glsl-120":"shaders/bgfx/glsl-120/sprite.vs.bin"}},
            "fragment":{"compiled":{"glsl-120":"shaders/bgfx/glsl-120/sprite.fs.bin"}}
          },
          "uniforms":{},
          "samplers":{}
        }
      },
      "materials":{
        "sprite-material":{
          "display_name":"Sprite",
          "role":"engine-2d",
          "shader":"sprite-shader",
          "uniforms":{},
          "textures":{},
          "blend":"premultiplied-alpha"
        }
      }
    })json");
}

nlohmann::json package_manifest_for(const CompiledProject& project, bool with_materials)
{
    nlohmann::json entries = nlohmann::json::array({{{"path", "game"}, {"size", 10}}});
    for (const auto& asset : project.assets())
        entries.push_back({{"path", asset.path}, {"size", 10}});
    if (with_materials) {
        entries.push_back({{"path", "shader-materials.json"}, {"size", 10}});
        entries.push_back({{"path", "shaders/bgfx/glsl-120/sprite.vs.bin"}, {"size", 10}});
        entries.push_back({{"path", "shaders/bgfx/glsl-120/sprite.fs.bin"}, {"size", 10}});
    }
    nlohmann::json manifest = {
        {"format", "noveltea.runtime-package"},
        {"format_version", 1},
        {"kind", "runtime"},
        {"created_by", "compiled-package-test"},
        {"project", {{"name", project.identity().name}, {"version", project.identity().version}}},
        {"shader_variants",
         with_materials ? nlohmann::json::array({"glsl-120"}) : nlohmann::json::array()},
        {"entries", std::move(entries)},
    };
    if (with_materials) {
        manifest["shader_materials"] = {{"entry", "shader-materials.json"},
                                        {"schema", "noveltea.shader-materials.v1"},
                                        {"sources_stripped", true}};
    }
    return manifest;
}

std::vector<RuntimePackageFile> inventory_for(const RuntimePackageManifest& manifest)
{
    std::vector<RuntimePackageFile> files;
    for (const auto& entry : manifest.entries)
        files.push_back({entry.path, entry.size, entry.checksum});
    return files;
}

bool has_code(const Diagnostics& diagnostics, std::string_view code)
{
    for (const auto& diagnostic : diagnostics)
        if (diagnostic.code == code)
            return true;
    return false;
}

} // namespace

TEST_CASE("strict package and shader manifests decode separately")
{
    auto project = decode_project("minimal");
    auto manifest = decode_runtime_package_manifest(package_manifest_for(project, false));
    REQUIRE(manifest.has_value());
    CHECK(manifest.value().entries.size() == 1);
    CHECK_FALSE(manifest.value().shader_materials.has_value());

    auto shaders = decode_shader_material_manifest(shader_manifest());
    REQUIRE(shaders.has_value());
    CHECK(shaders.value().shaders.size() == 1);
    CHECK(shaders.value().materials.size() == 1);

    auto unknown_package = package_manifest_for(project, false);
    unknown_package["future"] = true;
    const auto rejected_package = decode_runtime_package_manifest(unknown_package);
    REQUIRE_FALSE(rejected_package.has_value());
    CHECK(has_code(rejected_package.error(), "runtime_package.unknown_field"));

    auto unknown_shader = shader_manifest();
    unknown_shader["materials"]["sprite-material"]["future"] = true;
    const auto rejected_shader = decode_shader_material_manifest(unknown_shader);
    REQUIRE_FALSE(rejected_shader.has_value());
    CHECK(has_code(rejected_shader.error(), "shader_material.unknown_field"));

    auto missing_shader = shader_manifest();
    missing_shader["materials"]["sprite-material"]["shader"] = "missing-shader";
    const auto rejected_reference = decode_shader_material_manifest(missing_shader);
    REQUIRE_FALSE(rejected_reference.has_value());
    CHECK(has_code(rejected_reference.error(), "shader_material.unknown_shader_ref"));
}

TEST_CASE("package manifest rejects unsafe paths and malformed checksums")
{
    auto project = decode_project("minimal");
    auto unsafe = package_manifest_for(project, false);
    unsafe["entries"][0]["path"] = "../game";
    const auto unsafe_result = decode_runtime_package_manifest(unsafe);
    REQUIRE_FALSE(unsafe_result.has_value());
    CHECK(has_code(unsafe_result.error(), "runtime_package.invalid_path"));

    auto checksum = package_manifest_for(project, false);
    checksum["checksums"] = {{"game", "NOT-CRC"}};
    const auto checksum_result = decode_runtime_package_manifest(checksum);
    REQUIRE_FALSE(checksum_result.has_value());
    CHECK(has_code(checksum_result.error(), "runtime_package.invalid_checksum"));
}

TEST_CASE("compiled package assembles gameplay and prepared resource registries")
{
    auto project = decode_project("comprehensive");
    auto manifest = decode_runtime_package_manifest(package_manifest_for(project, true));
    REQUIRE(manifest.has_value());
    auto shaders = decode_shader_material_manifest(shader_manifest());
    REQUIRE(shaders.has_value());
    auto files = inventory_for(manifest.value());

    auto loaded = assemble_compiled_package(std::move(project), std::move(manifest).value(),
                                            std::move(shaders).value(), std::move(files));
    REQUIRE(loaded.has_value());
    auto image_id = AssetId::create("image-main");
    auto layout_id = LayoutId::create("hud-inline");
    auto script_id = ScriptId::create("inline-module");
    auto material_id = noveltea::core::MaterialId::create("sprite-material");
    REQUIRE(image_id.has_value());
    REQUIRE(layout_id.has_value());
    REQUIRE(script_id.has_value());
    REQUIRE(material_id.has_value());
    CHECK(loaded.value().resources().find_asset(image_id.value()) != nullptr);
    CHECK(loaded.value().resources().find_layout(layout_id.value()) != nullptr);
    CHECK(loaded.value().resources().find_script(script_id.value()) != nullptr);
    CHECK(loaded.value().resources().find_material(material_id.value()) != nullptr);
    REQUIRE(loaded.value().resources().find_asset_by_alias("main-image") != nullptr);
    CHECK(loaded.value().resources().find_asset_by_alias("main-image")->id.text() == "image-main");
}

TEST_CASE("compiled package rejects inventory and cross-document reference failures")
{
    SECTION("checksum mismatch")
    {
        auto project = decode_project("minimal");
        auto document = package_manifest_for(project, false);
        document["checksums"] = {{"game", "1234abcd"}};
        auto manifest = decode_runtime_package_manifest(document);
        REQUIRE(manifest.has_value());
        auto files = inventory_for(manifest.value());
        files[0].checksum = "deadbeef";
        auto loaded = assemble_compiled_package(std::move(project), std::move(manifest).value(),
                                                std::nullopt, std::move(files));
        REQUIRE_FALSE(loaded.has_value());
        CHECK(has_code(loaded.error(), "runtime_package.checksum_mismatch"));
    }

    SECTION("missing gameplay material")
    {
        auto project = decode_project("comprehensive");
        auto manifest = decode_runtime_package_manifest(package_manifest_for(project, false));
        REQUIRE(manifest.has_value());
        auto files = inventory_for(manifest.value());
        auto loaded = assemble_compiled_package(std::move(project), std::move(manifest).value(),
                                                std::nullopt, std::move(files));
        REQUIRE_FALSE(loaded.has_value());
        CHECK(has_code(loaded.error(), "runtime_package.missing_gameplay_material"));
    }

    SECTION("missing compiled shader binary")
    {
        auto project = decode_project("minimal");
        auto manifest = decode_runtime_package_manifest(package_manifest_for(project, true));
        REQUIRE(manifest.has_value());
        auto shaders = decode_shader_material_manifest(shader_manifest());
        REQUIRE(shaders.has_value());
        auto files = inventory_for(manifest.value());
        files.erase(files.end() - 1);
        auto loaded = assemble_compiled_package(std::move(project), std::move(manifest).value(),
                                                std::move(shaders).value(), std::move(files));
        REQUIRE_FALSE(loaded.has_value());
        CHECK(has_code(loaded.error(), "runtime_package.missing_entry"));
    }
}
