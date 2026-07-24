#include "host/game_host.hpp"
#include "host/layout_realizer.hpp"
#include "host/preview_host.hpp"
#include "noveltea/assets/asset_source.hpp"
#include "noveltea/core/package_export.hpp"
#include "noveltea/script/script_runtime.hpp"
#include "ui/rmlui/runtime_ui_facade_access.hpp"
#include "ui/rmlui/runtime_ui_playback_driver.hpp"
#include "ui/runtime_ui_lifecycle_fixture.hpp"

#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <array>
#include <atomic>
#include <cstddef>
#include <filesystem>
#include <fstream>
#include <functional>
#include <iterator>
#include <optional>
#include <span>
#include <string>
#include <type_traits>
#include <utility>

#include <nlohmann/json.hpp>

namespace noveltea::host {

using presentation::RuntimeSystemLayoutHost;

namespace {

class FakeScriptInvocationPort final : public runtime::ScriptInvocationPort {
public:
    [[nodiscard]] core::Result<runtime::ScriptInvocationOutcome, runtime::ScriptInvocationError>
    invoke(const runtime::ScriptInvocationRequest& request,
           const runtime::RuntimeCapabilitySet&) override
    {
        requests.push_back(request);
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
    std::vector<runtime::ScriptInvocationRequest> requests;
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

    [[nodiscard]] core::Result<void, core::Diagnostics> set_runtime_ui_scale(double) override
    {
        return core::Result<void, core::Diagnostics>::success();
    }

    [[nodiscard]] core::Result<void, core::Diagnostics> set_runtime_text_scale(double) override
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

class FakeRuntimeUiHost final : public RuntimeUiHost {
public:
    void bind_input_sink(RuntimeUiInputSink* sink) noexcept override { input_sink = sink; }

    void bind_asset_service(const RuntimeUiAssetService* service) noexcept override
    {
        asset_service = service;
    }

    [[nodiscard]] bool apply_gameplay_ui_values(const RuntimeUiGameplayValues& values) override
    {
        gameplay_values = values;
        return accept_gameplay_values;
    }

    void clear_gameplay_ui_values() override { gameplay_values.reset(); }
    void clear_runtime_shell_view() override { ++shell_clear_count; }
    void set_runtime_notification(std::string notification) override
    {
        runtime_notification = std::move(notification);
    }
    void append_typed_runtime_diagnostics(core::Diagnostics diagnostics) override
    {
        core::append_diagnostics(runtime_diagnostics, std::move(diagnostics));
    }
    void clear_typed_runtime_diagnostics() override { runtime_diagnostics.clear(); }
    [[nodiscard]] core::ActiveTextPresentationPhase
    active_text_presentation_phase() const noexcept override
    {
        return active_text_phase;
    }
    void bind_title_document(const std::string& project_title, const std::string& subtitle,
                             const std::string& start_label) override
    {
        title = project_title;
        title_subtitle = subtitle;
        title_start_label = start_label;
    }

    RuntimeUiInputSink* input_sink = nullptr;
    const RuntimeUiAssetService* asset_service = nullptr;
    std::optional<RuntimeUiGameplayValues> gameplay_values;
    core::Diagnostics runtime_diagnostics;
    std::string runtime_notification;
    std::string title;
    std::string title_subtitle;
    std::string title_start_label;
    core::ActiveTextPresentationPhase active_text_phase = core::ActiveTextPresentationPhase::Stable;
    std::size_t shell_clear_count = 0;
    bool accept_gameplay_values = true;
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

std::shared_ptr<assets::ZipAssetSource>
runtime_package_source(std::string_view fixture,
                       std::span<const std::pair<std::string, std::string>> additional_files = {})
{
    auto project = nlohmann::json::parse(fixture, nullptr, false);
    REQUIRE_FALSE(project.is_discarded());
    const auto& display = project.at("settings").at("display");
    const auto& accessibility = project.at("settings").at("accessibility");

    core::PackageExportOptions options;
    options.project_name = project.at("project").at("name").get<std::string>();
    options.project_version = project.at("project").at("version").get<std::string>();
    options.created_by = "game-host-transaction-test";
    options.display = {
        {"reference_resolution",
         {{"width", display.at("referenceResolution").at("width")},
          {"height", display.at("referenceResolution").at("height")}}},
        {"world_raster_policy", display.at("worldRasterPolicy")},
        {"bar_color", display.at("barColor")},
    };
    options.accessibility = {
        {"ui_scale",
         {{"enabled", accessibility.at("uiScale").at("enabled")},
          {"minimum", accessibility.at("uiScale").at("minimum")},
          {"maximum", accessibility.at("uiScale").at("maximum")}}},
        {"text_scale",
         {{"enabled", accessibility.at("textScale").at("enabled")},
          {"minimum", accessibility.at("textScale").at("minimum")},
          {"maximum", accessibility.at("textScale").at("maximum")}}},
    };

    static std::atomic_uint64_t sequence = 0;
    const auto root = std::filesystem::temp_directory_path() /
                      ("noveltea-game-host-package-" +
                       std::to_string(sequence.fetch_add(1, std::memory_order_relaxed)));
    std::filesystem::remove_all(root);
    for (const auto& [package_path, contents] : additional_files) {
        const auto source_path = root / package_path;
        std::filesystem::create_directories(source_path.parent_path());
        std::ofstream output(source_path, std::ios::binary | std::ios::trunc);
        output.write(contents.data(), static_cast<std::streamsize>(contents.size()));
        REQUIRE(output.good());
        options.file_entries.push_back({.source = source_path, .package_path = package_path});
    }

    std::vector<std::byte> package;
    const auto exported = core::ProjectPackageWriter::write_to_memory(project, options, package);
    std::filesystem::remove_all(root);
    REQUIRE(exported.success);
    assets::AssetBytes bytes;
    bytes.reserve(package.size());
    for (const auto value : package)
        bytes.push_back(std::to_integer<std::uint8_t>(value));
    return std::make_shared<assets::ZipAssetSource>(
        std::make_shared<const assets::AssetBytes>(std::move(bytes)));
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
    FakeRuntimeUiHost runtime_ui;
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
    FakeRuntimeUiHost runtime_ui;
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

TEST_CASE("PreviewHost rejects commands carrying a stale runtime handle")
{
    assets::AssetManager assets;
    FakeScriptInvocationPort scripts;
    script::ScriptRuntime script_runtime;
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
                   .script_certifier = script_runtime,
                   .diagnostic_sink = {}});
    Renderer renderer;
    ShaderMaterialProject shader_materials;
    LayoutRealizer preview_layout_realizer(assets, runtime_ui);
    bool preview_running = false;
    PreviewHost preview({.game_host = host,
                         .runtime_ui = runtime_ui,
                         .scripts = script_runtime,
                         .renderer = renderer,
                         .shader_materials = shader_materials,
                         .assets = assets,
                         .audio_backend = audio,
                         .layout_realizer = preview_layout_realizer,
                         .load_game = {},
                         .apply_authored_environment =
                             [](const core::editor::TypedEditorAuthoredPreviewEnvironment&) {
                                 return core::Result<void, core::Diagnostics>::success();
                             },
                         .clear_authored_environment =
                             []() { return core::Result<void, core::Diagnostics>::success(); },
                         .preview_running = preview_running});

    const auto handle = preview.runtime_handle();
    host.invalidate_session_generation();
    CHECK_FALSE(preview.accepts(handle));
    CHECK_FALSE(preview.dispatch(handle, core::RuntimeInputMessage{core::ContinueInput{}}));
    REQUIRE_FALSE(preview.preview_diagnostics().empty());
    CHECK(preview.preview_diagnostics().back().code == "preview.runtime.stale_handle");
}

TEST_CASE("PreviewHost keeps the active document when authored environment application fails")
{
    test::RuntimeUiLifecycleFixture fixture({.mount_system_assets = true});
    auto& runtime_ui = fixture.runtime_ui();
    const auto presentation = make_presentation_metrics(
        make_host_surface_metrics(1280, 720, 1280, 720), {.reference = {.size = {1920, 1080}}});
    REQUIRE(presentation);
    runtime_ui.resize(presentation.value());
    REQUIRE(fixture.initialize());
    auto& assets = fixture.assets();
    auto& scripts = fixture.scripts();

    core::TypedMemorySaveSlotStore saves;
    FakeLayoutRealizer game_layout_realizer;
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
                   .layout_realizer = &game_layout_realizer,
                   .audio = audio,
                   .preview_publication_sink = &preview_sink,
                   .observation_sink = &observation_sink,
                   .runtime_clock = runtime_clock,
                   .host_values = host_values,
                   .system_layout_host = system_layout_host,
                   .world_transitions = nullptr,
                   .script_certifier = scripts,
                   .diagnostic_sink = {}});

