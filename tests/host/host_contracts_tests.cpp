#include "host/host_lifecycle_contracts.hpp"
#include "host/layout_realization_contracts.hpp"
#include "host/preview_host_contracts.hpp"
#include "host/runtime_host_contracts.hpp"

#include <catch2/catch_test_macros.hpp>

#include <array>
#include <string_view>
#include <type_traits>
#include <utility>
#include <variant>

namespace noveltea::host {
namespace {

core::MountedLayoutPolicy visible_game_ui_policy()
{
    return {.plane = core::PresentationPlane::GameUi,
            .local_order = 0,
            .clock = core::LayoutClockDomain::Gameplay,
            .input = core::LayoutInputMode::Normal,
            .gameplay_pause = core::GameplayPausePolicy::Continue,
            .visibility = core::LayoutVisibility::Visible,
            .escape_dismissal = core::EscapeDismissalPolicy::Ignore,
            .entrance_operation = std::nullopt,
            .exit_operation = std::nullopt};
}

class FakeRuntimeInputSink final : public RuntimeInputSink {
public:
    [[nodiscard]] HostRuntimeDispatchResult
    submit_runtime_input(core::RuntimeInputMessage input) override
    {
        last_input = std::move(input);
        return {.disposition = runtime::RuntimeInputDisposition::Handled};
    }

    std::optional<core::RuntimeInputMessage> last_input;
};

class FakeRuntimeInputSource final : public RuntimeInputSource {
public:
    void bind_runtime_input_sink(RuntimeInputSink* sink) noexcept override { m_sink = sink; }

    [[nodiscard]] HostRuntimeDispatchResult submit(core::RuntimeInputMessage input)
    {
        if (m_sink == nullptr) {
            return {.disposition = runtime::RuntimeInputDisposition::Failed,
                    .diagnostics = {{.code = "host.runtime_input_sink_unbound",
                                     .message = "Runtime input source has no bound sink."}}};
        }
        return m_sink->submit_runtime_input(std::move(input));
    }

private:
    RuntimeInputSink* m_sink = nullptr;
};

class FakePublicationSink final : public RuntimePublicationSink {
public:
    [[nodiscard]] core::Result<void, core::Diagnostics>
    apply_runtime_publication(const runtime::RuntimePublication& publication) override
    {
        revision = publication.revision;
        return core::Result<void, core::Diagnostics>::success();
    }

