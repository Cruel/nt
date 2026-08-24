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
                                "function offer_false() return false end",
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

} // namespace

TEST_CASE(
    "typed Interaction selects exact selector before broader selector and mutates session state")
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
        {{id<core::VerbSlotId>("target"),
          core::compiled::InteractableInteractionSubject{id<core::InteractableId>("key")}}}));
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
        {{id<core::VerbSlotId>("target"),
          core::compiled::InteractableInteractionSubject{id<core::InteractableId>("key")}}}));
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
        core::compiled::InteractableInteractionSubject{id<core::InteractableId>("key")};
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
        core::compiled::InteractableInteractionSubject{id<core::InteractableId>("key")};
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
    first["program"] = program({{{"id", "move"},
                                 {"kind", "move-interactable"},
                                 {"interactable", {{"kind", "interactable"}, {"id", "key"}}},
                                 {"target", {{"kind", "unplaced"}}}}});
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
        core::compiled::InteractableInteractionSubject{id<core::InteractableId>("key")};
    CHECK_FALSE(
        kernel->interact(id<core::VerbId>("use"), {{id<core::VerbSlotId>("target"), key_subject}}));
    const auto* key = kernel->state().interactable(id<core::InteractableId>("key"));
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
    rule["program"] = program({{{"id", "move"},
                                {"kind", "move-interactable"},
                                {"interactable", {{"kind", "interactable"}, {"id", "key"}}},
                                {"target", {{"kind", "unplaced"}}}}});
    definition(document, "interactions", "actions")["rules"] =
        nlohmann::json::array({std::move(rule)});

    RuntimeFixture fixture;
    auto project = decode(std::move(document));
    auto created = test_support::create_execution_kernel(project, fixture.runtime);
    REQUIRE(created);
    auto kernel = std::move(created).value();
    drive_to_room(*kernel);

    const core::compiled::InteractionSubject key_subject =
        core::compiled::InteractableInteractionSubject{id<core::InteractableId>("key")};
    CHECK_FALSE(
        kernel->interact(id<core::VerbId>("use"), {{id<core::VerbSlotId>("target"), key_subject}}));
    const auto* key = kernel->state().interactable(id<core::InteractableId>("key"));
    REQUIRE(key != nullptr);
    CHECK(std::holds_alternative<core::compiled::RoomLocation>(key->location));
}

TEST_CASE("compact Interaction mutation batches validate atomically before commit")
{
    auto document = load_document();
    definition(document, "verbs", "use")["availability"] = {{"kind", "always"}};
    auto rule = definition(document, "interactions", "actions")["rules"][2];
    rule["id"] = "atomic-cycle";
    const nlohmann::json key_into_coin = {
        {"id", "key-into-coin"},
        {"kind", "move-interactable"},
        {"interactable", {{"kind", "interactable"}, {"id", "key"}}},
        {"target",
         {{"kind", "inventory"},
          {"inventory",
           {{"owner",
             {{"kind", "interactable"},
              {"interactable", {{"kind", "interactable"}, {"id", "coin"}}}}},
            {"inventoryId", "pouch"}}}}},
    };
    const nlohmann::json coin_into_key = {
        {"id", "coin-into-key"},
        {"kind", "move-interactable"},
        {"interactable", {{"kind", "interactable"}, {"id", "coin"}}},
        {"target",
         {{"kind", "inventory"},
          {"inventory",
           {{"owner",
             {{"kind", "interactable"},
              {"interactable", {{"kind", "interactable"}, {"id", "key"}}}}},
            {"inventoryId", "hidden"}}}}},
    };
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
        core::compiled::InteractableInteractionSubject{id<core::InteractableId>("key")};
    REQUIRE(
        kernel->interact(id<core::VerbId>("use"), {{id<core::VerbSlotId>("target"), key_subject}}));
    auto outcome = kernel->run_until_blocked(8, "en");
    REQUIRE(std::holds_alternative<core::FlowFaultOutcome>(outcome));
    const auto* key = kernel->state().interactable(id<core::InteractableId>("key"));
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
        {"kind", "move-interactable"},
        {"interactable", {{"kind", "interactable"}, {"id", "key"}}},
        {"target",
         {{"kind", "inventory"},
          {"inventory", {{"owner", {{"kind", "project"}}}, {"inventoryId", "player"}}}}},
    };
    const nlohmann::json lua = {
        {"id", "lua"},
        {"kind", "apply-effect"},
        {"effect", {{"kind", "run-lua-effect"}, {"source", "error('terminal failed')"}}},
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
        core::compiled::InteractableInteractionSubject{id<core::InteractableId>("key")};
    REQUIRE(
        kernel->interact(id<core::VerbId>("use"), {{id<core::VerbSlotId>("target"), key_subject}}));
    auto outcome = kernel->run_until_blocked(8, "en");
    REQUIRE(std::holds_alternative<core::FlowFaultOutcome>(outcome));
    const auto* key = kernel->state().interactable(id<core::InteractableId>("key"));
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
        core::compiled::InteractableInteractionSubject{id<core::InteractableId>("key")};
    REQUIRE(kernel->interact(id<core::VerbId>("use"), {{id<core::VerbSlotId>("source"), subject},
                                                       {id<core::VerbSlotId>("target"), subject}}));
    auto interaction = kernel->interaction_view("en");
    REQUIRE(interaction);
    CHECK(interaction.value().bindings ==
          std::vector<core::InteractionSubjectBinding>{{id<core::VerbSlotId>("source"), subject},
                                                       {id<core::VerbSlotId>("target"), subject}});
}