    Renderer renderer;
    ShaderMaterialProject shader_materials;
    LayoutRealizer preview_layout_realizer(assets, runtime_ui);
    bool preview_running = false;
    std::string failure_code;
    std::size_t apply_calls = 0;
    std::size_t clear_calls = 0;
    PreviewHost preview({
        .game_host = host,
        .runtime_ui = runtime_ui,
        .scripts = scripts,
        .renderer = renderer,
        .shader_materials = shader_materials,
        .assets = assets,
        .audio_backend = audio,
        .layout_realizer = preview_layout_realizer,
        .load_game = {},
        .apply_authored_environment =
            [&](const core::editor::TypedEditorAuthoredPreviewEnvironment&) {
                ++apply_calls;
                return core::Result<void, core::Diagnostics>::failure(
                    {{.code = failure_code,
                      .message = "Authored preview environment rejected for test",
                      .source_path = "/environment"}});
            },
        .clear_authored_environment =
            [&]() {
                ++clear_calls;
                return core::Result<void, core::Diagnostics>::success();
            },
        .preview_running = preview_running,
    });

    REQUIRE(preview.load_document({.rml = "<rml><head></head><body><p>baseline</p></body></rml>",
                                   .source_url = "preview://baseline.rml"}));
    clear_calls = 0;
    auto* driver = ui::rmlui::RuntimeUiPlaybackDriver::from(runtime_ui);
    REQUIRE(driver != nullptr);
    auto* baseline_document = driver->document("editor_preview");
    REQUIRE(baseline_document != nullptr);

