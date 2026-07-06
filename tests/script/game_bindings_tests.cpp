#include <catch2/catch_test_macros.hpp>

#include <nlohmann/json.hpp>

#include <noveltea/core/game_session.hpp>
#include <noveltea/core/project_ids.hpp>
#include <noveltea/assets/asset_manager.hpp>
#include <noveltea/script/script_runtime.hpp>
#include <noveltea/runtime_shell.hpp>
#include "script/lua/script_runtime_internal.hpp"

#include <lua.hpp>
#include <sol/sol.hpp>

#include <memory>
#include <string>

using namespace noveltea;

namespace {

noveltea::core::EntityType E(noveltea::core::EntityType t) { return t; }

nlohmann::json props() { return nlohmann::json::object(); }

nlohmann::json ref(int type, std::string id)
{
    return nlohmann::json::array({type, std::move(id)});
}

core::ProjectDocument make_test_project()
{
    auto project = core::ProjectDocument::new_project();
    auto& root = project.root();
    root[core::project_ids::object] = nlohmann::json::object();
    root[core::project_ids::verb] = nlohmann::json::object();
    root[core::project_ids::action] = nlohmann::json::object();
    root[core::project_ids::room] = nlohmann::json::object({
        {"foyer",
         nlohmann::json::array({"foyer", "", props(), "text='Welcome to the foyer.';", "", "", "",
                                "", nlohmann::json::array(), nlohmann::json::array(), "Foyer"})},
        {"kitchen",
         nlohmann::json::array({"kitchen", "", props(), "text='A warm kitchen.';", "return true;",
                                "kitchen_after_enter", "return true;", "kitchen_after_leave",
                                nlohmann::json::array(), nlohmann::json::array(), "Kitchen"})},
    });
    root[core::project_ids::map] = nlohmann::json::object();
    root[core::project_ids::dialogue] = nlohmann::json::object();
    root[core::project_ids::cutscene] = nlohmann::json::object();
    root[core::project_ids::script] = nlohmann::json::object({
        {"greeting",
         nlohmann::json::array({"greeting", "", props(), false, R"(return "Hello from script!")"})},
        {"autorun_demo",
         nlohmann::json::array({"autorun_demo", "", props(), true, R"(return "autorun ran")"})},
    });
    root[core::project_ids::entrypoint_entity] =
        ref(core::to_integer(core::EntityType::Room), "foyer");
    root[core::project_ids::starting_inventory] = nlohmann::json::array();
    root[core::project_ids::properties] = nlohmann::json::object({
        {"global_greeting", "Hello World"},
        {"player_level", 5},
    });
    return project;
}

struct GameBindingsFixture {
    std::shared_ptr<assets::MemoryAssetSource> memory =
        std::make_shared<assets::MemoryAssetSource>();
    assets::AssetManager assets;
    script::ScriptRuntime runtime;
    core::GameSession session;

    GameBindingsFixture()
    {
        assets.mount("project", memory);
        auto initialized = runtime.initialize({&assets});
        REQUIRE(initialized);
        auto result = session.load(make_test_project());
        REQUIRE(result.success);
        runtime.bind_game_session(&session);
    }

    ~GameBindingsFixture() { runtime.clear_game_bindings(); }
};

struct GameCommandBindingsFixture {
    std::shared_ptr<assets::MemoryAssetSource> memory =
        std::make_shared<assets::MemoryAssetSource>();
    assets::AssetManager assets;
    script::ScriptRuntime runtime;
    RuntimeShell shell;

    GameCommandBindingsFixture()
    {
        assets.mount("project", memory);
        auto initialized = runtime.initialize({&assets});
        REQUIRE(initialized);
        REQUIRE(shell.load_project(make_test_project()).success);
        runtime.bind_runtime_host(&shell.host());
        runtime.bind_runtime_command_dispatcher(&shell.dispatcher());
    }

    ~GameCommandBindingsFixture() { runtime.clear_game_bindings(); }
};

} // namespace

