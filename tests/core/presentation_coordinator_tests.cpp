#include <noveltea/core/presentation_coordinator.hpp>

#include <catch2/catch_test_macros.hpp>

#include <limits>

using namespace noveltea::core;
namespace compiled = noveltea::core::compiled;

namespace {
template<class Id> Id id(const char* value) { return std::move(Id::create(value)).value(); }

TransitionPresentationOperation transition(std::uint64_t number)
{
    return {.id = PresentationOperationId::from_number(number),
            .kind = compiled::TransitionKind::Cut};
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
        snapshots.push_back(snapshot.revision);
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
    snapshot.revision = 7;
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
