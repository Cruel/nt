#include <catch2/catch_test_macros.hpp>

#include "noveltea/assets/asset_manager.hpp"
#include "noveltea/assets/asset_source.hpp"
#include "noveltea/audio/audio_system.hpp"
#include "noveltea/core/compiled_project_codec.hpp"
#include "noveltea/core/flow_executor.hpp"
#include "noveltea/core/runtime_session_host.hpp"
#include "noveltea/core/session_state.hpp"
#include "noveltea/script/script_invoker.hpp"
#include "noveltea/script/script_runtime.hpp"
#include "script/lua/script_runtime_internal.hpp"

#include <lua.hpp>
#include <nlohmann/json.hpp>
#include <sol/sol.hpp>

#include <fstream>
#include <memory>
#include <string>
#include <type_traits>
#include <vector>

using namespace noveltea;

namespace {

assets::AssetBytes bytes(std::string text) { return assets::AssetBytes(text.begin(), text.end()); }

core::CompiledProject load_script_project()
{
    std::ifstream input(
        std::string(NOVELTEA_SOURCE_DIR) +
        "/editor/src/renderer/test/fixtures/compiled-project-golden/scene-program.json");
    REQUIRE(input.good());
    const std::string source((std::istreambuf_iterator<char>(input)),
                             std::istreambuf_iterator<char>());
    auto document = nlohmann::json::parse(source, nullptr, false);
    REQUIRE_FALSE(document.is_discarded());
    auto decoded = core::decode_compiled_project(document, "scene-program.json");
    REQUIRE(decoded);
    return std::move(decoded).value();
}

struct RuntimeFixture {
    std::shared_ptr<assets::MemoryAssetSource> memory =
        std::make_shared<assets::MemoryAssetSource>();
    assets::AssetManager assets;
    script::ScriptRuntime runtime;

    RuntimeFixture() { assets.mount("project", memory); }
};

struct FakeAudioEvent {
    AudioClipHandle clip;
    AudioPlaybackDesc desc;
};

class FakeAudioBackend final : public AudioBackend {
public:
    AudioBackendInfo backend_info() const override { return {"fake", initialized}; }
    bool initialize(const assets::AssetManager&) override
    {
        initialized = true;
        return true;
    }
    void shutdown() override { initialized = false; }

    assets::AssetResult<assets::AudioAsset>
    load_audio(const assets::AudioAssetRequest& request) override
    {
        last_request = request;
        return {assets::AudioAsset{.clip = AudioClipHandle{next_clip++},
                                   .path = request.path,
                                   .mode = request.mode,
                                   .kind = request.kind},
                {}};
    }

    AudioVoiceHandle play(AudioClipHandle clip, const AudioPlaybackDesc& desc) override
    {
        played.push_back(FakeAudioEvent{clip, desc});
        return AudioVoiceHandle{next_voice++};
    }
    void stop(AudioVoiceHandle voice) override { stopped.push_back(voice); }
    void set_volume(AudioVoiceHandle, float) override {}
    void set_bus_volume(AudioBus bus, float volume) override
    {
        last_bus = bus;
        last_bus_volume = volume;
    }
    void pause() override { ++pause_count; }
    void resume() override { ++resume_count; }
    bool voice_active(AudioVoiceHandle voice) const override { return static_cast<bool>(voice); }
    AudioBackendStats stats() const override { return {}; }
    void collect_finished_voices() override {}

    bool initialized = false;
    uint32_t next_clip = 1;
    uint32_t next_voice = 1;
    std::optional<assets::AudioAssetRequest> last_request;
    std::vector<FakeAudioEvent> played;
    std::vector<AudioVoiceHandle> stopped;
    AudioBus last_bus = AudioBus::Master;
    float last_bus_volume = 1.0f;
    uint32_t pause_count = 0;
    uint32_t resume_count = 0;
};

} // namespace

TEST_CASE("ScriptRuntime initializes with pinned Lua and sol2 versions")
{
    RuntimeFixture fixture;
    auto initialized = fixture.runtime.initialize({&fixture.assets});
    REQUIRE(initialized);
    CHECK(fixture.runtime.is_initialized());
    CHECK(LUA_VERSION_NUM == 505);
    CHECK(std::string(LUA_VERSION) == "Lua 5.5");
    CHECK(SOL_VERSION_MAJOR == 3);
    CHECK(SOL_VERSION_MINOR == 5);
    CHECK(SOL_VERSION_PATCH == 0);
}

