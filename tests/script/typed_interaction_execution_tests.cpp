#include <catch2/catch_test_macros.hpp>

#include "noveltea/core/compiled_project_codec.hpp"
#include "noveltea/script/script_runtime.hpp"
#include "noveltea/runtime/runtime_executor.hpp"
#include "fake_script_source.hpp"
#include "runtime_test_services.hpp"

#include <algorithm>
#include <array>
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
    if (!decoded)
        for (const auto& diagnostic : decoded.error())
            UNSCOPED_INFO(diagnostic.code << ": " << diagnostic.message << " @ "
                                          << diagnostic.json_pointer);
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
                                "function can_unlock() return true end\n"
                                "function offer_false() return false end\n"
                                "function yielding_interaction() coroutine.yield() end",
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

void drive_interaction(TypedExecutionKernel& kernel, std::string_view locale = "en")
{
    for (std::size_t iteration = 0; iteration < 64; ++iteration) {
        auto outcome = kernel.run_until_blocked(1, locale);
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

nlohmann::json interactable_operand(std::string id)
{
    return {{"kind", "interactable"},
            {"interactable", {{"kind", "interactable"}, {"id", std::move(id)}}}};
}

nlohmann::json inventory_location(nlohmann::json owner, std::string inventory_id)
{
    return {
        {"kind", "inventory"},
        {"inventory",
         {{"kind", "inventory"},
          {"inventory", {{"owner", std::move(owner)}, {"inventoryId", std::move(inventory_id)}}}}}};
}

nlohmann::json move_instance(std::string id, std::string interactable, nlohmann::json location)
{
    return {{"id", std::move(id)},
            {"kind", "move-instance"},
            {"subject", interactable_operand(std::move(interactable))},
            {"location", std::move(location)}};
}

} // namespace

TEST_CASE(
    "typed Interaction selects exact selector before broader selector and mutates session state")
{
    auto document = load_document();
    definition(document, "verbs", "use")["availability"] = {{"kind", "always"}};
    auto& rules = definition(document, "interactions", "actions")["rules"];
    rules[0]["program"] = program(nlohmann::json::array(
        {move_instance("exact-move", "key", inventory_location({{"kind", "project"}}, "player"))}));
    rules[1]["program"] = program(
        nlohmann::json::array({move_instance("wildcard-move", "key", {{"kind", "unplaced"}})}));

    RuntimeFixture fixture;
    auto project = decode(std::move(document));
    auto created = test_support::create_execution_kernel(project, fixture.runtime);
    REQUIRE(created);
    auto kernel = std::move(created).value();
    drive_to_room(*kernel);

    REQUIRE(kernel->interact(
        id<core::VerbId>("use"),
        {{id<core::VerbSlotId>("target"), core::compiled::InteractableInteractionSubject{
                                              id<core::InteractableInstanceId>("key")}}}));
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
    CHECK(runtime_ui.value().interaction->bindings == active.value().bindings);
    CHECK_FALSE(runtime_ui.value().scene);
    CHECK_FALSE(runtime_ui.value().dialogue);
    REQUIRE(runtime_ui.value().room);
    CHECK(runtime_ui.value().room->room == id<core::RoomId>("start"));
    drive_interaction(*kernel);

    const auto* key = kernel->state().interactable(id<core::InteractableInstanceId>("key"));
    REQUIRE(key != nullptr);
    CHECK(std::holds_alternative<core::compiled::InventoryLocation>(key->location));
}

TEST_CASE("typed Interaction selects typed wildcard before any-subject wildcard")
{
    auto document = load_document();
    definition(document, "verbs", "use")["availability"] = {{"kind", "always"}};
    auto generic = definition(document, "interactions", "actions")["rules"][2];
    generic["id"] = "generic-subject";
    generic["slots"] = nlohmann::json::array(
        {{{"slotId", "target"},
          {"selectors", nlohmann::json::array({{{"kind", "any-subject"}}})}}});
    generic["program"] = program(nlohmann::json::array());
    auto typed = generic;
    typed["id"] = "typed-interactable";
    typed["slots"] = nlohmann::json::array(
        {{{"slotId", "target"},
          {"selectors",
           nlohmann::json::array({{{"kind", "family"}, {"family", "interactable"}}})}}});
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
        {{id<core::VerbSlotId>("target"), core::compiled::InteractableInteractionSubject{
                                              id<core::InteractableInstanceId>("key")}}}));
    auto interaction = kernel->interaction_view("en");
    REQUIRE(interaction);
    REQUIRE(interaction.value().program);
    const auto* selected =
        std::get_if<core::InteractionRuleProgramRef>(&*interaction.value().program);
    REQUIRE(selected != nullptr);
    CHECK(selected->rule == id<core::InteractionRuleId>("typed-interactable"));
}

TEST_CASE("Interaction Guard fallthrough advances from a false narrower tier to a broader tier")
{
    auto document = load_document();
    definition(document, "verbs", "use")["availability"] = {{"kind", "always"}};
    auto narrow = definition(document, "interactions", "actions")["rules"][2];
    narrow["id"] = "narrow-false";
    narrow["guard"] = {{"kind", "lua-predicate"}, {"source", "offer_false()"}};
    narrow["priority"] = 100;
    narrow["program"] = program(nlohmann::json::array());
    auto broad = narrow;
    broad["id"] = "broad-true";
    broad["guard"] = {{"kind", "always"}};
    broad["priority"] = 0;
    broad["slots"][0]["selectors"] =
        nlohmann::json::array({{{"kind", "family"}, {"family", "interactable"}}});
    definition(document, "interactions", "actions")["rules"] =
        nlohmann::json::array({std::move(broad), std::move(narrow)});

    RuntimeFixture fixture;
    auto project = decode(std::move(document));
    auto created = test_support::create_execution_kernel(project, fixture.runtime);
    REQUIRE(created);
    auto kernel = std::move(created).value();
    drive_to_room(*kernel);

    const core::compiled::InteractionSubject key =
        core::compiled::InteractableInteractionSubject{id<core::InteractableInstanceId>("key")};
    REQUIRE(kernel->interact(id<core::VerbId>("use"), {{id<core::VerbSlotId>("target"), key}}));
    auto interaction = kernel->interaction_view("en");
    REQUIRE(interaction);
    REQUIRE(interaction.value().program);
    const auto* selected =
        std::get_if<core::InteractionRuleProgramRef>(&*interaction.value().program);
    REQUIRE(selected != nullptr);
    CHECK(selected->rule == id<core::InteractionRuleId>("broad-true"));
}

