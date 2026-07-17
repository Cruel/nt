#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include "noveltea/world_transition.hpp"

#include <algorithm>
#include <bit>
#include <utility>

using namespace noveltea;
using namespace noveltea::core;
namespace compiled = noveltea::core::compiled;

namespace {

template<class Id> Id id(const char* value) { return std::move(Id::create(value)).value(); }

class EmptyWorldResources final : public WorldPresentationResourceResolver {
public:
    Result<WorldPreparedVisual, Diagnostics> resolve(std::optional<AssetId>,
                                                     std::optional<core::MaterialId> material,
                                                     std::string_view) override
    {
        WorldPreparedVisual result;
        if (material)
            result.material = noveltea::MaterialId(material->text());
        return Result<WorldPreparedVisual, Diagnostics>::success(std::move(result));
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

CoordinatedOperationDelivery
delivery(std::uint64_t operation, LayoutClockDomain clock,
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

FinitePresentationOperationCommon common(std::uint64_t operation, std::uint64_t source = 1,
                                         std::uint64_t target = 2)
{
    return {.id = PresentationOperationId::from_number(operation),
            .duration = std::chrono::milliseconds{100},
            .skippable = true,
            .clock = LayoutClockDomain::Gameplay,
            .revisions = {PresentationSnapshotRevision::from_number(source),
                          PresentationSnapshotRevision::from_number(target)}};
}

template<class Operation>
CoordinatedOperationDelivery targeted_delivery(std::uint64_t operation, Operation value)
{
    const auto id = PresentationOperationId::from_number(operation);
    return {{id, PresentationOperationSequence::from_number(operation),
             PresentationOperationOwner::GameplayRuntime, CheckpointClass::Disposable,
             NoPresentationCompletion{}},
            std::move(value)};
}

PresentationActor actor(ActorPresentationKey key, compiled::ActorPosition position,
                        const char* pose = "standing")
{
    return PresentationActor{std::move(key),
                             id<CharacterId>("hero"),
                             id<CharacterPoseId>(pose),
                             id<CharacterExpressionId>("neutral"),
                             std::nullopt,
                             id<core::MaterialId>("pose-material"),
                             {0.5, 1.0},
                             {0.0, 0.0},
                             1.0,
                             std::nullopt,
                             std::nullopt,
                             {position, {0.0, 0.0}, 1.0},
                             std::nullopt,
                             std::nullopt,
                             PresentationPlane::WorldContent,
                             0,
                             true,
                             true,
                             true};
}

PresentationMountedLayout layout(MountedLayoutPresentationKey key)
{
    MountedLayoutPolicy policy;
    policy.plane = PresentationPlane::GameUi;
    policy.visibility = LayoutVisibility::Visible;
    return {std::move(key), SessionPresentationOwner{PresentationSessionId::from_number(1)},
            id<LayoutId>("hud"), policy, PresentationCompositionGroup::Interface};
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

TEST_CASE("unrelated world transition targets cannot silently displace active work")
{
    EmptyWorldResources resources;
    WorldPresentationBackend world(resources);
    REQUIRE(world.reconcile(snapshot(1), {1280.0f, 720.0f}));
    REQUIRE(world.reconcile(snapshot(2), {1280.0f, 720.0f}));
    REQUIRE(world.reconcile(snapshot(3), {1280.0f, 720.0f}));
    WorldTransitionBackend transitions(world);

    REQUIRE(transitions.realize(delivery(40, LayoutClockDomain::Gameplay)));
    (void)transitions.take_acknowledgements();

    static_assert(sizeof(FlowFrameId) == sizeof(std::uint64_t));
    static_assert(sizeof(PresentationFlowBlockerHandle) == sizeof(std::uint64_t));
    const auto owner = std::bit_cast<FlowFrameId>(std::uint64_t{4});
    const auto blocker = std::bit_cast<PresentationFlowBlockerHandle>(std::uint64_t{5});
    RoomNavigationTransitionOperation navigation{
        .common = common(41, 2, 3),
        .target = {.source_room = id<RoomId>("hall"), .target_room = id<RoomId>("garden")},
        .kind = compiled::TransitionKind::Dissolve,
        .color = std::nullopt,
        .completion = PresentationFlowCompletion{owner, blocker},
    };
    REQUIRE(transitions.realize(targeted_delivery(41, navigation)));

    const auto facts = transitions.take_acknowledgements();
    REQUIRE(facts.size() == 1);
    const auto* failed = std::get_if<BackendOperationFailed>(&facts.front().fact);
    REQUIRE(failed != nullptr);
    CHECK(failed->diagnostic.code == "presentation.world_transition_target_conflict");
    REQUIRE(transitions.render_state());
    CHECK(transitions.render_state()->operation ==
          PresentationOperationRef{PresentationOperationId::from_number(40)});
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
    REQUIRE(transitions.realize(
        delivery(3, LayoutClockDomain::UnscaledPresentation, compiled::TransitionKind::Dissolve)));
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

TEST_CASE("targeted background cross-fade retains exact revisions and completes")
{
    EmptyWorldResources resources;
    WorldPresentationBackend world(resources);
    auto source = snapshot(1);
    source.background = PresentationBackground{.color = std::string{"#ff0000"}};
    auto target = snapshot(2);
    target.background = PresentationBackground{.color = std::string{"#0000ff"}};
    REQUIRE(world.reconcile(source, {1280.0f, 720.0f}));
    REQUIRE(world.reconcile(target, {1280.0f, 720.0f}));

    WorldTransitionBackend transitions(world);
    BackgroundPresentationOperation operation{common(21), BackgroundOperationKind::CrossFade,
                                              std::nullopt};
    REQUIRE(transitions.realize(targeted_delivery(21, operation)));
    auto facts = transitions.take_acknowledgements();
    REQUIRE(facts.size() == 1);
    CHECK(std::holds_alternative<BackendOperationRunning>(facts.front().fact));
    CHECK(transitions.active_revisions().size() == 2);

    RuntimeClockUpdate clocks;
    clocks.gameplay_delta = std::chrono::milliseconds{50};
    transitions.advance(clocks);
    auto batch = transitions.compose_targeted_world_batch();
    REQUIRE(batch);
    REQUIRE(batch.value().commands().size() == 2);
    CHECK(batch.value().commands()[0].color.a == Catch::Approx(0.5f));
    CHECK(batch.value().commands()[1].color.a == Catch::Approx(0.5f));

    transitions.advance(clocks);
    CHECK(transitions.targeted_render_states().empty());
    facts = transitions.take_acknowledgements();
    REQUIRE(facts.size() == 1);
    CHECK(std::holds_alternative<BackendOperationCompleted>(facts.front().fact));
}

TEST_CASE("targeted actor slide interpolates resolved bounds and rejects pose changes")
{
    EmptyWorldResources resources;
    WorldPresentationBackend world(resources);
    const ActorPresentationKey key = CharacterActorKey{id<CharacterId>("hero")};
    auto source = snapshot(1);
    source.actors.push_back(actor(key, compiled::ActorPosition::Left));
    auto target = snapshot(2);
    target.actors.push_back(actor(key, compiled::ActorPosition::Right));
    REQUIRE(world.reconcile(source, {1000.0f, 500.0f}));
    REQUIRE(world.reconcile(target, {1000.0f, 500.0f}));

    WorldTransitionBackend transitions(world);
    ActorPresentationOperation slide{common(22), {key}, ActorOperationKind::Slide, std::nullopt};
    REQUIRE(transitions.realize(targeted_delivery(22, slide)));
    (void)transitions.take_acknowledgements();
    RuntimeClockUpdate clocks;
    clocks.gameplay_delta = std::chrono::milliseconds{50};
    transitions.advance(clocks);
    auto batch = transitions.compose_targeted_world_batch();
    REQUIRE(batch);
    REQUIRE(batch.value().commands().size() == 1);
    CHECK(batch.value().commands().front().rect.x == Catch::Approx(340.0f));

    REQUIRE(world.resize({2000.0f, 1000.0f}));
    batch = transitions.compose_targeted_world_batch();
    REQUIRE(batch);
    REQUIRE(batch.value().commands().size() == 1);
    CHECK(batch.value().commands().front().rect.x == Catch::Approx(680.0f));

    transitions.reset(PresentationCancellationReason::RuntimeReset);
    auto invalid_target = snapshot(3);
    invalid_target.actors.push_back(actor(key, compiled::ActorPosition::Right, "kneeling"));
    REQUIRE(world.reconcile(invalid_target, {1000.0f, 500.0f}));
    slide.common = common(23, 2, 3);
    REQUIRE(transitions.realize(targeted_delivery(23, slide)));
    const auto facts = transitions.take_acknowledgements();
    REQUIRE(facts.size() == 1);
    const auto* failed = std::get_if<BackendOperationFailed>(&facts.front().fact);
    REQUIRE(failed != nullptr);
    CHECK(failed->diagnostic.code == "presentation.actor_slide_semantics_invalid");
}

TEST_CASE("targeted actor fade cross-fades general actor replacement")
{
    EmptyWorldResources resources;
    WorldPresentationBackend world(resources);
    const ActorPresentationKey key = CharacterActorKey{id<CharacterId>("hero")};
    auto source = snapshot(1);
    source.actors.push_back(actor(key, compiled::ActorPosition::Left));
    auto target = snapshot(2);
    target.actors.push_back(actor(key, compiled::ActorPosition::Right, "kneeling"));
    REQUIRE(world.reconcile(source, {1000.0f, 500.0f}));
    REQUIRE(world.reconcile(target, {1000.0f, 500.0f}));

    WorldTransitionBackend transitions(world);
    ActorPresentationOperation fade{common(31), {key}, ActorOperationKind::Fade, std::nullopt};
    REQUIRE(transitions.realize(targeted_delivery(31, fade)));
    (void)transitions.take_acknowledgements();
    RuntimeClockUpdate clocks;
    clocks.gameplay_delta = std::chrono::milliseconds{50};
    transitions.advance(clocks);

    auto batch = transitions.compose_targeted_world_batch();
    REQUIRE(batch);
    REQUIRE(batch.value().commands().size() == 2);
    CHECK(batch.value().commands()[0].color.a == Catch::Approx(0.5f));
    CHECK(batch.value().commands()[1].color.a == Catch::Approx(0.5f));
    CHECK(batch.value().commands()[0].rect.x != batch.value().commands()[1].rect.x);
}

TEST_CASE("targeted actor slide rejects hidden pose or expression changes")
{
    EmptyWorldResources resources;
    WorldPresentationBackend world(resources);
    const ActorPresentationKey key = CharacterActorKey{id<CharacterId>("hero")};
    auto source = snapshot(1);
    auto hidden = actor(key, compiled::ActorPosition::Left, "standing");
    hidden.visible = false;
    source.actors.push_back(hidden);
    auto target = snapshot(2);
    target.actors.push_back(actor(key, compiled::ActorPosition::Left, "kneeling"));
    REQUIRE(world.reconcile(source, {1000.0f, 500.0f}));
    REQUIRE(world.reconcile(target, {1000.0f, 500.0f}));

    WorldTransitionBackend transitions(world);
    ActorPresentationOperation slide{common(32), {key}, ActorOperationKind::Slide, std::nullopt};
    REQUIRE(transitions.realize(targeted_delivery(32, slide)));
    const auto facts = transitions.take_acknowledgements();
    REQUIRE(facts.size() == 1);
    const auto* failed = std::get_if<BackendOperationFailed>(&facts.front().fact);
    REQUIRE(failed != nullptr);
    CHECK(failed->diagnostic.code == "presentation.actor_slide_semantics_invalid");
}

TEST_CASE("targeted actor show slide derives nearest horizontal offscreen endpoint")
{
    EmptyWorldResources resources;
    WorldPresentationBackend world(resources);
    const ActorPresentationKey key = CharacterActorKey{id<CharacterId>("hero")};
    auto source = snapshot(1);
    auto target = snapshot(2);
    target.actors.push_back(actor(key, compiled::ActorPosition::Left));
    REQUIRE(world.reconcile(source, {1000.0f, 500.0f}));
    REQUIRE(world.reconcile(target, {1000.0f, 500.0f}));

    WorldTransitionBackend transitions(world);
    ActorPresentationOperation slide{common(24), {key}, ActorOperationKind::Slide, std::nullopt};
    REQUIRE(transitions.realize(targeted_delivery(24, slide)));
    (void)transitions.take_acknowledgements();
    auto batch = transitions.compose_targeted_world_batch();
    REQUIRE(batch);
    REQUIRE(batch.value().commands().size() == 1);
    CHECK(batch.value().commands().front().rect.x == Catch::Approx(-320.0f));
}

TEST_CASE("targeted actor hide slide converges to the nearest horizontal offscreen endpoint")
{
    EmptyWorldResources resources;
    WorldPresentationBackend world(resources);
    const ActorPresentationKey key = CharacterActorKey{id<CharacterId>("hero")};
    auto source = snapshot(1);
    source.actors.push_back(actor(key, compiled::ActorPosition::Right));
    auto target = snapshot(2);
    auto hidden = actor(key, compiled::ActorPosition::Right);
    hidden.visible = false;
    target.actors.push_back(hidden);
    REQUIRE(world.reconcile(source, {1000.0f, 500.0f}));
    REQUIRE(world.reconcile(target, {1000.0f, 500.0f}));

    WorldTransitionBackend transitions(world);
    ActorPresentationOperation slide{common(33), {key}, ActorOperationKind::Slide, std::nullopt};
    REQUIRE(transitions.realize(targeted_delivery(33, slide)));
    (void)transitions.take_acknowledgements();
    RuntimeClockUpdate clocks;
    clocks.gameplay_delta = std::chrono::milliseconds{50};
    transitions.advance(clocks);
    auto batch = transitions.compose_targeted_world_batch();
    REQUIRE(batch);
    REQUIRE(batch.value().commands().size() == 1);
    CHECK(batch.value().commands().front().rect.x == Catch::Approx(795.0f));
}

TEST_CASE("targeted realization remains active beneath a concurrent full-world transition")
{
    EmptyWorldResources resources;
    WorldPresentationBackend world(resources);
    const ActorPresentationKey key = CharacterActorKey{id<CharacterId>("hero")};
    auto first = snapshot(1);
    first.actors.push_back(actor(key, compiled::ActorPosition::Left));
    auto second = snapshot(2);
    second.actors.push_back(actor(key, compiled::ActorPosition::Center));
    auto third = snapshot(3);
    third.actors.push_back(actor(key, compiled::ActorPosition::Right));
    REQUIRE(world.reconcile(first, {1000.0f, 500.0f}));
    REQUIRE(world.reconcile(second, {1000.0f, 500.0f}));
    REQUIRE(world.reconcile(third, {1000.0f, 500.0f}));

    WorldTransitionBackend transitions(world);
    auto whole_world =
        delivery(34, LayoutClockDomain::Gameplay, compiled::TransitionKind::Dissolve);
    auto* group = std::get_if<SceneTransitionGroupOperation>(&whole_world.operation);
    REQUIRE(group != nullptr);
    group->common.revisions = {PresentationSnapshotRevision::from_number(1),
                               PresentationSnapshotRevision::from_number(2)};
    REQUIRE(transitions.realize(whole_world));
    REQUIRE(transitions.realize(targeted_delivery(
        35, ActorPresentationOperation{
                common(35, 2, 3), {key}, ActorOperationKind::Slide, std::nullopt})));
    (void)transitions.take_acknowledgements();
    RuntimeClockUpdate clocks;
    clocks.gameplay_delta = std::chrono::milliseconds{50};
    transitions.advance(clocks);

    REQUIRE(transitions.render_state());
    REQUIRE(transitions.targeted_render_states().size() == 1);
    auto batch = transitions.compose_targeted_world_batch();
    REQUIRE(batch);
    REQUIRE(batch.value().commands().size() == 1);
    CHECK(batch.value().commands().front().rect.x == Catch::Approx(465.0f));
}

TEST_CASE("targeted operations replace only the same typed target")
{
    EmptyWorldResources resources;
    WorldPresentationBackend world(resources);
    const ActorPresentationKey hero = CharacterActorKey{id<CharacterId>("hero")};
    const ActorPresentationKey rival = CharacterActorKey{id<CharacterId>("rival")};
    auto source = snapshot(1);
    source.actors.push_back(actor(hero, compiled::ActorPosition::Left));
    auto rival_source = actor(rival, compiled::ActorPosition::Right);
    rival_source.character = id<CharacterId>("rival");
    source.actors.push_back(rival_source);
    auto target = source;
    target.revision = PresentationSnapshotRevision::from_number(2);
    target.actors[0].placement.position = compiled::ActorPosition::Center;
    target.actors[1].placement.position = compiled::ActorPosition::Center;
    REQUIRE(world.reconcile(source, {1000.0f, 500.0f}));
    REQUIRE(world.reconcile(target, {1000.0f, 500.0f}));

    WorldTransitionBackend transitions(world);
    REQUIRE(transitions.realize(targeted_delivery(
        25,
        ActorPresentationOperation{common(25), {hero}, ActorOperationKind::Fade, std::nullopt})));
    REQUIRE(transitions.realize(targeted_delivery(
        26,
        ActorPresentationOperation{common(26), {rival}, ActorOperationKind::Fade, std::nullopt})));
    REQUIRE(transitions.realize(
        targeted_delivery(27, BackgroundPresentationOperation{
                                  common(27), BackgroundOperationKind::CrossFade, std::nullopt})));
    REQUIRE(transitions.realize(targeted_delivery(
        28,
        ActorPresentationOperation{common(28), {hero}, ActorOperationKind::Fade, std::nullopt})));

    const auto states = transitions.targeted_render_states();
    REQUIRE(states.size() == 3);
    CHECK(std::none_of(states.begin(), states.end(), [](const auto& state) {
        return state.operation ==
               PresentationOperationRef{PresentationOperationId::from_number(25)};
    }));
}

TEST_CASE("layout fade uses the shared targeted lifecycle and clears on skip or reset")
{
    EmptyWorldResources resources;
    WorldPresentationBackend world(resources);
    const MountedLayoutPresentationKey key = ReservedLayoutMountKey{compiled::LayoutSlot::Hud};
    auto source = snapshot(1);
    auto target = snapshot(2);
    target.layouts.push_back(layout(key));
    REQUIRE(world.reconcile(source, {1280.0f, 720.0f}));
    REQUIRE(world.reconcile(target, {1280.0f, 720.0f}));

    WorldTransitionBackend transitions(world);
    LayoutFinitePresentationOperation fade{
        common(29), {key}, LayoutOperationKind::Fade, std::nullopt};
    REQUIRE(transitions.realize(targeted_delivery(29, fade)));
    (void)transitions.take_acknowledgements();
    RuntimeClockUpdate clocks;
    clocks.gameplay_delta = std::chrono::milliseconds{25};
    transitions.advance(clocks);
    auto layouts = transitions.layout_render_states();
    REQUIRE(layouts.size() == 1);
    CHECK(layouts.front().progress == Catch::Approx(0.25f));

    transitions.snap_to_target(PresentationOperationRef{PresentationOperationId::from_number(29)});
    CHECK(transitions.layout_render_states().empty());
    fade.common.id = PresentationOperationId::from_number(30);
    REQUIRE(transitions.realize(targeted_delivery(30, fade)));
    transitions.reset(PresentationCancellationReason::RuntimeReset);
    CHECK(transitions.targeted_render_states().empty());
    CHECK(transitions.active_revisions().empty());
}