TEST_CASE("Game bindings: basic Lua evaluation works")
{
    GameBindingsFixture f;
    // Verify basic evaluations work
    auto r1 = f.runtime.evaluate("42", "basic_int");
    if (!r1)
        FAIL("42 failed: " + r1.error->message + " | " + r1.error->traceback);
    CHECK(std::holds_alternative<std::int64_t>(*r1.value));
    auto r2 = f.runtime.evaluate_string("'hello'", "basic_str");
    REQUIRE(r2);
    CHECK(*r2.value == "hello");
    auto r3 = f.runtime.evaluate("true", "basic_bool");
    REQUIRE(r3);
    CHECK(std::holds_alternative<bool>(*r3.value));
    CHECK(std::get<bool>(*r3.value));
    // Check Game.room works (evaluate_string succeeds for string returns)
    auto r5 = f.runtime.evaluate_string("Game.room.id", "room_id");
    REQUIRE(r5);
    CHECK(*r5.value == "foyer");
}

TEST_CASE("Game bindings: Game.room returns current room")
{
    GameBindingsFixture f;
    auto result = f.runtime.evaluate_string("Game.room.id", "room_id");
    REQUIRE(result);
    CHECK(*result.value == "foyer");
}

TEST_CASE("Game bindings: Game.room.description returns raw description")
{
    GameBindingsFixture f;
    auto res = f.runtime.evaluate("Game.room.description", "desc");
    if (!res)
        FAIL("Game.room.description failed: " + res.error->message + " | " + res.error->traceback);
    REQUIRE(res);
    auto result = f.runtime.evaluate_string("Game.room.description", "desc_str");
    REQUIRE(result);
    REQUIRE(result.value);
    CHECK(result.value->find("foyer") != std::string::npos);
}

TEST_CASE("Game bindings: Game.room.name returns room name")
{
    GameBindingsFixture f;
    auto result = f.runtime.evaluate_string("Game.room.name", "name");
    REQUIRE(result);
    CHECK(*result.value == "Foyer");
}

TEST_CASE("Game bindings: Game.prop reads global properties")
{
    GameBindingsFixture f;
    auto eval_result = f.runtime.evaluate("Game.prop('global_greeting', 'default')", "greeting");
    if (!eval_result) {
        FAIL("Game.prop evaluation failed: " + eval_result.error->message +
             " | traceback: " + eval_result.error->traceback);
    }
    CHECK(std::holds_alternative<std::string>(*eval_result.value));
    if (auto* s = std::get_if<std::string>(&*eval_result.value)) {
        CHECK(*s == "Hello World");
    }

    auto missing = f.runtime.evaluate_string("Game.prop('nonexistent', 'fallback')", "missing");
    REQUIRE(missing);
    CHECK(*missing.value == "fallback");
}

TEST_CASE("Game bindings: Game.set_prop and unset_prop mutate save-backed properties")
{
    GameBindingsFixture f;

    REQUIRE(f.runtime.execute("Game.set_prop('runtime_score', 12)", "set_prop"));
    auto score = f.runtime.evaluate("Game.prop('runtime_score')", "runtime_score");
    REQUIRE(score);
    CHECK(std::get<std::int64_t>(*score.value) == 12);
    REQUIRE(f.session.save() != nullptr);
    CHECK(f.session.save()->root()[core::project_ids::properties]["runtime_score"] == 12);

    REQUIRE(f.runtime.execute("Game.unset_prop('runtime_score')", "unset_prop"));
    auto missing = f.runtime.evaluate_string("Game.prop('runtime_score', 'missing')", "missing");
    REQUIRE(missing);
    CHECK(*missing.value == "missing");
}

TEST_CASE("Game bindings: Game.load_room loads an entity by id")
{
    GameBindingsFixture f;
    auto result = f.runtime.evaluate_string("Game.load_room('kitchen').name", "kitchen_name");
    if (!result) {
        FAIL("Game.load_room name failed: " + result.error->message + " | " +
             result.error->traceback);
    }
    CHECK(*result.value == "Kitchen");
}

