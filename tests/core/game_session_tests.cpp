#include <catch2/catch_test_macros.hpp>

#include <nlohmann/json.hpp>

#include <noveltea/core/game_session.hpp>
#include <noveltea/core/project_ids.hpp>

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

ProjectDocument make_session_project()
{
    auto project = ProjectDocument::new_project();
    auto& root = project.root();
    root[project_ids::object] = nlohmann::json::object();
    root[project_ids::verb] = nlohmann::json::object();
    root[project_ids::action] = nlohmann::json::object();
    root[project_ids::room] = nlohmann::json::object({
        {"foyer", nlohmann::json::array({"foyer", "", props(), "text='Foyer';", "", "", "", "",
                                         nlohmann::json::array(), nlohmann::json::array(), "Foyer"})},
    });
    root[project_ids::map] = nlohmann::json::object();
    root[project_ids::dialogue] = nlohmann::json::object();
    root[project_ids::cutscene] = nlohmann::json::object();
    root[project_ids::script] = nlohmann::json::object();
    root[project_ids::entrypoint_entity] = ref(EntityType::Room, "foyer");
    root[project_ids::starting_inventory] = nlohmann::json::array();
    return project;
}

bool has_diag(const std::vector<SessionDiagnostic>& diagnostics, SessionDiagnosticSeverity severity,
              std::string_view text)
{
    for (const auto& diagnostic : diagnostics) {
        if (diagnostic.severity == severity && diagnostic.message.find(text) != std::string::npos) {
            return true;
        }
    }
    return false;
}

} // namespace

TEST_CASE("GameSession loads typed project model and project startup entrypoint")
{
    GameSession session;
    auto result = session.load(make_session_project());

    REQUIRE(result.success);
    CHECK(session.loaded());
    REQUIRE(session.project() != nullptr);
    REQUIRE(session.save() != nullptr);
    REQUIRE(session.startup_entrypoint().has_value());
    CHECK(session.startup_entrypoint()->type == EntityType::Room);
    CHECK(session.startup_entrypoint()->id == "foyer");
    CHECK(session.play_time() == 0.0);
    CHECK(session.current_entity().has_value());
    CHECK(session.current_entity()->id == "foyer");
    CHECK(session.current_room_id() == std::optional<std::string>("foyer"));
    CHECK(session.navigation_enabled());
    CHECK(session.map_enabled());
    CHECK(has_diag(result.diagnostics, SessionDiagnosticSeverity::Info, "using project entrypoint"));
    CHECK(session.events().queued_count() == 1);
    const auto state = session.runtime_state();
    CHECK(state.current_room_id == std::optional<std::string>("foyer"));
    CHECK(state.queued_entity_count == 0);
}

TEST_CASE("GameSession prefers save startup entrypoint and play time")
{
    auto save = SaveDocument::new_save();
    save.root()[project_ids::entrypoint_entity] = ref(EntityType::Room, "foyer");
    save.root()[project_ids::play_time] = 12.5;

    GameSession session;
    const auto result = session.load(make_session_project(), save);

    REQUIRE(result.success);
    REQUIRE(session.startup_entrypoint().has_value());
    CHECK(session.startup_entrypoint()->id == "foyer");
    CHECK(session.play_time() == 12.5);
    CHECK(has_diag(result.diagnostics, SessionDiagnosticSeverity::Info, "using save entrypoint"));
}

TEST_CASE("GameSession restores save runtime flags and queued entities")
{
    auto save = SaveDocument::new_save();
    save.root()[project_ids::entrypoint_entity] = ref(EntityType::Room, "foyer");
    save.root()[project_ids::navigation_enabled] = false;
    save.root()[project_ids::map_enabled] = false;
    save.root()[project_ids::entity_queue] = nlohmann::json::array({
        ref(EntityType::Room, "foyer"),
    });

    GameSession session;
    const auto result = session.load(make_session_project(), save);

    REQUIRE(result.success);
    CHECK_FALSE(session.navigation_enabled());
    CHECK_FALSE(session.map_enabled());
    REQUIRE(session.current_entity().has_value());
    CHECK(session.current_entity()->id == "foyer");
    CHECK(session.entity_queue().size() == 1);

    auto commands = session.take_commands();
    CHECK(commands.size() >= 4);
    CHECK(commands.front().type == SessionCommandType::NavigationStateChanged);
    CHECK(session.take_commands().empty());

    const auto next = session.pop_next_entity();
    REQUIRE(next.has_value());
    CHECK(next->type == EntityType::Room);
    CHECK(next->id == "foyer");
    CHECK(session.entity_queue().empty());
    CHECK(session.current_room_id() == std::optional<std::string>("foyer"));
}

