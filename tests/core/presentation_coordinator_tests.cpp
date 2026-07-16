#include <noveltea/core/presentation_coordinator.hpp>

#include <catch2/catch_test_macros.hpp>

#include <chrono>
#include <limits>
#include <type_traits>

using namespace noveltea::core;
namespace compiled = noveltea::core::compiled;

namespace {
template<class Id> Id id(const char* value) { return std::move(Id::create(value)).value(); }

TransitionPresentationOperation transition(std::uint64_t number)
{
    return {.id = PresentationOperationId::from_number(number),
            .kind = compiled::TransitionKind::Cut};
}

FinitePresentationOperationCommon finite_common(std::uint64_t number,
                                                std::uint64_t source_revision = 1,
                                                std::uint64_t target_revision = 2)
{
    return {
        .id = PresentationOperationId::from_number(number),
        .duration = std::chrono::milliseconds{250},
        .skippable = true,
        .clock = LayoutClockDomain::Gameplay,
        .revisions = {PresentationSnapshotRevision::from_number(source_revision),
                      PresentationSnapshotRevision::from_number(target_revision)},
    };
}

AudioOperation audio(std::uint64_t number, bool loop = false)
{
    return {.id = AudioOperationId::from_number(number),
            .action = compiled::AudioAction::Play,
            .channel = loop ? compiled::AudioChannel::Music : compiled::AudioChannel::SoundEffect,
            .asset = id<AssetId>("sound"),
            .loop = loop};
}

class FakeBackend final : public PresentationSnapshotBackendPort,
                          public PresentationOperationBackendPort {
public:
    Result<void, Diagnostics> reconcile(const RuntimePresentationSnapshot& snapshot) override
    {
        snapshots.push_back(snapshot.revision.number());
        return Result<void, Diagnostics>::success();
    }
    Result<void, Diagnostics> realize(const CoordinatedOperationDelivery& delivery) override
    {
        if (fail_delivery) {
            fail_delivery = false;
            return Result<void, Diagnostics>::failure(
                {{.code = "fake.delivery", .message = "retry"}});
        }
        deliveries.push_back(delivery);
        return Result<void, Diagnostics>::success();
    }
    void reset(PresentationCancellationReason reason) override { resets.push_back(reason); }

    bool fail_delivery = false;
    std::vector<std::uint64_t> snapshots;
    std::vector<CoordinatedOperationDelivery> deliveries;
    std::vector<PresentationCancellationReason> resets;
};

BackendOperationAcknowledgement acknowledgement(const PresentationOperationLifecycle& lifecycle,
                                                BackendOperationFact fact)
{
    return {lifecycle.metadata.operation, lifecycle.metadata.sequence, lifecycle.metadata.owner,
            std::move(fact)};
}
} // namespace

TEST_CASE("coordinator assigns one total order and registers causal barriers synchronously")
{
    PresentationCoordinator coordinator;
    auto first = coordinator.accept(PresentationOperation{transition(1)});
    auto second = coordinator.accept(audio(1));
    auto third = coordinator.accept(audio(2, true));
    REQUIRE(first);
    REQUIRE(second);
    REQUIRE(third);
    CHECK(first.value().metadata.sequence.number() == 1);
    CHECK(second.value().metadata.sequence.number() == 2);
    CHECK(third.value().metadata.sequence.number() == 3);
    CHECK(first.value().metadata.checkpoint_class == CheckpointClass::CausalBarrier);
    CHECK(second.value().metadata.checkpoint_class == CheckpointClass::CausalBarrier);
    CHECK(third.value().metadata.checkpoint_class == CheckpointClass::Reconstructible);
    CHECK(coordinator.checkpoint_status().active_barriers.size() == 2);
    CHECK(coordinator.checkpoint_status().revision.number() == 3);
}

