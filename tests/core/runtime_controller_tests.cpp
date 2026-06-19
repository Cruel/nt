#include <catch2/catch_test_macros.hpp>

#include <nlohmann/json.hpp>

#include <noveltea/core/game_session.hpp>
#include <noveltea/core/project_ids.hpp>
#include <noveltea/core/runtime_controller.hpp>

using namespace noveltea::core;

namespace {

nlohmann::json props()
{
    return nlohmann::json::object();
}

nlohmann::json ref(EntityType type, std::string id)
{
    return nlohmann::json::array({to_integer(type), std::move(id)});
}

nlohmann::json path_entry(bool enabled, EntityType type, const std::string& id)
{
    return nlohmann::json::array({enabled, ref(type, id)});
}

EntityRef eref(EntityType type, std::string id)
{
    return EntityRef{type, std::move(id)};
}

ProjectDocument make_room_project()
{
    auto project = ProjectDocument::new_project();
    auto& root = project.root();
    root[project_ids::object] = nlohmann::json::object();
    root[project_ids::verb] = nlohmann::json::object();
    root[project_ids::action] = nlohmann::json::object();
    root[project_ids::room] = nlohmann::json::object({
        {"foyer", nlohmann::json::array({"foyer", "", props(),
                                         "text='Welcome to the foyer.';",
                                         "", "", "", "",
                                         nlohmann::json::array(),
                                         nlohmann::json::array({
                                             path_entry(true, EntityType::Room, "kitchen"),
                                             path_entry(false, EntityType::Room, "basement"),
                                         }),
                                         "Foyer"})},
        {"kitchen", nlohmann::json::array({"kitchen", "", props(),
                                           "text='A bright kitchen.';",
                                           "", "", "", "",
                                           nlohmann::json::array(),
                                           nlohmann::json::array(),
                                           "Kitchen"})},
    });
    root[project_ids::map] = nlohmann::json::object();
    root[project_ids::dialogue] = nlohmann::json::object();
    root[project_ids::cutscene] = nlohmann::json::object();
    root[project_ids::script] = nlohmann::json::object();
    root[project_ids::entrypoint_entity] = ref(EntityType::Room, "foyer");
    root[project_ids::starting_inventory] = nlohmann::json::array();
    return project;
}

ProjectDocument make_non_room_entrypoint_project()
{
    auto project = make_room_project();
    project.root()[project_ids::entrypoint_entity] = ref(EntityType::Script, "init");
    project.root()[project_ids::script] = nlohmann::json::object({
        {"init", nlohmann::json::array({"init", "", props(), false, "log('hello');"})},
    });
    return project;
}

nlohmann::json object_entry(const std::string& id, const std::string& name)
{
    return nlohmann::json::array({id, "", props(), name, false});
}

nlohmann::json verb_entry(const std::string& id, int object_count, const std::string& default_script = "")
{
    return nlohmann::json::array({
        id,
        "",
        props(),
        id,
        object_count,
        default_script,
        "",
        nlohmann::json::array(),
    });
}

nlohmann::json action_entry(const std::string& id,
                            const std::string& parent_id,
                            const std::string& verb_id,
                            const std::string& script,
                            std::vector<std::string> object_ids,
                            bool position_dependent)
{
    nlohmann::json objects = nlohmann::json::array();
    for (const auto& object_id : object_ids) {
        objects.push_back(object_id);
    }
    return nlohmann::json::array({id, parent_id, props(), verb_id, script, objects, position_dependent});
}

ProjectDocument make_action_project()
{
    auto project = make_room_project();
    auto& root = project.root();
    root[project_ids::script_before_action] = "before();";
    root[project_ids::script_after_action] = "after();";
    root[project_ids::object] = nlohmann::json::object({
        {"lamp", object_entry("lamp", "Lamp")},
        {"key", object_entry("key", "Key")},
        {"coin", object_entry("coin", "Coin")},
    });
    root[project_ids::verb] = nlohmann::json::object({
        {"use", verb_entry("use", 2, "default_use();")},
        {"look", verb_entry("look", 1, "default_look();")},
    });
    root[project_ids::action] = nlohmann::json::object({
        {"base_use", action_entry("base_use", "", "look", "base_use();", {"coin"}, false)},
        {"use_lamp_key", action_entry("use_lamp_key", "base_use", "use", "use_lamp_key();", {"lamp", "key"}, false)},
        {"use_key_lamp_exact", action_entry("use_key_lamp_exact", "", "use", "use_key_lamp_exact();", {"key", "lamp"}, true)},
    });

    auto& foyer = root[project_ids::room]["foyer"];
    foyer[8] = nlohmann::json::array({
        nlohmann::json::array({"lamp", true}),
        nlohmann::json::array({"key", true}),
    });
    root[project_ids::starting_inventory] = nlohmann::json::array({"coin"});
    return project;
}

ProjectDocument make_room_hook_project()
{
    auto project = make_room_project();
    auto& root = project.root();
    root[project_ids::script_before_enter] = "project_before_enter();";
    root[project_ids::script_after_enter] = "project_after_enter();";
    root[project_ids::script_before_leave] = "project_before_leave();";
    root[project_ids::script_after_leave] = "project_after_leave();";
    auto& foyer = root[project_ids::room]["foyer"];
    foyer[4] = "room_before_enter();";
    foyer[5] = "room_after_enter();";
    foyer[6] = "room_before_leave();";
    foyer[7] = "room_after_leave();";
    return project;
}

bool has_command(const std::vector<ControllerCommand>& commands, ControllerCommandType type)
{
    for (const auto& cmd : commands) {
        if (cmd.type == type) {
            return true;
        }
    }
    return false;
}

} // namespace