TEST_CASE("ScriptRuntime keeps persistent global state across executions")
{
    RuntimeFixture fixture;
    REQUIRE(fixture.runtime.initialize({&fixture.assets}));
    REQUIRE(fixture.runtime.execute("count = 1", "first"));
    REQUIRE(fixture.runtime.execute("count = count + 1", "second"));
    auto result = fixture.runtime.evaluate("count", "count");
    REQUIRE(result);
    REQUIRE(std::holds_alternative<std::int64_t>(result.value()));
    CHECK(std::get<std::int64_t>(result.value()) == 2);
}

TEST_CASE("ScriptRuntime evaluates typed basic values")
{
    RuntimeFixture fixture;
    REQUIRE(fixture.runtime.initialize({&fixture.assets}));

    auto boolean = fixture.runtime.evaluate_bool("3 < 4", "bool");
    REQUIRE(boolean);
    CHECK(boolean.value());

    auto string = fixture.runtime.evaluate_string("'Novel' .. 'Tea'", "string");
    REQUIRE(string);
    CHECK(string.value() == "NovelTea");

    auto integer = fixture.runtime.evaluate("42", "integer");
    REQUIRE(integer);
    CHECK(std::holds_alternative<std::int64_t>(integer.value()));
    CHECK(std::get<std::int64_t>(integer.value()) == 42);

    auto whole_float = fixture.runtime.evaluate("42.0", "whole_float");
    REQUIRE(whole_float);
    CHECK(std::holds_alternative<double>(whole_float.value()));
    CHECK(std::get<double>(whole_float.value()) == 42.0);

    auto floating = fixture.runtime.evaluate("42.5", "float");
    REQUIRE(floating);
    CHECK(std::holds_alternative<double>(floating.value()));
    CHECK(std::get<double>(floating.value()) == 42.5);

    auto nil = fixture.runtime.evaluate("nil", "nil");
    REQUIRE(nil);
    CHECK(std::holds_alternative<std::monostate>(nil.value()));
}

TEST_CASE("ScriptRuntime has an explicit expression return policy")
{
    RuntimeFixture fixture;
    REQUIRE(fixture.runtime.initialize({&fixture.assets}));

    auto no_return = fixture.runtime.evaluate("print('no-return')", "no_return");
    REQUIRE(no_return);
    CHECK(std::holds_alternative<std::monostate>(no_return.value()));

    auto multiple = fixture.runtime.evaluate("1, 2", "multiple");
    REQUIRE_FALSE(multiple);
    CHECK(multiple.error().message.find("multiple values") != std::string::npos);

    for (const auto* expression : {"{}", "function() end", "coroutine.create(function() end)"}) {
        auto result = fixture.runtime.evaluate(expression, expression);
        REQUIRE_FALSE(result);
        CHECK(result.error().message.find("unsupported Lua result type") != std::string::npos);
    }

    lua_State* state = script::detail::ScriptRuntimeAccess::state(fixture.runtime);
    REQUIRE(state != nullptr);
    lua_pushlightuserdata(state, &fixture);
    lua_setglobal(state, "test_userdata");
    auto userdata = fixture.runtime.evaluate("test_userdata", "userdata");
    REQUIRE_FALSE(userdata);
    CHECK(userdata.error().message.find("userdata") != std::string::npos);
}

TEST_CASE("ScriptRuntime reports syntax errors and nested runtime tracebacks")
{
    RuntimeFixture fixture;
    REQUIRE(fixture.runtime.initialize({&fixture.assets}));

    auto syntax = fixture.runtime.execute("function bad(", "bad_syntax");
    REQUIRE_FALSE(syntax);
    CHECK(syntax.error().code == script::ScriptErrorCode::LoadFailed);
    CHECK(syntax.error().chunk.find("bad_syntax") != std::string::npos);
    CHECK_FALSE(syntax.error().message.empty());
    CHECK_FALSE(syntax.error().traceback.empty());

    auto runtime = fixture.runtime.execute("error('boom')", "bad_runtime");
    REQUIRE_FALSE(runtime);
    CHECK(runtime.error().code == script::ScriptErrorCode::RuntimeFailed);
    CHECK(runtime.error().message.find("boom") != std::string::npos);
    CHECK(runtime.error().traceback.find("boom") != std::string::npos);
    CHECK(runtime.error().traceback.find("stack traceback") != std::string::npos);

    auto nested = fixture.runtime.execute(R"(
        local function deepest()
            error("boom")
        end
        local function middle()
            deepest()
        end
        middle()
    )",
                                          "nested_runtime");
    REQUIRE_FALSE(nested);
    CHECK(nested.error().message.find("boom") != std::string::npos);
    CHECK(nested.error().chunk.find("nested_runtime") != std::string::npos);
    CHECK(nested.error().traceback.find("boom") != std::string::npos);
    CHECK(nested.error().traceback.find("nested_runtime") != std::string::npos);
    CHECK(nested.error().traceback.find("deepest") != std::string::npos);
    CHECK(nested.error().traceback.find("middle") != std::string::npos);
    CHECK(nested.error().traceback != nested.error().message);
}