TEST_CASE("Interaction priority selects one passing rule within a structural tier")
{
    auto document = load_document();
    definition(document, "verbs", "use")["availability"] = {{"kind", "always"}};
    auto low = definition(document, "interactions", "actions")["rules"][2];
    low["id"] = "low-priority";
    low["guard"] = {{"kind", "always"}};
    low["priority"] = 5;
    low["program"] = program(nlohmann::json::array());
    auto high = low;
    high["id"] = "high-priority";
    high["priority"] = 10;
    definition(document, "interactions", "actions")["rules"] =
        nlohmann::json::array({std::move(low), std::move(high)});

    RuntimeFixture fixture;
    auto project = decode(std::move(document));
    auto created = test_support::create_execution_kernel(project, fixture.runtime);
    REQUIRE(created);
    auto kernel = std::move(created).value();
    drive_to_room(*kernel);

    const core::compiled::InteractionSubject key =
        core::compiled::InteractableInteractionSubject{id<core::InteractableInstanceId>("key")};
    REQUIRE(kernel->interact(id<core::VerbId>("use"), {{id<core::VerbSlotId>("target"), key}}));
    auto interaction = kernel->interaction_view("en");
    REQUIRE(interaction);
    REQUIRE(interaction.value().program);
    const auto* selected =
        std::get_if<core::InteractionRuleProgramRef>(&*interaction.value().program);
    REQUIRE(selected != nullptr);
    CHECK(selected->rule == id<core::InteractionRuleId>("high-priority"));
}

TEST_CASE("equal-priority passing Interaction rules fault as ambiguous before execution")
{
    auto document = load_document();
    definition(document, "verbs", "use")["availability"] = {{"kind", "always"}};
    auto first = definition(document, "interactions", "actions")["rules"][2];
    first["id"] = "ambiguous-a";
    first["guard"] = {{"kind", "always"}};
    first["priority"] = 10;
    first["program"] =
        program(nlohmann::json::array({move_instance("move", "key", {{"kind", "unplaced"}})}));
    auto second = first;
    second["id"] = "ambiguous-b";
    definition(document, "interactions", "actions")["rules"] =
        nlohmann::json::array({std::move(first), std::move(second)});

    RuntimeFixture fixture;
    auto project = decode(std::move(document));
    auto created = test_support::create_execution_kernel(project, fixture.runtime);
    REQUIRE(created);
    auto kernel = std::move(created).value();
    drive_to_room(*kernel);

    const core::compiled::InteractionSubject key_subject =
        core::compiled::InteractableInteractionSubject{id<core::InteractableInstanceId>("key")};
    CHECK_FALSE(
        kernel->interact(id<core::VerbId>("use"), {{id<core::VerbSlotId>("target"), key_subject}}));
    const auto* key = kernel->state().interactable(id<core::InteractableInstanceId>("key"));
    REQUIRE(key != nullptr);
    CHECK(std::holds_alternative<core::compiled::RoomLocation>(key->location));
    CHECK(std::holds_alternative<core::RoomMode>(kernel->state().mode()));
}

TEST_CASE("Interaction Guard errors fault before behavior execution")
{
    auto document = load_document();
    definition(document, "verbs", "use")["availability"] = {{"kind", "always"}};
    auto rule = definition(document, "interactions", "actions")["rules"][2];
    rule["id"] = "guard-error";
    rule["guard"] = {{"kind", "lua-predicate"}, {"source", "error('guard failed')"}};
    rule["program"] =
        program(nlohmann::json::array({move_instance("move", "key", {{"kind", "unplaced"}})}));
    definition(document, "interactions", "actions")["rules"] =
        nlohmann::json::array({std::move(rule)});

    RuntimeFixture fixture;
    auto project = decode(std::move(document));
    auto created = test_support::create_execution_kernel(project, fixture.runtime);
    REQUIRE(created);
    auto kernel = std::move(created).value();
    drive_to_room(*kernel);

    const core::compiled::InteractionSubject key_subject =
        core::compiled::InteractableInteractionSubject{id<core::InteractableInstanceId>("key")};
    CHECK_FALSE(
        kernel->interact(id<core::VerbId>("use"), {{id<core::VerbSlotId>("target"), key_subject}}));
    const auto* key = kernel->state().interactable(id<core::InteractableInstanceId>("key"));
    REQUIRE(key != nullptr);
    CHECK(std::holds_alternative<core::compiled::RoomLocation>(key->location));
}

TEST_CASE("compact Interaction mutation batches validate atomically before commit")
{
    auto document = load_document();
    definition(document, "verbs", "use")["availability"] = {{"kind", "always"}};
    auto rule = definition(document, "interactions", "actions")["rules"][2];
    rule["id"] = "atomic-cycle";
    const nlohmann::json key_into_coin = move_instance(
        "key-into-coin", "key",
        inventory_location({{"kind", "interactable"},
                            {"interactable", {{"kind", "interactable"}, {"id", "coin"}}}},
                           "pouch"));
    const nlohmann::json coin_into_key = move_instance(
        "coin-into-key", "coin",
        inventory_location(
            {{"kind", "interactable"}, {"interactable", {{"kind", "interactable"}, {"id", "key"}}}},
            "hidden"));
    rule["program"] =
        program(nlohmann::json::array({std::move(key_into_coin), std::move(coin_into_key)}));
    definition(document, "interactions", "actions")["rules"] =
        nlohmann::json::array({std::move(rule)});

    RuntimeFixture fixture;
    auto project = decode(std::move(document));
    auto created = test_support::create_execution_kernel(project, fixture.runtime);
    REQUIRE(created);
    auto kernel = std::move(created).value();
    drive_to_room(*kernel);

    const core::compiled::InteractionSubject key_subject =
        core::compiled::InteractableInteractionSubject{id<core::InteractableInstanceId>("key")};
    REQUIRE(
        kernel->interact(id<core::VerbId>("use"), {{id<core::VerbSlotId>("target"), key_subject}}));
    auto outcome = kernel->run_until_blocked(8, "en");
    REQUIRE(std::holds_alternative<core::FlowFaultOutcome>(outcome));
    const auto* key = kernel->state().interactable(id<core::InteractableInstanceId>("key"));
    REQUIRE(key != nullptr);
    CHECK(std::holds_alternative<core::compiled::RoomLocation>(key->location));
}