    const core::editor::TypedEditorAuthoredPreviewEnvironment environment{
        .profile_name = "project",
        .native_resolution = {.width = 1920, .height = 1080},
        .scale_policy = {.ui = core::LayoutScaleInheritance::Ignore,
                         .text = core::LayoutScaleInheritance::Inherit},
        .project_display = {.reference_resolution = {.width = 1920, .height = 1080},
                            .bar_color = "#000000",
                            .world_raster_policy = core::compiled::WorldRasterPolicy::Capped},
        .accessibility =
            {
                .ui_scale = {.enabled = true, .minimum = 0.75, .maximum = 2.0},
                .text_scale = {.enabled = true, .minimum = 0.75, .maximum = 2.0},
            },
    };
    const core::editor::TypedEditorLayoutPreviewDocument authored_document{
        .layout_kind = core::editor::EditorPreviewLayoutKind::Document,
        .rml = "<rml><head></head><body><p>authored</p></body></rml>",
        .rcss = {},
        .lua = {},
        .script_enabled = false,
        .fragment_host_rml = std::nullopt,
        .fragment_host_rcss = std::nullopt,
        .environment = environment,
    };

    const std::array failure_codes{
        "preview.authored_environment.presentation_invalid",
        "preview.authored_environment.wrong_state",
    };
    for (const char* code : failure_codes) {
        failure_code = code;
        (void)preview.take_preview_diagnostics();
        CHECK_FALSE(preview.apply_editor_document(authored_document));
        CHECK(driver->document("editor_preview") == baseline_document);
        CHECK(driver->document(std::string(LayoutRealizer::authored_preview_document_id())) ==
              nullptr);
        CHECK(clear_calls == 0);
        const auto diagnostics = preview.take_preview_diagnostics();
        CHECK(std::any_of(diagnostics.begin(), diagnostics.end(),
                          [&](const auto& diagnostic) { return diagnostic.code == failure_code; }));
    }
    CHECK(apply_calls == failure_codes.size());
}

TEST_CASE("PreviewHost executes loaded preview Lua with scoped tooling capabilities")
{
    assets::AssetManager assets;
    auto project_assets = std::make_shared<assets::MemoryAssetSource>();
    const auto fixture = minimal_compiled_project_fixture();
    project_assets->add("minimal.json", assets::AssetBytes(fixture.begin(), fixture.end()),
                        "preview-host-test");
    assets.mount("project", project_assets);

    script::ScriptRuntime scripts;
    REQUIRE(scripts.initialize({&assets}));
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
                   .script_certifier = scripts,
                   .diagnostic_sink = {}});
    REQUIRE(host.load_compiled_project({.logical_path = "project:/minimal.json",
                                        .runtime_locale = "en",
                                        .load_title_screen = false,
                                        .stop_runtime_after_load = true},
                                       {}));