TEST_CASE("ScriptRuntime handles coroutine yield and resume through Lua status codes")
{
    RuntimeFixture fixture;
    REQUIRE(fixture.runtime.initialize({&fixture.assets}));

    auto result = fixture.runtime.execute(R"(
        local co = coroutine.create(function()
            local resumed = coroutine.yield("paused")
            return resumed
        end)
        local ok1, first = coroutine.resume(co)
        assert(ok1 and first == "paused")
        local ok2, second = coroutine.resume(co, "finished")
        assert(ok2 and second == "finished")
        assert(coroutine.status(co) == "dead")
    )",
                                          "coroutine_status");
    REQUIRE(result);
}

TEST_CASE("ScriptRuntime rejects yields from every immediate invocation form")
{
    RuntimeFixture fixture;
    REQUIRE(fixture.runtime.initialize({&fixture.assets}));
    auto project = load_script_project();
    auto state_result = core::SessionState::create(project);
    REQUIRE(state_result);
    auto state = std::move(state_result).value();
    core::FlowExecutor executor(project, state);
    script::ScriptInvoker invoker(fixture.runtime, executor);

    REQUIRE(invoker.run_startup(core::compiled::StartupHook{"startup_ran = true"}));
    auto startup_value = fixture.runtime.evaluate_bool("startup_ran", "startup-value");
    REQUIRE(startup_value);
    CHECK(startup_value.value());
    auto immediate_condition = invoker.evaluate(core::LuaPredicate{"2 + 2 == 4"});
    REQUIRE(immediate_condition);
    CHECK(immediate_condition.value());
    auto immediate_text = invoker.resolve(core::LuaTextExpression{"'typed text'"});
    REQUIRE(immediate_text);
    CHECK(immediate_text.value() == "typed text");

    auto startup = invoker.run_startup(core::compiled::StartupHook{"coroutine.yield()"});
    REQUIRE_FALSE(startup);
    CHECK(startup.error().code == script::ScriptErrorCode::YieldForbidden);

    auto condition = invoker.evaluate(core::LuaPredicate{"coroutine.yield()"});
    REQUIRE_FALSE(condition);
    CHECK(condition.error().code == script::ScriptErrorCode::YieldForbidden);

    auto text = invoker.resolve(core::LuaTextExpression{"coroutine.yield()"});
    REQUIRE_FALSE(text);
    CHECK(text.error().code == script::ScriptErrorCode::YieldForbidden);
}

TEST_CASE("ScriptInvoker suspends and resumes only its exact flow frame and invocation")
{
    static_assert(
        !std::is_convertible_v<core::PresentationFlowBlockerHandle, core::ScriptInvocationHandle>);

    RuntimeFixture fixture;
    REQUIRE(fixture.runtime.initialize({&fixture.assets}));
    auto project = load_script_project();
    auto state_result = core::SessionState::create(project);
    REQUIRE(state_result);
    auto state = std::move(state_result).value();
    core::FlowExecutor executor(project, state);
    script::ScriptInvoker invoker(fixture.runtime, executor);

    auto started = invoker.invoke(
        core::RunLuaEffect{"coroutine.yield(); invocation_completed = true"}, "effect-suspension");
    REQUIRE(started);
    const auto* suspended = std::get_if<script::ScriptInvocationSuspended>(&started.value());
    REQUIRE(suspended != nullptr);
    REQUIRE(state.blocker());
    CHECK(std::holds_alternative<core::ScriptFlowBlocker>(*state.blocker()));
    CHECK(core::flow_blocker_owner(*state.blocker()) == suspended->owner);
    CHECK(core::flow_blocker_handle(*state.blocker()) ==
          core::AnyFlowBlockerHandle{suspended->invocation});

    auto resumed = invoker.resume(suspended->owner, suspended->invocation);
    REQUIRE(resumed);
    CHECK(std::holds_alternative<script::ScriptInvocationCompleted>(resumed.value()));
    CHECK_FALSE(state.blocker());
    auto completed = fixture.runtime.evaluate_bool("invocation_completed", "completed");
    REQUIRE(completed);
    CHECK(completed.value());

    auto duplicate = invoker.resume(suspended->owner, suspended->invocation);
    REQUIRE_FALSE(duplicate);
    CHECK(duplicate.error().code == script::ScriptErrorCode::StaleInvocation);
}