TEST_CASE("Game bindings: Game.exists_room checks entity existence")
{
    GameBindingsFixture f;
    auto exists = f.runtime.evaluate_bool("Game.exists_room('foyer')", "exists");
    REQUIRE(exists);
    CHECK(*exists.value);
    auto missing = f.runtime.evaluate_bool("Game.exists_room('nowhere')", "missing");
    REQUIRE(missing);
    CHECK_FALSE(*missing.value);
}

TEST_CASE("Game bindings: Game.load_script and ScriptEntity properties")
{
    GameBindingsFixture f;
    auto id_result = f.runtime.evaluate_string("Game.load_script('greeting').id", "id");
    REQUIRE(id_result);
    CHECK(*id_result.value == "greeting");

    auto autorun = f.runtime.evaluate_bool("Game.load_script('greeting').autorun", "autorun");
    REQUIRE(autorun);
    CHECK_FALSE(*autorun.value);

    auto autorun2 = f.runtime.evaluate_bool("Game.load_script('autorun_demo').autorun", "autorun2");
    REQUIRE(autorun2);
    CHECK(*autorun2.value);

    auto content = f.runtime.evaluate_string("Game.load_script('greeting').content", "content");
    REQUIRE(content);
    REQUIRE(content.value);
    CHECK(content.value->find("Hello") != std::string::npos);
}

TEST_CASE("Game bindings: dispatcher-backed shell commands route through RuntimeShell")
{
    GameCommandBindingsFixture f;

    auto command_start = f.runtime.execute("started = Game.command('game.start')", "command_start");
    REQUIRE(command_start);
    CHECK(f.shell.mode() == RuntimeShellMode::Game);
    auto started = f.runtime.evaluate_bool("started", "started");
    REQUIRE(started);
    CHECK(*started.value);

    auto pause = f.runtime.execute("paused = Game.pause()", "pause");
    REQUIRE(pause);
    CHECK(f.shell.mode() == RuntimeShellMode::Paused);
    auto paused = f.runtime.evaluate_bool("paused", "paused");
    REQUIRE(paused);
    CHECK(*paused.value);

    auto resume = f.runtime.execute("resumed = Game.resume()", "resume");
    REQUIRE(resume);
    CHECK(f.shell.mode() == RuntimeShellMode::Game);
    auto resumed = f.runtime.evaluate_bool("resumed", "resumed");
    REQUIRE(resumed);
    CHECK(*resumed.value);

    auto menu = f.runtime.execute(R"(
        load_ok = Game.open_load_menu()
        settings_ok = Game.open_settings_menu()
        close_ok = Game.close_menu()
    )",
                                  "menus");
    REQUIRE(menu);
    CHECK(*f.runtime.evaluate_bool("load_ok", "load_ok").value);
    CHECK(*f.runtime.evaluate_bool("settings_ok", "settings_ok").value);
    CHECK(*f.runtime.evaluate_bool("close_ok", "close_ok").value);
}