    Renderer renderer;
    ShaderMaterialProject shader_materials;
    LayoutRealizer preview_layout_realizer(assets, runtime_ui);
    bool preview_running = false;
    PreviewHost preview({.game_host = host,
                         .runtime_ui = runtime_ui,
                         .scripts = scripts,
                         .renderer = renderer,
                         .shader_materials = shader_materials,
                         .assets = assets,
                         .audio_backend = audio,
                         .layout_realizer = preview_layout_realizer,
                         .load_game =
                             [&](GameHostLoadRequest request) {
                                 return static_cast<bool>(host.load_compiled_project(request, {}));
                             },
                         .apply_authored_environment =
                             [](const core::editor::TypedEditorAuthoredPreviewEnvironment&) {
                                 return core::Result<void, core::Diagnostics>::success();
                             },
                         .clear_authored_environment =
                             []() { return core::Result<void, core::Diagnostics>::success(); },
                         .preview_running = preview_running});

    REQUIRE(preview.execute_lua({.source = "assert(type(noveltea.variables.get) == 'function'); "
                                           "assert(type(noveltea.project.room) == 'function')",
                                 .chunk_name = "preview-tooling-test"}));
    REQUIRE(preview.preview_diagnostics().empty());

    auto cleared = scripts.execute("local value, err = noveltea.variables.get('missing'); "
                                   "assert(value == nil and err ~= nil)",
                                   "preview-tooling-cleared-test");
    REQUIRE(cleared);

    const auto pre_reload_handle = preview.runtime_handle();
    REQUIRE(preview.reload());
    CHECK_FALSE(preview.accepts(pre_reload_handle));
    CHECK_FALSE(
        preview.dispatch(pre_reload_handle, core::RuntimeInputMessage{core::ContinueInput{}}));
}

