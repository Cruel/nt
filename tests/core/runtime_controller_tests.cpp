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