TEST_CASE("RuntimeController enters room mode from room entrypoint on first tick")
{
    GameSession session;
    REQUIRE(session.load(make_room_project()).success);

    RuntimeController controller(session);
    CHECK(controller.idle());
    CHECK(controller.current_mode_name() == std::string_view("none"));

    controller.tick(0.0);

    CHECK_FALSE(controller.idle());
    CHECK(controller.current_mode_name() == std::string_view("room"));

    auto commands = controller.take_commands();
    CHECK(has_command(commands, ControllerCommandType::ModeChanged));
    CHECK(has_command(commands, ControllerCommandType::RoomEntry));
    CHECK(has_command(commands, ControllerCommandType::RoomDescription));
    CHECK(has_command(commands, ControllerCommandType::NavigationUpdate));

    const auto* mode_cmd = [&]() -> const ControllerCommand* {
        for (const auto& c : commands) {
            if (c.type == ControllerCommandType::ModeChanged && c.data.value("entering", false) == true) {
                return &c;
            }
        }
        return nullptr;
    }();
    REQUIRE(mode_cmd != nullptr);
    CHECK(mode_cmd->text == "room");
    REQUIRE(mode_cmd->entity.has_value());
    CHECK(mode_cmd->entity->type == EntityType::Room);
    CHECK(mode_cmd->entity->id == "foyer");
    CHECK(mode_cmd->data.value("first_visit", false) == true);
    CHECK(mode_cmd->data.value("room_name", "") == "Foyer");

    const auto* desc_cmd = [&]() -> const ControllerCommand* {
        for (const auto& c : commands) {
            if (c.type == ControllerCommandType::RoomDescription) {
                return &c;
            }
        }
        return nullptr;
    }();
    REQUIRE(desc_cmd != nullptr);
    CHECK(desc_cmd->text == "text='Welcome to the foyer.';");
    CHECK(desc_cmd->entity->id == "foyer");
    CHECK(desc_cmd->data.value("first_visit", false) == true);

    const auto* nav_cmd = [&]() -> const ControllerCommand* {
        for (const auto& c : commands) {
            if (c.type == ControllerCommandType::NavigationUpdate) {
                return &c;
            }
        }
        return nullptr;
    }();
    REQUIRE(nav_cmd != nullptr);
    REQUIRE(nav_cmd->data.contains("paths"));
    const auto& paths = nav_cmd->data["paths"];
    REQUIRE(paths.is_array());
    REQUIRE(paths.size() == 2);
    CHECK(paths[0]["enabled"] == true);
    CHECK(paths[0]["target_id"] == "kitchen");
    CHECK(paths[1]["enabled"] == false);
    CHECK(paths[1]["target_id"] == "basement");
}

