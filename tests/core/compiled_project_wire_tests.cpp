#include "core/compiled_project_wire.hpp"

#include <noveltea/core/compiled_project_codec.hpp>
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
    CHECK(project.settings.display.reference_resolution.width == 1920);
    CHECK(project.settings.display.reference_resolution.height == 1080);
    CHECK(project.settings.display.world_raster_policy == WorldRasterPolicy::Capped);
    CHECK(project.settings.accessibility.ui_scale.enabled);
    CHECK(project.settings.accessibility.text_scale.maximum == 2.0);
    CHECK(project.rooms.front().placements.front().id.text() == "coin-placement");
    CHECK(project.maps.front().connections.front().exit.exit_id.text() == "north-exit");
    CHECK(project.localization.catalogs.size() == 2);
}

TEST_CASE("compiled Layout scale policy retains explicit resolved wire values")
{
    auto document = fixture("comprehensive");
    auto defaults = decode_shared_project(document, "comprehensive.json");
    REQUIRE(defaults);
    const auto& layouts = defaults.value().layouts;
    const auto world = std::ranges::find_if(
        layouts, [](const LayoutResource& layout) { return layout.id.text() == "hud-assets"; });
    const auto screen = std::ranges::find_if(
        layouts, [](const LayoutResource& layout) { return layout.id.text() == "hud-inline"; });
    REQUIRE(world != layouts.end());
    REQUIRE(screen != layouts.end());
    CHECK(world->scale_policy.ui == LayoutScaleInheritance::Ignore);
    CHECK(world->scale_policy.text == LayoutScaleInheritance::Inherit);
    CHECK(screen->scale_policy.ui == LayoutScaleInheritance::Inherit);
    CHECK(screen->scale_policy.text == LayoutScaleInheritance::Inherit);
}

