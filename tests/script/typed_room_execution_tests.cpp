#include <catch2/catch_test_macros.hpp>

#include "noveltea/assets/asset_manager.hpp"
#include "noveltea/assets/asset_source.hpp"
#include "noveltea/core/compiled_project_codec.hpp"
#include "noveltea/script/script_runtime.hpp"
#include "noveltea/script/typed_execution_kernel.hpp"

#include <algorithm>
#include <fstream>
#include <iterator>
#include <memory>
#include <string>
#include <string_view>

#include <nlohmann/json.hpp>

namespace noveltea::script::test {
namespace {

template<class Id> Id id(std::string value)
{
    auto result = Id::create(std::move(value));
    REQUIRE(result);
    return std::move(result).value();
}

template<class T>
concept HasCategories = requires(const T& value) { value.categories; };

template<class T>
concept HasTags = requires(const T& value) { value.tags; };

nlohmann::json load_document(std::string_view filename)
{
    std::ifstream input(std::string(NOVELTEA_SOURCE_DIR) +
                        "/editor/src/renderer/test/fixtures/compiled-project-golden/" +
                        std::string(filename));
    REQUIRE(input.good());
    const std::string source((std::istreambuf_iterator<char>(input)),
                             std::istreambuf_iterator<char>());
    auto document = nlohmann::json::parse(source, nullptr, false);
    REQUIRE_FALSE(document.is_discarded());
    return document;
}

core::CompiledProject decode_document(nlohmann::json document, std::string_view source)
{
    auto decoded = core::decode_compiled_project(document, std::string(source));
    REQUIRE(decoded);
    return std::move(decoded).value();
}

nlohmann::json& room_document(nlohmann::json& document, std::string_view room)
{
    auto& rooms = document["definitions"]["rooms"];
    const auto found =
        std::find_if(rooms.begin(), rooms.end(), [room](const nlohmann::json& value) {
            return value.value("id", std::string{}) == room;
        });
    REQUIRE(found != rooms.end());
    return *found;
}

nlohmann::json& hook_document(nlohmann::json& room, std::string_view hook)
{
    auto& hooks = room["lifecycle"]["hooks"];
    const auto found =
        std::find_if(hooks.begin(), hooks.end(), [hook](const nlohmann::json& value) {
            return value.value("hook", std::string{}) == hook;
        });
    REQUIRE(found != hooks.end());
    return *found;
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
    }
};

void install_room_scripts(RuntimeFixture& fixture, bool can_leave = true,
                          bool yielding_before_leave = false, bool failing_before_leave = false,
                          bool can_enter_hall = true)
{
    std::string before_leave;
    if (failing_before_leave) {
        before_leave = "error('before-leave failed')";
    } else if (yielding_before_leave) {
        before_leave = "noveltea.notify('before-leave-start'); coroutine.yield(); "
                       "noveltea.notify('before-leave-end')";
    }
    const std::string source = "function initialize_fixture() end\n"
                               "function can_leave_start() return " +
                               std::string(can_leave ? "true" : "false") +
                               " end\n"
                               "function can_enter_hall() return " +
                               std::string(can_enter_hall ? "true" : "false") +
                               " end\n"
                               "function after_enter_start() end\n"
                               "function before_leave_start() " +
                               before_leave +
                               " end\n"
                               "function hall_description() return 'Hall description.' end\n"
                               "function tower_open() return true end\n"
                               "function key_label() return 'Key' end";
    REQUIRE(fixture.runtime.execute(source, "room-test-setup"));
}

const core::RoomTransitionFrame& active_transition(const TypedExecutionKernel& kernel)
{
    REQUIRE_FALSE(kernel.state().flow_stack().empty());
    const auto* frame = std::get_if<core::RoomTransitionFrame>(&kernel.state().flow_stack().back());
    REQUIRE(frame != nullptr);
    return *frame;
}

void drive_to_room(TypedExecutionKernel& kernel, const core::RoomId& room,
                   std::string_view locale = "en")
{
    for (std::size_t iteration = 0; iteration < 64; ++iteration) {
        auto outcome = kernel.run_until_blocked(1, locale);
        if (const auto* blocked = std::get_if<core::FlowBlockedOutcome>(&outcome)) {
            const auto* script = std::get_if<core::ScriptFlowBlocker>(&blocked->blocker);
            REQUIRE(script != nullptr);
            auto resumed = kernel.resume_script(script->owner, script->handle);
            REQUIRE(resumed);
            REQUIRE(std::holds_alternative<ScriptInvocationCompleted>(resumed.value()));
            continue;
        }
        if (const auto* changed = std::get_if<core::FlowModeChangedOutcome>(&outcome)) {
            const auto* active = std::get_if<core::RoomMode>(&changed->mode);
            REQUIRE(active != nullptr);
            REQUIRE(active->room == room);
            return;
        }
        REQUIRE_FALSE(std::holds_alternative<core::FlowFaultOutcome>(outcome));
    }
    FAIL("Room transition did not complete within the deterministic unit budget");
}

std::vector<std::string> notifications(const TypedExecutionKernel& kernel)
{
    std::vector<std::string> result;
    for (const auto& event : kernel.gateway().events()) {
        const auto* notification = std::get_if<runtime::NotificationEvent>(&event);
        if (notification != nullptr)
            result.push_back(notification->message);
    }
    return result;
}

const core::RuntimeValue&
property_value(const core::Result<core::PropertyLookupResult, core::Diagnostics>& result)
{
    REQUIRE(result);
    const auto* value = std::get_if<core::RuntimeValue>(&result.value());
    REQUIRE(value != nullptr);
    return *value;
}

} // namespace

