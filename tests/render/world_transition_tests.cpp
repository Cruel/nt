#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include "noveltea/world_transition.hpp"

#include <bit>

using namespace noveltea;
using namespace noveltea::core;
namespace compiled = noveltea::core::compiled;

namespace {

class EmptyWorldResources final : public WorldPresentationResourceResolver {
public:
    Result<WorldPreparedVisual, Diagnostics> resolve(std::optional<AssetId>,
                                                     std::optional<core::MaterialId>,
                                                     std::string_view) override
    {
        return Result<WorldPreparedVisual, Diagnostics>::success({});
    }

    Result<std::optional<WorldPreparedVisual>, Diagnostics>
    resolve_environment(std::string_view, std::string_view) override
    {
        return Result<std::optional<WorldPreparedVisual>, Diagnostics>::success(std::nullopt);
    }
};

RuntimePresentationSnapshot snapshot(std::uint64_t revision)
{
    RuntimePresentationSnapshot result;
    result.revision = PresentationSnapshotRevision::from_number(revision);
    result.mode = PresentationRuntimeMode::Room;
    return result;
}

CoordinatedOperationDelivery delivery(std::uint64_t operation, LayoutClockDomain clock,
                                      compiled::TransitionKind kind = compiled::TransitionKind::Fade)
{
    const auto id = PresentationOperationId::from_number(operation);
    SceneTransitionGroupOperation transition{
        .common = {.id = id,
                   .duration = std::chrono::milliseconds{100},
                   .skippable = true,
                   .clock = clock,
                   .revisions = {PresentationSnapshotRevision::from_number(1),
                                 PresentationSnapshotRevision::from_number(2)}},
        .kind = kind,
        .color = std::string{"#204060"},
        .completion = std::nullopt,
    };
    return {{id, PresentationOperationSequence::from_number(operation),
             PresentationOperationOwner::GameplayRuntime, CheckpointClass::Disposable,
             NoPresentationCompletion{}},
            transition};
}

} // namespace

TEST_CASE("world transition backend keeps causal barrier until exact completion acknowledgement")
{
    EmptyWorldResources resources;
    WorldPresentationBackend world(resources);
    REQUIRE(world.reconcile(snapshot(1), {1280.0f, 720.0f}));
    REQUIRE(world.reconcile(snapshot(2), {1280.0f, 720.0f}));
    WorldTransitionBackend transitions(world);

    class SnapshotBackend final : public PresentationSnapshotBackendPort {
    public:
        Result<void, Diagnostics> reconcile(const RuntimePresentationSnapshot&) override
        {
            return Result<void, Diagnostics>::success();
        }
        void reset(PresentationCancellationReason) override {}
    } snapshots;

    static_assert(sizeof(FlowFrameId) == sizeof(std::uint64_t));
    static_assert(sizeof(PresentationFlowBlockerHandle) == sizeof(std::uint64_t));
    const auto owner = std::bit_cast<FlowFrameId>(std::uint64_t{7});
    const auto blocker = std::bit_cast<PresentationFlowBlockerHandle>(std::uint64_t{9});
    auto operation = std::get<SceneTransitionGroupOperation>(
        delivery(11, LayoutClockDomain::Gameplay).operation);
    operation.completion = PresentationFlowCompletion{owner, blocker};

    PresentationCoordinator coordinator(&snapshots, &transitions);
    auto accepted = coordinator.accept(PresentationOperation{operation});
    REQUIRE(accepted);
    CHECK(coordinator.checkpoint_status().active_barriers.size() == 1);
    REQUIRE(coordinator.deliver_pending());
    auto facts = transitions.take_acknowledgements();
    REQUIRE(facts.size() == 1);
    REQUIRE(coordinator.acknowledge(facts.front()));
    CHECK(coordinator.checkpoint_status().active_barriers.size() == 1);

    RuntimeClockUpdate clocks;
    clocks.gameplay_delta = std::chrono::milliseconds{100};
    transitions.advance(clocks);
    facts = transitions.take_acknowledgements();
    REQUIRE(facts.size() == 1);
    REQUIRE(coordinator.acknowledge(facts.front()));
    CHECK(coordinator.checkpoint_status().active_barriers.empty());
}

