#include "host/game_host.hpp"
#include "noveltea/assets/asset_source.hpp"
#include "noveltea/script/script_runtime.hpp"
#include "ui/rmlui/runtime_ui_facade_access.hpp"
#include "ui/rmlui/runtime_ui_playback_driver.hpp"

#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <filesystem>
#include <fstream>
#include <functional>
#include <iterator>
#include <optional>
#include <string>
#include <type_traits>
#include <utility>

namespace noveltea::host {
namespace {

class FakeScriptInvocationPort final : public runtime::ScriptInvocationPort {
public:
    [[nodiscard]] core::Result<runtime::ScriptInvocationOutcome, runtime::ScriptInvocationError>
    invoke(const runtime::ScriptInvocationRequest&, const runtime::RuntimeCapabilitySet&) override
    {
        return core::Result<runtime::ScriptInvocationOutcome, runtime::ScriptInvocationError>::
            success(runtime::ScriptInvocationCompleted{});
    }

    [[nodiscard]] core::Result<runtime::ScriptInvocationOutcome, runtime::ScriptInvocationError>
    resume(const core::ScriptInvocationHandle&, const runtime::RuntimeCapabilitySet&) override
    {
        return core::Result<runtime::ScriptInvocationOutcome, runtime::ScriptInvocationError>::
            failure({.code = runtime::ScriptInvocationErrorCode::StaleInvocation,
                     .message = "stale test invocation",
                     .chunk = "game-host-test",
                     .traceback = "game-host-test: stale test invocation"});
    }

    void cancel(const core::ScriptInvocationHandle&, runtime::ScriptCancellationReason) override {}
    void invalidate_capabilities(runtime::CapabilityGeneration) noexcept override
    {
        if (on_invalidate)
            on_invalidate();
    }

    std::function<void()> on_invalidate;
};

class FakeLayoutRealizer final : public LayoutRealizationSink {
public:
    [[nodiscard]] LayoutRealizationResult
    apply_layout_realization(LayoutRealizationRequest request) override
    {
        if (const auto* recreate = std::get_if<RecreateLayoutRealizationsRequest>(&request)) {
            ++recreate_count;
            last_recreate = *recreate;
        }
        LayoutRealizationResult result;
        result.disposition = LayoutRealizationDisposition::Unchanged;
        return result;
    }

    std::size_t recreate_count = 0;
    std::optional<RecreateLayoutRealizationsRequest> last_recreate;
};

class FakePublicationSink final : public RuntimePublicationSink {
public:
    [[nodiscard]] core::Result<void, core::Diagnostics>
    apply_runtime_publication(const runtime::RuntimePublication& publication) override
    {
        revisions.push_back(publication.revision);
        if (fail_next) {
            fail_next = false;
            return core::Result<void, core::Diagnostics>::failure(
                {{.code = "host.test_preview_publication_failed",
                  .message = "Preview publication failed for test"}});
        }
        if (on_apply)
            on_apply();
        return core::Result<void, core::Diagnostics>::success();
    }

    std::vector<runtime::RuntimePublicationRevision> revisions;
    bool fail_next = false;
    std::function<void()> on_apply;
};

class FakeObservationSink final : public RuntimeObservationSink {
public:
    void observe_runtime_outputs(const runtime::RuntimeObservationSnapshot& observations,
                                 std::span<const runtime::RuntimeEvent> events) override
    {
        snapshots.push_back(observations);
        event_batches.emplace_back(events.begin(), events.end());
    }

    std::vector<runtime::RuntimeObservationSnapshot> snapshots;
    std::vector<std::vector<runtime::RuntimeEvent>> event_batches;
};

class FakeSystemLayoutHost final : public RuntimeSystemLayoutHost {
public:
    [[nodiscard]] core::Result<core::MountedLayoutInstanceId, core::Diagnostics>
    mount_system_layout(core::compiled::SystemLayoutRole, core::MountedLayoutPolicy) override
    {
        if (fail_next_mount) {
            fail_next_mount = false;
            return core::Result<core::MountedLayoutInstanceId, core::Diagnostics>::failure(
                {{.code = "host.test_system_layout_mount_failed",
                  .message = "System Layout mount failed for test"}});
        }
        return core::Result<core::MountedLayoutInstanceId, core::Diagnostics>::success(
            core::MountedLayoutInstanceId::from_number(1));
    }

    [[nodiscard]] core::Result<void, core::Diagnostics>
    set_system_layout_visible(core::MountedLayoutInstanceId, bool) override
    {
        return core::Result<void, core::Diagnostics>::success();
    }

    [[nodiscard]] core::Result<void, core::Diagnostics>
    unmount_system_layout(core::MountedLayoutInstanceId) override
    {
        return core::Result<void, core::Diagnostics>::success();
    }

    [[nodiscard]] bool dispatch_shell_runtime_input(core::RuntimeInputMessage) override
    {
        return true;
    }

    [[nodiscard]] core::Result<void, core::Diagnostics>
    set_runtime_user_settings(core::RuntimeUserSettings) override
    {
        return core::Result<void, core::Diagnostics>::success();
    }

    [[nodiscard]] core::RuntimeShellViewState
    build_runtime_shell_view(core::RuntimeShellScreen screen,
                             const std::optional<core::RuntimeShellConfirmation>& confirmation,
                             bool game_active) override
    {
        core::RuntimeShellViewState view;
        view.screen = screen;
        view.settings = core::RuntimeUserSettings::defaults();
        view.confirmation = confirmation;
        view.game_active = game_active;
        return view;
    }