TEST_CASE("typed Room entry commits visits presentation placements exits and transient inputs")
{
    RuntimeFixture fixture;
    install_room_scripts(fixture);
    auto project = decode_document(load_document("comprehensive.json"), "room-entry");
    auto created = TypedExecutionKernel::create(project, fixture.runtime);
    REQUIRE(created);
    auto kernel = std::move(created).value();

    drive_to_room(*kernel, id<core::RoomId>("start"));
    CHECK(kernel->state().room_visits(id<core::RoomId>("start")) == 1);
    REQUIRE(kernel->state().background());
    CHECK(kernel->state().background()->asset == id<core::AssetId>("image-main"));
    REQUIRE(kernel->state().overlays().size() == 1);
    CHECK(kernel->state().overlays().front().overlay == id<core::RoomOverlayId>("start-overlay"));
    CHECK(kernel->state().overlays().front().visible);

    auto view = kernel->room_view("en");
    REQUIRE(view);
    CHECK(view.value().room == id<core::RoomId>("start"));
    CHECK(view.value().visits == 1);
    CHECK(view.value().description == "The starting room.");
    CHECK(view.value().description_markup == core::TextMarkup::ActiveText);
    REQUIRE(view.value().overlays.size() == 1);
    CHECK(view.value().overlays.front().layout == id<core::LayoutId>("hud-assets"));
    CHECK(view.value().overlays.front().visible);
    REQUIRE(view.value().placements.size() == 1);
    CHECK(view.value().placements.front().placement == id<core::RoomPlacementId>("key-placement"));
    CHECK(view.value().placements.front().label == "Key");
    CHECK(view.value().placements.front().layout == id<core::LayoutId>("hud-inline"));
    CHECK(view.value().placements.front().enabled);
    CHECK(view.value().placements.front().visible);
    REQUIRE(view.value().exits.size() == 1);
    CHECK(view.value().exits.front().exit == id<core::RoomExitId>("north-exit"));
    CHECK(view.value().exits.front().target == id<core::RoomId>("hall"));
    CHECK(view.value().exits.front().enabled);
    auto runtime_ui = kernel->runtime_ui_view("en");
    REQUIRE(runtime_ui);
    CHECK(runtime_ui.value().mode == "room");
    REQUIRE(runtime_ui.value().room);
    CHECK(runtime_ui.value().room->room == view.value().room);
    CHECK(runtime_ui.value().room->description == view.value().description);
    CHECK_FALSE(runtime_ui.value().scene);
    CHECK_FALSE(runtime_ui.value().dialogue);
    CHECK_FALSE(runtime_ui.value().interaction);

    REQUIRE(kernel->start_transient(id<core::SceneId>("opening")));
    REQUIRE(std::holds_alternative<core::SceneFrame>(kernel->state().flow_stack().back()));
    REQUIRE_FALSE(kernel->room_view("en"));
    REQUIRE(kernel->flow().return_from_flow());
    CHECK(std::get<core::RoomMode>(kernel->state().mode()).room == id<core::RoomId>("start"));

    REQUIRE(kernel->start_transient(id<core::DialogueId>("intro")));
    REQUIRE(std::holds_alternative<core::DialogueFrame>(kernel->state().flow_stack().back()));
    REQUIRE(kernel->flow().return_from_flow());
    CHECK(std::get<core::RoomMode>(kernel->state().mode()).room == id<core::RoomId>("start"));
}