TEST_CASE("RuntimeController queues non-room entrypoint and emits ScriptDeferred")
{
    GameSession session;
    REQUIRE(session.load(make_non_room_entrypoint_project()).success);

    RuntimeController controller(session);
    controller.tick(0.0);

    CHECK(controller.current_mode_name() == std::string_view("none"));
    CHECK_FALSE(controller.idle());

    auto commands = controller.take_commands();
    CHECK(has_command(commands, ControllerCommandType::ScriptDeferred));

    const auto* deferred = [&]() -> const ControllerCommand* {
        for (const auto& c : commands) {
            if (c.type == ControllerCommandType::ScriptDeferred) {
                return &c;
            }
        }
        return nullptr;
    }();
    REQUIRE(deferred != nullptr);
    REQUIRE(deferred->entity.has_value());
    CHECK(deferred->entity->type == EntityType::Script);
    CHECK(deferred->entity->id == "init");
    CHECK(deferred->text == "log('hello');");
    CHECK(deferred->data.value("context", "") == "script");
    CHECK(has_command(commands, ControllerCommandType::ModeChanged));
}

TEST_CASE("RuntimeController room mode blocks queue draining until navigate_path")
{
    GameSession session;
    REQUIRE(session.load(make_room_project()).success);

    session.queue_entity(eref(EntityType::Script, "init"));

    RuntimeController controller(session);

    controller.tick(0.0);
    {
        auto cmds = controller.take_commands();
        CHECK(has_command(cmds, ControllerCommandType::RoomEntry));
        CHECK(controller.current_mode_name() == std::string_view("room"));
        // Script init is in queue but room mode blocks draining
        CHECK(session.entity_queue().size() == 1);
    }

    // Room mode blocks - next tick can't drain
    controller.tick(0.0);
    {
        auto cmds = controller.take_commands();
        CHECK(cmds.empty());
        CHECK(session.entity_queue().size() == 1);
    }

    // Navigate to kitchen - queues target and exits room mode
    controller.navigate_path(0);
    (void)controller.take_commands();
    CHECK(controller.current_mode_name() == std::string_view("none"));
    CHECK(session.entity_queue().size() == 2); // Script + Kitchen

    // Tick pops Script (ScriptDeferred)
    controller.tick(0.0);
    {
        auto cmds = controller.take_commands();
        CHECK(has_command(cmds, ControllerCommandType::ScriptDeferred));
        CHECK(session.entity_queue().size() == 1);
    }

    // Tick pops Kitchen (enter room mode again)
    controller.tick(0.0);
    {
        auto cmds = controller.take_commands();
        CHECK(has_command(cmds, ControllerCommandType::RoomEntry));
        CHECK(session.current_room_id() == std::optional<std::string>("kitchen"));
        CHECK(controller.current_mode_name() == std::string_view("room"));
    }

    // Queue empty, stay blocking in kitchen
    controller.tick(0.0);
    {
        auto cmds = controller.take_commands();
        CHECK(cmds.empty());
        CHECK(controller.current_mode_name() == std::string_view("room"));
        CHECK_FALSE(controller.idle());
    }
}

