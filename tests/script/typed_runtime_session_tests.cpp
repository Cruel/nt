#include <catch2/catch_test_macros.hpp>

#include "noveltea/assets/asset_manager.hpp"
#include "noveltea/assets/asset_source.hpp"
#include "noveltea/core/compiled_project_codec.hpp"
#include "noveltea/script/script_runtime.hpp"
#include "noveltea/script/typed_runtime_session.hpp"

#include <fstream>
#include <algorithm>
#include <chrono>
#include <iterator>
#include <memory>
#include <string>
#include <type_traits>

#include <nlohmann/json.hpp>

namespace noveltea::script::test {
namespace {

nlohmann::json load_document(std::string_view filename)
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
    return document;
}

core::CompiledProject decode_document(nlohmann::json document, std::string source)
{
    auto decoded = core::decode_compiled_project(document, std::move(source));
    REQUIRE(decoded);
    return std::move(decoded).value();
}

core::CompiledProject load_project(std::string_view filename)
{
    return decode_document(load_document(filename), std::string(filename));
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

TypedRuntimeSessionResult dispatch_settled(TypedRuntimeSession& session,
                                           core::RuntimeInputMessage input)
{
    session.begin_dispatch_transaction();
    auto result = session.apply(input);
    for (const auto& output : result.outputs)
        core::append_diagnostics(result.diagnostics, session.accept_runtime_output(output));
    core::append_diagnostics(result.diagnostics, session.settle_dispatch_transaction());
    if (!result.diagnostics.empty())
        result.disposition = RuntimeInputDisposition::Failed;
    return result;
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
    STATIC_REQUIRE(std::variant_size_v<core::RuntimeInputMessage> == 27);
    STATIC_REQUIRE(std::variant_size_v<core::RuntimeOutputMessage> == 8);
    Fixture fixture;
    auto started = fixture.session->apply(core::RuntimeInputMessage{core::StopRuntimeInput{}});
    CHECK(started.disposition == RuntimeInputDisposition::Handled);
    CHECK(has_output_kind(started, core::RuntimeOutputKind::ViewPublication));

    const auto count = make_id<core::VariableIdTag>("count");
    auto changed = dispatch_settled(
        *fixture.session,
        core::RuntimeInputMessage{core::SetVariableDebugInput{count, std::int64_t{7}}});
    CHECK(changed.disposition == RuntimeInputDisposition::Handled);
    REQUIRE(fixture.session->script_variable(count));
    CHECK(fixture.session->script_variable(count).value() == core::RuntimeValue{std::int64_t{7}});

    const auto slot = core::TypedSaveSlotId::manual(4);
    auto saved =
        dispatch_settled(*fixture.session, core::RuntimeInputMessage{core::SaveRuntimeInput{slot}});
    REQUIRE(saved.diagnostics.empty());
    auto save_outcomes = fixture.session->take_checkpoint_save_outcomes();
    REQUIRE(save_outcomes.size() == 1);
    CHECK(std::holds_alternative<core::CheckpointWriteSucceeded>(save_outcomes.front()));
    const auto saved_bytes = fixture.saves.read_slot(slot).value();
    const auto retained_before_load = *fixture.session->checkpoint_service().latest_checkpoint();
    std::vector<core::PresentationCancellationReason> resets;
    fixture.session->bind_transient_reset_handler(
        [&](core::PresentationCancellationReason reason) { resets.push_back(reason); });
    (void)fixture.session->apply(
        core::RuntimeInputMessage{core::SetVariableDebugInput{count, std::int64_t{9}}});

    const auto corrupt_slot = core::TypedSaveSlotId::manual(5);
    REQUIRE(fixture.saves.write_slot(corrupt_slot, "{corrupt"));
    auto failed_load =
        fixture.session->apply(core::RuntimeInputMessage{core::LoadRuntimeInput{corrupt_slot}});
    REQUIRE_FALSE(failed_load.diagnostics.empty());
    CHECK(resets.empty());
    CHECK(*fixture.session->checkpoint_service().latest_checkpoint() == retained_before_load);
    CHECK(fixture.session->script_variable(count).value() == core::RuntimeValue{std::int64_t{9}});

    auto loaded = fixture.session->apply(core::RuntimeInputMessage{core::LoadRuntimeInput{slot}});
    CHECK(has_output_kind(loaded, core::RuntimeOutputKind::SaveOutcome));
    REQUIRE(resets.size() == 1);
    CHECK(resets.front() == core::PresentationCancellationReason::CheckpointLoad);
    REQUIRE(fixture.session->script_variable(count));
    CHECK(fixture.session->script_variable(count).value() == core::RuntimeValue{std::int64_t{7}});
    REQUIRE(fixture.session->checkpoint_service().latest_checkpoint());
    CHECK(fixture.session->checkpoint_service().latest_checkpoint()->encoded_save == saved_bytes);
    CHECK(fixture.session->checkpoint_service().latest_checkpoint()->revision.number() ==
          retained_before_load.revision.number() + 1);
    CHECK(fixture.session->checkpoint_service().generations() == core::CheckpointGenerationState{});
}

TEST_CASE("runtime reset clears checkpoint and transient lifecycle without fabricated completion")
{
    Fixture fixture("minimal.json");
    REQUIRE(dispatch_settled(*fixture.session, core::RuntimeInputMessage{core::StartRuntimeInput{}})
                .diagnostics.empty());
    REQUIRE(fixture.session->checkpoint_service().latest_checkpoint());
    std::vector<core::PresentationCancellationReason> resets;
    fixture.session->bind_transient_reset_handler(
        [&](core::PresentationCancellationReason reason) { resets.push_back(reason); });

    auto reset =
        dispatch_settled(*fixture.session, core::RuntimeInputMessage{core::ResetRuntimeInput{}});
    REQUIRE(reset.diagnostics.empty());
    REQUIRE(resets.size() == 1);
    CHECK(resets.front() == core::PresentationCancellationReason::RuntimeReset);
    CHECK_FALSE(fixture.session->checkpoint_service().latest_checkpoint());
    CHECK(fixture.session->presentation_checkpoint_status().active_barriers.empty());
}

TEST_CASE("typed runtime session starts a representative Room session")
{
    Fixture fixture("minimal.json");
    auto started = fixture.session->apply(core::RuntimeInputMessage{core::StartRuntimeInput{}});
    CHECK(started.disposition == RuntimeInputDisposition::Handled);
    REQUIRE(started.view.room);
    CHECK(started.view.room->room.text() == "start");
}

TEST_CASE("typed runtime session captures only at settled dirty transaction boundaries")
{
    Fixture fixture("minimal.json");
    CHECK_FALSE(fixture.session->checkpoint_service().latest_checkpoint());

    auto started =
        dispatch_settled(*fixture.session, core::RuntimeInputMessage{core::StartRuntimeInput{}});
    REQUIRE(started.disposition == RuntimeInputDisposition::Handled);
    REQUIRE(fixture.session->checkpoint_service().latest_checkpoint());
    const auto initial = *fixture.session->checkpoint_service().latest_checkpoint();
    CHECK(initial.revision.number() == 1);

    REQUIRE(dispatch_settled(*fixture.session, core::RuntimeInputMessage{core::StopRuntimeInput{}})
                .diagnostics.empty());
    CHECK(fixture.session->checkpoint_service().latest_checkpoint()->revision == initial.revision);
    const auto idle_readiness = fixture.session->checkpoint_service().readiness().revision;
    REQUIRE(dispatch_settled(*fixture.session, core::RuntimeInputMessage{core::StopRuntimeInput{}})
                .diagnostics.empty());
    CHECK(fixture.session->checkpoint_service().readiness().revision == idle_readiness);

    REQUIRE(dispatch_settled(*fixture.session, core::RuntimeInputMessage{core::AdvanceTimeInput{
                                                   std::chrono::milliseconds{500}}})
                .diagnostics.empty());
    CHECK(fixture.session->checkpoint_service().latest_checkpoint()->revision == initial.revision);
    REQUIRE(dispatch_settled(*fixture.session, core::RuntimeInputMessage{core::AdvanceTimeInput{
                                                   std::chrono::milliseconds{500}}})
                .diagnostics.empty());
    CHECK(fixture.session->checkpoint_service().latest_checkpoint()->revision.number() == 2);
    CHECK(fixture.session->checkpoint_service().generations().time_generation == 2);
    CHECK(fixture.session->checkpoint_service().generations().captured_time_generation == 2);
}

TEST_CASE("presentation barriers register before sinks and clear only after committed termination")
{
    Fixture fixture("minimal.json");
    fixture.session->begin_dispatch_transaction();
    auto started = fixture.session->apply(core::RuntimeInputMessage{core::StartRuntimeInput{}});
    const auto operation = core::PresentationOperationId::from_number(44);
    const core::RuntimeOutputMessage output =
        core::PresentationOperation{core::TransitionPresentationOperation{
            .id = operation, .kind = core::compiled::TransitionKind::Fade}};
    core::append_diagnostics(started.diagnostics, fixture.session->accept_runtime_output(output));
    REQUIRE_FALSE(fixture.session->presentation_checkpoint_status().active_barriers.empty());

    core::append_diagnostics(started.diagnostics,
                             fixture.session->commit_transient_operation(operation));
    core::append_diagnostics(started.diagnostics, fixture.session->settle_dispatch_transaction());
    CHECK(fixture.session->presentation_checkpoint_status().active_barriers.empty());
    CHECK(fixture.session->checkpoint_service().readiness().can_capture());
}

TEST_CASE("frame-driven ActiveText barrier changes settle checkpoint readiness")
{
    Fixture fixture("minimal.json");
    REQUIRE(dispatch_settled(*fixture.session, core::RuntimeInputMessage{core::StartRuntimeInput{}})
                .diagnostics.empty());
    REQUIRE(fixture.session->checkpoint_service().latest_checkpoint());

    fixture.session->begin_dispatch_transaction();
    REQUIRE(fixture.session->update_active_text_checkpoint_status(true).empty());
    REQUIRE(fixture.session->settle_dispatch_transaction().empty());
    CHECK_FALSE(fixture.session->checkpoint_service().readiness().can_capture());
    CHECK(std::any_of(
        fixture.session->checkpoint_service().readiness().issues.begin(),
        fixture.session->checkpoint_service().readiness().issues.end(), [](const auto& issue) {
            return issue.reason == core::CheckpointReadinessReason::PresentationBarrierActive;
        }));

    fixture.session->begin_dispatch_transaction();
    REQUIRE(fixture.session->update_active_text_checkpoint_status(false).empty());
    REQUIRE(fixture.session->settle_dispatch_transaction().empty());
    CHECK(fixture.session->checkpoint_service().readiness().can_capture());
}

TEST_CASE("pending host requests publish typed checkpoint readiness barriers")
{
    Fixture fixture("interaction-program.json");
    REQUIRE(dispatch_settled(*fixture.session, core::RuntimeInputMessage{core::StopRuntimeInput{}})
                .diagnostics.empty());
    REQUIRE(dispatch_settled(*fixture.session, core::RuntimeInputMessage{core::StartRuntimeInput{}})
                .diagnostics.empty());
    const auto use = make_id<core::VerbIdTag>("use");
    const auto key = make_id<core::InteractableIdTag>("key");
    auto invoked = dispatch_settled(
        *fixture.session, core::RuntimeInputMessage{core::InvokeInteractionInput{use, {key}}});
    REQUIRE(invoked.disposition == RuntimeInputDisposition::Handled);
    REQUIRE_FALSE(fixture.session->checkpoint_service().readiness().can_capture());
    const auto& issues = fixture.session->checkpoint_service().readiness().issues;
    CHECK(std::any_of(issues.begin(), issues.end(), [](const auto& issue) {
        return issue.reason == core::CheckpointReadinessReason::HostRequestPending;
    }));
}

TEST_CASE("recursive host acknowledgement settles inside one outer transaction")
{
    Fixture fixture("interaction-program.json");
    REQUIRE(dispatch_settled(*fixture.session, core::RuntimeInputMessage{core::StartRuntimeInput{}})
                .diagnostics.empty());
    fixture.session->begin_dispatch_transaction();
    auto invoked = fixture.session->apply(core::RuntimeInputMessage{core::InvokeInteractionInput{
        make_id<core::VerbIdTag>("use"), {make_id<core::InteractableIdTag>("key")}}});
    std::optional<core::HostRequestId> request;
    for (const auto& output : invoked.outputs) {
        if (const auto* host = std::get_if<core::TypedHostRequest>(&output)) {
            request = std::visit([](const auto& value) { return value.id; }, *host);
            break;
        }
    }
    REQUIRE(request);
    auto acknowledged = fixture.session->apply(
        core::RuntimeInputMessage{core::AcknowledgeHostRequestInput{*request}});
    REQUIRE(acknowledged.diagnostics.empty());
    REQUIRE(fixture.session->settle_dispatch_transaction().empty());
    CHECK(std::none_of(
        fixture.session->checkpoint_service().readiness().issues.begin(),
        fixture.session->checkpoint_service().readiness().issues.end(), [](const auto& issue) {
            return issue.reason == core::CheckpointReadinessReason::HostRequestPending;
        }));
}

TEST_CASE("successful structural mutations capture once and true no-ops stay clean")
{
    Fixture fixture("comprehensive.json");
    REQUIRE(dispatch_settled(*fixture.session, core::RuntimeInputMessage{core::StartRuntimeInput{}})
                .diagnostics.empty());
    REQUIRE(fixture.session->checkpoint_service().latest_checkpoint());
    const auto count = make_id<core::VariableIdTag>("count");
    const auto before = fixture.session->checkpoint_service().generations();

    REQUIRE(dispatch_settled(
                *fixture.session,
                core::RuntimeInputMessage{core::SetVariableDebugInput{count, std::int64_t{7}}})
                .diagnostics.empty());
    const auto changed = fixture.session->checkpoint_service().generations();
    CHECK(changed.structural_generation == before.structural_generation + 1);
    CHECK(changed.captured_structural_generation == changed.structural_generation);
    const auto checkpoint = fixture.session->checkpoint_service().latest_checkpoint()->revision;

    REQUIRE(dispatch_settled(
                *fixture.session,
                core::RuntimeInputMessage{core::SetVariableDebugInput{count, std::int64_t{7}}})
                .diagnostics.empty());
    CHECK(fixture.session->checkpoint_service().generations() == changed);
    CHECK(fixture.session->checkpoint_service().latest_checkpoint()->revision == checkpoint);
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
    auto drained =
        dispatch_settled(*fixture.session, core::RuntimeInputMessage{core::StopRuntimeInput{}});
    CHECK(fixture.saves.has_slot(slot).value());
    CHECK_FALSE(fixture.session->take_checkpoint_save_outcomes().empty());

    REQUIRE(fixture.session->apply(core::RuntimeInputMessage{core::ResetRuntimeInput{}})
                .diagnostics.empty());
    REQUIRE(fixture.runtime.execute(
        "local ok, err = noveltea.variables.set('count', 21); assert(ok and err == nil)",
        "script-api-after-reset"));
    REQUIRE(fixture.session->script_variable(count));
    CHECK(fixture.session->script_variable(count).value() == core::RuntimeValue{std::int64_t{21}});

    REQUIRE(
        fixture.runtime.execute("local ok = Game.load(7); assert(ok)", "script-api-queued-load"));
    (void)dispatch_settled(*fixture.session, core::RuntimeInputMessage{core::StopRuntimeInput{}});
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
    REQUIRE(dispatch_settled(*fixture.session, core::RuntimeInputMessage{core::StopRuntimeInput{}})
                .diagnostics.empty());
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
    auto drained =
        dispatch_settled(*fixture.session, core::RuntimeInputMessage{core::StopRuntimeInput{}});
    REQUIRE(drained.diagnostics.empty());
    CHECK(fixture.saves.has_slot(slot).value());
    CHECK_FALSE(fixture.session->take_checkpoint_save_outcomes().empty());
}

TEST_CASE("runtime script API routes autosave and rejects malformed interaction operands")
{
    Fixture fixture("interaction-program.json");
    REQUIRE(dispatch_settled(*fixture.session, core::RuntimeInputMessage{core::StopRuntimeInput{}})
                .diagnostics.empty());
    REQUIRE(fixture.runtime.execute("local ok, err = Game.run_action('use', { 'key', 5 })\n"
                                    "assert(not ok and err ~= nil)\n"
                                    "ok, err = Game.autosave()\n"
                                    "assert(ok and err == nil)",
                                    "script-api-validation"));

    CHECK_FALSE(fixture.saves.has_slot(core::TypedSaveSlotId::autosave()).value());
    auto drained =
        dispatch_settled(*fixture.session, core::RuntimeInputMessage{core::StopRuntimeInput{}});
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

TEST_CASE("runtime Lua random state is deterministic across save load and invalid ranges")
{
    Fixture fixture;
    REQUIRE(fixture.runtime.execute(
        "local ok, err = noveltea.random.seed(77); assert(ok and err == nil)\n"
        "random_first = assert(noveltea.random.integer(-20, 20))\n"
        "ok, err = Game.save(12); assert(ok and err == nil)",
        "typed-random-save"));
    (void)dispatch_settled(*fixture.session, core::RuntimeInputMessage{core::StopRuntimeInput{}});

    REQUIRE(fixture.runtime.execute(
        "random_expected = assert(noveltea.random.integer(-20, 20))\n"
        "local before = assert(noveltea.random.number())\n"
        "local value, err = noveltea.random.integer(5, 4); assert(value == nil and err ~= nil)\n"
        "random_after_invalid = assert(noveltea.random.number())",
        "typed-random-after-save"));
    auto expected = fixture.runtime.evaluate("random_expected", "typed-random-expected");
    REQUIRE(expected);

    REQUIRE(fixture.runtime.execute("local ok = Game.load(12); assert(ok)", "typed-random-load"));
    (void)fixture.session->apply(core::RuntimeInputMessage{core::StopRuntimeInput{}});
    REQUIRE(fixture.runtime.execute("random_restored = assert(noveltea.random.integer(-20, 20))",
                                    "typed-random-restored"));
    auto restored = fixture.runtime.evaluate("random_restored", "typed-random-restored-value");
    REQUIRE(restored);
    CHECK(restored.value() == expected.value());

    REQUIRE(fixture.runtime.execute(
        "noveltea.random.seed(991)\n"
        "local value, err = noveltea.random.integer(2, 1); assert(value == nil and err ~= nil)\n"
        "random_after_failure = assert(noveltea.random.integer(1, 1000))\n"
        "noveltea.random.seed(991)\n"
        "random_without_failure = assert(noveltea.random.integer(1, 1000))",
        "typed-random-atomic"));
    auto atomic = fixture.runtime.evaluate_bool("random_after_failure == random_without_failure",
                                                "typed-random-atomic-result");
    REQUIRE(atomic);
    CHECK(atomic.value());

    REQUIRE(fixture.runtime.execute(
        "math.randomseed(31337); math_random = math.random(1, 100000)\n"
        "noveltea.random.seed(31337); typed_random = assert(noveltea.random.integer(1, 100000))",
        "typed-math-random"));
    auto math_matches =
        fixture.runtime.evaluate_bool("math_random == typed_random", "typed-math-random-result");
    REQUIRE(math_matches);
    CHECK(math_matches.value());
}

TEST_CASE("runtime Lua Map and layout controls use typed state and validated navigation")
{
    Fixture fixture;
    auto started = fixture.session->apply(core::RuntimeInputMessage{core::StartRuntimeInput{}});
    REQUIRE(started.diagnostics.empty());
    REQUIRE(started.view.room);
    CHECK(started.view.room->room.text() == "start");

    REQUIRE(fixture.runtime.execute(
        "local ok, err = noveltea.map.present('house', {mode='full-map', visible=true, "
        "focus='hall-location'}); assert(ok and err == nil)\n"
        "local state = assert(noveltea.map.state()); assert(state.map == 'house' and "
        "state.mode == 'full-map' and state.focused_location == 'hall-location')\n"
        "ok, err = noveltea.layouts.set('custom', 'hud-assets'); assert(ok and err == nil)\n"
        "layout_value = assert(noveltea.layouts.get('custom'))",
        "typed-map-layout"));
    auto view = fixture.session->apply(core::RuntimeInputMessage{core::StopRuntimeInput{}});
    REQUIRE(view.diagnostics.empty());
    REQUIRE(view.view.map);
    CHECK(view.view.map->map.text() == "house");
    CHECK(view.view.map->mode == core::compiled::InitialMapMode::FullMap);
    CHECK(view.view.map->locations[1].focused);
    REQUIRE(view.view.scene == std::nullopt);
    auto layout_value = fixture.runtime.evaluate_string("layout_value", "layout-value");
    REQUIRE(layout_value);
    CHECK(layout_value.value() == "hud-assets");
    CHECK(std::count_if(view.outputs.begin(), view.outputs.end(), [](const auto& output) {
              return std::holds_alternative<core::RuntimeViewPublication>(output);
          }) == 1);

    REQUIRE(fixture.runtime.execute(
        "local before = assert(noveltea.map.state())\n"
        "local ok, err = noveltea.map.present('missing', {mode='minimap'}); "
        "assert(not ok and err ~= nil)\n"
        "local after = assert(noveltea.map.state()); assert(after.map == before.map)\n"
        "ok, err = noveltea.layouts.set('custom', 'missing'); assert(not ok and err ~= nil)\n"
        "assert(noveltea.layouts.get('custom') == 'hud-assets')\n"
        "ok, err = noveltea.map.activate('start-hall'); assert(ok and err == nil)",
        "typed-map-layout-atomic"));
    auto requested = fixture.session->apply(core::RuntimeInputMessage{core::StopRuntimeInput{}});
    const core::TypedHostRequest* request = nullptr;
    for (const auto& output : requested.outputs) {
        if (const auto* value = std::get_if<core::TypedHostRequest>(&output)) {
            request = value;
            break;
        }
    }
    REQUIRE(request != nullptr);
    REQUIRE(std::holds_alternative<core::NavigationHostRequest>(*request));
    const auto request_id = std::get<core::NavigationHostRequest>(*request).id;
    auto navigated = fixture.session->apply(
        core::RuntimeInputMessage{core::AcknowledgeHostRequestInput{request_id}});
    REQUIRE(navigated.diagnostics.empty());
    REQUIRE(navigated.view.room);
    CHECK(navigated.view.room->room.text() == "hall");

    REQUIRE(fixture.runtime.execute(
        "local ok, err = noveltea.map.hide(); assert(ok and err == nil)\n"
        "ok, err = noveltea.layouts.clear('custom'); assert(ok and err == nil)\n"
        "assert(noveltea.layouts.get('custom') == nil)",
        "typed-map-layout-clear"));
    auto cleared = fixture.session->apply(core::RuntimeInputMessage{core::StopRuntimeInput{}});
    REQUIRE(cleared.view.map);
    CHECK_FALSE(cleared.view.map->visible);
}

TEST_CASE("runtime Lua pause blocks gameplay and is reset by typed load")
{
    Fixture fixture;
    auto started = fixture.session->apply(core::RuntimeInputMessage{core::StartRuntimeInput{}});
    REQUIRE(started.diagnostics.empty());
    REQUIRE(fixture.runtime.execute("local ok, err = Game.pause(); assert(ok and err == nil)\n"
                                    "ok, err = Game.pause(); assert(ok and err == nil)\n"
                                    "paused_value = assert(Game.paused())\n"
                                    "ok, err = Game.save(13); assert(ok and err == nil)",
                                    "typed-pause"));
    auto paused =
        dispatch_settled(*fixture.session, core::RuntimeInputMessage{core::StopRuntimeInput{}});
    REQUIRE(paused.diagnostics.empty());
    CHECK(paused.view.gameplay_paused);
    auto paused_value = fixture.runtime.evaluate_bool("paused_value", "typed-pause-value");
    REQUIRE(paused_value);
    CHECK(paused_value.value());

    auto blocked = fixture.session->apply(core::RuntimeInputMessage{core::ContinueInput{}});
    CHECK(blocked.disposition == RuntimeInputDisposition::Unhandled);
    CHECK(blocked.view.gameplay_paused);

    REQUIRE(fixture.runtime.execute("local ok = Game.load(13); assert(ok)", "typed-pause-load"));
    auto loaded = fixture.session->apply(core::RuntimeInputMessage{core::StopRuntimeInput{}});
    REQUIRE(loaded.diagnostics.empty());
    CHECK_FALSE(loaded.view.gameplay_paused);
    REQUIRE(fixture.runtime.execute("local ok, err = Game.resume(); assert(ok and err == nil); "
                                    "assert(Game.paused() == false)",
                                    "typed-pause-resume"));
}

TEST_CASE("runtime Lua pause takes effect before the next typed instruction")
{
    auto document = load_document("scene-program.json");
    auto& opening = document["definitions"]["scenes"][1];
    opening["program"]["instructions"] = nlohmann::json::array(
        {{{"id", "pause"},
          {"kind", "run-lua"},
          {"autosaveSafePoint", false},
          {"mayYield", false},
          {"source", "local ok, err = Game.pause(); assert(ok and err == nil)"}},
         {{"id", "after-pause"},
          {"kind", "set-variable"},
          {"variable", {{"kind", "variable"}, {"id", "count"}}},
          {"value", 77}}});
    auto project = decode_document(std::move(document), "typed-pause-in-flow.json");
    auto source = std::make_shared<assets::MemoryAssetSource>();
    assets::AssetManager assets;
    assets.mount("project", source);
    ScriptRuntime runtime;
    REQUIRE(runtime.initialize({&assets}));
    core::TypedMemorySaveSlotStore saves;
    auto created = TypedRuntimeSession::create(project, runtime, saves, "en");
    REQUIRE(created);
    auto session = std::move(created).value();

    auto paused = session->apply(core::RuntimeInputMessage{core::StartRuntimeInput{}});
    REQUIRE(paused.diagnostics.empty());
    CHECK(paused.view.gameplay_paused);
    CHECK(session->script_variable(make_id<core::VariableIdTag>("count")).value() ==
          core::RuntimeValue{std::int64_t{2}});

    REQUIRE(runtime.execute("local ok, err = Game.resume(); assert(ok and err == nil)",
                            "typed-pause-in-flow-resume"));
    auto resumed = session->apply(
        core::RuntimeInputMessage{core::AdvanceTimeInput{std::chrono::microseconds{0}}});
    REQUIRE(resumed.diagnostics.empty());
    CHECK_FALSE(resumed.view.gameplay_paused);
    CHECK(session->script_variable(make_id<core::VariableIdTag>("count")).value() ==
          core::RuntimeValue{std::int64_t{77}});
}

TEST_CASE("effective Layout pause gates gameplay without changing Lua pause state")
{
    Fixture fixture;
    auto started = fixture.session->apply(core::RuntimeInputMessage{core::StartRuntimeInput{}});
    REQUIRE(started.diagnostics.empty());
    fixture.session->set_effective_gameplay_pause(
        {.paused = true,
         .active_sources = {{.kind = core::GameplayPauseSourceKind::MountedLayout,
                             .layout_instance = core::MountedLayoutInstanceId::from_number(41)}}});

    auto blocked = fixture.session->apply(core::RuntimeInputMessage{core::ContinueInput{}});
    CHECK(blocked.disposition == RuntimeInputDisposition::Unhandled);
    CHECK_FALSE(blocked.view.gameplay_paused);
    CHECK(blocked.view.effective_gameplay_pause.paused);
    REQUIRE(blocked.view.effective_gameplay_pause.active_sources.size() == 1);

    REQUIRE(fixture.runtime.execute("assert(Game.paused() == false); "
                                    "local ok, err = Game.resume(); assert(ok and err == nil)",
                                    "typed-effective-pause"));
    auto lifecycle = fixture.session->apply(core::RuntimeInputMessage{core::StopRuntimeInput{}});
    REQUIRE(lifecycle.diagnostics.empty());
    CHECK(lifecycle.view.effective_gameplay_pause.paused);

    fixture.session->set_effective_gameplay_pause({});
    auto admitted = fixture.session->apply(
        core::RuntimeInputMessage{core::AdvanceTimeInput{std::chrono::microseconds{0}}});
    CHECK(admitted.disposition != RuntimeInputDisposition::Unhandled);
}

TEST_CASE("effective pause derives explicit state from the authoritative runtime session")
{
    Fixture fixture;
    CHECK_FALSE(fixture.session->explicit_gameplay_paused());
    REQUIRE(fixture.runtime.execute("local ok, err = Game.pause(); assert(ok and err == nil)",
                                    "typed-explicit-pause-source"));
    CHECK(fixture.session->explicit_gameplay_paused());
    REQUIRE(fixture.runtime.execute("local ok, err = Game.resume(); assert(ok and err == nil)",
                                    "typed-explicit-resume-source"));
    CHECK_FALSE(fixture.session->explicit_gameplay_paused());
}

TEST_CASE("runtime Lua text log validates metadata and survives save restore")
{
    Fixture fixture;
    REQUIRE(fixture.runtime.execute(
        "local ok, err = noveltea.text_log.append('notification', 'system', "
        "'[b]Saved[/b]', 'active-text'); assert(ok and err == nil)\n"
        "ok, err = noveltea.text_log.append('line', 'system', 'bad', 'plain'); "
        "assert(not ok and err ~= nil)\n"
        "ok, err = noveltea.text_log.append('notification', 'legacy', 'bad', 'plain'); "
        "assert(not ok and err ~= nil)\n"
        "ok, err = Game.save(14); assert(ok and err == nil)",
        "typed-text-log"));
    auto saved =
        dispatch_settled(*fixture.session, core::RuntimeInputMessage{core::StopRuntimeInput{}});
    REQUIRE(saved.diagnostics.empty());
    REQUIRE(saved.view.text_log.entries.size() == 1);
    CHECK(saved.view.text_log.entries.front().text == "[b]Saved[/b]");
    CHECK(saved.view.text_log.entries.front().markup == core::TextMarkup::ActiveText);

    REQUIRE(fixture.runtime.execute("local ok = noveltea.text_log.clear(); assert(ok)\n"
                                    "ok = Game.load(14); assert(ok)",
                                    "typed-text-log-load"));
    auto restored = fixture.session->apply(core::RuntimeInputMessage{core::StopRuntimeInput{}});
    REQUIRE(restored.diagnostics.empty());
    REQUIRE(restored.view.text_log.entries.size() == 1);
    CHECK(restored.view.text_log.entries.front().text == "[b]Saved[/b]");
}

TEST_CASE(
    "runtime Lua audio emits typed operations and awaited completion resumes exact invocation")
{
    Fixture immediate;
    REQUIRE(immediate.runtime.execute(
        "local ok, err = audio.play('audio-voice', 'voice', "
        "{fade_ms=25, volume=0.5, loop=false}); assert(ok and err == nil)\n"
        "local state = assert(audio.state('voice')); assert(state.playing and "
        "state.asset == 'audio-voice' and state.volume == 0.5)\n"
        "ok, err = audio.play('missing', 'voice'); assert(not ok and err ~= nil)\n"
        "ok, err = audio.play('image-main', 'voice'); assert(not ok and err ~= nil)\n"
        "state = assert(audio.state('voice')); assert(state.asset == 'audio-voice')",
        "typed-audio-immediate"));
    auto emitted = immediate.session->apply(core::RuntimeInputMessage{core::StopRuntimeInput{}});
    const core::AudioOperation* immediate_operation = nullptr;
    for (const auto& output : emitted.outputs) {
        if (const auto* value = std::get_if<core::AudioOperation>(&output)) {
            immediate_operation = value;
            break;
        }
    }
    REQUIRE(immediate_operation != nullptr);
    CHECK(immediate_operation->action == core::compiled::AudioAction::FadeIn);
    CHECK(immediate_operation->channel == core::compiled::AudioChannel::Voice);
    CHECK(immediate_operation->asset == make_id<core::AssetIdTag>("audio-voice"));
    CHECK_FALSE(immediate_operation->owner);
    CHECK_FALSE(immediate_operation->completion);

    auto document = load_document("scene-program.json");
    auto& opening = document["definitions"]["scenes"][1];
    opening["program"]["instructions"] = nlohmann::json::array(
        {{{"id", "lua"},
          {"kind", "run-lua"},
          {"autosaveSafePoint", false},
          {"mayYield", true},
          {"source", "local ok, err = audio.play_and_wait('audio-voice', 'voice', {volume=0.4}); "
                     "assert(ok and err == nil); noveltea.variables.set('count', 50); "
                     "ok, err = audio.stop_and_wait('voice', {fade_ms=5}); "
                     "assert(ok and err == nil); noveltea.variables.set('count', 77)"}}});
    auto project = decode_document(std::move(document), "typed-audio-await.json");
    auto source = std::make_shared<assets::MemoryAssetSource>();
    assets::AssetManager assets;
    assets.mount("project", source);
    ScriptRuntime runtime;
    REQUIRE(runtime.initialize({&assets}));
    core::TypedMemorySaveSlotStore saves;
    auto created = TypedRuntimeSession::create(project, runtime, saves, "en");
    REQUIRE(created);
    auto session = std::move(created).value();

    auto blocked = session->apply(core::RuntimeInputMessage{core::StartRuntimeInput{}});
    const core::AudioOperation* awaited = nullptr;
    for (const auto& output : blocked.outputs) {
        if (const auto* value = std::get_if<core::AudioOperation>(&output)) {
            awaited = value;
            break;
        }
    }
    REQUIRE(awaited != nullptr);
    REQUIRE(awaited->owner);
    REQUIRE(awaited->completion);
    REQUIRE(std::holds_alternative<core::ScriptInvocationHandle>(*awaited->completion));
    const auto owner = *awaited->owner;
    const auto completion = *awaited->completion;
    const auto operation = awaited->id;

    auto stale = session->apply(core::RuntimeInputMessage{core::CompleteAudioInput{
        core::AudioOperationId::from_number(operation.number() + 1), owner, completion}});
    CHECK(stale.disposition == RuntimeInputDisposition::Failed);
    REQUIRE_FALSE(stale.diagnostics.empty());
    CHECK(stale.diagnostics.front().code == "runtime.stale_audio_completion");
    CHECK(session->script_variable(make_id<core::VariableIdTag>("count")).value() ==
          core::RuntimeValue{std::int64_t{2}});

    auto completed = session->apply(
        core::RuntimeInputMessage{core::CompleteAudioInput{operation, owner, completion}});
    REQUIRE(completed.diagnostics.empty());
    CHECK(session->script_variable(make_id<core::VariableIdTag>("count")).value() ==
          core::RuntimeValue{std::int64_t{50}});
    const core::AudioOperation* second = nullptr;
    for (const auto& output : completed.outputs) {
        if (const auto* value = std::get_if<core::AudioOperation>(&output)) {
            second = value;
            break;
        }
    }
    REQUIRE(second != nullptr);
    CHECK(second->action == core::compiled::AudioAction::FadeOut);
    REQUIRE(second->owner);
    REQUIRE(second->completion);
    const auto second_operation = second->id;
    const auto second_owner = *second->owner;
    const auto second_completion = *second->completion;
    auto stopped = session->apply(core::RuntimeInputMessage{
        core::CompleteAudioInput{second_operation, second_owner, second_completion}});
    REQUIRE(stopped.diagnostics.empty());
    CHECK(session->script_variable(make_id<core::VariableIdTag>("count")).value() ==
          core::RuntimeValue{std::int64_t{77}});
}

} // namespace noveltea::script::test
