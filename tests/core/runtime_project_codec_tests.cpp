#include <noveltea/core/runtime_project_codec.hpp>

#include <catch2/catch_test_macros.hpp>
#include <nlohmann/json.hpp>

#include <algorithm>

namespace noveltea::core {
namespace {

nlohmann::json valid_project()
{
    return nlohmann::json::parse(R"({
      "schema":"noveltea.runtime.project","schemaVersion":1,
      "identity":{"id":"tea","name":"Tea","version":"1.0"},
      "settings":{"locale":"en","allowSaves":true},
      "entrypoint":{"kind":"room","id":"foyer"},
      "variables":{"visited":false,"count":2,"ratio":1.5,"title":"Tea","none":null},
      "assets":[{"id":"ui.main","path":"ui/main.rml","mediaType":"text/rml"}],
      "assetAliases":[{"id":"main-ui","assetId":"ui.main"}],
      "rooms":[{"id":"foyer","name":"Foyer","objectIds":["kettle"],"verbIds":["look"]}],
      "objects":[{"id":"kettle","name":"Kettle","verbIds":["look"]}],
      "verbs":[{"id":"look","label":"Look"}],
      "actions":[{"id":"look-kettle","verbId":"look","objectId":"kettle","steps":["describe"]}],
      "dialogues":[{"id":"welcome","nodes":[{"id":"start","text":"Hello","choices":[]}]}],
      "scenes":[{"id":"intro","steps":["fade-in"]}],
      "maps":[{"id":"house","locations":[{"id":"foyer-pin","roomId":"foyer","x":1,"y":2}]}],
      "scripts":[{"id":"startup","source":"return true"}],
      "layouts":[{"id":"main","documentAssetId":"ui.main"}],
      "runtimeUi":{"defaultLayoutId":"main","themeAssetId":"ui.main"}
    })");
}

bool has_code(const Diagnostics& diagnostics, std::string_view code)
{
    return std::ranges::any_of(diagnostics, [code](const Diagnostic& d) { return d.code == code; });
}

} // namespace

TEST_CASE("runtime project decoder produces a complete typed project")
{
    auto result = decode_runtime_project(valid_project());
    REQUIRE(result);
    const auto& project = result.value();
    CHECK(project.identity.id == "tea");
    CHECK(project.entrypoint.kind == EntrypointKind::Room);
    CHECK(project.rooms.size() == 1);
    CHECK(project.objects.size() == 1);
    CHECK(project.verbs.size() == 1);
    CHECK(project.actions.size() == 1);
    CHECK(project.dialogues.size() == 1);
    CHECK(project.scenes.size() == 1);
    CHECK(project.maps.size() == 1);
    CHECK(project.scripts.size() == 1);
    CHECK(project.layouts.size() == 1);
    CHECK(project.variables.size() == 5);
}

TEST_CASE("runtime project decoder reports malformed structure and invalid scalar types")
{
    auto document = valid_project();
    document["rooms"] = "not-an-array";
    document["variables"]["nested"] = nlohmann::json::object();
    auto result = decode_runtime_project(document);
    REQUIRE_FALSE(result);
    CHECK(has_code(result.error(), "runtime_project.type"));
    CHECK(has_code(result.error(), "runtime_project.variable_type"));
}

TEST_CASE("runtime project decoder reports missing references")
{
    auto document = valid_project();
    document["entrypoint"]["id"] = "missing";
    document["assetAliases"][0]["assetId"] = "missing";
    auto result = decode_runtime_project(document);
    REQUIRE_FALSE(result);
    CHECK(has_code(result.error(), "runtime_project.missing_reference"));
    CHECK_FALSE(result.error().front().json_pointer.empty());
}

TEST_CASE("runtime project decoder rejects missing required fields")
{
    auto document = valid_project();
    document.erase("identity");
    auto result = decode_runtime_project(document);
    REQUIRE_FALSE(result);
    CHECK(has_code(result.error(), "runtime_project.missing_field"));
}

} // namespace noveltea::core
