#include <catch2/catch_test_macros.hpp>

#include "noveltea/core/compiled_project_codec.hpp"
#include "noveltea/script/script_runtime.hpp"
#include "noveltea/runtime/runtime_executor.hpp"
#include "fake_script_source.hpp"
#include "runtime_test_services.hpp"

#include <algorithm>
#include <fstream>
#include <iterator>
#include <memory>
#include <string>

#include <nlohmann/json.hpp>

namespace noveltea::script::test {
namespace {

using TypedExecutionKernel = runtime::RuntimeExecutor;

template<class Id> Id id(std::string value)
{
    auto result = Id::create(std::move(value));
    REQUIRE(result);
    return std::move(result).value();
}

nlohmann::json load_document()
{
    std::ifstream input(
        std::string(NOVELTEA_SOURCE_DIR) +
        "/editor/src/renderer/test/fixtures/compiled-project-golden/interaction-program.json");
    REQUIRE(input.good());
    const std::string source((std::istreambuf_iterator<char>(input)),
                             std::istreambuf_iterator<char>());
    auto document = nlohmann::json::parse(source, nullptr, false);
    REQUIRE_FALSE(document.is_discarded());
    return document;
}

nlohmann::json& definition(nlohmann::json& document, std::string_view collection,
                           std::string_view identifier)
{
    auto& values = document["definitions"][std::string(collection)];
    const auto found = std::find_if(values.begin(), values.end(), [identifier](const auto& value) {
        return value.value("id", std::string{}) == identifier;
    });
    REQUIRE(found != values.end());
    return *found;
}

core::CompiledProject decode(nlohmann::json document)
{
    auto decoded = core::decode_compiled_project(document, "typed-interaction-test");
    REQUIRE(decoded);
    return std::move(decoded).value();
}

struct RuntimeFixture {
    test_support::MemoryScriptSource sources;
    ScriptRuntime runtime;