TEST_CASE("committed Interaction effects survive a later Lua handoff failure without fallback")
{
    auto document = load_document();
    definition(document, "verbs", "use")["availability"] = {{"kind", "always"}};
    auto rule = definition(document, "interactions", "actions")["rules"][2];
    rule["id"] = "commit-then-fail";
    const nlohmann::json move = {
        {"id", "move"},
        {"kind", "move-instance"},
        {"subject",
         {{"kind", "interactable"}, {"interactable", {{"kind", "interactable"}, {"id", "key"}}}}},
        {"location",
         {{"kind", "inventory"},
          {"inventory",
           {{"kind", "inventory"},
            {"inventory", {{"owner", {{"kind", "project"}}}, {"inventoryId", "player"}}}}}}},
    };
    const nlohmann::json lua = {
        {"id", "lua"},
        {"kind", "run-lua"},
        {"source", "error('terminal failed')"},
    };
    rule["program"] = program(nlohmann::json::array({std::move(move), std::move(lua)}));
    definition(document, "interactions", "actions")["rules"] =
        nlohmann::json::array({std::move(rule)});

    RuntimeFixture fixture;
    auto project = decode(std::move(document));
    auto created = test_support::create_execution_kernel(project, fixture.runtime);
    REQUIRE(created);
    auto kernel = std::move(created).value();
    drive_to_room(*kernel);

    const core::compiled::InteractionSubject key_subject =
        core::compiled::InteractableInteractionSubject{id<core::InteractableInstanceId>("key")};
    REQUIRE(
        kernel->interact(id<core::VerbId>("use"), {{id<core::VerbSlotId>("target"), key_subject}}));
    auto outcome = kernel->run_until_blocked(8, "en");
    REQUIRE(std::holds_alternative<core::FlowFaultOutcome>(outcome));
    const auto* key = kernel->state().interactable(id<core::InteractableInstanceId>("key"));
    REQUIRE(key != nullptr);
    CHECK(std::holds_alternative<core::compiled::InventoryLocation>(key->location));
    const auto fallback = std::find_if(
        kernel->gateway().events().begin(), kernel->gateway().events().end(),
        [](const runtime::RuntimeEvent& event) {
            const auto* notification = std::get_if<runtime::NotificationEvent>(&event);
            return notification != nullptr && notification->message == "Nothing happens.";
        });
    CHECK(fallback == kernel->gateway().events().end());
}

TEST_CASE("Interaction nested If resumes a yielding command after committing prior mutations")
{
    auto document = load_document();
    definition(document, "verbs", "use")["availability"] = {{"kind", "always"}};
    auto rule = definition(document, "interactions", "actions")["rules"][2];
    rule["id"] = "nested-yield";
    const auto move =
        move_instance("move", "key", inventory_location({{"kind", "project"}}, "player"));
    const nlohmann::json yield = {
        {"id", "yield"}, {"kind", "run-lua"}, {"source", "yielding_interaction()"}};
    const nlohmann::json nested_after = {
        {"id", "nested-after"},
        {"kind", "notify"},
        {"message",
         {{"markup", "plain"}, {"source", {{"kind", "inline"}, {"text", "nested-after"}}}}},
    };
    const nlohmann::json branch = {
        {"id", "branch"},
        {"kind", "if"},
        {"condition", {{"kind", "always"}}},
        {"then", nlohmann::json::array({move, yield, nested_after})},
        {"else", nlohmann::json::array()},
    };
    const nlohmann::json root_after = {
        {"id", "root-after"},
        {"kind", "notify"},
        {"message",
         {{"markup", "plain"}, {"source", {{"kind", "inline"}, {"text", "root-after"}}}}},
    };
    rule["program"] = program(nlohmann::json::array({branch, root_after}));
    definition(document, "interactions", "actions")["rules"] =
        nlohmann::json::array({std::move(rule)});

    RuntimeFixture fixture;
    auto project = decode(std::move(document));
    auto created = test_support::create_execution_kernel(project, fixture.runtime);
    REQUIRE(created);
    auto kernel = std::move(created).value();
    drive_to_room(*kernel);

    const core::compiled::InteractionSubject key_subject =
        core::compiled::InteractableInteractionSubject{id<core::InteractableInstanceId>("key")};
    REQUIRE(
        kernel->interact(id<core::VerbId>("use"), {{id<core::VerbSlotId>("target"), key_subject}}));
    auto yielded = kernel->run_until_blocked(100, "en");
    const auto* blocked = std::get_if<core::FlowBlockedOutcome>(&yielded);
    REQUIRE(blocked != nullptr);
    const auto* script = std::get_if<core::ScriptFlowBlocker>(&blocked->blocker);
    REQUIRE(script != nullptr);
    const auto* key = kernel->state().interactable(id<core::InteractableInstanceId>("key"));
    REQUIRE(key != nullptr);
    CHECK(std::holds_alternative<core::compiled::InventoryLocation>(key->location));

    auto resumed = kernel->resume_script(script->owner, script->handle);
    REQUIRE(resumed);
    REQUIRE(std::holds_alternative<ScriptInvocationCompleted>(resumed.value()));
    drive_interaction(*kernel);

    const auto nested = std::ranges::count_if(kernel->gateway().events(), [](const auto& event) {
        const auto* notification = std::get_if<runtime::NotificationEvent>(&event);
        return notification && notification->message == "nested-after";
    });
    const auto root = std::ranges::count_if(kernel->gateway().events(), [](const auto& event) {
        const auto* notification = std::get_if<runtime::NotificationEvent>(&event);
        return notification && notification->message == "root-after";
    });
    CHECK(nested == 1);
    CHECK(root == 1);
}