TEST_CASE("coordinator validates ActiveText causal phase and clock before acceptance")
{
    PresentationCoordinator coordinator;
    const auto operation = PresentationOperationId::from_number(1);

    auto stable = coordinator.accept(ActiveTextPresentationOperation{
        operation, ActiveTextPresentationPhase::Stable, LayoutClockDomain::Gameplay});
    REQUIRE_FALSE(stable);
    CHECK(stable.error().front().code == "presentation.invalid_active_text_operation");

    auto invalid_phase = coordinator.accept(ActiveTextPresentationOperation{
        PresentationOperationId::from_number(2), static_cast<ActiveTextPresentationPhase>(255),
        LayoutClockDomain::Gameplay});
    REQUIRE_FALSE(invalid_phase);

    auto invalid_clock = coordinator.accept(ActiveTextPresentationOperation{
        PresentationOperationId::from_number(3), ActiveTextPresentationPhase::Reveal,
        static_cast<LayoutClockDomain>(255)});
    REQUIRE_FALSE(invalid_clock);
    CHECK(coordinator.lifecycles().empty());
    CHECK(coordinator.checkpoint_status().active_barriers.empty());

    auto reveal = coordinator.accept(ActiveTextPresentationOperation{
        PresentationOperationId::from_number(4), ActiveTextPresentationPhase::Reveal,
        LayoutClockDomain::Gameplay});
    REQUIRE(reveal);
    CHECK(reveal.value().metadata.checkpoint_class == CheckpointClass::CausalBarrier);
    CHECK(coordinator.checkpoint_status().active_barriers.size() == 1);
}

TEST_CASE("coordinator enforces lifecycle acknowledgement identity and terminal paths")
{
    PresentationCoordinator coordinator;
    auto accepted = coordinator.accept(PresentationOperation{transition(8)});
    REQUIRE(accepted);
    auto wrong = acknowledgement(accepted.value(), BackendOperationRunning{});
    wrong.sequence = PresentationOperationSequence::from_number(99);
    auto rejected = coordinator.acknowledge(wrong);
    REQUIRE_FALSE(rejected);
    CHECK(rejected.error().front().code == "presentation.wrong_sequence");
    wrong.sequence = accepted.value().metadata.sequence;
    wrong.owner = PresentationOperationOwner::Shell;
    rejected = coordinator.acknowledge(wrong);
    REQUIRE_FALSE(rejected);
    CHECK(rejected.error().front().code == "presentation.wrong_owner");
    wrong.operation = PresentationOperationId::from_number(999);
    rejected = coordinator.acknowledge(wrong);
    REQUIRE_FALSE(rejected);
    CHECK(rejected.error().front().code == "presentation.stale_acknowledgement");
    REQUIRE(coordinator.acknowledge(acknowledgement(accepted.value(), BackendOperationRunning{})));
    REQUIRE(
        coordinator.acknowledge(acknowledgement(accepted.value(), BackendOperationCompleted{})));
    CHECK(coordinator.checkpoint_status().active_barriers.empty());
    CHECK(coordinator.checkpoint_status().revision.number() == 3);
    auto duplicate =
        coordinator.acknowledge(acknowledgement(accepted.value(), BackendOperationCompleted{}));
    REQUIRE_FALSE(duplicate);
    CHECK(duplicate.error().front().code == "presentation.operation_terminal");
}

TEST_CASE("coordinator replacement requires a live accepted replacement")
{
    PresentationCoordinator coordinator;
    auto original = coordinator.accept(audio(1));
    auto replacement = coordinator.accept(audio(2));
    REQUIRE(original);
    REQUIRE(replacement);
    REQUIRE(coordinator.replace(original.value().metadata.operation,
                                replacement.value().metadata.operation));
    REQUIRE(std::holds_alternative<PresentationOperationReplaced>(
        coordinator.lifecycles().front().state));
    CHECK(coordinator.checkpoint_status().active_barriers.size() == 1);
}