TEST_CASE("GameSession ignores stale saved map and queued entity metadata with warnings")
{
    auto save = SaveDocument::new_save();
    save.root()[project_ids::save_map] = "missing-map";
    save.root()[project_ids::entity_queue] = nlohmann::json::array({
        ref(EntityType::Room, "missing-room"),
        nlohmann::json::array({"bad"}),
        ref(EntityType::Room, "foyer"),
    });

    GameSession session;
    const auto result = session.load(make_session_project(), save);

    REQUIRE(result.success);
    CHECK_FALSE(session.current_map_id().has_value());
    REQUIRE(session.entity_queue().size() == 1);
    CHECK(session.entity_queue().front().id == "foyer");
    CHECK(has_diag(result.diagnostics, SessionDiagnosticSeverity::Warning, "saved current map 'missing-map'"));
    CHECK(has_diag(result.diagnostics, SessionDiagnosticSeverity::Warning, "does not exist in project"));
    CHECK(has_diag(result.diagnostics, SessionDiagnosticSeverity::Warning, "expected selected-entity array"));
}

TEST_CASE("GameSession reports validation diagnostics and refuses invalid project")
{
    auto project = make_session_project();
    project.root()[project_ids::entrypoint_entity] = ref(EntityType::Room, "missing");

    GameSession session;
    const auto result = session.load(project);

    CHECK_FALSE(result.success);
    CHECK_FALSE(session.loaded());
    CHECK(has_diag(result.diagnostics, SessionDiagnosticSeverity::Error, "missing room entity 'missing'"));
}

TEST_CASE("GameSession reports save diagnostics and refuses invalid save")
{
    auto save = SaveDocument::new_save();
    save.root()[project_ids::play_time] = "later";

    GameSession session;
    const auto result = session.load(make_session_project(), save);

    CHECK_FALSE(result.success);
    CHECK_FALSE(session.loaded());
    CHECK(has_diag(result.diagnostics, SessionDiagnosticSeverity::Error, "expected number"));
}

TEST_CASE("GameSession tick advances play time, timers, and queued events")
{
    GameSession session;
    REQUIRE(session.load(make_session_project()).success);
    int loaded_events = 0;
    int timer_events = 0;
    const auto loaded_listener = session.events().listen(RuntimeEventType::GameLoaded, [&](const RuntimeEvent& event) {
        CHECK(event.text == "foyer");
        ++loaded_events;
        return true;
    });
    const auto timer_listener = session.events().listen(RuntimeEventType::TimerCompleted, [&](const RuntimeEvent&) {
        ++timer_events;
        return true;
    });
    CHECK(loaded_listener != timer_listener);
    const auto timer = session.timers().start(0.5);
    CHECK(timer.id != 0);

    session.tick(0.25);
    CHECK(session.play_time() == 0.25);
    CHECK(loaded_events == 1);
    CHECK(timer_events == 0);

    session.tick(0.25);
    CHECK(session.play_time() == 0.5);
    CHECK(loaded_events == 1);
    CHECK(timer_events == 1);
}

TEST_CASE("GameSession reset clears loaded state and runtime services")
{
    GameSession session;
    REQUIRE(session.load(make_session_project()).success);
    const auto timer = session.timers().start_repeat(1.0);
    CHECK(timer.id != 0);

    session.reset();

    CHECK_FALSE(session.loaded());
    CHECK(session.project() == nullptr);
    CHECK(session.save() == nullptr);
    CHECK_FALSE(session.startup_entrypoint().has_value());
    CHECK(session.play_time() == 0.0);
    CHECK(session.events().queued_count() == 0);
    CHECK(session.timers().active_count() == 0);
}