TEST_CASE("typed Room navigation preserves lifecycle order and exact yielding hook cursor")
{
    RuntimeFixture fixture;
    install_room_scripts(fixture, true, true);
    auto project = decode_document(load_document("comprehensive.json"), "room-navigation");
    auto created = TypedExecutionKernel::create(project, fixture.runtime);
    REQUIRE(created);
    auto kernel = std::move(created).value();
    drive_to_room(*kernel, id<core::RoomId>("start"));

    REQUIRE(kernel->navigate(id<core::RoomExitId>("north-exit")));
    CHECK(active_transition(*kernel).position.stage == core::RoomTransitionStage::SourceCanLeave);
    REQUIRE(
        std::holds_alternative<core::FlowBudgetYieldOutcome>(kernel->run_until_blocked(1, "en")));
    CHECK(active_transition(*kernel).position.stage == core::RoomTransitionStage::ExitCondition);
    REQUIRE(
        std::holds_alternative<core::FlowBudgetYieldOutcome>(kernel->run_until_blocked(1, "en")));
    CHECK(active_transition(*kernel).position.stage == core::RoomTransitionStage::TargetCanEnter);
    REQUIRE(
        std::holds_alternative<core::FlowBudgetYieldOutcome>(kernel->run_until_blocked(1, "en")));
    CHECK(active_transition(*kernel).position.stage == core::RoomTransitionStage::BeforeLeave);

    auto blocked = kernel->run_until_blocked(1, "en");
    const auto* blocked_outcome = std::get_if<core::FlowBlockedOutcome>(&blocked);
    REQUIRE(blocked_outcome != nullptr);
    const auto* script = std::get_if<core::ScriptFlowBlocker>(&blocked_outcome->blocker);
    REQUIRE(script != nullptr);
    CHECK(active_transition(*kernel).position.next_effect == 0);
    CHECK(active_transition(*kernel).position.awaiting_completion);
    CHECK(notifications(*kernel) == std::vector<std::string>{"before-leave-start"});

    auto resumed = kernel->resume_script(script->owner, script->handle);
    REQUIRE(resumed);
    REQUIRE(std::holds_alternative<ScriptInvocationCompleted>(resumed.value()));
    CHECK(notifications(*kernel) ==
          std::vector<std::string>{"before-leave-start", "before-leave-end"});
    REQUIRE(
        std::holds_alternative<core::FlowBudgetYieldOutcome>(kernel->run_until_blocked(1, "en")));
    CHECK(active_transition(*kernel).position.next_effect == 1);
    CHECK_FALSE(active_transition(*kernel).position.awaiting_completion);
    REQUIRE(
        std::holds_alternative<core::FlowBudgetYieldOutcome>(kernel->run_until_blocked(1, "en")));
    CHECK(active_transition(*kernel).position.stage == core::RoomTransitionStage::BeforeEnter);
    REQUIRE(
        std::holds_alternative<core::FlowBudgetYieldOutcome>(kernel->run_until_blocked(1, "en")));
    CHECK(active_transition(*kernel).position.stage == core::RoomTransitionStage::CommitRoomSwitch);

    REQUIRE(
        std::holds_alternative<core::FlowBudgetYieldOutcome>(kernel->run_until_blocked(1, "en")));
    CHECK(active_transition(*kernel).position.stage == core::RoomTransitionStage::AfterLeave);
    CHECK(kernel->state().room_visits(id<core::RoomId>("hall")) == 1);
    REQUIRE(kernel->state().background());
    CHECK(kernel->state().background()->fit == core::compiled::BackgroundFit::Contain);

    drive_to_room(*kernel, id<core::RoomId>("hall"));
    CHECK(kernel->state().variable(project, id<core::VariableId>("count")).value() ==
          core::RuntimeValue{std::int64_t{3}});
    auto view = kernel->room_view("en");
    REQUIRE(view);
    CHECK(view.value().description == "Hall description.");
}

