#include <catch2/catch_test_macros.hpp>

#include <noveltea/assets/asset_manager.hpp>
#include <noveltea/core/editor_api.hpp>
#include <noveltea/core/project_ids.hpp>
#include <noveltea/core/runtime_session_host.hpp>
#include <noveltea/runtime_shell.hpp>
#include <noveltea/script/runtime_script_executor.hpp>
#include <noveltea/script/script_runtime.hpp>

#include <memory>
#include <string>
#include <string_view>
#include <vector>

using namespace noveltea;

namespace {

nlohmann::json props() { return nlohmann::json::object(); }

nlohmann::json ref(core::EntityType type, std::string id)
{
    return nlohmann::json::array({core::to_integer(type), std::move(id)});
}

core::ProjectDocument make_base_project(core::EntityType entry_type = core::EntityType::Room,
                                        std::string entry_id = "foyer")
{
    auto project = core::ProjectDocument::new_project();
    auto& root = project.root();
    root[core::project_ids::object] = nlohmann::json::object();
    root[core::project_ids::verb] = nlohmann::json::object();
    root[core::project_ids::action] = nlohmann::json::object();
    root[core::project_ids::room] = nlohmann::json::object({
        {"foyer",
         nlohmann::json::array({"foyer", "", props(), "A quiet foyer.", "", "", "", "",
                                nlohmann::json::array(), nlohmann::json::array(), "Foyer"})},
        {"kitchen",
         nlohmann::json::array({"kitchen", "", props(), "A bright kitchen.", "", "", "", "",
                                nlohmann::json::array(), nlohmann::json::array(), "Kitchen"})},
    });
    root[core::project_ids::map] = nlohmann::json::object();
    root[core::project_ids::dialogue] = nlohmann::json::object();
    root[core::project_ids::cutscene] = nlohmann::json::object();
    root[core::project_ids::script] = nlohmann::json::object();
    root[core::project_ids::entrypoint_entity] = ref(entry_type, std::move(entry_id));
    root[core::project_ids::starting_inventory] = nlohmann::json::array();
    root[core::project_ids::properties] = nlohmann::json::object();
    return project;
}

struct RuntimeScriptFixture {
    std::shared_ptr<assets::MemoryAssetSource> memory =
        std::make_shared<assets::MemoryAssetSource>();
    assets::AssetManager assets;
    script::ScriptRuntime scripts;
    core::RuntimeSessionHost host;
    core::MemorySaveSlotStore slots;
    script::RuntimeScriptExecutor executor;

    RuntimeScriptFixture()
    {
        assets.mount("project", memory);
        REQUIRE(scripts.initialize({&assets}));
    }

    ~RuntimeScriptFixture() { executor.shutdown(); }

    void load(core::ProjectDocument project)
    {
        host.set_save_slot_store(&slots);
        REQUIRE(host.load(std::move(project)).success);
        executor.initialize(&scripts, &host);
    }

    core::RuntimeInputResult tick(double delta_seconds = 0.0)
    {
        core::RuntimeInput input;
        input.type = core::RuntimeInputType::Tick;
        input.delta_seconds = delta_seconds;
        auto result = host.apply_input(input);
        executor.process(result);
        return result;
    }
};

struct ShellRuntimeScriptFixture {
    std::shared_ptr<assets::MemoryAssetSource> memory =
        std::make_shared<assets::MemoryAssetSource>();
    assets::AssetManager assets;
    script::ScriptRuntime scripts;
    RuntimeShell shell;
    script::RuntimeScriptExecutor executor;

    ShellRuntimeScriptFixture()
    {
        assets.mount("project", memory);
        REQUIRE(scripts.initialize({&assets}));
    }

    ~ShellRuntimeScriptFixture() { executor.shutdown(); }