TEST_CASE("named Verb slots allow the same live subject to bind more than once")
{
    auto document = load_document();
    auto& use = definition(document, "verbs", "use");
    use["availability"] = {{"kind", "always"}};
    const auto second_slot = use["slots"][0];
    use["slots"][0]["id"] = "source";
    use["slots"][0]["label"]["source"]["text"] = "source";
    use["slots"][0]["prompt"]["source"]["text"] = "source";
    use["slots"].push_back(second_slot);
    use["bindingOrder"] = nlohmann::json::array({"source", "target"});
    definition(document, "interactions", "actions")["rules"] = nlohmann::json::array();

    RuntimeFixture fixture;
    auto project = decode(std::move(document));
    auto created = test_support::create_execution_kernel(project, fixture.runtime);
    REQUIRE(created);
    auto kernel = std::move(created).value();
    drive_to_room(*kernel);

    const core::compiled::InteractionSubject subject =
        core::compiled::InteractableInteractionSubject{id<core::InteractableInstanceId>("key")};
    REQUIRE(kernel->interact(id<core::VerbId>("use"), {{id<core::VerbSlotId>("source"), subject},
                                                       {id<core::VerbSlotId>("target"), subject}}));
    auto interaction = kernel->interaction_view("en");
    REQUIRE(interaction);
    CHECK(interaction.value().bindings ==
          std::vector<core::InteractionSubjectBinding>{{id<core::VerbSlotId>("source"), subject},
                                                       {id<core::VerbSlotId>("target"), subject}});
}

TEST_CASE("typed Interaction selector unions cannot overwrite an earlier mismatch")
{
    auto document = load_document();
    auto exact_then_wildcard = definition(document, "interactions", "actions")["rules"][2];
    exact_then_wildcard["id"] = "mismatched-exact";
    exact_then_wildcard["verb"] = {{"kind", "verb"}, {"id", "combine"}};
    exact_then_wildcard["slots"] = nlohmann::json::array(
        {{{"slotId", "first"},
          {"selectors", nlohmann::json::array(
                            {{{"kind", "exact"},
                              {"subject",
                               {{"kind", "interactable"},
                                {"interactable", {{"kind", "interactable"}, {"id", "coin"}}}}}}})}},
         {{"slotId", "second"},
          {"selectors",
           nlohmann::json::array({{{"kind", "family"}, {"family", "interactable"}}})}}});
    exact_then_wildcard["offer"] = nullptr;
    exact_then_wildcard["program"] = program(nlohmann::json::array());
    auto generic = exact_then_wildcard;
    generic["id"] = "matching-wildcards";
    generic["slots"] = nlohmann::json::array(
        {{{"slotId", "first"},
          {"selectors", nlohmann::json::array({{{"kind", "family"}, {"family", "interactable"}}})}},
         {{"slotId", "second"},
          {"selectors",
           nlohmann::json::array({{{"kind", "family"}, {"family", "interactable"}}})}}});
    definition(document, "interactions", "actions")["rules"] =
        nlohmann::json::array({std::move(exact_then_wildcard), std::move(generic)});

    RuntimeFixture fixture;
    auto project = decode(std::move(document));
    auto created = test_support::create_execution_kernel(project, fixture.runtime);
    REQUIRE(created);
    auto kernel = std::move(created).value();
    drive_to_room(*kernel);

    const auto key =
        core::compiled::InteractableInteractionSubject{id<core::InteractableInstanceId>("key")};
    REQUIRE(kernel->interact(id<core::VerbId>("combine"), {{id<core::VerbSlotId>("first"), key},
                                                           {id<core::VerbSlotId>("second"), key}}));
    auto interaction = kernel->interaction_view("en");
    REQUIRE(interaction);
    REQUIRE(interaction.value().program);
    const auto* selected =
        std::get_if<core::InteractionRuleProgramRef>(&*interaction.value().program);
    REQUIRE(selected != nullptr);
    CHECK(selected->rule == id<core::InteractionRuleId>("matching-wildcards"));
}

TEST_CASE("Verb Offers resolve exact rule-derived declarations before broader Verb declarations")
{
    auto document = load_document();
    definition(document, "verbs", "use")["availability"] = {{"kind", "always"}};

    RuntimeFixture fixture;
    auto project = decode(std::move(document));
    auto created = test_support::create_execution_kernel(project, fixture.runtime);
    REQUIRE(created);
    auto kernel = std::move(created).value();
    drive_to_room(*kernel);

    const core::compiled::InteractionSubject key =
        core::compiled::InteractableInteractionSubject{id<core::InteractableInstanceId>("key")};
    auto offers = kernel->verb_offers(key, "en");
    REQUIRE(offers);
    const auto use =
        std::find_if(offers.value().begin(), offers.value().end(),
                     [](const auto& offer) { return offer.verb == id<core::VerbId>("use"); });
    REQUIRE(use != offers.value().end());
    CHECK(use->slot == id<core::VerbSlotId>("target"));
    CHECK(use->rank == 5);
    CHECK(use->primary);
}

