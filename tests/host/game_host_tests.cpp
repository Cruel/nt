#include "host/game_host.hpp"

#include <catch2/catch_test_macros.hpp>

#include <optional>
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
    void invalidate_capabilities(runtime::CapabilityGeneration) noexcept override {}
};

class FakeLayoutRealizer final : public LayoutRealizationSink {
public:
    [[nodiscard]] LayoutRealizationResult
    apply_layout_realization(LayoutRealizationRequest) override
    {
        return {.disposition = LayoutRealizationDisposition::Unchanged};
    }
};

class FakePublicationSink final : public RuntimePublicationSink {
public:
    [[nodiscard]] core::Result<void, core::Diagnostics>
    apply_runtime_publication(const runtime::RuntimePublication&) override
    {
        return core::Result<void, core::Diagnostics>::success();
    }
};

class FakeObservationSink final : public RuntimeObservationSink {
public:
    void observe_runtime_outputs(const runtime::RuntimeObservationSnapshot&,
                                 std::span<const runtime::RuntimeEvent>) override
    {
    }
};

class FakeSystemLayoutHost final : public RuntimeSystemLayoutHost {
public:
    [[nodiscard]] core::Result<core::MountedLayoutInstanceId, core::Diagnostics>
    mount_system_layout(core::compiled::SystemLayoutRole, core::MountedLayoutPolicy) override
    {
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
};

TEST_CASE("GameHost owns runtime integration state and borrows explicit host dependencies")
{
    STATIC_REQUIRE_FALSE(std::is_copy_constructible_v<GameHost>);
    STATIC_REQUIRE_FALSE(std::is_move_constructible_v<GameHost>);

    assets::AssetManager assets;
    FakeScriptInvocationPort scripts;
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
                   .world_transitions = nullptr});

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
    CHECK(host.presentation_layout_instances().empty());
    CHECK(host.retained_presentation_layout_instances().empty());
    CHECK(host.current_presentation_revision() == std::nullopt);

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

} // namespace
} // namespace noveltea::host