TEST_CASE("compiled project decoder rejects reference dimensions above the runtime display limit")
{
    auto document = fixture("minimal");
    document["settings"]["display"]["referenceResolution"]["width"] =
        max_reference_resolution_dimension + 1;

    const auto result = decode_shared_project(document, "oversized-reference-resolution.json");
    REQUIRE_FALSE(result);
    CHECK(has_code(result.error(), "reference_resolution_out_of_range"));
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
        const auto& background =
            std::get<SetBackgroundInstruction>(opening.program.instructions[0]);
        CHECK(background.transition == BackgroundTransition::Cut);
        CHECK(background.duration_ms == 0);
        CHECK(std::holds_alternative<ImmediateWait>(background.wait));
        const auto& actor = std::get<ActorCueInstruction>(opening.program.instructions[1]);
        CHECK(actor.slot_id.text() == "hero-slot");
        CHECK(actor.transition == ActorTransition::None);
        CHECK(actor.duration_ms == 0);
        CHECK(std::holds_alternative<ImmediateWait>(actor.wait));
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
        const auto& layout = std::get<SetLayoutInstruction>(opening.program.instructions[13]);
        CHECK(layout.transition == LayoutTransition::None);
        CHECK(layout.duration_ms == 0);
        CHECK(std::holds_alternative<ImmediateWait>(layout.wait));
        REQUIRE(layout.scale_overrides.ui.has_value());
        REQUIRE(layout.scale_overrides.text.has_value());
        CHECK(*layout.scale_overrides.ui == LayoutScaleInheritance::Inherit);
        CHECK(*layout.scale_overrides.text == LayoutScaleInheritance::Ignore);
        REQUIRE(
            std::holds_alternative<TransitionGroupInstruction>(opening.program.instructions[14]));
        const auto& transition =
            std::get<TransitionGroupInstruction>(opening.program.instructions[14]);
        CHECK(transition.children.size() == 1);
        CHECK(std::holds_alternative<TransitionGroupSetBackgroundMutation>(
            transition.children.front()));
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

TEST_CASE("compiled project decoder rejects stale and malformed TransitionGroup contracts")
{
    const std::initializer_list<std::string_view> instruction_path = {
        "definitions", "scenes", "1", "program", "instructions", "14"};

    SECTION("stale standalone transition")
    {
        auto document = fixture("scene-program");
        auto* instruction = path_member(document, instruction_path);
        REQUIRE(instruction != nullptr);
        (*instruction)["kind"] = "transition";
        auto result = decode_shared_project(document, "scene-program.json");
        REQUIRE_FALSE(result);
        CHECK(has_code(result.error(), "compiled_project.unknown_variant"));
    }

    SECTION("empty child list")
    {
        auto document = fixture("scene-program");
        auto* instruction = path_member(document, instruction_path);
        REQUIRE(instruction != nullptr);
        (*instruction)["children"] = nlohmann::json::array();
        auto result = decode_shared_project(document, "scene-program.json");
        REQUIRE_FALSE(result);
        CHECK(has_code(result.error(), "compiled_project.type"));
    }

    SECTION("side-effect child")
    {
        auto document = fixture("scene-program");
        auto* instruction = path_member(document, instruction_path);
        REQUIRE(instruction != nullptr);
        (*instruction)["children"] = nlohmann::json::array(
            {{{"id", "side-effect"}, {"kind", "run-lua"}, {"source", "mutate()"}}});
        auto result = decode_shared_project(document, "scene-program.json");
        REQUIRE_FALSE(result);
        CHECK(has_code(result.error(), "compiled_project.unknown_variant"));
    }

    SECTION("invalid immediate timing")
    {
        auto document = fixture("scene-program");
        auto* instruction = path_member(document, instruction_path);
        REQUIRE(instruction != nullptr);
        (*instruction)["transitionKind"] = "cut";
        (*instruction)["durationMs"] = 10;
        (*instruction)["waitForCompletion"] = true;
        (*instruction)["color"] = "#000000";
        auto result = decode_shared_project(document, "scene-program.json");
        REQUIRE_FALSE(result);
        CHECK(has_code(result.error(), "compiled_project.unknown_variant"));
    }

    SECTION("excluded Layout plane")
    {
        auto document = fixture("scene-program");
        auto* instruction = path_member(document, instruction_path);
        REQUIRE(instruction != nullptr);
        (*instruction)["children"] =
            nlohmann::json::array({{{"action", "show"},
                                    {"id", "layout"},
                                    {"kind", "set-layout"},
                                    {"layout", {{"id", "hud-inline"}, {"kind", "layout"}}},
                                    {"plane", "game-ui"},
                                    {"slot", "overlay"}}});
        auto result = decode_shared_project(document, "scene-program.json");
        REQUIRE_FALSE(result);
        CHECK(has_code(result.error(), "compiled_project.unknown_value"));
    }
}

TEST_CASE("compiled project decoder rejects malformed standalone finite presentation contracts")
{
    SECTION("immediate background transition cannot carry finite timing")
    {
        auto document = fixture("scene-program");
        auto* instruction =
            path_member(document, {"definitions", "scenes", "1", "program", "instructions", "0"});
        REQUIRE(instruction != nullptr);
        (*instruction)["transition"] = "cut";
        (*instruction)["durationMs"] = 50;
        (*instruction)["waitForCompletion"] = true;
        auto result = decode_shared_project(document, "scene-program.json");
        REQUIRE_FALSE(result);
        CHECK(has_code(result.error(), "compiled_project.unknown_variant"));
    }

    SECTION("actor slide requires positive timing and a placement action")
    {
        auto document = fixture("scene-program");
        auto* instruction =
            path_member(document, {"definitions", "scenes", "1", "program", "instructions", "1"});
        REQUIRE(instruction != nullptr);
        (*instruction)["action"] = "expression";
        (*instruction)["transition"] = "slide";
        (*instruction)["durationMs"] = 0;
        auto result = decode_shared_project(document, "scene-program.json");
        REQUIRE_FALSE(result);
        CHECK(has_code(result.error(), "compiled_project.invalid_number"));
        CHECK(has_code(result.error(), "compiled_project.unknown_variant"));
    }

    SECTION("animated Layout transition requires positive timing")
    {
        auto document = fixture("scene-program");
        auto* instruction =
            path_member(document, {"definitions", "scenes", "1", "program", "instructions", "13"});
        REQUIRE(instruction != nullptr);
        (*instruction)["transition"] = "fade";
        (*instruction)["durationMs"] = 0;
        auto result = decode_shared_project(document, "scene-program.json");
        REQUIRE_FALSE(result);
        CHECK(has_code(result.error(), "compiled_project.invalid_number"));
    }
}

TEST_CASE("compiled project decoder retains valid standalone finite presentation contracts")
{
    auto document = fixture("scene-program");
    auto* background =
        path_member(document, {"definitions", "scenes", "1", "program", "instructions", "0"});
    auto* actor =
        path_member(document, {"definitions", "scenes", "1", "program", "instructions", "1"});
    auto* layout =
        path_member(document, {"definitions", "scenes", "1", "program", "instructions", "13"});
    REQUIRE(background != nullptr);
    REQUIRE(actor != nullptr);
    REQUIRE(layout != nullptr);
    (*background)["transition"] = "fade";
    (*background)["durationMs"] = 400;
    (*background)["waitForCompletion"] = true;
    (*actor)["action"] = "move";
    (*actor)["transition"] = "slide";
    (*actor)["durationMs"] = 300;
    (*actor)["waitForCompletion"] = true;
    (*layout)["transition"] = "fade";
    (*layout)["durationMs"] = 250;
    (*layout)["waitForCompletion"] = true;

    auto result = decode_shared_project(document, "scene-program.json");
    REQUIRE(result);
    const auto& instructions = result.value().scenes[1].program.instructions;
    const auto& decoded_background = std::get<SetBackgroundInstruction>(instructions[0]);
    CHECK(decoded_background.transition == BackgroundTransition::Fade);
    CHECK(decoded_background.duration_ms == 400);
    CHECK(std::holds_alternative<PresentationCompletionWait>(decoded_background.wait));
    const auto& decoded_actor = std::get<ActorCueInstruction>(instructions[1]);
    CHECK(decoded_actor.transition == ActorTransition::Slide);
    CHECK(decoded_actor.duration_ms == 300);
    CHECK(std::holds_alternative<PresentationCompletionWait>(decoded_actor.wait));
    const auto& decoded_layout = std::get<SetLayoutInstruction>(instructions[13]);
    CHECK(decoded_layout.transition == LayoutTransition::Fade);
    CHECK(decoded_layout.duration_ms == 250);
    CHECK(std::holds_alternative<PresentationCompletionWait>(decoded_layout.wait));
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
        document["schemaVersion"] = 1;
        auto result = decode_shared_project(document, "minimal.json");
        REQUIRE_FALSE(result);
        CHECK(has_code(result.error(), "compiled_project.unsupported_provisional_schema"));
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
        (*display)["worldRasterPolicy"] = "diagonal";
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

TEST_CASE("compiled project public decoder atomically publishes all Phase 4 goldens")
{
    for (const auto name :
         {"minimal", "comprehensive", "inheritance-properties-localization", "resources",
          "scene-program", "dialogue-program", "interaction-program"}) {
        auto document = fixture(name);
        const auto original = document;
        auto result =
            noveltea::core::decode_compiled_project(document, std::string(name) + ".json");
        INFO(name);
        REQUIRE(result);
        CHECK(document == original);
        CHECK(result.value().identity().id.text().starts_with("golden-"));
        CHECK(result.value().find_room(RoomId::create("start").value()) != nullptr);
    }

    auto inheritance = noveltea::core::decode_compiled_project(
        fixture("inheritance-properties-localization"), "inheritance.json");
    REQUIRE(inheritance);
    const auto child = RoomId::create("hall").value();
    REQUIRE(inheritance.value().find_room(child) != nullptr);
    REQUIRE(inheritance.value().room_parent_index(child));
    CHECK_FALSE(inheritance.value().find_room(child)->identity.property_assignments.empty());

    auto comprehensive =
        noveltea::core::decode_compiled_project(fixture("comprehensive"), "comprehensive.json");
    REQUIRE(comprehensive);
    const auto& complete = comprehensive.value();
    CHECK(complete.variables().size() == 5);
    CHECK(complete.properties().size() == 5);
    CHECK(complete.assets().size() == 9);
    CHECK(complete.layouts().size() == 2);
    CHECK(complete.scripts().size() == 2);
    CHECK(complete.characters().size() == 1);
    CHECK(complete.rooms().size() == 3);
    CHECK(complete.interactables().size() == 3);
    CHECK(complete.verbs().size() == 1);
    CHECK(complete.interactions().size() == 1);
    CHECK(complete.scenes().size() == 1);
    CHECK(complete.dialogues().size() == 1);
    CHECK(complete.maps().size() == 1);
    CHECK(complete.find_variable(VariableId::create("count").value()) != nullptr);
    CHECK(complete.find_property(PropertyId::create("mood").value()) != nullptr);
    CHECK(complete.find_asset(AssetId::create("image-main").value()) != nullptr);
    CHECK(complete.find_layout(LayoutId::create("hud-inline").value()) != nullptr);
    CHECK(complete.find_script(ScriptId::create("inline-module").value()) != nullptr);
    CHECK(complete.find_character(CharacterId::create("hero").value()) != nullptr);
    CHECK(complete.find_interactable(InteractableId::create("coin").value()) != nullptr);
    CHECK(complete.find_verb(VerbId::create("look").value()) != nullptr);
    CHECK(complete.find_interaction(InteractionId::create("look").value()) != nullptr);
    CHECK(complete.find_scene(SceneId::create("opening").value()) != nullptr);
    CHECK(complete.find_dialogue(DialogueId::create("intro").value()) != nullptr);
    CHECK(complete.find_map(MapId::create("house").value()) != nullptr);
    REQUIRE(complete.layouts().front().dependencies.materials.size() == 1);
    CHECK(complete.layouts().front().dependencies.materials.front().text() == "sprite-material");

    auto scene = noveltea::core::decode_compiled_project(fixture("scene-program"), "scene.json");
    REQUIRE(scene);
    REQUIRE(scene.value().scenes().size() == 2);
    CHECK(scene.value().scenes()[1].program.instructions.size() == 15);

    auto dialogue =
        noveltea::core::decode_compiled_project(fixture("dialogue-program"), "dialogue.json");
    REQUIRE(dialogue);
    REQUIRE(dialogue.value().dialogues().size() == 2);
    CHECK(dialogue.value().dialogues()[1].program.blocks.size() == 4);
    CHECK(dialogue.value().dialogues()[1].program.edges.size() == 3);

    auto interaction =
        noveltea::core::decode_compiled_project(fixture("interaction-program"), "interaction.json");
    REQUIRE(interaction);
    REQUIRE(interaction.value().interactions().size() == 2);
    CHECK(interaction.value().interactions().front().rules.size() == 4);
}

TEST_CASE("compiled project public decoder rejects semantic linking failures")
{
    SECTION("unresolved entrypoint")
    {
        auto document = fixture("minimal");
        document["entrypoint"]["room"]["id"] = "missing-room";
        auto result = noveltea::core::decode_compiled_project(document, "minimal.json");
        REQUIRE_FALSE(result);
        CHECK(has_code(result.error(), "compiled_project.unresolved_reference"));
    }

    SECTION("inheritance cycle")
    {
        auto document = fixture("inheritance-properties-localization");
        auto* rooms = path_member(document, {"definitions", "rooms"});
        REQUIRE(rooms != nullptr);
        auto* first = json_access::element(*rooms, 0);
        auto* second = json_access::element(*rooms, 1);
        REQUIRE(first != nullptr);
        REQUIRE(second != nullptr);
        (*first)["extends"] = (*second)["id"];
        (*second)["extends"] = (*first)["id"];
        auto result = noveltea::core::decode_compiled_project(document, "inheritance.json");
        REQUIRE_FALSE(result);
        CHECK(has_code(result.error(), "compiled.invalid_inheritance"));
    }

    SECTION("inheritance self-reference")
    {
        auto document = fixture("inheritance-properties-localization");
        auto* room = path_member(document, {"definitions", "rooms", "0"});
        REQUIRE(room != nullptr);
        (*room)["extends"] = (*room)["id"];
        auto result = noveltea::core::decode_compiled_project(document, "inheritance.json");
        REQUIRE_FALSE(result);
        CHECK(has_code(result.error(), "compiled.invalid_inheritance"));
    }

    SECTION("inheritance missing parent")
    {
        auto document = fixture("inheritance-properties-localization");
        auto* room = path_member(document, {"definitions", "rooms", "0"});
        REQUIRE(room != nullptr);
        (*room)["extends"] = "missing-room";
        auto result = noveltea::core::decode_compiled_project(document, "inheritance.json");
        REQUIRE_FALSE(result);
        CHECK(has_code(result.error(), "compiled.invalid_inheritance"));
    }

    SECTION("property declaration and assignment mismatch")
    {
        auto document = fixture("inheritance-properties-localization");
        auto* rooms = path_member(document, {"definitions", "rooms"});
        REQUIRE(rooms != nullptr);
        auto* room = json_access::element(*rooms, 0);
        REQUIRE(room != nullptr);
        auto* assignments = json_access::member(*room, "propertyAssignments");
        REQUIRE(assignments != nullptr);
        auto* assignment = json_access::element(*assignments, 0);
        REQUIRE(assignment != nullptr);
        (*assignment)["value"] = false;
        auto result = noveltea::core::decode_compiled_project(document, "inheritance.json");
        REQUIRE_FALSE(result);
        CHECK(has_code(result.error(), "domain.invalid_property_assignment"));
    }

    SECTION("property owner restriction")
    {
        auto document = fixture("inheritance-properties-localization");
        auto* scene = path_member(document, {"definitions", "scenes", "0"});
        REQUIRE(scene != nullptr);
        (*scene)["propertyAssignments"] =
            nlohmann::json::array({{{"propertyId", "mood"}, {"value", "calm"}}});
        auto result = noveltea::core::decode_compiled_project(document, "properties.json");
        REQUIRE_FALSE(result);
        CHECK(has_code(result.error(), "domain.invalid_property_assignment"));
    }

    SECTION("property nullability")
    {
        auto document = fixture("inheritance-properties-localization");
        auto* assignment =
            path_member(document, {"definitions", "rooms", "0", "propertyAssignments", "0"});
        REQUIRE(assignment != nullptr);
        (*assignment)["value"] = nullptr;
        auto result = noveltea::core::decode_compiled_project(document, "properties.json");
        REQUIRE_FALSE(result);
        CHECK(has_code(result.error(), "domain.invalid_property_assignment"));
    }

    SECTION("property enum membership")
    {
        auto document = fixture("inheritance-properties-localization");
        auto* assignment =
            path_member(document, {"definitions", "rooms", "0", "propertyAssignments", "0"});
        REQUIRE(assignment != nullptr);
        (*assignment)["value"] = "angry";
        auto result = noveltea::core::decode_compiled_project(document, "properties.json");
        REQUIRE_FALSE(result);
        CHECK(has_code(result.error(), "domain.invalid_property_assignment"));
    }

    SECTION("invalid property default")
    {
        auto document = fixture("inheritance-properties-localization");
        auto* property = path_member(document, {"properties", "1"});
        REQUIRE(property != nullptr);
        (*property)["defaultValue"] = "angry";
        auto result = noveltea::core::decode_compiled_project(document, "properties.json");
        REQUIRE_FALSE(result);
        CHECK(has_code(result.error(), "domain.invalid_property_definition"));
    }

    SECTION("invalid property persistence")
    {
        auto document = fixture("inheritance-properties-localization");
        auto* property = path_member(document, {"properties", "0"});
        REQUIRE(property != nullptr);
        (*property)["persistence"] = "Forever";
        auto result = noveltea::core::decode_compiled_project(document, "properties.json");
        REQUIRE_FALSE(result);
        CHECK(has_code(result.error(), "compiled_project.unknown_value"));
    }

    SECTION("unresolved property declaration")
    {
        auto document = fixture("inheritance-properties-localization");
        auto* assignment =
            path_member(document, {"definitions", "rooms", "0", "propertyAssignments", "0"});
        REQUIRE(assignment != nullptr);
        (*assignment)["propertyId"] = "missing-property";
        auto result = noveltea::core::decode_compiled_project(document, "properties.json");
        REQUIRE_FALSE(result);
        CHECK(has_code(result.error(), "compiled_project.unresolved_reference"));
    }

    SECTION("variable assignment mismatch")
    {
        auto document = fixture("scene-program");
        auto* instruction =
            path_member(document, {"definitions", "scenes", "1", "program", "instructions", "7"});
        REQUIRE(instruction != nullptr);
        (*instruction)["value"] = "wrong-type";
        auto result = noveltea::core::decode_compiled_project(document, "scene.json");
        REQUIRE_FALSE(result);
        CHECK(has_code(result.error(), "compiled_project.variable_type_mismatch"));
    }

    SECTION("playing audio cue requires an audio Asset")
    {
        auto document = fixture("scene-program");
        auto* instruction =
            path_member(document, {"definitions", "scenes", "1", "program", "instructions", "6"});
        REQUIRE(instruction != nullptr);
        (*instruction)["asset"] = nullptr;
        auto result = noveltea::core::decode_compiled_project(document, "scene-audio.json");
        REQUIRE_FALSE(result);
        CHECK(has_code(result.error(), "compiled_project.invalid_audio_cue"));
    }

    SECTION("audio cue rejects non-audio Assets")
    {
        auto document = fixture("scene-program");
        auto* instruction =
            path_member(document, {"definitions", "scenes", "1", "program", "instructions", "6"});
        REQUIRE(instruction != nullptr);
        (*instruction)["asset"]["id"] = "image-main";
        auto result = noveltea::core::decode_compiled_project(document, "scene-audio.json");
        REQUIRE_FALSE(result);
        CHECK(has_code(result.error(), "compiled_project.invalid_audio_cue"));
    }

    SECTION("persistent audio loop requires Music or Ambient and cannot await completion")
    {
        auto invalid_bus = fixture("scene-program");
        auto* instruction = path_member(
            invalid_bus, {"definitions", "scenes", "1", "program", "instructions", "6"});
        REQUIRE(instruction != nullptr);
        (*instruction)["loop"] = true;
        auto result = noveltea::core::decode_compiled_project(invalid_bus, "scene-audio.json");
        REQUIRE_FALSE(result);
        CHECK(has_code(result.error(), "compiled_project.invalid_audio_cue"));

        auto awaited_loop = fixture("scene-program");
        instruction = path_member(awaited_loop,
                                  {"definitions", "scenes", "1", "program", "instructions", "6"});
        REQUIRE(instruction != nullptr);
        (*instruction)["channel"] = "music";
        (*instruction)["loop"] = true;
        auto awaited = noveltea::core::decode_compiled_project(awaited_loop, "scene-audio.json");
        REQUIRE_FALSE(awaited);
        CHECK(has_code(awaited.error(), "compiled_project.invalid_audio_cue"));
    }

    SECTION("variable default enum membership")
    {
        auto document = fixture("inheritance-properties-localization");
        auto* variable = path_member(document, {"variables", "2"});
        REQUIRE(variable != nullptr);
        (*variable)["defaultValue"] = "angry";
        auto result = noveltea::core::decode_compiled_project(document, "variables.json");
        REQUIRE_FALSE(result);
        CHECK(has_code(result.error(), "compiled.invalid_model"));
    }

    SECTION("condition comparison type mismatch")
    {
        auto document = fixture("scene-program");
        auto* condition =
            path_member(document, {"definitions", "scenes", "1", "program", "instructions", "11",
                                   "branches", "0", "condition"});
        REQUIRE(condition != nullptr);
        (*condition)["value"] = "not-an-integer";
        auto result = noveltea::core::decode_compiled_project(document, "condition.json");
        REQUIRE_FALSE(result);
        CHECK(has_code(result.error(), "compiled_project.variable_type_mismatch"));
    }

    SECTION("missing Scene branch target")
    {
        auto document = fixture("scene-program");
        auto* instruction =
            path_member(document, {"definitions", "scenes", "1", "program", "instructions", "11"});
        REQUIRE(instruction != nullptr);
        (*instruction)["fallbackInstructionId"] = "missing-step";
        auto result = noveltea::core::decode_compiled_project(document, "scene.json");
        REQUIRE_FALSE(result);
        CHECK(has_code(result.error(), "compiled_project.unresolved_nested_reference"));
    }

    SECTION("duplicate Scene step ID")
    {
        auto document = fixture("scene-program");
        auto* instructions =
            path_member(document, {"definitions", "scenes", "1", "program", "instructions"});
        REQUIRE(instructions != nullptr);
        REQUIRE(instructions->size() > 1);
        (*instructions)[1]["id"] = (*instructions)[0]["id"];
        auto result = noveltea::core::decode_compiled_project(document, "scene.json");
        REQUIRE_FALSE(result);
        CHECK(has_code(result.error(), "compiled_project.duplicate_id"));
    }

    SECTION("missing Dialogue graph target")
    {
        auto document = fixture("dialogue-program");
        auto* edge =
            path_member(document, {"definitions", "dialogues", "1", "program", "edges", "0"});
        REQUIRE(edge != nullptr);
        (*edge)["toBlockId"] = "missing-block";
        auto result = noveltea::core::decode_compiled_project(document, "dialogue.json");
        REQUIRE_FALSE(result);
        CHECK(has_code(result.error(), "compiled_project.unresolved_nested_reference"));
    }

    SECTION("duplicate Dialogue block ID")
    {
        auto document = fixture("dialogue-program");
        auto* blocks =
            path_member(document, {"definitions", "dialogues", "1", "program", "blocks"});
        REQUIRE(blocks != nullptr);
        REQUIRE(blocks->size() > 1);
        (*blocks)[1]["id"] = (*blocks)[0]["id"];
        auto result = noveltea::core::decode_compiled_project(document, "dialogue.json");
        REQUIRE_FALSE(result);
        CHECK(has_code(result.error(), "compiled_project.duplicate_id"));
    }

    SECTION("Dialogue redirect-only cycle")
    {
        auto document = fixture("dialogue-program");
        auto* blocks =
            path_member(document, {"definitions", "dialogues", "1", "program", "blocks"});
        REQUIRE(blocks != nullptr);
        REQUIRE(blocks->size() >= 4);
        (*blocks)[2]["targetBlockId"] = (*blocks)[2]["id"];
        auto result = noveltea::core::decode_compiled_project(document, "dialogue.json");
        REQUIRE_FALSE(result);
        CHECK(has_code(result.error(), "compiled_project.invalid_dialogue_graph"));
    }

    SECTION("interaction arity mismatch")
    {
        auto document = fixture("interaction-program");
        auto* operands =
            path_member(document, {"definitions", "interactions", "0", "rules", "0", "operands"});
        REQUIRE(operands != nullptr);
        operands->clear();
        auto result = noveltea::core::decode_compiled_project(document, "interaction.json");
        REQUIRE_FALSE(result);
        CHECK(has_code(result.error(), "compiled_project.interaction_arity_mismatch"));
    }

    SECTION("Interactable initial location references a missing generic placement")
    {
        auto document = fixture("comprehensive");
        auto* placement = path_member(document, {"definitions", "interactables", "2",
                                                 "initialState", "location", "placement"});
        REQUIRE(placement != nullptr);
        (*placement)["placementId"] = "missing-placement";
        auto result = noveltea::core::decode_compiled_project(document, "room.json");
        REQUIRE_FALSE(result);
        CHECK(has_code(result.error(), "compiled_project.unresolved_nested_reference"));
    }

    SECTION("Room exit references a missing Room")
    {
        auto document = fixture("comprehensive");
        auto* target = path_member(document, {"definitions", "rooms", "0", "exits", "0", "target"});
        REQUIRE(target != nullptr);
        (*target)["id"] = "missing-room";
        auto result = noveltea::core::decode_compiled_project(document, "room.json");
        REQUIRE_FALSE(result);
        CHECK(has_code(result.error(), "compiled_project.unresolved_reference"));
    }

    SECTION("Character defaults reference a missing pose")
    {
        auto document = fixture("comprehensive");
        auto* defaults = path_member(document, {"definitions", "characters", "0", "defaults"});
        REQUIRE(defaults != nullptr);
        (*defaults)["poseId"] = "missing-pose";
        auto result = noveltea::core::decode_compiled_project(document, "character.json");
        REQUIRE_FALSE(result);
        CHECK(has_code(result.error(), "compiled_project.unresolved_nested_reference"));
    }

    SECTION("gameplay Layout dependency references a missing Asset")
    {
        auto document = fixture("resources");
        auto* image =
            path_member(document, {"resources", "layouts", "0", "dependencies", "images", "0"});
        REQUIRE(image != nullptr);
        (*image)["id"] = "missing-asset";
        auto result = noveltea::core::decode_compiled_project(document, "resources.json");
        REQUIRE_FALSE(result);
        CHECK(has_code(result.error(), "compiled_project.unresolved_reference"));
    }

    SECTION("gameplay Script source references a missing Asset")
    {
        auto document = fixture("resources");
        auto* asset = path_member(document, {"resources", "scripts", "0", "source", "asset"});
        REQUIRE(asset != nullptr);
        (*asset)["id"] = "missing-asset";
        auto result = noveltea::core::decode_compiled_project(document, "resources.json");
        REQUIRE_FALSE(result);
        CHECK(has_code(result.error(), "compiled_project.unresolved_reference"));
    }

    SECTION("inconsistent Map topology")
    {
        auto document = fixture("comprehensive");
        auto* connection = path_member(document, {"definitions", "maps", "0", "connections", "0"});
        REQUIRE(connection != nullptr);
        (*connection)["targetLocationId"] = (*connection)["sourceLocationId"];
        auto result = noveltea::core::decode_compiled_project(document, "map.json");
        REQUIRE_FALSE(result);
        CHECK(has_code(result.error(), "compiled_project.inconsistent_map_topology"));
    }

    SECTION("Map connection references a missing location")
    {
        auto document = fixture("comprehensive");
        auto* connection = path_member(document, {"definitions", "maps", "0", "connections", "0"});
        REQUIRE(connection != nullptr);
        (*connection)["sourceLocationId"] = "missing-location";
        auto result = noveltea::core::decode_compiled_project(document, "map.json");
        REQUIRE_FALSE(result);
        CHECK(has_code(result.error(), "compiled_project.unresolved_nested_reference"));
    }

    SECTION("direct Scene entrypoint cannot return")
    {
        auto document = fixture("scene-program");
        document["entrypoint"] = {{"kind", "scene"},
                                  {"scene", {{"kind", "scene"}, {"id", "opening"}}}};
        auto* continuation = path_member(document, {"definitions", "scenes", "1", "continuation"});
        REQUIRE(continuation != nullptr);
        *continuation = {{"kind", "return"}};
        auto result = noveltea::core::decode_compiled_project(document, "scene.json");
        REQUIRE_FALSE(result);
        CHECK(has_code(result.error(), "compiled_project.invalid_entrypoint_continuation"));
    }

    SECTION("provisional schema is explicitly unsupported")
    {
        auto document = fixture("minimal");
        document["schema"] = "noveltea.runtime.project";
        auto result = noveltea::core::decode_compiled_project(document, "legacy.json");
        REQUIRE_FALSE(result);
        CHECK(has_code(result.error(), "compiled_project.unsupported_provisional_schema"));
    }
}

} // namespace noveltea::core::compiled::wire
