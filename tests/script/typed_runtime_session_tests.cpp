#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include "noveltea/core/compiled_project_codec.hpp"
#include "noveltea/script/script_runtime.hpp"
#include "noveltea/runtime/runtime_session.hpp"
#include "fake_script_source.hpp"
#include "runtime_test_services.hpp"

#include <fstream>
#include <algorithm>
#include <functional>
#include <chrono>
#include <iterator>
#include <memory>
#include <optional>
#include <string>
#include <type_traits>

#include <nlohmann/json.hpp>

namespace noveltea::script::test {
namespace {

using TypedRuntimeSession = runtime::RuntimeSession;

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

core::CompiledProject load_project(std::string_view filename,
                                   const std::function<void(nlohmann::json&)>& amend = {})
{
    auto document = load_document(filename);
    if (amend)
        amend(document);
    return decode_document(std::move(document), std::string(filename));
}

core::compiled::InventoryLocation player_inventory_location()
{
    auto inventory = core::InventoryId::create("player");
    REQUIRE(inventory);
    return core::compiled::InventoryLocation{core::compiled::InventoryRef{
        core::compiled::ProjectInventoryOwner{}, std::move(inventory).value()}};
}

nlohmann::json scene_events(nlohmann::json instructions)
{
    auto events = nlohmann::json::array();
    for (auto& instruction : instructions) {
        const auto id = instruction.at("id");
        events.push_back({{"id", id},
                          {"timeline",
                           {{"trackId", "main"},
                            {"startMs", 0},
                            {"durationMs", instruction.value("durationMs", 0)}}},
                          {"completionDependencies", nlohmann::json::array()},
                          {"instruction", std::move(instruction)}});
    }
    return events;
}

core::CompiledProject make_immediate_audio_project(std::string source_name)
{
    auto document = load_document("scene-program.json");
    auto& opening = document["definitions"]["scenes"][1];
    opening["program"]["events"] = scene_events(
        nlohmann::json::array({{{"id", "audio"},
                                {"kind", "run-lua"},
                                {"autosaveSafePoint", false},
                                {"mayYield", false},
                                {"source", "local ok, err = audio.play('audio-voice', 'voice'); "
                                           "assert(ok and err == nil)"}}}));
    return decode_document(std::move(document), std::move(source_name));
}

core::CompiledProject make_awaited_audio_cue_project(std::string source_name)
{
    auto document = load_document("scene-program.json");
    auto& opening = document["definitions"]["scenes"][1];
    opening["program"]["events"] =
        scene_events(nlohmann::json::array({{{"id", "audio"},
                                             {"kind", "audio-cue"},
                                             {"owner", "invocation"},
                                             {"action", "fade-in"},
                                             {"purpose", "voice"},
                                             {"lifetime", "one-shot"},
                                             {"pausePolicy", "gameplay"},
                                             {"asset", {{"kind", "asset"}, {"id", "audio-voice"}}},
                                             {"fadeMs", 25},
                                             {"gain", 0.5},
                                             {"pan", 0.0},
                                             {"panSource", nullptr},
                                             {"waitForCompletion", true},
                                             {"causality", "causal"},
                                             {"synchronized", false},
                                             {"skipBehavior", "stop"},
                                             {"instanceId", nullptr},
                                             {"replacementGroup", nullptr}}}));
    return decode_document(std::move(document), std::move(source_name));
}

core::CompiledProject make_audio_semantic_wait_project(std::string source_name)
{
    auto document = load_document("scene-program.json");
    auto& opening = document["definitions"]["scenes"][1];
    opening["program"]["events"] = scene_events(nlohmann::json::array(
        {{{"id", "audio"},
          {"kind", "audio-cue"},
          {"owner", "invocation"},
          {"action", "play"},
          {"purpose", "sound-effect"},
          {"lifetime", "one-shot"},
          {"pausePolicy", "gameplay"},
          {"asset", {{"kind", "asset"}, {"id", "audio-voice"}}},
          {"fadeMs", 0},
          {"gain", 1.0},
          {"pan", 0.0},
          {"panSource", nullptr},
          {"waitForCompletion", false},
          {"causality", "causal"},
          {"synchronized", false},
          {"skipBehavior", "stop"},
          {"instanceId", nullptr},
          {"replacementGroup", nullptr}},
         {{"id", "wait-audio"}, {"kind", "wait-audio"}, {"eventId", "audio"}, {"skippable", false}},
         {{"id", "after-audio"},
          {"kind", "set-global-property"},
          {"property", {{"kind", "property"}, {"id", "count"}}},
          {"value", 9}}}));
    return decode_document(std::move(document), std::move(source_name));
}

core::CompiledProject make_transition_group_project(std::string source_name,
                                                    bool wait_for_completion)
{
    auto document = load_document("scene-program.json");
    auto& opening = document["definitions"]["scenes"][1];
    opening["program"]["events"] = scene_events(
        nlohmann::json::array({{{"id", "transition"},
                                {"kind", "transition-group"},
                                {"owner", "invocation"},
                                {"children", nlohmann::json::array({{{"id", "background"},
                                                                     {"kind", "set-background"},
                                                                     {"asset", nullptr},
                                                                     {"material", nullptr},
                                                                     {"color", "#556677"},
                                                                     {"fit", "cover"}}})},
                                {"transitionKind", "fade"},
                                {"durationMs", 250},
                                {"color", "#000000"},
                                {"skippable", true},
                                {"waitForCompletion", wait_for_completion}},
                               {{"id", "after-transition"},
                                {"kind", "set-global-property"},
                                {"property", {{"kind", "property"}, {"id", "count"}}},
                                {"value", 9}}}));
    return decode_document(std::move(document), std::move(source_name));
}

core::CompiledProject make_transition_dependency_project(std::string source_name)
{
    auto document = load_document("scene-program.json");
    auto& opening = document["definitions"]["scenes"][1];
    opening["program"]["events"] = scene_events(
        nlohmann::json::array({{{"id", "transition"},
                                {"kind", "transition-group"},
                                {"owner", "invocation"},
                                {"children", nlohmann::json::array({{{"id", "background"},
                                                                     {"kind", "set-background"},
                                                                     {"asset", nullptr},
                                                                     {"material", nullptr},
                                                                     {"color", "#556677"},
                                                                     {"fit", "cover"}}})},
                                {"transitionKind", "fade"},
                                {"durationMs", 250},
                                {"color", "#000000"},
                                {"skippable", true},
                                {"waitForCompletion", false}},
                               {{"id", "overlap"},
                                {"kind", "set-global-property"},
                                {"property", {{"kind", "property"}, {"id", "count"}}},
                                {"value", 5}},
                               {{"id", "dependent"},
                                {"kind", "set-global-property"},
                                {"property", {{"kind", "property"}, {"id", "count"}}},
                                {"value", 9}}}));
    opening["program"]["events"][2]["completionDependencies"] =
        nlohmann::json::array({"transition"});
    return decode_document(std::move(document), std::move(source_name));
}

core::CompiledProject make_transition_operation_wait_project(std::string source_name)
{
    auto document = load_document("scene-program.json");
    auto& opening = document["definitions"]["scenes"][1];
    opening["program"]["events"] = scene_events(
        nlohmann::json::array({{{"id", "transition"},
                                {"kind", "transition-group"},
                                {"owner", "invocation"},
                                {"children", nlohmann::json::array({{{"id", "background"},
                                                                     {"kind", "set-background"},
                                                                     {"asset", nullptr},
                                                                     {"material", nullptr},
                                                                     {"color", "#556677"},
                                                                     {"fit", "cover"}}})},
                                {"transitionKind", "fade"},
                                {"durationMs", 250},
                                {"color", "#000000"},
                                {"skippable", true},
                                {"waitForCompletion", false}},
                               {{"id", "wait-transition"},
                                {"kind", "wait-operation"},
                                {"eventId", "transition"},
                                {"skippable", false}},
                               {{"id", "after-transition"},
                                {"kind", "set-global-property"},
                                {"property", {{"kind", "property"}, {"id", "count"}}},
                                {"value", 9}}}));
    return decode_document(std::move(document), std::move(source_name));
}

core::CompiledProject make_animated_room_project(std::string source_name)
{
    auto document = load_document("comprehensive.json");
    document["settings"]["roomNavigationTransition"] = {
        {"kind", "fade"},
        {"durationMs", 250},
        {"color", "#000000"},
        {"skippable", true},
    };
    document["resources"]["scripts"].push_back(
        {{"id", "animated-room-hooks"},
         {"source",
          {{"kind", "inline-lua"},
           {"source", "return { after_enter_start = function() "
                      "local ok, err = Game.set_prop('count', 7); assert(ok, err) end, "
                      "after_enter_hall = function() "
                      "local ok, err = Game.set_prop('count', 8); assert(ok, err) end }"}}}});
    for (auto& room : document["definitions"]["rooms"]) {
        const auto room_id = room["id"].get<std::string>();
        if (room_id != "start" && room_id != "hall")
            continue;
        auto& hooks = room["scriptHooks"];
        hooks.erase(std::remove_if(
                        hooks.begin(), hooks.end(),
                        [](const nlohmann::json& hook) { return hook["hook"] == "after-enter"; }),
                    hooks.end());
        hooks.push_back(
            {{"hook", "after-enter"},
             {"handler",
              {{"module", {{"kind", "script"}, {"id", "animated-room-hooks"}}},
               {"export", room_id == "start" ? "after_enter_start" : "after_enter_hall"}}}});
    }
    return decode_document(std::move(document), std::move(source_name));
}

core::CompiledProject make_faulting_scene_project(std::string source_name)
{
    auto document = load_document("scene-program.json");
    auto& opening = document["definitions"]["scenes"][1];
    opening["program"]["events"] =
        scene_events(nlohmann::json::array({{{"id", "fault"},
                                             {"kind", "run-lua"},
                                             {"autosaveSafePoint", false},
                                             {"mayYield", false},
                                             {"source", "error('intentional runtime fault')"}}}));
    return decode_document(std::move(document), std::move(source_name));
}

void configure_detached_duration_flow(nlohmann::json& document, std::string_view owner)
{
    auto& closing = document["definitions"]["scenes"][0];
    auto& opening = document["definitions"]["scenes"][1];
    REQUIRE(closing["id"] == "closing");
    REQUIRE(opening["id"] == "opening");
    closing["program"]["events"] = scene_events(nlohmann::json::array(
        {{{"id", "delay"}, {"kind", "wait-duration"}, {"durationMs", 1000}, {"skippable", true}},
         {{"id", "detached-effect"},
          {"kind", "set-global-property"},
          {"property", {{"kind", "property"}, {"id", "count"}}},
          {"value", 9}}}));
    closing["terminal"] = {{"kind", "return"}, {"outcome", nullptr}};
    opening["program"]["events"] = scene_events(nlohmann::json::array(
        {{{"id", "start-detached"},
          {"kind", "start-detached-scene"},
          {"autosaveSafePoint", false},
          {"scene", {{"kind", "scene"}, {"id", "closing"}}},
          {"inputs", nlohmann::json::array()},
          {"owner", owner}},
         {{"id", "foreground-effect"},
          {"kind", "set-global-property"},
          {"property", {{"kind", "property"}, {"id", "count"}}},
          {"value", 7}},
         {{"id", "foreground-input"}, {"kind", "wait-input"}, {"skippable", false}}}));
    opening["terminal"] = {{"kind", "complete-game"}};
}

void configure_scene_fast_forward_flow(nlohmann::json& document)
{
    auto& opening = document["definitions"]["scenes"][1];
    REQUIRE(opening["id"] == "opening");
    opening["program"]["events"] = scene_events(nlohmann::json::array(
        {{{"id", "intro-text"},
          {"kind", "show-text"},
          {"autosaveSafePoint", true},
          {"speaker", nullptr},
          {"text", {{"markup", "plain"}, {"source", {{"kind", "inline"}, {"text", "Intro"}}}}},
          {"wait", "input"}},
         {{"id", "skipped-audio"},
          {"kind", "audio-cue"},
          {"owner", "invocation"},
          {"action", "play"},
          {"purpose", "sound-effect"},
          {"lifetime", "one-shot"},
          {"pausePolicy", "gameplay"},
          {"asset", {{"kind", "asset"}, {"id", "audio-voice"}}},
          {"fadeMs", 0},
          {"gain", 1.0},
          {"pan", 0.0},
          {"panSource", nullptr},
          {"waitForCompletion", true},
          {"causality", "causal"},
          {"synchronized", false},
          {"skipBehavior", "stop"},
          {"instanceId", nullptr},
          {"replacementGroup", nullptr}},
         {{"id", "semantic-effect"},
          {"kind", "set-global-property"},
          {"property", {{"kind", "property"}, {"id", "count"}}},
          {"value", 7}},
         {{"id", "skippable-delay"},
          {"kind", "wait-duration"},
          {"durationMs", 1500},
          {"skippable", true}},
         {{"id", "real-barrier"}, {"kind", "wait-input"}, {"skippable", false}},
         {{"id", "after-barrier"},
          {"kind", "set-global-property"},
          {"property", {{"kind", "property"}, {"id", "count"}}},
          {"value", 9}}}));
    opening["terminal"] = {{"kind", "complete-game"}};
}

core::CompiledProject make_dialogue_cue_project(nlohmann::json cues, std::string source_name)
{
    auto document = load_document("dialogue-program.json");
    for (auto& dialogue : document["definitions"]["dialogues"]) {
        if (dialogue["id"] != "intro")
            continue;
        dialogue["stageSlots"] = nlohmann::json::array();
        dialogue["mediaSlots"] = nlohmann::json::array();
        dialogue["program"] = {
            {"blocks",
             nlohmann::json::array(
                 {{{"id", "start"},
                   {"kind", "sequence"},
                   {"defaultSpeaker", nullptr},
                   {"segments",
                    nlohmann::json::array({{{"id", "line"},
                                            {"kind", "line"},
                                            {"autosaveSafePoint", false},
                                            {"effects", nlohmann::json::array()},
                                            {"logged", true},
                                            {"showOnce", false},
                                            {"speaker", nullptr},
                                            {"text",
                                             {{"markup", "plain"},
                                              {"source", {{"kind", "inline"}, {"text", "ABCDE"}}}}},
                                            {"cues", std::move(cues)}}})}}})},
            {"edges", nlohmann::json::array()},
            {"entryBlockId", "start"},
        };
        dialogue["completion"] = {{"kind", "end"}};
    }
    document["entrypoint"] = {{"kind", "dialogue"},
                              {"dialogue", {{"kind", "dialogue"}, {"id", "intro"}}}};
    return decode_document(std::move(document), std::move(source_name));
}

template<class T> core::StrongId<T> make_id(std::string value)
{
    auto id = core::StrongId<T>::create(std::move(value));
    REQUIRE(id);
    return std::move(id).value();
}

class FakePresentationRuntime final : public runtime::PresentationRuntimePort {
public:
    [[nodiscard]] core::Result<void, core::Diagnostics>
    reconcile_snapshot(const core::RuntimePresentationSnapshot& snapshot) override
    {
        reconciled_snapshots.push_back(snapshot);
        if (reject_reconcile ||
            (reject_reconcile_call && reconciled_snapshots.size() == *reject_reconcile_call))
            return core::Result<void, core::Diagnostics>::failure(
                {{.code = "presentation.test_reconcile_failed",
                  .message = "Test presentation service rejected snapshot reconciliation"}});
        return core::Result<void, core::Diagnostics>::success();
    }

    [[nodiscard]] core::Result<runtime::PresentationAcceptance, core::Diagnostics>
    accept(const core::PresentationOperation& operation) override
    {
        presentation_operations.push_back(operation);
        if (track_presentation_liveness) {
            active_presentation_operations.push_back(
                std::visit([](const auto& value) { return value.common.id; }, operation));
        }
        if (reject_presentation)
            return core::Result<runtime::PresentationAcceptance, core::Diagnostics>::failure(
                {{.code = "presentation.test_rejected",
                  .message = "Test presentation service rejected finite work"}});
        if (install_barrier_on_presentation_accept) {
            const auto* group = std::get_if<core::SceneTransitionGroupOperation>(&operation);
            const auto* room = std::get_if<core::RoomNavigationTransitionOperation>(&operation);
            const auto operation_id = group != nullptr && group->completion
                                          ? std::optional{group->common.id}
                                      : room != nullptr ? std::optional{room->common.id}
                                                        : std::nullopt;
            if (operation_id) {
                status.revision = core::CheckpointStatusRevision::from_number(2);
                status.active_barriers = {
                    {core::CheckpointBarrierId::from_number(1),
                     core::PresentationCheckpointBarrierSource{*operation_id},
                     core::CheckpointBarrierKind::PresentationCausalOperation}};
            }
        }
        return core::Result<runtime::PresentationAcceptance, core::Diagnostics>::success({true});
    }

    [[nodiscard]] core::Result<runtime::PresentationAcceptance, core::Diagnostics>
    accept(const core::AudioOperation& operation) override
    {
        audio_operations.push_back(operation);
        if (reject_audio) {
            return core::Result<runtime::PresentationAcceptance, core::Diagnostics>::failure(
                {{.code = "presentation.test_rejected",
                  .message = "Test presentation service rejected audio"}});
        }
        if (install_barrier_on_audio_accept) {
            status.revision = core::CheckpointStatusRevision::from_number(2);
            status.active_barriers = {{core::CheckpointBarrierId::from_number(1),
                                       core::PresentationCheckpointBarrierSource{operation.id},
                                       core::CheckpointBarrierKind::PresentationCausalOperation}};
        }
        if (reentrant_session && !nested_dispatch)
            nested_dispatch =
                reentrant_session->dispatch(core::RuntimeInputMessage{core::StopRuntimeInput{}});
        return core::Result<runtime::PresentationAcceptance, core::Diagnostics>::success({true});
    }

    [[nodiscard]] const core::PresentationCheckpointStatus&
    checkpoint_status() const noexcept override
    {
        return status;
    }

    [[nodiscard]] bool
    presentation_operation_active(core::PresentationOperationId operation) const noexcept override
    {
        return std::find(active_presentation_operations.begin(),
                         active_presentation_operations.end(),
                         operation) != active_presentation_operations.end();
    }

    void terminate(core::PresentationCancellationReason reason) override
    {
        terminations.push_back(reason);
    }

    core::PresentationCheckpointStatus status{core::CheckpointStatusRevision::from_number(1), {}};
    std::vector<core::RuntimePresentationSnapshot> reconciled_snapshots;
    std::vector<core::PresentationOperation> presentation_operations;
    std::vector<core::PresentationOperationId> active_presentation_operations;
    std::vector<core::AudioOperation> audio_operations;
    std::vector<core::PresentationCancellationReason> terminations;
    bool reject_audio = false;
    bool reject_presentation = false;
    bool reject_reconcile = false;
    std::optional<std::size_t> reject_reconcile_call;
    bool install_barrier_on_audio_accept = false;
    bool install_barrier_on_presentation_accept = false;
    bool track_presentation_liveness = false;
    TypedRuntimeSession* reentrant_session = nullptr;
    std::optional<runtime::RuntimeDispatchResult> nested_dispatch;
};

template<class T>
concept HasPublicBeginDispatchTransaction =
    requires(T& value) { value.begin_dispatch_transaction(); };

template<class T>
concept HasPublicSettleDispatchTransaction =
    requires(T& value) { value.settle_dispatch_transaction(); };

enum class DispatchArtifactKind {
    Publication,
    Notification,
    SaveOutcome,
    Observation
};

bool has_output_kind(const runtime::RuntimeDispatchResult& result, DispatchArtifactKind kind)
{
    switch (kind) {
    case DispatchArtifactKind::Publication:
        return result.publication.has_value();
    case DispatchArtifactKind::Notification:
        return std::any_of(result.events.begin(), result.events.end(), [](const auto& event) {
            return std::holds_alternative<runtime::NotificationEvent>(event);
        });
    case DispatchArtifactKind::SaveOutcome:
        return std::any_of(result.events.begin(), result.events.end(), [](const auto& event) {
            return std::holds_alternative<runtime::SaveOutcomeEvent>(event);
        });
    case DispatchArtifactKind::Observation:
        return std::any_of(result.events.begin(), result.events.end(), [](const auto& event) {
            return std::holds_alternative<runtime::ObservationEvent>(event);
        });
    }
    return false;
}

bool diagnostics_have_code(const core::Diagnostics& diagnostics, std::string_view code)
{
    for (const auto& diagnostic : diagnostics) {
        if (diagnostic.code == code || diagnostics_have_code(diagnostic.causes, code))
            return true;
    }
    return false;
}

runtime::RuntimeDispatchResult dispatch_settled(TypedRuntimeSession& session,
                                                core::RuntimeInputMessage input)
{
    return session.dispatch(input);
}

const core::TypedRuntimeUIViewState& published_view(const runtime::RuntimeDispatchResult& result)
{
    REQUIRE(result.publication.has_value());
    return result.publication->gameplay_ui;
}

class RecordingScriptPort final : public runtime::ScriptInvocationPort {
public:
    explicit RecordingScriptPort(ScriptRuntime& delegate) noexcept : m_delegate(delegate) {}

    [[nodiscard]] core::Result<runtime::ScriptInvocationOutcome, runtime::ScriptInvocationError>
    invoke(const runtime::ScriptInvocationRequest& request,
           const runtime::RuntimeCapabilitySet& capabilities) override
    {
        return m_delegate.invoke(request, capabilities);
    }

    [[nodiscard]] core::Result<runtime::ScriptInvocationOutcome, runtime::ScriptInvocationError>
    resume(const core::ScriptInvocationHandle& invocation,
           const runtime::RuntimeCapabilitySet& capabilities) override
    {
        return m_delegate.resume(invocation, capabilities);
    }

    [[nodiscard]] core::Result<runtime::ProjectHookInvocationResult, runtime::ScriptInvocationError>
    invoke_project_hook(const runtime::ProjectHookInvocationRequest& request,
                        const runtime::RuntimeCapabilitySet& capabilities) override
    {
        return m_delegate.invoke_project_hook(request, capabilities);
    }

    [[nodiscard]] core::Result<void, runtime::ScriptInvocationError>
    run_project_on_game_ready(const runtime::RuntimeCapabilitySet& capabilities) override
    {
        ++ready_calls;
        ready_profiles.push_back(capabilities.profile());
        if (fail_next_ready) {
            fail_next_ready = false;
            return core::Result<void, runtime::ScriptInvocationError>::failure(
                {.code = runtime::ScriptInvocationErrorCode::RuntimeFailed,
                 .message = "On Game Ready failed for test",
                 .chunk = "module:test#on_ready",
                 .traceback = "module:test#on_ready: failure"});
        }
        return m_delegate.run_project_on_game_ready(capabilities);
    }

    void cancel(const core::ScriptInvocationHandle& invocation,
                runtime::ScriptCancellationReason reason) override
    {
        m_delegate.cancel(invocation, reason);
    }

