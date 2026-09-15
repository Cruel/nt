#include "tooling_native.hpp"

#include <catch2/catch_test_macros.hpp>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <string>
#include <system_error>

namespace {

nlohmann::json load_minimal_compiled_project()
{
    const auto path = std::filesystem::path(NOVELTEA_SOURCE_DIR) /
                      "editor/src/renderer/test/fixtures/compiled-project-golden/minimal.json";
    std::ifstream stream(path);
    REQUIRE(stream.good());
    return nlohmann::json::parse(stream);
}

nlohmann::json run_playback(nlohmann::json step_expectations,
                            nlohmann::json final_expectations = nlohmann::json::array())
{
    const nlohmann::json request = {
        {"project", load_minimal_compiled_project()},
        {"spec",
         {{"schema", "noveltea.editor.playback"},
          {"version", 1},
          {"id", "expectations"},
          {"steps",
           nlohmann::json::array({{{"index", 0},
                                   {"input", {{"type", "advance-time"}, {"microseconds", 0}}},
                                   {"expectations", std::move(step_expectations)}}})},
          {"finalExpectations", std::move(final_expectations)}}},
    };
    const auto result = noveltea::tooling::run_headless_test(request.dump());
    REQUIRE(result.exit_code == 0);
    const auto response = nlohmann::json::parse(result.response_json, nullptr, false);
    REQUIRE_FALSE(response.is_discarded());
    REQUIRE(response.value("ok", false));
    REQUIRE(response.contains("report"));
    return response["report"];
}

} // namespace

TEST_CASE("native semantic playback evaluates typed expectations after a settled step")
{
    const auto report = run_playback(nlohmann::json::array(
        {{{"id", "room"}, {"type", "current-room"}, {"operator", "eq"}, {"roomId", "start"}},
         {{"id", "no-error"},
          {"type", "diagnostic"},
          {"operator", "absent"},
          {"code", "runtime.synthetic"}}}));

    CHECK(report["passed"] == true);
    REQUIRE(report["steps"].size() == 1);
    REQUIRE(report["steps"][0]["expectations"].size() == 2);
    CHECK(report["steps"][0]["expectations"][0]["id"] == "room");
    CHECK(report["steps"][0]["expectations"][0]["passed"] == true);
    CHECK(report["steps"][0]["expectations"][1]["passed"] == true);
}

TEST_CASE("native semantic playback reports failed step and final expectations deterministically")
{
    const auto report = run_playback(nlohmann::json::array({{{"id", "wrong-room"},
                                                             {"type", "current-room"},
                                                             {"operator", "eq"},
                                                             {"roomId", "elsewhere"}}}),
                                     nlohmann::json::array({{{"id", "final-room"},
                                                             {"type", "current-room"},
                                                             {"operator", "eq"},
                                                             {"roomId", "elsewhere"}}}));

    CHECK(report["passed"] == false);
    CHECK(report["steps"][0]["expectations"][0]["passed"] == false);
    CHECK(report["steps"][0]["expectations"][0]["message"] == "Current Room did not match.");
    REQUIRE(report["finalExpectations"].size() == 1);
    CHECK(report["finalExpectations"][0]["passed"] == false);
}