    std::optional<runtime::RuntimePublicationRevision> revision;
};

TEST_CASE("host runtime dispatch result preserves one settled runtime dispatch")
{
    const auto revision = runtime::RuntimePublicationRevision::from_number(7);
    REQUIRE(revision.has_value());

    runtime::RuntimeDispatchResult runtime_result{
        .disposition = runtime::RuntimeInputDisposition::Handled,
        .publication =
            runtime::RuntimePublication{
                .revision = *revision, .gameplay_ui = {}, .presentation = {}, .observations = {}},
        .events = {runtime::NotificationEvent{"saved"}},
        .diagnostics = {{.code = "host.test", .message = "diagnostic"}},
        .budget = {.kind = runtime::RuntimeBudgetOutcomeKind::WithinBudget,
                   .exhausted = std::nullopt,
                   .consumed = 3},
    };

    auto result = HostRuntimeDispatchResult::from_runtime(std::move(runtime_result));
    CHECK(result.accepted());
    REQUIRE(result.has_publication());
    CHECK(result.publication->revision == *revision);
    REQUIRE(result.events.size() == 1);
    CHECK(std::get<runtime::NotificationEvent>(result.events.front()).message == "saved");
    REQUIRE(result.diagnostics.size() == 1);
    CHECK(result.diagnostics.front().code == "host.test");
    CHECK(result.budget.consumed == 3);

    result.disposition = runtime::RuntimeInputDisposition::Failed;
    CHECK_FALSE(result.accepted());
}

TEST_CASE("runtime input sources and publication consumers use typed seams")
{
    FakeRuntimeInputSource source;
    auto unbound = source.submit(core::RuntimeInputMessage{core::ContinueInput{}});
    CHECK_FALSE(unbound.accepted());
    REQUIRE(unbound.diagnostics.size() == 1);

    FakeRuntimeInputSink sink;
    source.bind_runtime_input_sink(&sink);
    auto submitted = source.submit(core::RuntimeInputMessage{core::StopRuntimeInput{}});
    CHECK(submitted.accepted());
    REQUIRE(sink.last_input.has_value());
    CHECK(std::holds_alternative<core::StopRuntimeInput>(*sink.last_input));

    const auto revision = runtime::RuntimePublicationRevision::from_number(2);
    REQUIRE(revision.has_value());
    const runtime::RuntimePublication publication{
        .revision = *revision, .gameplay_ui = {}, .presentation = {}, .observations = {}};
    FakePublicationSink publication_sink;
    CHECK(publication_sink.apply_runtime_publication(publication).has_value());
    REQUIRE(publication_sink.revision.has_value());
    CHECK(*publication_sink.revision == *revision);
}

TEST_CASE("host lifecycle and backend notifications have explicit typed state")
{
    HostLifecycleStatus status;
    CHECK(status.state == HostLifecycleState::Uninitialized);
    CHECK_FALSE(status.initialized());
    CHECK_FALSE(status.terminal());

    status.state = HostLifecycleState::Running;
    CHECK(status.initialized());
    status.state = HostLifecycleState::Shutdown;
    status.shutdown_reason = HostShutdownReason::ExplicitRequest;
    CHECK(status.terminal());
    CHECK(status.shutdown_reason == HostShutdownReason::ExplicitRequest);

    const auto backend_generation = BackendGeneration::from_number(4);
    REQUIRE(backend_generation.has_value());
    HostBackendNotification notification = BackendResetNotification{
        .domain = HostBackendDomain::Renderer,
        .generation = *backend_generation,
        .phase = BackendResetPhase::BeforeReset,
        .reason = BackendResetReason::SurfaceRecreated,
    };
    REQUIRE(std::holds_alternative<BackendResetNotification>(notification));
    CHECK(std::get<BackendResetNotification>(notification).generation == *backend_generation);

    notification = BackendReloadNotification{
        .domain = HostBackendDomain::RuntimeUi,
        .generation = *backend_generation,
        .reason = BackendReloadReason::DocumentsAndStylesChanged,
    };
    CHECK(std::holds_alternative<BackendReloadNotification>(notification));
}

TEST_CASE("host frame stages expose stable diagnostic identifiers in execution order")
{
    constexpr std::array stages{
        HostFrameStage::BeginFrame,      HostFrameStage::PollPlatformEvents,
        HostFrameStage::RouteInput,      HostFrameStage::UpdateClocks,
        HostFrameStage::AdvanceRuntime,  HostFrameStage::UpdatePresentation,
        HostFrameStage::RealizeLayouts,  HostFrameStage::UpdateRuntimeUi,
        HostFrameStage::BeginRender,     HostFrameStage::RenderWorld,
        HostFrameStage::RenderRuntimeUi, HostFrameStage::RenderDevtools,
        HostFrameStage::ProcessCaptures, HostFrameStage::Present,
        HostFrameStage::PaceFrame,
    };

    STATIC_REQUIRE(stages.size() == frame_stage_index(HostFrameStage::Count));
    for (std::size_t index = 0; index < stages.size(); ++index) {
        CHECK(frame_stage_index(stages[index]) == index);
        CHECK(to_string(stages[index]) != std::string_view{"unknown"});
    }
}

TEST_CASE("layout realization contracts preserve stable identity and typed sources")
{
    const auto host_generation = HostGeneration::from_number(3);
    REQUIRE(host_generation.has_value());
    auto layout = core::LayoutId::create("game-hud");
    REQUIRE(layout.has_value());

    RealizeLayoutRequest realize{
        .host_generation = *host_generation,
        .publication_revision = core::PresentationSnapshotRevision::from_number(9),
        .mounted = {.instance = core::MountedLayoutInstanceId::from_number(5),
                    .layout = std::move(layout).value(),
                    .owner = core::MountedLayoutOwner::Gameplay,
                    .policy = visible_game_ui_policy()},
        .composition_group = core::PresentationCompositionGroup::Interface,
        .source = AssetLayoutRealizationSource{.logical_path = "project:/layouts/game-hud.rml"},
    };

    LayoutRealizationRequest request = std::move(realize);
    REQUIRE(std::holds_alternative<RealizeLayoutRequest>(request));
    const auto& stored = std::get<RealizeLayoutRequest>(request);
    CHECK(stored.mounted.instance.number() == 5);
    REQUIRE(std::holds_alternative<AssetLayoutRealizationSource>(stored.source));

    LayoutRealizationResult result{
        .disposition = LayoutRealizationDisposition::Created,
        .instance = stored.mounted.instance,
        .document_id = "layout-game-hud-5",
        .affected_count = 1,
        .diagnostics = {},
    };
    CHECK(result.succeeded());
    result.disposition = LayoutRealizationDisposition::RejectedStale;
    CHECK_FALSE(result.succeeded());

    STATIC_REQUIRE(std::variant_size_v<LayoutRealizationSource> == 5);
    STATIC_REQUIRE(std::variant_size_v<LayoutRealizationRequest> == 3);
}

TEST_CASE("preview contracts are closed typed requests after protocol decoding")
{
    const auto request_id = PreviewRequestId::from_number(11);
    const auto host_generation = HostGeneration::from_number(8);
    REQUIRE(request_id.has_value());
    REQUIRE(host_generation.has_value());

    PreviewRequest request{
        .request = *request_id,
        .host_generation = *host_generation,
        .payload =
            PreviewLayoutDocumentRequest{
                .layout_kind = PreviewLayoutKind::Fragment,
                .rml = "<button>Continue</button>",
                .rcss = "button { color: white; }",
                .lua = "",
                .script_enabled = false,
                .fragment_host_rml = "<rml><body>__NT_LAYOUT_FRAGMENT__</body></rml>",
                .fragment_host_rcss = "",
            },
    };

    REQUIRE(std::holds_alternative<PreviewLayoutDocumentRequest>(request.payload));
    CHECK(std::get<PreviewLayoutDocumentRequest>(request.payload).layout_kind ==
          PreviewLayoutKind::Fragment);

    PreviewResult result{
        .request = *request_id,
        .disposition = PreviewRequestDisposition::Applied,
        .payload = PreviewTextResult{.text = "ok"},
    };
    CHECK(result.accepted());
    CHECK(std::get<PreviewTextResult>(result.payload).text == "ok");
    result.disposition = PreviewRequestDisposition::Rejected;
    CHECK_FALSE(result.accepted());

    STATIC_REQUIRE(std::variant_size_v<PreviewRequestPayload> == 11);
    STATIC_REQUIRE(std::variant_size_v<PreviewResultPayload> == 4);
}

} // namespace
} // namespace noveltea::host