TEST_CASE("typed Room lifecycle rejection and failures preserve the room-switch boundary")
{
    SECTION("source canLeave rejection resumes the source without hooks")
    {
        RuntimeFixture fixture;
        install_room_scripts(fixture, false);
        auto project = decode_document(load_document("comprehensive.json"), "room-reject-source");
        auto created = TypedExecutionKernel::create(project, fixture.runtime);
        REQUIRE(created);
        auto kernel = std::move(created).value();
        drive_to_room(*kernel, id<core::RoomId>("start"));
        REQUIRE(kernel->navigate(id<core::RoomExitId>("north-exit")));
        const auto outcome = kernel->run_until_blocked(1, "en");
        REQUIRE(std::holds_alternative<core::FlowModeChangedOutcome>(outcome));
        CHECK(std::get<core::RoomMode>(kernel->state().mode()).room == id<core::RoomId>("start"));
        CHECK(kernel->state().room_visits(id<core::RoomId>("hall")) == 0);
        CHECK(notifications(*kernel).empty());
    }

    SECTION("selected exit rejection resumes the source")
    {
        RuntimeFixture fixture;
        install_room_scripts(fixture);
        auto project = decode_document(load_document("comprehensive.json"), "room-reject-exit");
        auto created = TypedExecutionKernel::create(project, fixture.runtime);
        REQUIRE(created);
        auto kernel = std::move(created).value();
        drive_to_room(*kernel, id<core::RoomId>("start"));
        REQUIRE(kernel->apply(core::SetVariable{id<core::VariableId>("flag"), false}));
        REQUIRE(kernel->navigate(id<core::RoomExitId>("north-exit")));
        REQUIRE(std::holds_alternative<core::FlowBudgetYieldOutcome>(
            kernel->run_until_blocked(1, "en")));
        const auto outcome = kernel->run_until_blocked(1, "en");
        REQUIRE(std::holds_alternative<core::FlowModeChangedOutcome>(outcome));
        CHECK(std::get<core::RoomMode>(kernel->state().mode()).room == id<core::RoomId>("start"));
    }

    SECTION("target canEnter rejection resumes the source")
    {
        RuntimeFixture fixture;
        install_room_scripts(fixture, true, false, false, false);
        auto document = load_document("comprehensive.json");
        room_document(document, "hall")["lifecycle"]["canEnter"] = {{"kind", "lua-predicate"},
                                                                    {"source", "can_enter_hall()"}};
        auto project = decode_document(std::move(document), "room-reject-target");
        auto created = TypedExecutionKernel::create(project, fixture.runtime);
        REQUIRE(created);
        auto kernel = std::move(created).value();
        drive_to_room(*kernel, id<core::RoomId>("start"));
        REQUIRE(kernel->navigate(id<core::RoomExitId>("north-exit")));
        REQUIRE(std::holds_alternative<core::FlowBudgetYieldOutcome>(
            kernel->run_until_blocked(2, "en")));
        const auto outcome = kernel->run_until_blocked(1, "en");
        REQUIRE(std::holds_alternative<core::FlowModeChangedOutcome>(outcome));
        CHECK(std::get<core::RoomMode>(kernel->state().mode()).room == id<core::RoomId>("start"));
    }

    SECTION("initial target rejection faults because no source Room exists")
    {
        RuntimeFixture fixture;
        install_room_scripts(fixture, true, false, false, false);
        auto document = load_document("comprehensive.json");
        room_document(document, "start")["lifecycle"]["canEnter"] = {
            {"kind", "lua-predicate"}, {"source", "can_enter_hall()"}};
        auto project = decode_document(std::move(document), "room-reject-initial");
        auto created = TypedExecutionKernel::create(project, fixture.runtime);
        REQUIRE(created);
        auto kernel = std::move(created).value();
        const auto outcome = kernel->run_until_blocked(1, "en");
        REQUIRE(std::holds_alternative<core::FlowFaultOutcome>(outcome));
        REQUIRE(kernel->flow().discard_fault());
        CHECK(std::holds_alternative<core::EndedMode>(kernel->state().mode()));
    }

    SECTION("hook failure retains the exact precommit cursor")
    {
        RuntimeFixture fixture;
        install_room_scripts(fixture, true, false, true);
        auto project = decode_document(load_document("comprehensive.json"), "room-hook-failure");
        auto created = TypedExecutionKernel::create(project, fixture.runtime);
        REQUIRE(created);
        auto kernel = std::move(created).value();
        drive_to_room(*kernel, id<core::RoomId>("start"));
        REQUIRE_FALSE(kernel->navigate(id<core::RoomExitId>("missing")));
        CHECK(std::get<core::RoomMode>(kernel->state().mode()).room == id<core::RoomId>("start"));
        REQUIRE(kernel->navigate(id<core::RoomExitId>("north-exit")));
        REQUIRE(std::holds_alternative<core::FlowBudgetYieldOutcome>(
            kernel->run_until_blocked(3, "en")));
        const auto failed = kernel->run_until_blocked(1, "en");
        REQUIRE(std::holds_alternative<core::FlowFaultOutcome>(failed));
        CHECK(active_transition(*kernel).position.stage == core::RoomTransitionStage::BeforeLeave);
        CHECK(active_transition(*kernel).position.next_effect == 0);
        CHECK_FALSE(active_transition(*kernel).position.awaiting_completion);
        REQUIRE(kernel->flow().discard_fault());
        CHECK(std::get<core::RoomMode>(kernel->state().mode()).room == id<core::RoomId>("start"));
    }

    SECTION("postcommit hook failure discards to the target Room")
    {
        RuntimeFixture fixture;
        install_room_scripts(fixture);
        REQUIRE(
            fixture.runtime.execute("function after_enter_hall() error('after-enter failed') end",
                                    "room-postcommit-failure"));
        auto document = load_document("comprehensive.json");
        hook_document(room_document(document, "hall"), "after-enter")["effects"] =
            nlohmann::json::array({{{"kind", "run-lua-effect"}, {"source", "after_enter_hall()"}}});
        auto project = decode_document(std::move(document), "room-postcommit-failure");
        auto created = TypedExecutionKernel::create(project, fixture.runtime);
        REQUIRE(created);
        auto kernel = std::move(created).value();
        drive_to_room(*kernel, id<core::RoomId>("start"));
        REQUIRE(kernel->navigate(id<core::RoomExitId>("north-exit")));
        const auto failed = kernel->run_until_blocked(32, "en");
        REQUIRE(std::holds_alternative<core::FlowFaultOutcome>(failed));
        CHECK(active_transition(*kernel).position.stage == core::RoomTransitionStage::AfterEnter);
        CHECK(kernel->state().room_visits(id<core::RoomId>("hall")) == 1);
        REQUIRE(kernel->flow().discard_fault());
        CHECK(std::get<core::RoomMode>(kernel->state().mode()).room == id<core::RoomId>("hall"));
    }
}