TEST_CASE("GameHost rebinds RuntimeUI input to the committed session generation")
{
    test::RuntimeUiLifecycleFixture runtime_ui_fixture({.mount_system_assets = true});
    const auto project = minimal_compiled_project_fixture();
    runtime_ui_fixture.project_assets().add(
        "minimal.json", assets::AssetBytes(project.begin(), project.end()), "game-host-test");
    REQUIRE(runtime_ui_fixture.initialize());
    auto& assets = runtime_ui_fixture.assets();
    auto& script_certifier = runtime_ui_fixture.scripts();
    auto& runtime_ui = runtime_ui_fixture.runtime_ui();

    FakeScriptInvocationPort scripts;
    core::TypedMemorySaveSlotStore saves;
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
    FakeRuntimeUiHost runtime_ui;
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

TEST_CASE("Rejected runtime package validation does not advance the live asset generation")
{
    assets::AssetManager assets;
    auto project_assets = std::make_shared<assets::MemoryAssetSource>();
    const auto fixture = minimal_compiled_project_fixture();
    project_assets->add("minimal.json", assets::AssetBytes(fixture.begin(), fixture.end()),
                        "game-host-transaction-test");
    project_assets->add("current-session.txt",
                        assets::AssetBytes{'c', 'u', 'r', 'r', 'e', 'n', 't'},
                        "game-host-current-session");
    assets.mount("project", project_assets);

    FakeScriptInvocationPort scripts;
    script::ScriptRuntime script_certifier;
    REQUIRE(script_certifier.initialize({&assets}));
    core::TypedMemorySaveSlotStore saves;
    FakeRuntimeUiHost runtime_ui;
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

    GameHostLoadHooks initial_hooks;
    initial_hooks.prepare_candidate = [](const runtime::RunningGame&,
                                         const runtime::RuntimePublication&) {
        return core::Result<void, core::Diagnostics>::success();
    };
    REQUIRE(host.load_compiled_project({.logical_path = "project:/minimal.json",
                                        .runtime_locale = "en",
                                        .load_title_screen = false,
                                        .stop_runtime_after_load = true},
                                       initial_hooks));
    auto* const previous_game = host.running_game();
    const auto source_generation = assets.source_generation_on_owner();
    scripts.requests.clear();

    auto candidate_project = nlohmann::json::parse(fixture, nullptr, false);
    REQUIRE_FALSE(candidate_project.is_discarded());
    candidate_project["resources"]["assets"].push_back({{"aliases", nlohmann::json::array()},
                                                        {"id", "candidate-compose-source"},
                                                        {"kind", "script"},
                                                        {"path", "scripts/candidate-compose.lua"}});
    candidate_project["resources"]["scripts"].push_back(
        {{"id", "candidate-compose"},
         {"source",
          {{"kind", "asset"},
           {"asset", {{"id", "candidate-compose-source"}, {"kind", "asset"}}}}}});
    candidate_project["definitions"]["rooms"][0]["compose"] = {
        {"script", {{"id", "candidate-compose"}, {"kind", "script"}}}};
    const auto candidate_fixture = candidate_project.dump();
    const std::array candidate_files = {std::pair<std::string, std::string>{
        "scripts/candidate-compose.lua",
        "room = { compose = function(context, presentation) end }"}};

    std::size_t detach_calls = 0;
    std::size_t commit_calls = 0;
    GameHostLoadHooks rejected_hooks;
    rejected_hooks.prepare_candidate = [](const runtime::RunningGame&,
                                          const runtime::RuntimePublication&) {
        return core::Result<void, core::Diagnostics>::failure(
            {{.code = "host.test_package_candidate_rejected",
              .message = "Runtime package candidate was rejected for test"}});
    };
    rejected_hooks.detach_current_resources = [&]() { ++detach_calls; };
    rejected_hooks.commit_candidate_resources =
        [&](const runtime::RunningGame&, const runtime::RuntimePublication&) { ++commit_calls; };

    auto rejected = host.load_compiled_project(
        {.logical_path = "project:/candidate.ntpkg",
         .runtime_locale = "en",
         .load_title_screen = false,
         .stop_runtime_after_load = true},
        runtime_package_source(candidate_fixture, candidate_files), rejected_hooks);

    REQUIRE_FALSE(rejected);
    REQUIRE(rejected.error().size() == 1);
    CHECK(rejected.error().front().code == "host.test_package_candidate_rejected");
    CHECK(assets.source_generation_on_owner() == source_generation);
    CHECK(host.running_game() == previous_game);
    CHECK(detach_calls == 0);
    CHECK(commit_calls == 0);
    REQUIRE(scripts.requests.size() >= 2);
    CHECK_FALSE(scripts.requests.front().asset_path.has_value());
    CHECK(scripts.requests.front().chunk_name == "@scripts/candidate-compose.lua");
    CHECK(scripts.requests.front().source.find("room =") != std::string::npos);
    auto current = assets.read_text("project:/current-session.txt");
    REQUIRE(current);
    CHECK(*current.value == "current");
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
    FakeRuntimeUiHost runtime_ui;
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
    FakeRuntimeUiHost runtime_ui;
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
    FakeRuntimeUiHost runtime_ui;
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
    FakeRuntimeUiHost runtime_ui;
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