TEST_CASE("RuntimeController navigate_path queues target and exits room mode")
{
    GameSession session;
    REQUIRE(session.load(make_room_project()).success);

    RuntimeController controller(session);
    controller.tick(0.0);
    (void)controller.take_commands();

    CHECK(controller.current_mode_name() == std::string_view("room"));

    controller.navigate_path(0);

    CHECK(controller.current_mode_name() == std::string_view("none"));
    CHECK(session.entity_queue().size() == 1);
    CHECK(session.entity_queue().front().type == EntityType::Room);
    CHECK(session.entity_queue().front().id == "kitchen");

    auto commands = controller.take_commands();
    CHECK(has_command(commands, ControllerCommandType::ModeChanged));
    bool found_exit = false;
    for (const auto& cmd : commands) {
        if (cmd.type == ControllerCommandType::ModeChanged && cmd.data.value("entering", true) == false) {
            found_exit = true;
            break;
        }
    }
    CHECK(found_exit);
}

TEST_CASE("RuntimeController navigate_path ignores invalid direction")
{
    GameSession session;
    REQUIRE(session.load(make_room_project()).success);

    RuntimeController controller(session);
    controller.tick(0.0);
    (void)controller.take_commands();

    controller.navigate_path(-1);
    CHECK(controller.current_mode_name() == std::string_view("room"));

    controller.navigate_path(10);
    CHECK(controller.current_mode_name() == std::string_view("room"));

    CHECK(session.entity_queue().empty());
}

TEST_CASE("RuntimeController navigate_path ignores disabled path")
{
    GameSession session;
    REQUIRE(session.load(make_room_project()).success);

    RuntimeController controller(session);
    controller.tick(0.0);
    (void)controller.take_commands();

    controller.navigate_path(1);
    CHECK(controller.current_mode_name() == std::string_view("room"));
    CHECK(session.entity_queue().empty());
}

TEST_CASE("RuntimeController navigate_path is no-op outside room mode")
{
    GameSession session;
    REQUIRE(session.load(make_non_room_entrypoint_project()).success);

    RuntimeController controller(session);
    controller.tick(0.0);
    (void)controller.take_commands();

    CHECK(controller.current_mode_name() == std::string_view("none"));
    controller.navigate_path(0);
    CHECK(session.entity_queue().empty());
}

TEST_CASE("RuntimeController tracks room visit counts across transitions")
{
    GameSession session;
    REQUIRE(session.load(make_room_project()).success);

    RuntimeController controller(session);
    controller.tick(0.0);
    (void)controller.take_commands();

    CHECK(controller.visit_count("foyer") == 0);
    CHECK(controller.visit_count("kitchen") == 0);

    controller.navigate_path(0);
    (void)controller.take_commands();

    CHECK(controller.visit_count("foyer") == 1);
    CHECK(controller.visit_count("kitchen") == 0);

    controller.tick(0.0);
    (void)controller.take_commands();

    CHECK(controller.current_mode_name() == std::string_view("room"));
    CHECK(session.current_room_id() == std::optional<std::string>("kitchen"));
}

TEST_CASE("RuntimeController correctly reports first vs subsequent room entries")
{
    GameSession session;
    REQUIRE(session.load(make_room_project()).success);

    RuntimeController controller(session);

    controller.tick(0.0);
    {
        auto cmds = controller.take_commands();
        const auto* entry = [&]() -> const ControllerCommand* {
            for (const auto& c : cmds) {
                if (c.type == ControllerCommandType::RoomEntry) return &c;
            }
            return nullptr;
        }();
        REQUIRE(entry != nullptr);
        CHECK(entry->data.value("first_visit", false) == true);
    }

    controller.navigate_path(0);
    (void)controller.take_commands();

    controller.tick(0.0);
    {
        auto cmds = controller.take_commands();
        const auto* entry = [&]() -> const ControllerCommand* {
            for (const auto& c : cmds) {
                if (c.type == ControllerCommandType::RoomEntry) return &c;
            }
            return nullptr;
        }();
        REQUIRE(entry != nullptr);
        CHECK(entry->data.value("first_visit", false) == true);
        CHECK(entry->entity->id == "kitchen");
    }
}