TEST_CASE("coordinator reset cancellation is terminal without fabricated completion")
{
    FakeBackend backend;
    PresentationCoordinator coordinator(&backend, &backend);
    REQUIRE(coordinator.accept(PresentationOperation{transition(1)}));
    REQUIRE(coordinator.accept(audio(1)));
    coordinator.cancel_all(PresentationCancellationReason::CheckpointLoad);
    for (const auto& lifecycle : coordinator.lifecycles()) {
        const auto* cancelled = std::get_if<PresentationOperationCancelled>(&lifecycle.state);
        REQUIRE(cancelled);
        CHECK(cancelled->reason == PresentationCancellationReason::CheckpointLoad);
    }
    CHECK(coordinator.checkpoint_status().active_barriers.empty());
    coordinator.reset_backends(PresentationCancellationReason::CheckpointLoad);
    CHECK(backend.resets.size() == 2);
}

TEST_CASE("coordinator snapshot reconciliation is idempotent and operation delivery retries")
{
    FakeBackend backend;
    PresentationCoordinator coordinator(&backend, &backend);
    RuntimePresentationSnapshot invalid_snapshot;
    auto invalid_revision = coordinator.reconcile_snapshot(invalid_snapshot);
    REQUIRE_FALSE(invalid_revision);
    CHECK(invalid_revision.error().front().code == "presentation.invalid_snapshot_revision");

    RuntimePresentationSnapshot snapshot;
    snapshot.revision = PresentationSnapshotRevision::from_number(7);
    REQUIRE(coordinator.reconcile_snapshot(snapshot));
    REQUIRE(coordinator.reconcile_snapshot(snapshot));
    CHECK(backend.snapshots == std::vector<std::uint64_t>{7});
    auto conflicting = snapshot;
    conflicting.mode = PresentationRuntimeMode::Ended;
    auto conflict = coordinator.reconcile_snapshot(conflicting);
    REQUIRE_FALSE(conflict);
    CHECK(conflict.error().front().code == "presentation.snapshot_revision_conflict");

    auto accepted = coordinator.accept(audio(3));
    REQUIRE(accepted);
    backend.fail_delivery = true;
    REQUIRE_FALSE(coordinator.deliver_pending());
    REQUIRE(coordinator.deliver_pending());
    REQUIRE(coordinator.deliver_pending());
    REQUIRE(backend.deliveries.size() == 1);
    REQUIRE(coordinator.acknowledge(acknowledgement(
        accepted.value(),
        BackendOperationFailed{PresentationFailureDomain::AudioPresentation,
                               {.code = "audio.failed", .message = "backend failure"}})));
    CHECK(coordinator.checkpoint_status().active_barriers.empty());
}

TEST_CASE("backend reset redelivers only live unacknowledged operations")
{
    FakeBackend backend;
    PresentationCoordinator coordinator(&backend, &backend);
    auto live = coordinator.accept(audio(1));
    auto completed = coordinator.accept(audio(2));
    REQUIRE(live);
    REQUIRE(completed);
    REQUIRE(coordinator.deliver_pending());
    REQUIRE(
        coordinator.acknowledge(acknowledgement(completed.value(), BackendOperationCompleted{})));
    coordinator.reset_backends(PresentationCancellationReason::ProjectReload);
    REQUIRE(coordinator.deliver_pending());
    REQUIRE(backend.deliveries.size() == 3);
    CHECK(backend.deliveries.back().metadata.operation == live.value().metadata.operation);
}

TEST_CASE("backend reset permits one running acknowledgement for redelivered work")
{
    FakeBackend backend;
    PresentationCoordinator coordinator(&backend, &backend);
    auto accepted = coordinator.accept(audio(1));
    REQUIRE(accepted);
    REQUIRE(coordinator.deliver_pending());
    REQUIRE(coordinator.acknowledge(acknowledgement(accepted.value(), BackendOperationRunning{})));

    coordinator.reset_backends(PresentationCancellationReason::ProjectReload);
    REQUIRE(coordinator.deliver_pending());
    REQUIRE(coordinator.acknowledge(acknowledgement(accepted.value(), BackendOperationRunning{})));

    auto duplicate =
        coordinator.acknowledge(acknowledgement(accepted.value(), BackendOperationRunning{}));
    REQUIRE_FALSE(duplicate);
    CHECK(duplicate.error().front().code == "presentation.duplicate_acknowledgement");
}