TEST_CASE(
    "native UI playback drives file-backed RmlUi selector input into authoritative gameplay state")
{
    const auto path =
        std::filesystem::path(NOVELTEA_SOURCE_DIR) /
        "editor/src/renderer/test/fixtures/compiled-project-golden/canonical-layout-signal.json";
    std::ifstream stream(path);
    REQUIRE(stream.good());
    auto project = nlohmann::json::parse(stream);

    const auto nonce = std::chrono::steady_clock::now().time_since_epoch().count();
    const auto project_root =
        std::filesystem::temp_directory_path() / ("noveltea-ui-playback-" + std::to_string(nonce));
    std::error_code cleanup_error;
    std::filesystem::remove_all(project_root, cleanup_error);
    struct TempProjectCleanup {
        std::filesystem::path root;
        ~TempProjectCleanup()
        {
            std::error_code error;
            std::filesystem::remove_all(root, error);
        }
    } cleanup{project_root};
    auto write_source = [&](const std::filesystem::path& relative, std::string_view text) {
        const auto target = project_root / relative;
        std::filesystem::create_directories(target.parent_path());
        std::ofstream output(target, std::ios::binary | std::ios::trunc);
        REQUIRE(output.good());
        output << text;
    };
    write_source("assets/ui/layout.rml", R"RML(<rml>
<head><style>body { width: 640px; height: 360px; } button { width: 180px; height: 48px; }</style></head>
<body><button id="confirm" onclick="layout_test.confirm(event, element, document)">Confirm</button></body>
</rml>)RML");
    write_source("assets/ui/layout.rcss", "");
    std::filesystem::create_directories(project_root / "assets/fonts");
    std::filesystem::copy_file(std::filesystem::path(NOVELTEA_SOURCE_DIR) /
                                   "engine/assets/system/fonts/LiberationSans.ttf",
                               project_root / "assets/fonts/main.ttf",
                               std::filesystem::copy_options::overwrite_existing);
    write_source("assets/scripts/layout.lua", R"LUA(
layout_test = layout_test or {}
function layout_test.confirm(event, element, document)
  local context = Game.mount_context()
  assert(context ~= nil)
  local ok, err = context:signal('confirm', { accepted = true })
  assert(ok, err)
end
return {}
)LUA");

    auto& layouts = project["resources"]["layouts"];
    auto layout = std::find_if(layouts.begin(), layouts.end(), [](const auto& candidate) {
        return candidate.value("id", std::string{}) == "stateful-overlay";
    });
    REQUIRE(layout != layouts.end());
    (*layout)["rml"] = {{"kind", "asset"}, {"asset", {{"kind", "asset"}, {"id", "text-rml"}}}};
    (*layout)["rcss"] = {{"kind", "asset"}, {"asset", {{"kind", "asset"}, {"id", "text-rcss"}}}};
    (*layout)["lua"] = {{"kind", "asset"}, {"asset", {{"kind", "asset"}, {"id", "script-layout"}}}};
    (*layout)["script"] = {{"enabled", true}, {"namespace", "layout_test"}};
    (*layout)["dependencies"] = {
        {"fonts", nlohmann::json::array()},
        {"images", nlohmann::json::array()},
        {"materials", nlohmann::json::array()},
        {"scripts", nlohmann::json::array({{{"kind", "asset"}, {"id", "script-layout"}}})},
        {"stylesheets", nlohmann::json::array({{{"kind", "asset"}, {"id", "text-rcss"}}})},
        {"data", nlohmann::json::array()},
    };

    // Keep the fixture's unrelated title Layout inert so this test isolates the file-backed
    // gameplay Layout while still leaving the asset-backed Script Module available for runtime
    // certification through the same project-root mount.
    for (auto& candidate : layouts) {
        if (candidate.value("id", std::string{}) != "hud-assets")
            continue;
        candidate["dependencies"] = {
            {"fonts", nlohmann::json::array()},       {"images", nlohmann::json::array()},
            {"materials", nlohmann::json::array()},   {"scripts", nlohmann::json::array()},
            {"stylesheets", nlohmann::json::array()}, {"data", nlohmann::json::array()}};
        candidate["rml"] = {{"kind", "inline"}, {"text", "<div></div>"}};
        candidate["rcss"] = {{"kind", "inline"}, {"text", ""}};
        candidate["lua"] = {{"kind", "inline"}, {"text", ""}};
        candidate["script"]["enabled"] = false;
    }

    const auto shader_materials = nlohmann::json::parse(R"json({
      "schema":"noveltea.shader-materials",
      "shaders":{"sprite-shader":{"display_name":"Sprite","roles":["engine-2d"],"role_bindings":{},
        "stages":{"vertex":{"compiled":{"glsl-120":{"runtimePath":"project:/shaders/bgfx/glsl-120/sprite.vs.bin","byteHash":"sha256:0000000000000000000000000000000000000000000000000000000000000000","byteSize":1}}},
                  "fragment":{"compiled":{"glsl-120":{"runtimePath":"project:/shaders/bgfx/glsl-120/sprite.fs.bin","byteHash":"sha256:0000000000000000000000000000000000000000000000000000000000000000","byteSize":1}}}},
        "uniforms":{},"samplers":{}}},
      "materials":{"sprite-material":{"display_name":"Sprite","role":"engine-2d",
        "shader":"sprite-shader","uniforms":{},"textures":{},
        "blend":"premultiplied-alpha"}}
    })json");
    const nlohmann::json request = {
        {"project", std::move(project)},
        {"projectRoot", project_root.generic_string()},
        {"shaderMaterialMetadata", shader_materials},
        {"spec",
         {{"schema", "noveltea.editor.playback"},
          {"version", 1},
          {"id", "ui-layout-signal"},
          {"steps", nlohmann::json::array(
                        {{{"index", 0},
                          {"input",
                           {{"type", "ui-click"},
                            {"documentId", "layout_stateful-overlay_instance_1_realization_1"},
                            {"selector", "#confirm"}}},
                          {"expectations", nlohmann::json::array({{{"id", "signal-mutated-count"},
                                                                   {"type", "property"},
                                                                   {"operator", "eq"},
                                                                   {"scope", "global"},
                                                                   {"ownerId", ""},
                                                                   {"propertyId", "count"},
                                                                   {"value", 7}}})}},
                         {{"index", 1},
                          {"input", {{"type", "continue"}}},
                          {"expectations", nlohmann::json::array()}}})},
          {"finalExpectations", nlohmann::json::array()}}},
    };

    const auto result = noveltea::tooling::run_ui_test(request.dump());
    INFO(result.response_json);
    REQUIRE(result.exit_code == 0);
    const auto response = nlohmann::json::parse(result.response_json, nullptr, false);
    REQUIRE_FALSE(response.is_discarded());
    INFO(response.dump(2));
    REQUIRE(response.value("ok", false));
    REQUIRE(response.contains("report"));
    CHECK(response["report"]["passed"] == true);
    REQUIRE(response["report"]["steps"].size() == 2);
    CHECK(response["report"]["steps"][0]["handled"] == true);
    REQUIRE(response["report"]["steps"][0]["expectations"].size() == 1);
    CHECK(response["report"]["steps"][0]["expectations"][0]["passed"] == true);
    CHECK(response["report"]["steps"][1]["handled"] == true);
}