TEST_CASE("ScriptInvoker validates frame ownership and supports exact cancellation")
{
    RuntimeFixture fixture;
    REQUIRE(fixture.runtime.initialize({&fixture.assets}));
    auto project = load_script_project();
    auto state_result = core::SessionState::create(project);
    REQUIRE(state_result);
    auto state = std::move(state_result).value();
    core::FlowExecutor executor(project, state);
    script::ScriptInvoker invoker(fixture.runtime, executor);

    auto first =
        invoker.invoke("coroutine.yield(); cancelled_continued = true", "cancelled-effect");
    REQUIRE(first);
    const auto cancelled = std::get<script::ScriptInvocationSuspended>(first.value());
    REQUIRE(invoker.cancel(cancelled.owner, cancelled.invocation));
    CHECK_FALSE(state.blocker());
    auto did_not_continue =
        fixture.runtime.evaluate_bool("cancelled_continued == nil", "cancel-check");
    REQUIRE(did_not_continue);
    CHECK(did_not_continue.value());
    auto duplicate_cancel = invoker.cancel(cancelled.owner, cancelled.invocation);
    REQUIRE_FALSE(duplicate_cancel);
    CHECK(duplicate_cancel.error().code == script::ScriptErrorCode::StaleInvocation);

    auto target = core::SceneId::create("opening");
    REQUIRE(target);
    REQUIRE(executor.apply_target(target.value()));
    auto second = invoker.invoke("coroutine.yield(); owner_checked = true", "owned-effect");
    REQUIRE(second);
    const auto active = std::get<script::ScriptInvocationSuspended>(second.value());
    CHECK(active.owner != cancelled.owner);

    auto wrong_owner = invoker.resume(cancelled.owner, active.invocation);
    REQUIRE_FALSE(wrong_owner);
    CHECK(wrong_owner.error().code == script::ScriptErrorCode::StaleInvocation);
    REQUIRE(state.blocker());

    auto exact = invoker.resume(active.owner, active.invocation);
    REQUIRE(exact);
    CHECK(std::holds_alternative<script::ScriptInvocationCompleted>(exact.value()));
    CHECK_FALSE(state.blocker());
}

TEST_CASE("ScriptInvoker propagates nested failures after suspension")
{
    RuntimeFixture fixture;
    REQUIRE(fixture.runtime.initialize({&fixture.assets}));
    auto project = load_script_project();
    auto state_result = core::SessionState::create(project);
    REQUIRE(state_result);
    auto state = std::move(state_result).value();
    core::FlowExecutor executor(project, state);
    script::ScriptInvoker invoker(fixture.runtime, executor);

    auto started = invoker.invoke(R"(
        local function nested_failure()
            error("nested resume boom")
        end
        coroutine.yield()
        nested_failure()
    )",
                                  "nested-effect");
    REQUIRE(started);
    const auto suspended = std::get<script::ScriptInvocationSuspended>(started.value());
    auto resumed = invoker.resume(suspended.owner, suspended.invocation);
    REQUIRE_FALSE(resumed);
    CHECK(resumed.error().code == script::ScriptErrorCode::RuntimeFailed);
    CHECK(resumed.error().message.find("nested resume boom") != std::string::npos);
    CHECK(resumed.error().traceback.find("nested_failure") != std::string::npos);
    CHECK_FALSE(state.blocker());
}

TEST_CASE("ScriptRuntime does not expose unsafe standard libraries by default")
{
    RuntimeFixture fixture;
    REQUIRE(fixture.runtime.initialize({&fixture.assets}));
    for (const auto* name : {"os", "io", "debug", "package", "require", "dofile", "loadfile"}) {
        auto result = fixture.runtime.evaluate_bool(std::string(name) + " == nil", name);
        REQUIRE(result);
        CHECK(result.value());
    }
    auto load_available = fixture.runtime.evaluate_bool("load ~= nil", "load");
    REQUIRE(load_available);
    CHECK(load_available.value());
}

