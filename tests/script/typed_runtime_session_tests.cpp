#include <catch2/catch_test_macros.hpp>

#include "noveltea/assets/asset_manager.hpp"
#include "noveltea/assets/asset_source.hpp"
#include "noveltea/core/compiled_project_codec.hpp"
#include "noveltea/script/script_runtime.hpp"
#include "noveltea/script/typed_runtime_session.hpp"

#include <fstream>
#include <algorithm>
#include <iterator>
#include <memory>
#include <string>
#include <type_traits>

#include <nlohmann/json.hpp>

namespace noveltea::script::test {
namespace {

core::CompiledProject load_project(std::string_view filename)
{
    const std::string path = std::string(NOVELTEA_SOURCE_DIR) +
                             "/editor/src/renderer/test/fixtures/compiled-project-golden/" +
                             std::string(filename);
    std::ifstream input(path);
    REQUIRE(input.good());
    const std::string source((std::istreambuf_iterator<char>(input)),
                             std::istreambuf_iterator<char>());
    const auto document = nlohmann::json::parse(source, nullptr, false);
    REQUIRE_FALSE(document.is_discarded());
    auto decoded = core::decode_compiled_project(document, path);
    REQUIRE(decoded);
    return std::move(decoded).value();
}

template<class T> core::StrongId<T> make_id(std::string value)
{
    auto id = core::StrongId<T>::create(std::move(value));
    REQUIRE(id);
    return std::move(id).value();
}

bool has_output_kind(const TypedRuntimeSessionResult& result, core::RuntimeOutputKind kind)
{
    return std::any_of(result.outputs.begin(), result.outputs.end(),
                       [&](const auto& output) { return core::output_kind(output) == kind; });
}

struct Fixture {
    core::CompiledProject project;
    std::shared_ptr<assets::MemoryAssetSource> source =
        std::make_shared<assets::MemoryAssetSource>();
    assets::AssetManager assets;
    ScriptRuntime runtime;
    core::TypedMemorySaveSlotStore saves;
    std::unique_ptr<TypedRuntimeSession> session;