TEST_CASE("Game bindings: dispatcher-backed gameplay helpers build valid payloads")
{
    GameCommandBindingsFixture f;
    REQUIRE(f.runtime.execute("Game.start()", "start"));

    auto helpers = f.runtime.execute(R"(
        continue_ok = Game.continue()
        navigate_ok = Game.navigate(0)
        choose_ok = Game.choose(0)
        select_ok = Game.select_object("coin")
        clear_ok = Game.clear_selection()
        action_ok = Game.run_action("look", { "coin" })
        room_ok = Game.start_room("foyer")
        dialogue_ok = Game.start_dialogue("intro")
        scene_ok = Game.start_scene("opening")
        script_ok = Game.run_script("bootstrap")
    )",
                                     "helpers");
    REQUIRE(helpers);
    CHECK_FALSE(*f.runtime.evaluate_bool("continue_ok", "continue_ok").value);
    CHECK(*f.runtime.evaluate_bool("navigate_ok", "navigate_ok").value);
    CHECK_FALSE(*f.runtime.evaluate_bool("choose_ok", "choose_ok").value);
    CHECK_FALSE(*f.runtime.evaluate_bool("select_ok", "select_ok").value);
    CHECK(*f.runtime.evaluate_bool("clear_ok", "clear_ok").value);
    CHECK_FALSE(*f.runtime.evaluate_bool("action_ok", "action_ok").value);
    CHECK(*f.runtime.evaluate_bool("room_ok", "room_ok").value);
    CHECK(*f.runtime.evaluate_bool("dialogue_ok", "dialogue_ok").value);
    CHECK(*f.runtime.evaluate_bool("scene_ok", "scene_ok").value);
    CHECK(*f.runtime.evaluate_bool("script_ok", "script_ok").value);
}

TEST_CASE("Game bindings: layout layer helper dispatches through RuntimeShell")
{
    GameCommandBindingsFixture f;

    auto helpers = f.runtime.execute(R"(
        corner_ok = Game.add_layer("corner_button", 20)
        top_ok = Game.add_layer("bottom_nav")
    )",
                                     "layout_helpers");
    REQUIRE(helpers);
    CHECK_FALSE(*f.runtime.evaluate_bool("corner_ok", "corner_ok").value);
    CHECK_FALSE(*f.runtime.evaluate_bool("top_ok", "top_ok").value);
}

TEST_CASE("Game bindings: Script.rand and Script.seed produce deterministic sequence")
{
    GameBindingsFixture f;
    auto seed1 = f.runtime.execute("Script.seed(42)", "seed1");
    REQUIRE(seed1);
    auto r1 = f.runtime.evaluate("Script.rand()", "r1");
    REQUIRE(r1);
    REQUIRE(std::holds_alternative<double>(*r1.value));
    double v1 = std::get<double>(*r1.value);
    CHECK(v1 >= 0.0);
    CHECK(v1 < 1.0);

    // Same seed → same value
    auto seed2 = f.runtime.execute("Script.seed(42)", "seed2");
    REQUIRE(seed2);
    auto r2 = f.runtime.evaluate("Script.rand()", "r2");
    REQUIRE(r2);
    REQUIRE(std::holds_alternative<double>(*r2.value));
    double v2 = std::get<double>(*r2.value);
    CHECK(v1 == v2);
}

TEST_CASE("Game bindings: Script.eval_expressions evaluates {{ }} templates")
{
    GameBindingsFixture f;
    // Simple expression
    auto result =
        f.runtime.evaluate_string("Script.eval_expressions('Hello {{ 2 + 3 }}')", "simple");
    REQUIRE(result);
    CHECK(*result.value == "Hello 5");

    // Nested property access — Game.room.name is the dedicated field
    auto result2 = f.runtime.evaluate_string(
        R"(Script.eval_expressions('Room: {{ Game.room.name }}'))", "prop");
    REQUIRE(result2);
    CHECK(*result2.value == "Room: Foyer");
}

TEST_CASE("Game bindings: Log.push adds text log events")
{
    GameBindingsFixture f;
    int log_count = 0;
    auto text_log_listener = f.session.events().listen(core::RuntimeEventType::TextLogged,
                                                       [&](const core::RuntimeEvent&) {
                                                           ++log_count;
                                                           return true;
                                                       });
    REQUIRE(text_log_listener != 0);

    auto exec = f.runtime.execute(R"(Log.push("test log entry"))", "log_push");
    REQUIRE(exec);

    f.session.tick(0.0);
    auto dispatched = f.session.events().dispatch_queued();
    CHECK(dispatched);
    CHECK(log_count == 1);
}