TEST_CASE("RuntimeController idle when queue empty and no mode active")
{
    GameSession session;
    REQUIRE(session.load(make_non_room_entrypoint_project()).success);

    RuntimeController controller(session);

    controller.tick(0.0);
    (void)controller.take_commands();
    CHECK_FALSE(controller.idle());
    CHECK(controller.current_mode_name() == std::string_view("none"));

    controller.tick(0.0);
    (void)controller.take_commands();
    CHECK(controller.idle());
}

TEST_CASE("RuntimeController take_commands clears accumulated commands")
{
    GameSession session;
    REQUIRE(session.load(make_room_project()).success);

    RuntimeController controller(session);
    controller.tick(0.0);

    auto commands = controller.take_commands();
    CHECK_FALSE(commands.empty());

    auto empty = controller.take_commands();
    CHECK(empty.empty());
}

TEST_CASE("RuntimeController tick advances session play time")
{
    GameSession session;
    REQUIRE(session.load(make_room_project()).success);

    RuntimeController controller(session);
    CHECK(session.play_time() == 0.0);

    controller.tick(1.5);
    CHECK(session.play_time() == 1.5);

    controller.tick(0.5);
    CHECK(session.play_time() == 2.0);
}

TEST_CASE("RuntimeController startup is handled exactly once")
{
    GameSession session;
    REQUIRE(session.load(make_non_room_entrypoint_project()).success);

    RuntimeController controller(session);

    controller.tick(0.0);
    (void)controller.take_commands();
    CHECK_FALSE(controller.idle());

    controller.tick(0.0);
    (void)controller.take_commands();
    CHECK(controller.idle());

    controller.tick(0.0);
    auto cmds = controller.take_commands();
    CHECK_FALSE(has_command(cmds, ControllerCommandType::ScriptDeferred));
    CHECK(controller.idle());
}

TEST_CASE("RuntimeController emits room enter and leave hook scripts in legacy order")
{
    GameSession session;
    REQUIRE(session.load(make_room_hook_project()).success);

    RuntimeController controller(session);
    controller.tick(0.0);

    auto enter_commands = controller.take_commands();
    std::vector<std::string> enter_contexts;
    for (const auto& cmd : enter_commands) {
        if (cmd.type == ControllerCommandType::ScriptDeferred) {
            enter_contexts.push_back(cmd.data.value("context", ""));
        }
    }
    CHECK(enter_contexts == std::vector<std::string>{
        "project_before_enter",
        "room_before_enter",
        "project_after_enter",
        "room_after_enter",
    });

    controller.navigate_path(0);
    auto leave_commands = controller.take_commands();
    std::vector<std::string> leave_contexts;
    for (const auto& cmd : leave_commands) {
        if (cmd.type == ControllerCommandType::ScriptDeferred) {
            leave_contexts.push_back(cmd.data.value("context", ""));
        }
    }
    CHECK(leave_contexts == std::vector<std::string>{
        "project_before_leave",
        "room_before_leave",
        "project_after_leave",
        "room_after_leave",
    });
}

TEST_CASE("RuntimeController save_state and restore_state preserve active room")
{
    GameSession session;
    REQUIRE(session.load(make_room_project()).success);

    RuntimeController controller(session);
    controller.tick(0.0);
    (void)controller.take_commands();
    controller.navigate_path(0);
    (void)controller.take_commands();
    controller.tick(0.0);
    (void)controller.take_commands();
    CHECK(controller.visit_count("foyer") == 1);

    auto saved = controller.save_state();

    RuntimeController restored(session);
    restored.restore_state(saved);

    CHECK(restored.current_mode_name() == std::string_view("room"));
    CHECK(restored.visit_count("foyer") == 1);
    CHECK_FALSE(restored.idle());
    auto commands = restored.take_commands();
    CHECK(has_command(commands, ControllerCommandType::RoomEntry));
}