TEST_CASE("resident Interaction prediction keeps only programs plausible for Current Room subjects")
{
    auto document = load_document();
    auto& use = definition(document, "verbs", "use");
    use["availability"] = {{"kind", "always"}};
    auto& rules = definition(document, "interactions", "actions")["rules"];
    const auto source = std::find_if(rules.begin(), rules.end(),
                                     [](const auto& rule) { return rule["id"] == "any-context"; });
    REQUIRE(source != rules.end());
    auto absent = *source;
    absent["id"] = "absent-coin";
    absent["offer"] = nullptr;
    absent["slots"][0]["selectors"][0]["subject"]["interactable"]["id"] = "coin";
    rules.push_back(std::move(absent));

    RuntimeFixture fixture;
    auto project = decode(std::move(document));
    auto created = test_support::create_execution_kernel(project, fixture.runtime);
    REQUIRE(created);
    auto kernel = std::move(created).value();
    drive_to_room(*kernel);

    const std::array enabled{id<core::VerbId>("use")};
    const auto resident = kernel->resident_interaction_programs(enabled);
    CHECK(std::any_of(resident.begin(), resident.end(), [](const auto& program) {
        const auto* rule = std::get_if<core::InteractionRuleProgramRef>(&program);
        return rule != nullptr && rule->rule == id<core::InteractionRuleId>("any-context");
    }));
    CHECK_FALSE(std::any_of(resident.begin(), resident.end(), [](const auto& program) {
        const auto* rule = std::get_if<core::InteractionRuleProgramRef>(&program);
        return rule != nullptr && rule->rule == id<core::InteractionRuleId>("absent-coin");
    }));
    CHECK(std::any_of(resident.begin(), resident.end(), [](const auto& program) {
        const auto* fallback = std::get_if<core::VerbDefaultProgramRef>(&program);
        return fallback != nullptr && fallback->verb == id<core::VerbId>("use");
    }));
}

TEST_CASE("a false most-specific Verb Offer suppresses the Verb without broader fallback")
{
    auto document = load_document();
    auto& rules = definition(document, "interactions", "actions")["rules"];
    const auto room_feature = std::find_if(
        rules.begin(), rules.end(), [](const auto& rule) { return rule["id"] == "room-feature"; });
    REQUIRE(room_feature != rules.end());
    (*room_feature)["offer"]["condition"] = {{"kind", "lua-predicate"},
                                             {"source", "offer_false()"}};

    RuntimeFixture fixture;
    auto project = decode(std::move(document));
    auto created = test_support::create_execution_kernel(project, fixture.runtime);
    REQUIRE(created);
    auto kernel = std::move(created).value();
    drive_to_room(*kernel);

    const core::compiled::InteractionSubject door = core::compiled::FeatureInteractionSubject{
        core::RoomFeatureRef{id<core::RoomId>("start"), id<core::FeatureId>("door")}};
    auto offers = kernel->verb_offers(door, "en");
    REQUIRE(offers);
    CHECK(std::none_of(offers.value().begin(), offers.value().end(), [](const auto& offer) {
        return offer.verb == id<core::VerbId>("inspect");
    }));
}

TEST_CASE("Verb Offer publication orders equal authored ranks by stable Verb ID")
{
    auto document = load_document();
    auto& inspect = definition(document, "verbs", "inspect");
    inspect["offers"].push_back(
        {{"id", "inspect-key"},
         {"slotId", "target"},
         {"selectors", nlohmann::json::array(
                           {{{"kind", "exact"},
                             {"subject",
                              {{"kind", "interactable"},
                               {"interactable", {{"kind", "interactable"}, {"id", "key"}}}}}}})},
         {"rank", 20},
         {"primary", false}});
    definition(document, "verbs", "use")["availability"] = {{"kind", "always"}};
    auto& rules = definition(document, "interactions", "actions")["rules"];
    const auto use_rule = std::find_if(
        rules.begin(), rules.end(), [](const auto& rule) { return rule["id"] == "any-context"; });
    REQUIRE(use_rule != rules.end());
    (*use_rule)["offer"] = nullptr;

    RuntimeFixture fixture;
    auto project = decode(std::move(document));
    auto created = test_support::create_execution_kernel(project, fixture.runtime);
    REQUIRE(created);
    auto kernel = std::move(created).value();
    drive_to_room(*kernel);

    const core::compiled::InteractionSubject key =
        core::compiled::InteractableInteractionSubject{id<core::InteractableInstanceId>("key")};
    auto offers = kernel->verb_offers(key, "en");
    REQUIRE(offers);
    const auto inspect_offer =
        std::find_if(offers.value().begin(), offers.value().end(),
                     [](const auto& offer) { return offer.verb == id<core::VerbId>("inspect"); });
    const auto use_offer =
        std::find_if(offers.value().begin(), offers.value().end(),
                     [](const auto& offer) { return offer.verb == id<core::VerbId>("use"); });
    REQUIRE(inspect_offer != offers.value().end());
    REQUIRE(use_offer != offers.value().end());
    CHECK(inspect_offer->rank == use_offer->rank);
    CHECK(std::distance(offers.value().begin(), inspect_offer) <
          std::distance(offers.value().begin(), use_offer));
}

TEST_CASE("direct complete-command submission does not require a discoverable Verb Offer")
{
    auto document = load_document();
    auto& use = definition(document, "verbs", "use");
    use["availability"] = {{"kind", "always"}};
    use["offers"] = nlohmann::json::array();
    auto& rules = definition(document, "interactions", "actions")["rules"];
    for (auto& rule : rules)
        if (rule["verb"]["id"] == "use")
            rule["offer"] = nullptr;

    RuntimeFixture fixture;
    auto project = decode(std::move(document));
    auto created = test_support::create_execution_kernel(project, fixture.runtime);
    REQUIRE(created);
    auto kernel = std::move(created).value();
    drive_to_room(*kernel);

    const core::compiled::InteractionSubject key =
        core::compiled::InteractableInteractionSubject{id<core::InteractableInstanceId>("key")};
    auto offers = kernel->verb_offers(key, "en");
    REQUIRE(offers);
    CHECK(std::none_of(offers.value().begin(), offers.value().end(),
                       [](const auto& offer) { return offer.verb == id<core::VerbId>("use"); }));
    REQUIRE(kernel->interact(id<core::VerbId>("use"), {{id<core::VerbSlotId>("target"), key}}));
}

