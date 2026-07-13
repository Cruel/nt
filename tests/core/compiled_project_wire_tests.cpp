#include "core/compiled_project_wire.hpp"

#include <noveltea/core/json_access.hpp>

#include <catch2/catch_test_macros.hpp>
#include <nlohmann/json.hpp>

#include <fstream>
#include <limits>
#include <ranges>
#include <string>
#include <string_view>
#include <type_traits>

namespace noveltea::core::compiled::wire {
namespace {

nlohmann::json fixture(std::string_view name)
{
    const std::string path = std::string(NOVELTEA_SOURCE_DIR) +
                             "/editor/src/renderer/test/fixtures/compiled-project-golden/" +
                             std::string(name) + ".json";
    std::ifstream stream(path);
    return nlohmann::json::parse(stream, nullptr, false);
}

bool has_code(const Diagnostics& diagnostics, std::string_view code)
{
    return std::ranges::any_of(
        diagnostics, [code](const Diagnostic& diagnostic) { return diagnostic.code == code; });
}

const Diagnostic* find_code(const Diagnostics& diagnostics, std::string_view code)
{
    const auto iterator = std::ranges::find_if(
        diagnostics, [code](const Diagnostic& diagnostic) { return diagnostic.code == code; });
    return iterator == diagnostics.end() ? nullptr : &*iterator;
}

nlohmann::json* path_member(nlohmann::json& root, std::initializer_list<std::string_view> path)
{
    auto* current = &root;
    for (const auto part : path) {
        current = json_access::member(*current, part);
        if (!current)
            return nullptr;
    }
    return current;
}

} // namespace

TEST_CASE("compiled project shared decoder consumes the Phase 4 golden boundaries")
{
    STATIC_REQUIRE(!std::is_same_v<SharedProject, CompiledProject>);

    for (const auto name :
         {"minimal", "comprehensive", "inheritance-properties-localization", "resources"}) {
        auto document = fixture(name);
        REQUIRE_FALSE(document.is_discarded());
        const auto original = document;
        auto result = decode_shared_project(document, std::string(name) + ".json");
        INFO(name);
        REQUIRE(result);
        CHECK(document == original);
        CHECK(result.value().identity.id.text().starts_with("golden-"));
    }
}

TEST_CASE("compiled project shared decoder retains representative declarations and definitions")
{
    auto result = decode_shared_project(fixture("comprehensive"), "comprehensive.json");
    REQUIRE(result);
    const auto& project = result.value();
    CHECK(project.identity.name == "Golden Comprehensive");
    CHECK(project.variables.size() == 5);
    CHECK(project.properties.size() == 5);
    CHECK(project.assets.size() == 9);
    CHECK(project.layouts.size() == 2);
    CHECK(project.scripts.size() == 2);
    CHECK(project.characters.size() == 1);
    CHECK(project.rooms.size() == 3);
    CHECK(project.interactables.size() == 3);
    CHECK(project.verbs.size() == 1);
    CHECK(project.interactions.size() == 1);
    CHECK(project.scenes.size() == 1);
    CHECK(project.dialogues.size() == 1);
    CHECK(project.maps.size() == 1);
    CHECK(project.rooms.front().placements.front().id.text() == "coin-placement");
    CHECK(project.maps.front().connections.front().exit.exit_id.text() == "north-exit");
    CHECK(project.localization.catalogs.size() == 2);
}

TEST_CASE("compiled project shared primitives decode closed variants strictly")
{
    auto condition = decode_condition(
        nlohmann::json::parse(
            R"({"kind":"variable-comparison","operator":"greater-equal","value":2,"variable":{"id":"count","kind":"variable"}})",
            nullptr, false),
        "primitive.json", "/condition");
    REQUIRE(condition);
    CHECK(std::holds_alternative<VariableComparison>(condition.value()));

    auto effect = decode_effect(
        nlohmann::json::parse(
            R"({"kind":"set-variable","value":true,"variable":{"id":"flag","kind":"variable"}})",
            nullptr, false),
        "primitive.json", "/effect");
    REQUIRE(effect);
    CHECK(std::holds_alternative<SetVariable>(effect.value()));

    auto target = decode_flow_target(
        nlohmann::json::parse(R"({"kind":"dialogue","dialogue":{"id":"intro","kind":"dialogue"}})",
                              nullptr, false),
        "primitive.json", "/target");
    REQUIRE(target);
    CHECK(std::holds_alternative<DialogueId>(target.value()));

    auto malformed = decode_condition(
        nlohmann::json::parse(R"({"kind":"future","payload":true})", nullptr, false),
        "primitive.json", "/condition");
    REQUIRE_FALSE(malformed);
    CHECK(has_code(malformed.error(), "compiled_project.unknown_variant"));
    CHECK(has_code(malformed.error(), "compiled_project.unknown_field"));
}

TEST_CASE("compiled project shared decoder rejects strict structural failures with context")
{
    SECTION("missing root field")
    {
        auto document = fixture("minimal");
        document.erase("project");
        auto result = decode_shared_project(document, "minimal.json");
        REQUIRE_FALSE(result);
        const auto* diagnostic = find_code(result.error(), "compiled_project.missing_field");
        REQUIRE(diagnostic != nullptr);
        CHECK(diagnostic->source_path == "minimal.json");
        CHECK(diagnostic->json_pointer == "/project");
    }

    SECTION("unsupported schema and version")
    {
        auto document = fixture("minimal");
        document["schema"] = "noveltea.runtime.project";
        document["schemaVersion"] = 2;
        auto result = decode_shared_project(document, "minimal.json");
        REQUIRE_FALSE(result);
        CHECK(has_code(result.error(), "compiled_project.unsupported_schema"));
        CHECK(has_code(result.error(), "compiled_project.unsupported_version"));
    }

    SECTION("unknown nested field")
    {
        auto document = fixture("comprehensive");
        auto* characters = path_member(document, {"definitions", "characters"});
        REQUIRE(characters != nullptr);
        auto* character = json_access::element(*characters, 0);
        REQUIRE(character != nullptr);
        (*character)["legacyParent"] = "old";
        auto result = decode_shared_project(document, "comprehensive.json");
        REQUIRE_FALSE(result);
        const auto* diagnostic = find_code(result.error(), "compiled_project.unknown_field");
        REQUIRE(diagnostic != nullptr);
        CHECK(diagnostic->json_pointer == "/definitions/characters/0/legacyParent");
    }

    SECTION("wrong shared type")
    {
        auto document = fixture("minimal");
        auto* settings = path_member(document, {"settings"});
        REQUIRE(settings != nullptr);
        (*settings)["systemLayouts"] = "not-an-array";
        auto result = decode_shared_project(document, "minimal.json");
        REQUIRE_FALSE(result);
        CHECK(has_code(result.error(), "compiled_project.type"));
    }

    SECTION("unknown enum value")
    {
        auto document = fixture("minimal");
        auto* display = path_member(document, {"settings", "display"});
        REQUIRE(display != nullptr);
        (*display)["orientation"] = "diagonal";
        auto result = decode_shared_project(document, "minimal.json");
        REQUIRE_FALSE(result);
        CHECK(has_code(result.error(), "compiled_project.unknown_value"));
    }

    SECTION("unknown shared discriminant")
    {
        auto document = fixture("comprehensive");
        auto* source = path_member(document, {"definitions", "rooms"});
        REQUIRE(source != nullptr);
        auto* room = json_access::element(*source, 0);
        REQUIRE(room != nullptr);
        auto* description = json_access::member(*room, "description");
        REQUIRE(description != nullptr);
        auto* text_source = json_access::member(*description, "source");
        REQUIRE(text_source != nullptr);
        (*text_source)["kind"] = "legacy-script";
        auto result = decode_shared_project(document, "comprehensive.json");
        REQUIRE_FALSE(result);
        CHECK(has_code(result.error(), "compiled_project.unknown_variant"));
    }

    SECTION("invalid strong ID")
    {
        auto document = fixture("minimal");
        auto* project = path_member(document, {"project"});
        REQUIRE(project != nullptr);
        (*project)["id"] = "Invalid ID";
        auto result = decode_shared_project(document, "minimal.json");
        REQUIRE_FALSE(result);
        CHECK(has_code(result.error(), "compiled_project.invalid_id"));
    }

    SECTION("non-finite number")
    {
        auto document = fixture("comprehensive");
        auto* rooms = path_member(document, {"definitions", "rooms"});
        REQUIRE(rooms != nullptr);
        auto* room = json_access::element(*rooms, 0);
        REQUIRE(room != nullptr);
        auto* placements = json_access::member(*room, "placements");
        REQUIRE(placements != nullptr);
        auto* placement = json_access::element(*placements, 0);
        REQUIRE(placement != nullptr);
        auto* bounds = json_access::member(*placement, "bounds");
        REQUIRE(bounds != nullptr);
        (*bounds)["x"] = std::numeric_limits<double>::infinity();
        auto result = decode_shared_project(document, "comprehensive.json");
        REQUIRE_FALSE(result);
        CHECK(has_code(result.error(), "compiled_project.invalid_number"));
    }

    SECTION("null variable default")
    {
        auto document = fixture("comprehensive");
        auto* variables = path_member(document, {"variables"});
        REQUIRE(variables != nullptr);
        auto* variable = json_access::element(*variables, 0);
        REQUIRE(variable != nullptr);
        (*variable)["defaultValue"] = nullptr;
        auto result = decode_shared_project(document, "comprehensive.json");
        REQUIRE_FALSE(result);
        const auto* diagnostic = find_code(result.error(), "compiled_project.type");
        REQUIRE(diagnostic != nullptr);
        CHECK(diagnostic->json_pointer == "/variables/0/defaultValue");
    }

    SECTION("duplicate collection ID")
    {
        auto document = fixture("comprehensive");
        auto* assets = path_member(document, {"resources", "assets"});
        REQUIRE(assets != nullptr);
        const auto* first = json_access::element(*assets, 0);
        REQUIRE(first != nullptr);
        assets->push_back(*first);
        auto result = decode_shared_project(document, "comprehensive.json");
        REQUIRE_FALSE(result);
        CHECK(has_code(result.error(), "compiled_project.duplicate_id"));
    }
}

} // namespace noveltea::core::compiled::wire