TEST_CASE("RuntimeController forwards notification and text log events as commands")
{
    GameSession session;
    REQUIRE(session.load(make_room_project()).success);

    RuntimeController controller(session);

    RuntimeEvent notification;
    notification.type = RuntimeEventType::Notification;
    notification.text = "Saved";
    notification.number_value = 1200.0;
    session.events().push(notification);

    RuntimeEvent text_log;
    text_log.type = RuntimeEventType::TextLogged;
    text_log.text = "A log entry";
    session.events().push(text_log);

    controller.tick(0.0);

    auto commands = controller.take_commands();
    CHECK(has_command(commands, ControllerCommandType::Notification));
    CHECK(has_command(commands, ControllerCommandType::TextLogged));
}

TEST_CASE("RuntimeController process_action emits action script chain")
{
    GameSession session;
    REQUIRE(session.load(make_action_project()).success);

    RuntimeController controller(session);
    controller.tick(0.0);
    (void)controller.take_commands();

    REQUIRE(controller.process_action("use", {"lamp", "key"}));

    auto commands = controller.take_commands();
    REQUIRE(commands.size() == 5);
    CHECK(commands[0].type == ControllerCommandType::ScriptDeferred);
    CHECK(commands[0].data.value("context", "") == "project_before_action");
    CHECK(commands[1].type == ControllerCommandType::ScriptDeferred);
    CHECK(commands[1].data.value("action_id", "") == "base_use");
    CHECK(commands[2].type == ControllerCommandType::ScriptDeferred);
    CHECK(commands[2].data.value("action_id", "") == "use_lamp_key");
    CHECK(commands[3].type == ControllerCommandType::ActionResolved);
    CHECK(commands[3].entity->id == "use_lamp_key");
    CHECK(commands[3].data.value("used_default", true) == false);
    CHECK(commands[4].type == ControllerCommandType::ScriptDeferred);
    CHECK(commands[4].data.value("context", "") == "project_after_action");
}

TEST_CASE("RuntimeController process_action supports position-dependent matching")
{
    GameSession session;
    REQUIRE(session.load(make_action_project()).success);

    RuntimeController controller(session);
    controller.tick(0.0);
    (void)controller.take_commands();

    REQUIRE(controller.process_action("use", {"key", "lamp"}));

    auto commands = controller.take_commands();
    const auto* resolved = [&]() -> const ControllerCommand* {
        for (const auto& cmd : commands) {
            if (cmd.type == ControllerCommandType::ActionResolved) return &cmd;
        }
        return nullptr;
    }();
    REQUIRE(resolved != nullptr);
    REQUIRE(resolved->entity.has_value());
    CHECK(resolved->entity->id == "use_key_lamp_exact");
}

TEST_CASE("RuntimeController process_action falls back to verb default script")
{
    GameSession session;
    REQUIRE(session.load(make_action_project()).success);

    RuntimeController controller(session);
    controller.tick(0.0);
    (void)controller.take_commands();

    REQUIRE(controller.process_action("look", {"lamp"}));

    auto commands = controller.take_commands();
    CHECK(has_command(commands, ControllerCommandType::ActionResolved));
    bool found_default_script = false;
    for (const auto& cmd : commands) {
        if (cmd.type == ControllerCommandType::ScriptDeferred &&
            cmd.data.value("context", "") == "verb_default_action" &&
            cmd.text == "default_look();") {
            found_default_script = true;
        }
        if (cmd.type == ControllerCommandType::ActionResolved) {
            CHECK(cmd.data.value("used_default", false) == true);
            REQUIRE(cmd.entity.has_value());
            CHECK(cmd.entity->type == EntityType::Verb);
        }
    }
    CHECK(found_default_script);
}

TEST_CASE("RuntimeController process_action rejects unavailable objects")
{
    GameSession session;
    REQUIRE(session.load(make_action_project()).success);

    RuntimeController controller(session);
    controller.tick(0.0);
    (void)controller.take_commands();

    CHECK_FALSE(controller.process_action("look", {"missing"}));

    auto commands = controller.take_commands();
    REQUIRE(commands.size() == 1);
    CHECK(commands[0].type == ControllerCommandType::ActionRejected);
    CHECK(commands[0].data.value("reason", "") == "object unavailable");
}