    void load(core::ProjectDocument project)
    {
        REQUIRE(shell.load_project(std::move(project)).success);
        executor.initialize(&scripts, &shell.host());
        scripts.bind_runtime_command_dispatcher(&shell.dispatcher());
    }
};

bool has_output(const std::vector<core::RuntimeOutput>& outputs, core::RuntimeOutputType type)
{
    for (const auto& output : outputs) {
        if (output.type == type) {
            return true;
        }
    }
    return false;
}

std::vector<std::string> text_log_outputs(const std::vector<core::RuntimeOutput>& outputs)
{
    std::vector<std::string> result;
    for (const auto& output : outputs) {
        if (output.type == core::RuntimeOutputType::TextLogEntry) {
            result.push_back(output.payload.value("plain_text", std::string{}));
        }
    }
    return result;
}

} // namespace

TEST_CASE("RuntimeScriptExecutor executes script requests and mutates Game properties")
{
    auto project = make_base_project(core::EntityType::Script, "bootstrap");
    project.root()[core::project_ids::script] = nlohmann::json::object({
        {"bootstrap", nlohmann::json::array({"bootstrap", "", props(), false,
                                             "Game.set_prop('phase2_value', 'ok')"})},
    });

    RuntimeScriptFixture f;
    f.load(std::move(project));

    auto result = f.tick();

    CHECK(has_output(result.outputs, core::RuntimeOutputType::ScriptRequest));
    CHECK(has_output(result.outputs, core::RuntimeOutputType::ScriptResult));
    CHECK(f.host.session().property("phase2_value") == "ok");
}

TEST_CASE("RuntimeScriptExecutor lets a script entrypoint start a room through Game flow APIs")
{
    auto project = make_base_project(core::EntityType::Script, "bootstrap");
    project.root()[core::project_ids::script] = nlohmann::json::object({
        {"bootstrap",
         nlohmann::json::array({"bootstrap", "", props(), false, "Game.go_to_room('kitchen')"})},
    });

    ShellRuntimeScriptFixture f;
    f.load(std::move(project));

    auto result = f.shell.start_game();
    f.executor.process(result);

    CHECK(has_output(result.outputs, core::RuntimeOutputType::ScriptRequest));
    CHECK(has_output(result.outputs, core::RuntimeOutputType::ScriptResult));
    CHECK(f.shell.host().current_mode_name() == std::string_view("room"));
    CHECK(f.shell.host().view_state().title == "Kitchen");
}

TEST_CASE("RuntimeScriptExecutor runs dispatcher-requested Script entities")
{
    auto project = make_base_project();
    project.root()[core::project_ids::script] = nlohmann::json::object({
        {"bootstrap", nlohmann::json::array({"bootstrap", "", props(), false,
                                             "Game.set_prop('dispatcher_script', 'ran')"})},
    });

    RuntimeScriptFixture f;
    f.load(std::move(project));
    REQUIRE(f.tick().handled);

    auto result = f.host.run_script("bootstrap");
    f.executor.process(result);

    CHECK(result.handled);
    CHECK(has_output(result.outputs, core::RuntimeOutputType::ScriptRequest));
    CHECK(has_output(result.outputs, core::RuntimeOutputType::ScriptResult));
    CHECK(f.host.session().property("dispatcher_script") == "ran");
}

TEST_CASE("RuntimeScriptExecutor records Lua errors as runtime diagnostics")
{
    auto project = make_base_project(core::EntityType::Script, "bad");
    project.root()[core::project_ids::script] = nlohmann::json::object({
        {"bad", nlohmann::json::array({"bad", "", props(), false, "error('phase2 boom')"})},
    });

    RuntimeScriptFixture f;
    f.load(std::move(project));

    auto result = f.tick();

    REQUIRE(result.diagnostics.size() == 1);
    CHECK(result.diagnostics.front().severity == core::RuntimeDiagnosticSeverity::Error);
    CHECK(result.diagnostics.front().category == "lua");
    CHECK(result.diagnostics.front().message.find("phase2 boom") != std::string::npos);
    CHECK(result.diagnostics.front().lua_traceback.find("stack traceback") != std::string::npos);
    CHECK(has_output(result.outputs, core::RuntimeOutputType::Diagnostic));
}