    void invalidate_capabilities(runtime::CapabilityGeneration generation) noexcept override
    {
        m_delegate.invalidate_capabilities(generation);
    }

    std::size_t ready_calls = 0;
    bool fail_next_ready = false;
    std::vector<runtime::RuntimeCapabilityProfile> ready_profiles;

private:
    ScriptRuntime& m_delegate;
};

struct Fixture {
    core::CompiledProject project;
    test_support::MemoryScriptSource sources;
    ScriptRuntime runtime;
    RecordingScriptPort script_port{runtime};
    FakePresentationRuntime presentation;
    core::TypedMemorySaveSlotStore saves;
    std::unique_ptr<TypedRuntimeSession> session;
    runtime::RuntimeBudgetConfiguration runtime_budget;

    explicit Fixture(std::string_view filename = "comprehensive.json",
                     runtime::RuntimeBudgetConfiguration budget = {},
                     const std::function<void(nlohmann::json&)>& amend = {})
        : project(load_project(filename, amend)), runtime_budget(budget)
    {
        REQUIRE(runtime.initialize({&sources}));
        REQUIRE(runtime.execute("function initialize_fixture() end\n"
                                "function after_enter_start() end\n"
                                "function before_leave_start() end\n"
                                "function can_leave_start() return true end\n"
                                "function can_unlock() return true end\n"
                                "function combine_items() end\n"
                                "function hall_description() return 'Hall' end\n"
                                "function key_label() return 'Key' end\n"
                                "function tower_open() return true end\n"
                                "function show_hero() return true end\n"
                                "function dynamic_line() return 'Dynamic line.' end\n"
                                "function run_scene_effect() end\n"
                                "function take_layout_branch() return false end\n"
                                "function can_transition() return true end\n"
                                "function prepare_transition() end\n"
                                "function transition_label() return 'Transition' end\n",
                                "typed-session-fixture"));
        REQUIRE(runtime.prepare_project_modules(project));
        REQUIRE(runtime.run_project_bootstrap());
        REQUIRE(runtime.freeze_project_hooks());
        auto created = test_support::create_runtime_session(project, script_port, presentation,
                                                            saves, "en", runtime_budget);
        REQUIRE(created);
        session = std::move(created).value();
    }
};

void commit_reset_candidate(Fixture& fixture)
{
    auto replacement = test_support::create_runtime_session(fixture.project, fixture.script_port,
                                                            fixture.presentation, fixture.saves,
                                                            "en", fixture.runtime_budget);
    REQUIRE(replacement);
    auto started =
        (*replacement.value_if())->dispatch(core::RuntimeInputMessage{core::StartRuntimeInput{}});
    REQUIRE(started.diagnostics.empty());
    REQUIRE_FALSE(started.session_replacement_request);
    fixture.session = std::move(*replacement.value_if());
}

void commit_load_candidate(Fixture& fixture, core::TypedSaveSlotId slot)
{
    auto replacement = runtime::RuntimeSession::restore(
        fixture.project, fixture.script_port, test_support::presentation_model(),
        fixture.presentation, fixture.saves, test_support::save_codec(), slot, "en",
        fixture.runtime_budget);
    REQUIRE(replacement);
    auto initial = (*replacement.value_if())->publish_initial_state();
    REQUIRE(initial.diagnostics.empty());
    REQUIRE_FALSE(initial.session_replacement_request);
    fixture.session = std::move(*replacement.value_if());
}

void prepare_project_scripts(ScriptRuntime& runtime, const core::CompiledProject& project)
{
    REQUIRE(
        runtime.execute("function initialize_fixture() end", "direct-session-bootstrap-fixture"));
    REQUIRE(runtime.prepare_project_modules(project));
    REQUIRE(runtime.run_project_bootstrap());
    REQUIRE(runtime.freeze_project_hooks());
}

core::Result<void, ScriptError> execute_session_lua(Fixture& fixture, std::string source,
                                                    std::string chunk_name)
{
    runtime::RuntimeCapabilityIssuer issuer(fixture.session->gateway(),
                                            fixture.session->gateway().generation());
    auto capabilities = issuer.issue(runtime::RuntimeCapabilityProfile::GameplayScript);
    REQUIRE(capabilities.has_value());
    auto invoked = fixture.runtime.invoke(
        runtime::ScriptInvocationRequest{.source = std::move(source),
                                         .chunk_name = std::move(chunk_name),
                                         .owner = std::nullopt,
                                         .invocation = std::nullopt,
                                         .source_context =
                                             fixture.session->gateway().current_source_context(),
                                         .result_kind = runtime::ScriptInvocationResultKind::None},
        *capabilities);
    if (!invoked)
        return core::Result<void, ScriptError>::failure(invoked.error());
    if (!std::holds_alternative<runtime::ScriptInvocationCompleted>(*invoked.value_if())) {
        return core::Result<void, ScriptError>::failure(
            ScriptError{.code = ScriptErrorCode::YieldForbidden,
                        .message = "Immediate test script unexpectedly suspended",
                        .chunk = "session-test",
                        .traceback = {}});
    }
    return core::Result<void, ScriptError>::success();
}

core::Result<void, ScriptError>
execute_session_lua_with_profile(Fixture& fixture, std::string source, std::string chunk_name,
                                 runtime::RuntimeCapabilityProfile profile)
{
    runtime::RuntimeCapabilityIssuer issuer(fixture.session->gateway(),
                                            fixture.session->gateway().generation());
    auto capabilities = issuer.issue(profile);
    REQUIRE(capabilities.has_value());
    auto invoked = fixture.runtime.invoke(
        runtime::ScriptInvocationRequest{.source = std::move(source),
                                         .chunk_name = std::move(chunk_name),
                                         .owner = std::nullopt,
                                         .invocation = std::nullopt,
                                         .source_context =
                                             fixture.session->gateway().current_source_context(),
                                         .result_kind = runtime::ScriptInvocationResultKind::None},
        *capabilities);
    if (!invoked)
        return core::Result<void, ScriptError>::failure(invoked.error());
    if (!std::holds_alternative<runtime::ScriptInvocationCompleted>(*invoked.value_if())) {
        return core::Result<void, ScriptError>::failure(
            ScriptError{.code = ScriptErrorCode::YieldForbidden,
                        .message = "Layout event test script unexpectedly suspended",
                        .chunk = "layout-event-test",
                        .traceback = {}});
    }
    return core::Result<void, ScriptError>::success();
}

} // namespace

TEST_CASE("typed runtime session dispatches lifecycle debug mutation save and replacement requests")
{
    STATIC_REQUIRE(std::variant_size_v<core::RuntimeInputMessage> == 37);
    Fixture fixture;
    auto started = fixture.session->dispatch(core::RuntimeInputMessage{core::StopRuntimeInput{}});
    CHECK(started.disposition == runtime::RuntimeInputDisposition::Handled);
    CHECK(has_output_kind(started, DispatchArtifactKind::Publication));

    const auto count = make_id<core::PropertyIdTag>("count");
    auto changed = dispatch_settled(
        *fixture.session,
        core::RuntimeInputMessage{core::SetVariableDebugInput{count, std::int64_t{7}}});
    CHECK(changed.disposition == runtime::RuntimeInputDisposition::Handled);
    REQUIRE(fixture.session->gateway().global_property(count));
    CHECK(fixture.session->gateway().global_property(count).value() ==
          core::RuntimeValue{std::int64_t{7}});

    const auto slot = core::TypedSaveSlotId::manual(4);
    auto saved =
        dispatch_settled(*fixture.session, core::RuntimeInputMessage{core::SaveRuntimeInput{slot}});
    REQUIRE(saved.diagnostics.empty());
    auto save_outcomes = fixture.session->take_checkpoint_save_outcomes();
    REQUIRE(save_outcomes.size() == 1);
    CHECK(std::holds_alternative<core::CheckpointWriteSucceeded>(save_outcomes.front()));
    const auto saved_bytes = fixture.saves.read_slot(slot).value();
    const auto retained_before_load = *fixture.session->checkpoint_service().latest_checkpoint();
    fixture.presentation.terminations.clear();
    (void)fixture.session->dispatch(
        core::RuntimeInputMessage{core::SetVariableDebugInput{count, std::int64_t{9}}});
    const auto retained_before_failed_load =
        *fixture.session->checkpoint_service().latest_checkpoint();
    CHECK(retained_before_failed_load.revision.number() ==
          retained_before_load.revision.number() + 1);

    const auto corrupt_slot = core::TypedSaveSlotId::manual(5);
    REQUIRE(fixture.saves.write_slot(corrupt_slot, "{corrupt"));
    auto failed_load_request =
        fixture.session->dispatch(core::RuntimeInputMessage{core::LoadRuntimeInput{corrupt_slot}});
    REQUIRE(failed_load_request.diagnostics.empty());
    REQUIRE(failed_load_request.session_replacement_request);
    const auto* corrupt_request =
        std::get_if<core::LoadRuntimeInput>(&*failed_load_request.session_replacement_request);
    REQUIRE(corrupt_request);
    CHECK(corrupt_request->slot == corrupt_slot);
    auto rejected_candidate = runtime::RuntimeSession::restore(
        fixture.project, fixture.script_port, test_support::presentation_model(),
        fixture.presentation, fixture.saves, test_support::save_codec(), corrupt_slot, "en",
        fixture.runtime_budget);
    REQUIRE_FALSE(rejected_candidate);
    CHECK(fixture.presentation.terminations.empty());
    CHECK(*fixture.session->checkpoint_service().latest_checkpoint() ==
          retained_before_failed_load);
    CHECK(fixture.session->gateway().global_property(count).value() ==
          core::RuntimeValue{std::int64_t{9}});

    auto load_request =
        fixture.session->dispatch(core::RuntimeInputMessage{core::LoadRuntimeInput{slot}});
    REQUIRE(load_request.diagnostics.empty());
    REQUIRE(load_request.session_replacement_request);
    const auto* requested_load =
        std::get_if<core::LoadRuntimeInput>(&*load_request.session_replacement_request);
    REQUIRE(requested_load);
    CHECK(requested_load->slot == slot);
    CHECK(fixture.session->gateway().global_property(count).value() ==
          core::RuntimeValue{std::int64_t{9}});

    commit_load_candidate(fixture, slot);
    REQUIRE(fixture.session->gateway().global_property(count));
    CHECK(fixture.session->gateway().global_property(count).value() ==
          core::RuntimeValue{std::int64_t{7}});
    REQUIRE(fixture.session->checkpoint_service().latest_checkpoint());
    CHECK(fixture.session->checkpoint_service().latest_checkpoint()->encoded_save == saved_bytes);
    CHECK(fixture.session->checkpoint_service().latest_checkpoint()->revision.number() == 1);
    CHECK(fixture.session->checkpoint_service().generations() == core::CheckpointGenerationState{});
}

TEST_CASE("On Game Ready runs during candidate construction before replacement commit")
{
    Fixture fixture("minimal.json");
    REQUIRE(fixture.script_port.ready_calls == 1);
    REQUIRE(fixture.script_port.ready_profiles ==
            std::vector{runtime::RuntimeCapabilityProfile::OnGameReady});

    REQUIRE(dispatch_settled(*fixture.session, core::RuntimeInputMessage{core::StartRuntimeInput{}})
                .diagnostics.empty());
    const auto slot = core::TypedSaveSlotId::manual(8);
    REQUIRE(
        dispatch_settled(*fixture.session, core::RuntimeInputMessage{core::SaveRuntimeInput{slot}})
            .diagnostics.empty());

    fixture.presentation.terminations.clear();
    fixture.script_port.fail_next_ready = true;
    auto* const live_session = fixture.session.get();
    auto reset_request =
        fixture.session->dispatch(core::RuntimeInputMessage{core::ResetRuntimeInput{}});
    REQUIRE(reset_request.diagnostics.empty());
    REQUIRE(reset_request.session_replacement_request);
    CHECK(std::holds_alternative<core::ResetRuntimeInput>(
        *reset_request.session_replacement_request));
    CHECK(fixture.script_port.ready_calls == 1);

    auto failed_reset = test_support::create_runtime_session(fixture.project, fixture.script_port,
                                                             fixture.presentation, fixture.saves,
                                                             "en", fixture.runtime_budget);
    REQUIRE_FALSE(failed_reset);
    CHECK(diagnostics_have_code(failed_reset.error(), "runtime.on_game_ready_failed"));
    CHECK(fixture.presentation.terminations.empty());
    CHECK(fixture.session.get() == live_session);
    CHECK(fixture.script_port.ready_calls == 2);

    commit_reset_candidate(fixture);
    CHECK(fixture.script_port.ready_calls == 3);

    const auto corrupt_slot = core::TypedSaveSlotId::manual(7);
    REQUIRE(fixture.saves.write_slot(corrupt_slot, "{corrupt"));
    auto corrupt_request =
        fixture.session->dispatch(core::RuntimeInputMessage{core::LoadRuntimeInput{corrupt_slot}});
    REQUIRE(corrupt_request.diagnostics.empty());
    REQUIRE(corrupt_request.session_replacement_request);
    auto corrupt = runtime::RuntimeSession::restore(
        fixture.project, fixture.script_port, test_support::presentation_model(),
        fixture.presentation, fixture.saves, test_support::save_codec(), corrupt_slot, "en",
        fixture.runtime_budget);
    REQUIRE_FALSE(corrupt);
    CHECK(fixture.script_port.ready_calls == 3);

    fixture.presentation.terminations.clear();
    auto load_request =
        fixture.session->dispatch(core::RuntimeInputMessage{core::LoadRuntimeInput{slot}});
    REQUIRE(load_request.diagnostics.empty());
    REQUIRE(load_request.session_replacement_request);
    commit_load_candidate(fixture, slot);
    CHECK(fixture.script_port.ready_calls == 4);
    CHECK(fixture.script_port.ready_profiles.back() ==
          runtime::RuntimeCapabilityProfile::OnGameReady);
}

TEST_CASE("reset replacement request leaves live checkpoint state untouched until candidate commit")
{
    Fixture fixture("minimal.json");
    REQUIRE(dispatch_settled(*fixture.session, core::RuntimeInputMessage{core::StartRuntimeInput{}})
                .diagnostics.empty());
    REQUIRE(fixture.session->checkpoint_service().latest_checkpoint());
    fixture.presentation.terminations.clear();

    const auto checkpoint_before = *fixture.session->checkpoint_service().latest_checkpoint();
    auto reset_request =
        dispatch_settled(*fixture.session, core::RuntimeInputMessage{core::ResetRuntimeInput{}});
    REQUIRE(reset_request.diagnostics.empty());
    REQUIRE(reset_request.session_replacement_request);
    CHECK(std::holds_alternative<core::ResetRuntimeInput>(
        *reset_request.session_replacement_request));
    CHECK(fixture.presentation.terminations.empty());
    CHECK(*fixture.session->checkpoint_service().latest_checkpoint() == checkpoint_before);

    commit_reset_candidate(fixture);
    REQUIRE(fixture.session->checkpoint_service().latest_checkpoint());
}

TEST_CASE("stop and candidate replacement cancel staged runtime commands without mutation")
{
    Fixture fixture;
    const auto key = make_id<core::InteractableIdTag>("key");
    const auto original = fixture.session->gateway().interactable_location(key);
    REQUIRE(original);
    const auto* original_room = std::get_if<core::compiled::RoomLocation>(original.value_if());
    REQUIRE(original_room != nullptr);

    const auto missing = make_id<core::InteractableIdTag>("missing");
    auto invalid = fixture.session->gateway().request_interactable_location(
        missing, player_inventory_location());
    REQUIRE_FALSE(invalid);
    CHECK(fixture.session->pending_command_count() == 0);

    REQUIRE(
        fixture.session->gateway().request_interactable_location(key, player_inventory_location()));
    REQUIRE(fixture.session->dispatch(core::RuntimeInputMessage{core::StopRuntimeInput{}})
                .diagnostics.empty());
    auto after_stop = fixture.session->gateway().interactable_location(key);
    REQUIRE(after_stop);
    const auto* stopped_room = std::get_if<core::compiled::RoomLocation>(after_stop.value_if());
    REQUIRE(stopped_room != nullptr);
    CHECK(stopped_room->room == original_room->room);
    CHECK(fixture.session->pending_command_count() == 0);

    REQUIRE(
        fixture.session->gateway().request_interactable_location(key, player_inventory_location()));
    commit_reset_candidate(fixture);
    auto after_reset = fixture.session->gateway().interactable_location(key);
    REQUIRE(after_reset);
    const auto* reset_room = std::get_if<core::compiled::RoomLocation>(after_reset.value_if());
    REQUIRE(reset_room != nullptr);
    CHECK(reset_room->room == original_room->room);
    CHECK(fixture.session->pending_command_count() == 0);
}

TEST_CASE("successful load candidate discards commands staged against the replaced session state")
{
    Fixture fixture;
    const auto key = make_id<core::InteractableIdTag>("key");
    REQUIRE(dispatch_settled(*fixture.session, core::RuntimeInputMessage{core::StartRuntimeInput{}})
                .diagnostics.empty());
    const auto slot = core::TypedSaveSlotId::manual(6);
    REQUIRE(
        dispatch_settled(*fixture.session, core::RuntimeInputMessage{core::SaveRuntimeInput{slot}})
            .diagnostics.empty());

    REQUIRE(
        fixture.session->gateway().request_interactable_location(key, player_inventory_location()));
    commit_load_candidate(fixture, slot);
    CHECK(fixture.session->pending_command_count() == 0);
    const auto location = fixture.session->gateway().interactable_location(key);
    REQUIRE(location);
    CHECK(std::holds_alternative<core::compiled::RoomLocation>(location.value()));
}

TEST_CASE("typed runtime session starts a representative Room session")
{
    Fixture fixture("minimal.json");
    auto started = fixture.session->dispatch(core::RuntimeInputMessage{core::StartRuntimeInput{}});
    CHECK(started.disposition == runtime::RuntimeInputDisposition::Handled);
    const auto& view = published_view(started);
    REQUIRE(view.room);
    CHECK(view.room->room.text() == "start");
}

TEST_CASE("Room descriptions are transient ActiveText messages for each Room visit")
{
    Fixture fixture("minimal.json");
    auto started = fixture.session->dispatch(core::RuntimeInputMessage{core::StartRuntimeInput{}});
    REQUIRE(started.publication);
    REQUIRE(started.publication->gameplay_ui.room);
    CHECK(started.publication->gameplay_ui.room->description == "Minimal room.");
    CHECK(started.publication->gameplay_ui.can_continue);

    auto dismissed = fixture.session->dispatch(core::RuntimeInputMessage{core::ContinueInput{}});
    CHECK(dismissed.disposition == runtime::RuntimeInputDisposition::Handled);
    REQUIRE(dismissed.publication);
    REQUIRE(dismissed.publication->gameplay_ui.room);
    CHECK(dismissed.publication->gameplay_ui.room->description.empty());
    CHECK_FALSE(dismissed.publication->gameplay_ui.can_continue);

    auto redundant = fixture.session->dispatch(core::RuntimeInputMessage{core::ContinueInput{}});
    CHECK(redundant.disposition == runtime::RuntimeInputDisposition::Unhandled);
    CHECK_FALSE(redundant.publication);
}

TEST_CASE("typed Room navigation input commits the default Cut transition")
{
    Fixture fixture("comprehensive.json");
    auto started = fixture.session->dispatch(core::RuntimeInputMessage{core::StartRuntimeInput{}});
    REQUIRE(started.diagnostics.empty());
    REQUIRE(started.publication);
    REQUIRE(started.publication->gameplay_ui.room);
    CHECK(started.publication->gameplay_ui.room->room == make_id<core::RoomIdTag>("start"));

    auto navigated = fixture.session->dispatch(core::RuntimeInputMessage{
        core::NavigateRoomInput{make_id<core::RoomExitIdTag>("north-exit")}});
    REQUIRE(navigated.diagnostics.empty());
    CHECK(navigated.disposition == runtime::RuntimeInputDisposition::Handled);
    REQUIRE(navigated.publication);
    REQUIRE(navigated.publication->gameplay_ui.room);
    CHECK(navigated.publication->gameplay_ui.room->room == make_id<core::RoomIdTag>("hall"));
    CHECK(navigated.publication->presentation.current_room == make_id<core::RoomIdTag>("hall"));
    CHECK(fixture.presentation.presentation_operations.empty());
}

TEST_CASE("failed Room recomposition republishes diagnostics with the prior complete target")
{
    auto document = load_document("minimal.json");
    document["properties"] = nlohmann::json::array({{{"id", "flag"},
                                                     {"label", "Flag"},
                                                     {"description", ""},
                                                     {"type", "boolean"},
                                                     {"nullable", false},
                                                     {"defaultValue", false},
                                                     {"enumValues", nlohmann::json::array()},
                                                     {"scope", "global"}}});
    document["definitions"]["rooms"][0]["description"] = {
        {"markup", "plain"},
        {"source", {{"kind", "lua-expression"}, {"source", "room_description()"}}}};
    auto project = decode_document(std::move(document), "room-recomposition-failure.json");
    test_support::MemoryScriptSource sources;
    ScriptRuntime scripts;
    REQUIRE(scripts.initialize({&sources}));
    REQUIRE(scripts.execute("function room_description() return 'Stable room.' end",
                            "room-recomposition-stable"));
    prepare_project_scripts(scripts, project);
    FakePresentationRuntime presentation;
    core::TypedMemorySaveSlotStore saves;
    auto created =
        test_support::create_runtime_session(project, scripts, presentation, saves, "en");
    REQUIRE(created);
    auto session = std::move(created).value();

    auto started = session->dispatch(core::RuntimeInputMessage{core::StartRuntimeInput{}});
    REQUIRE(started.publication);
    REQUIRE(started.publication->gameplay_ui.room);
    CHECK(started.publication->gameplay_ui.room->description == "Stable room.");
    const auto previous = *started.publication;

    REQUIRE(scripts.execute("function room_description() error('composition failed') end",
                            "room-recomposition-failure"));
    auto failed = session->dispatch(core::RuntimeInputMessage{
        core::SetVariableDebugInput{make_id<core::PropertyIdTag>("flag"), true}});
    REQUIRE(failed.publication);
    CHECK(failed.disposition == runtime::RuntimeInputDisposition::Handled);
    CHECK(failed.publication->revision.number() == previous.revision.number() + 1);
    CHECK(failed.publication->gameplay_ui.mode == previous.gameplay_ui.mode);
    CHECK(failed.publication->gameplay_ui.gameplay_paused == previous.gameplay_ui.gameplay_paused);
    CHECK(failed.publication->gameplay_ui.can_continue == previous.gameplay_ui.can_continue);
    REQUIRE(failed.publication->gameplay_ui.room);
    REQUIRE(previous.gameplay_ui.room);
    CHECK(failed.publication->gameplay_ui.room->room == previous.gameplay_ui.room->room);
    CHECK(failed.publication->gameplay_ui.room->visits == previous.gameplay_ui.room->visits);
    CHECK(failed.publication->gameplay_ui.room->description ==
          previous.gameplay_ui.room->description);
    CHECK(failed.publication->presentation == previous.presentation);
    const auto diagnostic = std::find_if(
        failed.publication->observations.values.begin(),
        failed.publication->observations.values.end(), [](const auto& observation) {
            return std::holds_alternative<core::RoomPresentationDiagnosticObservation>(observation);
        });
    REQUIRE(diagnostic != failed.publication->observations.values.end());
    const auto& room_diagnostic =
        std::get<core::RoomPresentationDiagnosticObservation>(*diagnostic);
    CHECK(room_diagnostic.room == make_id<core::RoomIdTag>("start"));
    REQUIRE_FALSE(room_diagnostic.diagnostics.empty());
}

TEST_CASE("typed runtime session captures only at settled dirty transaction boundaries")
{
    Fixture fixture("minimal.json");
    REQUIRE(fixture.session->checkpoint_service().latest_checkpoint());
    const auto creation = *fixture.session->checkpoint_service().latest_checkpoint();
    CHECK(creation.revision.number() == 1);

    auto started =
        dispatch_settled(*fixture.session, core::RuntimeInputMessage{core::StartRuntimeInput{}});
    REQUIRE(started.disposition == runtime::RuntimeInputDisposition::Handled);
    REQUIRE(fixture.session->checkpoint_service().latest_checkpoint());
    const auto initial = *fixture.session->checkpoint_service().latest_checkpoint();
    CHECK(initial.revision.number() >= creation.revision.number());

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
    CHECK(fixture.session->checkpoint_service().latest_checkpoint()->revision.number() ==
          initial.revision.number() + 1);
    CHECK(fixture.session->checkpoint_service().generations().time_generation == 2);
    CHECK(fixture.session->checkpoint_service().generations().captured_time_generation == 2);
}

TEST_CASE("runtime checkpoint settlement consumes coordinator-owned presentation status")
{
    Fixture fixture("minimal.json");
    const auto operation = core::PresentationOperationId::from_number(44);
    core::PresentationCheckpointStatus status{
        core::CheckpointStatusRevision::from_number(2),
        {{core::CheckpointBarrierId::from_number(1),
          core::PresentationCheckpointBarrierSource{operation},
          core::CheckpointBarrierKind::PresentationCausalOperation}}};
    fixture.presentation.status = status;

    REQUIRE(dispatch_settled(*fixture.session, core::RuntimeInputMessage{core::StartRuntimeInput{}})
                .diagnostics.empty());
    CHECK_FALSE(fixture.session->checkpoint_service().readiness().can_capture());

    fixture.presentation.status.active_barriers.clear();
    fixture.presentation.status.revision = core::CheckpointStatusRevision::from_number(3);
    REQUIRE(dispatch_settled(*fixture.session, core::RuntimeInputMessage{core::StopRuntimeInput{}})
                .diagnostics.empty());
    CHECK(fixture.session->checkpoint_service().readiness().can_capture());
}

TEST_CASE("internal runtime commands settle before checkpoint evaluation")
{
    Fixture fixture("interaction-program.json");
    REQUIRE(dispatch_settled(*fixture.session, core::RuntimeInputMessage{core::StopRuntimeInput{}})
                .diagnostics.empty());
    REQUIRE(dispatch_settled(*fixture.session, core::RuntimeInputMessage{core::StartRuntimeInput{}})
                .diagnostics.empty());
    const auto use = make_id<core::VerbIdTag>("use");
    const auto key = make_id<core::InteractableIdTag>("key");
    auto invoked = dispatch_settled(*fixture.session,
                                    core::RuntimeInputMessage{core::InvokeInteractionInput{
                                        use,
                                        {{make_id<core::VerbSlotIdTag>("target"),
                                          core::compiled::InteractableInteractionSubject{key}}}}});
    REQUIRE(invoked.disposition == runtime::RuntimeInputDisposition::Handled);
    CHECK(fixture.session->pending_command_count() == 0);
    const auto location = fixture.session->gateway().interactable_location(key);
    REQUIRE(location);
    CHECK(std::holds_alternative<core::compiled::InventoryLocation>(location.value()));
    const auto& issues = fixture.session->checkpoint_service().readiness().issues;
    CHECK(std::none_of(issues.begin(), issues.end(), [](const auto& issue) {
        return issue.reason == core::CheckpointReadinessReason::RuntimeQueueUnsettled;
    }));
}

TEST_CASE("semantic Verb menu publication never auto-selects a primary Offer")
{
    Fixture fixture("interaction-program.json");
    REQUIRE(dispatch_settled(*fixture.session, core::RuntimeInputMessage{core::StartRuntimeInput{}})
                .diagnostics.empty());
    const auto key = make_id<core::InteractableIdTag>("key");
    const core::compiled::InteractionSubject subject =
        core::compiled::InteractableInteractionSubject{key};

    auto opened = dispatch_settled(*fixture.session,
                                   core::RuntimeInputMessage{core::OpenVerbMenuInput{subject}});
    REQUIRE(opened.diagnostics.empty());
    REQUIRE(opened.publication);
    const auto& view = opened.publication->gameplay_ui;
    CHECK(view.verb_menu_open);
    REQUIRE(view.selected_subjects == std::vector<core::compiled::InteractionSubject>{subject});
    const auto use =
        std::find_if(view.verb_offers.begin(), view.verb_offers.end(), [](const auto& offer) {
            return offer.verb == make_id<core::VerbIdTag>("use");
        });
    REQUIRE(use != view.verb_offers.end());
    CHECK(use->primary);
    CHECK(view.mode == "room");
    const auto location = fixture.session->gateway().interactable_location(key);
    REQUIRE(location);
    CHECK(std::holds_alternative<core::compiled::RoomLocation>(location.value()));
}

TEST_CASE("Primary Activate executes the unique primary Verb Offer")
{
    Fixture fixture("interaction-program.json");
    REQUIRE(dispatch_settled(*fixture.session, core::RuntimeInputMessage{core::StartRuntimeInput{}})
                .diagnostics.empty());
    const auto key = make_id<core::InteractableIdTag>("key");
    const core::compiled::InteractionSubject subject =
        core::compiled::InteractableInteractionSubject{key};

    auto activated = dispatch_settled(
        *fixture.session, core::RuntimeInputMessage{core::PrimaryActivateInput{subject}});
    REQUIRE(activated.diagnostics.empty());
    const auto location = fixture.session->gateway().interactable_location(key);
    REQUIRE(location);
    CHECK(std::holds_alternative<core::compiled::InventoryLocation>(location.value()));
    REQUIRE(activated.publication);
    CHECK_FALSE(activated.publication->gameplay_ui.verb_menu_open);
}

TEST_CASE("ambiguous primary Verb Offers diagnose and open the ordinary menu")
{
    Fixture fixture("interaction-program.json", {}, [](nlohmann::json& document) {
        auto& verbs = document["definitions"]["verbs"];
        auto inspect = std::find_if(verbs.begin(), verbs.end(),
                                    [](const auto& verb) { return verb["id"] == "inspect"; });
        REQUIRE(inspect != verbs.end());
        (*inspect)["offers"].push_back(
            {{"id", "inspect-key"},
             {"slotId", "target"},
             {"selectors",
              nlohmann::json::array(
                  {{{"kind", "exact"},
                    {"subject",
                     {{"kind", "interactable"},
                      {"interactable", {{"kind", "interactable"}, {"id", "key"}}}}}}})},
             {"rank", 1},
             {"primary", true}});
    });
    REQUIRE(dispatch_settled(*fixture.session, core::RuntimeInputMessage{core::StartRuntimeInput{}})
                .diagnostics.empty());
    const auto key = make_id<core::InteractableIdTag>("key");
    const core::compiled::InteractionSubject subject =
        core::compiled::InteractableInteractionSubject{key};

    auto activated = dispatch_settled(
        *fixture.session, core::RuntimeInputMessage{core::PrimaryActivateInput{subject}});
    REQUIRE(activated.diagnostics.empty());
    REQUIRE(activated.publication);
    CHECK(activated.publication->gameplay_ui.verb_menu_open);
    const auto location = fixture.session->gateway().interactable_location(key);
    REQUIRE(location);
    CHECK(std::holds_alternative<core::compiled::RoomLocation>(location.value()));
    const auto ambiguity =
        std::find_if(activated.events.begin(), activated.events.end(), [](const auto& event) {
            const auto* observation = std::get_if<runtime::ObservationEvent>(&event);
            return observation && std::holds_alternative<core::VerbOfferAmbiguityObservation>(
                                      observation->observation);
        });
    REQUIRE(ambiguity != activated.events.end());
    const auto& detail = std::get<core::VerbOfferAmbiguityObservation>(
        std::get<runtime::ObservationEvent>(*ambiguity).observation);
    CHECK(detail.primary_verbs.size() == 2);
}

TEST_CASE(
    "Command Builder publishes watched references rejects stale occurrences and submits atomically")
{
    Fixture fixture("interaction-program.json", {}, [](nlohmann::json& document) {
        for (auto& verb : document["definitions"]["verbs"]) {
            if (verb["id"] != "combine")
                continue;
            verb["offers"].push_back(
                {{"id", "combine-key"},
                 {"slotId", "first"},
                 {"selectors",
                  nlohmann::json::array(
                      {{{"kind", "exact"},
                        {"subject",
                         {{"kind", "interactable"},
                          {"interactable", {{"kind", "interactable"}, {"id", "key"}}}}}}})},
                 {"rank", 0},
                 {"primary", false}});
        }
        for (auto& interaction : document["definitions"]["interactions"]) {
            if (interaction["id"] != "actions")
                continue;
            for (auto& rule : interaction["rules"]) {
                if (rule["id"] == "predicate-context") {
                    rule["slots"][1]["selectors"][0]["subject"]["interactable"]["id"] = "key";
                    rule["program"]["instructions"] = nlohmann::json::array();
                    rule["program"]["outcome"] = "handled";
                }
            }
        }
    });
    REQUIRE(dispatch_settled(*fixture.session, core::RuntimeInputMessage{core::StartRuntimeInput{}})
                .diagnostics.empty());

    const auto key = make_id<core::InteractableIdTag>("key");
    const core::compiled::InteractionSubject key_subject =
        core::compiled::InteractableInteractionSubject{key};
    REQUIRE(dispatch_settled(
                *fixture.session,
                core::RuntimeInputMessage{core::SelectInteractionSubjectsInput{{key_subject}}})
                .diagnostics.empty());

    auto begun = dispatch_settled(
        *fixture.session, core::RuntimeInputMessage{core::BeginCommandBuilderInput{{key_subject}}});
    REQUIRE(begun.diagnostics.empty());
    REQUIRE(begun.publication);
    REQUIRE(begun.publication->gameplay_ui.command_builder.active);
    REQUIRE(begun.publication->gameplay_ui.command_builder.occurrence);
    const auto occurrence = *begun.publication->gameplay_ui.command_builder.occurrence;
    REQUIRE(begun.publication->gameplay_ui.command_builder.watched.size() == 1);
    const auto& watched_key = begun.publication->gameplay_ui.command_builder.watched.front();
    CHECK(watched_key.subject == key_subject);
    CHECK(watched_key.live);
    CHECK(watched_key.available);
    CHECK(watched_key.enabled);
    CHECK(watched_key.visible);
    REQUIRE(watched_key.effective_room);
    CHECK(*watched_key.effective_room == make_id<core::RoomIdTag>("start"));
    CHECK(std::any_of(watched_key.offers.begin(), watched_key.offers.end(), [](const auto& offer) {
        return offer.verb == make_id<core::VerbIdTag>("combine");
    }));

    auto captured = dispatch_settled(
        *fixture.session,
        core::RuntimeInputMessage{core::CommandBuilderSubjectPressInput{occurrence, key_subject}});
    REQUIRE(captured.diagnostics.empty());
    REQUIRE(captured.publication);
    REQUIRE(captured.publication->gameplay_ui.command_builder.captured_subject);
    CHECK(*captured.publication->gameplay_ui.command_builder.captured_subject == key_subject);
    CHECK(captured.publication->gameplay_ui.command_builder.capture_revision == 1);

    auto watched = dispatch_settled(*fixture.session,
                                    core::RuntimeInputMessage{core::UpdateCommandBuilderWatchInput{
                                        occurrence, {key_subject, key_subject}}});
    REQUIRE(watched.diagnostics.empty());
    REQUIRE(watched.publication);
    CHECK(watched.publication->gameplay_ui.command_builder.watched.size() == 1);

    REQUIRE(fixture.session->gateway().request_interactable_state(key, std::nullopt, std::nullopt,
                                                                  false));
    auto hidden =
        dispatch_settled(*fixture.session, core::RuntimeInputMessage{core::AdvanceTimeInput{}});
    REQUIRE(hidden.diagnostics.empty());
    REQUIRE(hidden.publication);
    REQUIRE(hidden.publication->gameplay_ui.command_builder.watched.size() == 1);
    CHECK_FALSE(hidden.publication->gameplay_ui.command_builder.watched.front().visible);

    REQUIRE(fixture.session->gateway().request_interactable_state(key, std::nullopt, std::nullopt,
                                                                  true));
    auto restored =
        dispatch_settled(*fixture.session, core::RuntimeInputMessage{core::AdvanceTimeInput{}});
    REQUIRE(restored.diagnostics.empty());
    REQUIRE(restored.publication);
    REQUIRE(restored.publication->gameplay_ui.command_builder.watched.size() == 1);
    CHECK(restored.publication->gameplay_ui.command_builder.watched.front().visible);

    const auto stale_occurrence =
        core::CommandBuilderOccurrenceId::from_number(occurrence.number() + 1);
    auto stale = dispatch_settled(*fixture.session,
                                  core::RuntimeInputMessage{core::CommandBuilderSubjectPressInput{
                                      stale_occurrence, key_subject}});
    REQUIRE_FALSE(stale.diagnostics.empty());
    CHECK(stale.diagnostics.front().code == "runtime.stale_command_builder_occurrence");

    auto submitted = dispatch_settled(
        *fixture.session, core::RuntimeInputMessage{core::SubmitCommandBuilderInput{
                              occurrence,
                              make_id<core::VerbIdTag>("combine"),
                              {{make_id<core::VerbSlotIdTag>("first"), key_subject},
                               {make_id<core::VerbSlotIdTag>("second"), key_subject}}}});
    if (!submitted.diagnostics.empty())
        INFO(submitted.diagnostics.front().code << ": " << submitted.diagnostics.front().message);
    REQUIRE(submitted.diagnostics.empty());
    REQUIRE(submitted.publication);
    CHECK_FALSE(submitted.publication->gameplay_ui.command_builder.active);
    CHECK_FALSE(submitted.publication->gameplay_ui.command_builder.occurrence);
}

TEST_CASE("Command Builder is transient and terminates on runtime lifecycle changes")
{
    Fixture fixture("interaction-program.json");
    REQUIRE(dispatch_settled(*fixture.session, core::RuntimeInputMessage{core::StartRuntimeInput{}})
                .diagnostics.empty());
    const core::compiled::InteractionSubject subject =
        core::compiled::InteractableInteractionSubject{make_id<core::InteractableIdTag>("key")};
    REQUIRE(
        dispatch_settled(*fixture.session,
                         core::RuntimeInputMessage{core::SelectInteractionSubjectsInput{{subject}}})
            .diagnostics.empty());

    auto begun = dispatch_settled(
        *fixture.session, core::RuntimeInputMessage{core::BeginCommandBuilderInput{{subject}}});
    REQUIRE(begun.diagnostics.empty());
    REQUIRE(begun.publication);
    REQUIRE(begun.publication->gameplay_ui.command_builder.occurrence);
    const auto occurrence = *begun.publication->gameplay_ui.command_builder.occurrence;

    const auto require_stale_occurrence = [&]() {
        auto stale = dispatch_settled(
            *fixture.session,
            core::RuntimeInputMessage{core::CancelCommandBuilderInput{occurrence}});
        REQUIRE_FALSE(stale.diagnostics.empty());
        CHECK(stale.diagnostics.front().code == "runtime.stale_command_builder_occurrence");
    };

    SECTION("stop")
    {
        auto stopped =
            dispatch_settled(*fixture.session, core::RuntimeInputMessage{core::StopRuntimeInput{}});
        REQUIRE(stopped.diagnostics.empty());
        require_stale_occurrence();
    }

    SECTION("reset")
    {
        auto reset = dispatch_settled(*fixture.session,
                                      core::RuntimeInputMessage{core::ResetRuntimeInput{}});
        REQUIRE(reset.diagnostics.empty());
        REQUIRE(reset.session_replacement_request);
        require_stale_occurrence();
    }

    SECTION("load")
    {
        const auto slot = core::TypedSaveSlotId::manual(6);
        REQUIRE(dispatch_settled(*fixture.session,
                                 core::RuntimeInputMessage{core::SaveRuntimeInput{slot}})
                    .diagnostics.empty());
        REQUIRE_FALSE(fixture.session->take_checkpoint_save_outcomes().empty());
        auto load = dispatch_settled(*fixture.session,
                                     core::RuntimeInputMessage{core::LoadRuntimeInput{slot}});
        REQUIRE(load.diagnostics.empty());
        REQUIRE(load.session_replacement_request);
        require_stale_occurrence();
    }

    SECTION("Room transition")
    {
        REQUIRE(
            dispatch_settled(*fixture.session,
                             core::RuntimeInputMessage{core::SetVariableDebugInput{
                                 make_id<core::PropertyIdTag>("flag"), core::RuntimeValue{true}}})
                .diagnostics.empty());
        auto navigated =
            dispatch_settled(*fixture.session, core::RuntimeInputMessage{core::NavigateRoomInput{
                                                   make_id<core::RoomExitIdTag>("north-exit")}});
        REQUIRE(navigated.diagnostics.empty());
        REQUIRE(navigated.publication);
        REQUIRE(navigated.publication->gameplay_ui.room);
        CHECK(navigated.publication->gameplay_ui.room->room == make_id<core::RoomIdTag>("hall"));
        CHECK_FALSE(navigated.publication->gameplay_ui.command_builder.active);
        require_stale_occurrence();
    }
}

TEST_CASE("Command Builder enforces runtime capture authority")
{
    Fixture fixture("interaction-program.json");
    REQUIRE(dispatch_settled(*fixture.session, core::RuntimeInputMessage{core::StartRuntimeInput{}})
                .diagnostics.empty());
    const core::compiled::InteractionSubject key_subject =
        core::compiled::InteractableInteractionSubject{make_id<core::InteractableIdTag>("key")};
    const core::compiled::InteractionSubject unauthorized_subject =
        core::compiled::InteractableInteractionSubject{make_id<core::InteractableIdTag>("coin")};
    const core::compiled::InteractionSubject door_subject =
        core::compiled::FeatureInteractionSubject{core::RoomFeatureRef{
            make_id<core::RoomIdTag>("start"), make_id<core::FeatureIdTag>("door")}};
    REQUIRE(dispatch_settled(
                *fixture.session,
                core::RuntimeInputMessage{core::SelectInteractionSubjectsInput{{key_subject}}})
                .diagnostics.empty());

    auto begun = dispatch_settled(
        *fixture.session, core::RuntimeInputMessage{core::BeginCommandBuilderInput{{key_subject}}});
    REQUIRE(begun.diagnostics.empty());
    REQUIRE(begun.publication);
    REQUIRE(begun.publication->gameplay_ui.command_builder.occurrence);
    const auto occurrence = *begun.publication->gameplay_ui.command_builder.occurrence;

    auto unauthorized_watch = dispatch_settled(
        *fixture.session, core::RuntimeInputMessage{core::UpdateCommandBuilderWatchInput{
                              occurrence, {key_subject, unauthorized_subject}}});
    REQUIRE_FALSE(unauthorized_watch.diagnostics.empty());
    CHECK(unauthorized_watch.diagnostics.front().code ==
          "runtime.command_builder_unauthorized_subject");

    auto world_capture = dispatch_settled(
        *fixture.session, core::RuntimeInputMessage{core::PrimaryActivateInput{door_subject}});
    REQUIRE(world_capture.diagnostics.empty());
    REQUIRE(world_capture.publication);
    REQUIRE(world_capture.publication->gameplay_ui.command_builder.captured_subject);
    CHECK(*world_capture.publication->gameplay_ui.command_builder.captured_subject == door_subject);

    auto authorized_watch = dispatch_settled(
        *fixture.session, core::RuntimeInputMessage{core::UpdateCommandBuilderWatchInput{
                              occurrence, {key_subject, door_subject}}});
    REQUIRE(authorized_watch.diagnostics.empty());
    REQUIRE(authorized_watch.publication);
    CHECK(authorized_watch.publication->gameplay_ui.command_builder.watched.size() == 2);

    auto unauthorized_submit = dispatch_settled(
        *fixture.session, core::RuntimeInputMessage{core::SubmitCommandBuilderInput{
                              occurrence,
                              make_id<core::VerbIdTag>("combine"),
                              {{make_id<core::VerbSlotIdTag>("first"), key_subject},
                               {make_id<core::VerbSlotIdTag>("second"), unauthorized_subject}}}});
    REQUIRE_FALSE(unauthorized_submit.diagnostics.empty());
    CHECK(unauthorized_submit.diagnostics.front().code ==
          "runtime.command_builder_unauthorized_subject");
}

TEST_CASE("Command Builder transient Draft state does not change saved gameplay")
{
    Fixture fixture("interaction-program.json");
    REQUIRE(dispatch_settled(*fixture.session, core::RuntimeInputMessage{core::StartRuntimeInput{}})
                .diagnostics.empty());
    const auto baseline_slot = core::TypedSaveSlotId::manual(6);
    REQUIRE(dispatch_settled(*fixture.session,
                             core::RuntimeInputMessage{core::SaveRuntimeInput{baseline_slot}})
                .diagnostics.empty());
    REQUIRE_FALSE(fixture.session->take_checkpoint_save_outcomes().empty());
    const auto baseline_save = fixture.saves.read_slot(baseline_slot);
    REQUIRE(baseline_save);

    const core::compiled::InteractionSubject key_subject =
        core::compiled::InteractableInteractionSubject{make_id<core::InteractableIdTag>("key")};
    REQUIRE(dispatch_settled(
                *fixture.session,
                core::RuntimeInputMessage{core::SelectInteractionSubjectsInput{{key_subject}}})
                .diagnostics.empty());
    auto begun = dispatch_settled(
        *fixture.session, core::RuntimeInputMessage{core::BeginCommandBuilderInput{{key_subject}}});
    REQUIRE(begun.diagnostics.empty());
    REQUIRE(begun.publication);
    CHECK(begun.publication->gameplay_ui.command_builder.active);

    const auto builder_slot = core::TypedSaveSlotId::manual(7);
    REQUIRE(dispatch_settled(*fixture.session,
                             core::RuntimeInputMessage{core::SaveRuntimeInput{builder_slot}})
                .diagnostics.empty());
    REQUIRE_FALSE(fixture.session->take_checkpoint_save_outcomes().empty());
    const auto builder_save = fixture.saves.read_slot(builder_slot);
    REQUIRE(builder_save);
    CHECK(*builder_save.value_if() == *baseline_save.value_if());
}

TEST_CASE("Command Builder terminates after an accepted direct control command")
{
    Fixture fixture("interaction-program.json");
    REQUIRE(dispatch_settled(*fixture.session, core::RuntimeInputMessage{core::StartRuntimeInput{}})
                .diagnostics.empty());
    const core::compiled::InteractionSubject key_subject =
        core::compiled::InteractableInteractionSubject{make_id<core::InteractableIdTag>("key")};
    REQUIRE(dispatch_settled(
                *fixture.session,
                core::RuntimeInputMessage{core::SelectInteractionSubjectsInput{{key_subject}}})
                .diagnostics.empty());
    auto begun = dispatch_settled(
        *fixture.session, core::RuntimeInputMessage{core::BeginCommandBuilderInput{{key_subject}}});
    REQUIRE(begun.diagnostics.empty());
    REQUIRE(begun.publication);
    REQUIRE(begun.publication->gameplay_ui.command_builder.occurrence);
    const auto occurrence = *begun.publication->gameplay_ui.command_builder.occurrence;

    auto invoked = dispatch_settled(*fixture.session,
                                    core::RuntimeInputMessage{core::InvokeInteractionInput{
                                        make_id<core::VerbIdTag>("use"),
                                        {{make_id<core::VerbSlotIdTag>("target"), key_subject}}}});
    REQUIRE(invoked.diagnostics.empty());
    REQUIRE(invoked.publication);
    CHECK_FALSE(invoked.publication->gameplay_ui.command_builder.active);

    auto stale = dispatch_settled(
        *fixture.session, core::RuntimeInputMessage{core::CancelCommandBuilderInput{occurrence}});
    REQUIRE_FALSE(stale.diagnostics.empty());
    CHECK(stale.diagnostics.front().code == "runtime.stale_command_builder_occurrence");
}

TEST_CASE("deferred runtime commands execute inside one outer transaction")
{
    Fixture fixture("interaction-program.json");
    REQUIRE(dispatch_settled(*fixture.session, core::RuntimeInputMessage{core::StartRuntimeInput{}})
                .diagnostics.empty());
    auto invoked = fixture.session->dispatch(core::RuntimeInputMessage{core::InvokeInteractionInput{
        make_id<core::VerbIdTag>("use"),
        {{make_id<core::VerbSlotIdTag>("target"), core::compiled::InteractableInteractionSubject{
                                                      make_id<core::InteractableIdTag>("key")}}}}});
    REQUIRE(invoked.diagnostics.empty());
    CHECK(fixture.session->pending_command_count() == 0);
    const auto location =
        fixture.session->gateway().interactable_location(make_id<core::InteractableIdTag>("key"));
    REQUIRE(location);
    CHECK(std::holds_alternative<core::compiled::InventoryLocation>(location.value()));
    CHECK(std::none_of(
        fixture.session->checkpoint_service().readiness().issues.begin(),
        fixture.session->checkpoint_service().readiness().issues.end(), [](const auto& issue) {
            return issue.reason == core::CheckpointReadinessReason::RuntimeQueueUnsettled;
        }));
}

TEST_CASE("detached Scene duration work is non-awaited and advances beside foreground Flow")
{
    Fixture fixture("scene-program.json", {}, [](nlohmann::json& document) {
        configure_detached_duration_flow(document, "flow");
    });
    const auto count = make_id<core::PropertyIdTag>("count");

    auto started = fixture.session->dispatch(core::RuntimeInputMessage{core::StartRuntimeInput{}});
    REQUIRE(started.diagnostics.empty());
    REQUIRE(fixture.session->gateway().global_property(count));
    CHECK(fixture.session->gateway().global_property(count).value() ==
          core::RuntimeValue{std::int64_t{7}});
    REQUIRE(fixture.session->presentation_state().blocker());
    CHECK(std::holds_alternative<core::InputFlowBlocker>(
        *fixture.session->presentation_state().blocker()));

    const auto slot = core::TypedSaveSlotId::manual(1);
    auto save = fixture.session->dispatch(core::RuntimeInputMessage{core::SaveRuntimeInput{slot}});
    REQUIRE(save.diagnostics.empty());
    CHECK(save.disposition == runtime::RuntimeInputDisposition::Handled);
    const auto encoded = fixture.saves.read_slot(slot);
    REQUIRE(encoded);
    auto decoded =
        core::decode_save_state_text(fixture.project, encoded.value(), "detached-scene-save.json");
    REQUIRE(decoded);
    REQUIRE(decoded.value().detached_flows.size() == 1);
    REQUIRE(decoded.value().detached_flows.front().blocker);
    CHECK(std::holds_alternative<core::SavedDurationBlocker>(
        *decoded.value().detached_flows.front().blocker));
    CHECK_FALSE(decoded.value().execution_provenance.empty());
    const auto detached_provenance = std::ranges::find_if(
        decoded.value().execution_provenance, [](const core::SavedExecutionProvenance& provenance) {
            return provenance.relationship == core::ExecutionRelationship::Detached;
        });
    REQUIRE(detached_provenance != decoded.value().execution_provenance.end());
    REQUIRE(detached_provenance->source);
    CHECK(detached_provenance->state == core::ExecutionState::Waiting);

    commit_load_candidate(fixture, slot);
    REQUIRE(fixture.session->gateway().global_property(count));
    CHECK(fixture.session->gateway().global_property(count).value() ==
          core::RuntimeValue{std::int64_t{7}});
    REQUIRE(fixture.session->presentation_state().blocker());
    CHECK(std::holds_alternative<core::InputFlowBlocker>(
        *fixture.session->presentation_state().blocker()));

    auto advanced = fixture.session->dispatch(
        core::RuntimeInputMessage{core::AdvanceTimeInput{std::chrono::milliseconds{1000}}});
    REQUIRE(advanced.diagnostics.empty());
    REQUIRE(fixture.session->gateway().global_property(count));
    CHECK(fixture.session->gateway().global_property(count).value() ==
          core::RuntimeValue{std::int64_t{9}});
    REQUIRE(fixture.session->presentation_state().blocker());
    CHECK(std::holds_alternative<core::InputFlowBlocker>(
        *fixture.session->presentation_state().blocker()));
}

TEST_CASE(
    "Scene fast-forward commits semantic work once suppresses one-shots and stops at barriers")
{
    Fixture fixture("scene-program.json", {},
                    [](nlohmann::json& document) { configure_scene_fast_forward_flow(document); });
    const auto count = make_id<core::PropertyIdTag>("count");

    auto started = fixture.session->dispatch(core::RuntimeInputMessage{core::StartRuntimeInput{}});
    REQUIRE(started.diagnostics.empty());
    REQUIRE(fixture.session->presentation_state().blocker());
    CHECK(std::holds_alternative<core::InputFlowBlocker>(
        *fixture.session->presentation_state().blocker()));
    CHECK(fixture.session->gateway().global_property(count).value() ==
          core::RuntimeValue{std::int64_t{2}});
    CHECK(fixture.presentation.audio_operations.empty());

    auto skipped = fixture.session->dispatch(core::RuntimeInputMessage{core::FastForwardInput{}});
    REQUIRE(skipped.diagnostics.empty());
    CHECK(skipped.disposition == runtime::RuntimeInputDisposition::Handled);
    CHECK(fixture.session->gateway().global_property(count).value() ==
          core::RuntimeValue{std::int64_t{7}});
    CHECK(fixture.presentation.audio_operations.empty());
    REQUIRE(fixture.session->presentation_state().blocker());
    CHECK(std::holds_alternative<core::InputFlowBlocker>(
        *fixture.session->presentation_state().blocker()));
    REQUIRE_FALSE(fixture.session->presentation_state().flow_stack().empty());
    const auto& scene =
        std::get<core::SceneFrame>(fixture.session->presentation_state().flow_stack().back());
    REQUIRE(scene.position.next_step);
    CHECK(scene.position.next_step->text() == "real-barrier");
    const auto checkpoint_outcomes = fixture.session->take_checkpoint_save_outcomes();
    CHECK(std::ranges::any_of(checkpoint_outcomes, [](const core::CheckpointSaveOutcome& outcome) {
        const auto* written = std::get_if<core::CheckpointWriteSucceeded>(&outcome);
        return written != nullptr && written->slot.is_autosave();
    }));

    auto stopped = fixture.session->dispatch(core::RuntimeInputMessage{core::FastForwardInput{}});
    REQUIRE(stopped.diagnostics.empty());
    CHECK(stopped.disposition == runtime::RuntimeInputDisposition::Unhandled);
    CHECK(fixture.session->gateway().global_property(count).value() ==
          core::RuntimeValue{std::int64_t{7}});
    CHECK(fixture.presentation.audio_operations.empty());

    auto continued = fixture.session->dispatch(core::RuntimeInputMessage{core::ContinueInput{}});
    REQUIRE(continued.diagnostics.empty());
    CHECK(fixture.session->gateway().global_property(count).value() ==
          core::RuntimeValue{std::int64_t{9}});
    CHECK(fixture.session->presentation_state().game_completed());
}

TEST_CASE("Flow-owned detached Scene is cancelled when its initiating Flow ends")
{
    Fixture fixture("scene-program.json", {}, [](nlohmann::json& document) {
        configure_detached_duration_flow(document, "flow");
        auto& opening = document["definitions"]["scenes"][1];
        opening["program"]["events"].erase(opening["program"]["events"].begin() + 2);
    });
    const auto count = make_id<core::PropertyIdTag>("count");

    auto started = fixture.session->dispatch(core::RuntimeInputMessage{core::StartRuntimeInput{}});
    REQUIRE(started.diagnostics.empty());
    CHECK(fixture.session->presentation_state().game_completed());
    REQUIRE(fixture.session->gateway().global_property(count));
    CHECK(fixture.session->gateway().global_property(count).value() ==
          core::RuntimeValue{std::int64_t{7}});

    auto advanced = fixture.session->dispatch(
        core::RuntimeInputMessage{core::AdvanceTimeInput{std::chrono::milliseconds{1000}}});
    REQUIRE(advanced.diagnostics.empty());
    CHECK(fixture.session->gateway().global_property(count).value() ==
          core::RuntimeValue{std::int64_t{7}});
}

TEST_CASE("detached Scene failure terminates only its branch and leaves foreground resumable")
{
    Fixture fixture("scene-program.json", {}, [](nlohmann::json& document) {
        configure_detached_duration_flow(document, "runtime-session");
        auto& closing = document["definitions"]["scenes"][0];
        closing["program"]["events"] =
            scene_events(nlohmann::json::array({{{"id", "detached-fault"},
                                                 {"kind", "run-lua"},
                                                 {"autosaveSafePoint", false},
                                                 {"mayYield", false},
                                                 {"source", "error('detached failure')"}}}));
    });
    const auto count = make_id<core::PropertyIdTag>("count");

    auto started = fixture.session->dispatch(core::RuntimeInputMessage{core::StartRuntimeInput{}});
    CHECK(started.disposition == runtime::RuntimeInputDisposition::Failed);
    REQUIRE_FALSE(started.diagnostics.empty());
    CHECK_FALSE(fixture.session->presentation_state().execution_fault());
    REQUIRE(fixture.session->presentation_state().blocker());
    CHECK(std::holds_alternative<core::InputFlowBlocker>(
        *fixture.session->presentation_state().blocker()));
    CHECK(fixture.session->gateway().global_property(count).value() ==
          core::RuntimeValue{std::int64_t{7}});

    const auto failed_detached = std::ranges::find_if(
        fixture.session->presentation_state().execution_provenance(),
        [](const core::ExecutionProvenance& provenance) {
            return provenance.relationship == core::ExecutionRelationship::Detached &&
                   provenance.state == core::ExecutionState::Failed;
        });
    REQUIRE(failed_detached != fixture.session->presentation_state().execution_provenance().end());

    auto continued = fixture.session->dispatch(core::RuntimeInputMessage{core::ContinueInput{}});
    REQUIRE(continued.diagnostics.empty());
    CHECK(fixture.session->presentation_state().game_completed());
    CHECK(fixture.session->gateway().global_property(count).value() ==
          core::RuntimeValue{std::int64_t{7}});
}

TEST_CASE("deferred command self-enqueue is bounded by the transaction command budget")
{
    Fixture fixture(
        "comprehensive.json",
        runtime::RuntimeBudgetConfiguration{.instruction_limit = 100'000, .command_limit = 1},
        [](nlohmann::json& document) {
            document["resources"]["scripts"].push_back(
                {{"id", "self-enqueue-hooks"},
                 {"source",
                  {{"kind", "inline-lua"},
                   {"source", "return { before_leave = function()\n"
                              "  local ok, err = noveltea.interactables.set_location('key', {\n"
                              "    kind = 'inventory',\n"
                              "    inventory = { owner = { kind = 'project' }, id = 'player' }\n"
                              "  })\n"
                              "  assert(ok and err == nil)\n"
                              "end }"}}}});
            for (auto& room : document["definitions"]["rooms"]) {
                if (room["id"] != "start")
                    continue;
                for (auto& hook : room["scriptHooks"]) {
                    if (hook["hook"] != "before-leave")
                        continue;
                    hook["handler"] = {
                        {"module", {{"kind", "script"}, {"id", "self-enqueue-hooks"}}},
                        {"export", "before_leave"}};
                }
            }
        });
    REQUIRE(fixture.session->dispatch(core::RuntimeInputMessage{core::StartRuntimeInput{}})
                .diagnostics.empty());

    const auto key = make_id<core::InteractableIdTag>("key");
    REQUIRE(fixture.session->gateway().request_navigation(core::compiled::RoomExitRef{
        make_id<core::RoomIdTag>("start"), make_id<core::RoomExitIdTag>("north-exit")}));
    auto drained = fixture.session->dispatch(core::RuntimeInputMessage{core::BeginPlaybackInput{}});
    REQUIRE_FALSE(drained.diagnostics.empty());
    CHECK(drained.diagnostics.front().code == "runtime.command_budget_exhausted");
    CHECK(drained.budget.kind == runtime::RuntimeBudgetOutcomeKind::CycleRejected);
    CHECK(drained.budget.exhausted == runtime::RuntimeBudgetKind::Command);
    CHECK(drained.budget.consumed == 1);
    CHECK(fixture.session->pending_command_count() == 0);

    const auto location = fixture.session->gateway().interactable_location(key);
    REQUIRE(location);
    CHECK(std::holds_alternative<core::compiled::RoomLocation>(location.value()));
}

TEST_CASE("runtime dispatch distinguishes instruction budget yield from execution fault")
{
    Fixture yielding("scene-program.json", runtime::RuntimeBudgetConfiguration{
                                               .instruction_limit = 1, .command_limit = 4'096});
    auto yielded = yielding.session->dispatch(core::RuntimeInputMessage{core::StartRuntimeInput{}});
    REQUIRE(yielded.diagnostics.empty());
    REQUIRE(yielded.publication);
    CHECK(yielded.budget.kind == runtime::RuntimeBudgetOutcomeKind::Yielded);
    CHECK(yielded.budget.exhausted == runtime::RuntimeBudgetKind::Instruction);
    CHECK(yielded.budget.consumed == 1);

    auto project = make_faulting_scene_project("budget-fault.json");
    test_support::MemoryScriptSource sources;
    ScriptRuntime scripts;
    REQUIRE(scripts.initialize({&sources}));
    prepare_project_scripts(scripts, project);
    FakePresentationRuntime presentation;
    core::TypedMemorySaveSlotStore saves;
    auto created =
        test_support::create_runtime_session(project, scripts, presentation, saves, "en");
    REQUIRE(created);
    auto session = std::move(created).value();
    REQUIRE_FALSE(session->presentation_state().flow_stack().empty());
    const auto faulting_frame =
        core::flow_frame_id(session->presentation_state().flow_stack().back());
    auto faulted = session->dispatch(core::RuntimeInputMessage{core::StartRuntimeInput{}});
    CHECK(faulted.disposition == runtime::RuntimeInputDisposition::Failed);
    REQUIRE_FALSE(faulted.diagnostics.empty());
    CHECK(faulted.budget.kind == runtime::RuntimeBudgetOutcomeKind::Faulted);
    CHECK_FALSE(faulted.budget.exhausted.has_value());
    REQUIRE(session->presentation_state().execution_fault());
    REQUIRE_FALSE(session->presentation_state().flow_stack().empty());
    const auto& faulting_scene =
        std::get<core::SceneFrame>(session->presentation_state().flow_stack().back());
    REQUIRE(faulting_scene.position.next_step);
    CHECK(faulting_scene.position.next_step->text() == "fault");
    const auto provenance =
        std::ranges::find_if(session->presentation_state().execution_provenance(),
                             [faulting_frame](const core::ExecutionProvenance& item) {
                                 return item.frame == faulting_frame;
                             });
    REQUIRE(provenance != session->presentation_state().execution_provenance().end());
    CHECK(provenance->state == core::ExecutionState::Failed);
}

TEST_CASE("frame-destructive commands make later commands from the old owner stale")
{
    Fixture fixture("scene-program.json");
    auto started = fixture.session->dispatch(core::RuntimeInputMessage{core::StartRuntimeInput{}});
    REQUIRE(started.diagnostics.empty());
    const auto key = make_id<core::InteractableIdTag>("key");
    REQUIRE(fixture.session->gateway().request_tail_replacement(
        core::FlowTarget{make_id<core::SceneIdTag>("closing")}));
    REQUIRE(
        fixture.session->gateway().request_interactable_location(key, player_inventory_location()));

    auto drained = fixture.session->dispatch(core::RuntimeInputMessage{core::BeginPlaybackInput{}});
    REQUIRE_FALSE(drained.diagnostics.empty());
    CHECK(drained.diagnostics.front().code == "runtime.stale_command_source");
    CHECK(drained.diagnostics.front().runtime_context != nullptr);
    CHECK(fixture.session->pending_command_count() == 0);
    const auto& view = published_view(drained);
    REQUIRE(view.scene);
    CHECK(view.scene->scene.text() == "closing");

    const auto location = fixture.session->gateway().interactable_location(key);
    REQUIRE(location);
    CHECK(std::holds_alternative<core::compiled::RoomLocation>(location.value()));
}

TEST_CASE("successful structural mutations capture once and true no-ops stay clean")
{
    Fixture fixture("comprehensive.json");
    REQUIRE(dispatch_settled(*fixture.session, core::RuntimeInputMessage{core::StartRuntimeInput{}})
                .diagnostics.empty());
    REQUIRE(fixture.session->checkpoint_service().latest_checkpoint());
    const auto count = make_id<core::PropertyIdTag>("count");
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

TEST_CASE("runtime dispatch publishes coherent envelopes with independent target revision")
{
    STATIC_REQUIRE_FALSE(HasPublicBeginDispatchTransaction<TypedRuntimeSession>);
    STATIC_REQUIRE_FALSE(HasPublicSettleDispatchTransaction<TypedRuntimeSession>);

    Fixture fixture;
    auto initial = fixture.session->dispatch(core::RuntimeInputMessage{core::StopRuntimeInput{}});
    REQUIRE(initial.publication);
    CHECK(initial.publication->presentation.revision.number() == 1);

    auto no_op = fixture.session->dispatch(core::RuntimeInputMessage{core::StopRuntimeInput{}});
    CHECK_FALSE(no_op.publication.has_value());

    auto changed = fixture.session->dispatch(core::RuntimeInputMessage{
        core::SetVariableDebugInput{make_id<core::PropertyIdTag>("count"), std::int64_t{7}}});
    REQUIRE(changed.publication);
    CHECK(changed.publication->revision.number() == initial.publication->revision.number() + 1);
    CHECK(changed.publication->presentation.revision == initial.publication->presentation.revision);
}

TEST_CASE("presentation acceptance installs its checkpoint barrier before dispatch settlement")
{
    auto project = make_immediate_audio_project("presentation-barrier.json");
    test_support::MemoryScriptSource sources;
    ScriptRuntime scripts;
    REQUIRE(scripts.initialize({&sources}));
    prepare_project_scripts(scripts, project);
    FakePresentationRuntime presentation;
    presentation.install_barrier_on_audio_accept = true;
    core::TypedMemorySaveSlotStore saves;
    auto created =
        test_support::create_runtime_session(project, scripts, presentation, saves, "en");
    REQUIRE(created);
    auto session = std::move(created).value();

    auto started = session->dispatch(core::RuntimeInputMessage{core::StartRuntimeInput{}});
    REQUIRE(started.diagnostics.empty());
    REQUIRE(presentation.audio_operations.size() == 1);
    CHECK_FALSE(session->checkpoint_service().readiness().can_capture());
    CHECK(std::any_of(
        session->checkpoint_service().readiness().issues.begin(),
        session->checkpoint_service().readiness().issues.end(), [](const auto& issue) {
            return issue.reason == core::CheckpointReadinessReason::PresentationBarrierActive;
        }));
}

TEST_CASE("presentation acceptance failure is diagnosed without retaining an invalid blocker")
{
    auto project = make_awaited_audio_cue_project("presentation-rejection.json");
    test_support::MemoryScriptSource sources;
    ScriptRuntime scripts;
    REQUIRE(scripts.initialize({&sources}));
    prepare_project_scripts(scripts, project);
    FakePresentationRuntime presentation;
    presentation.reject_audio = true;
    core::TypedMemorySaveSlotStore saves;
    auto created =
        test_support::create_runtime_session(project, scripts, presentation, saves, "en");
    REQUIRE(created);
    auto session = std::move(created).value();
    const auto before = session->checkpoint_service().generations();

    auto started = session->dispatch(core::RuntimeInputMessage{core::StartRuntimeInput{}});
    CHECK(started.disposition == runtime::RuntimeInputDisposition::Failed);
    CHECK(diagnostics_have_code(started.diagnostics, "presentation.test_rejected"));
    CHECK_FALSE(session->presentation_state().blocker().has_value());
    CHECK(presentation.status.active_barriers.empty());
    REQUIRE(started.publication);
    const auto after = session->checkpoint_service().generations();
    CHECK(after.structural_generation == before.structural_generation);
    CHECK(after.captured_structural_generation == before.captured_structural_generation);
}

TEST_CASE("atomic TransitionGroup publishes once and installs its causal barrier before settlement")
{
    auto project = make_transition_group_project("transition-group-awaited.json", true);
    test_support::MemoryScriptSource sources;
    ScriptRuntime scripts;
    REQUIRE(scripts.initialize({&sources}));
    REQUIRE(scripts.execute("function initialize_fixture() end", "transition-group-startup"));
    prepare_project_scripts(scripts, project);
    FakePresentationRuntime presentation;
    presentation.install_barrier_on_presentation_accept = true;
    core::TypedMemorySaveSlotStore saves;
    auto created =
        test_support::create_runtime_session(project, scripts, presentation, saves, "en");
    REQUIRE(created);
    auto session = std::move(created).value();

    auto started = session->dispatch(core::RuntimeInputMessage{core::StartRuntimeInput{}});
    REQUIRE(started.diagnostics.empty());
    REQUIRE(started.publication);
    REQUIRE(presentation.presentation_operations.size() == 1);
    const auto* operation = std::get_if<core::SceneTransitionGroupOperation>(
        &presentation.presentation_operations.front());
    REQUIRE(operation != nullptr);
    REQUIRE(operation->completion);
    CHECK(operation->common.revisions.source.number() == 1);
    CHECK(operation->common.revisions.target == started.publication->presentation.revision);
    CHECK(presentation.reconciled_snapshots.size() == 2);
    CHECK(session->gateway().global_property(make_id<core::PropertyIdTag>("count")).value() ==
          core::RuntimeValue{std::int64_t{2}});
    CHECK_FALSE(session->checkpoint_service().readiness().can_capture());
    CHECK(std::any_of(
        session->checkpoint_service().readiness().issues.begin(),
        session->checkpoint_service().readiness().issues.end(), [](const auto& issue) {
            return issue.reason == core::CheckpointReadinessReason::PresentationBarrierActive;
        }));

    presentation.status = {core::CheckpointStatusRevision::from_number(3), {}};
    auto completed = session->dispatch(core::RuntimeInputMessage{core::CompletePresentationInput{
        operation->common.id, operation->completion->owner, operation->completion->blocker}});
    REQUIRE(completed.diagnostics.empty());
    CHECK(session->gateway().global_property(make_id<core::PropertyIdTag>("count")).value() ==
          core::RuntimeValue{std::int64_t{9}});
}

TEST_CASE("disposable TransitionGroup emits and ends the transaction before adjacent instructions")
{
    auto project = make_transition_group_project("transition-group-disposable.json", false);
    test_support::MemoryScriptSource sources;
    ScriptRuntime scripts;
    REQUIRE(scripts.initialize({&sources}));
    REQUIRE(scripts.execute("function initialize_fixture() end", "transition-group-startup"));
    prepare_project_scripts(scripts, project);
    FakePresentationRuntime presentation;
    core::TypedMemorySaveSlotStore saves;
    auto created =
        test_support::create_runtime_session(project, scripts, presentation, saves, "en");
    REQUIRE(created);
    auto session = std::move(created).value();

    auto started = session->dispatch(core::RuntimeInputMessage{core::StartRuntimeInput{}});
    REQUIRE(started.diagnostics.empty());
    REQUIRE(started.publication);
    REQUIRE(presentation.presentation_operations.size() == 1);
    const auto* operation = std::get_if<core::SceneTransitionGroupOperation>(
        &presentation.presentation_operations.front());
    REQUIRE(operation != nullptr);
    CHECK_FALSE(operation->completion);
    CHECK(presentation.status.active_barriers.empty());
    CHECK(session->gateway().global_property(make_id<core::PropertyIdTag>("count")).value() ==
          core::RuntimeValue{std::int64_t{2}});

    auto continued = session->dispatch(
        core::RuntimeInputMessage{core::AdvanceTimeInput{std::chrono::milliseconds{0}}});
    REQUIRE(continued.diagnostics.empty());
    CHECK(session->gateway().global_property(make_id<core::PropertyIdTag>("count")).value() ==
          core::RuntimeValue{std::int64_t{9}});
}

TEST_CASE("Scene completion dependencies wait only for the referenced non-blocking operation")
{
    auto project = make_transition_dependency_project("transition-group-dependency.json");
    test_support::MemoryScriptSource sources;
    ScriptRuntime scripts;
    REQUIRE(scripts.initialize({&sources}));
    REQUIRE(scripts.execute("function initialize_fixture() end", "transition-dependency-startup"));
    prepare_project_scripts(scripts, project);
    FakePresentationRuntime presentation;
    presentation.track_presentation_liveness = true;
    core::TypedMemorySaveSlotStore saves;
    auto created =
        test_support::create_runtime_session(project, scripts, presentation, saves, "en");
    REQUIRE(created);
    auto session = std::move(created).value();
    const auto count = make_id<core::PropertyIdTag>("count");

    auto started = session->dispatch(core::RuntimeInputMessage{core::StartRuntimeInput{}});
    REQUIRE(started.diagnostics.empty());
    REQUIRE(presentation.presentation_operations.size() == 1);
    REQUIRE(presentation.active_presentation_operations.size() == 1);
    CHECK(session->gateway().global_property(count).value() == core::RuntimeValue{std::int64_t{2}});

    auto overlapped = session->dispatch(
        core::RuntimeInputMessage{core::AdvanceTimeInput{std::chrono::milliseconds{0}}});
    REQUIRE(overlapped.diagnostics.empty());
    CHECK(session->gateway().global_property(count).value() == core::RuntimeValue{std::int64_t{5}});

    presentation.active_presentation_operations.clear();
    auto completed = session->dispatch(
        core::RuntimeInputMessage{core::AdvanceTimeInput{std::chrono::milliseconds{0}}});
    REQUIRE(completed.diagnostics.empty());
    CHECK(session->gateway().global_property(count).value() == core::RuntimeValue{std::int64_t{9}});
}

TEST_CASE(
    "Scene exact audio wait catches same-pass playback and resumes on its terminal acknowledgement")
{
    auto project = make_audio_semantic_wait_project("audio-semantic-wait.json");
    test_support::MemoryScriptSource sources;
    ScriptRuntime scripts;
    REQUIRE(scripts.initialize({&sources}));
    REQUIRE(scripts.execute("function initialize_fixture() end", "audio-semantic-wait-startup"));
    prepare_project_scripts(scripts, project);
    FakePresentationRuntime presentation;
    core::TypedMemorySaveSlotStore saves;
    auto created =
        test_support::create_runtime_session(project, scripts, presentation, saves, "en");
    REQUIRE(created);
    auto session = std::move(created).value();
    const auto count = make_id<core::PropertyIdTag>("count");

    auto started = session->dispatch(core::RuntimeInputMessage{core::StartRuntimeInput{}});
    REQUIRE(started.diagnostics.empty());
    REQUIRE(presentation.audio_operations.size() == 1);
    CHECK(session->gateway().global_property(count).value() == core::RuntimeValue{std::int64_t{2}});
    REQUIRE(session->presentation_state().blocker());
    CHECK(std::holds_alternative<core::InputFlowBlocker>(*session->presentation_state().blocker()));

    auto ignored_continue = session->dispatch(core::RuntimeInputMessage{core::ContinueInput{}});
    CHECK(ignored_continue.disposition == runtime::RuntimeInputDisposition::Unhandled);
    CHECK(session->gateway().global_property(count).value() == core::RuntimeValue{std::int64_t{2}});

    auto completed = session->dispatch(core::RuntimeInputMessage{
        core::AcknowledgeAudioTerminationInput{presentation.audio_operations.front().id}});
    REQUIRE(completed.diagnostics.empty());
    CHECK(session->gateway().global_property(count).value() == core::RuntimeValue{std::int64_t{9}});
}

TEST_CASE("Scene exact operation wait blocks only on its referenced finite operation")
{
    auto project = make_transition_operation_wait_project("transition-operation-wait.json");
    test_support::MemoryScriptSource sources;
    ScriptRuntime scripts;
    REQUIRE(scripts.initialize({&sources}));
    REQUIRE(
        scripts.execute("function initialize_fixture() end", "transition-operation-wait-startup"));
    prepare_project_scripts(scripts, project);
    FakePresentationRuntime presentation;
    presentation.track_presentation_liveness = true;
    core::TypedMemorySaveSlotStore saves;
    auto created =
        test_support::create_runtime_session(project, scripts, presentation, saves, "en");
    REQUIRE(created);
    auto session = std::move(created).value();
    const auto count = make_id<core::PropertyIdTag>("count");

    auto started = session->dispatch(core::RuntimeInputMessage{core::StartRuntimeInput{}});
    REQUIRE(started.diagnostics.empty());
    REQUIRE(presentation.presentation_operations.size() == 1);
    REQUIRE(presentation.active_presentation_operations.size() == 1);

    auto waiting = session->dispatch(
        core::RuntimeInputMessage{core::AdvanceTimeInput{std::chrono::milliseconds{0}}});
    REQUIRE(waiting.diagnostics.empty());
    CHECK(session->gateway().global_property(count).value() == core::RuntimeValue{std::int64_t{2}});
    REQUIRE(session->presentation_state().blocker());
    CHECK(std::holds_alternative<core::InputFlowBlocker>(*session->presentation_state().blocker()));

    auto ignored_continue = session->dispatch(core::RuntimeInputMessage{core::ContinueInput{}});
    CHECK(ignored_continue.disposition == runtime::RuntimeInputDisposition::Unhandled);
    CHECK(session->gateway().global_property(count).value() == core::RuntimeValue{std::int64_t{2}});

    presentation.active_presentation_operations.clear();
    auto completed = session->dispatch(
        core::RuntimeInputMessage{core::AdvanceTimeInput{std::chrono::milliseconds{0}}});
    REQUIRE(completed.diagnostics.empty());
    CHECK(session->gateway().global_property(count).value() == core::RuntimeValue{std::int64_t{9}});
}

TEST_CASE("finite target reconciliation failure restores the source before operation acceptance")
{
    auto project = make_transition_group_project("transition-group-reconcile.json", false);
    test_support::MemoryScriptSource sources;
    ScriptRuntime scripts;
    REQUIRE(scripts.initialize({&sources}));
    REQUIRE(scripts.execute("function initialize_fixture() end", "transition-group-startup"));
    prepare_project_scripts(scripts, project);
    FakePresentationRuntime presentation;
    presentation.reject_reconcile_call = 2;
    core::TypedMemorySaveSlotStore saves;
    auto created =
        test_support::create_runtime_session(project, scripts, presentation, saves, "en");
    REQUIRE(created);
    auto session = std::move(created).value();
    const auto source_backgrounds = session->presentation_state().background_overrides();

    auto started = session->dispatch(core::RuntimeInputMessage{core::StartRuntimeInput{}});
    CHECK(started.disposition == runtime::RuntimeInputDisposition::Failed);
    CHECK(diagnostics_have_code(started.diagnostics, "presentation.test_reconcile_failed"));
    CHECK_FALSE(started.publication);
    CHECK(presentation.presentation_operations.empty());
    CHECK(session->presentation_state().background_overrides() == source_backgrounds);
    REQUIRE(presentation.reconciled_snapshots.size() == 2);
    CHECK(presentation.reconciled_snapshots.front().revision.number() == 1);
    CHECK(presentation.reconciled_snapshots.back().revision.number() == 2);
}

TEST_CASE("Room navigation publishes the prepared target before transition completion and delays "
          "after hooks")
{
    auto project = make_animated_room_project("room-navigation.json");
    test_support::MemoryScriptSource sources;
    ScriptRuntime scripts;
    REQUIRE(scripts.initialize({&sources}));
    REQUIRE(scripts.execute("function initialize_fixture() end\n"
                            "function can_leave_start() return true end\n"
                            "function before_leave_start() end\n"
                            "function hall_description() return 'Hall' end\n"
                            "function key_label() return 'Key' end\n"
                            "function tower_open() return true end\n",
                            "room-navigation-startup"));
    prepare_project_scripts(scripts, project);
    FakePresentationRuntime presentation;
    presentation.install_barrier_on_presentation_accept = true;
    core::TypedMemorySaveSlotStore saves;
    auto created =
        test_support::create_runtime_session(project, scripts, presentation, saves, "en");
    REQUIRE(created);
    auto session = std::move(created).value();
    const auto count = make_id<core::PropertyIdTag>("count");

    auto entered = session->dispatch(core::RuntimeInputMessage{core::StartRuntimeInput{}});
    REQUIRE(entered.diagnostics.empty());
    REQUIRE(entered.presentation_predecessor);
    REQUIRE(entered.publication);
    REQUIRE(presentation.presentation_operations.size() == 1);
    const auto* initial = std::get_if<core::RoomNavigationTransitionOperation>(
        &presentation.presentation_operations.front());
    REQUIRE(initial != nullptr);
    CHECK_FALSE(initial->target.source_room);
    CHECK(entered.presentation_predecessor->revision == initial->common.revisions.source);
    CHECK(entered.publication->presentation.revision == initial->common.revisions.target);
    CHECK_FALSE(entered.presentation_predecessor->current_room);
    CHECK(initial->target.target_room == make_id<core::RoomIdTag>("start"));
    CHECK(entered.publication->presentation.current_room == make_id<core::RoomIdTag>("start"));
    CHECK(session->gateway().global_property(count).value() == core::RuntimeValue{std::int64_t{2}});

    presentation.status = {core::CheckpointStatusRevision::from_number(3), {}};
    auto initial_completed =
        session->dispatch(core::RuntimeInputMessage{core::CompletePresentationInput{
            initial->common.id, initial->completion.owner, initial->completion.blocker}});
    REQUIRE(initial_completed.diagnostics.empty());
    CHECK(session->gateway().global_property(count).value() == core::RuntimeValue{std::int64_t{7}});

    REQUIRE(session->gateway().request_navigation(core::compiled::RoomExitRef{
        make_id<core::RoomIdTag>("start"), make_id<core::RoomExitIdTag>("north-exit")}));
    auto navigated = session->dispatch(
        core::RuntimeInputMessage{core::AdvanceTimeInput{std::chrono::milliseconds{0}}});
    REQUIRE(navigated.diagnostics.empty());
    REQUIRE(navigated.presentation_predecessor);
    REQUIRE(navigated.publication);
    REQUIRE(presentation.presentation_operations.size() == 2);
    const auto* navigation = std::get_if<core::RoomNavigationTransitionOperation>(
        &presentation.presentation_operations.back());
    REQUIRE(navigation != nullptr);
    REQUIRE(navigation->target.source_room);
    CHECK(navigated.presentation_predecessor->revision == navigation->common.revisions.source);
    CHECK(navigated.publication->presentation.revision == navigation->common.revisions.target);
    CHECK(*navigation->target.source_room == make_id<core::RoomIdTag>("start"));
    CHECK(navigation->target.target_room == make_id<core::RoomIdTag>("hall"));
    CHECK(navigated.publication->presentation.current_room == make_id<core::RoomIdTag>("hall"));
    REQUIRE(navigated.publication->gameplay_ui.room);
    CHECK(navigated.publication->gameplay_ui.room->room == make_id<core::RoomIdTag>("hall"));
    CHECK(navigated.publication->gameplay_ui.room->description.empty());
    CHECK(session->gateway().global_property(count).value() == core::RuntimeValue{std::int64_t{7}});
    CHECK(std::none_of(navigated.publication->presentation.layouts.begin(),
                       navigated.publication->presentation.layouts.end(), [](const auto& layout) {
                           const auto* overlay =
                               std::get_if<core::RoomOverlayLayoutMountKey>(&layout.key);
                           return overlay != nullptr &&
                                  overlay->room == make_id<core::RoomIdTag>("start");
                       }));
    CHECK(std::any_of(navigated.publication->presentation.layouts.begin(),
                      navigated.publication->presentation.layouts.end(), [](const auto& layout) {
                          const auto* overlay =
                              std::get_if<core::RoomOverlayLayoutMountKey>(&layout.key);
                          return overlay != nullptr &&
                                 overlay->room == make_id<core::RoomIdTag>("hall");
                      }));

    presentation.status = {core::CheckpointStatusRevision::from_number(5), {}};
    auto navigation_completed =
        session->dispatch(core::RuntimeInputMessage{core::CompletePresentationInput{
            navigation->common.id, navigation->completion.owner, navigation->completion.blocker}});
    REQUIRE(navigation_completed.diagnostics.empty());
    CHECK(session->gateway().global_property(count).value() == core::RuntimeValue{std::int64_t{8}});
    REQUIRE(navigation_completed.publication);
    REQUIRE(navigation_completed.publication->gameplay_ui.room);
    CHECK(navigation_completed.publication->gameplay_ui.room->room ==
          make_id<core::RoomIdTag>("hall"));
    CHECK(navigation_completed.publication->gameplay_ui.room->description == "Hall");
    CHECK(navigation_completed.publication->gameplay_ui.can_continue);
}

TEST_CASE("reentrant public runtime dispatch is rejected without disturbing the outer operation")
{
    auto project = make_immediate_audio_project("reentrant-dispatch.json");
    test_support::MemoryScriptSource sources;
    ScriptRuntime scripts;
    REQUIRE(scripts.initialize({&sources}));
    prepare_project_scripts(scripts, project);
    FakePresentationRuntime presentation;
    core::TypedMemorySaveSlotStore saves;
    auto created =
        test_support::create_runtime_session(project, scripts, presentation, saves, "en");
    REQUIRE(created);
    auto session = std::move(created).value();
    presentation.reentrant_session = session.get();

    auto started = session->dispatch(core::RuntimeInputMessage{core::StartRuntimeInput{}});
    REQUIRE(started.diagnostics.empty());
    REQUIRE(presentation.nested_dispatch);
    CHECK(presentation.nested_dispatch->disposition == runtime::RuntimeInputDisposition::Failed);
    REQUIRE(presentation.nested_dispatch->diagnostics.size() == 1);
    CHECK(presentation.nested_dispatch->diagnostics.front().code == "runtime.reentrant_dispatch");
    REQUIRE(started.publication);
}

TEST_CASE("typed runtime session reports unhandled operations deterministically")
{
    Fixture fixture;
    auto continued = fixture.session->dispatch(core::RuntimeInputMessage{core::ContinueInput{}});
    CHECK(continued.disposition == runtime::RuntimeInputDisposition::Unhandled);
    CHECK(has_output_kind(continued, DispatchArtifactKind::Publication));
}

TEST_CASE("typed runtime session returns playback observations beside one coherent publication")
{
    Fixture fixture;
    auto begun = fixture.session->dispatch(core::RuntimeInputMessage{core::BeginPlaybackInput{}});
    REQUIRE(begun.publication);
    REQUIRE_FALSE(fixture.presentation.reconciled_snapshots.empty());
    CHECK(fixture.presentation.reconciled_snapshots.back() == begun.publication->presentation);
    REQUIRE(begun.events.size() == 3);
    CHECK(std::all_of(begun.events.begin(), begun.events.end(), [](const auto& event) {
        return std::holds_alternative<runtime::ObservationEvent>(event);
    }));
    CHECK(begun.publication->observations.values.size() == 3);
    CHECK(std::holds_alternative<core::CheckpointRuntimeObservation>(
        begun.publication->observations.values.back()));
}

TEST_CASE("runtime notifications are ordered events and require no acknowledgement")
{
    Fixture fixture;
    REQUIRE(fixture.session->gateway().request_notification("first"));
    REQUIRE(fixture.session->gateway().request_notification("second"));
    auto drained = fixture.session->dispatch(core::RuntimeInputMessage{core::BeginPlaybackInput{}});
    REQUIRE(drained.diagnostics.empty());
    std::vector<std::string> notifications;
    for (const auto& event : drained.events) {
        if (const auto* notification = std::get_if<runtime::NotificationEvent>(&event))
            notifications.push_back(notification->message);
    }
    CHECK(notifications == std::vector<std::string>{"first", "second"});
    CHECK(fixture.session->pending_command_count() == 0);
}

TEST_CASE("runtime events retain order while script audio is accepted directly")
{
    Fixture fixture;
    REQUIRE(fixture.session->gateway().request_notification("before"));
    REQUIRE(fixture.session->gateway().request_audio(
        core::compiled::AudioAction::Play, core::compiled::AudioPurpose::SoundEffect,
        make_id<core::AssetIdTag>("audio-voice"), std::chrono::milliseconds{0}, false, 1.0, false));
    REQUIRE(fixture.session->gateway().request_notification("after"));

    auto drained = fixture.session->dispatch(core::RuntimeInputMessage{core::BeginPlaybackInput{}});
    REQUIRE(drained.diagnostics.empty());
    REQUIRE(fixture.presentation.audio_operations.size() == 1);
    std::vector<std::string> notifications;
    for (const auto& event : drained.events) {
        if (const auto* notification = std::get_if<runtime::NotificationEvent>(&event))
            notifications.push_back(notification->message);
    }
    CHECK(notifications == std::vector<std::string>{"before", "after"});
}

TEST_CASE(
    "runtime script API routes load through session replacement without kernel-owned closures")
{
    Fixture fixture;
    const auto count = make_id<core::PropertyIdTag>("count");
    REQUIRE(execute_session_lua(
        fixture, "local ok, err = Game.set_prop('count', 12); assert(ok and err == nil)",
        "script-api-before-reset"));
    REQUIRE(fixture.session->gateway().global_property(count));
    CHECK(fixture.session->gateway().global_property(count).value() ==
          core::RuntimeValue{std::int64_t{12}});
    REQUIRE(dispatch_settled(*fixture.session, core::RuntimeInputMessage{core::StopRuntimeInput{}})
                .diagnostics.empty());

    const auto slot = core::TypedSaveSlotId::manual(7);
    REQUIRE(execute_session_lua(fixture, "local ok = Game.save(7); assert(ok)",
                                "script-api-queued-save"));
    CHECK_FALSE(fixture.saves.has_slot(slot).value());
    auto drained =
        dispatch_settled(*fixture.session, core::RuntimeInputMessage{core::StopRuntimeInput{}});
    CHECK(fixture.saves.has_slot(slot).value());
    CHECK_FALSE(fixture.session->take_checkpoint_save_outcomes().empty());

    auto reset_request =
        fixture.session->dispatch(core::RuntimeInputMessage{core::ResetRuntimeInput{}});
    REQUIRE(reset_request.diagnostics.empty());
    REQUIRE(reset_request.session_replacement_request);
    CHECK(std::holds_alternative<core::ResetRuntimeInput>(
        *reset_request.session_replacement_request));
    commit_reset_candidate(fixture);
    REQUIRE(execute_session_lua(
        fixture, "local ok, err = Game.set_prop('count', 21); assert(ok and err == nil)",
        "script-api-after-reset"));
    REQUIRE(fixture.session->gateway().global_property(count));
    CHECK(fixture.session->gateway().global_property(count).value() ==
          core::RuntimeValue{std::int64_t{21}});

    REQUIRE(execute_session_lua(fixture, "local ok = Game.load(7); assert(ok)",
                                "script-api-queued-load"));
    auto load_request =
        dispatch_settled(*fixture.session, core::RuntimeInputMessage{core::StopRuntimeInput{}});
    REQUIRE(load_request.diagnostics.empty());
    REQUIRE(load_request.session_replacement_request);
    const auto* requested_load =
        std::get_if<core::LoadRuntimeInput>(&*load_request.session_replacement_request);
    REQUIRE(requested_load);
    CHECK(requested_load->slot == slot);
    CHECK(fixture.session->gateway().global_property(count).value() ==
          core::RuntimeValue{std::int64_t{21}});

    commit_load_candidate(fixture, slot);
    REQUIRE(fixture.session->gateway().global_property(count));
    CHECK(fixture.session->gateway().global_property(count).value() ==
          core::RuntimeValue{std::int64_t{12}});
}

TEST_CASE("runtime script API remains attached when a requested load candidate fails")
{
    Fixture fixture;
    const auto bad_slot = core::TypedSaveSlotId::manual(9);
    REQUIRE(fixture.saves.write_slot(bad_slot, "not a valid typed save"));

    REQUIRE(execute_session_lua(fixture, "local ok, err = Game.load(9); assert(ok and err == nil)",
                                "script-api-failed-load-request"));
    auto requested = fixture.session->dispatch(core::RuntimeInputMessage{core::StopRuntimeInput{}});
    REQUIRE(requested.diagnostics.empty());
    REQUIRE(requested.session_replacement_request);
    auto failed = runtime::RuntimeSession::restore(
        fixture.project, fixture.script_port, test_support::presentation_model(),
        fixture.presentation, fixture.saves, test_support::save_codec(), bad_slot, "en",
        fixture.runtime_budget);
    REQUIRE_FALSE(failed);

    REQUIRE(execute_session_lua(
        fixture, "local ok, err = Game.set_prop('count', 33); assert(ok and err == nil)",
        "script-api-after-failed-load"));
    const auto count = make_id<core::PropertyIdTag>("count");
    REQUIRE(fixture.session->gateway().global_property(count));
    CHECK(fixture.session->gateway().global_property(count).value() ==
          core::RuntimeValue{std::int64_t{33}});
}

TEST_CASE("runtime script API lowers indexed navigation to the current stable exit ID")
{
    Fixture fixture;
    auto started = fixture.session->dispatch(core::RuntimeInputMessage{core::StartRuntimeInput{}});
    const auto& started_view = published_view(started);
    REQUIRE(started_view.room);
    REQUIRE(started_view.room->room.text() == "start");
    REQUIRE(started_view.room->exits.size() == 1);
    CHECK(started_view.room->exits.front().exit.text() == "north-exit");

    auto invalid =
        execute_session_lua(fixture,
                            "local ok, err = Game.navigate(-1); assert(not ok and err ~= nil)\n"
                            "ok, err = Game.navigate(1); assert(not ok and err ~= nil)",
                            "script-api-navigation-range");
    REQUIRE(invalid);

    REQUIRE(execute_session_lua(fixture,
                                "local ok, err = Game.navigate(0); assert(ok and err == nil)",
                                "script-api-navigation"));
    auto drained =
        dispatch_settled(*fixture.session, core::RuntimeInputMessage{core::StopRuntimeInput{}});
    REQUIRE(drained.diagnostics.empty());
    const auto& drained_view = published_view(drained);
    REQUIRE(drained_view.room);
    CHECK(drained_view.room->room.text() == "hall");
}

TEST_CASE(
    "runtime script API drains commands queued by Lua reached during the same outer operation")
{
    Fixture fixture("comprehensive.json", {}, [](nlohmann::json& document) {
        document["resources"]["scripts"].push_back(
            {{"id", "save-on-leave-hooks"},
             {"source",
              {{"kind", "inline-lua"},
               {"source", "return { before_leave = function() "
                          "local ok, err = Game.save(8); assert(ok and err == nil) end }"}}}});
        for (auto& room : document["definitions"]["rooms"]) {
            if (room["id"] != "start")
                continue;
            for (auto& hook : room["scriptHooks"]) {
                if (hook["hook"] != "before-leave")
                    continue;
                hook["handler"] = {{"module", {{"kind", "script"}, {"id", "save-on-leave-hooks"}}},
                                   {"export", "before_leave"}};
            }
        }
    });
    REQUIRE(dispatch_settled(*fixture.session, core::RuntimeInputMessage{core::StopRuntimeInput{}})
                .diagnostics.empty());
    const auto slot = core::TypedSaveSlotId::manual(8);

    auto started = fixture.session->dispatch(core::RuntimeInputMessage{core::StartRuntimeInput{}});
    REQUIRE(started.diagnostics.empty());
    CHECK_FALSE(fixture.saves.has_slot(slot).value());
    REQUIRE(execute_session_lua(fixture,
                                "local ok, err = Game.navigate(0); assert(ok and err == nil)",
                                "script-api-nested-command-navigation"));
    auto drained =
        dispatch_settled(*fixture.session, core::RuntimeInputMessage{core::StopRuntimeInput{}});
    REQUIRE(drained.diagnostics.empty());
    CHECK(fixture.saves.has_slot(slot).value());
    CHECK_FALSE(fixture.session->take_checkpoint_save_outcomes().empty());
}

TEST_CASE("runtime script API routes autosave and rejects malformed interaction bindings")
{
    Fixture fixture("interaction-program.json");
    REQUIRE(dispatch_settled(*fixture.session, core::RuntimeInputMessage{core::StopRuntimeInput{}})
                .diagnostics.empty());
    REQUIRE(execute_session_lua(fixture,
                                "local ok, err = Game.run_action('use', { target = 5 })\n"
                                "assert(not ok and err ~= nil)\n"
                                "ok, err = Game.autosave()\n"
                                "assert(ok and err == nil)",
                                "script-api-validation"));

    CHECK_FALSE(fixture.saves.has_slot(core::TypedSaveSlotId::autosave()).value());
    auto queued =
        dispatch_settled(*fixture.session, core::RuntimeInputMessage{core::StopRuntimeInput{}});
    REQUIRE(queued.diagnostics.empty());
    CHECK_FALSE(fixture.saves.has_slot(core::TypedSaveSlotId::autosave()).value());
    CHECK_FALSE(has_output_kind(queued, DispatchArtifactKind::SaveOutcome));

    auto promoted =
        dispatch_settled(*fixture.session, core::RuntimeInputMessage{core::StartRuntimeInput{}});
    REQUIRE(promoted.diagnostics.empty());
    CHECK(fixture.saves.has_slot(core::TypedSaveSlotId::autosave()).value());
    CHECK_FALSE(has_output_kind(promoted, DispatchArtifactKind::SaveOutcome));
    const auto outcomes = fixture.session->take_checkpoint_save_outcomes();
    REQUIRE_FALSE(outcomes.empty());
    CHECK(std::holds_alternative<core::CheckpointWriteSucceeded>(outcomes.back()));
}

TEST_CASE("runtime script API uses owner-qualified Feature subjects and Properties")
{
    Fixture fixture("interaction-program.json");
    auto started = fixture.session->dispatch(core::RuntimeInputMessage{core::StartRuntimeInput{}});
    REQUIRE(started.diagnostics.empty());
    REQUIRE(published_view(started).room);

    REQUIRE(execute_session_lua(
        fixture,
        "local value, present, err = noveltea.properties.get_feature('room', 'start', 'door', "
        "'enabled')\n"
        "assert(present and value == true and err == nil)\n"
        "local ok\n"
        "ok, err = noveltea.properties.set_feature('room', 'start', 'door', 'enabled', false)\n"
        "assert(ok and err == nil)\n"
        "value, present, err = noveltea.properties.get_feature('room', 'start', 'door', "
        "'enabled')\n"
        "assert(present and value == false and err == nil)\n"
        "ok, err = noveltea.properties.unset_feature('room', 'start', 'door', 'enabled')\n"
        "assert(ok and err == nil)\n"
        "ok, err = Game.run_action('inspect', {target={kind='feature', ownerKind='room', "
        "ownerId='start', featureId='door'}})\n"
        "assert(ok and err == nil)",
        "script-api-feature"));
    auto drained = fixture.session->dispatch(core::RuntimeInputMessage{core::StopRuntimeInput{}});
    REQUIRE(drained.diagnostics.empty());

    REQUIRE(execute_session_lua(
        fixture,
        "local ok, err = Game.run_action('inspect', {target={kind='feature', ownerKind='unknown', "
        "ownerId='start', featureId='door'}})\n"
        "assert(not ok and err ~= nil)",
        "script-api-feature-invalid-owner"));
}

TEST_CASE("runtime script API teardown leaves inert bindings without a stale target")
{
    Fixture fixture;
    fixture.session.reset();
    REQUIRE(fixture.runtime.execute(
        "local value, variable_error = Game.prop('count')\n"
        "local ok, save_error = Game.save(1)\n"
        "teardown_inert = value == nil and type(variable_error) == 'string' and not ok and "
        "type(save_error) == 'string'",
        "script-api-after-teardown"));
    auto cleared = fixture.runtime.evaluate_bool("teardown_inert", "script-api-after-teardown");
    REQUIRE(cleared);
    CHECK(cleared.value());
}

TEST_CASE("runtime Lua random state is deterministic across save load and invalid ranges")
{
    Fixture fixture;
    REQUIRE(
        execute_session_lua(fixture,
                            "local ok, err = noveltea.random.seed(77); assert(ok and err == nil)\n"
                            "random_first = assert(noveltea.random.integer(-20, 20))",
                            "typed-random-seed"));
    REQUIRE(dispatch_settled(*fixture.session, core::RuntimeInputMessage{core::StopRuntimeInput{}})
                .diagnostics.empty());
    REQUIRE(execute_session_lua(fixture, "local ok, err = Game.save(12); assert(ok and err == nil)",
                                "typed-random-save"));
    (void)dispatch_settled(*fixture.session, core::RuntimeInputMessage{core::StopRuntimeInput{}});

    REQUIRE(execute_session_lua(
        fixture,
        "random_expected = assert(noveltea.random.integer(-20, 20))\n"
        "local before = assert(noveltea.random.number())\n"
        "local value, err = noveltea.random.integer(5, 4); assert(value == nil and err ~= nil)\n"
        "random_after_invalid = assert(noveltea.random.number())",
        "typed-random-after-save"));
    auto expected = fixture.runtime.evaluate("random_expected", "typed-random-expected");
    REQUIRE(expected);

    REQUIRE(
        execute_session_lua(fixture, "local ok = Game.load(12); assert(ok)", "typed-random-load"));
    auto load_request =
        fixture.session->dispatch(core::RuntimeInputMessage{core::StopRuntimeInput{}});
    REQUIRE(load_request.diagnostics.empty());
    REQUIRE(load_request.session_replacement_request);
    commit_load_candidate(fixture, core::TypedSaveSlotId::manual(12));
    REQUIRE(execute_session_lua(fixture,
                                "random_restored = assert(noveltea.random.integer(-20, 20))",
                                "typed-random-restored"));
    auto restored = fixture.runtime.evaluate("random_restored", "typed-random-restored-value");
    REQUIRE(restored);
    CHECK(restored.value() == expected.value());

    REQUIRE(execute_session_lua(
        fixture,
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

    REQUIRE(execute_session_lua(
        fixture,
        "math.randomseed(31337); math_random = math.random(1, 100000)\n"
        "noveltea.random.seed(31337); typed_random = assert(noveltea.random.integer(1, 100000))",
        "typed-math-random"));
    auto math_matches =
        fixture.runtime.evaluate_bool("math_random == typed_random", "typed-math-random-result");
    REQUIRE(math_matches);
    CHECK(math_matches.value());
}

TEST_CASE("runtime Lua Map activation and layout controls use typed state and validated navigation")
{
    Fixture fixture;
    auto started = fixture.session->dispatch(core::RuntimeInputMessage{core::StartRuntimeInput{}});
    REQUIRE(started.diagnostics.empty());
    const auto& started_view = published_view(started);
    REQUIRE(started_view.room);
    CHECK(started_view.room->room.text() == "start");

    REQUIRE(execute_session_lua(
        fixture,
        "local ok, err = noveltea.layouts.set('custom', 'hud-assets'); assert(ok and err == nil)",
        "typed-map-layout"));
    auto flushed = fixture.session->dispatch(
        core::RuntimeInputMessage{core::AdvanceTimeInput{std::chrono::milliseconds{0}}});
    REQUIRE(flushed.diagnostics.empty());
    const auto& view = published_view(flushed);
    REQUIRE(view.maps.size() == 1);
    CHECK(view.maps.front().map.text() == "house");
    REQUIRE(view.scene == std::nullopt);
    auto layout_value = fixture.session->gateway().layout(core::compiled::LayoutSlot::Custom);
    REQUIRE(layout_value);
    REQUIRE(layout_value.value());
    CHECK(*layout_value.value() == core::LayoutId::create("hud-assets").value());
    CHECK(flushed.publication.has_value());

    auto stopped = fixture.session->dispatch(core::RuntimeInputMessage{core::StopRuntimeInput{}});
    REQUIRE(stopped.diagnostics.empty());

    REQUIRE(execute_session_lua(
        fixture,
        "local ok, err = noveltea.map.activate('missing', 'start-hall'); assert(not ok and err ~= "
        "nil)\n"
        "ok, err = noveltea.layouts.set('custom', 'missing'); assert(not ok and err ~= nil)\n"
        "assert(noveltea.layouts.get('custom') == 'hud-assets')\n"
        "ok, err = noveltea.map.activate('house', 'start-hall'); assert(ok and err == nil)",
        "typed-map-layout-atomic"));
    auto navigated =
        fixture.session->dispatch(core::RuntimeInputMessage{core::BeginPlaybackInput{}});
    REQUIRE(navigated.diagnostics.empty());
    CHECK(fixture.session->pending_command_count() == 0);
    const auto& navigated_view = published_view(navigated);
    REQUIRE(navigated_view.room);
    CHECK(navigated_view.room->room.text() == "hall");

    REQUIRE(execute_session_lua(
        fixture, "local ok, err = noveltea.layouts.clear('custom'); assert(ok and err == nil)",
        "typed-map-layout-clear"));
    auto cleared = fixture.session->dispatch(
        core::RuntimeInputMessage{core::AdvanceTimeInput{std::chrono::milliseconds{0}}});
    REQUIRE(cleared.diagnostics.empty());
    auto cleared_layout = fixture.session->gateway().layout(core::compiled::LayoutSlot::Custom);
    REQUIRE(cleared_layout);
    CHECK_FALSE(cleared_layout.value());
    const auto& cleared_view = published_view(cleared);
    REQUIRE(cleared_view.maps.size() == 1);
}

TEST_CASE("runtime Lua environment controls enqueue typed long-lived desired state")
{
    Fixture fixture;
    auto started = fixture.session->dispatch(core::RuntimeInputMessage{core::StartRuntimeInput{}});
    REQUIRE(started.diagnostics.empty());
    REQUIRE(execute_session_lua(
        fixture,
        "local ok, err = noveltea.presentation.set_environment('rain', 'sprite-material', "
        "{owner='session', asset='image-main', stop_key='weather', "
        "plane='world-overlay', order=9, clock='gameplay', scroll_y=0.2, opacity=0.7}); "
        "assert(ok and err == nil)\n"
        "ok, err = noveltea.presentation.set_environment('rain', 'sprite-material', "
        "{owner='session', asset='image-main', stop_key='weather', "
        "plane='world-overlay', order=10, scroll_y=0.3, opacity=0.4}); "
        "assert(ok and err == nil)\n"
        "ok, err = noveltea.presentation.set_environment('mist', 'sprite-material', "
        "{owner='session', stop_key='weather', plane='world-background'}); "
        "assert(ok and err == nil)",
        "typed-presentation-environment"));
    auto flushed = fixture.session->dispatch(
        core::RuntimeInputMessage{core::AdvanceTimeInput{std::chrono::milliseconds{0}}});
    REQUIRE(flushed.diagnostics.empty());
    REQUIRE(flushed.publication);
    const auto& environments = flushed.publication->presentation.environments;
    REQUIRE(environments.size() == 2);
    const auto rain = std::find_if(environments.begin(), environments.end(), [](const auto& value) {
        return value.instance.text() == "rain";
    });
    REQUIRE(rain != environments.end());
    CHECK(rain->stop_key.text() == "weather");
    CHECK(rain->order == 10);
    CHECK(rain->scroll_per_second.y == Catch::Approx(0.3));
    CHECK(rain->opacity == Catch::Approx(0.4));

    REQUIRE(execute_session_lua(
        fixture,
        "local ok, err = noveltea.presentation.set_environment('invalid', 'sprite-material', "
        "{owner='session', asset='missing'}); assert(ok and err == nil)",
        "typed-presentation-environment-invalid"));
    auto rejected = fixture.session->dispatch(
        core::RuntimeInputMessage{core::AdvanceTimeInput{std::chrono::milliseconds{0}}});
    CHECK_FALSE(rejected.diagnostics.empty());

    REQUIRE(execute_session_lua(
        fixture,
        "local ok, err = noveltea.presentation.set_environment('rain', 'sprite-material', "
        "{owner='session', asset='image-main', stop_key='weather', "
        "plane='world-overlay', order=11}); assert(ok and err == nil)",
        "typed-presentation-environment-after-rejection"));
    auto recovered = fixture.session->dispatch(
        core::RuntimeInputMessage{core::AdvanceTimeInput{std::chrono::milliseconds{0}}});
    REQUIRE(recovered.diagnostics.empty());
    REQUIRE(recovered.publication);
    REQUIRE(recovered.publication->presentation.environments.size() == 2);
    CHECK(std::ranges::any_of(recovered.publication->presentation.environments,
                              [](const auto& value) { return value.instance.text() == "mist"; }));

    REQUIRE(
        execute_session_lua(fixture,
                            "local ok, err = noveltea.presentation.stop_environments('weather', "
                            "{owner='session'}); assert(ok and err == nil)",
                            "typed-presentation-environment-stop"));
    auto cleared = fixture.session->dispatch(
        core::RuntimeInputMessage{core::AdvanceTimeInput{std::chrono::milliseconds{0}}});
    REQUIRE(cleared.diagnostics.empty());
    REQUIRE(cleared.publication);
    CHECK(cleared.publication->presentation.environments.empty());
}

TEST_CASE("runtime Lua Material Parameters and postprocess effects stay semantic and queryable")
{
    Fixture fixture("scene-program.json");
    auto started = fixture.session->dispatch(core::RuntimeInputMessage{core::StartRuntimeInput{}});
    REQUIRE(started.diagnostics.empty());

    REQUIRE(execute_session_lua(
        fixture,
        "local ok, err = noveltea.presentation.set_background({owner='session', "
        "material='sprite-material', color='#ffffff'}); assert(ok and err == nil)\n"
        "ok, err = noveltea.presentation.set_material_parameter({kind='background'}, "
        "'sprite-material', 'u_tint', {r=0.2,g=0.4,b=0.6,a=1.0}, "
        "{owner='session', clock='gameplay'}); assert(ok and err == nil)\n"
        "ok, err = noveltea.presentation.set_postprocess('lua-grade', "
        "'scene-postprocess-material', {owner='session', scope='world', order=7, "
        "clock='unscaled-presentation'}); assert(ok and err == nil)\n"
        "ok, err = noveltea.presentation.set_material_parameter({kind='postprocess', "
        "instance_id='lua-grade'}, 'scene-postprocess-material', 'u_strength', 0.75, "
        "{owner='session', clock='unscaled-presentation'}); assert(ok and err == nil)",
        "typed-material-presentation-set"));
    auto flushed = fixture.session->dispatch(
        core::RuntimeInputMessage{core::AdvanceTimeInput{std::chrono::milliseconds{0}}});
    REQUIRE(flushed.diagnostics.empty());
    REQUIRE(flushed.publication);
    REQUIRE(flushed.publication->presentation.material_parameters.size() == 2);
    REQUIRE(flushed.publication->presentation.postprocess_effects.size() == 1);

    REQUIRE(execute_session_lua(
        fixture,
        "local parameter, err = noveltea.presentation.material_parameter({kind='background'}, "
        "'sprite-material', 'u_tint', {owner='session'}); assert(parameter ~= nil and "
        "err == nil and parameter.clock == 'gameplay' and parameter.value.r == 0.2 and "
        "parameter.value.a == 1.0)\n"
        "local effect; effect, err = noveltea.presentation.postprocess('lua-grade', "
        "{owner='session'}); assert(effect ~= nil and err == nil and "
        "effect.material == 'scene-postprocess-material' and effect.scope == 'world' and "
        "effect.order == 7 and effect.clock == 'unscaled-presentation' and "
        "effect.visible == true)",
        "typed-material-presentation-query"));

    REQUIRE(execute_session_lua(
        fixture,
        "local ok, err = noveltea.presentation.clear_material_parameter({kind='postprocess', "
        "instance_id='lua-grade'}, 'scene-postprocess-material', 'u_strength', "
        "{owner='session'}); assert(ok and err == nil)\n"
        "ok, err = noveltea.presentation.bind_material_parameter({kind='postprocess', "
        "instance_id='lua-grade'}, 'scene-postprocess-material', 'u_strength', "
        "{kind='standard-facet', facet='occurrence-time'}, "
        "{owner='session', clock='unscaled-presentation'}); assert(ok and err == nil)",
        "typed-material-presentation-bind"));
    auto bound = fixture.session->dispatch(
        core::RuntimeInputMessage{core::AdvanceTimeInput{std::chrono::milliseconds{0}}});
    REQUIRE(bound.diagnostics.empty());
    REQUIRE(execute_session_lua(
        fixture,
        "local parameter, err = noveltea.presentation.material_parameter({kind='postprocess', "
        "instance_id='lua-grade'}, 'scene-postprocess-material', 'u_strength', "
        "{owner='session'}); assert(parameter ~= nil and err == nil and parameter.value == nil "
        "and parameter.binding.kind == 'standard-facet' and "
        "parameter.binding.facet == 'occurrence-time')",
        "typed-material-presentation-binding-query"));

    REQUIRE(execute_session_lua(
        fixture,
        "local ok, err = noveltea.presentation.clear_material_parameter({kind='background'}, "
        "'sprite-material', 'u_tint', {owner='session'}); assert(ok and err == nil)\n"
        "ok, err = noveltea.presentation.clear_material_parameter({kind='postprocess', "
        "instance_id='lua-grade'}, 'scene-postprocess-material', 'u_strength', "
        "{owner='session'}); assert(ok and err == nil)\n"
        "ok, err = noveltea.presentation.clear_postprocess('lua-grade', {owner='session'}); "
        "assert(ok and err == nil)",
        "typed-material-presentation-clear"));
    auto cleared = fixture.session->dispatch(
        core::RuntimeInputMessage{core::AdvanceTimeInput{std::chrono::milliseconds{0}}});
    REQUIRE(cleared.diagnostics.empty());
    CHECK(fixture.session->presentation_state().material_parameters().empty());
    CHECK(fixture.session->presentation_state().postprocess_effects().empty());
}

TEST_CASE("runtime Lua custom gameplay Layout mounts preserve typed policy owner and identity")
{
    Fixture fixture;
    auto started = fixture.session->dispatch(core::RuntimeInputMessage{core::StartRuntimeInput{}});
    REQUIRE(started.diagnostics.empty());

    REQUIRE(execute_session_lua(
        fixture,
        "local ok, err = noveltea.layouts.mount('room-menu', 'hud-assets', "
        "{owner='current-room', plane='menu-overlay', order=4, "
        "clock='unscaled-presentation', input='block-gameplay', pause='continue', "
        "visible=true, dismiss_on_escape=true, composition='interface'}); "
        "assert(ok and err == nil)\n"
        "ok, err = noveltea.layouts.mount('room-menu', 'hud-assets', "
        "{owner='current-room', plane='modal', order=9, clock='unscaled-presentation', "
        "input='modal', pause='pause-while-visible', visible=false, "
        "dismiss_on_escape=true, ui_scale='ignore', text_scale='inherit', "
        "transition='fade', duration_ms=180, skippable=false}); "
        "assert(ok and err == nil)\n"
        "ok, err = noveltea.layouts.mount('second-fade', 'hud-assets', "
        "{owner='session', transition='fade', duration_ms=50}); "
        "assert(not ok and err ~= nil)\n"
        "ok, err = noveltea.layouts.mount('session-hud', 'hud-assets', "
        "{owner='session', plane='game-ui', input='normal'}); assert(ok and err == nil)\n"
        "ok, err = noveltea.layouts.mount('room-overlay', 'hud-assets', "
        "{owner='room', room='start', plane='world-overlay', input='none', "
        "composition='world'}); assert(ok and err == nil)\n"
        "ok, err = noveltea.layouts.mount('bad-plane', 'hud-assets', {plane='invalid'}); "
        "assert(not ok and err ~= nil)\n"
        "ok, err = noveltea.layouts.mount('bad-clock', 'hud-assets', {clock='invalid'}); "
        "assert(not ok and err ~= nil)\n"
        "ok, err = noveltea.layouts.mount('bad-input', 'hud-assets', {input='invalid'}); "
        "assert(not ok and err ~= nil)\n"
        "ok, err = noveltea.layouts.mount('bad-pause', 'hud-assets', {pause='invalid'}); "
        "assert(not ok and err ~= nil)\n"
        "ok, err = noveltea.layouts.mount('bad-ui-scale', 'hud-assets', "
        "{ui_scale='enlarge'}); assert(not ok and err ~= nil)\n"
        "ok, err = noveltea.layouts.mount('bad-text-scale', 'hud-assets', "
        "{text_scale='shrink'}); assert(not ok and err ~= nil)\n"
        "ok, err = noveltea.layouts.mount('bad-transition', 'hud-assets', "
        "{transition='fade', duration_ms=0}); assert(not ok and err ~= nil)\n"
        "ok, err = noveltea.layouts.mount('bad-immediate', 'hud-assets', "
        "{transition='immediate', duration_ms=5}); assert(not ok and err ~= nil)\n"
        "ok, err = noveltea.layouts.mount('scene-menu', 'hud-assets', {owner='scene'}); "
        "assert(not ok and err ~= nil)",
        "typed-custom-layout-mounts"));

    auto flushed = fixture.session->dispatch(
        core::RuntimeInputMessage{core::AdvanceTimeInput{std::chrono::milliseconds{0}}});
    REQUIRE(flushed.diagnostics.empty());
    const auto& layouts = fixture.session->presentation_state().mounted_layouts();
    const auto find_scoped = [&layouts](std::string_view name) {
        return std::find_if(layouts.begin(), layouts.end(), [name](const auto& layout) {
            const auto* scoped = std::get_if<core::ScopedLayoutMountKey>(&layout.key);
            return scoped != nullptr && scoped->instance.text() == name;
        });
    };
    const auto room_menu = find_scoped("room-menu");
    const auto session_hud = find_scoped("session-hud");
    const auto room_overlay = find_scoped("room-overlay");
    REQUIRE(room_menu != layouts.end());
    REQUIRE(session_hud != layouts.end());
    REQUIRE(room_overlay != layouts.end());
    CHECK(find_scoped("second-fade") == layouts.end());
    const auto room_menu_key = room_menu->key;
    CHECK(std::count_if(layouts.begin(), layouts.end(), [](const auto& layout) {
              const auto* scoped = std::get_if<core::ScopedLayoutMountKey>(&layout.key);
              return scoped != nullptr && scoped->instance.text() == "room-menu";
          }) == 1);
    CHECK(std::holds_alternative<core::CurrentRoomPresentationOwner>(room_menu->owner));
    CHECK(std::holds_alternative<core::SessionPresentationOwner>(session_hud->owner));
    CHECK(std::holds_alternative<core::RoomPresentationOwner>(room_overlay->owner));
    CHECK(room_menu->policy.plane == core::PresentationPlane::Modal);
    REQUIRE(room_menu->scale_overrides.ui);
    REQUIRE(room_menu->scale_overrides.text);
    CHECK(*room_menu->scale_overrides.ui == core::LayoutScaleInheritance::Ignore);
    CHECK(*room_menu->scale_overrides.text == core::LayoutScaleInheritance::Inherit);
    CHECK(room_menu->policy.local_order == 9);
    CHECK(room_menu->policy.clock == core::LayoutClockDomain::UnscaledPresentation);
    CHECK(room_menu->policy.input == core::LayoutInputMode::Modal);
    CHECK(room_menu->policy.gameplay_pause == core::GameplayPausePolicy::PauseWhileVisible);
    CHECK(room_menu->policy.visibility == core::LayoutVisibility::Hidden);
    CHECK(room_menu->policy.escape_dismissal == core::EscapeDismissalPolicy::Dismiss);
    CHECK(room_overlay->composition_group == core::PresentationCompositionGroup::World);
    REQUIRE(fixture.presentation.presentation_operations.size() == 1);
    const auto* entrance = std::get_if<core::LayoutFinitePresentationOperation>(
        &fixture.presentation.presentation_operations.back());
    REQUIRE(entrance);
    CHECK(entrance->common.duration == std::chrono::milliseconds{180});
    CHECK_FALSE(entrance->common.skippable);
    CHECK(entrance->target.layout == room_menu_key);
    CHECK_FALSE(entrance->completion.has_value());

    REQUIRE(
        execute_session_lua(fixture,
                            "local mounted, err = noveltea.layouts.mounted('room-menu', "
                            "{owner='current-room'}); assert(mounted ~= nil and err == nil); "
                            "assert(mounted.layout == 'hud-assets' and mounted.order == 9 and "
                            "mounted.plane == 'modal' and "
                            "mounted.ui_scale == 'ignore' and "
                            "mounted.text_scale == 'inherit' and "
                            "mounted.clock == 'unscaled-presentation' and "
                            "mounted.input == 'modal' and "
                            "mounted.pause == 'pause-while-visible' and "
                            "mounted.visible == false and mounted.dismiss_on_escape == true and "
                            "mounted.composition == 'interface')\n"
                            "local ok; ok, err = Game.save(23); assert(ok and err == nil)",
                            "typed-custom-layout-query-save"));
    (void)dispatch_settled(*fixture.session, core::RuntimeInputMessage{core::StopRuntimeInput{}});
    CHECK(fixture.saves.has_slot(core::TypedSaveSlotId::manual(23)).value());

    REQUIRE(execute_session_lua(
        fixture,
        "local ok, err = noveltea.layouts.unmount('room-menu', {owner='current-room', "
        "transition='fade', duration_ms=90}); "
        "assert(ok and err == nil)\n"
        "ok, err = noveltea.layouts.unmount('session-hud', {owner='session'}); "
        "assert(ok and err == nil)\n"
        "ok, err = noveltea.layouts.unmount('room-overlay', {owner='room', room='start'}); "
        "assert(ok and err == nil)",
        "typed-custom-layout-unmount"));
    auto removed = fixture.session->dispatch(
        core::RuntimeInputMessage{core::AdvanceTimeInput{std::chrono::milliseconds{0}}});
    REQUIRE(removed.diagnostics.empty());
    CHECK(find_scoped("room-menu") ==
          fixture.session->presentation_state().mounted_layouts().end());
    REQUIRE(fixture.presentation.presentation_operations.size() == 2);
    const auto* exit = std::get_if<core::LayoutFinitePresentationOperation>(
        &fixture.presentation.presentation_operations.back());
    REQUIRE(exit);
    CHECK(exit->common.duration == std::chrono::milliseconds{90});
    CHECK(exit->common.skippable);
    CHECK(exit->target.layout == room_menu_key);

    REQUIRE(execute_session_lua(fixture, "local ok, err = Game.load(23); assert(ok and err == nil)",
                                "typed-custom-layout-load"));
    auto load_request =
        dispatch_settled(*fixture.session, core::RuntimeInputMessage{core::StopRuntimeInput{}});
    REQUIRE(load_request.diagnostics.empty());
    REQUIRE(load_request.session_replacement_request);
    commit_load_candidate(fixture, core::TypedSaveSlotId::manual(23));
    const auto& restored = fixture.session->presentation_state().mounted_layouts();
    CHECK(std::ranges::any_of(restored, [](const auto& layout) {
        const auto* scoped = std::get_if<core::ScopedLayoutMountKey>(&layout.key);
        return scoped != nullptr && scoped->instance.text() == "room-menu" &&
               layout.policy.plane == core::PresentationPlane::Modal &&
               layout.scale_overrides.ui == core::LayoutScaleInheritance::Ignore &&
               layout.scale_overrides.text == core::LayoutScaleInheritance::Inherit &&
               layout.policy.gameplay_pause == core::GameplayPausePolicy::PauseWhileVisible;
    }));
}

TEST_CASE("runtime Lua custom Layout mounts accept typed contract bindings and signal connections")
{
    Fixture fixture("comprehensive.json", {}, [](nlohmann::json& document) {
        auto& layouts = document["resources"]["layouts"];
        auto source = std::find_if(layouts.begin(), layouts.end(), [](const nlohmann::json& value) {
            return value["id"] == "hud-assets";
        });
        REQUIRE(source != layouts.end());
        auto layout = *source;
        layout["id"] = "contract-layout";
        layout["contract"] = {
            {"inputs", nlohmann::json::array({
                           {{"id", "count"},
                            {"type", "integer"},
                            {"nullable", false},
                            {"hasDefault", false},
                            {"defaultValue", nullptr}},
                           {{"id", "mood"},
                            {"type", "string"},
                            {"nullable", false},
                            {"hasDefault", false},
                            {"defaultValue", nullptr}},
                           {{"id", "paused"},
                            {"type", "boolean"},
                            {"nullable", false},
                            {"hasDefault", false},
                            {"defaultValue", nullptr}},
                           {{"id", "title"},
                            {"type", "string"},
                            {"nullable", false},
                            {"hasDefault", false},
                            {"defaultValue", nullptr}},
                       })},
            {"signals",
             nlohmann::json::array({{{"id", "confirm"}, {"fields", nlohmann::json::array()}}})},
            {"state", nullptr},
        };
        layouts.push_back(std::move(layout));
    });
    auto started = fixture.session->dispatch(core::RuntimeInputMessage{core::StartRuntimeInput{}});
    REQUIRE(started.diagnostics.empty());

    REQUIRE(execute_session_lua(
        fixture,
        "local ok, err = noveltea.layouts.mount('contract-widget', 'contract-layout', {"
        "owner='session', inputs={"
        "count={variable='count'}, "
        "mood={property='mood', target={kind='room', id='start'}}, "
        "paused={facet='gameplay-paused'}, title='Status'}, "
        "signals={'confirm'}}); assert(ok and err == nil)",
        "typed-layout-contract-mount"));
    auto flushed = fixture.session->dispatch(
        core::RuntimeInputMessage{core::AdvanceTimeInput{std::chrono::milliseconds{0}}});
    REQUIRE(flushed.diagnostics.empty());
    const auto& layouts = fixture.session->presentation_state().mounted_layouts();
    const auto mounted = std::ranges::find_if(layouts, [](const auto& value) {
        const auto* key = std::get_if<core::ScopedLayoutMountKey>(&value.key);
        return key && key->instance.text() == "contract-widget";
    });
    REQUIRE(mounted != layouts.end());
    REQUIRE(mounted->occurrence);
    CHECK(mounted->inputs.size() == 4);
    CHECK(mounted->connected_signals ==
          std::vector<core::LayoutSignalId>{make_id<core::LayoutSignalIdTag>("confirm")});
    CHECK(std::ranges::any_of(mounted->inputs, [](const auto& input) {
        return input.input.text() == "count" &&
               std::holds_alternative<core::LayoutVariableBinding>(input.source);
    }));
    CHECK(std::ranges::any_of(mounted->inputs, [](const auto& input) {
        return input.input.text() == "mood" &&
               std::holds_alternative<core::LayoutPropertyBinding>(input.source);
    }));
    CHECK(std::ranges::any_of(mounted->inputs, [](const auto& input) {
        return input.input.text() == "paused" &&
               std::holds_alternative<core::LayoutStandardFacetBinding>(input.source);
    }));
    CHECK(std::ranges::any_of(mounted->inputs, [](const auto& input) {
        const auto* literal = std::get_if<core::LayoutLiteralInput>(&input.source);
        return input.input.text() == "title" && literal &&
               literal->value == core::RuntimeValue{std::string{"Status"}};
    }));
}

TEST_CASE("runtime Lua custom gameplay Layouts can use active Scene ownership")
{
    Fixture fixture("scene-program.json");
    auto started = fixture.session->dispatch(core::RuntimeInputMessage{core::StartRuntimeInput{}});
    REQUIRE(started.diagnostics.empty());
    auto owner = fixture.session->gateway().presentation_owner(
        runtime::RuntimePresentationOwnerScope::Scene);
    REQUIRE(owner);
    CHECK(std::holds_alternative<core::ScenePresentationOwner>(*owner.value_if()));

    REQUIRE(
        execute_session_lua(fixture,
                            "local ok, err = noveltea.layouts.mount('scene-overlay', 'hud-assets', "
                            "{owner='scene', plane='world-overlay', composition='world'}); "
                            "assert(ok and err == nil)",
                            "typed-scene-layout-owner"));
    auto flushed = fixture.session->dispatch(
        core::RuntimeInputMessage{core::AdvanceTimeInput{std::chrono::milliseconds{0}}});
    REQUIRE(flushed.diagnostics.empty());
    const auto& layouts = fixture.session->presentation_state().mounted_layouts();
    const auto found = std::ranges::find_if(layouts, [](const auto& layout) {
        const auto* scoped = std::get_if<core::ScopedLayoutMountKey>(&layout.key);
        return scoped != nullptr && scoped->instance.text() == "scene-overlay";
    });
    REQUIRE(found != layouts.end());
    CHECK(std::holds_alternative<core::ScenePresentationOwner>(found->owner));
    CHECK(found->composition_group == core::PresentationCompositionGroup::World);
}

TEST_CASE("runtime Lua scoped presentation families share typed owner commands and queries")
{
    Fixture fixture;
    auto started = fixture.session->dispatch(core::RuntimeInputMessage{core::StartRuntimeInput{}});
    REQUIRE(started.diagnostics.empty());
    REQUIRE(execute_session_lua(
        fixture,
        "local ok, err = noveltea.presentation.set_background({owner='current-room', "
        "color='#223344', fit='contain'}); assert(ok and err == nil)\n"
        "ok, err = noveltea.presentation.set_actor('speaker', 'hero', 'stage', 'default', "
        "'neutral', "
        "{owner='current-room', position='left', offset_x=0.1, offset_y=-0.2, scale=1.2}); "
        "assert(ok and err == nil)\n"
        "ok, err = noveltea.presentation.set_prop('lantern', {owner='current-room', "
        "asset='image-main', material='sprite-material', x=0.2, y=0.3, width=0.1, "
        "height=0.2, plane='world-overlay', order=6}); assert(ok and err == nil)\n"
        "ok, err = noveltea.presentation.set_environment('rain-query', 'sprite-material', "
        "{owner='current-room', asset='image-main', stop_key='weather-query', order=7}); "
        "assert(ok and err == nil)",
        "typed-scoped-presentation-set"));
    auto flushed = fixture.session->dispatch(
        core::RuntimeInputMessage{core::AdvanceTimeInput{std::chrono::milliseconds{0}}});
    REQUIRE(flushed.diagnostics.empty());

    REQUIRE(execute_session_lua(
        fixture,
        "local background, err = noveltea.presentation.background({owner='current-room'}); "
        "assert(background ~= nil and err == nil and background.color == '#223344')\n"
        "local actor; actor, err = noveltea.presentation.actor('speaker', "
        "{owner='current-room'}); assert(actor ~= nil and err == nil and "
        "actor.character == 'hero' and actor.pose == 'default' and actor.scale == 1.2)\n"
        "local prop; prop, err = noveltea.presentation.prop('lantern', "
        "{owner='current-room'}); assert(prop ~= nil and err == nil and prop.asset == "
        "'image-main' and prop.order == 6 and prop.visible == true)\n"
        "local environment; environment, err = noveltea.presentation.environment("
        "'rain-query', {owner='current-room'}); assert(environment ~= nil and err == nil and "
        "environment.stop_key == 'weather-query' and environment.order == 7)",
        "typed-scoped-presentation-query"));

    REQUIRE(execute_session_lua(
        fixture,
        "local ok, err = noveltea.presentation.clear_background({owner='current-room'}); "
        "assert(ok and err == nil)\n"
        "ok, err = noveltea.presentation.clear_actor('speaker', {owner='current-room'}); "
        "assert(ok and err == nil)\n"
        "ok, err = noveltea.presentation.clear_prop('lantern', {owner='current-room'}); "
        "assert(ok and err == nil)\n"
        "ok, err = noveltea.presentation.clear_environment('rain-query', "
        "{owner='current-room'}); assert(ok and err == nil)",
        "typed-scoped-presentation-clear"));
    auto cleared = fixture.session->dispatch(
        core::RuntimeInputMessage{core::AdvanceTimeInput{std::chrono::milliseconds{0}}});
    REQUIRE(cleared.diagnostics.empty());
    CHECK(fixture.session->presentation_state().background_overrides().empty());
    CHECK(fixture.session->presentation_state().actors().empty());
    CHECK(fixture.session->presentation_state().presentation_props().empty());
    CHECK(fixture.session->presentation_state().presentation_environments().empty());
}

TEST_CASE("Layout event capability profiles admit gameplay presentation and deny shell mutation")
{
    Fixture fixture;
    auto started = fixture.session->dispatch(core::RuntimeInputMessage{core::StartRuntimeInput{}});
    REQUIRE(started.diagnostics.empty());
    REQUIRE(execute_session_lua_with_profile(
        fixture,
        "local ok, err = noveltea.layouts.mount('event-menu', 'hud-assets', "
        "{owner='current-room', plane='menu-overlay'}); assert(ok and err == nil)",
        "gameplay-layout-event", runtime::RuntimeCapabilityProfile::GameplayLayoutEvent));
    REQUIRE(execute_session_lua_with_profile(
        fixture,
        "local ok, err = noveltea.layouts.mount('forbidden-menu', 'hud-assets', "
        "{owner='session'}); shell_layout_denied = (not ok and err ~= nil and "
        "string.find(err, 'not admitted', 1, true) ~= nil)",
        "shell-layout-event", runtime::RuntimeCapabilityProfile::ShellLayoutEvent));
    auto denied = fixture.runtime.evaluate_bool("shell_layout_denied", "shell-layout-denied");
    REQUIRE(denied);
    CHECK(denied.value());
    auto flushed = fixture.session->dispatch(
        core::RuntimeInputMessage{core::AdvanceTimeInput{std::chrono::milliseconds{0}}});
    REQUIRE(flushed.diagnostics.empty());
    CHECK(std::ranges::any_of(
        fixture.session->presentation_state().mounted_layouts(), [](const auto& layout) {
            const auto* scoped = std::get_if<core::ScopedLayoutMountKey>(&layout.key);
            return scoped != nullptr && scoped->instance.text() == "event-menu";
        }));
    CHECK_FALSE(std::ranges::any_of(
        fixture.session->presentation_state().mounted_layouts(), [](const auto& layout) {
            const auto* scoped = std::get_if<core::ScopedLayoutMountKey>(&layout.key);
            return scoped != nullptr && scoped->instance.text() == "forbidden-menu";
        }));
}

TEST_CASE("runtime Lua pause blocks gameplay and is reset by typed load")
{
    Fixture fixture;
    auto started = fixture.session->dispatch(core::RuntimeInputMessage{core::StartRuntimeInput{}});
    REQUIRE(started.diagnostics.empty());
    REQUIRE(execute_session_lua(fixture,
                                "local ok, err = Game.pause(); assert(ok and err == nil)\n"
                                "ok, err = Game.pause(); assert(ok and err == nil)\n"
                                "paused_value = assert(Game.paused())\n"
                                "ok, err = Game.save(13); assert(ok and err == nil)",
                                "typed-pause"));
    auto paused =
        dispatch_settled(*fixture.session, core::RuntimeInputMessage{core::StopRuntimeInput{}});
    REQUIRE(paused.diagnostics.empty());
    CHECK(published_view(paused).gameplay_paused);
    auto paused_value = fixture.runtime.evaluate_bool("paused_value", "typed-pause-value");
    REQUIRE(paused_value);
    CHECK(paused_value.value());

    auto blocked = fixture.session->dispatch(core::RuntimeInputMessage{core::ContinueInput{}});
    CHECK(blocked.disposition == runtime::RuntimeInputDisposition::Unhandled);
    CHECK_FALSE(blocked.publication.has_value());
    CHECK(published_view(paused).gameplay_paused);

    REQUIRE(
        execute_session_lua(fixture, "local ok = Game.load(13); assert(ok)", "typed-pause-load"));
    auto load_request =
        fixture.session->dispatch(core::RuntimeInputMessage{core::StopRuntimeInput{}});
    REQUIRE(load_request.diagnostics.empty());
    REQUIRE(load_request.session_replacement_request);
    commit_load_candidate(fixture, core::TypedSaveSlotId::manual(13));
    CHECK_FALSE(fixture.session->explicit_gameplay_paused());
    REQUIRE(execute_session_lua(fixture,
                                "local ok, err = Game.resume(); assert(ok and err == nil); "
                                "assert(Game.paused() == false)",
                                "typed-pause-resume"));
}

TEST_CASE("runtime Lua pause takes effect before the next typed instruction")
{
    auto document = load_document("scene-program.json");
    auto& opening = document["definitions"]["scenes"][1];
    opening["program"]["events"] = scene_events(nlohmann::json::array(
        {{{"id", "pause"},
          {"kind", "run-lua"},
          {"autosaveSafePoint", false},
          {"mayYield", false},
          {"source", "local ok, err = Game.pause(); assert(ok and err == nil)"}},
         {{"id", "after-pause"},
          {"kind", "set-global-property"},
          {"property", {{"kind", "property"}, {"id", "count"}}},
          {"value", 77}}}));
    auto project = decode_document(std::move(document), "typed-pause-in-flow.json");
    test_support::MemoryScriptSource sources;
    ScriptRuntime runtime;
    REQUIRE(runtime.initialize({&sources}));
    prepare_project_scripts(runtime, project);
    FakePresentationRuntime presentation;
    core::TypedMemorySaveSlotStore saves;
    auto created =
        test_support::create_runtime_session(project, runtime, presentation, saves, "en");
    REQUIRE(created);
    auto session = std::move(created).value();

    auto paused = session->dispatch(core::RuntimeInputMessage{core::StartRuntimeInput{}});
    REQUIRE(paused.diagnostics.empty());
    CHECK(published_view(paused).gameplay_paused);
    CHECK(session->gateway().global_property(make_id<core::PropertyIdTag>("count")).value() ==
          core::RuntimeValue{std::int64_t{2}});

    runtime::RuntimeCapabilityIssuer issuer(session->gateway(), session->gateway().generation());
    auto capabilities = issuer.issue(runtime::RuntimeCapabilityProfile::GameplayScript);
    REQUIRE(capabilities.has_value());
    auto invoked = runtime.invoke(
        runtime::ScriptInvocationRequest{
            .source = "local ok, err = Game.resume(); assert(ok and err == nil)",
            .chunk_name = "typed-pause-in-flow-resume",
            .source_context = session->gateway().current_source_context(),
            .result_kind = runtime::ScriptInvocationResultKind::None},
        *capabilities);
    REQUIRE(invoked);
    auto resumed = session->dispatch(
        core::RuntimeInputMessage{core::AdvanceTimeInput{std::chrono::microseconds{0}}});
    REQUIRE(resumed.diagnostics.empty());
    CHECK_FALSE(published_view(resumed).gameplay_paused);
    CHECK(session->gateway().global_property(make_id<core::PropertyIdTag>("count")).value() ==
          core::RuntimeValue{std::int64_t{77}});
}

TEST_CASE("effective Layout pause gates gameplay without changing Lua pause state")
{
    Fixture fixture;
    auto started = fixture.session->dispatch(core::RuntimeInputMessage{core::StartRuntimeInput{}});
    REQUIRE(started.diagnostics.empty());
    fixture.session->set_effective_gameplay_pause(
        {.paused = true,
         .active_sources = {{.kind = core::GameplayPauseSourceKind::MountedLayout,
                             .layout_instance = core::MountedLayoutInstanceId::from_number(41)}}});

    auto blocked = fixture.session->dispatch(core::RuntimeInputMessage{core::ContinueInput{}});
    CHECK(blocked.disposition == runtime::RuntimeInputDisposition::Unhandled);
    const auto& blocked_view = published_view(blocked);
    CHECK_FALSE(blocked_view.gameplay_paused);
    CHECK(blocked_view.effective_gameplay_pause.paused);
    REQUIRE(blocked_view.effective_gameplay_pause.active_sources.size() == 1);

    REQUIRE(execute_session_lua(fixture,
                                "assert(Game.paused() == false); "
                                "local ok, err = Game.resume(); assert(ok and err == nil)",
                                "typed-effective-pause"));
    auto lifecycle = fixture.session->dispatch(core::RuntimeInputMessage{core::StopRuntimeInput{}});
    REQUIRE(lifecycle.diagnostics.empty());
    CHECK_FALSE(lifecycle.publication.has_value());
    CHECK(blocked_view.effective_gameplay_pause.paused);

    fixture.session->set_effective_gameplay_pause({});
    auto admitted = fixture.session->dispatch(
        core::RuntimeInputMessage{core::AdvanceTimeInput{std::chrono::microseconds{0}}});
    CHECK(admitted.disposition != runtime::RuntimeInputDisposition::Unhandled);
    CHECK_FALSE(published_view(admitted).effective_gameplay_pause.paused);
}

TEST_CASE("effective pause derives explicit state from the authoritative runtime session")
{
    Fixture fixture;
    CHECK_FALSE(fixture.session->explicit_gameplay_paused());
    REQUIRE(execute_session_lua(fixture, "local ok, err = Game.pause(); assert(ok and err == nil)",
                                "typed-explicit-pause-source"));
    CHECK(fixture.session->explicit_gameplay_paused());
    REQUIRE(execute_session_lua(fixture, "local ok, err = Game.resume(); assert(ok and err == nil)",
                                "typed-explicit-resume-source"));
    CHECK_FALSE(fixture.session->explicit_gameplay_paused());
}

TEST_CASE("runtime Lua text log validates metadata and survives save restore")
{
    Fixture fixture;
    REQUIRE(execute_session_lua(
        fixture,
        "local ok, err = noveltea.text_log.append('notification', 'system', "
        "'[b]Saved[/b]', 'active-text'); assert(ok and err == nil)\n"
        "ok, err = noveltea.text_log.append('line', 'system', 'bad', 'plain'); "
        "assert(not ok and err ~= nil)\n"
        "ok, err = noveltea.text_log.append('notification', 'legacy', 'bad', 'plain'); "
        "assert(not ok and err ~= nil)",
        "typed-text-log"));
    auto promoted =
        dispatch_settled(*fixture.session, core::RuntimeInputMessage{core::StopRuntimeInput{}});
    REQUIRE(promoted.diagnostics.empty());
    const auto& saved_view = published_view(promoted);
    REQUIRE(execute_session_lua(fixture, "local ok, err = Game.save(14); assert(ok and err == nil)",
                                "typed-text-log-save"));
    auto saved =
        dispatch_settled(*fixture.session, core::RuntimeInputMessage{core::StopRuntimeInput{}});
    REQUIRE(saved.diagnostics.empty());
    REQUIRE(saved_view.text_log.entries.size() == 1);
    CHECK(saved_view.text_log.entries.front().text == "[b]Saved[/b]");
    CHECK(saved_view.text_log.entries.front().markup == core::TextMarkup::ActiveText);

    REQUIRE(execute_session_lua(fixture,
                                "local ok = noveltea.text_log.clear(); assert(ok)\n"
                                "ok = Game.load(14); assert(ok)",
                                "typed-text-log-load"));
    auto load_request =
        fixture.session->dispatch(core::RuntimeInputMessage{core::StopRuntimeInput{}});
    REQUIRE(load_request.diagnostics.empty());
    REQUIRE(load_request.session_replacement_request);
    commit_load_candidate(fixture, core::TypedSaveSlotId::manual(14));
    auto restored = fixture.session->publish_initial_state();
    REQUIRE(restored.diagnostics.empty());
    const auto& restored_view = published_view(restored);
    REQUIRE(restored_view.text_log.entries.size() == 1);
    CHECK(restored_view.text_log.entries.front().text == "[b]Saved[/b]");
}

TEST_CASE(
    "runtime Lua audio emits typed operations and awaited completion resumes exact invocation")
{
    Fixture immediate;
    REQUIRE(execute_session_lua(
        immediate,
        "local ok, err = audio.set_music('audio-voice', "
        "{fade_in_ms=10, fade_out_ms=20, gain=0.6}); assert(ok and err == nil)\n"
        "ok, err = audio.play('audio-voice', 'voice', "
        "{fade_ms=25, gain=0.5}); assert(ok and err == nil)\n"
        "ok, err = audio.play('missing', 'voice'); assert(not ok and err ~= nil)\n"
        "ok, err = audio.play('image-main', 'voice'); assert(not ok and err ~= nil)\n"
        "ok, err = audio.play_ui('audio-voice'); assert(ok and err == nil)",
        "typed-audio-immediate"));
    auto settled = immediate.session->dispatch(core::RuntimeInputMessage{
        core::SetVariableDebugInput{make_id<core::PropertyIdTag>("count"), std::int64_t{2}}});
    REQUIRE(settled.diagnostics.empty());
    REQUIRE(execute_session_lua(
        immediate,
        "local state, err = audio.state('background-music'); assert(state and err == nil)\n"
        "assert(state.asset == 'audio-voice' and state.purpose == 'music' and "
        "state.gain == 0.6 and state.fade_in_ms == 10 and state.fade_out_ms == 20)",
        "typed-audio-desired-state"));
    auto emitted = immediate.session->dispatch(core::RuntimeInputMessage{core::StopRuntimeInput{}});
    REQUIRE(emitted.diagnostics.empty());
    REQUIRE(immediate.presentation.audio_operations.size() == 2);
    const auto* immediate_operation = &immediate.presentation.audio_operations.front();
    CHECK(immediate_operation->action == core::compiled::AudioAction::FadeIn);
    CHECK(immediate_operation->purpose == core::compiled::AudioPurpose::Voice);
    CHECK(immediate_operation->asset == make_id<core::AssetIdTag>("audio-voice"));
    REQUIRE(immediate_operation->audio_owner);
    CHECK(immediate_operation->causality == core::compiled::AudioCausality::Causal);
    CHECK(immediate_operation->pause_policy == core::compiled::AudioPausePolicy::Gameplay);
    CHECK_FALSE(immediate_operation->completion_owner);
    CHECK_FALSE(immediate_operation->completion);
    CHECK(std::holds_alternative<core::NewAudioPlaybackTarget>(immediate_operation->target));
    const auto& ui_operation = immediate.presentation.audio_operations.back();
    CHECK(ui_operation.action == core::compiled::AudioAction::Play);
    CHECK(ui_operation.purpose == core::compiled::AudioPurpose::UiSound);
    CHECK(ui_operation.asset == make_id<core::AssetIdTag>("audio-voice"));
    REQUIRE(ui_operation.audio_owner);
    CHECK(ui_operation.causality == core::compiled::AudioCausality::Disposable);
    CHECK(ui_operation.pause_policy == core::compiled::AudioPausePolicy::Unscaled);
    CHECK_FALSE(ui_operation.completion_owner);
    CHECK_FALSE(ui_operation.completion);
    CHECK(std::holds_alternative<core::NewAudioPlaybackTarget>(ui_operation.target));

    auto document = load_document("scene-program.json");
    auto& opening = document["definitions"]["scenes"][1];
    opening["program"]["events"] = scene_events(nlohmann::json::array(
        {{{"id", "lua"},
          {"kind", "run-lua"},
          {"autosaveSafePoint", false},
          {"mayYield", true},
          {"source", "local ok, err = audio.play_and_wait('audio-voice', 'voice', {gain=0.4}); "
                     "assert(ok and err == nil); Game.set_prop('count', 50); "
                     "ok, err = audio.stop_and_wait('voice', {fade_ms=5}); "
                     "assert(ok and err == nil); Game.set_prop('count', 77)"}}}));
    auto project = decode_document(std::move(document), "typed-audio-await.json");
    test_support::MemoryScriptSource sources;
    ScriptRuntime runtime;
    REQUIRE(runtime.initialize({&sources}));
    prepare_project_scripts(runtime, project);
    FakePresentationRuntime presentation;
    core::TypedMemorySaveSlotStore saves;
    auto created =
        test_support::create_runtime_session(project, runtime, presentation, saves, "en");
    REQUIRE(created);
    auto session = std::move(created).value();

    auto blocked = session->dispatch(core::RuntimeInputMessage{core::StartRuntimeInput{}});
    REQUIRE(blocked.diagnostics.empty());
    REQUIRE(presentation.audio_operations.size() == 1);
    const auto* awaited = &presentation.audio_operations.front();
    REQUIRE(awaited->completion_owner);
    REQUIRE(awaited->completion);
    REQUIRE(std::holds_alternative<core::ScriptInvocationHandle>(*awaited->completion));
    const auto owner = *awaited->completion_owner;
    const auto completion = *awaited->completion;
    const auto operation = awaited->id;

    auto stale = session->dispatch(core::RuntimeInputMessage{core::CompleteAudioInput{
        core::AudioOperationId::from_number(operation.number() + 1), owner, completion}});
    CHECK(stale.disposition == runtime::RuntimeInputDisposition::Failed);
    REQUIRE(stale.diagnostics.size() == 1);
    CHECK(stale.diagnostics.front().code == "runtime.stale_audio_completion");
    CHECK(session->gateway().global_property(make_id<core::PropertyIdTag>("count")).value() ==
          core::RuntimeValue{std::int64_t{2}});

    auto completed = session->dispatch(
        core::RuntimeInputMessage{core::CompleteAudioInput{operation, owner, completion}});
    REQUIRE(completed.diagnostics.empty());
    CHECK(session->gateway().global_property(make_id<core::PropertyIdTag>("count")).value() ==
          core::RuntimeValue{std::int64_t{50}});
    REQUIRE(presentation.audio_operations.size() == 2);
    const auto* second = &presentation.audio_operations.back();
    CHECK(second->action == core::compiled::AudioAction::FadeOut);
    REQUIRE(second->completion_owner);
    REQUIRE(second->completion);
    const auto second_operation = second->id;
    const auto second_owner = *second->completion_owner;
    const auto second_completion = *second->completion;
    auto stopped = session->dispatch(core::RuntimeInputMessage{
        core::CompleteAudioInput{second_operation, second_owner, second_completion}});
    REQUIRE(stopped.diagnostics.empty());
    CHECK(session->gateway().global_property(make_id<core::PropertyIdTag>("count")).value() ==
          core::RuntimeValue{std::int64_t{77}});
}

TEST_CASE("Dialogue reveal crosses audio cues exactly once and resumes after cancellation")
{
    auto project = make_dialogue_cue_project(
        nlohmann::json::array({{{"id", "sfx-before"},
                                {"kind", "sound-effect"},
                                {"position", {{"offset", 1}, {"order", 0}}},
                                {"asset", {{"kind", "asset"}, {"id", "audio-voice"}}},
                                {"pausePolicy", "gameplay"},
                                {"gain", 1.0},
                                {"pan", 0.0},
                                {"waitForCompletion", false},
                                {"causality", "disposable"},
                                {"synchronized", false},
                                {"skipBehavior", "suppress"}},
                               {{"id", "voice"},
                                {"kind", "voice"},
                                {"position", {{"offset", 2}, {"order", 0}}},
                                {"asset", {{"kind", "asset"}, {"id", "audio-voice"}}},
                                {"pausePolicy", "gameplay"},
                                {"gain", 0.75},
                                {"pan", -0.25},
                                {"waitForCompletion", true},
                                {"skipBehavior", "stop"}},
                               {{"id", "sfx-after"},
                                {"kind", "sound-effect"},
                                {"position", {{"offset", 3}, {"order", 0}}},
                                {"asset", {{"kind", "asset"}, {"id", "audio-voice"}}},
                                {"pausePolicy", "gameplay"},
                                {"gain", 0.5},
                                {"pan", 0.25},
                                {"waitForCompletion", false},
                                {"causality", "causal"},
                                {"synchronized", false},
                                {"skipBehavior", "suppress"}}}),
        "dialogue-cue-audio.json");
    test_support::MemoryScriptSource sources;
    ScriptRuntime runtime;
    REQUIRE(runtime.initialize({&sources}));
    prepare_project_scripts(runtime, project);
    FakePresentationRuntime presentation;
    core::TypedMemorySaveSlotStore saves;
    auto created =
        test_support::create_runtime_session(project, runtime, presentation, saves, "en");
    REQUIRE(created);
    auto session = std::move(created).value();

    auto started = session->dispatch(core::RuntimeInputMessage{core::StartRuntimeInput{}});
    REQUIRE(started.diagnostics.empty());
    const auto& start_view = published_view(started);
    REQUIRE(start_view.dialogue);
    REQUIRE(start_view.dialogue->segment);
    const auto frame = start_view.dialogue->frame;
    const auto dialogue = start_view.dialogue->dialogue;
    const auto segment = *start_view.dialogue->segment;

    auto first = session->dispatch(core::RuntimeInputMessage{
        core::AdvanceDialogueRevealInput{frame, dialogue, segment, 1, false}});
    REQUIRE(first.diagnostics.empty());
    REQUIRE(presentation.audio_operations.size() == 1);
    CHECK(presentation.audio_operations.front().purpose ==
          core::compiled::AudioPurpose::SoundEffect);
    CHECK(presentation.audio_operations.front().causality ==
          core::compiled::AudioCausality::Disposable);
    REQUIRE(presentation.audio_operations.front().audio_owner);
    const auto* cue_owner = std::get_if<core::DialoguePresentationOwner>(
        &*presentation.audio_operations.front().audio_owner);
    REQUIRE(cue_owner != nullptr);
    CHECK(cue_owner->invocation == frame);
    CHECK(cue_owner->dialogue == dialogue);

    auto repeated = session->dispatch(core::RuntimeInputMessage{
        core::AdvanceDialogueRevealInput{frame, dialogue, segment, 1, false}});
    REQUIRE(repeated.diagnostics.empty());
    CHECK(presentation.audio_operations.size() == 1);

    auto voice = session->dispatch(core::RuntimeInputMessage{
        core::AdvanceDialogueRevealInput{frame, dialogue, segment, 5, false}});
    REQUIRE(voice.diagnostics.empty());
    REQUIRE(presentation.audio_operations.size() == 2);
    const auto awaited = presentation.audio_operations.back();
    CHECK(awaited.purpose == core::compiled::AudioPurpose::Voice);
    CHECK(awaited.gain == Catch::Approx(0.75));
    CHECK(awaited.pan == Catch::Approx(-0.25));
    REQUIRE(awaited.completion_owner);
    REQUIRE(awaited.completion);
    REQUIRE(std::holds_alternative<core::AudioFlowBlockerHandle>(*awaited.completion));

    auto while_waiting = session->dispatch(core::RuntimeInputMessage{
        core::AdvanceDialogueRevealInput{frame, dialogue, segment, 5, false}});
    REQUIRE(while_waiting.diagnostics.empty());
    CHECK(presentation.audio_operations.size() == 2);

    auto cancelled = session->dispatch(core::RuntimeInputMessage{
        core::CancelAudioInput{awaited.id, *awaited.completion_owner, *awaited.completion}});
    REQUIRE(cancelled.diagnostics.empty());
    CHECK(presentation.audio_operations.size() == 2);

    auto resumed = session->dispatch(core::RuntimeInputMessage{
        core::AdvanceDialogueRevealInput{frame, dialogue, segment, 5, false}});
    REQUIRE(resumed.diagnostics.empty());
    REQUIRE(presentation.audio_operations.size() == 3);
    CHECK(presentation.audio_operations.back().purpose ==
          core::compiled::AudioPurpose::SoundEffect);
    CHECK(presentation.audio_operations.back().causality == core::compiled::AudioCausality::Causal);
}

TEST_CASE("Dialogue fast-forward suppresses unreached disposable audio and skippable camera cues")
{
    const auto cues = nlohmann::json::array({{{"id", "sfx"},
                                              {"kind", "sound-effect"},
                                              {"position", {{"offset", 1}, {"order", 0}}},
                                              {"asset", {{"kind", "asset"}, {"id", "audio-voice"}}},
                                              {"pausePolicy", "gameplay"},
                                              {"gain", 1.0},
                                              {"pan", 0.0},
                                              {"waitForCompletion", false},
                                              {"causality", "disposable"},
                                              {"synchronized", false},
                                              {"skipBehavior", "suppress"}},
                                             {{"id", "voice"},
                                              {"kind", "voice"},
                                              {"position", {{"offset", 2}, {"order", 0}}},
                                              {"asset", {{"kind", "asset"}, {"id", "audio-voice"}}},
                                              {"pausePolicy", "gameplay"},
                                              {"gain", 1.0},
                                              {"pan", 0.0},
                                              {"waitForCompletion", false},
                                              {"skipBehavior", "stop"}},
                                             {{"id", "camera"},
                                              {"kind", "camera"},
                                              {"position", {{"offset", 3}, {"order", 0}}},
                                              {"emphasis",
                                               {{"kind", "shake"},
                                                {"amplitude", {{"x", 4.0}, {"y", 2.0}}},
                                                {"frequencyHz", 12.0},
                                                {"durationMs", 150},
                                                {"skippable", true},
                                                {"waitForCompletion", false}}}}});
    auto project = make_dialogue_cue_project(cues, "dialogue-cue-fast-forward.json");
    test_support::MemoryScriptSource sources;
    ScriptRuntime runtime;
    REQUIRE(runtime.initialize({&sources}));
    prepare_project_scripts(runtime, project);
    FakePresentationRuntime presentation;
    core::TypedMemorySaveSlotStore saves;
    auto created =
        test_support::create_runtime_session(project, runtime, presentation, saves, "en");
    REQUIRE(created);
    auto session = std::move(created).value();

    auto started = session->dispatch(core::RuntimeInputMessage{core::StartRuntimeInput{}});
    REQUIRE(started.diagnostics.empty());
    auto skipped = session->dispatch(core::RuntimeInputMessage{core::ContinueInput{}});
    REQUIRE(skipped.diagnostics.empty());
    CHECK(presentation.audio_operations.empty());
    CHECK(presentation.presentation_operations.empty());
}

TEST_CASE("Dialogue camera cue emits one typed finite operation at its reveal position")
{
    auto project = make_dialogue_cue_project(
        nlohmann::json::array({{{"id", "camera"},
                                {"kind", "camera"},
                                {"position", {{"offset", 1}, {"order", 0}}},
                                {"emphasis",
                                 {{"kind", "punch"},
                                  {"translation", {{"x", 6.0}, {"y", -3.0}}},
                                  {"zoomDelta", 0.15},
                                  {"rotationDegrees", 2.0},
                                  {"durationMs", 120},
                                  {"skippable", true},
                                  {"waitForCompletion", false}}}}}),
        "dialogue-cue-camera.json");
    test_support::MemoryScriptSource sources;
    ScriptRuntime runtime;
    REQUIRE(runtime.initialize({&sources}));
    prepare_project_scripts(runtime, project);
    FakePresentationRuntime presentation;
    core::TypedMemorySaveSlotStore saves;
    auto created =
        test_support::create_runtime_session(project, runtime, presentation, saves, "en");
    REQUIRE(created);
    auto session = std::move(created).value();

    auto started = session->dispatch(core::RuntimeInputMessage{core::StartRuntimeInput{}});
    REQUIRE(started.diagnostics.empty());
    const auto& view = published_view(started);
    REQUIRE(view.dialogue);
    REQUIRE(view.dialogue->segment);
    const auto reveal = core::AdvanceDialogueRevealInput{
        view.dialogue->frame, view.dialogue->dialogue, *view.dialogue->segment, 1, false};
    auto crossed = session->dispatch(core::RuntimeInputMessage{reveal});
    REQUIRE(crossed.diagnostics.empty());
    REQUIRE(presentation.presentation_operations.size() == 1);
    const auto* punch =
        std::get_if<core::CameraPunchOperation>(&presentation.presentation_operations.front());
    REQUIRE(punch != nullptr);
    CHECK(punch->translation.x == Catch::Approx(6.0));
    CHECK(punch->translation.y == Catch::Approx(-3.0));
    CHECK(punch->zoom_delta == Catch::Approx(0.15));
    CHECK(punch->rotation_degrees == Catch::Approx(2.0));

    auto repeated = session->dispatch(core::RuntimeInputMessage{reveal});
    REQUIRE(repeated.diagnostics.empty());
    CHECK(presentation.presentation_operations.size() == 1);
}

} // namespace noveltea::script::test