    RuntimeFixture()
    {
        REQUIRE(runtime.initialize({&sources}));
        REQUIRE(runtime.execute("function initialize_fixture() end\n"
                                "function can_leave_start() return true end\n"
                                "function after_enter_start() end\n"
                                "function before_leave_start() end\n"
                                "function hall_description() return 'Hall' end\n"
                                "function tower_open() return true end\n"
                                "function key_label() return 'Key' end\n"
                                "function can_unlock() return true end",
                                "typed-interaction-setup"));
    }
};

void drive_to_room(TypedExecutionKernel& kernel)
{
    for (std::size_t iteration = 0; iteration < 64; ++iteration) {
        auto outcome = kernel.run_until_blocked(1, "en");
        if (const auto* changed = std::get_if<core::FlowModeChangedOutcome>(&outcome)) {
            REQUIRE(std::holds_alternative<core::RoomMode>(changed->mode));
            return;
        }
        REQUIRE_FALSE(std::holds_alternative<core::FlowFaultOutcome>(outcome));
    }
    FAIL("Room entry did not complete");
}

void drive_interaction(TypedExecutionKernel& kernel)
{
    for (std::size_t iteration = 0; iteration < 64; ++iteration) {
        auto outcome = kernel.run_until_blocked(1, "en");
        if (const auto* blocked = std::get_if<core::FlowBlockedOutcome>(&outcome)) {
            if (std::holds_alternative<core::InputFlowBlocker>(blocked->blocker)) {
                return;
            }
            if (const auto* script = std::get_if<core::ScriptFlowBlocker>(&blocked->blocker)) {
                auto resumed = kernel.resume_script(script->owner, script->handle);
                REQUIRE(resumed);
                REQUIRE(std::holds_alternative<ScriptInvocationCompleted>(resumed.value()));
            } else {
                const auto* presentation =
                    std::get_if<core::PresentationFlowBlocker>(&blocked->blocker);
                REQUIRE(presentation != nullptr);
                REQUIRE(kernel.pending_presentation_operation());
                kernel.commit_pending_presentation();
                REQUIRE(kernel.complete(presentation->owner, presentation->handle));
            }
            continue;
        }
        if (const auto* changed = std::get_if<core::FlowModeChangedOutcome>(&outcome)) {
            REQUIRE(std::holds_alternative<core::RoomMode>(changed->mode));
            return;
        }
        REQUIRE_FALSE(std::holds_alternative<core::FlowFaultOutcome>(outcome));
    }
    FAIL("Interaction did not complete");
}

nlohmann::json program(nlohmann::json instructions, std::string outcome = "handled")
{
    return {{"instructions", std::move(instructions)},
            {"completion", {{"kind", "return"}}},
            {"outcome", std::move(outcome)}};
}

} // namespace

TEST_CASE("typed Interaction selects exact operands before wildcard and mutates session state")
{
    auto document = load_document();
    definition(document, "verbs", "use")["availability"] = {{"kind", "always"}};
    auto& rules = definition(document, "interactions", "actions")["rules"];
    rules[0]["program"] = program(
        {{{"id", "exact-move"},
          {"kind", "move-interactable"},
          {"interactable", {{"kind", "interactable"}, {"id", "key"}}},
          {"target",
           {{"kind", "inventory"},
            {"inventory", {{"owner", {{"kind", "project"}}}, {"inventoryId", "player"}}}}}}});
    rules[1]["program"] = program({{{"id", "wildcard-move"},
                                    {"kind", "move-interactable"},
                                    {"interactable", {{"kind", "interactable"}, {"id", "key"}}},
                                    {"target", {{"kind", "unplaced"}}}}});

    RuntimeFixture fixture;
    auto project = decode(std::move(document));
    auto created = test_support::create_execution_kernel(project, fixture.runtime);
    REQUIRE(created);
    auto kernel = std::move(created).value();
    drive_to_room(*kernel);

    REQUIRE(kernel->interact(
        id<core::VerbId>("use"),
        {core::compiled::InteractableInteractionSubject{id<core::InteractableId>("key")}}));
    auto active = kernel->interaction_view("en");
    REQUIRE(active);
    REQUIRE(active.value().program);
    const auto* selected = std::get_if<core::InteractionRuleProgramRef>(&*active.value().program);
    REQUIRE(selected != nullptr);
    CHECK(selected->rule == id<core::InteractionRuleId>("any-context"));
    auto runtime_ui = kernel->runtime_ui_view("en");
    REQUIRE(runtime_ui);
    CHECK(runtime_ui.value().mode == "interaction");
    REQUIRE(runtime_ui.value().interaction);
    CHECK(runtime_ui.value().interaction->verb == active.value().verb);
    CHECK(runtime_ui.value().interaction->operands == active.value().operands);
    CHECK_FALSE(runtime_ui.value().scene);
    CHECK_FALSE(runtime_ui.value().dialogue);
    CHECK_FALSE(runtime_ui.value().room);
    drive_interaction(*kernel);

    const auto* key = kernel->state().interactable(id<core::InteractableId>("key"));
    REQUIRE(key != nullptr);
    CHECK(std::holds_alternative<core::compiled::InventoryLocation>(key->location));
}

TEST_CASE("typed Interaction selects typed wildcard before any-subject wildcard")
{
    auto document = load_document();
    definition(document, "verbs", "use")["availability"] = {{"kind", "always"}};
    auto generic = definition(document, "interactions", "actions")["rules"][2];
    generic["id"] = "generic-subject";
    generic["operands"] = nlohmann::json::array({{{"kind", "any-subject"}}});
    generic["context"] = {{"kind", "any"}};
    generic["program"] = program(nlohmann::json::array());
    auto typed = generic;
    typed["id"] = "typed-interactable";
    typed["operands"] = nlohmann::json::array({{{"kind", "any-interactable"}}});
    definition(document, "interactions", "actions")["rules"] =
        nlohmann::json::array({std::move(generic), std::move(typed)});

    RuntimeFixture fixture;
    auto project = decode(std::move(document));
    auto created = test_support::create_execution_kernel(project, fixture.runtime);
    REQUIRE(created);
    auto kernel = std::move(created).value();
    drive_to_room(*kernel);

    REQUIRE(kernel->interact(
        id<core::VerbId>("use"),
        {core::compiled::InteractableInteractionSubject{id<core::InteractableId>("key")}}));
    auto interaction = kernel->interaction_view("en");
    REQUIRE(interaction);
    REQUIRE(interaction.value().program);
    const auto* selected =
        std::get_if<core::InteractionRuleProgramRef>(&*interaction.value().program);
    REQUIRE(selected != nullptr);
    CHECK(selected->rule == id<core::InteractionRuleId>("typed-interactable"));
}

TEST_CASE("typed Interaction wildcard operands cannot overwrite an earlier mismatch")
{
    auto document = load_document();
    auto exact_then_wildcard = definition(document, "interactions", "actions")["rules"][2];
    exact_then_wildcard["id"] = "mismatched-exact";
    exact_then_wildcard["verb"] = {{"kind", "verb"}, {"id", "combine"}};
    auto mismatched_operands = nlohmann::json::array();
    mismatched_operands.push_back(
        {{"kind", "exact"},
         {"subject",
          {{"kind", "interactable"},
           {"interactable", {{"kind", "interactable"}, {"id", "coin"}}}}}});
    mismatched_operands.push_back({{"kind", "any-interactable"}});
    exact_then_wildcard["operands"] = std::move(mismatched_operands);
    exact_then_wildcard["context"] = {{"kind", "any"}};
    exact_then_wildcard["program"] = program(nlohmann::json::array());
    auto generic = exact_then_wildcard;
    generic["id"] = "matching-wildcards";
    generic["operands"] = nlohmann::json::array();
    generic["operands"].push_back({{"kind", "any-interactable"}});
    generic["operands"].push_back({{"kind", "any-interactable"}});
    definition(document, "interactions", "actions")["rules"] =
        nlohmann::json::array({std::move(exact_then_wildcard), std::move(generic)});

    RuntimeFixture fixture;
    auto project = decode(std::move(document));
    auto created = test_support::create_execution_kernel(project, fixture.runtime);
    REQUIRE(created);
    auto kernel = std::move(created).value();
    drive_to_room(*kernel);

    const auto key =
        core::compiled::InteractableInteractionSubject{id<core::InteractableId>("key")};
    REQUIRE(kernel->interact(id<core::VerbId>("combine"), {key, key}));
    auto interaction = kernel->interaction_view("en");
    REQUIRE(interaction);
    REQUIRE(interaction.value().program);
    const auto* selected =
        std::get_if<core::InteractionRuleProgramRef>(&*interaction.value().program);
    REQUIRE(selected != nullptr);
    CHECK(selected->rule == id<core::InteractionRuleId>("matching-wildcards"));
}

TEST_CASE("typed Interaction and Room publication preserve exact live item Stack identity")
{
    auto document = load_document();
    definition(document, "verbs", "use")["availability"] = {{"kind", "always"}};
    auto exact = definition(document, "interactions", "actions")["rules"][2];
    exact["id"] = "exact-wallet";
    exact["operands"] = nlohmann::json::array(
        {{{"kind", "exact"},
          {"subject",
           {{"kind", "item-stack"}, {"itemStack", {{"kind", "item-stack"}, {"id", "wallet"}}}}}}});
    exact["context"] = {{"kind", "any"}};
    exact["program"] = program(nlohmann::json::array());
    auto wildcard = exact;
    wildcard["id"] = "any-item-stack";
    wildcard["operands"] = nlohmann::json::array({{{"kind", "any-item-stack"}}});
    definition(document, "interactions", "actions")["rules"] =
        nlohmann::json::array({std::move(wildcard), std::move(exact)});

    RuntimeFixture fixture;
    auto project = decode(std::move(document));
    auto created = test_support::create_execution_kernel(project, fixture.runtime);
    REQUIRE(created);
    auto kernel = std::move(created).value();
    const auto wallet = id<core::ItemStackId>("wallet");
    REQUIRE(kernel->gateway().transfer_item_quantity(
        wallet, 25, core::compiled::RoomLocation{id<core::RoomId>("start")},
        runtime::ItemStackPlacementPolicy::KeepSeparate));
    drive_to_room(*kernel);
    auto room = kernel->room_view("en");
    REQUIRE(room);
    REQUIRE(room.value().item_stacks.size() == 1);
    CHECK(room.value().item_stacks.front().stack == wallet);
    CHECK(room.value().item_stacks.front().quantity == 25);

    const core::compiled::InteractionSubject subject =
        core::compiled::ItemStackInteractionSubject{wallet};
    REQUIRE(kernel->interact(id<core::VerbId>("use"), {subject}));
    auto interaction = kernel->interaction_view("en");
    REQUIRE(interaction);
    CHECK(interaction.value().operands == std::vector<core::compiled::InteractionSubject>{subject});
    REQUIRE(interaction.value().program);
    const auto* selected =
        std::get_if<core::InteractionRuleProgramRef>(&*interaction.value().program);
    REQUIRE(selected != nullptr);
    CHECK(selected->rule == id<core::InteractionRuleId>("exact-wallet"));
}

TEST_CASE(
    "typed Interaction falls back to the selected Verb default then emits typed undefined fallback")
{
    auto document = load_document();
    definition(document, "interactions", "actions")["rules"] = nlohmann::json::array();
    definition(document, "verbs", "unlock")["availability"] = {{"kind", "always"}};
    definition(document, "verbs", "unlock")["defaultProgram"] =
        program(nlohmann::json::array(), "unhandled");
    definition(document, "verbs", "use")["availability"] = {{"kind", "always"}};
    definition(document, "verbs", "use")["defaultProgram"] =
        program(nlohmann::json::array(), "unhandled");

    RuntimeFixture fixture;
    auto project = decode(std::move(document));
    auto created = test_support::create_execution_kernel(project, fixture.runtime);
    REQUIRE(created);
    auto kernel = std::move(created).value();
    drive_to_room(*kernel);

    REQUIRE(kernel->interact(
        id<core::VerbId>("unlock"),
        {core::compiled::InteractableInteractionSubject{id<core::InteractableId>("key")}}));
    drive_interaction(*kernel);
    const auto found = std::find_if(
        kernel->gateway().events().begin(), kernel->gateway().events().end(),
        [](const runtime::RuntimeEvent& event) {
            const auto* notification = std::get_if<runtime::NotificationEvent>(&event);
            return notification != nullptr && notification->message == "Nothing happens.";
        });
    CHECK(found != kernel->gateway().events().end());

    auto inventory = kernel->inventory_view("en");
    REQUIRE(inventory);
    REQUIRE(inventory.value().item_stacks.size() == 1);
    CHECK(inventory.value().item_stacks.front().stack == id<core::ItemStackId>("wallet"));
    CHECK(inventory.value().item_stacks.front().quantity == 25);
    CHECK(std::any_of(inventory.value().controls.begin(), inventory.value().controls.end(),
                      [](const auto& control) { return control.quick_action; }));
    auto room = kernel->room_view("en");
    REQUIRE(room);
    CHECK(room.value().controls.size() == inventory.value().controls.size());
}

TEST_CASE("Room and Interactable Features preserve owner-qualified semantic invocation")
{
    SECTION("Room Feature")
    {
        RuntimeFixture fixture;
        auto project = decode(load_document());
        auto created = test_support::create_execution_kernel(project, fixture.runtime);
        REQUIRE(created);
        auto kernel = std::move(created).value();
        drive_to_room(*kernel);

        const core::compiled::InteractionSubject subject =
            core::compiled::FeatureInteractionSubject{
                core::RoomFeatureRef{id<core::RoomId>("start"), id<core::FeatureId>("door")}};
        REQUIRE(kernel->interact(id<core::VerbId>("inspect"), {subject}));
        auto interaction = kernel->interaction_view("en");
        REQUIRE(interaction);
        CHECK(interaction.value().operands ==
              std::vector<core::compiled::InteractionSubject>{subject});
        REQUIRE(interaction.value().program);
        const auto* program =
            std::get_if<core::InteractionRuleProgramRef>(&*interaction.value().program);
        REQUIRE(program != nullptr);
        CHECK(program->rule == id<core::InteractionRuleId>("room-feature"));
    }

    SECTION("Interactable Feature")
    {
        auto document = load_document();
        definition(document, "verbs", "use")["availability"] = {{"kind", "always"}};
        RuntimeFixture fixture;
        auto project = decode(std::move(document));
        auto created = test_support::create_execution_kernel(project, fixture.runtime);
        REQUIRE(created);
        auto kernel = std::move(created).value();
        drive_to_room(*kernel);

        const core::compiled::InteractionSubject subject =
            core::compiled::FeatureInteractionSubject{core::InteractableFeatureRef{
                id<core::InteractableId>("key"), id<core::FeatureId>("surface")}};
        REQUIRE(kernel->interact(id<core::VerbId>("use"), {subject}));
        auto interaction = kernel->interaction_view("en");
        REQUIRE(interaction);
        CHECK(interaction.value().operands ==
              std::vector<core::compiled::InteractionSubject>{subject});
        REQUIRE(interaction.value().program);
        const auto* program =
            std::get_if<core::InteractionRuleProgramRef>(&*interaction.value().program);
        REQUIRE(program != nullptr);
        CHECK(program->rule == id<core::InteractionRuleId>("interactable-feature"));
    }
}

TEST_CASE("Interactable subjects remain distinct from owner Feature subjects")
{
    auto document = load_document();
    definition(document, "verbs", "use")["availability"] = {{"kind", "always"}};

    RuntimeFixture fixture;
    auto project = decode(std::move(document));
    auto created = test_support::create_execution_kernel(project, fixture.runtime);
    REQUIRE(created);
    auto kernel = std::move(created).value();
    drive_to_room(*kernel);

    REQUIRE(kernel->interact(
        id<core::VerbId>("use"),
        {core::compiled::InteractableInteractionSubject{id<core::InteractableId>("key")}}));
    auto active = kernel->interaction_view("en");
    REQUIRE(active);
    REQUIRE(active.value().program);
    const auto* selected = std::get_if<core::InteractionRuleProgramRef>(&*active.value().program);
    REQUIRE(selected != nullptr);
    CHECK(selected->rule == id<core::InteractionRuleId>("any-context"));
}

TEST_CASE("Room exit semantic navigation preserves selected-exit identity")
{
    RuntimeFixture fixture;
    auto project = decode(load_document());
    auto created = test_support::create_execution_kernel(project, fixture.runtime);
    REQUIRE(created);
    auto kernel = std::move(created).value();
    drive_to_room(*kernel);

    REQUIRE(kernel->navigate(id<core::RoomExitId>("north-exit")));
    REQUIRE_FALSE(kernel->state().flow_stack().empty());
    const auto* frame =
        std::get_if<core::RoomTransitionFrame>(&kernel->state().flow_stack().back());
    REQUIRE(frame != nullptr);
    REQUIRE(frame->selected_exit);
    CHECK(frame->selected_exit->room == id<core::RoomId>("start"));
    CHECK(frame->selected_exit->exit_id == id<core::RoomExitId>("north-exit"));
}

} // namespace noveltea::script::test