TEST_CASE("Present Inventory resolves Player Inventory and the Project default Layout")
{
    auto document = load_document();
    document["settings"]["inventory"] = {
        {"playerInventory", "player"},
        {"defaultLayout", {{"kind", "layout"}, {"id", "hud-inline"}}},
    };
    definition(document, "verbs", "use")["availability"] = {{"kind", "always"}};
    auto& rules = definition(document, "interactions", "actions")["rules"];
    rules[2]["program"] =
        program(nlohmann::json::array({{{"id", "show-player-inventory"},
                                        {"kind", "present-inventory"},
                                        {"inventory", {{"kind", "player-inventory"}}}}}));

    RuntimeFixture fixture;
    auto project = decode(std::move(document));
    auto created = test_support::create_execution_kernel(project, fixture.runtime);
    REQUIRE(created);
    auto kernel = std::move(created).value();
    drive_to_room(*kernel);

    const core::compiled::InteractionSubject key =
        core::compiled::InteractableInteractionSubject{id<core::InteractableInstanceId>("key")};
    REQUIRE(kernel->interact(id<core::VerbId>("use"), {{id<core::VerbSlotId>("target"), key}}));
    drive_interaction(*kernel);

    const auto mounted_it =
        std::find_if(kernel->state().mounted_layouts().begin(),
                     kernel->state().mounted_layouts().end(), [](const auto& mounted) {
                         const auto* key = std::get_if<core::ScopedLayoutMountKey>(&mounted.key);
                         return key != nullptr && key->instance.text() == "inventory-ui";
                     });
    REQUIRE(mounted_it != kernel->state().mounted_layouts().end());
    const auto& mounted = *mounted_it;
    CHECK(mounted.layout == id<core::LayoutId>("hud-inline"));
    CHECK(mounted.policy.input == core::LayoutInputMode::Normal);
    REQUIRE(mounted.occurrence);
    const auto context =
        std::find_if(mounted.inputs.begin(), mounted.inputs.end(), [](const auto& input) {
            return input.input.text() == core::inventory_layout_context_input;
        });
    REQUIRE(context != mounted.inputs.end());
    const auto* literal = std::get_if<core::LayoutLiteralInput>(&context->source);
    REQUIRE(literal != nullptr);
    const auto* key_value = std::get_if<std::string>(&literal->value);
    REQUIRE(key_value != nullptr);
    const core::compiled::InventoryRef player_inventory{core::compiled::ProjectInventoryOwner{},
                                                        id<core::InventoryId>("player")};
    CHECK(*key_value == core::compiled::inventory_ref_key(player_inventory));

    auto inventory = kernel->inventory_view("en");
    REQUIRE(inventory);
    CHECK(inventory.value().player_inventory_available);
    REQUIRE(inventory.value().player_inventory);
    CHECK(*inventory.value().player_inventory == player_inventory);
    CHECK(inventory.value().presented_inventory_key == *key_value);
}

TEST_CASE("Present Inventory resolves built-in fallback and explicit Layout precedence")
{
    auto document = load_document();
    document["settings"]["inventory"] = {
        {"playerInventory", "player"},
        {"defaultLayout", nullptr},
    };

    RuntimeFixture fixture;
    auto project = decode(std::move(document));
    auto created = test_support::create_execution_kernel(project, fixture.runtime);
    REQUIRE(created);
    auto kernel = std::move(created).value();
    drive_to_room(*kernel);

    const core::compiled::InventoryRef player_inventory{core::compiled::ProjectInventoryOwner{},
                                                        id<core::InventoryId>("player")};
    REQUIRE(kernel->present_inventory(player_inventory, std::nullopt));
    const auto inventory_mount = [&]() -> const core::DesiredMountedLayout* {
        const auto found =
            std::find_if(kernel->state().mounted_layouts().begin(),
                         kernel->state().mounted_layouts().end(), [](const auto& mounted) {
                             const auto* key =
                                 std::get_if<core::ScopedLayoutMountKey>(&mounted.key);
                             return key != nullptr && key->instance.text() == "inventory-ui";
                         });
        return found == kernel->state().mounted_layouts().end() ? nullptr : &*found;
    };
    REQUIRE(inventory_mount() != nullptr);
    CHECK(inventory_mount()->layout.text() == core::compiled::builtin_inventory_layout_id);

    REQUIRE(kernel->present_inventory(player_inventory, id<core::LayoutId>("hud-assets")));
    REQUIRE(inventory_mount() != nullptr);
    CHECK(inventory_mount()->layout == id<core::LayoutId>("hud-assets"));
}

TEST_CASE(
    "Present Inventory command can inherit the triggering Layout occurrence as lifetime parent")
{
    auto document = load_document();
    document["settings"]["inventory"] = {
        {"playerInventory", "player"},
        {"defaultLayout", nullptr},
    };
    definition(document, "verbs", "use")["availability"] = {{"kind", "always"}};
    auto& rules = definition(document, "interactions", "actions")["rules"];
    rules[2]["program"] =
        program(nlohmann::json::array({{{"id", "show-child-inventory"},
                                        {"kind", "present-inventory"},
                                        {"inventory", {{"kind", "player-inventory"}}},
                                        {"parentToTriggeringLayout", true},
                                        {"coexist", true}}}));

    RuntimeFixture fixture;
    auto project = decode(std::move(document));
    auto created = test_support::create_execution_kernel(project, fixture.runtime);
    REQUIRE(created);
    auto kernel = std::move(created).value();
    drive_to_room(*kernel);

    const core::PresentationOwner owner{kernel->state().session_presentation_owner()};
    REQUIRE(kernel->state().set_layout(project, owner, core::compiled::LayoutSlot::Custom,
                                       id<core::LayoutId>("hud-inline")));
    const auto parent_mount =
        std::ranges::find_if(kernel->state().mounted_layouts(), [&](const auto& mounted) {
            return mounted.owner == owner && mounted.layout == id<core::LayoutId>("hud-inline");
        });
    REQUIRE(parent_mount != kernel->state().mounted_layouts().end());
    REQUIRE(parent_mount->occurrence);
    const core::LayoutPresentationParent parent{owner, parent_mount->key,
                                                *parent_mount->occurrence};
    kernel->set_trigger_presentation_parent(parent);

    const core::compiled::InteractionSubject key =
        core::compiled::InteractableInteractionSubject{id<core::InteractableInstanceId>("key")};
    REQUIRE(kernel->interact(id<core::VerbId>("use"), {{id<core::VerbSlotId>("target"), key}}));
    drive_interaction(*kernel);

    const auto inventory_mount =
        std::ranges::find_if(kernel->state().mounted_layouts(), [](const auto& mounted) {
            const auto* key = std::get_if<core::ScopedLayoutMountKey>(&mounted.key);
            return key != nullptr && key->instance.text().starts_with("inventory-ui");
        });
    REQUIRE(inventory_mount != kernel->state().mounted_layouts().end());
    REQUIRE(inventory_mount->presentation_parent);
    CHECK(*inventory_mount->presentation_parent == parent);
}