TEST_CASE("ScriptRuntime initialization failure leaves runtime clean")
{
    script::ScriptRuntime runtime;
    auto initialized = runtime.initialize({});
    REQUIRE_FALSE(initialized);
    CHECK_FALSE(runtime.is_initialized());
    runtime.shutdown();
    CHECK_FALSE(runtime.is_initialized());
}

TEST_CASE(
    "ScriptRuntime converts bound callback argument failures into diagnostics and stays usable")
{
    RuntimeFixture fixture;
    REQUIRE(fixture.runtime.initialize({&fixture.assets}));
    fixture.runtime.bind_game_session(nullptr);

    auto failed = fixture.runtime.execute("toast({})", "callback_argument_error");
    REQUIRE_FALSE(failed);
    CHECK(failed.error().message.find("string") != std::string::npos);
    CHECK(failed.error().traceback.find("stack traceback") != std::string::npos);

    auto still_usable = fixture.runtime.evaluate_string("'still' .. '-ok'", "after_failure");
    REQUIRE(still_usable);
    CHECK(still_usable.value() == "still-ok");
}

TEST_CASE("ScriptRuntime exposes audio playback bindings")
{
    RuntimeFixture fixture;
    auto backend = std::make_unique<FakeAudioBackend>();
    auto* backend_ptr = backend.get();
    AudioSystem audio(std::move(backend));
    assets::ResourceAliasRegistry aliases;
    aliases.register_audio("ui.notification",
                           assets::AudioAssetRequest{.path = "project:/audio/notification.mp3",
                                                     .mode = AudioLoadMode::Decode,
                                                     .kind = AudioClipKind::Sfx});
    fixture.assets.configure_resource_aliases(std::move(aliases));
    REQUIRE(audio.initialize(fixture.assets));
    fixture.assets.bind_audio_loader(&audio);
    REQUIRE(fixture.runtime.initialize({&fixture.assets, &audio}));

    REQUIRE(fixture.runtime.execute(R"(
        sfx_ok = audio.play_sfx_alias("ui.notification", {
            volume = 0.75,
            pitch = 1.35,
            max_simultaneous = 2,
        })
        audio.set_bus_volume("music", 0.25)
        audio.pause()
        paused_after_pause = audio.paused()
        audio.resume()
        paused_after_resume = audio.paused()
    )",
                                    "audio_bindings"));

    auto ok = fixture.runtime.evaluate_bool("sfx_ok", "sfx_ok");
    REQUIRE(ok);
    CHECK(ok.value());
    REQUIRE(backend_ptr->last_request);
    CHECK(backend_ptr->last_request->path == "project:/audio/notification.mp3");
    CHECK(backend_ptr->last_request->kind == AudioClipKind::Sfx);
    REQUIRE(backend_ptr->played.size() == 1);
    CHECK(backend_ptr->played[0].desc.bus == AudioBus::Sfx);
    CHECK(backend_ptr->played[0].desc.volume == 0.75f);
    CHECK(backend_ptr->played[0].desc.pitch == 1.35f);
    CHECK_FALSE(backend_ptr->played[0].desc.loop);
    CHECK(backend_ptr->last_bus == AudioBus::Music);
    CHECK(backend_ptr->last_bus_volume == 0.25f);
    CHECK(backend_ptr->pause_count == 1);
    CHECK(backend_ptr->resume_count == 1);
    auto paused_after_pause =
        fixture.runtime.evaluate_bool("paused_after_pause", "paused_after_pause");
    REQUIRE(paused_after_pause);
    CHECK(paused_after_pause.value());
    auto paused_after_resume =
        fixture.runtime.evaluate_bool("paused_after_resume", "paused_after_resume");
    REQUIRE(paused_after_resume);
    CHECK_FALSE(paused_after_resume.value());
}

