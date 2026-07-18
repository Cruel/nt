#include <catch2/catch_test_macros.hpp>

#include "noveltea/assets/asset_manager.hpp"
#include "noveltea/assets/asset_source.hpp"
#include "noveltea/core/compiled_project_codec.hpp"
#include "noveltea/script/script_runtime.hpp"
#include "noveltea/runtime/runtime_executor.hpp"
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
    std::shared_ptr<assets::MemoryAssetSource> memory =
        std::make_shared<assets::MemoryAssetSource>();
    assets::AssetManager assets;
    ScriptRuntime runtime;

    RuntimeFixture()
    {
        assets.mount("project", memory);
        REQUIRE(runtime.initialize({&assets}));
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
    rules[0]["program"] = program({{{"id", "exact-move"},
                                    {"kind", "move-interactable"},
                                    {"interactable", {{"kind", "interactable"}, {"id", "key"}}},
                                    {"target", {{"kind", "inventory"}}}}});
    rules[1]["program"] = program({{{"id", "wildcard-move"},
                                    {"kind", "move-interactable"},
                                    {"interactable", {{"kind", "interactable"}, {"id", "key"}}},
                                    {"target", {{"kind", "nowhere"}}}}});

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

TEST_CASE("typed Interaction falls back child-to-root and emits typed undefined fallback")
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
    CHECK(std::any_of(inventory.value().controls.begin(), inventory.value().controls.end(),
                      [](const auto& control) { return control.quick_action; }));
    auto room = kernel->room_view("en");
    REQUIRE(room);
    CHECK(room.value().controls.size() == inventory.value().controls.size());
}

} // namespace noveltea::script::test