TEST_CASE("Present Inventory command can explicitly ignore the triggering anchor")
{
    auto document = load_document();
    document["settings"]["inventory"] = {
        {"playerInventory", "player"},
        {"defaultLayout", nullptr},
    };
    definition(document, "verbs", "use")["availability"] = {{"kind", "always"}};
    auto& rules = definition(document, "interactions", "actions")["rules"];
    rules[2]["program"] =
        program(nlohmann::json::array({{{"id", "show-unanchored-inventory"},
                                        {"kind", "present-inventory"},
                                        {"inventory", {{"kind", "player-inventory"}}},
                                        {"useTriggerAnchor", false}}}));

    RuntimeFixture fixture;
    auto project = decode(std::move(document));
    auto created = test_support::create_execution_kernel(project, fixture.runtime);
    REQUIRE(created);
    auto kernel = std::move(created).value();
    drive_to_room(*kernel);
    kernel->set_trigger_context(core::TriggerContext{.pointer = core::TriggerPoint{0.25, 0.75}});

    const core::compiled::InteractionSubject key =
        core::compiled::InteractableInteractionSubject{id<core::InteractableInstanceId>("key")};
    REQUIRE(kernel->interact(id<core::VerbId>("use"), {{id<core::VerbSlotId>("target"), key}}));
    drive_interaction(*kernel);

    const auto inventory_mount =
        std::ranges::find_if(kernel->state().mounted_layouts(), [](const auto& mounted) {
            const auto* key = std::get_if<core::ScopedLayoutMountKey>(&mounted.key);
            return key != nullptr && key->instance.text() == "inventory-ui";
        });
    REQUIRE(inventory_mount != kernel->state().mounted_layouts().end());
    CHECK_FALSE(inventory_mount->trigger_context);
}

TEST_CASE("shared Navigate Exit remains vetoable while Change Room is authoritative")
{
    const auto run_command = [](nlohmann::json command, const core::RoomId& expected_room) {
        RuntimeFixture fixture;
        auto document = load_document();
        definition(document, "rooms", "start")["lifecycle"]["canLeave"] = {
            {"kind", "lua-predicate"}, {"source", "offer_false()"}};
        definition(document, "verbs", "use")["availability"] = {{"kind", "always"}};
        auto& rules = definition(document, "interactions", "actions")["rules"];
        rules[2]["program"] = program(nlohmann::json::array({std::move(command)}));

        auto project = decode(std::move(document));
        auto created = test_support::create_execution_kernel(project, fixture.runtime);
        REQUIRE(created);
        auto kernel = std::move(created).value();
        drive_to_room(*kernel);
        const core::compiled::InteractionSubject key =
            core::compiled::InteractableInteractionSubject{id<core::InteractableInstanceId>("key")};
        REQUIRE(kernel->interact(id<core::VerbId>("use"), {{id<core::VerbSlotId>("target"), key}}));
        drive_interaction(*kernel);
        REQUIRE(std::holds_alternative<core::RoomMode>(kernel->state().mode()));
        INFO("expected Room " << expected_room.text() << ", actual Room "
                              << std::get<core::RoomMode>(kernel->state().mode()).room.text());
        CHECK(std::get<core::RoomMode>(kernel->state().mode()).room == expected_room);
        return kernel->take_room_presentation_diagnostics();
    };

    const auto navigation_diagnostics =
        run_command({{"id", "navigate"}, {"kind", "navigate-exit"}, {"exitId", "north-exit"}},
                    id<core::RoomId>("start"));
    CHECK(std::none_of(navigation_diagnostics.begin(), navigation_diagnostics.end(),
                       [](const core::Diagnostic& item) {
                           return item.code == "execution.directed_room_guard_false";
                       }));

    const auto directed_diagnostics =
        run_command({{"id", "change"},
                     {"kind", "change-room"},
                     {"room", {{"kind", "room"}, {"room", {{"kind", "room"}, {"id", "hall"}}}}}},
                    id<core::RoomId>("hall"));
    CHECK(std::any_of(directed_diagnostics.begin(), directed_diagnostics.end(),
                      [](const core::Diagnostic& item) {
                          return item.code == "execution.directed_room_guard_false";
                      }));
}