TEST_CASE("ScriptRuntime queues runtime audio commands")
{
    RuntimeFixture fixture;
    auto backend = std::make_unique<FakeAudioBackend>();
    AudioSystem audio(std::move(backend));
    REQUIRE(audio.initialize(fixture.assets));
    core::RuntimeSessionHost host;
    REQUIRE(fixture.runtime.initialize({&fixture.assets, &audio}));
    fixture.runtime.bind_runtime_host(&host);

    REQUIRE(fixture.runtime.execute(R"(
        queued_sfx = audio.queue_sfx_alias("ui.notification", { volume = 0.4, pitch = 1.2 })
        queued_track = audio.queue_track_alias("bgm", "music.cello_loop", { fade_in = 0.5 })
        queued_stop = audio.queue_stop_track("bgm", { fade = 0.25 })
    )",
                                    "audio_queue"));

    auto sfx = fixture.runtime.evaluate_bool("queued_sfx", "queued_sfx");
    auto track = fixture.runtime.evaluate_bool("queued_track", "queued_track");
    auto stop = fixture.runtime.evaluate_bool("queued_stop", "queued_stop");
    REQUIRE(sfx);
    REQUIRE(track);
    REQUIRE(stop);
    CHECK(sfx.value());
    CHECK(track.value());
    CHECK(stop.value());

    auto flushed = host.flush_pending_outputs();
    REQUIRE(flushed.outputs.size() == 3);
    CHECK(flushed.outputs[0].type == core::RuntimeOutputType::AudioCommand);
    CHECK(flushed.outputs[0].payload.value("op", "") == "play_sfx_alias");
    CHECK(flushed.outputs[0].payload.value("alias", "") == "ui.notification");
    const double queued_pitch = flushed.outputs[0].payload["options"].value("pitch", 0.0);
    CHECK(queued_pitch > 1.19);
    CHECK(queued_pitch < 1.21);
    CHECK(flushed.outputs[1].payload.value("op", "") == "play_track_alias");
    CHECK(flushed.outputs[1].payload.value("track_id", "") == "bgm");
    CHECK(flushed.outputs[1].payload.value("alias", "") == "music.cello_loop");
    CHECK(flushed.outputs[2].payload.value("op", "") == "stop_track");
    CHECK(flushed.outputs[2].payload.value("fade", 0.0) == 0.25);
}

TEST_CASE("ScriptRuntime executes scripts through AssetManager logical paths")
{
    RuntimeFixture fixture;
    fixture.memory->add("project:/scripts/example.lua",
                        bytes("asset_value = noveltea.echo('asset-ok')"));
    REQUIRE(fixture.runtime.initialize({&fixture.assets}));
    auto executed = fixture.runtime.execute_asset("project:/scripts/example.lua");
    REQUIRE(executed);
    auto value = fixture.runtime.evaluate_string("asset_value", "asset_value");
    REQUIRE(value);
    CHECK(value.value() == "asset-ok");
}

TEST_CASE("ScriptRuntime supports shared_ptr-backed sol2 usertypes for future bindings")
{
    struct TestObject {
        explicit TestObject(std::string label) : label(std::move(label)) {}
        std::string label;
        int calls = 0;
        std::string ping()
        {
            ++calls;
            return label + ":" + std::to_string(calls);
        }
    };

    RuntimeFixture fixture;
    REQUIRE(fixture.runtime.initialize({&fixture.assets}));
    sol::state_view lua(script::detail::ScriptRuntimeAccess::state(fixture.runtime));
    lua.new_usertype<TestObject>(
        "TestObject", sol::no_constructor, "ping", &TestObject::ping, "calls",
        sol::property([](const TestObject& object) { return object.calls; }));

    auto object = std::make_shared<TestObject>("kept");
    std::weak_ptr<TestObject> weak = object;
    lua["test_object"] = object;
    object.reset();

    REQUIRE(fixture.runtime.execute("stored_object = test_object\nobserved = stored_object:ping()",
                                    "shared_ptr"));
    CHECK_FALSE(weak.expired());
    auto observed = fixture.runtime.evaluate_string("observed", "observed");
    REQUIRE(observed);
    CHECK(observed.value() == "kept:1");
    auto calls = fixture.runtime.evaluate("stored_object.calls", "calls");
    REQUIRE(calls);
    CHECK(std::get<std::int64_t>(calls.value()) == 1);

    REQUIRE(fixture.runtime.execute("test_object = nil\nstored_object = nil", "release"));
    fixture.runtime.collect_garbage();
    CHECK(weak.expired());
}

TEST_CASE("ScriptRuntime shutdown is idempotent and supports reinitialization")
{
    RuntimeFixture fixture;
    REQUIRE(fixture.runtime.initialize({&fixture.assets}));
    fixture.runtime.shutdown();
    fixture.runtime.shutdown();
    CHECK_FALSE(fixture.runtime.is_initialized());
    REQUIRE(fixture.runtime.initialize({&fixture.assets}));
    CHECK(fixture.runtime.is_initialized());
}