TEST_CASE("world transition backend requires exact source and target revisions")
{
    EmptyWorldResources resources;
    WorldPresentationBackend world(resources);
    REQUIRE(world.reconcile(snapshot(2), {1280.0f, 720.0f}));
    WorldTransitionBackend transitions(world);

    REQUIRE(transitions.realize(delivery(1, LayoutClockDomain::Gameplay)));
    const auto facts = transitions.take_acknowledgements();
    REQUIRE(facts.size() == 1);
    const auto* failed = std::get_if<BackendOperationFailed>(&facts.front().fact);
    REQUIRE(failed != nullptr);
    CHECK(failed->diagnostic.code == "presentation.world_transition_revision_unavailable");
    CHECK_FALSE(transitions.render_state());
}

TEST_CASE("gameplay world transitions freeze while gameplay is paused")
{
    EmptyWorldResources resources;
    WorldPresentationBackend world(resources);
    REQUIRE(world.reconcile(snapshot(1), {1280.0f, 720.0f}));
    REQUIRE(world.reconcile(snapshot(2), {1280.0f, 720.0f}));
    WorldTransitionBackend transitions(world);
    REQUIRE(transitions.realize(delivery(2, LayoutClockDomain::Gameplay)));
    auto facts = transitions.take_acknowledgements();
    REQUIRE(facts.size() == 1);
    CHECK(std::holds_alternative<BackendOperationRunning>(facts.front().fact));

    RuntimeClockUpdate clocks;
    clocks.gameplay_paused = true;
    clocks.unscaled_presentation_delta = std::chrono::milliseconds{50};
    transitions.advance(clocks);
    REQUIRE(transitions.render_state());
    CHECK(transitions.render_state()->progress == 0.0f);

    clocks.gameplay_paused = false;
    clocks.gameplay_delta = std::chrono::milliseconds{50};
    transitions.advance(clocks);
    REQUIRE(transitions.render_state());
    CHECK(transitions.render_state()->progress == Catch::Approx(0.5f));

    transitions.advance(clocks);
    CHECK_FALSE(transitions.render_state());
    facts = transitions.take_acknowledgements();
    REQUIRE(facts.size() == 1);
    CHECK(std::holds_alternative<BackendOperationCompleted>(facts.front().fact));
}

TEST_CASE("unscaled world transitions continue while gameplay is paused")
{
    EmptyWorldResources resources;
    WorldPresentationBackend world(resources);
    REQUIRE(world.reconcile(snapshot(1), {1280.0f, 720.0f}));
    REQUIRE(world.reconcile(snapshot(2), {1280.0f, 720.0f}));
    WorldTransitionBackend transitions(world);
    REQUIRE(transitions.realize(delivery(3, LayoutClockDomain::UnscaledPresentation,
                                         compiled::TransitionKind::Dissolve)));
    (void)transitions.take_acknowledgements();

    RuntimeClockUpdate clocks;
    clocks.gameplay_paused = true;
    clocks.unscaled_presentation_delta = std::chrono::milliseconds{25};
    transitions.advance(clocks);
    REQUIRE(transitions.render_state());
    CHECK(transitions.render_state()->kind == WorldTransitionVisualKind::Dissolve);
    CHECK(transitions.render_state()->progress == Catch::Approx(0.25f));
}

TEST_CASE("world transition resize rebuilds both retained revisions")
{
    EmptyWorldResources resources;
    WorldPresentationBackend world(resources);
    REQUIRE(world.reconcile(snapshot(1), {1280.0f, 720.0f}));
    REQUIRE(world.reconcile(snapshot(2), {1280.0f, 720.0f}));
    REQUIRE(world.resize({1920.0f, 1080.0f}));
    REQUIRE(world.frame(PresentationSnapshotRevision::from_number(1)) != nullptr);
    REQUIRE(world.frame(PresentationSnapshotRevision::from_number(2)) != nullptr);
}