namespace {

ProjectDocument make_dialogue_project()
{
    auto project = make_non_room_entrypoint_project();

    auto seg0 = nlohmann::json::array();
    seg0.push_back(0); seg0.push_back(-1); seg0.push_back(false);
    seg0.push_back(false); seg0.push_back(false); seg0.push_back(false);
    seg0.push_back(false); seg0.push_back(false);
    seg0.push_back(""); seg0.push_back(""); seg0.push_back("");
    auto ch1 = nlohmann::json::array(); ch1.push_back(1);
    seg0.push_back(ch1);

    auto seg1 = nlohmann::json::array();
    seg1.push_back(1); seg1.push_back(-1); seg1.push_back(false);
    seg1.push_back(false); seg1.push_back(false); seg1.push_back(false);
    seg1.push_back(false); seg1.push_back(false);
    seg1.push_back(""); seg1.push_back(""); seg1.push_back("[Greeter]Hello there!");
    auto ch2 = nlohmann::json::array(); ch2.push_back(2);
    seg1.push_back(ch2);

    auto seg2 = nlohmann::json::array();
    seg2.push_back(2); seg2.push_back(-1); seg2.push_back(false);
    seg2.push_back(false); seg2.push_back(false); seg2.push_back(false);
    seg2.push_back(false); seg2.push_back(false);
    seg2.push_back(""); seg2.push_back(""); seg2.push_back("Go to kitchen");
    seg2.push_back(nlohmann::json::array());

    auto segments = nlohmann::json::array();
    segments.push_back(seg0);
    segments.push_back(seg1);
    segments.push_back(seg2);

    auto dialogueEntry = nlohmann::json::array();
    dialogueEntry.push_back("talk_greeter");
    dialogueEntry.push_back("");
    dialogueEntry.push_back(props());
    dialogueEntry.push_back("Greeter");
    dialogueEntry.push_back(ref(EntityType::Room, "kitchen"));
    dialogueEntry.push_back(0);
    dialogueEntry.push_back(false);
    dialogueEntry.push_back(false);
    dialogueEntry.push_back(1);
    dialogueEntry.push_back(segments);

    auto dialogueRoot = nlohmann::json::object();
    dialogueRoot["talk_greeter"] = dialogueEntry;
    project.root()[project_ids::dialogue] = dialogueRoot;
    return project;
}

ProjectDocument make_cutscene_project()
{
    auto project = make_non_room_entrypoint_project();

    auto pageSeg = nlohmann::json::array();
    pageSeg.push_back(2); pageSeg.push_back(true);
    pageSeg.push_back("Welcome to the game.\n\nLet's begin!");
    pageSeg.push_back("\n"); pageSeg.push_back("\n\n");
    pageSeg.push_back(0); pageSeg.push_back(1);
    pageSeg.push_back(1000); pageSeg.push_back(2000);
    pageSeg.push_back(2000); pageSeg.push_back(3000);
    pageSeg.push_back(true); pageSeg.push_back(true);
    pageSeg.push_back(0); pageSeg.push_back(0);
    pageSeg.push_back(""); pageSeg.push_back(true);

    auto segments = nlohmann::json::array();
    segments.push_back(pageSeg);

    auto cutsceneEntry = nlohmann::json::array();
    cutsceneEntry.push_back("intro");
    cutsceneEntry.push_back("");
    cutsceneEntry.push_back(props());
    cutsceneEntry.push_back(true);
    cutsceneEntry.push_back(true);
    cutsceneEntry.push_back(1.0);
    cutsceneEntry.push_back(ref(EntityType::Room, "foyer"));
    cutsceneEntry.push_back(segments);

    auto cutsceneRoot = nlohmann::json::object();
    cutsceneRoot["intro"] = cutsceneEntry;
    project.root()[project_ids::cutscene] = cutsceneRoot;
    return project;
}

} // namespace