TEST_CASE("coordinator rejects contradictory operations before sequence allocation")
{
    PresentationCoordinator coordinator;
    auto invalid = transition(1);
    invalid.owner = std::nullopt;
    // A completion cannot be constructed without its private Flow handle, so use an invalid ID.
    invalid.id = PresentationOperationId::from_number(0);
    auto rejected = coordinator.accept(PresentationOperation{invalid});
    REQUIRE_FALSE(rejected);
    auto valid = coordinator.accept(PresentationOperation{transition(2)});
    REQUIRE(valid);
    CHECK(valid.value().metadata.sequence.number() == 1);

    auto invalid_audio = audio(3);
    invalid_audio.volume = std::numeric_limits<double>::quiet_NaN();
    rejected = coordinator.accept(invalid_audio);
    REQUIRE_FALSE(rejected);
    CHECK(rejected.error().front().code == "presentation.invalid_audio_operation");

    invalid_audio = audio(4);
    invalid_audio.action = compiled::AudioAction::Stop;
    invalid_audio.asset.reset();
    invalid_audio.loop = true;
    rejected = coordinator.accept(invalid_audio);
    REQUIRE_FALSE(rejected);
    CHECK(rejected.error().front().code == "presentation.invalid_audio_operation");

    auto next = coordinator.accept(audio(5));
    REQUIRE(next);
    CHECK(next.value().metadata.sequence.number() == 2);
}

TEST_CASE("finite presentation requests preserve typed targets and revision metadata")
{
    STATIC_REQUIRE_FALSE(
        std::is_same_v<SceneTransitionGroupOperation, RoomNavigationTransitionOperation>);

    FakeBackend backend;
    PresentationCoordinator coordinator(&backend, &backend);
    SceneTransitionGroupOperation group{
        .common = finite_common(1),
        .kind = compiled::TransitionKind::Fade,
        .color = std::string{"#000000"},
        .completion = std::nullopt,
    };
    auto accepted = coordinator.accept(PresentationOperation{group});
    REQUIRE(accepted);
    CHECK(accepted.value().metadata.checkpoint_class == CheckpointClass::Disposable);
    REQUIRE(coordinator.deliver_pending());
    REQUIRE(backend.deliveries.size() == 1);
    const auto* delivered =
        std::get_if<SceneTransitionGroupOperation>(&backend.deliveries.front().operation);
    REQUIRE(delivered != nullptr);
    CHECK(delivered->common.revisions.source.number() == 1);
    CHECK(delivered->common.revisions.target.number() == 2);
    CHECK(operation_skippable(FinitePresentationOperation{*delivered}));
    CHECK(std::holds_alternative<WorldCompositionOperationTarget>(
        operation_target(FinitePresentationOperation{*delivered})));
}

TEST_CASE("finite presentation requests reject immediate and contradictory metadata")
{
    PresentationCoordinator coordinator;
    auto cut = SceneTransitionGroupOperation{
        .common = finite_common(1),
        .kind = compiled::TransitionKind::Cut,
        .color = std::nullopt,
        .completion = std::nullopt,
    };
    auto rejected = coordinator.accept(PresentationOperation{cut});
    REQUIRE_FALSE(rejected);
    CHECK(rejected.error().front().code == "presentation.invalid_transition_group_operation");

    auto invalid_revision = cut;
    invalid_revision.kind = compiled::TransitionKind::Fade;
    invalid_revision.common.revisions.target = PresentationSnapshotRevision::from_number(1);
    rejected = coordinator.accept(PresentationOperation{invalid_revision});
    REQUIRE_FALSE(rejected);
    CHECK(rejected.error().front().code == "presentation.invalid_finite_operation");

    auto invalid_duration = invalid_revision;
    invalid_duration.common.revisions.target = PresentationSnapshotRevision::from_number(2);
    invalid_duration.common.duration = std::chrono::milliseconds{0};
    rejected = coordinator.accept(PresentationOperation{invalid_duration});
    REQUIRE_FALSE(rejected);
    CHECK(rejected.error().front().code == "presentation.invalid_finite_operation");
}