TEST_CASE("Present Inventory mount survives save encode and strict restore validation")
{
    auto document = load_document();
    document["settings"]["inventory"] = {
        {"playerInventory", "player"},
        {"defaultLayout", nullptr},
    };
    definition(document, "verbs", "use")["availability"] = {{"kind", "always"}};
    auto& rules = definition(document, "interactions", "actions")["rules"];
    rules[2]["program"] =
        program(nlohmann::json::array({{{"id", "show-player-inventory"},
                                        {"kind", "present-inventory"},
                                        {"inventory", {{"kind", "player-inventory"}}}}}));

    RuntimeFixture fixture;
    auto project = decode(std::move(document));
    auto created = test_support::create_execution_kernel(project, fixture.runtime);
    REQUIRE(created);
    auto kernel = std::move(created).value();
    drive_to_room(*kernel);

    const core::compiled::InteractionSubject key =
        core::compiled::InteractableInteractionSubject{id<core::InteractableInstanceId>("key")};
    REQUIRE(kernel->interact(id<core::VerbId>("use"), {{id<core::VerbSlotId>("target"), key}}));
    drive_interaction(*kernel);

    auto save = core::make_save_state(project, kernel->state());
    REQUIRE(save);
    auto encoded = core::encode_save_state_text(project, *save.value_if());
    REQUIRE(encoded);
    auto decoded =
        core::decode_save_state_text(project, *encoded.value_if(), "inventory-save.json");
    REQUIRE(decoded);
    REQUIRE(decoded.value().mounted_layouts.size() >= 1);
    const auto restored = std::find_if(
        decoded.value().mounted_layouts.begin(), decoded.value().mounted_layouts.end(),
        [](const auto& mounted) {
            return mounted.layout.text() == core::compiled::builtin_inventory_layout_id;
        });
    REQUIRE(restored != decoded.value().mounted_layouts.end());
    const auto context =
        std::find_if(restored->inputs.begin(), restored->inputs.end(), [](const auto& input) {
            return input.input.text() == core::inventory_layout_context_input;
        });
    REQUIRE(context != restored->inputs.end());
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
        {{id<core::VerbSlotId>("target"), core::compiled::InteractableInteractionSubject{
                                              id<core::InteractableInstanceId>("key")}}}));
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
    CHECK_FALSE(inventory.value().controls.empty());
    auto room = kernel->room_view("en");
    REQUIRE(room);
    CHECK(room.value().controls.size() == inventory.value().controls.size());
}

TEST_CASE("Interaction fallback uses optional Project behavior before the engine response")
{
    auto document = load_document();
    definition(document, "interactions", "actions")["rules"] = nlohmann::json::array();
    definition(document, "verbs", "use")["availability"] = {{"kind", "always"}};
    definition(document, "verbs", "use")["defaultProgram"] =
        program(nlohmann::json::array(), "unhandled");
    document["undefinedInteractionProgram"] = program(nlohmann::json::array(
        {{{"id", "project-fallback"},
          {"kind", "notify"},
          {"message",
           {{"markup", "plain"},
            {"source", {{"kind", "inline"}, {"text", "Project fallback"}}}}}}}));

    RuntimeFixture fixture;
    auto project = decode(std::move(document));
    auto created = test_support::create_execution_kernel(project, fixture.runtime);
    REQUIRE(created);
    auto kernel = std::move(created).value();
    drive_to_room(*kernel);

    const core::compiled::InteractionSubject key =
        core::compiled::InteractableInteractionSubject{id<core::InteractableInstanceId>("key")};
    REQUIRE(kernel->interact(id<core::VerbId>("use"), {{id<core::VerbSlotId>("target"), key}}));
    drive_interaction(*kernel);
    const auto project_fallback = std::find_if(
        kernel->gateway().events().begin(), kernel->gateway().events().end(),
        [](const runtime::RuntimeEvent& event) {
            const auto* notification = std::get_if<runtime::NotificationEvent>(&event);
            return notification != nullptr && notification->message == "Project fallback";
        });
    REQUIRE(project_fallback != kernel->gateway().events().end());
    const auto engine_fallback = std::find_if(
        kernel->gateway().events().begin(), kernel->gateway().events().end(),
        [](const runtime::RuntimeEvent& event) {
            const auto* notification = std::get_if<runtime::NotificationEvent>(&event);
            return notification != nullptr && notification->message == "Nothing happens.";
        });
    CHECK(engine_fallback == kernel->gateway().events().end());
}

TEST_CASE("undefined Interaction engine fallback is localized by runtime locale")
{
    auto document = load_document();
    definition(document, "interactions", "actions")["rules"] = nlohmann::json::array();
    definition(document, "verbs", "use")["availability"] = {{"kind", "always"}};
    definition(document, "verbs", "use")["defaultProgram"] =
        program(nlohmann::json::array(), "unhandled");
    document.erase("undefinedInteractionProgram");

    RuntimeFixture fixture;
    auto project = decode(std::move(document));
    auto created = test_support::create_execution_kernel(project, fixture.runtime);
    REQUIRE(created);
    auto kernel = std::move(created).value();
    drive_to_room(*kernel);

    const core::compiled::InteractionSubject key =
        core::compiled::InteractableInteractionSubject{id<core::InteractableInstanceId>("key")};
    REQUIRE(kernel->interact(id<core::VerbId>("use"), {{id<core::VerbSlotId>("target"), key}}));
    drive_interaction(*kernel, "es");
    const auto localized =
        std::find_if(kernel->gateway().events().begin(), kernel->gateway().events().end(),
                     [](const runtime::RuntimeEvent& event) {
                         const auto* notification = std::get_if<runtime::NotificationEvent>(&event);
                         return notification != nullptr && notification->message == "No pasa nada.";
                     });
    CHECK(localized != kernel->gateway().events().end());
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
        REQUIRE(kernel->interact(id<core::VerbId>("inspect"),
                                 {{id<core::VerbSlotId>("target"), subject}}));
        auto interaction = kernel->interaction_view("en");
        REQUIRE(interaction);
        CHECK(interaction.value().bindings == std::vector<core::InteractionSubjectBinding>{
                                                  {id<core::VerbSlotId>("target"), subject}});
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
                id<core::InteractableInstanceId>("key"), id<core::FeatureId>("surface")}};
        REQUIRE(
            kernel->interact(id<core::VerbId>("use"), {{id<core::VerbSlotId>("target"), subject}}));
        auto interaction = kernel->interaction_view("en");
        REQUIRE(interaction);
        CHECK(interaction.value().bindings == std::vector<core::InteractionSubjectBinding>{
                                                  {id<core::VerbSlotId>("target"), subject}});
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
        {{id<core::VerbSlotId>("target"), core::compiled::InteractableInteractionSubject{
                                              id<core::InteractableInstanceId>("key")}}}));
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