TEST_CASE("typed Room flow targets run lifecycle and live property inheritance has one resolver")
{
    STATIC_REQUIRE_FALSE(HasCategories<core::compiled::RoomDefinition>);
    STATIC_REQUIRE_FALSE(HasTags<core::compiled::RoomDefinition>);

    RuntimeFixture fixture;
    install_room_scripts(fixture);
    auto document = load_document("comprehensive.json");
    document["properties"].push_back({{"id", "map"},
                                      {"label", "Map"},
                                      {"description", "Inherited map"},
                                      {"type", "string"},
                                      {"nullable", false},
                                      {"defaultValue", "default-map"},
                                      {"enumValues", nlohmann::json::array()},
                                      {"ownerKinds", nlohmann::json::array({"room"})},
                                      {"persistence", "Session"}});
    room_document(document, "start")["propertyAssignments"].push_back(
        {{"propertyId", "map"}, {"value", "house"}});
    room_document(document, "tower")["extends"] = "start";
    room_document(document, "tower")["propertyAssignments"].push_back(
        {{"propertyId", "map"}, {"value", "authored-tower"}});
    auto project = decode_document(std::move(document), "room-inheritance");
    auto created = TypedExecutionKernel::create(project, fixture.runtime);
    REQUIRE(created);
    auto kernel = std::move(created).value();

    const auto map = id<core::PropertyId>("map");
    const core::PropertyOwnerRef start{id<core::RoomId>("start")};
    const core::PropertyOwnerRef hall{id<core::RoomId>("hall")};
    const core::PropertyOwnerRef tower{id<core::RoomId>("tower")};
    CHECK(property_value(kernel->gateway().property(hall, map)) ==
          core::RuntimeValue{std::string{"house"}});
    CHECK(property_value(kernel->gateway().property(tower, map)) ==
          core::RuntimeValue{std::string{"authored-tower"}});
    REQUIRE(kernel->gateway().set_property(start, map, std::string{"runtime-root"}));
    CHECK(property_value(kernel->gateway().property(hall, map)) ==
          core::RuntimeValue{std::string{"runtime-root"}});
    CHECK(property_value(kernel->gateway().property(tower, map)) ==
          core::RuntimeValue{std::string{"authored-tower"}});
    REQUIRE(kernel->gateway().set_property(hall, map, std::string{"runtime-hall"}));
    CHECK(property_value(kernel->gateway().property(hall, map)) ==
          core::RuntimeValue{std::string{"runtime-hall"}});
    REQUIRE(kernel->gateway().unset_property(hall, map));
    CHECK(property_value(kernel->gateway().property(hall, map)) ==
          core::RuntimeValue{std::string{"runtime-root"}});

    drive_to_room(*kernel, id<core::RoomId>("start"));
    REQUIRE(kernel->start_transient(id<core::SceneId>("opening")));
    REQUIRE(kernel->flow().apply_target(core::FlowTarget{id<core::RoomId>("hall")}));
    const auto& transition = active_transition(*kernel);
    REQUIRE(transition.source_room);
    CHECK(*transition.source_room == id<core::RoomId>("start"));
    CHECK_FALSE(transition.selected_exit);
    drive_to_room(*kernel, id<core::RoomId>("hall"));
    CHECK(kernel->state().room_visits(id<core::RoomId>("hall")) == 1);
}

} // namespace noveltea::script::test