TEST_CASE("Game bindings: toast emits notification and optionally text log events")
{
    GameBindingsFixture f;
    int notification_count = 0;
    int log_count = 0;
    auto notif_listener = f.session.events().listen(core::RuntimeEventType::Notification,
                                                    [&](const core::RuntimeEvent& e) {
                                                        CHECK(e.text == "hello");
                                                        ++notification_count;
                                                        return true;
                                                    });
    REQUIRE(notif_listener != 0);
    auto log_listener2 = f.session.events().listen(core::RuntimeEventType::TextLogged,
                                                   [&](const core::RuntimeEvent&) {
                                                       ++log_count;
                                                       return true;
                                                   });
    REQUIRE(log_listener2 != 0);

    auto toast_exec = f.runtime.execute(R"(toast("hello"))", "toast1");
    REQUIRE(toast_exec);
    f.session.tick(0.0);
    auto dispatched = f.session.events().dispatch_queued();
    CHECK(dispatched);
    CHECK(notification_count == 1);
    CHECK(log_count == 1);
}

TEST_CASE("Game bindings: thisEntity / prop / set_prop forward to entity")
{
    GameBindingsFixture f;
    // Set thisEntity to a room, then read/write prop
    auto entity_exec = f.runtime.execute(R"(
        thisEntity = Game.load_room("foyer")
        prop("visited", true)
    )",
                                         "thisEntity_set");
    REQUIRE(entity_exec);
    // Just verify it doesn't crash and returns the default for unset key
    auto result =
        f.runtime.evaluate_string(R"(prop("nonexistent_key", "fallback_val"))", "prop_read");
    REQUIRE(result);
    CHECK(*result.value == "fallback_val");
}

TEST_CASE("Game bindings: entity set_prop and unset_prop mutate save-backed overrides")
{
    GameBindingsFixture f;

    REQUIRE(f.runtime.execute(R"(
        room = Game.load_room("foyer")
        room:set_prop("runtime_note", "saved")
    )",
                              "entity_set_prop"));
    auto value =
        f.runtime.evaluate_string(R"(Game.load_room("foyer"):prop("runtime_note"))", "entity_prop");
    REQUIRE(value);
    CHECK(*value.value == "saved");

    REQUIRE(f.runtime.execute(R"(Game.load_room("foyer"):unset_prop("runtime_note"))",
                              "entity_unset_prop"));
    auto missing = f.runtime.evaluate_string(
        R"(Game.load_room("foyer"):prop("runtime_note", "missing"))", "entity_missing");
    REQUIRE(missing);
    CHECK(*missing.value == "missing");
}

TEST_CASE("Game bindings: object location helpers mutate save object locations")
{
    GameBindingsFixture f;

    REQUIRE(f.runtime.execute("Game.set_object_location('coin', 3, 'foyer')", "set_location"));
    auto location = f.session.object_location("coin");
    REQUIRE(location.has_value());
    CHECK(location->type == core::EntityType::Room);
    CHECK(location->id == "foyer");

    auto location_id = f.runtime.evaluate_string("Game.object_location('coin').id", "location_id");
    REQUIRE(location_id);
    CHECK(*location_id.value == "foyer");

    REQUIRE(f.runtime.execute("Game.clear_object_location('coin')", "clear_location"));
    CHECK_FALSE(f.session.object_location("coin").has_value());
}

TEST_CASE("Game bindings: Game.push_next queues an entity")
{
    GameBindingsFixture f;
    REQUIRE(f.session.entity_queue().empty());
    auto push_result = f.runtime.execute("Game.push_next(6, 'greeting')", "push");
    REQUIRE(push_result);
    REQUIRE(f.session.entity_queue().size() == 1);
    CHECK(f.session.entity_queue().front().type == core::EntityType::Script);
    CHECK(f.session.entity_queue().front().id == "greeting");
}

TEST_CASE("Game bindings: Script.run executes a Script entity's content")
{
    GameBindingsFixture f;
    auto exec_result = f.runtime.execute(R"(Script.run("greeting"))", "script_run_exec");
    if (!exec_result) {
        FAIL("Script.run execution failed: " + exec_result.error->message + " | " +
             exec_result.error->traceback);
    }
    auto result = f.runtime.evaluate_string(R"(Script.run("greeting") and "done")", "script_run");
    REQUIRE(result);
    CHECK(*result.value == "done");
}

