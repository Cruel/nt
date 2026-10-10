#include <catch2/catch_test_macros.hpp>

#include <noveltea/core/compiled_package.hpp>
#include <noveltea/core/compiled_package_codec.hpp>
#include <noveltea/core/compiled_project_codec.hpp>
#include <noveltea/core/json_access.hpp>
#include <noveltea/core/player_bootstrap.hpp>

#include "../support/json_test_utils.hpp"

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
      "schema":"noveltea.shader-materials",
      "shaders":{
        "sprite-shader":{
          "display_name":"Sprite",
          "interface_contract":"noveltea.material-preset:engine-2d:1",
          "interface_fingerprint":"sha256:49111ad3e9c928953f510a57100419f761118d42f65bafe1786d56a858ae74b9",
          "roles":["engine-2d"],
          "role_bindings":{},
          "stages":{
            "vertex":{"compiled":{"glsl-330":{"runtimePath":"project:/shaders/bgfx/glsl-330/sprite.vs.bin","byteHash":"sha256:0000000000000000000000000000000000000000000000000000000000000000","byteSize":1}}},
            "fragment":{"compiled":{"glsl-330":{"runtimePath":"project:/shaders/bgfx/glsl-330/sprite.fs.bin","byteHash":"sha256:0000000000000000000000000000000000000000000000000000000000000000","byteSize":1}}}
          },
          "uniforms":{},
          "samplers":{"s_texColor":{"type":"texture2d","stage":0,"binding":null}}
        },
        "layout-shader":{
          "display_name":"Layout",
          "interface_contract":"noveltea.material-preset:rmlui-decorator:1",
          "interface_fingerprint":"sha256:13861c8862bc8406cc2a3575a6a81e504c8f85943b9fcb5f9b4de8bf075245f8",
          "roles":["rmlui-decorator"],
          "role_bindings":{},
          "stages":{
            "vertex":{"compiled":{"glsl-330":{"runtimePath":"project:/shaders/bgfx/glsl-330/sprite.vs.bin","byteHash":"sha256:0000000000000000000000000000000000000000000000000000000000000000","byteSize":1}}},
            "fragment":{"compiled":{"glsl-330":{"runtimePath":"project:/shaders/bgfx/glsl-330/sprite.fs.bin","byteHash":"sha256:0000000000000000000000000000000000000000000000000000000000000000","byteSize":1}}}
          },
          "uniforms":{},
          "samplers":{"s_texColor":{"type":"texture2d","stage":0,"binding":null}}
        }
      },
      "materials":{
        "sprite-material":{
          "display_name":"Sprite",
          "role":"engine-2d",
          "shader":"sprite-shader",
          "uniforms":{},
          "textures":{}
        },
        "layout-material":{
          "display_name":"Layout",
          "role":"rmlui-decorator",
          "shader":"layout-shader",
          "uniforms":{},
          "textures":{}
        },
        "wrong-hotspot-material":{
          "display_name":"Wrong Hotspot",
          "role":"engine-2d",
          "shader":"sprite-shader",
          "uniforms":{},
          "textures":{}
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
        entries.push_back({{"path", "shaders/bgfx/glsl-330/sprite.vs.bin"}, {"size", 10}});
        entries.push_back({{"path", "shaders/bgfx/glsl-330/sprite.fs.bin"}, {"size", 10}});
    }
    nlohmann::json manifest = {
        {"format", "noveltea.runtime-package"},
        {"runtime_api_version", noveltea::core::player_runtime_api_version},
        {"kind", "runtime"},
        {"created_by", "compiled-package-test"},
        {"project", {{"name", project.identity().name}, {"version", project.identity().version}}},
        {"display",
         {{"reference_resolution", {{"width", 1920}, {"height", 1080}}},
          {"world_raster_policy", "capped"},
          {"bar_color", "#000000"}}},
        {"accessibility",
         {{"ui_scale", {{"enabled", true}, {"minimum", 1.0}, {"maximum", 2.0}}},
          {"text_scale", {{"enabled", true}, {"minimum", 1.0}, {"maximum", 2.0}}}}},
        {"shader_variants",
         with_materials ? nlohmann::json::array({"glsl-330"}) : nlohmann::json::array()},
        {"entries", std::move(entries)},
    };
    if (with_materials) {
        manifest["shader_materials"] = {{"entry", "shader-materials.json"},
                                        {"schema", "noveltea.shader-materials"},
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

CompiledProject localized_asset_project(bool use_variant)
{
    auto document = read_json("minimal");
    document["localization"]["sourceLocale"] = "fr";
    document["localization"]["defaultLocale"] = "fr";
    document["localization"]["locales"][0]["locale"] = "fr";
    document["localization"]["catalogs"][0]["locale"] = "fr";
    document["resources"]["assets"] = nlohmann::json::array({
        {{"id", "background"},
         {"kind", "image"},
         {"path", "assets/images/background.png"},
         {"aliases", nlohmann::json::array()},
         {"sampling", "linear"},
         {"width", 1920},
         {"height", 1080},
         {"localized",
          nlohmann::json::array(
              {use_variant ? nlohmann::json{{"locale", "fr"},
                                            {"state", "variant"},
                                            {"asset", {{"kind", "asset"}, {"id", "background-fr"}}}}
                           : nlohmann::json{{"locale", "fr"}, {"state", "source"}}})}},
        {{"id", "background-fr"},
         {"kind", "image"},
         {"path", "assets/images/background-fr.png"},
         {"aliases", nlohmann::json::array()},
         {"sampling", "linear"},
         {"width", 1920},
         {"height", 1080}},
    });
    auto decoded = decode_compiled_project(document, "localized-package-test.json");
    REQUIRE(decoded.has_value());
    return std::move(decoded).value();
}

CompiledProject video_animation_project()
{
    auto document = read_json("minimal");
    document["resources"]["assets"].push_back({{"id", "video-source"},
                                               {"kind", "video"},
                                               {"path", "assets/video/source.mov"},
                                               {"aliases", nlohmann::json::array()}});
    document["resources"]["animations"] = nlohmann::json::array({
        {{"id", "video-animation"},
         {"canvas", {{"width", 320}, {"height", 180}}},
         {"defaultMotionId", "idle"},
         {"motions", nlohmann::json::array({{{"id", "idle"},
                                             {"kind", "video"},
                                             {"video", {{"kind", "asset"}, {"id", "video-source"}}},
                                             {"sourceRange", {{"startMs", 100}, {"endMs", 1100}}},
                                             {"markers", nlohmann::json::array()}}})}},
    });
    auto decoded = decode_compiled_project(document, "video-animation-package-test.json");
    if (!decoded)
        for (const auto& diagnostic : decoded.error())
            WARN(diagnostic.code << ": " << diagnostic.message << " @ " << diagnostic.source_path);
    REQUIRE(decoded.has_value());
    return std::move(decoded).value();
}

PreparedMediaCatalog prepared_video_catalog()
{
    return PreparedMediaCatalog{{PreparedVideoMotion{
        AnimationId::create("video-animation").value(),
        AnimationMotionId::create("idle").value(),
        std::string(64, 'a'),
        {{"assets/.prepared-media/video-animation/idle/a/frame-000000.png", 500},
         {"assets/.prepared-media/video-animation/idle/a/frame-000001.png", 500}}}}};
}

void erase_manifest_entry(nlohmann::json& manifest, std::string_view path)
{
    auto& entries = manifest["entries"];
    for (auto iterator = entries.begin(); iterator != entries.end();) {
        if (iterator->at("path").get<std::string>() == path)
            iterator = entries.erase(iterator);
        else
            ++iterator;
    }
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
    CHECK(shaders.value().shaders.size() == 2);
    CHECK(shaders.value().materials.size() == 3);

    auto unknown_package = package_manifest_for(project, false);
    unknown_package["future"] = true;
    const auto rejected_package = decode_runtime_package_manifest(unknown_package);
    REQUIRE_FALSE(rejected_package.has_value());
    CHECK(has_code(rejected_package.error(), "runtime_package.unknown_field"));

    auto oversized_display = package_manifest_for(project, false);
    oversized_display["display"]["reference_resolution"]["width"] =
        compiled::max_reference_resolution_dimension + 1;
    const auto rejected_display = decode_runtime_package_manifest(oversized_display);
    REQUIRE_FALSE(rejected_display.has_value());
    CHECK(has_code(rejected_display.error(), "runtime_package.out_of_range"));

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

TEST_CASE("private prepared media decodes strictly and assembles only for matching video motions")
{
    const auto prepared_json = R"json({
      "schema":"noveltea.private.prepared-media",
      "version":1,
      "motions":[{
        "animationId":"video-animation",
        "motionId":"idle",
        "representation":"opaque-vp9-webm",
        "contentHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "browserVideo":{"path":"assets/.prepared-media/video-animation/idle/a/opaque.webm","width":320,"height":180},
        "frames":[
          {"durationMs":500},
          {"durationMs":500}
        ]
      }]
    })json";
    auto decoded = decode_prepared_media_catalog_json(prepared_json, "prepared-media.json");
    REQUIRE(decoded.has_value());
    REQUIRE(decoded.value().motions.size() == 1);
    CHECK(decoded.value().motions.front().frames.size() == 2);

    auto obsolete = nlohmann::json::parse(prepared_json);
    obsolete.erase("version");
    CHECK_FALSE(decode_prepared_media_catalog_json(obsolete.dump(), "prepared-media.json"));
    obsolete = nlohmann::json::parse(prepared_json);
    obsolete["motions"][0].erase("browserVideo");
    CHECK_FALSE(decode_prepared_media_catalog_json(obsolete.dump(), "prepared-media.json"));
    obsolete = nlohmann::json::parse(prepared_json);
    obsolete["version"] = 0;
    CHECK_FALSE(decode_prepared_media_catalog_json(obsolete.dump(), "prepared-media.json"));

    auto unknown_representation = nlohmann::json::parse(prepared_json);
    unknown_representation["motions"][0]["representation"] = "future-codec";
    auto rejected =
        decode_prepared_media_catalog_json(unknown_representation.dump(), "prepared-media.json");
    REQUIRE_FALSE(rejected.has_value());
    CHECK(has_code(rejected.error(), "prepared_media.unknown_value"));

    auto project = video_animation_project();
    auto manifest_json = package_manifest_for(project, false);
    const auto prepared = decoded.value();
    CHECK(prepared.motions.front().browser_video->width == 320);
    manifest_json["entries"].push_back(
        {{"path", prepared.motions.front().browser_video->path}, {"size", 10}});
    auto manifest = decode_runtime_package_manifest(manifest_json);
    REQUIRE(manifest.has_value());
    auto inventory = inventory_for(manifest.value());

    auto missing = assemble_compiled_package(project, manifest.value(), std::nullopt, inventory);
    REQUIRE_FALSE(missing.has_value());
    CHECK(has_code(missing.error(), "runtime_package.missing_prepared_video_motion"));

    auto wrong_canvas = prepared;
    wrong_canvas.motions.front().browser_video->width = 1;
    auto invalid =
        assemble_compiled_package(project, manifest.value(), std::nullopt, inventory, wrong_canvas);
    REQUIRE_FALSE(invalid.has_value());
    CHECK(has_code(invalid.error(), "runtime_package.invalid_browser_video"));
    auto missing_browser = manifest_json;
    erase_manifest_entry(missing_browser, prepared.motions.front().browser_video->path);
    auto missing_browser_manifest = decode_runtime_package_manifest(missing_browser);
    REQUIRE(missing_browser_manifest.has_value());
    invalid = assemble_compiled_package(project, missing_browser_manifest.value(), std::nullopt,
                                        inventory_for(missing_browser_manifest.value()), prepared);
    REQUIRE_FALSE(invalid.has_value());
    CHECK(has_code(invalid.error(), "runtime_package.invalid_browser_video"));

    auto assembled = assemble_compiled_package(std::move(project), std::move(manifest).value(),
                                               std::nullopt, std::move(inventory), prepared);
    REQUIRE(assembled.has_value());
    CHECK(assembled.value().prepared_media().motions.size() == 1);
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

TEST_CASE("compiled package accepts system-owned preset shader binaries outside the package")
{
    auto project = decode_project("comprehensive");
    auto manifest = decode_runtime_package_manifest(package_manifest_for(project, true));
    REQUIRE(manifest.has_value());
    auto shader_document = shader_manifest();
    shader_document["shaders"]["layout-shader"]["stages"]["vertex"]["compiled"]["glsl-330"] = {
        {"runtimePath", "system:/shaders/bgfx/glsl-330/rmlui_noise_panel.vs.bin"}};
    shader_document["shaders"]["layout-shader"]["stages"]["fragment"]["compiled"]["glsl-330"] = {
        {"runtimePath", "system:/shaders/bgfx/glsl-330/rmlui_noise_panel.fs.bin"}};
    auto shaders = decode_shader_material_manifest(shader_document);
    REQUIRE(shaders.has_value());
    auto files = inventory_for(manifest.value());

    auto loaded = assemble_compiled_package(std::move(project), std::move(manifest).value(),
                                            std::move(shaders).value(), std::move(files));
    REQUIRE(loaded.has_value());
}

TEST_CASE("runtime package may omit localized base asset unused by supported locales")
{
    auto project = localized_asset_project(true);
    auto document = package_manifest_for(project, false);
    erase_manifest_entry(document, "assets/images/background.png");
    auto manifest = decode_runtime_package_manifest(document);
    REQUIRE(manifest.has_value());
    auto files = inventory_for(manifest.value());

    auto loaded = assemble_compiled_package(std::move(project), std::move(manifest).value(),
                                            std::nullopt, std::move(files));
    REQUIRE(loaded.has_value());
    auto background = AssetId::create("background");
    REQUIRE(background.has_value());
    const auto* resolved = loaded.value().project().resolve_asset(background.value(), "fr");
    REQUIRE(resolved != nullptr);
    CHECK(resolved->id.text() == "background-fr");
}

TEST_CASE("runtime package still requires localized base asset used by a supported locale")
{
    auto project = localized_asset_project(false);
    auto document = package_manifest_for(project, false);
    erase_manifest_entry(document, "assets/images/background.png");
    auto manifest = decode_runtime_package_manifest(document);
    REQUIRE(manifest.has_value());
    auto files = inventory_for(manifest.value());

    auto loaded = assemble_compiled_package(std::move(project), std::move(manifest).value(),
                                            std::nullopt, std::move(files));
    REQUIRE_FALSE(loaded.has_value());
    CHECK(has_code(loaded.error(), "runtime_package.missing_asset"));
}

TEST_CASE("compiled package validates every localized ActiveText Material occurrence")
{
    auto document = read_json("minimal");
    auto french_locale = document["localization"]["locales"][0];
    french_locale["locale"] = "fr";
    french_locale["nativeName"] = "Français";
    french_locale["displayName"] = "French";
    document["localization"]["locales"].push_back(std::move(french_locale));
    auto french_catalog = document["localization"]["catalogs"][0];
    french_catalog["locale"] = "fr";
    french_catalog["entries"][0]["value"] = "[mat id=missing/material]Texte[/mat]";
    document["localization"]["catalogs"].push_back(std::move(french_catalog));

    auto decoded = decode_compiled_project(document, "localized-active-text.json");
    REQUIRE(decoded.has_value());
    auto project = std::move(decoded).value();
    auto manifest = decode_runtime_package_manifest(package_manifest_for(project, true));
    REQUIRE(manifest.has_value());
    auto shaders = decode_shader_material_manifest(shader_manifest());
    REQUIRE(shaders.has_value());
    auto files = inventory_for(manifest.value());

    auto loaded = assemble_compiled_package(std::move(project), std::move(manifest).value(),
                                            std::move(shaders).value(), std::move(files));
    REQUIRE_FALSE(loaded.has_value());
    CHECK(has_code(loaded.error(), "runtime_package.active_text_unknown_material_ref"));
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

    SECTION("hotspot highlight material has the wrong role")
    {
        auto document = read_json("interaction-program");
        auto* coin =
            test_support::json_object_by_id(document["definitions"]["interactables"], "coin");
        REQUIRE(coin != nullptr);
        (*coin)["presentation"]["hotspots"]["hotspots"][0]["highlight"]["material"]["id"] =
            "wrong-hotspot-material";
        document["resources"]["materialInterfaces"].push_back(
            {{"id", "wrong-hotspot-material"},
             {"role", "hotspot-overlay"},
             {"parameters", nlohmann::json::array()}});
        auto decoded = decode_compiled_project(document, "interaction-program.json");
        REQUIRE(decoded.has_value());
        auto project = std::move(decoded).value();
        auto manifest = decode_runtime_package_manifest(package_manifest_for(project, true));
        REQUIRE(manifest.has_value());
        auto shaders = decode_shader_material_manifest(shader_manifest());
        REQUIRE(shaders.has_value());
        auto files = inventory_for(manifest.value());
        auto loaded = assemble_compiled_package(std::move(project), std::move(manifest).value(),
                                                std::move(shaders).value(), std::move(files));
        REQUIRE_FALSE(loaded.has_value());
        CHECK(has_code(loaded.error(), "runtime_package.invalid_hotspot_material_role"));
    }
}