TEST_CASE("runtime-created subjects match live Trait and qualified-pattern selectors")
{
    auto document = load_document();
    auto& use = definition(document, "verbs", "use");
    use["availability"] = {{"kind", "always"}};
    use["slots"][0]["selectors"] = nlohmann::json::array(
        {{{"kind", "trait"}, {"trait", {{"kind", "trait"}, {"id", "currency"}}}},
         {{"kind", "qualified-pattern"},
          {"family", "item-stack"},
          {"pattern", "item-stack:runtime-item-stack-*"}}});
    auto rule = definition(document, "interactions", "actions")["rules"][2];
    rule["id"] = "runtime-created";
    rule["program"] = program(nlohmann::json::array());
    rule["slots"][0]["selectors"] = use["slots"][0]["selectors"];
    definition(document, "interactions", "actions")["rules"] =
        nlohmann::json::array({std::move(rule)});

    RuntimeFixture fixture;
    auto project = decode(std::move(document));
    auto created = test_support::create_execution_kernel(project, fixture.runtime);
    REQUIRE(created);
    auto kernel = std::move(created).value();
    drive_to_room(*kernel);

    auto split = kernel->gateway().split_item_stack(id<core::ItemStackId>("wallet"), 5);
    REQUIRE(split);
    REQUIRE(split.value().created.size() == 1);
    const auto created_stack = split.value().created.front();
    REQUIRE(kernel->gateway().transfer_item_quantity(
        created_stack, 5, core::compiled::RoomLocation{id<core::RoomId>("start")},
        runtime::ItemStackPlacementPolicy::KeepSeparate));
    kernel->invalidate_room_presentation();
    REQUIRE(kernel->refresh_room_presentation("en"));
    const core::compiled::InteractionSubject subject =
        core::compiled::ItemStackInteractionSubject{created_stack};
    REQUIRE(kernel->interact(id<core::VerbId>("use"), {{id<core::VerbSlotId>("target"), subject}}));
    auto interaction = kernel->interaction_view("en");
    REQUIRE(interaction);
    REQUIRE(interaction.value().program);
    const auto* selected =
        std::get_if<core::InteractionRuleProgramRef>(&*interaction.value().program);
    REQUIRE(selected != nullptr);
    CHECK(selected->rule == id<core::InteractionRuleId>("runtime-created"));
}

