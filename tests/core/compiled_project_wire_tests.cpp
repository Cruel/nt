#include "core/compiled_project_wire.hpp"
#include "../support/json_test_utils.hpp"

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

TEST_CASE("compiled project shared decoder consumes every golden boundary")
{
    STATIC_REQUIRE(!std::is_same_v<SharedProject, CompiledProject>);

    for (const auto name :
         {"minimal", "comprehensive", "trait-properties-localization", "resources", "scene-program",
          "dialogue-program", "interaction-program"}) {
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
    CHECK(project.save_contract == "sc1:1a57ed12102be08009b1ca4295415704");
    CHECK(project.properties.size() == 11);
    CHECK(project.assets.size() == 9);
    CHECK(project.layouts.size() == 2);
    CHECK(project.scripts.size() == 3);
    CHECK(project.characters.size() == 1);
    CHECK(project.rooms.size() == 3);
    CHECK(project.interactables.size() == 4);
    REQUIRE(project.interactable_instances.size() == 4);
    const auto wallet = std::ranges::find_if(project.interactable_instances, [](const auto& value) {
        return value.id.text() == "wallet";
    });
    REQUIRE(wallet != project.interactable_instances.end());
    CHECK(wallet->definition.text() == "credits");
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
    REQUIRE(project.maps.front().connections.front().exits.size() == 1);
    CHECK(project.maps.front().connections.front().exits.front().exit_id.text() == "north-exit");
    CHECK(project.localization.catalogs.size() == 2);
}

TEST_CASE("compiled project Interactable Instance boundary is strict within the current format")
{
    SECTION("required root collection")
    {
        auto document = fixture("minimal");
        document.erase("interactableInstances");
        const auto result = decode_shared_project(document, "missing-interactable-instances.json");
        REQUIRE_FALSE(result);
    }
    SECTION("resolved definition")
    {
        auto document = fixture("comprehensive");
        document["interactableInstances"][0]["definition"]["id"] = "missing";
        auto unresolved = noveltea::core::decode_compiled_project(
            document, "unresolved-interactable-definition.json");
        REQUIRE_FALSE(unresolved);
        CHECK(has_code(unresolved.error(), "compiled_project.unresolved_reference"));
    }
    SECTION("retired Item top-level collections are not aliases")
    {
        auto document = fixture("minimal");
        document["definitions"]["itemDefinitions"] = nlohmann::json::array();
        auto item_definitions = decode_shared_project(document, "retired-item-definitions.json");
        REQUIRE_FALSE(item_definitions);

        document = fixture("minimal");
        document["itemStacks"] = nlohmann::json::array();
        auto item_stacks = decode_shared_project(document, "retired-item-stacks.json");
        REQUIRE_FALSE(item_stacks);
    }
    SECTION("definition-owned mutable state is not accepted")
    {
        auto document = fixture("minimal");
        document["definitions"]["interactables"][0]["initialState"] = {{"enabled", true},
                                                                       {"visible", true}};
        auto result = decode_shared_project(document, "retired-interactable-initial-state.json");
        REQUIRE_FALSE(result);
    }
}

TEST_CASE("compiled Scene boundary rejects the superseded same-version wire shape")
{
    auto document = fixture("scene-program");
    auto& scene = document["definitions"]["scenes"][1];
    const auto stage = scene["stage"];
    const auto events = scene["program"]["events"];
    scene.erase("stage");
    scene["defaultBackground"] = stage["background"];
    scene["defaultLayout"] = stage["layout"];
    scene["program"] = {{"instructions", nlohmann::json::array()}};
    for (const auto& event : events)
        scene["program"]["instructions"].push_back(event["instruction"]);

    const auto result = decode_shared_project(document, "stale-scene-wire.json");
    REQUIRE_FALSE(result);
    CHECK(has_code(result.error(), "compiled_project.unknown_field"));
}

TEST_CASE("compiled Scene boundary rejects the retired continuation field at the current version")
{
    auto document = fixture("scene-program");
    auto& scene = document["definitions"]["scenes"][1];
    scene.erase("terminal");
    scene["continuation"] = {{"kind", "end"}};

    const auto result = decode_shared_project(document, "retired-scene-continuation.json");
    REQUIRE_FALSE(result);
    CHECK(has_code(result.error(), "compiled_project.unknown_field"));
}

TEST_CASE("compiled project decoder accepts the generated canonical vocabulary golden")
{
    auto result =
        decode_shared_project(fixture("canonical-vocabulary"), "canonical-vocabulary.json");
    REQUIRE(result);
    const auto& project = result.value();
    CHECK(project.archetypes.size() == 3);
    CHECK(project.scenes.size() >= 4);
    CHECK(project.dialogues.size() >= 2);
    CHECK(project.interactable_instances.size() >= 5);
}

TEST_CASE("compiled Scene boundary rejects detached targets that await foreground-only work")
{
    auto document = fixture("scene-program");
    auto& closing = document["definitions"]["scenes"][0];
    auto& opening = document["definitions"]["scenes"][1];
    REQUIRE(closing["id"] == "closing");
    REQUIRE(opening["id"] == "opening");

    closing["program"]["events"] = nlohmann::json::array(
        {{{"id", "await-background"},
          {"timeline", {{"trackId", "main"}, {"startMs", 0}, {"durationMs", 100}}},
          {"completionDependencies", nlohmann::json::array()},
          {"instruction",
           {{"id", "await-background"},
            {"kind", "set-background"},
            {"owner", "invocation"},
            {"asset", nullptr},
            {"material", nullptr},
            {"color", "#000000"},
            {"fit", "cover"},
            {"transition", "fade"},
            {"durationMs", 100},
            {"waitForCompletion", true},
            {"skippable", true}}}}});
    closing["terminal"] = {{"kind", "return"}, {"outcome", nullptr}};
    opening["program"]["events"] = nlohmann::json::array(
        {{{"id", "detached"},
          {"timeline", {{"trackId", "main"}, {"startMs", 0}, {"durationMs", 0}}},
          {"completionDependencies", nlohmann::json::array()},
          {"instruction",
           {{"id", "detached"},
            {"kind", "start-detached-scene"},
            {"autosaveSafePoint", false},
            {"scene", {{"kind", "scene"}, {"id", "closing"}}},
            {"inputs", nlohmann::json::array()},
            {"owner", "flow"}}}}});
    opening["terminal"] = {{"kind", "complete-game"}};

    auto result = noveltea::core::decode_compiled_project(document, "unsafe-detached-scene.json");
    REQUIRE_FALSE(result);
    CHECK(has_code(result.error(), "compiled_project.detached_scene_not_background_safe"));
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
        REQUIRE(opening.program.instructions.size() == 19);
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
        CHECK(std::holds_alternative<SetGlobalPropertySceneInstruction>(
            opening.program.instructions[7]));
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
        const auto& postprocess_add =
            std::get<PostprocessEffectInstruction>(opening.program.instructions[14]);
        CHECK(postprocess_add.instance.text() == "scene-grade");
        CHECK(postprocess_add.action == PostprocessEffectAction::Upsert);
        CHECK(postprocess_add.order == 2);
        CHECK(postprocess_add.parameters.size() == 1);
        const auto& background_material =
            std::get<MaterialParameterInstruction>(opening.program.instructions[15]);
        CHECK(background_material.parameter == "u_tint");
        CHECK(background_material.transition == MaterialParameterTransition::None);
        CHECK(background_material.duration_ms == 0);
        CHECK(background_material.clock == MaterialClock::Gameplay);
        const auto& postprocess_material =
            std::get<MaterialParameterInstruction>(opening.program.instructions[16]);
        CHECK(postprocess_material.parameter == "u_strength");
        CHECK(postprocess_material.transition == MaterialParameterTransition::Tween);
        CHECK(postprocess_material.duration_ms == 350);
        CHECK(postprocess_material.clock == MaterialClock::UnscaledPresentation);
        const auto& postprocess_remove =
            std::get<PostprocessEffectInstruction>(opening.program.instructions[17]);
        CHECK(postprocess_remove.action == PostprocessEffectAction::Remove);
        REQUIRE(
            std::holds_alternative<TransitionGroupInstruction>(opening.program.instructions[18]));
        const auto& transition =
            std::get<TransitionGroupInstruction>(opening.program.instructions[18]);
        CHECK(transition.children.size() == 1);
        CHECK(std::holds_alternative<TransitionGroupSetBackgroundMutation>(
            transition.children.front()));
        REQUIRE(project.rooms.size() == 3);
        REQUIRE(project.rooms[1].script_hooks.size() == 4);
        CHECK(project.rooms[1].script_hooks.front().hook == RoomScriptHookKind::BeforeEnter);
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
        REQUIRE(project.verbs.size() == 5);
        CHECK(project.verbs[3].default_program.instructions.size() == 1);
        REQUIRE(project.interactions.front().rules.size() == 6);
        const auto& rules = project.interactions.front().rules;
        CHECK(std::holds_alternative<Always>(rules[0].guard));
        CHECK(rules[0].priority == 10);
        CHECK(std::holds_alternative<Always>(rules[1].guard));
        CHECK(rules[1].priority == 10);
        REQUIRE(
            std::holds_alternative<ExactSubjectSelector>(rules[0].slots.front().selectors.front()));
        CHECK(std::holds_alternative<FeatureInteractionSubject>(
            std::get<ExactSubjectSelector>(rules[0].slots.front().selectors.front()).subject));
        REQUIRE(
            std::holds_alternative<ExactSubjectSelector>(rules[1].slots.front().selectors.front()));
        CHECK(std::holds_alternative<FeatureInteractionSubject>(
            std::get<ExactSubjectSelector>(rules[1].slots.front().selectors.front()).subject));
        CHECK(std::holds_alternative<Always>(rules[2].guard));
        CHECK(rules[2].priority == 20);
        REQUIRE(rules[2].program.instructions.size() == 4);
        CHECK(std::holds_alternative<ApplyEffectInstruction>(rules[2].program.instructions[0]));
        CHECK(
            std::holds_alternative<MoveInteractableInstruction>(rules[2].program.instructions[1]));
        CHECK(std::holds_alternative<SetInteractableStateInstruction>(
            rules[2].program.instructions[2]));
        CHECK(std::holds_alternative<NotifyInstruction>(rules[2].program.instructions[3]));
        CHECK(std::holds_alternative<LuaPredicate>(rules[3].guard));
        CHECK(rules[3].priority == 0);
        CHECK(std::holds_alternative<Always>(rules[4].guard));
        CHECK(rules[4].priority == 5);
        CHECK(std::holds_alternative<GlobalPropertyComparison>(rules[5].guard));
        CHECK(rules[5].priority == 0);
        REQUIRE(std::holds_alternative<FamilySubjectSelector>(
            rules[3].slots.front().selectors.front()));
        CHECK(std::get<FamilySubjectSelector>(rules[3].slots.front().selectors.front()).family ==
              SubjectFamily::Interactable);
        CHECK(std::get<MoveInteractableInstruction>(rules[4].program.instructions.front())
                  .id.text() == "room");
    }

    SECTION("all Subject Selector variants share the compiled decoder vocabulary")
    {
        auto document = fixture("interaction-program");
        auto* selectors =
            path_member(document, {"definitions", "verbs", "4", "slots", "0", "selectors"});
        REQUIRE(selectors != nullptr);
        *selectors = nlohmann::json::array(
            {{{"kind", "any-subject"}},
             {{"kind", "family"}, {"family", "interactable"}},
             {{"kind", "trait"}, {"trait", {{"kind", "trait"}, {"id", "feature-enabled"}}}},
             {{"kind", "item-definition"},
              {"itemDefinition", {{"kind", "item-definition"}, {"id", "credits"}}}},
             {{"kind", "qualified-pattern"}, {"family", "interactable"}, {"pattern", "key*"}},
             {{"kind", "exact"},
              {"subject",
               {{"kind", "interactable"},
                {"interactable", {{"kind", "interactable"}, {"id", "key"}}}}}}});
        auto result = decode_shared_project(document, "selector-vocabulary.json");
        REQUIRE(result);
        const auto& decoded = result.value().verbs[4].slots.front().selectors;
        REQUIRE(decoded.size() == 6);
        CHECK(std::holds_alternative<AnySubjectSelector>(decoded[0]));
        CHECK(std::holds_alternative<FamilySubjectSelector>(decoded[1]));
        CHECK(std::holds_alternative<TraitSubjectSelector>(decoded[2]));
        CHECK(std::holds_alternative<ItemDefinitionSubjectSelector>(decoded[3]));
        CHECK(std::holds_alternative<QualifiedPatternSubjectSelector>(decoded[4]));
        CHECK(std::holds_alternative<ExactSubjectSelector>(decoded[5]));
    }
}