TEST_CASE("finite operation replacement requires the same typed target")
{
    PresentationCoordinator coordinator;
    const ActorPresentationKey hero = CharacterActorKey{id<CharacterId>("hero")};
    const ActorPresentationKey rival = CharacterActorKey{id<CharacterId>("rival")};
    auto first = coordinator.accept(PresentationOperation{ActorPresentationOperation{
        .common = finite_common(1),
        .target = ActorOperationTarget{hero},
        .kind = ActorOperationKind::Fade,
    }});
    auto same_target = coordinator.accept(PresentationOperation{ActorPresentationOperation{
        .common = finite_common(2, 2, 3),
        .target = ActorOperationTarget{hero},
        .kind = ActorOperationKind::Slide,
    }});
    auto other_target = coordinator.accept(PresentationOperation{ActorPresentationOperation{
        .common = finite_common(3, 2, 3),
        .target = ActorOperationTarget{rival},
        .kind = ActorOperationKind::Fade,
    }});
    REQUIRE(first);
    REQUIRE(same_target);
    REQUIRE(other_target);
    REQUIRE(coordinator.replace(first.value().metadata.operation,
                                same_target.value().metadata.operation));

    auto second_first = coordinator.accept(PresentationOperation{ActorPresentationOperation{
        .common = finite_common(4, 3, 4),
        .target = ActorOperationTarget{hero},
        .kind = ActorOperationKind::Fade,
    }});
    REQUIRE(second_first);
    auto rejected = coordinator.replace(second_first.value().metadata.operation,
                                        other_target.value().metadata.operation);
    REQUIRE_FALSE(rejected);
    CHECK(rejected.error().front().code == "presentation.replacement_target_mismatch");
}

TEST_CASE("TransitionGroup target construction is atomic and rejects excluded planes")
{
    const PresentationOwner owner = RoomPresentationOwner{id<RoomId>("room")};
    const ActorPresentationKey actor_key = CharacterActorKey{id<CharacterId>("hero")};
    PresentationTargetDraft source;
    source.actors.push_back({
        .key = actor_key,
        .owner = owner,
        .character = id<CharacterId>("hero"),
        .pose = id<CharacterPoseId>("default"),
        .expression = id<CharacterExpressionId>("neutral"),
        .placement = {},
        .visible = true,
        .presentation_complete = true,
    });

    DesiredMountedLayout invalid_layout{
        .key = ReservedLayoutMountKey{compiled::LayoutSlot::Overlay},
        .owner = owner,
        .layout = id<LayoutId>("ui"),
        .policy = {PresentationPlane::GameUi, 0, LayoutClockDomain::Gameplay,
                   LayoutInputMode::Normal, GameplayPausePolicy::Continue,
                   LayoutVisibility::Visible, EscapeDismissalPolicy::Ignore, std::nullopt,
                   std::nullopt},
        .composition_group = PresentationCompositionGroup::Interface,
    };
    std::vector<TransitionGroupTargetMutation> invalid_mutations;
    invalid_mutations.push_back(TransitionGroupRemoveActorTarget{actor_key, owner});
    invalid_mutations.push_back(TransitionGroupUpsertLayoutTarget{invalid_layout});
    auto rejected = build_transition_group_target(source, invalid_mutations);
    REQUIRE_FALSE(rejected);
    CHECK(rejected.error().front().code == "presentation.excluded_transition_group_plane");
    REQUIRE(source.actors.size() == 1);
    CHECK(source.layouts.empty());

    auto valid_layout = invalid_layout;
    valid_layout.policy.plane = PresentationPlane::WorldOverlay;
    valid_layout.composition_group = PresentationCompositionGroup::World;
    auto built =
        build_transition_group_target(source, {TransitionGroupRemoveActorTarget{actor_key, owner},
                                               TransitionGroupUpsertLayoutTarget{valid_layout}});
    REQUIRE(built);
    CHECK(built.value().actors.empty());
    REQUIRE(built.value().layouts.size() == 1);
    REQUIRE(source.actors.size() == 1);
    CHECK(source.layouts.empty());
}