TEST_CASE("RuntimeController enters dialogue mode from dialogue entity")
{
    GameSession session;
    REQUIRE(session.load(make_dialogue_project()).success);

    RuntimeController controller(session);
    // Queue dialogue BEFORE tick so it's in front of startup's Script init
    session.queue_entity(eref(EntityType::Dialogue, "talk_greeter"));

    controller.tick(0.0);
    auto commands = controller.take_commands();

    CHECK(controller.current_mode_name() == std::string_view("dialogue"));
    CHECK(has_command(commands, ControllerCommandType::ModeChanged));
    CHECK(has_command(commands, ControllerCommandType::DialogueText));
}

TEST_CASE("RuntimeController enters cutscene mode from cutscene entity")
{
    GameSession session;
    REQUIRE(session.load(make_cutscene_project()).success);

    RuntimeController controller(session);
    session.queue_entity(eref(EntityType::Cutscene, "intro"));

    controller.tick(0.0);
    auto commands = controller.take_commands();

    CHECK(controller.current_mode_name() == std::string_view("cutscene"));
    CHECK(has_command(commands, ControllerCommandType::ModeChanged));
    CHECK(has_command(commands, ControllerCommandType::CutsceneText));
}

TEST_CASE("RuntimeController dialogue select option chains to next entity")
{
    GameSession session;
    REQUIRE(session.load(make_dialogue_project()).success);

    RuntimeController controller(session);
    session.queue_entity(eref(EntityType::Dialogue, "talk_greeter"));

    controller.tick(0.0);
    (void)controller.take_commands();
    CHECK(controller.current_mode_name() == std::string_view("dialogue"));

    controller.dialogue_select_option(0);
    auto commands = controller.take_commands();

    CHECK(has_command(commands, ControllerCommandType::DialogueComplete));
}

TEST_CASE("RuntimeController cutscene click advances and completes")
{
    GameSession session;
    REQUIRE(session.load(make_cutscene_project()).success);

    RuntimeController controller(session);
    session.queue_entity(eref(EntityType::Cutscene, "intro"));

    controller.tick(0.0);
    (void)controller.take_commands();
    CHECK(controller.current_mode_name() == std::string_view("cutscene"));

    // Click through: Text -> PageBreak -> Text -> PageBreak -> complete
    controller.cutscene_click();
    controller.tick(0.0);
    (void)controller.take_commands();

    controller.cutscene_click();
    auto commands = controller.take_commands();

    CHECK(has_command(commands, ControllerCommandType::CutsceneComplete));
}

TEST_CASE("RuntimeController save_state and restore_state preserve active dialogue")
{
    GameSession session;
    REQUIRE(session.load(make_dialogue_project()).success);

    RuntimeController controller(session);
    session.queue_entity(eref(EntityType::Dialogue, "talk_greeter"));
    controller.tick(0.0);
    (void)controller.take_commands();

    auto saved = controller.save_state();

    RuntimeController restored(session);
    restored.restore_state(saved);

    CHECK(restored.current_mode_name() == std::string_view("dialogue"));
    auto commands = restored.take_commands();
    CHECK(has_command(commands, ControllerCommandType::ModeChanged));
    CHECK(has_command(commands, ControllerCommandType::DialogueText));
}

TEST_CASE("RuntimeController save_state and restore_state preserve active cutscene")
{
    GameSession session;
    REQUIRE(session.load(make_cutscene_project()).success);

    RuntimeController controller(session);
    session.queue_entity(eref(EntityType::Cutscene, "intro"));
    controller.tick(0.0);
    (void)controller.take_commands();

    auto saved = controller.save_state();

    RuntimeController restored(session);
    restored.restore_state(saved);

    CHECK(restored.current_mode_name() == std::string_view("cutscene"));
    auto commands = restored.take_commands();
    CHECK(has_command(commands, ControllerCommandType::ModeChanged));
    CHECK(has_command(commands, ControllerCommandType::CutsceneText));
}
