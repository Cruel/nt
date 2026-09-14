#include "host/host_lifecycle_contracts.hpp"
#include "host/runtime_host_contracts.hpp"

#include <catch2/catch_test_macros.hpp>

#include <array>
#include <string_view>
#include <utility>

namespace noveltea::host {
namespace {

TEST_CASE("host runtime dispatch result preserves one settled runtime dispatch")
{
    const auto revision = runtime::RuntimePublicationRevision::from_number(7);
    REQUIRE(revision.has_value());

    runtime::RuntimeDispatchResult runtime_result{
        .disposition = runtime::RuntimeInputDisposition::Handled,
        .presentation_predecessor =
            core::RuntimePresentationSnapshot{
                .revision = core::PresentationSnapshotRevision::from_number(6)},
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
    REQUIRE(result.presentation_predecessor);
    CHECK(result.presentation_predecessor->revision.number() == 6);
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

TEST_CASE("host lifecycle status classifies initialized and terminal states")
{
    HostLifecycleStatus status;
    for (const auto state :
         {HostLifecycleState::Ready, HostLifecycleState::Running, HostLifecycleState::Suspended,
          HostLifecycleState::Stopping, HostLifecycleState::ShuttingDown}) {
        status.state = state;
        CHECK(status.initialized());
        CHECK_FALSE(status.terminal());
    }

    for (const auto state : {HostLifecycleState::Uninitialized, HostLifecycleState::Initializing}) {
        status.state = state;
        CHECK_FALSE(status.initialized());
        CHECK_FALSE(status.terminal());
    }

    for (const auto state : {HostLifecycleState::Shutdown, HostLifecycleState::Failed}) {
        status.state = state;
        CHECK_FALSE(status.initialized());
        CHECK(status.terminal());
    }
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

} // namespace
} // namespace noveltea::host