    explicit Fixture(std::string_view filename = "comprehensive.json")
        : project(load_project(filename))
    {
        assets.mount("project", source);
        REQUIRE(runtime.initialize({&assets}));
        REQUIRE(runtime.execute("function initialize_fixture() end\n"
                                "function after_enter_start() end\n"
                                "function before_leave_start() end\n"
                                "function can_leave_start() return true end\n"
                                "function can_unlock() return true end\n"
                                "function combine_items() end\n"
                                "function hall_description() return 'Hall' end\n"
                                "function key_label() return 'Key' end\n"
                                "function tower_open() return true end\n",
                                "typed-session-fixture"));
        auto created = TypedRuntimeSession::create(project, runtime, saves, "en");
        REQUIRE(created);
        session = std::move(created).value();
    }
};

} // namespace

TEST_CASE(
    "typed runtime session dispatches lifecycle debug mutation and save load without legacy IO")
{
    STATIC_REQUIRE(std::variant_size_v<core::RuntimeInputMessage> == 26);
    STATIC_REQUIRE(std::variant_size_v<core::RuntimeOutputMessage> == 8);
    Fixture fixture;
    auto started = fixture.session->apply(core::RuntimeInputMessage{core::StopRuntimeInput{}});
    CHECK(started.disposition == RuntimeInputDisposition::Handled);
    CHECK(has_output_kind(started, core::RuntimeOutputKind::ViewPublication));

    const auto count = make_id<core::VariableIdTag>("count");
    auto changed = fixture.session->apply(
        core::RuntimeInputMessage{core::SetVariableDebugInput{count, std::int64_t{7}}});
    CHECK(changed.disposition == RuntimeInputDisposition::Handled);
    REQUIRE(fixture.session->script_variable(count));
    CHECK(fixture.session->script_variable(count).value() == core::RuntimeValue{std::int64_t{7}});

    const auto slot = core::TypedSaveSlotId::manual(4);
    auto saved = fixture.session->apply(core::RuntimeInputMessage{core::SaveRuntimeInput{slot}});
    CHECK(has_output_kind(saved, core::RuntimeOutputKind::SaveOutcome));
    (void)fixture.session->apply(
        core::RuntimeInputMessage{core::SetVariableDebugInput{count, std::int64_t{9}}});
    auto loaded = fixture.session->apply(core::RuntimeInputMessage{core::LoadRuntimeInput{slot}});
    CHECK(has_output_kind(loaded, core::RuntimeOutputKind::SaveOutcome));
    REQUIRE(fixture.session->script_variable(count));
    CHECK(fixture.session->script_variable(count).value() == core::RuntimeValue{std::int64_t{7}});
}

TEST_CASE("typed runtime session starts a representative Room session")
{
    Fixture fixture("minimal.json");
    auto started = fixture.session->apply(core::RuntimeInputMessage{core::StartRuntimeInput{}});
    CHECK(started.disposition == RuntimeInputDisposition::Handled);
    REQUIRE(started.view.room);
    CHECK(started.view.room->room.text() == "start");
}

TEST_CASE("typed runtime session reports unhandled and stale operations deterministically")
{
    Fixture fixture;
    auto continued = fixture.session->apply(core::RuntimeInputMessage{core::ContinueInput{}});
    CHECK(continued.disposition == RuntimeInputDisposition::Unhandled);
    CHECK(has_output_kind(continued, core::RuntimeOutputKind::ViewPublication));

    auto stale = fixture.session->apply(core::RuntimeInputMessage{
        core::AcknowledgeHostRequestInput{core::HostRequestId::from_number(999)}});
    CHECK(stale.disposition == RuntimeInputDisposition::Failed);
    REQUIRE_FALSE(stale.diagnostics.empty());
    CHECK(stale.diagnostics.front().code == "runtime.stale_host_request");
    REQUIRE(stale.outputs.size() >= 2);
    CHECK(core::output_kind(stale.outputs[stale.outputs.size() - 2]) ==
          core::RuntimeOutputKind::ViewPublication);
    CHECK(core::output_kind(stale.outputs.back()) == core::RuntimeOutputKind::Diagnostic);
}

TEST_CASE("typed runtime session playback observations are ordered before view publication")
{
    Fixture fixture;
    auto begun = fixture.session->apply(core::RuntimeInputMessage{core::BeginPlaybackInput{}});
    REQUIRE(begun.outputs.size() >= 2);
    CHECK(core::output_kind(begun.outputs[begun.outputs.size() - 2]) ==
          core::RuntimeOutputKind::Observation);
    CHECK(core::output_kind(begun.outputs.back()) == core::RuntimeOutputKind::ViewPublication);
}

TEST_CASE("typed runtime session retains failed host requests for explicit retry")
{
    Fixture fixture("interaction-program.json");
    const auto use = make_id<core::VerbIdTag>("use");
    const auto key = make_id<core::InteractableIdTag>("key");
    auto started = fixture.session->apply(core::RuntimeInputMessage{core::StartRuntimeInput{}});
    CAPTURE(started.diagnostics.size());
    const std::string start_code =
        started.diagnostics.empty() ? std::string{} : started.diagnostics.front().code;
    const std::string start_message =
        started.diagnostics.empty() ? std::string{} : started.diagnostics.front().message;
    CAPTURE(start_code, start_message);
    REQUIRE(started.disposition == RuntimeInputDisposition::Handled);
    auto invoked =
        fixture.session->apply(core::RuntimeInputMessage{core::InvokeInteractionInput{use, {key}}});
    CAPTURE(invoked.diagnostics.size());
    const std::string invoke_code =
        invoked.diagnostics.empty() ? std::string{} : invoked.diagnostics.front().code;
    const std::string invoke_message =
        invoked.diagnostics.empty() ? std::string{} : invoked.diagnostics.front().message;
    CAPTURE(invoke_code, invoke_message);
    CHECK(invoked.disposition == RuntimeInputDisposition::Handled);
    CHECK(fixture.session->pending_host_request_count() == 1);

    const core::TypedHostRequest* host_request = nullptr;
    for (const auto& output : invoked.outputs) {
        if (const auto* request = std::get_if<core::TypedHostRequest>(&output)) {
            host_request = request;
            break;
        }
    }
    REQUIRE(host_request != nullptr);
    const auto request_id =
        std::visit([](const auto& request) { return request.id; }, *host_request);

    auto failed = fixture.session->apply(core::RuntimeInputMessage{
        core::FailHostRequestInput{request_id, "backend temporarily unavailable"}});
    CHECK(failed.disposition == RuntimeInputDisposition::Failed);
    CHECK(fixture.session->pending_host_request_count() == 1);

    auto retried = fixture.session->apply(
        core::RuntimeInputMessage{core::AcknowledgeHostRequestInput{request_id}});
    CHECK(retried.disposition == RuntimeInputDisposition::Handled);
    auto duplicate = fixture.session->apply(
        core::RuntimeInputMessage{core::AcknowledgeHostRequestInput{request_id}});
    CHECK(duplicate.disposition == RuntimeInputDisposition::Failed);
    REQUIRE_FALSE(duplicate.diagnostics.empty());
    CHECK(duplicate.diagnostics.front().code == "runtime.stale_host_request");
}

TEST_CASE("runtime script API survives reset and load without kernel-owned Lua closures")
{
    Fixture fixture;
    const auto count = make_id<core::VariableIdTag>("count");

    REQUIRE(fixture.runtime.execute(
        "local ok, err = noveltea.variables.set('count', 12); assert(ok and err == nil)",
        "script-api-before-reset"));
    REQUIRE(fixture.session->script_variable(count));
    CHECK(fixture.session->script_variable(count).value() == core::RuntimeValue{std::int64_t{12}});

    const auto slot = core::TypedSaveSlotId::manual(7);
    REQUIRE(
        fixture.runtime.execute("local ok = Game.save(7); assert(ok)", "script-api-queued-save"));
    CHECK_FALSE(fixture.saves.has_slot(slot).value());
    auto drained = fixture.session->apply(core::RuntimeInputMessage{core::StopRuntimeInput{}});
    CHECK(fixture.saves.has_slot(slot).value());
    CHECK(has_output_kind(drained, core::RuntimeOutputKind::SaveOutcome));

    REQUIRE(fixture.session->apply(core::RuntimeInputMessage{core::ResetRuntimeInput{}})
                .diagnostics.empty());
    REQUIRE(fixture.runtime.execute(
        "local ok, err = noveltea.variables.set('count', 21); assert(ok and err == nil)",
        "script-api-after-reset"));
    REQUIRE(fixture.session->script_variable(count));
    CHECK(fixture.session->script_variable(count).value() == core::RuntimeValue{std::int64_t{21}});

    REQUIRE(
        fixture.runtime.execute("local ok = Game.load(7); assert(ok)", "script-api-queued-load"));
    (void)fixture.session->apply(core::RuntimeInputMessage{core::StopRuntimeInput{}});
    REQUIRE(fixture.session->script_variable(count));
    CHECK(fixture.session->script_variable(count).value() == core::RuntimeValue{std::int64_t{12}});
}

TEST_CASE("runtime script API remains attached after a failed typed load")
{
    Fixture fixture;
    const auto bad_slot = core::TypedSaveSlotId::manual(9);
    REQUIRE(fixture.saves.write_slot(bad_slot, "not a valid typed save"));

    REQUIRE(fixture.runtime.execute("local ok, err = Game.load(9); assert(ok and err == nil)",
                                    "script-api-failed-load-request"));
    auto failed = fixture.session->apply(core::RuntimeInputMessage{core::StopRuntimeInput{}});
    REQUIRE_FALSE(failed.diagnostics.empty());

    REQUIRE(fixture.runtime.execute(
        "local ok, err = noveltea.variables.set('count', 33); assert(ok and err == nil)",
        "script-api-after-failed-load"));
    const auto count = make_id<core::VariableIdTag>("count");
    REQUIRE(fixture.session->script_variable(count));
    CHECK(fixture.session->script_variable(count).value() == core::RuntimeValue{std::int64_t{33}});
}

TEST_CASE("runtime script API lowers indexed navigation to the current stable exit ID")
{
    Fixture fixture;
    auto started = fixture.session->apply(core::RuntimeInputMessage{core::StartRuntimeInput{}});
    REQUIRE(started.view.room);
    REQUIRE(started.view.room->room.text() == "start");
    REQUIRE(started.view.room->exits.size() == 1);
    CHECK(started.view.room->exits.front().exit.text() == "north-exit");

    auto invalid =
        fixture.runtime.execute("local ok, err = Game.navigate(-1); assert(not ok and err ~= nil)\n"
                                "ok, err = Game.navigate(1); assert(not ok and err ~= nil)",
                                "script-api-navigation-range");
    REQUIRE(invalid);

    REQUIRE(fixture.runtime.execute("local ok, err = Game.navigate(0); assert(ok and err == nil)",
                                    "script-api-navigation"));
    auto drained = fixture.session->apply(core::RuntimeInputMessage{core::StopRuntimeInput{}});
    REQUIRE(drained.diagnostics.empty());
    REQUIRE(drained.view.room);
    CHECK(drained.view.room->room.text() == "hall");
}

TEST_CASE(
    "runtime script API drains commands queued by Lua reached during the same outer operation")
{
    Fixture fixture;
    const auto slot = core::TypedSaveSlotId::manual(8);
    REQUIRE(fixture.runtime.execute("function before_leave_start()\n"
                                    "  local ok, err = Game.save(8)\n"
                                    "  assert(ok and err == nil)\n"
                                    "end",
                                    "script-api-nested-command-fixture"));

    auto started = fixture.session->apply(core::RuntimeInputMessage{core::StartRuntimeInput{}});
    REQUIRE(started.diagnostics.empty());
    CHECK_FALSE(fixture.saves.has_slot(slot).value());
    REQUIRE(fixture.runtime.execute("local ok, err = Game.navigate(0); assert(ok and err == nil)",
                                    "script-api-nested-command-navigation"));
    auto drained = fixture.session->apply(core::RuntimeInputMessage{core::StopRuntimeInput{}});
    REQUIRE(drained.diagnostics.empty());
    CHECK(fixture.saves.has_slot(slot).value());
    CHECK(has_output_kind(drained, core::RuntimeOutputKind::SaveOutcome));
}

TEST_CASE("runtime script API routes autosave and rejects malformed interaction operands")
{
    Fixture fixture("interaction-program.json");
    REQUIRE(fixture.runtime.execute("local ok, err = Game.run_action('use', { 'key', 5 })\n"
                                    "assert(not ok and err ~= nil)\n"
                                    "ok, err = Game.autosave()\n"
                                    "assert(ok and err == nil)",
                                    "script-api-validation"));

    CHECK_FALSE(fixture.saves.has_slot(core::TypedSaveSlotId::autosave()).value());
    auto drained = fixture.session->apply(core::RuntimeInputMessage{core::StopRuntimeInput{}});
    REQUIRE(drained.diagnostics.empty());
    CHECK(fixture.saves.has_slot(core::TypedSaveSlotId::autosave()).value());
    CHECK(has_output_kind(drained, core::RuntimeOutputKind::SaveOutcome));
}

TEST_CASE("runtime script API teardown removes public closures instead of leaving stale targets")
{
    Fixture fixture;
    fixture.session.reset();
    auto cleared = fixture.runtime.evaluate_bool(
        "noveltea.variables == nil and Game.save == nil and Game.load == nil",
        "script-api-after-teardown");
    REQUIRE(cleared);
    CHECK(cleared.value());
}

} // namespace noveltea::script::test