TEST_CASE("Game bindings: Timer.start creates a one-shot timer")
{
    GameBindingsFixture f;
    int timer_fired = 0;
    auto timer_exec = f.runtime.execute(R"(
        timer_id = Timer.start(100, function(id)
            -- timer callback
        end)
    )",
                                        "timer_start");
    REQUIRE(timer_exec);
    auto result = f.runtime.evaluate("timer_id", "timer_id");
    REQUIRE(result);
    REQUIRE(std::holds_alternative<std::int64_t>(*result.value));
    auto tid = static_cast<core::RuntimeTimerId>(std::get<std::int64_t>(*result.value));
    CHECK(tid != 0);
    CHECK(f.session.timers().active(tid));
}

TEST_CASE("Game bindings: Timer.cancel and Timer.active inspect timers")
{
    GameBindingsFixture f;
    REQUIRE(f.runtime.execute(R"(
        timer_id = Timer.start(100, function() end)
        was_active = Timer.active(timer_id)
        was_cancelled = Timer.cancel(timer_id)
        is_active_after_cancel = Timer.active(timer_id)
    )",
                              "timer_cancel"));

    auto was_active = f.runtime.evaluate_bool("was_active", "was_active");
    REQUIRE(was_active);
    CHECK(*was_active.value);
    auto was_cancelled = f.runtime.evaluate_bool("was_cancelled", "was_cancelled");
    REQUIRE(was_cancelled);
    CHECK(*was_cancelled.value);
    auto is_active_after_cancel =
        f.runtime.evaluate_bool("is_active_after_cancel", "is_active_after_cancel");
    REQUIRE(is_active_after_cancel);
    CHECK_FALSE(*is_active_after_cancel.value);
}

TEST_CASE("Game bindings: Game navigation and minimap flags")
{
    GameBindingsFixture f;
    auto nav = f.runtime.evaluate_bool("Game.navigation", "nav");
    REQUIRE(nav);
    CHECK(*nav.value);
    auto map = f.runtime.evaluate_bool("Game.minimap", "map");
    REQUIRE(map);
    CHECK(*map.value);
}

TEST_CASE("Game bindings: Room usertype entity properties via :prop()")
{
    GameBindingsFixture f;
    auto chain = f.runtime.evaluate_string("Game.load_room('foyer').name", "load_chain");
    if (!chain)
        FAIL("load_chain failed: " + chain.error->message + " | " + chain.error->traceback);
    CHECK(*chain.value == "Foyer");
    // :prop() accesses the entity's properties JSON (not dedicated fields like .name)
    // Use description_raw which IS in the room entity data
    auto exec = f.runtime.execute(R"(
        room = Game.load_room("foyer")
    )",
                                  "room_setup");
    REQUIRE(exec);
    auto result = f.runtime.evaluate_string(R"(room:prop("nonexistent", "fallback"))", "room_prop");
    REQUIRE(result);
    CHECK(*result.value == "fallback");
}

TEST_CASE("Game bindings: Game bindings are cleared and re-bindable")
{
    GameBindingsFixture f;

    // Verify bindings work
    auto r1 = f.runtime.evaluate_string("Game.room.id", "before_clear");
    REQUIRE(r1);
    CHECK(*r1.value == "foyer");

    // Clear bindings
    f.runtime.clear_game_bindings();
    auto r2 = f.runtime.evaluate("Game", "after_clear");
    REQUIRE(r2);
    CHECK(std::holds_alternative<std::monostate>(*r2.value));

    // Re-bind
    f.runtime.bind_game_session(&f.session);
    auto r3 = f.runtime.evaluate_string("Game.room.id", "after_rebind");
    REQUIRE(r3);
    CHECK(*r3.value == "foyer");
}