TEST_CASE("RuntimeScriptExecutor surfaces script log and notification events")
{
    auto project = make_base_project(core::EntityType::Script, "bootstrap");
    project.root()[core::project_ids::script] = nlohmann::json::object({
        {"bootstrap",
         nlohmann::json::array({"bootstrap", "", props(), false,
                                "Log.push('from log'); toast('from toast', false, 25)"})},
    });

    RuntimeScriptFixture f;
    f.load(std::move(project));

    auto result = f.tick();

    CHECK(has_output(result.outputs, core::RuntimeOutputType::TextLogEntry));
    CHECK(has_output(result.outputs, core::RuntimeOutputType::Notification));
    auto logs = text_log_outputs(result.outputs);
    REQUIRE(logs.size() == 1);
    CHECK(logs.front() == "from log");
    REQUIRE(f.host.session().save() != nullptr);
    CHECK(f.host.session().save()->root()[core::project_ids::log].size() == 1);
}

TEST_CASE("RuntimeScriptExecutor executes room action hooks in command order")
{
    auto project = make_base_project();
    auto& root = project.root();
    root[core::project_ids::script_before_action] = "Log.push('before')";
    root[core::project_ids::script_after_action] = "Log.push('after')";
    root[core::project_ids::verb] = nlohmann::json::object({
        {"look",
         nlohmann::json::array({"look", "", props(), "Look", 0, "", "", nlohmann::json::array()})},
    });
    root[core::project_ids::action] = nlohmann::json::object({
        {"look_any", nlohmann::json::array({"look_any", "", props(), "look", "Log.push('action')",
                                            nlohmann::json::array(), false})},
    });

    RuntimeScriptFixture f;
    f.load(std::move(project));
    (void)f.tick();

    core::RuntimeInput input;
    input.type = core::RuntimeInputType::RunAction;
    input.verb_id = "look";
    auto result = f.host.apply_input(input);
    f.executor.process(result);

    CHECK(text_log_outputs(result.outputs) ==
          std::vector<std::string>{"before", "action", "after"});
    CHECK(f.slots.has_slot(core::SaveSlotId::autosave()));
}

TEST_CASE("RuntimeScriptExecutor lets timer callbacks mutate runtime state")
{
    auto project = make_base_project(core::EntityType::Script, "bootstrap");
    project.root()[core::project_ids::script] = nlohmann::json::object({
        {"bootstrap",
         nlohmann::json::array({"bootstrap", "", props(), false,
                                "Timer.start(10, function() Game.set_prop('timer_done', true); "
                                "Log.push('timer fired') end)"})},
    });

    RuntimeScriptFixture f;
    f.load(std::move(project));
    (void)f.tick();

    auto result = f.tick(0.010);

    CHECK(f.host.session().property("timer_done") == true);
    CHECK(text_log_outputs(result.outputs) == std::vector<std::string>{"timer fired"});
}

TEST_CASE("RuntimeScriptExecutor lets Lua save and autosave runtime slots")
{
    auto project = make_base_project(core::EntityType::Script, "bootstrap");
    project.root()[core::project_ids::script] = nlohmann::json::object({
        {"bootstrap", nlohmann::json::array({"bootstrap", "", props(), false,
                                             "Game.set_prop('slot_value', 'saved'); Game.save(4); "
                                             "Game.autosave()"})},
    });

    RuntimeScriptFixture f;
    f.load(std::move(project));

    (void)f.tick();

    REQUIRE(f.slots.has_slot(core::SaveSlotId{4}));
    REQUIRE(f.slots.has_slot(core::SaveSlotId::autosave()));
    auto saved = f.slots.read_slot(core::SaveSlotId{4});
    REQUIRE(saved.success);
    REQUIRE(saved.save.has_value());
    CHECK(saved.save->root()[core::project_ids::properties]["slot_value"] == "saved");
}