    void publish_runtime_shell_view(core::RuntimeShellViewState) override {}
    void request_shell_quit() override {}

    bool fail_next_mount = false;
};

std::string minimal_compiled_project_fixture()
{
    const std::string path = std::string(NOVELTEA_SOURCE_DIR) +
                             "/editor/src/renderer/test/fixtures/compiled-project-golden/"
                             "minimal.json";
    std::ifstream file(path, std::ios::binary);
    REQUIRE(file.good());
    return {std::istreambuf_iterator<char>(file), std::istreambuf_iterator<char>()};
}

constexpr const char* kRuntimeUiGenerationDocument = R"(
<rml>
  <head>
    <style>
      body { width: 640px; height: 360px; }
      button { display: block; width: 180px; height: 52px; }
    </style>
  </head>
  <body>
    <button id="action">Action</button>
  </body>
</rml>
)";

TEST_CASE("GameHost owns runtime integration state and borrows explicit host dependencies")
{
    STATIC_REQUIRE_FALSE(std::is_copy_constructible_v<GameHost>);
    STATIC_REQUIRE_FALSE(std::is_move_constructible_v<GameHost>);

    assets::AssetManager assets;
    FakeScriptInvocationPort scripts;
    script::ScriptRuntime script_certifier;
    core::TypedMemorySaveSlotStore saves;
    RuntimeUI runtime_ui;
    FakeLayoutRealizer layout_realizer;
    AudioSystem audio;
    FakePublicationSink preview_sink;
    FakeObservationSink observation_sink;
    core::RuntimeClock runtime_clock;
    GameHostHostValues host_values;
    FakeSystemLayoutHost system_layout_host;

    GameHost host({.content_assets = assets,
                   .script_invocations = scripts,
                   .save_slots = saves,
                   .runtime_ui = runtime_ui,
                   .layout_realizer = &layout_realizer,
                   .audio = audio,
                   .preview_publication_sink = &preview_sink,
                   .observation_sink = &observation_sink,
                   .runtime_clock = runtime_clock,
                   .host_values = host_values,
                   .system_layout_host = system_layout_host,
                   .world_transitions = nullptr,
                   .script_certifier = script_certifier,
                   .diagnostic_sink = {}});

    CHECK(&host.content_assets() == &assets);
    CHECK(&host.script_invocations() == &scripts);
    CHECK(&host.save_slots() == &saves);
    CHECK(&host.runtime_ui() == &runtime_ui);
    CHECK(host.layout_realizer() == &layout_realizer);
    CHECK(&host.audio() == &audio);
    CHECK(host.preview_publication_sink() == &preview_sink);
    CHECK(host.observation_sink() == &observation_sink);
    CHECK(&host.runtime_clock() == &runtime_clock);
    CHECK(&host.host_values() == &host_values);

    CHECK(host.running_game() == nullptr);
    CHECK(host.lifecycle_state() == LoadedGameLifecycleState::Empty);
    CHECK(host.runtime_publication() == std::nullopt);
    CHECK(host.runtime_events().empty());
    CHECK(host.runtime_observations().values.empty());
    CHECK(host.runtime_diagnostics().empty());
    CHECK(host.pending_runtime_inputs().empty());
    CHECK(host.presentation_layout_state().current.empty());
    CHECK(host.presentation_layout_state().retained.empty());
    CHECK(host.presentation_layout_state().current_revision == std::nullopt);

    CHECK(&host.presentation_port() ==
          static_cast<runtime::PresentationRuntimePort*>(&host.runtime_presentation()));
    CHECK(host.checkpoint_status().revision.number() == 1);
    CHECK(host.checkpoint_status().active_barriers.empty());

    const auto generation = host.session_generation();
    CHECK(host.accepts(generation));
    host.invalidate_session_generation();
    CHECK_FALSE(host.accepts(generation));
    CHECK(host.accepts(host.session_generation()));

    core::TypedMemorySaveSlotStore replacement_saves;
    host.bind_save_slots(replacement_saves);
    CHECK(&host.save_slots() == &replacement_saves);

    host_values.host_suspended = true;
    host_values.runtime_input_admitted = false;
    CHECK(host.host_values().host_suspended);
    CHECK_FALSE(host.host_values().runtime_input_admitted);
}

TEST_CASE("GameHost prepares and atomically installs a running game")
{
    assets::AssetManager assets;
    auto project_assets = std::make_shared<assets::MemoryAssetSource>();
    const auto fixture = minimal_compiled_project_fixture();
    project_assets->add("minimal.json", assets::AssetBytes(fixture.begin(), fixture.end()),
                        "game-host-test");
    assets.mount("project", project_assets);

    FakeScriptInvocationPort scripts;
    script::ScriptRuntime script_certifier;
    REQUIRE(script_certifier.initialize({&assets}));
    core::TypedMemorySaveSlotStore saves;
    RuntimeUI runtime_ui;
    FakeLayoutRealizer layout_realizer;
    AudioSystem audio;
    FakePublicationSink preview_sink;
    FakeObservationSink observation_sink;
    core::RuntimeClock runtime_clock;
    GameHostHostValues host_values;
    FakeSystemLayoutHost system_layout_host;

    GameHost host({.content_assets = assets,
                   .script_invocations = scripts,
                   .save_slots = saves,
                   .runtime_ui = runtime_ui,
                   .layout_realizer = &layout_realizer,
                   .audio = audio,
                   .preview_publication_sink = &preview_sink,
                   .observation_sink = &observation_sink,
                   .runtime_clock = runtime_clock,
                   .host_values = host_values,
                   .system_layout_host = system_layout_host,
                   .world_transitions = nullptr,
                   .script_certifier = script_certifier,
                   .diagnostic_sink = {}});

    std::size_t prepare_calls = 0;
    std::size_t detach_calls = 0;
    std::size_t commit_calls = 0;
    GameHostLoadHooks hooks;
    hooks.prepare_candidate = [&](const runtime::RunningGame& candidate,
                                  const runtime::RuntimePublication& publication) {
        ++prepare_calls;
        CHECK(candidate.package().project().identity().name == "Golden Minimal");
        CHECK(publication.revision.number() == 1);
        return core::Result<void, core::Diagnostics>::success();
    };
    hooks.detach_current_resources = [&]() { ++detach_calls; };
    hooks.commit_candidate_resources = [&](const runtime::RunningGame&,
                                           const runtime::RuntimePublication&) { ++commit_calls; };

    auto loaded = host.load_compiled_project({.logical_path = "project:/minimal.json",
                                              .runtime_locale = "en",
                                              .load_title_screen = false,
                                              .stop_runtime_after_load = true},
                                             hooks);

    REQUIRE(loaded);
    REQUIRE(host.running_game() != nullptr);
    CHECK(host.lifecycle_state() == LoadedGameLifecycleState::Stopped);
    CHECK(host.compiled_project_path() == "project:/minimal.json");
    REQUIRE(host.runtime_publication());
    CHECK(host.runtime_publication()->revision.number() == 1);
    CHECK(prepare_calls == 1);
    CHECK(detach_calls == 1);
    CHECK(commit_calls == 1);

    auto* const first_game = host.running_game();
    const auto first_session_generation = host.session_generation();
    const auto first_backend_generation = host.backend_generation();
    bool old_bindings_detached = false;
    scripts.on_invalidate = [&]() { CHECK(old_bindings_detached); };
    GameHostLoadHooks replacement_hooks;
    replacement_hooks.prepare_candidate = [](const runtime::RunningGame&,
                                             const runtime::RuntimePublication&) {
        return core::Result<void, core::Diagnostics>::success();
    };
    replacement_hooks.detach_current_resources = [&]() { old_bindings_detached = true; };
    replacement_hooks.commit_candidate_resources = [](const runtime::RunningGame&,
                                                      const runtime::RuntimePublication&) {};

    auto replaced = host.load_compiled_project({.logical_path = "project:/minimal.json",
                                                .runtime_locale = "en",
                                                .load_title_screen = false,
                                                .stop_runtime_after_load = true},
                                               replacement_hooks);

    REQUIRE(replaced);
    CHECK(old_bindings_detached);
    CHECK(host.running_game() != first_game);
    CHECK(host.session_generation().number() == first_session_generation.number() + 1);
    CHECK(host.backend_generation().number() == first_backend_generation.number() + 1);
    auto stale = host.submit_runtime_input(first_session_generation,
                                           core::RuntimeInputMessage{core::ContinueInput{}});
    REQUIRE_FALSE(stale.accepted());
    CHECK(stale.diagnostics.front().code == "host.stale_runtime_input_generation");
    scripts.on_invalidate = {};
}

TEST_CASE("GameHost rebinds RuntimeUI input to the committed session generation")
{
    assets::AssetManager assets;
    auto project_assets = std::make_shared<assets::MemoryAssetSource>();
    const auto fixture = minimal_compiled_project_fixture();
    project_assets->add("minimal.json", assets::AssetBytes(fixture.begin(), fixture.end()),
                        "game-host-test");
    assets.mount("project", project_assets);
    assets.mount_directory(
        "system", std::filesystem::path(NOVELTEA_SOURCE_DIR) / "engine/assets/system", false);

    FakeScriptInvocationPort scripts;
    script::ScriptRuntime script_certifier;
    REQUIRE(script_certifier.initialize({&assets}));
    core::TypedMemorySaveSlotStore saves;
    RuntimeUI runtime_ui;
    REQUIRE(runtime_ui.initialize(&assets, nullptr, false, &script_certifier, nullptr, true));
    FakeLayoutRealizer layout_realizer;
    AudioSystem audio;
    FakePublicationSink preview_sink;
    FakeObservationSink observation_sink;
    core::RuntimeClock runtime_clock;
    GameHostHostValues host_values;
    FakeSystemLayoutHost system_layout_host;
    core::Diagnostics diagnostics;

    GameHost host({.content_assets = assets,
                   .script_invocations = scripts,
                   .save_slots = saves,
                   .runtime_ui = runtime_ui,
                   .layout_realizer = &layout_realizer,
                   .audio = audio,
                   .preview_publication_sink = &preview_sink,
                   .observation_sink = &observation_sink,
                   .runtime_clock = runtime_clock,
                   .host_values = host_values,
                   .system_layout_host = system_layout_host,
                   .world_transitions = nullptr,
                   .script_certifier = script_certifier,
                   .diagnostic_sink = [&](HostFrameStage, const core::Diagnostic& diagnostic) {
                       diagnostics.push_back(diagnostic);
                   }});

    REQUIRE(host.load_compiled_project({.logical_path = "project:/minimal.json",
                                        .runtime_locale = "en",
                                        .load_title_screen = false,
                                        .stop_runtime_after_load = false},
                                       {}));
    REQUIRE(ui::rmlui::RuntimeUiFacadeAccess::load_document_from_memory(
        runtime_ui, "generation", kRuntimeUiGenerationDocument,
        "preview://runtime-ui-generation.rml", true));

    std::size_t activations = 0;
    const auto listener = ui::rmlui::RuntimeUiFacadeAccess::add_event_listener(
        runtime_ui, "generation", "action", "click", [&activations]() { ++activations; });
    REQUIRE(listener != 0);
    runtime_ui.begin_frame({});

    auto* playback = ui::rmlui::RuntimeUiPlaybackDriver::from(runtime_ui);
    REQUIRE(playback);
    const auto clicked = playback->click({.document_id = "generation", .selector = "#action"});
    CHECK(clicked.status == ui::rmlui::RuntimeUiPlaybackClickStatus::Dispatched);
    CHECK(clicked.dispatched);
    CHECK(activations == 1);
    CHECK(std::none_of(diagnostics.begin(), diagnostics.end(), [](const auto& diagnostic) {
        return diagnostic.code == "host.stale_runtime_ui_input_generation";
    }));

    CHECK(ui::rmlui::RuntimeUiFacadeAccess::remove_event_listener(runtime_ui, listener));
    host.shutdown();
    runtime_ui.shutdown();
}

TEST_CASE("GameHost preserves the current game when candidate preparation fails")
{
    assets::AssetManager assets;
    auto project_assets = std::make_shared<assets::MemoryAssetSource>();
    const auto fixture = minimal_compiled_project_fixture();
    project_assets->add("minimal.json", assets::AssetBytes(fixture.begin(), fixture.end()),
                        "game-host-test");
    assets.mount("project", project_assets);

    FakeScriptInvocationPort scripts;
    script::ScriptRuntime script_certifier;
    REQUIRE(script_certifier.initialize({&assets}));
    core::TypedMemorySaveSlotStore saves;
    RuntimeUI runtime_ui;
    FakeLayoutRealizer layout_realizer;
    AudioSystem audio;
    FakePublicationSink preview_sink;
    FakeObservationSink observation_sink;
    core::RuntimeClock runtime_clock;
    GameHostHostValues host_values;
    FakeSystemLayoutHost system_layout_host;

    GameHost host({.content_assets = assets,
                   .script_invocations = scripts,
                   .save_slots = saves,
                   .runtime_ui = runtime_ui,
                   .layout_realizer = &layout_realizer,
                   .audio = audio,
                   .preview_publication_sink = &preview_sink,
                   .observation_sink = &observation_sink,
                   .runtime_clock = runtime_clock,
                   .host_values = host_values,
                   .system_layout_host = system_layout_host,
                   .world_transitions = nullptr,
                   .script_certifier = script_certifier,
                   .diagnostic_sink = {}});

    GameHostLoadHooks success_hooks;
    success_hooks.prepare_candidate = [](const runtime::RunningGame&,
                                         const runtime::RuntimePublication&) {
        return core::Result<void, core::Diagnostics>::success();
    };
    REQUIRE(host.load_compiled_project({.logical_path = "project:/minimal.json",
                                        .runtime_locale = "en",
                                        .load_title_screen = false,
                                        .stop_runtime_after_load = true},
                                       success_hooks));

    auto* const previous_game = host.running_game();
    const auto previous_generation = host.session_generation();
    const auto previous_backend_generation = host.backend_generation();
    std::size_t detach_calls = 0;
    std::size_t commit_calls = 0;
    GameHostLoadHooks rejected_hooks;
    rejected_hooks.prepare_candidate = [](const runtime::RunningGame&,
                                          const runtime::RuntimePublication&) {
        return core::Result<void, core::Diagnostics>::failure(
            {{.code = "host.test_candidate_rejected",
              .message = "Candidate preparation failed for test"}});
    };
    rejected_hooks.detach_current_resources = [&]() { ++detach_calls; };
    rejected_hooks.commit_candidate_resources =
        [&](const runtime::RunningGame&, const runtime::RuntimePublication&) { ++commit_calls; };

    auto rejected = host.load_compiled_project({.logical_path = "project:/minimal.json",
                                                .runtime_locale = "en",
                                                .load_title_screen = false,
                                                .stop_runtime_after_load = true},
                                               rejected_hooks);

    REQUIRE_FALSE(rejected);
    REQUIRE(rejected.error().size() == 1);
    CHECK(rejected.error().front().code == "host.test_candidate_rejected");
    CHECK(host.running_game() == previous_game);
    CHECK(host.session_generation() == previous_generation);
    CHECK(host.backend_generation() == previous_backend_generation);
    CHECK(host.lifecycle_state() == LoadedGameLifecycleState::Stopped);
    CHECK(detach_calls == 0);
    CHECK(commit_calls == 0);

    auto missing = host.load_compiled_project({.logical_path = "project:/missing.json",
                                               .runtime_locale = "en",
                                               .load_title_screen = false,
                                               .stop_runtime_after_load = true},
                                              rejected_hooks);
    REQUIRE_FALSE(missing);
    CHECK(host.running_game() == previous_game);
    CHECK(host.session_generation() == previous_generation);
    CHECK(host.backend_generation() == previous_backend_generation);
    CHECK(detach_calls == 0);
    CHECK(commit_calls == 0);

    std::size_t rollback_detach_calls = 0;
    std::size_t rollback_commit_calls = 0;
    std::size_t restore_calls = 0;
    GameHostLoadHooks rollback_hooks;
    rollback_hooks.prepare_candidate = [](const runtime::RunningGame&,
                                          const runtime::RuntimePublication&) {
        return core::Result<void, core::Diagnostics>::success();
    };
    rollback_hooks.detach_current_resources = [&]() { ++rollback_detach_calls; };
    rollback_hooks.commit_candidate_resources = [&](const runtime::RunningGame&,
                                                    const runtime::RuntimePublication&) {
        ++rollback_commit_calls;
    };
    rollback_hooks.restore_previous_resources = [&](const runtime::RunningGame&) {
        ++restore_calls;
    };
    system_layout_host.fail_next_mount = true;

    auto rolled_back = host.load_compiled_project({.logical_path = "project:/minimal.json",
                                                   .runtime_locale = "en",
                                                   .load_title_screen = false,
                                                   .stop_runtime_after_load = true},
                                                  rollback_hooks);

    REQUIRE_FALSE(rolled_back);
    CHECK(rolled_back.error().front().code == "host.test_system_layout_mount_failed");
    CHECK(host.running_game() == previous_game);
    CHECK(host.session_generation() == previous_generation);
    CHECK(host.backend_generation() == previous_backend_generation);
    CHECK(host.lifecycle_state() == LoadedGameLifecycleState::Stopped);
    CHECK(host.compiled_project_path() == "project:/minimal.json");
    CHECK(rollback_detach_calls == 1);
    CHECK(rollback_commit_calls == 1);
    CHECK(restore_calls == 1);
}

TEST_CASE("GameHost dispatches once and applies one coherent runtime publication")
{
    assets::AssetManager assets;
    auto project_assets = std::make_shared<assets::MemoryAssetSource>();
    const auto fixture = minimal_compiled_project_fixture();
    project_assets->add("minimal.json", assets::AssetBytes(fixture.begin(), fixture.end()),
                        "game-host-test");
    assets.mount("project", project_assets);

    FakeScriptInvocationPort scripts;
    script::ScriptRuntime script_certifier;
    REQUIRE(script_certifier.initialize({&assets}));
    core::TypedMemorySaveSlotStore saves;
    RuntimeUI runtime_ui;
    FakeLayoutRealizer layout_realizer;
    AudioSystem audio;
    FakePublicationSink preview_sink;
    FakeObservationSink observation_sink;
    core::RuntimeClock runtime_clock;
    GameHostHostValues host_values;
    FakeSystemLayoutHost system_layout_host;
    std::vector<HostFrameStage> diagnostic_stages;

    GameHost host({.content_assets = assets,
                   .script_invocations = scripts,
                   .save_slots = saves,
                   .runtime_ui = runtime_ui,
                   .layout_realizer = &layout_realizer,
                   .audio = audio,
                   .preview_publication_sink = &preview_sink,
                   .observation_sink = &observation_sink,
                   .runtime_clock = runtime_clock,
                   .host_values = host_values,
                   .system_layout_host = system_layout_host,
                   .world_transitions = nullptr,
                   .script_certifier = script_certifier,
                   .diagnostic_sink = [&](HostFrameStage stage, const core::Diagnostic&) {
                       diagnostic_stages.push_back(stage);
                   }});

    GameHostLoadHooks hooks;
    hooks.prepare_candidate = [](const runtime::RunningGame&, const runtime::RuntimePublication&) {
        return core::Result<void, core::Diagnostics>::success();
    };
    REQUIRE(host.load_compiled_project({.logical_path = "project:/minimal.json",
                                        .runtime_locale = "en",
                                        .load_title_screen = false,
                                        .stop_runtime_after_load = true},
                                       hooks));

    std::size_t publication_callbacks = 0;
    preview_sink.on_apply = [&]() {
        ++publication_callbacks;
        host.enqueue_runtime_input(core::RuntimeInputMessage{core::StopRuntimeInput{}});
    };
    auto dispatched =
        host.submit_runtime_input(core::RuntimeInputMessage{core::StartRuntimeInput{}});

    REQUIRE(dispatched.accepted());
    REQUIRE(dispatched.publication.has_value());
    REQUIRE(host.runtime_publication().has_value());
    CHECK(host.runtime_publication()->revision == dispatched.publication->revision);
    REQUIRE(preview_sink.revisions.size() == 1);
    CHECK(preview_sink.revisions.front() == dispatched.publication->revision);
    REQUIRE(observation_sink.snapshots.size() == 1);
    REQUIRE(observation_sink.snapshots.front().values.size() ==
            dispatched.publication->observations.values.size());
    for (std::size_t index = 0; index < observation_sink.snapshots.front().values.size(); ++index) {
        CHECK(observation_sink.snapshots.front().values[index].index() ==
              dispatched.publication->observations.values[index].index());
    }
    REQUIRE(observation_sink.event_batches.size() == 1);
    REQUIRE(observation_sink.event_batches.front().size() == dispatched.events.size());
    for (std::size_t index = 0; index < observation_sink.event_batches.front().size(); ++index) {
        CHECK(observation_sink.event_batches.front()[index].index() ==
              dispatched.events[index].index());
    }
    REQUIRE(host.runtime_events().size() == dispatched.events.size());
    for (std::size_t index = 0; index < host.runtime_events().size(); ++index)
        CHECK(host.runtime_events()[index].index() == dispatched.events[index].index());
    REQUIRE(host.pending_runtime_inputs().size() == 1);
    CHECK(std::holds_alternative<core::StopRuntimeInput>(
        host.pending_runtime_inputs().front().input));
    CHECK(publication_callbacks == 1);
    CHECK(host.lifecycle_state() == LoadedGameLifecycleState::Running);

    preview_sink.on_apply = {};
    CHECK(host.dispatch_pending_runtime_inputs());
    CHECK(host.pending_runtime_inputs().empty());
    CHECK(host.lifecycle_state() == LoadedGameLifecycleState::Stopped);

    preview_sink.fail_next = true;
    auto failed_application =
        host.submit_runtime_input(core::RuntimeInputMessage{core::StartRuntimeInput{}});
    CHECK_FALSE(failed_application.accepted());
    REQUIRE_FALSE(failed_application.diagnostics.empty());
    CHECK(failed_application.diagnostics.back().code == "host.test_preview_publication_failed");
    REQUIRE_FALSE(host.runtime_diagnostic_records().empty());
    CHECK(host.runtime_diagnostic_records().back().stage == HostFrameStage::UpdateRuntimeUi);
    REQUIRE_FALSE(diagnostic_stages.empty());
    CHECK(diagnostic_stages.back() == HostFrameStage::UpdateRuntimeUi);
}

TEST_CASE("GameHost advances only admitted loaded-game runtime work")
{
    assets::AssetManager assets;
    auto project_assets = std::make_shared<assets::MemoryAssetSource>();
    const auto fixture = minimal_compiled_project_fixture();
    project_assets->add("minimal.json", assets::AssetBytes(fixture.begin(), fixture.end()),
                        "game-host-test");
    assets.mount("project", project_assets);

    FakeScriptInvocationPort scripts;
    script::ScriptRuntime script_certifier;
    REQUIRE(script_certifier.initialize({&assets}));
    core::TypedMemorySaveSlotStore saves;
    RuntimeUI runtime_ui;
    FakeLayoutRealizer layout_realizer;
    AudioSystem audio;
    FakePublicationSink preview_sink;
    FakeObservationSink observation_sink;
    core::RuntimeClock runtime_clock;
    GameHostHostValues host_values;
    FakeSystemLayoutHost system_layout_host;

    GameHost host({.content_assets = assets,
                   .script_invocations = scripts,
                   .save_slots = saves,
                   .runtime_ui = runtime_ui,
                   .layout_realizer = &layout_realizer,
                   .audio = audio,
                   .preview_publication_sink = &preview_sink,
                   .observation_sink = &observation_sink,
                   .runtime_clock = runtime_clock,
                   .host_values = host_values,
                   .system_layout_host = system_layout_host,
                   .world_transitions = nullptr,
                   .script_certifier = script_certifier,
                   .diagnostic_sink = {}});

    GameHostLoadHooks hooks;
    hooks.prepare_candidate = [](const runtime::RunningGame&, const runtime::RuntimePublication&) {
        return core::Result<void, core::Diagnostics>::success();
    };
    REQUIRE(host.load_compiled_project({.logical_path = "project:/minimal.json",
                                        .runtime_locale = "en",
                                        .load_title_screen = false,
                                        .stop_runtime_after_load = false},
                                       hooks));

    auto frame = runtime_clock.advance(0.016, false, false);
    REQUIRE(frame);
    host.enqueue_runtime_input(core::RuntimeInputMessage{core::StopRuntimeInput{}});
    REQUIRE(host.runtime_publication());
    const auto publication_before = host.runtime_publication()->revision;

    CHECK(host.advance({.frame_clock = *frame.value_if(),
                        .effective_gameplay_pause = {},
                        .runtime_input_admitted = false}));
    REQUIRE(host.pending_runtime_inputs().size() == 1);
    CHECK(host.runtime_publication()->revision == publication_before);

    CHECK(host.advance({.frame_clock = *frame.value_if(),
                        .effective_gameplay_pause = {},
                        .runtime_input_admitted = true}));
    CHECK(host.pending_runtime_inputs().empty());
    REQUIRE(host.runtime_publication());
    CHECK(host.runtime_publication()->revision.number() >= publication_before.number());
}

TEST_CASE("GameHost lifecycle transitions are idempotent and replace runtime generations")
{
    assets::AssetManager assets;
    auto project_assets = std::make_shared<assets::MemoryAssetSource>();
    const auto fixture = minimal_compiled_project_fixture();
    project_assets->add("minimal.json", assets::AssetBytes(fixture.begin(), fixture.end()),
                        "game-host-test");
    assets.mount("project", project_assets);

    FakeScriptInvocationPort scripts;
    std::size_t invalidations = 0;
    scripts.on_invalidate = [&]() { ++invalidations; };
    script::ScriptRuntime script_certifier;
    REQUIRE(script_certifier.initialize({&assets}));
    core::TypedMemorySaveSlotStore saves;
    RuntimeUI runtime_ui;
    FakeLayoutRealizer layout_realizer;
    AudioSystem audio;
    FakePublicationSink preview_sink;
    FakeObservationSink observation_sink;
    core::RuntimeClock runtime_clock;
    GameHostHostValues host_values;
    FakeSystemLayoutHost system_layout_host;

    GameHost host({.content_assets = assets,
                   .script_invocations = scripts,
                   .save_slots = saves,
                   .runtime_ui = runtime_ui,
                   .layout_realizer = &layout_realizer,
                   .audio = audio,
                   .preview_publication_sink = &preview_sink,
                   .observation_sink = &observation_sink,
                   .runtime_clock = runtime_clock,
                   .host_values = host_values,
                   .system_layout_host = system_layout_host,
                   .world_transitions = nullptr,
                   .script_certifier = script_certifier,
                   .diagnostic_sink = {}});

    GameHostLoadHooks hooks;
    hooks.prepare_candidate = [](const runtime::RunningGame&, const runtime::RuntimePublication&) {
        return core::Result<void, core::Diagnostics>::success();
    };
    REQUIRE(host.load_compiled_project({.logical_path = "project:/minimal.json",
                                        .runtime_locale = "en",
                                        .load_title_screen = false,
                                        .stop_runtime_after_load = true},
                                       hooks));
    CHECK(host.lifecycle_state() == LoadedGameLifecycleState::Stopped);

    const auto loaded_generation = host.session_generation();
    auto duplicate_stop =
        host.submit_runtime_input(core::RuntimeInputMessage{core::StopRuntimeInput{}});
    CHECK(duplicate_stop.accepted());
    CHECK_FALSE(duplicate_stop.publication);
    CHECK(host.session_generation() == loaded_generation);

    auto started = host.submit_runtime_input(core::RuntimeInputMessage{core::StartRuntimeInput{}});
    REQUIRE(started.accepted());
    CHECK(host.lifecycle_state() == LoadedGameLifecycleState::Running);
    auto duplicate_start =
        host.submit_runtime_input(core::RuntimeInputMessage{core::StartRuntimeInput{}});
    CHECK(duplicate_start.accepted());
    CHECK_FALSE(duplicate_start.publication);
    CHECK(host.lifecycle_state() == LoadedGameLifecycleState::Running);

    const auto pre_reset_session = host.session_generation();
    const auto pre_reset_backend = host.backend_generation();
    auto reset = host.submit_runtime_input(core::RuntimeInputMessage{core::ResetRuntimeInput{}});
    REQUIRE(reset.accepted());
    CHECK(host.session_generation().number() == pre_reset_session.number() + 1);
    CHECK(host.backend_generation().number() == pre_reset_backend.number() + 1);
    CHECK(host.lifecycle_state() == LoadedGameLifecycleState::Running);
    CHECK(invalidations == 1);

    auto stale = host.submit_runtime_input(pre_reset_session,
                                           core::RuntimeInputMessage{core::ContinueInput{}});
    REQUIRE_FALSE(stale.accepted());
    REQUIRE_FALSE(stale.diagnostics.empty());
    CHECK(stale.diagnostics.front().code == "host.stale_runtime_input_generation");

    host.enqueue_runtime_input(pre_reset_session, pre_reset_backend,
                               core::RuntimeInputMessage{core::ContinueInput{}});
    CHECK(host.dispatch_pending_runtime_inputs());
    CHECK(host.pending_runtime_inputs().empty());
    REQUIRE_FALSE(host.runtime_diagnostic_records().empty());
    CHECK(host.runtime_diagnostic_records().back().diagnostic.code ==
          "host.stale_deferred_runtime_input");

    REQUIRE(host.submit_runtime_input(
                    core::RuntimeInputMessage{core::AdvanceTimeInput{std::chrono::microseconds{0}}})
                .accepted());
    REQUIRE(host.submit_runtime_input(core::RuntimeInputMessage{core::SaveRuntimeInput{
                                          core::TypedSaveSlotId::autosave()}})
                .accepted());
    const auto pre_load_session = host.session_generation();
    const auto pre_load_backend = host.backend_generation();
    auto loaded_save = host.submit_runtime_input(
        core::RuntimeInputMessage{core::LoadRuntimeInput{core::TypedSaveSlotId::autosave()}});
    REQUIRE(loaded_save.accepted());
    CHECK(host.session_generation().number() == pre_load_session.number() + 1);
    CHECK(host.backend_generation().number() == pre_load_backend.number() + 1);
    CHECK(host.lifecycle_state() == LoadedGameLifecycleState::Running);
    CHECK(invalidations == 2);

    auto stopped = host.submit_runtime_input(core::RuntimeInputMessage{core::StopRuntimeInput{}});
    REQUIRE(stopped.accepted());
    CHECK(host.lifecycle_state() == LoadedGameLifecycleState::Stopped);
    const auto stopped_generation = host.session_generation();
    duplicate_stop = host.submit_runtime_input(core::RuntimeInputMessage{core::StopRuntimeInput{}});
    CHECK(duplicate_stop.accepted());
    CHECK_FALSE(duplicate_stop.publication);
    CHECK(host.session_generation() == stopped_generation);
}

TEST_CASE("GameHost suspend backend reset and shutdown ordering is idempotent")
{
    assets::AssetManager assets;
    auto project_assets = std::make_shared<assets::MemoryAssetSource>();
    const auto fixture = minimal_compiled_project_fixture();
    project_assets->add("minimal.json", assets::AssetBytes(fixture.begin(), fixture.end()),
                        "game-host-test");
    assets.mount("project", project_assets);

    FakeScriptInvocationPort scripts;
    std::size_t invalidations = 0;
    scripts.on_invalidate = [&]() { ++invalidations; };
    script::ScriptRuntime script_certifier;
    REQUIRE(script_certifier.initialize({&assets}));
    core::TypedMemorySaveSlotStore saves;
    RuntimeUI runtime_ui;
    FakeLayoutRealizer layout_realizer;
    AudioSystem audio;
    FakePublicationSink preview_sink;
    FakeObservationSink observation_sink;
    core::RuntimeClock runtime_clock;
    GameHostHostValues host_values;
    FakeSystemLayoutHost system_layout_host;

    GameHost host({.content_assets = assets,
                   .script_invocations = scripts,
                   .save_slots = saves,
                   .runtime_ui = runtime_ui,
                   .layout_realizer = &layout_realizer,
                   .audio = audio,
                   .preview_publication_sink = &preview_sink,
                   .observation_sink = &observation_sink,
                   .runtime_clock = runtime_clock,
                   .host_values = host_values,
                   .system_layout_host = system_layout_host,
                   .world_transitions = nullptr,
                   .script_certifier = script_certifier,
                   .diagnostic_sink = {}});

    GameHostLoadHooks hooks;
    hooks.prepare_candidate = [](const runtime::RunningGame&, const runtime::RuntimePublication&) {
        return core::Result<void, core::Diagnostics>::success();
    };
    REQUIRE(host.load_compiled_project({.logical_path = "project:/minimal.json",
                                        .runtime_locale = "en",
                                        .load_title_screen = false,
                                        .stop_runtime_after_load = false},
                                       hooks));

    const auto frame = runtime_clock.advance(0.016, false, false);
    REQUIRE(frame);
    host.enqueue_runtime_input(core::RuntimeInputMessage{core::StopRuntimeInput{}});
    CHECK(host.suspend_host());
    CHECK_FALSE(host.suspend_host());
    CHECK(host.host_values().host_suspended);
    CHECK(host.advance({.frame_clock = *frame.value_if(),
                        .effective_gameplay_pause = {},
                        .runtime_input_admitted = true}));
    CHECK(host.pending_runtime_inputs().size() == 1);
    CHECK(host.resume_host());
    CHECK_FALSE(host.resume_host());
    CHECK_FALSE(host.host_values().host_suspended);
    CHECK(host.advance({.frame_clock = *frame.value_if(),
                        .effective_gameplay_pause = {},
                        .runtime_input_admitted = true}));
    CHECK(host.pending_runtime_inputs().empty());
    CHECK(host.lifecycle_state() == LoadedGameLifecycleState::Stopped);

    const auto reset_session = host.session_generation();
    const auto reset_backend = host.backend_generation();
    host.enqueue_runtime_input(core::RuntimeInputMessage{core::ContinueInput{}});
    CHECK(host.begin_backend_reset(BackendResetReason::ExplicitRequest));
    CHECK_FALSE(host.begin_backend_reset(BackendResetReason::ExplicitRequest));
    CHECK(host.session_generation() == reset_session);
    CHECK(host.backend_generation().number() == reset_backend.number() + 1);
    CHECK(host.pending_runtime_inputs().empty());
    auto blocked = host.submit_runtime_input(core::RuntimeInputMessage{core::ContinueInput{}});
    REQUIRE_FALSE(blocked.accepted());
    CHECK(blocked.diagnostics.front().code == "host.runtime_input_during_backend_reset");
    auto blocked_reload = host.load_compiled_project({.logical_path = "project:/minimal.json",
                                                      .runtime_locale = "en",
                                                      .load_title_screen = false,
                                                      .stop_runtime_after_load = false},
                                                     hooks);
    REQUIRE_FALSE(blocked_reload);
    CHECK(blocked_reload.error().front().code == "host.game_load_during_backend_reset");
    host.enqueue_runtime_input(reset_session, reset_backend,
                               core::RuntimeInputMessage{core::ContinueInput{}});
    REQUIRE(host.finish_backend_reset());
    CHECK(layout_realizer.recreate_count == 1);
    REQUIRE(layout_realizer.last_recreate);
    CHECK(layout_realizer.last_recreate->host_generation.number() == reset_session.number());
    CHECK(layout_realizer.last_recreate->backend_generation == host.backend_generation());
    REQUIRE(host.finish_backend_reset());
    CHECK(layout_realizer.recreate_count == 1);
    CHECK(host.dispatch_pending_runtime_inputs());
    CHECK(host.pending_runtime_inputs().empty());

    const auto shutdown_session = host.session_generation();
    const auto shutdown_backend = host.backend_generation();
    host.shutdown();
    CHECK(host.running_game() == nullptr);
    CHECK(host.lifecycle_state() == LoadedGameLifecycleState::Empty);
    CHECK(host.session_generation().number() == shutdown_session.number() + 1);
    CHECK(host.backend_generation().number() == shutdown_backend.number() + 1);
    CHECK_FALSE(host.host_values().host_suspended);
    CHECK(invalidations == 1);

    const auto final_session = host.session_generation();
    const auto final_backend = host.backend_generation();
    host.shutdown();
    CHECK(host.session_generation() == final_session);
    CHECK(host.backend_generation() == final_backend);
    CHECK(invalidations == 1);
}

} // namespace
} // namespace noveltea::host