TEST_CASE("compiled project decoder rejects specialized discriminants and incompatible fields")
{
    struct Mutation {
        std::string_view fixture_name;
        std::initializer_list<std::string_view> path;
    };
    const Mutation mutations[] = {
        {"scene-program", {"definitions", "scenes", "1", "program", "events", "0", "instruction"}},
        {"dialogue-program", {"definitions", "dialogues", "1", "program", "blocks", "0"}},
        {"dialogue-program",
         {"definitions", "dialogues", "1", "program", "blocks", "0", "segments", "0"}},
        {"dialogue-program", {"definitions", "dialogues", "1", "program", "edges", "0"}},
        {"interaction-program",
         {"definitions", "interactions", "0", "rules", "2", "program", "instructions", "0"}},
        {"interaction-program", {"definitions", "interactions", "0", "rules", "2", "guard"}},
        {"interaction-program",
         {"definitions", "interactions", "0", "rules", "2", "slots", "0", "selectors", "0"}},
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
    auto* instruction = path_member(
        document, {"definitions", "scenes", "1", "program", "events", "8", "instruction"});
    REQUIRE(instruction != nullptr);
    (*instruction)["durationMs"] = 10;
    auto result = decode_shared_project(document, "scene-program.json");
    REQUIRE_FALSE(result);
    CHECK(has_code(result.error(), "compiled_project.unknown_field"));
}

TEST_CASE("compiled project decoder rejects stale and malformed TransitionGroup contracts")
{
    const std::initializer_list<std::string_view> instruction_path = {
        "definitions", "scenes", "1", "program", "events", "18", "instruction"};

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
        auto* instruction = path_member(
            document, {"definitions", "scenes", "1", "program", "events", "0", "instruction"});
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
        auto* instruction = path_member(
            document, {"definitions", "scenes", "1", "program", "events", "1", "instruction"});
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
        auto* instruction = path_member(
            document, {"definitions", "scenes", "1", "program", "events", "13", "instruction"});
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
    auto* background = path_member(
        document, {"definitions", "scenes", "1", "program", "events", "0", "instruction"});
    auto* actor = path_member(
        document, {"definitions", "scenes", "1", "program", "events", "1", "instruction"});
    auto* layout = path_member(
        document, {"definitions", "scenes", "1", "program", "events", "13", "instruction"});
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
            R"({"kind":"global-property-comparison","operator":"greater-equal","value":2,"property":{"id":"count","kind":"property"}})",
            nullptr, false),
        "primitive.json", "/condition");
    REQUIRE(condition);
    CHECK(std::holds_alternative<GlobalPropertyComparison>(condition.value()));

    auto effect = decode_effect(
        nlohmann::json::parse(
            R"({"kind":"set-global-property","property":{"id":"flag","kind":"property"},"value":true})",
            nullptr, false),
        "primitive.json", "/effect");
    REQUIRE(effect);
    CHECK(std::holds_alternative<SetGlobalProperty>(effect.value()));

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

    SECTION("missing and malformed Save Contract")
    {
        auto missing = fixture("minimal");
        missing.erase("saveContract");
        auto missing_result = decode_shared_project(missing, "minimal.json");
        REQUIRE_FALSE(missing_result);
        const auto* diagnostic =
            find_code(missing_result.error(), "compiled_project.missing_field");
        REQUIRE(diagnostic != nullptr);
        CHECK(diagnostic->json_pointer == "/saveContract");

        auto malformed = fixture("minimal");
        malformed["saveContract"] = "sc1:NOT-CANONICAL";
        auto malformed_result = decode_shared_project(malformed, "minimal.json");
        REQUIRE_FALSE(malformed_result);
        CHECK(has_code(malformed_result.error(), "compiled_project.invalid_save_contract"));
    }

    SECTION("unsupported schema and version")
    {
        auto document = fixture("minimal");
        document["schema"] = "noveltea.runtime.project";
        document["schemaVersion"] = 2;
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

    SECTION("missing Global Property default")
    {
        auto document = fixture("comprehensive");
        auto* properties = path_member(document, {"properties"});
        REQUIRE(properties != nullptr);
        auto* property = json_access::element(*properties, 6);
        REQUIRE(property != nullptr);
        REQUIRE((*property)["id"] == "count");
        REQUIRE((*property)["scope"] == "global");
        property->erase("defaultValue");
        auto result = decode_shared_project(document, "comprehensive.json");
        REQUIRE_FALSE(result);
        const auto* diagnostic = find_code(result.error(), "compiled_project.missing_field");
        REQUIRE(diagnostic != nullptr);
        CHECK(diagnostic->json_pointer == "/properties/6/defaultValue");
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

TEST_CASE("compiled project public decoder atomically publishes all golden fixtures")
{
    for (const auto name :
         {"minimal", "comprehensive", "trait-properties-localization", "resources", "scene-program",
          "dialogue-program", "interaction-program"}) {
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

    auto trait_project = noveltea::core::decode_compiled_project(
        fixture("trait-properties-localization"), "traits.json");
    REQUIRE(trait_project);
    const auto hall = RoomId::create("hall").value();
    REQUIRE(trait_project.value().find_room(hall) != nullptr);
    REQUIRE(trait_project.value().find_trait(TraitId::create("tense-room").value()) != nullptr);
    REQUIRE(trait_project.value().find_room(hall)->identity.traits.size() == 1);
    CHECK(trait_project.value().find_room(hall)->identity.traits.front().text() == "tense-room");

    auto comprehensive =
        noveltea::core::decode_compiled_project(fixture("comprehensive"), "comprehensive.json");
    REQUIRE(comprehensive);
    const auto& complete = comprehensive.value();
    CHECK(complete.properties().size() == 11);
    CHECK(complete.assets().size() == 9);
    CHECK(complete.layouts().size() == 2);
    CHECK(complete.scripts().size() == 3);
    CHECK(complete.characters().size() == 1);
    CHECK(complete.rooms().size() == 3);
    CHECK(complete.interactables().size() == 4);
    CHECK(complete.verbs().size() == 1);
    CHECK(complete.interactions().size() == 1);
    CHECK(complete.scenes().size() == 1);
    CHECK(complete.dialogues().size() == 1);
    CHECK(complete.maps().size() == 1);
    CHECK(complete.find_property(PropertyId::create("count").value()) != nullptr);
    CHECK(complete.find_property(PropertyId::create("count").value())->is_global());
    CHECK(complete.find_property(PropertyId::create("mood").value()) != nullptr);
    CHECK_FALSE(complete.find_property(PropertyId::create("mood").value())->is_global());
    const auto image_asset_id = AssetId::create("image-main").value();
    REQUIRE(complete.find_asset(image_asset_id) != nullptr);
    REQUIRE(complete.find_asset(image_asset_id)->sampling);
    CHECK(*complete.find_asset(image_asset_id)->sampling == ImageSampling::Linear);
    CHECK(complete.find_layout(LayoutId::create("hud-inline").value()) != nullptr);
    CHECK(complete.find_script(ScriptId::create("inline-module").value()) != nullptr);
    CHECK(complete.find_character(CharacterId::create("hero").value()) != nullptr);
    CHECK(complete.find_interactable_definition(InteractableDefinitionId::create("coin").value()) !=
          nullptr);
    CHECK(complete.find_interactable_instance(InteractableInstanceId::create("coin").value()) !=
          nullptr);
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
    CHECK(scene.value().scenes()[1].program.instructions.size() == 19);

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
    CHECK(interaction.value().interactions().front().rules.size() == 6);
}

TEST_CASE("compiled image sampling is required and decodes explicitly")
{
    auto document = fixture("resources");
    auto* assets = path_member(document, {"resources", "assets"});
    REQUIRE(assets != nullptr);
    auto* image = json_access::element(*assets, 4);
    REQUIRE(image != nullptr);
    REQUIRE((*image)["kind"] == "image");
    (*image)["sampling"] = "nearest";

    auto result = noveltea::core::decode_compiled_project(document, "resources-nearest.json");
    REQUIRE(result);
    const auto* decoded = result.value().find_asset(AssetId::create("image-main").value());
    REQUIRE(decoded != nullptr);
    REQUIRE(decoded->sampling);
    CHECK(*decoded->sampling == ImageSampling::Nearest);

    SECTION("missing image sampling is rejected")
    {
        auto missing = fixture("resources");
        auto* missing_assets = path_member(missing, {"resources", "assets"});
        REQUIRE(missing_assets != nullptr);
        auto* missing_image = json_access::element(*missing_assets, 4);
        REQUIRE(missing_image != nullptr);
        missing_image->erase("sampling");
        CHECK_FALSE(noveltea::core::decode_compiled_project(missing, "resources-missing.json"));
    }

    SECTION("non-image sampling is rejected")
    {
        auto illegal = fixture("resources");
        auto* illegal_assets = path_member(illegal, {"resources", "assets"});
        REQUIRE(illegal_assets != nullptr);
        auto* non_image = json_access::element(*illegal_assets, 0);
        REQUIRE(non_image != nullptr);
        REQUIRE((*non_image)["kind"] != "image");
        (*non_image)["sampling"] = "linear";
        CHECK_FALSE(
            noveltea::core::decode_compiled_project(illegal, "resources-font-sampling.json"));
    }
}

TEST_CASE("compiled project public decoder rejects semantic linking failures")
{
    SECTION("System Layout Roles reject project-defined Layout contracts")
    {
        auto document = fixture("comprehensive");
        auto* layout = path_member(document, {"resources", "layouts", "1"});
        REQUIRE(layout != nullptr);
        (*layout)["contract"] = {
            {"inputs", nlohmann::json::array({{{"id", "title"},
                                               {"type", "string"},
                                               {"nullable", false},
                                               {"hasDefault", true},
                                               {"defaultValue", "HUD"}}})},
            {"signals", nlohmann::json::array()},
            {"state", nullptr},
        };
        auto result =
            noveltea::core::decode_compiled_project(document, "system-layout-contract.json");
        REQUIRE_FALSE(result);
        CHECK(has_code(result.error(), "compiled_project.system_layout_custom_contract"));
    }

    SECTION("hotspot Feature targets require a non-null stable Feature ID")
    {
        auto document = fixture("interaction-program");
        auto* feature_id = path_member(
            document, {"definitions", "rooms", "1", "hotspots", "0", "target", "featureId"});
        REQUIRE(feature_id != nullptr);
        *feature_id = nullptr;
        auto result =
            noveltea::core::decode_compiled_project(document, "hotspot-null-feature.json");
        REQUIRE_FALSE(result);
        CHECK(has_code(result.error(), "compiled_project.type"));
    }

    SECTION("hotspot rectangles cannot cross normalized image bounds")
    {
        auto document = fixture("interaction-program");
        auto* bounds = path_member(
            document, {"definitions", "rooms", "1", "hotspots", "0", "shape", "bounds"});
        REQUIRE(bounds != nullptr);
        (*bounds)["x"] = 0.9;
        (*bounds)["width"] = 0.2;
        auto result = noveltea::core::decode_compiled_project(document, "hotspot-bounds.json");
        REQUIRE_FALSE(result);
        CHECK(has_code(result.error(), "compiled_project.invalid_number"));
    }

    SECTION("Room hotspot IDs are unique within their owner")
    {
        auto document = fixture("interaction-program");
        auto* second = path_member(document, {"definitions", "rooms", "1", "hotspots", "1"});
        REQUIRE(second != nullptr);
        (*second)["id"] = "inspect-door";
        auto result = noveltea::core::decode_compiled_project(document, "hotspot-duplicate.json");
        REQUIRE_FALSE(result);
        CHECK(has_code(result.error(), "compiled_project.duplicate_id"));
    }

    SECTION("Room hotspot exit target is owner-local")
    {
        auto document = fixture("interaction-program");
        auto* exit_id = path_member(
            document, {"definitions", "rooms", "1", "hotspots", "1", "target", "exitId"});
        REQUIRE(exit_id != nullptr);
        *exit_id = "east-exit";
        auto result = noveltea::core::decode_compiled_project(document, "hotspot-exit.json");
        REQUIRE_FALSE(result);
        CHECK(has_code(result.error(), "compiled_project.unresolved_nested_reference"));
    }

    SECTION("Room exit directions are unique within their owner")
    {
        auto document = fixture("interaction-program");
        auto* direction =
            path_member(document, {"definitions", "rooms", "0", "exits", "1", "direction"});
        REQUIRE(direction != nullptr);
        *direction = "south";
        auto result =
            noveltea::core::decode_compiled_project(document, "room-exit-direction-duplicate.json");
        REQUIRE_FALSE(result);
        CHECK(has_code(result.error(), "compiled_project.duplicate_room_exit_direction"));
    }

    SECTION("Room and Interactable hotspot Feature targets are owner-local")
    {
        auto room = fixture("interaction-program");
        auto* room_feature = path_member(
            room, {"definitions", "rooms", "1", "hotspots", "0", "target", "featureId"});
        REQUIRE(room_feature != nullptr);
        *room_feature = "missing";
        auto room_result =
            noveltea::core::decode_compiled_project(room, "hotspot-room-feature.json");
        REQUIRE_FALSE(room_result);
        CHECK(has_code(room_result.error(), "compiled_project.unresolved_nested_reference"));

        auto interactable = fixture("interaction-program");
        auto* key =
            test_support::json_object_by_id(interactable["definitions"]["interactables"], "key");
        REQUIRE(key != nullptr);
        auto* interactable_feature =
            path_member(*key, {"presentation", "hotspots", "hotspot", "target", "featureId"});
        REQUIRE(interactable_feature != nullptr);
        *interactable_feature = "missing";
        auto interactable_result = noveltea::core::decode_compiled_project(
            interactable, "hotspot-interactable-feature.json");
        REQUIRE_FALSE(interactable_result);
        CHECK(
            has_code(interactable_result.error(), "compiled_project.unresolved_nested_reference"));
    }

    SECTION("hotspot source assets must be present images")
    {
        auto room = fixture("interaction-program");
        auto* background = path_member(room, {"definitions", "rooms", "1", "background", "asset"});
        REQUIRE(background != nullptr);
        *background = nullptr;
        auto room_result =
            noveltea::core::decode_compiled_project(room, "hotspot-room-source.json");
        REQUIRE_FALSE(room_result);
        CHECK(has_code(room_result.error(), "compiled_project.hotspot_source_image_required"));

        auto interactable = fixture("interaction-program");
        auto* key =
            test_support::json_object_by_id(interactable["definitions"]["interactables"], "key");
        REQUIRE(key != nullptr);
        auto* sprite = path_member(*key, {"presentation", "sprite"});
        REQUIRE(sprite != nullptr);
        *sprite = nullptr;
        auto interactable_result = noveltea::core::decode_compiled_project(
            interactable, "hotspot-interactable-source.json");
        REQUIRE_FALSE(interactable_result);
        CHECK(has_code(interactable_result.error(),
                       "compiled_project.hotspot_source_image_required"));
    }

    SECTION("Interactable hotspot mode none accepts a missing sprite")
    {
        auto document = fixture("interaction-program");
        auto* key =
            test_support::json_object_by_id(document["definitions"]["interactables"], "key");
        REQUIRE(key != nullptr);
        (*key)["presentation"]["sprite"] = nullptr;
        (*key)["presentation"]["hotspots"] = nlohmann::json{{"kind", "none"}};

        auto result = noveltea::core::decode_compiled_project(document, "hotspot-none.json");
        REQUIRE(result);
    }

    SECTION("Interactable sprites remain image-only when hotspot mode is none")
    {
        auto document = fixture("interaction-program");
        auto* key =
            test_support::json_object_by_id(document["definitions"]["interactables"], "key");
        REQUIRE(key != nullptr);
        (*key)["presentation"]["hotspots"] = nlohmann::json{{"kind", "none"}};
        (*key)["presentation"]["sprite"] = nlohmann::json{{"id", "audio-voice"}, {"kind", "asset"}};

        auto result = noveltea::core::decode_compiled_project(
            document, "interactable-none-audio-sprite.json");
        REQUIRE_FALSE(result);
        CHECK(has_code(result.error(), "compiled_project.invalid_asset_kind"));
    }

    SECTION("exact Feature selectors require existing owner-qualified Features")
    {
        auto missing = fixture("interaction-program");
        auto* feature_id =
            path_member(missing, {"definitions", "interactions", "0", "rules", "0", "slots", "0",
                                  "selectors", "0", "subject", "feature", "featureId"});
        REQUIRE(feature_id != nullptr);
        *feature_id = "missing-feature";
        auto missing_result =
            noveltea::core::decode_compiled_project(missing, "feature-operand-missing.json");
        REQUIRE_FALSE(missing_result);
        CHECK(has_code(missing_result.error(), "compiled_project.unresolved_nested_reference"));

        auto wrong_owner = fixture("interaction-program");
        auto* room_id =
            path_member(wrong_owner, {"definitions", "interactions", "0", "rules", "0", "slots",
                                      "0", "selectors", "0", "subject", "feature", "room", "id"});
        REQUIRE(room_id != nullptr);
        *room_id = "hall";
        auto owner_result = noveltea::core::decode_compiled_project(
            wrong_owner, "feature-operand-wrong-owner.json");
        REQUIRE_FALSE(owner_result);
        CHECK(has_code(owner_result.error(), "compiled_project.unresolved_nested_reference"));
    }

    SECTION("unresolved entrypoint")
    {
        auto document = fixture("minimal");
        document["entrypoint"]["room"]["id"] = "missing-room";
        auto result = noveltea::core::decode_compiled_project(document, "minimal.json");
        REQUIRE_FALSE(result);
        CHECK(has_code(result.error(), "compiled_project.unresolved_reference"));
    }

    SECTION("retired extends field is rejected")
    {
        auto document = fixture("trait-properties-localization");
        auto* room = path_member(document, {"definitions", "rooms", "0"});
        REQUIRE(room != nullptr);
        (*room)["extends"] = "start";
        auto result = noveltea::core::decode_compiled_project(document, "traits.json");
        REQUIRE_FALSE(result);
        CHECK(has_code(result.error(), "compiled_project.unknown_field"));
    }

    SECTION("missing Trait attachment")
    {
        auto document = fixture("trait-properties-localization");
        auto* traits = path_member(document, {"definitions", "rooms", "0", "traits"});
        REQUIRE(traits != nullptr);
        traits->push_back("missing-trait");
        auto result = noveltea::core::decode_compiled_project(document, "traits.json");
        REQUIRE_FALSE(result);
        CHECK(has_code(result.error(), "compiled_project.unresolved_reference"));
    }

    SECTION("incompatible Trait attachment")
    {
        auto document = fixture("trait-properties-localization");
        auto* traits = path_member(document, {"definitions", "characters", "0", "traits"});
        REQUIRE(traits != nullptr);
        traits->push_back("tense-room");
        auto result = noveltea::core::decode_compiled_project(document, "traits.json");
        REQUIRE_FALSE(result);
        CHECK(has_code(result.error(), "compiled_project.invalid_trait_attachment"));
    }

    SECTION("property declaration and assignment mismatch")
    {
        auto document = fixture("trait-properties-localization");
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
        auto document = fixture("trait-properties-localization");
        auto* character = path_member(document, {"definitions", "characters", "0"});
        REQUIRE(character != nullptr);
        (*character)["propertyAssignments"] =
            nlohmann::json::array({{{"propertyId", "mood"}, {"value", "calm"}}});
        auto result = noveltea::core::decode_compiled_project(document, "properties.json");
        REQUIRE_FALSE(result);
        CHECK(has_code(result.error(), "domain.invalid_property_assignment"));
    }

    SECTION("property nullability")
    {
        auto document = fixture("trait-properties-localization");
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
        auto document = fixture("trait-properties-localization");
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
        auto document = fixture("trait-properties-localization");
        auto* property = path_member(document, {"properties", "1"});
        REQUIRE(property != nullptr);
        (*property)["defaultValue"] = "angry";
        auto result = noveltea::core::decode_compiled_project(document, "properties.json");
        REQUIRE_FALSE(result);
        CHECK(has_code(result.error(), "domain.invalid_property_definition"));
    }

    SECTION("retired property persistence field")
    {
        auto document = fixture("trait-properties-localization");
        auto* property = path_member(document, {"properties", "0"});
        REQUIRE(property != nullptr);
        (*property)["persistence"] = "Save";
        auto result = noveltea::core::decode_compiled_project(document, "properties.json");
        REQUIRE_FALSE(result);
        CHECK(has_code(result.error(), "compiled_project.unknown_field"));
    }

    SECTION("unresolved property declaration")
    {
        auto document = fixture("trait-properties-localization");
        auto* assignment =
            path_member(document, {"definitions", "rooms", "0", "propertyAssignments", "0"});
        REQUIRE(assignment != nullptr);
        (*assignment)["propertyId"] = "missing-property";
        auto result = noveltea::core::decode_compiled_project(document, "properties.json");
        REQUIRE_FALSE(result);
        CHECK(has_code(result.error(), "compiled_project.unresolved_reference"));
    }

    SECTION("Global Property assignment mismatch")
    {
        auto document = fixture("scene-program");
        auto* instruction = path_member(
            document, {"definitions", "scenes", "1", "program", "events", "7", "instruction"});
        REQUIRE(instruction != nullptr);
        (*instruction)["value"] = "wrong-type";
        auto result = noveltea::core::decode_compiled_project(document, "scene.json");
        REQUIRE_FALSE(result);
        CHECK(has_code(result.error(), "compiled_project.property_type_mismatch"));
    }

    SECTION("playing audio cue requires an audio Asset")
    {
        auto document = fixture("scene-program");
        auto* instruction = path_member(
            document, {"definitions", "scenes", "1", "program", "events", "6", "instruction"});
        REQUIRE(instruction != nullptr);
        (*instruction)["asset"] = nullptr;
        auto result = noveltea::core::decode_compiled_project(document, "scene-audio.json");
        REQUIRE_FALSE(result);
        CHECK(has_code(result.error(), "compiled_project.invalid_audio_cue"));
    }

    SECTION("audio cue rejects non-audio Assets")
    {
        auto document = fixture("scene-program");
        auto* instruction = path_member(
            document, {"definitions", "scenes", "1", "program", "events", "6", "instruction"});
        REQUIRE(instruction != nullptr);
        (*instruction)["asset"]["id"] = "image-main";
        auto result = noveltea::core::decode_compiled_project(document, "scene-audio.json");
        REQUIRE_FALSE(result);
        CHECK(has_code(result.error(), "compiled_project.invalid_audio_cue"));
    }

    SECTION("desired audio requires Music or Ambience and cannot await decoder completion")
    {
        auto invalid_purpose = fixture("scene-program");
        auto* instruction = path_member(invalid_purpose, {"definitions", "scenes", "1", "program",
                                                          "events", "6", "instruction"});
        REQUIRE(instruction != nullptr);
        (*instruction)["lifetime"] = "desired-loop";
        (*instruction)["instanceId"] = "voice-loop";
        (*instruction)["waitForCompletion"] = false;
        auto result = noveltea::core::decode_compiled_project(invalid_purpose, "scene-audio.json");
        REQUIRE_FALSE(result);
        CHECK(has_code(result.error(), "compiled_project.invalid_audio_cue"));

        auto awaited_loop = fixture("scene-program");
        instruction = path_member(
            awaited_loop, {"definitions", "scenes", "1", "program", "events", "6", "instruction"});
        REQUIRE(instruction != nullptr);
        (*instruction)["purpose"] = "music";
        (*instruction)["lifetime"] = "desired-loop";
        (*instruction)["instanceId"] = "background-music";
        auto awaited = noveltea::core::decode_compiled_project(awaited_loop, "scene-audio.json");
        REQUIRE_FALSE(awaited);
        CHECK(has_code(awaited.error(), "compiled_project.invalid_audio_cue"));
    }

    SECTION("Global Property default enum membership")
    {
        auto document = fixture("trait-properties-localization");
        auto* property = path_member(document, {"properties", "8"});
        REQUIRE(property != nullptr);
        REQUIRE((*property)["id"] == "mood-variable");
        REQUIRE((*property)["scope"] == "global");
        (*property)["defaultValue"] = "angry";
        auto result = noveltea::core::decode_compiled_project(document, "properties.json");
        REQUIRE_FALSE(result);
        CHECK(has_code(result.error(), "domain.invalid_property_definition"));
    }

    SECTION("condition comparison type mismatch")
    {
        auto document = fixture("scene-program");
        auto* condition =
            path_member(document, {"definitions", "scenes", "1", "program", "events", "11",
                                   "instruction", "branches", "0", "condition"});
        REQUIRE(condition != nullptr);
        (*condition)["value"] = "not-an-integer";
        auto result = noveltea::core::decode_compiled_project(document, "condition.json");
        REQUIRE_FALSE(result);
        CHECK(has_code(result.error(), "compiled_project.property_type_mismatch"));
    }

    SECTION("missing Scene branch target")
    {
        auto document = fixture("scene-program");
        auto* instruction = path_member(
            document, {"definitions", "scenes", "1", "program", "events", "11", "instruction"});
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
            path_member(document, {"definitions", "scenes", "1", "program", "events"});
        REQUIRE(instructions != nullptr);
        REQUIRE(instructions->size() > 1);
        (*instructions)[1]["id"] = (*instructions)[0]["id"];
        (*instructions)[1]["instruction"]["id"] = (*instructions)[0]["id"];
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

    SECTION("Dialogue cues are required and the retired presentation shape is rejected")
    {
        auto missing_slots = fixture("dialogue-program");
        auto* dialogue = path_member(missing_slots, {"definitions", "dialogues", "1"});
        REQUIRE(dialogue != nullptr);
        dialogue->erase("stageSlots");
        auto missing_slots_result =
            noveltea::core::decode_compiled_project(missing_slots, "dialogue-missing-slots.json");
        REQUIRE_FALSE(missing_slots_result);
        CHECK(has_code(missing_slots_result.error(), "compiled_project.missing_field"));

        auto missing_cues = fixture("dialogue-program");
        auto* segment = path_member(missing_cues, {"definitions", "dialogues", "1", "program",
                                                   "blocks", "0", "segments", "0"});
        REQUIRE(segment != nullptr);
        segment->erase("cues");
        auto missing_cues_result =
            noveltea::core::decode_compiled_project(missing_cues, "dialogue-missing-cues.json");
        REQUIRE_FALSE(missing_cues_result);
        CHECK(has_code(missing_cues_result.error(), "compiled_project.missing_field"));

        auto retired = fixture("dialogue-program");
        segment = path_member(
            retired, {"definitions", "dialogues", "1", "program", "blocks", "0", "segments", "0"});
        REQUIRE(segment != nullptr);
        (*segment)["presentation"] = {{"stage", nlohmann::json::array()},
                                      {"media", nlohmann::json::array()}};
        auto retired_result =
            noveltea::core::decode_compiled_project(retired, "dialogue-retired-presentation.json");
        REQUIRE_FALSE(retired_result);
        CHECK(has_code(retired_result.error(), "compiled_project.unknown_field"));
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

    SECTION("interaction named slot mismatch")
    {
        auto document = fixture("interaction-program");
        auto* slots =
            path_member(document, {"definitions", "interactions", "0", "rules", "2", "slots"});
        REQUIRE(slots != nullptr);
        slots->clear();
        auto result = noveltea::core::decode_compiled_project(document, "interaction.json");
        REQUIRE_FALSE(result);
        CHECK(has_code(result.error(), "compiled_project.interaction_slot_mismatch"));
    }

    SECTION("Interactable initial location references a missing owner-qualified Inventory")
    {
        auto document = fixture("comprehensive");
        auto* key = test_support::json_object_by_id(document["interactableInstances"], "key");
        REQUIRE(key != nullptr);
        (*key)["location"] = {
            {"kind", "inventory"},
            {"inventory",
             {{"owner", {{"kind", "project"}}}, {"inventoryId", "missing-inventory"}}}};
        auto result = noveltea::core::decode_compiled_project(document, "inventory.json");
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

    SECTION("Character profile defaults reference a missing pose")
    {
        auto document = fixture("comprehensive");
        auto* profile = path_member(document, {"definitions", "characters", "0", "profiles", "0"});
        REQUIRE(profile != nullptr);
        (*profile)["defaultPoseId"] = "missing-pose";
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
        auto* terminal = path_member(document, {"definitions", "scenes", "1", "terminal"});
        REQUIRE(terminal != nullptr);
        *terminal = {{"kind", "return"}, {"outcome", nullptr}};
        auto result = noveltea::core::decode_compiled_project(document, "scene.json");
        REQUIRE_FALSE(result);
        CHECK(has_code(result.error(), "compiled_project.invalid_entrypoint_terminal"));
    }

    SECTION("direct Scene entrypoint requires nullable or defaulted inputs")
    {
        auto document = fixture("scene-program");
        document["entrypoint"] = {{"kind", "scene"},
                                  {"scene", {{"kind", "scene"}, {"id", "opening"}}}};
        auto* scene = path_member(document, {"definitions", "scenes", "1"});
        REQUIRE(scene != nullptr);
        (*scene)["inputs"] = nlohmann::json::array(
            {{{"id", "name"}, {"label", "Name"}, {"type", "string"}, {"nullable", false}}});
        auto result = noveltea::core::decode_compiled_project(document, "scene.json");
        REQUIRE_FALSE(result);
        CHECK(has_code(result.error(), "compiled_project.invalid_entrypoint_scene_input"));
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