TEST_CASE("RuntimePlaybackSession executes Lua setup and check hooks through callback")
{
    auto project = make_base_project();

    core::editor::RuntimePlaybackSpec spec;
    spec.id = "lua-hooks";
    spec.init_script = "Game.set_prop('phase12_lua', 'ok')";
    spec.check_script = "if Game.prop('phase12_lua') ~= 'ok' then error('missing prop') end";

    core::editor::RuntimePlaybackStep step;
    step.input = core::editor::RuntimePlaybackInputType::Tick;
    step.assertions.push_back(core::editor::RuntimePlaybackAssertion{
        .type = core::editor::RuntimePlaybackAssertionType::PropertyEquals,
        .key = "phase12_lua",
        .expected = "ok",
    });
    spec.steps.push_back(std::move(step));

    auto memory = std::make_shared<assets::MemoryAssetSource>();
    assets::AssetManager assets;
    assets.mount("project", memory);
    script::ScriptRuntime scripts;
    REQUIRE(scripts.initialize({&assets}));

    core::editor::RuntimePlaybackSession playback;
    playback.set_hook_executor([&scripts](std::string_view source, std::string_view context,
                                          std::optional<std::uint64_t> step_index,
                                          core::RuntimeSessionHost& host) {
        scripts.bind_runtime_host(&host);
        auto executed = scripts.execute(source, context);
        core::editor::RuntimePlaybackHookResult result;
        if (!executed) {
            result.passed = false;
            core::RuntimeDiagnostic diagnostic;
            diagnostic.severity = core::RuntimeDiagnosticSeverity::Error;
            diagnostic.category = "lua";
            diagnostic.script_context = std::string(context);
            diagnostic.message = executed.error().message;
            diagnostic.lua_traceback = executed.error().traceback;
            diagnostic.playback_step_index = step_index;
            result.diagnostics.push_back(std::move(diagnostic));
        }
        return result;
    });

    auto report = playback.run(std::move(project), spec);
    CHECK(report.passed);
    CHECK(report.final_state.save_snapshot[core::project_ids::properties]["phase12_lua"] == "ok");
}

TEST_CASE("RuntimePlaybackSession fails on Lua hook errors")
{
    auto project = make_base_project();

    core::editor::RuntimePlaybackSpec spec;
    spec.id = "lua-error";
    spec.init_script = "error('phase12 hook boom')";
    spec.steps.push_back(core::editor::RuntimePlaybackStep{});

    auto memory = std::make_shared<assets::MemoryAssetSource>();
    assets::AssetManager assets;
    assets.mount("project", memory);
    script::ScriptRuntime scripts;
    REQUIRE(scripts.initialize({&assets}));

    core::editor::RuntimePlaybackSession playback;
    playback.set_hook_executor([&scripts](std::string_view source, std::string_view context,
                                          std::optional<std::uint64_t> step_index,
                                          core::RuntimeSessionHost& host) {
        scripts.bind_runtime_host(&host);
        auto executed = scripts.execute(source, context);
        core::editor::RuntimePlaybackHookResult result;
        if (!executed) {
            result.passed = false;
            core::RuntimeDiagnostic diagnostic;
            diagnostic.severity = core::RuntimeDiagnosticSeverity::Error;
            diagnostic.category = "lua";
            diagnostic.script_context = std::string(context);
            diagnostic.message = executed.error().message;
            diagnostic.lua_traceback = executed.error().traceback;
            diagnostic.playback_step_index = step_index;
            result.diagnostics.push_back(std::move(diagnostic));
        }
        return result;
    });

    auto report = playback.run(std::move(project), spec);
    CHECK_FALSE(report.passed);
    REQUIRE_FALSE(report.diagnostics.empty());
    CHECK(report.diagnostics.front().category == "lua");
    CHECK(report.diagnostics.front().message.find("phase12 hook boom") != std::string::npos);
}

TEST_CASE("RuntimeScriptExecutor lets Lua load a runtime slot")
{
    auto project = make_base_project(core::EntityType::Script, "bootstrap");
    project.root()[core::project_ids::script] = nlohmann::json::object({
        {"bootstrap",
         nlohmann::json::array({"bootstrap", "", props(), false,
                                "Game.set_prop('slot_value', 'saved'); Game.save(2); "
                                "Game.set_prop('slot_value', 'mutated'); Game.load(2)"})},
    });

    RuntimeScriptFixture f;
    f.load(std::move(project));

    (void)f.tick();

    CHECK(f.host.session().property("slot_value") == "saved");
}
