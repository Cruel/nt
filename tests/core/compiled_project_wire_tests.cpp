#include "core/compiled_project_wire.hpp"

#include <noveltea/core/json_access.hpp>

#include <catch2/catch_test_macros.hpp>
#include <nlohmann/json.hpp>

#include <charconv>
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
        if (current->is_array()) {
            std::size_t index = 0;
            const auto parsed = std::from_chars(part.data(), part.data() + part.size(), index);
            if (parsed.ec != std::errc{} || parsed.ptr != part.data() + part.size())
                return nullptr;
            current = json_access::element(*current, index);
        } else {
            current = json_access::member(*current, part);
        }
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
         {"minimal", "comprehensive", "inheritance-properties-localization", "resources",
          "scene-program", "dialogue-program", "interaction-program"}) {
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

TEST_CASE("compiled project decoder retains specialized programs and scoped nested IDs")
{
    SECTION("Scene and Room hook programs")
    {
        auto result = decode_shared_project(fixture("scene-program"), "scene-program.json");
        REQUIRE(result);
        const auto& project = result.value();
        REQUIRE(project.scenes.size() == 2);
        const auto& opening = project.scenes[1];
        REQUIRE(opening.program.instructions.size() == 15);
        CHECK(std::holds_alternative<SetBackgroundInstruction>(opening.program.instructions[0]));
        CHECK(std::get<ActorCueInstruction>(opening.program.instructions[1]).slot_id.text() ==
              "hero-slot");
        CHECK(std::get<CallDialogueSceneInstruction>(opening.program.instructions[2])
                  .start_block_id->text() == "start");
        CHECK(std::holds_alternative<ShowTextInstruction>(opening.program.instructions[3]));
        CHECK(std::holds_alternative<InputWait>(
            std::get<ShowTextInstruction>(opening.program.instructions[4]).wait));
        CHECK(std::holds_alternative<AudioCompletionWait>(
            std::get<AudioCueInstruction>(opening.program.instructions[6]).wait));
        CHECK(std::holds_alternative<SetVariableSceneInstruction>(opening.program.instructions[7]));
        CHECK(std::holds_alternative<RunLuaSceneInstruction>(opening.program.instructions[8]));
        CHECK(std::get<WaitDurationInstruction>(opening.program.instructions[9]).wait.duration() ==
              std::chrono::milliseconds(1500));
        CHECK(std::holds_alternative<WaitInputInstruction>(opening.program.instructions[10]));
        CHECK(std::get<ConditionalBranchInstruction>(opening.program.instructions[11])
                  .branches.front()
                  .id.text() == "count-branch");
        CHECK(std::get<ChoiceSceneInstruction>(opening.program.instructions[12])
                  .options.front()
                  .id.text() == "layout-option");
        CHECK(std::holds_alternative<SetLayoutInstruction>(opening.program.instructions[13]));
        CHECK(std::holds_alternative<TransitionInstruction>(opening.program.instructions[14]));
        REQUIRE(project.rooms.size() == 3);
        REQUIRE(project.rooms[1].lifecycle.hooks.size() == 4);
        CHECK(project.rooms[1].lifecycle.hooks.front().effects.size() == 1);
    }

    SECTION("Dialogue program")
    {
        auto result = decode_shared_project(fixture("dialogue-program"), "dialogue-program.json");
        REQUIRE(result);
        const auto& dialogue = result.value().dialogues[1];
        CHECK(dialogue.program.entry_block_id.text() == "start");
        REQUIRE(dialogue.program.blocks.size() == 4);
        const auto& sequence = std::get<DialogueSequenceBlock>(dialogue.program.blocks[0]);
        REQUIRE(sequence.segments.size() == 4);
        CHECK(std::get<DialogueLineSegment>(sequence.segments[0]).id.text() == "inline-line");
        CHECK(std::holds_alternative<DialogueRunLuaSegment>(sequence.segments[3]));
        CHECK(std::get<DialogueRedirectBlock>(dialogue.program.blocks[2]).target_block_id.text() ==
              "final");
        REQUIRE(dialogue.program.edges.size() == 3);
        CHECK(std::holds_alternative<DialogueNextEdge>(dialogue.program.edges[0]));
        CHECK(std::get<DialogueChoiceEdge>(dialogue.program.edges[1]).id.text() ==
              "choice-redirect");
    }

    SECTION("Interaction and Verb programs")
    {
        auto result =
            decode_shared_project(fixture("interaction-program"), "interaction-program.json");
        REQUIRE(result);
        const auto& project = result.value();
        REQUIRE(project.verbs.size() == 4);
        CHECK(project.verbs[2].default_program.instructions.size() == 1);
        REQUIRE(project.interactions.front().rules.size() == 4);
        const auto& rules = project.interactions.front().rules;
        CHECK(std::holds_alternative<AnyInteractionContext>(rules[0].context));
        REQUIRE(rules[0].program.instructions.size() == 6);
        CHECK(std::holds_alternative<ApplyEffectInstruction>(rules[0].program.instructions[0]));
        CHECK(
            std::holds_alternative<MoveInteractableInstruction>(rules[0].program.instructions[1]));
        CHECK(std::holds_alternative<SetInteractableStateInstruction>(
            rules[0].program.instructions[2]));
        CHECK(std::holds_alternative<NotifyInstruction>(rules[0].program.instructions[3]));
        CHECK(std::holds_alternative<CallSceneInteractionInstruction>(
            rules[0].program.instructions[4]));
        CHECK(std::holds_alternative<CallDialogueInteractionInstruction>(
            rules[0].program.instructions[5]));
        CHECK(std::holds_alternative<ActiveRoomInteractionContext>(rules[1].context));
        CHECK(std::holds_alternative<PlacementInteractionContext>(rules[2].context));
        CHECK(std::holds_alternative<PredicateInteractionContext>(rules[3].context));
        CHECK(std::holds_alternative<AnyInteractableOperand>(rules[1].operands.front()));
        CHECK(std::get<MoveInteractableInstruction>(rules[2].program.instructions.front())
                  .id.text() == "room-placement");
    }
}

TEST_CASE("compiled project decoder rejects specialized discriminants and incompatible fields")
{
    struct Mutation {
        std::string_view fixture_name;
        std::initializer_list<std::string_view> path;
    };
    const Mutation mutations[] = {
        {"scene-program", {"definitions", "scenes", "1", "program", "instructions", "0"}},
        {"dialogue-program", {"definitions", "dialogues", "1", "program", "blocks", "0"}},
        {"dialogue-program",
         {"definitions", "dialogues", "1", "program", "blocks", "0", "segments", "0"}},
        {"dialogue-program", {"definitions", "dialogues", "1", "program", "edges", "0"}},
        {"interaction-program",
         {"definitions", "interactions", "0", "rules", "0", "program", "instructions", "0"}},
        {"interaction-program", {"definitions", "interactions", "0", "rules", "0", "context"}},
        {"interaction-program",
         {"definitions", "interactions", "0", "rules", "0", "operands", "0"}},
    };
    for (const auto& mutation : mutations) {
        auto document = fixture(mutation.fixture_name);
        auto* value = path_member(document, mutation.path);
        REQUIRE(value != nullptr);
        (*value)["kind"] = "future-variant";
        auto result = decode_shared_project(document, std::string(mutation.fixture_name));
        INFO(mutation.fixture_name);
        REQUIRE_FALSE(result);
        CHECK(has_code(result.error(), "compiled_project.unknown_variant"));
    }

    auto document = fixture("scene-program");
    auto* instruction =
        path_member(document, {"definitions", "scenes", "1", "program", "instructions", "8"});
    REQUIRE(instruction != nullptr);
    (*instruction)["durationMs"] = 10;
    auto result = decode_shared_project(document, "scene-program.json");
    REQUIRE_FALSE(result);
    CHECK(has_code(result.error(), "compiled_project.unknown_field"));
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