TEST_CASE("item Stack definitions participate in Subject Selector matching")
{
    auto document = load_document();
    auto& use = definition(document, "verbs", "use");
    use["availability"] = {{"kind", "always"}};
    use["slots"][0]["selectors"] = nlohmann::json::array(
        {{{"kind", "item-definition"},
          {"itemDefinition", {{"kind", "item-definition"}, {"id", "credits"}}}}});
    auto rule = definition(document, "interactions", "actions")["rules"][2];
    rule["id"] = "credits-stack";
    rule["program"] = program(nlohmann::json::array());
    rule["slots"][0]["selectors"] = use["slots"][0]["selectors"];
    definition(document, "interactions", "actions")["rules"] =
        nlohmann::json::array({std::move(rule)});

    RuntimeFixture fixture;
    auto project = decode(std::move(document));
    auto created = test_support::create_execution_kernel(project, fixture.runtime);
    REQUIRE(created);
    auto kernel = std::move(created).value();
    const auto wallet_id = id<core::ItemStackId>("wallet");
    REQUIRE(kernel->gateway().transfer_item_quantity(
        wallet_id, 25, core::compiled::RoomLocation{id<core::RoomId>("start")},
        runtime::ItemStackPlacementPolicy::KeepSeparate));
    drive_to_room(*kernel);

    const core::compiled::InteractionSubject wallet =
        core::compiled::ItemStackInteractionSubject{wallet_id};
    REQUIRE(kernel->interact(id<core::VerbId>("use"), {{id<core::VerbSlotId>("target"), wallet}}));
    auto interaction = kernel->interaction_view("en");
    REQUIRE(interaction);
    REQUIRE(interaction.value().program);
    const auto* selected =
        std::get_if<core::InteractionRuleProgramRef>(&*interaction.value().program);
    REQUIRE(selected != nullptr);
    CHECK(selected->rule == id<core::InteractionRuleId>("credits-stack"));
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
        core::compiled::InteractableInteractionSubject{id<core::InteractableId>("key")};
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

TEST_CASE("typed Interaction and Room publication preserve exact live item Stack identity")
{
    auto document = load_document();
    definition(document, "verbs", "use")["availability"] = {{"kind", "always"}};
    auto exact = definition(document, "interactions", "actions")["rules"][2];
    exact["id"] = "exact-wallet";
    exact["slots"] = nlohmann::json::array(
        {{{"slotId", "target"},
          {"selectors", nlohmann::json::array(
                            {{{"kind", "exact"},
                              {"subject",
                               {{"kind", "item-stack"},
                                {"itemStack", {{"kind", "item-stack"}, {"id", "wallet"}}}}}}})}}});
    exact["program"] = program(nlohmann::json::array());
    auto wildcard = exact;
    wildcard["id"] = "item-stack-family";
    wildcard["slots"] = nlohmann::json::array(
        {{{"slotId", "target"},
          {"selectors", nlohmann::json::array({{{"kind", "family"}, {"family", "item-stack"}}})}}});
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
    REQUIRE(kernel->interact(id<core::VerbId>("use"), {{id<core::VerbSlotId>("target"), subject}}));
    auto interaction = kernel->interaction_view("en");
    REQUIRE(interaction);
    CHECK(interaction.value().bindings ==
          std::vector<core::InteractionSubjectBinding>{{id<core::VerbSlotId>("target"), subject}});
    REQUIRE(interaction.value().program);
    const auto* selected =
        std::get_if<core::InteractionRuleProgramRef>(&*interaction.value().program);
    REQUIRE(selected != nullptr);
    CHECK(selected->rule == id<core::InteractionRuleId>("exact-wallet"));
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
        core::compiled::InteractableInteractionSubject{id<core::InteractableId>("key")};
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
        core::compiled::InteractableInteractionSubject{id<core::InteractableId>("key")};
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
        core::compiled::InteractableInteractionSubject{id<core::InteractableId>("key")};
    auto offers = kernel->verb_offers(key, "en");
    REQUIRE(offers);
    CHECK(std::none_of(offers.value().begin(), offers.value().end(),
                       [](const auto& offer) { return offer.verb == id<core::VerbId>("use"); }));
    REQUIRE(kernel->interact(id<core::VerbId>("use"), {{id<core::VerbSlotId>("target"), key}}));
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
        {{id<core::VerbSlotId>("target"),
          core::compiled::InteractableInteractionSubject{id<core::InteractableId>("key")}}}));
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
        core::compiled::InteractableInteractionSubject{id<core::InteractableId>("key")};
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
        core::compiled::InteractableInteractionSubject{id<core::InteractableId>("key")};
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
                id<core::InteractableId>("key"), id<core::FeatureId>("surface")}};
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
        {{id<core::VerbSlotId>("target"),
          core::compiled::InteractableInteractionSubject{id<core::InteractableId>("key")}}}));
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
