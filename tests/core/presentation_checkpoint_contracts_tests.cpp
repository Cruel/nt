#include "noveltea/core/checkpoint_contracts.hpp"
#include "noveltea/core/runtime_messages.hpp"

#include <catch2/catch_test_macros.hpp>
#include <array>
#include <type_traits>

using namespace noveltea::core;

namespace {
template<class... Fs> struct Overload : Fs... {
    using Fs::operator()...;
};
template<class... Fs> Overload(Fs...) -> Overload<Fs...>;

template<class Id>
constexpr bool is_strong_session_id =
    !std::is_default_constructible_v<Id> && std::is_trivially_copyable_v<Id>;
} // namespace

TEST_CASE("presentation and checkpoint identities are strong domain types")
{
    STATIC_REQUIRE(is_strong_session_id<PresentationOperationId>);
    STATIC_REQUIRE(is_strong_session_id<AudioOperationId>);
    STATIC_REQUIRE(is_strong_session_id<HostRequestId>);
    STATIC_REQUIRE(is_strong_session_id<PresentationSnapshotRevision>);
    STATIC_REQUIRE(is_strong_session_id<PresentationOperationSequence>);
    STATIC_REQUIRE(is_strong_session_id<MountedLayoutInstanceId>);
    STATIC_REQUIRE(is_strong_session_id<CheckpointBarrierId>);
    STATIC_REQUIRE(is_strong_session_id<CheckpointStatusRevision>);
    STATIC_REQUIRE(is_strong_session_id<CheckpointReadinessRevision>);
    STATIC_REQUIRE(is_strong_session_id<SaveCheckpointRevision>);
    STATIC_REQUIRE(!std::is_convertible_v<PresentationOperationId, AudioOperationId>);
    STATIC_REQUIRE(!std::is_convertible_v<CheckpointBarrierId, SaveCheckpointRevision>);
    CHECK(PresentationSnapshotRevision::from_number(7).number() == 7);
}

TEST_CASE("closed presentation contract vocabularies have their frozen alternatives")
{
    STATIC_REQUIRE(std::variant_size_v<PresentationOperationRef> == 2);
    STATIC_REQUIRE(std::variant_size_v<PresentationCompletionTarget> == 4);
    STATIC_REQUIRE(std::variant_size_v<PresentationOperationState> == 6);
    STATIC_REQUIRE(std::variant_size_v<CheckpointBarrierSource> == 6);
    STATIC_REQUIRE(std::variant_size_v<CheckpointSaveRequest> == 3);
    STATIC_REQUIRE(std::variant_size_v<CheckpointSaveOutcome> == 3);

    constexpr std::array checkpoint_classes{CheckpointClass::Reconstructible,
                                            CheckpointClass::CausalBarrier,
                                            CheckpointClass::Disposable};
    constexpr std::array planes{PresentationPlane::WorldBackground, PresentationPlane::WorldContent,
                                PresentationPlane::WorldOverlay,    PresentationPlane::GameUi,
                                PresentationPlane::MenuOverlay,     PresentationPlane::Modal,
                                PresentationPlane::Transition,      PresentationPlane::Debug};
    constexpr std::array readiness_reasons{
        CheckpointReadinessReason::RuntimeTransactionActive,
        CheckpointReadinessReason::RuntimeQueueUnsettled,
        CheckpointReadinessReason::FlowStateNotSerializable,
        CheckpointReadinessReason::ImmediateScriptInvocationActive,
        CheckpointReadinessReason::SuspendedScriptInvocationActive,
        CheckpointReadinessReason::HostRequestPending,
        CheckpointReadinessReason::PresentationBarrierActive,
        CheckpointReadinessReason::ReconstructibleStateInvalid,
        CheckpointReadinessReason::SaveProjectionFailed,
        CheckpointReadinessReason::SaveValidationFailed,
        CheckpointReadinessReason::SaveEncodingFailed};
    STATIC_REQUIRE(checkpoint_classes.size() == 3);
    STATIC_REQUIRE(planes.size() == 8);
    STATIC_REQUIRE(readiness_reasons.size() == 11);

    PresentationOperationRef operation = PresentationOperationId::from_number(1);
    CHECK(std::visit(Overload{[](PresentationOperationId) { return 0; },
                              [](AudioOperationId) { return 1; }},
                     operation) == 0);

    PresentationCompletionTarget completion = NoPresentationCompletion{};
    CHECK(std::visit(Overload{[](const NoPresentationCompletion&) { return 0; },
                              [](const PresentationFlowCompletion&) { return 1; },
                              [](const AudioFlowCompletion&) { return 2; },
                              [](const ScriptAudioCompletion&) { return 3; }},
                     completion) == 0);

    PresentationOperationState state = PresentationOperationAccepted{};
    CHECK(std::visit(Overload{[](const PresentationOperationAccepted&) { return 0; },
                              [](const PresentationOperationRunning&) { return 1; },
                              [](const PresentationOperationCompleted&) { return 2; },
                              [](const PresentationOperationCancelled&) { return 3; },
                              [](const PresentationOperationReplaced&) { return 4; },
                              [](const PresentationOperationFailed&) { return 5; }},
                     state) == 0);

    CheckpointBarrierSource source = RuntimeTransactionBarrierSource{};
    CHECK(std::visit(Overload{[](const RuntimeTransactionBarrierSource&) { return 0; },
                              [](const RuntimeQueueBarrierSource&) { return 1; },
                              [](const FlowCheckpointBarrierSource&) { return 2; },
                              [](const ScriptCheckpointBarrierSource&) { return 3; },
                              [](const HostRequestCheckpointBarrierSource&) { return 4; },
                              [](const PresentationCheckpointBarrierSource&) { return 5; }},
                     source) == 0);

    CheckpointSaveRequest request = DeferredAutosaveRequest{};
    const auto request_kind =
        std::visit(Overload{[](const ManualSaveRequest&) { return 0; },
                            [](const DeferredAutosaveRequest&) { return 1; },
                            [](const ImmediateRetainedCheckpointWriteRequest&) { return 2; }},
                   request);
    CHECK(request_kind == 1);

    CheckpointSaveOutcome outcome = DeferredAutosaveQueued{};
    CHECK(std::visit(Overload{[](const CheckpointWriteSucceeded&) { return 0; },
                              [](const DeferredAutosaveQueued&) { return 1; },
                              [](const CheckpointSaveFailed&) { return 2; }},
                     outcome) == 1);
}

TEST_CASE("mounted Layout policy dimensions represent independent lifecycle choices")
{
    const MountedLayoutPolicy pausing{
        .plane = PresentationPlane::MenuOverlay,
        .clock = LayoutClockDomain::UnscaledPresentation,
        .input = LayoutInputMode::BlockGameplay,
        .gameplay_pause = GameplayPausePolicy::PauseWhileVisible,
        .visibility = LayoutVisibility::Visible,
        .escape_dismissal = EscapeDismissalPolicy::Dismiss,
    };
    const MountedLayoutPolicy non_pausing{
        .plane = PresentationPlane::MenuOverlay,
        .clock = LayoutClockDomain::UnscaledPresentation,
        .input = LayoutInputMode::BlockGameplay,
        .gameplay_pause = GameplayPausePolicy::Continue,
        .visibility = LayoutVisibility::Visible,
        .escape_dismissal = EscapeDismissalPolicy::Dismiss,
    };

    CHECK(pausing.input == non_pausing.input);
    CHECK(pausing.clock == non_pausing.clock);
    CHECK(pausing.gameplay_pause != non_pausing.gameplay_pause);
    STATIC_REQUIRE(!std::is_same_v<LayoutClockDomain, GameplayPausePolicy>);
    STATIC_REQUIRE(!std::is_same_v<LayoutInputMode, EscapeDismissalPolicy>);
}

TEST_CASE("checkpoint values are backend-neutral owned values")
{
    STATIC_REQUIRE(!std::is_pointer_v<decltype(LatestSaveCheckpoint::encoded_save)>);
    STATIC_REQUIRE(!std::is_pointer_v<decltype(LatestSaveCheckpoint::metadata)>);
    STATIC_REQUIRE(!std::is_pointer_v<decltype(PresentationCheckpointStatus::active_barriers)>);
    STATIC_REQUIRE(!std::is_constructible_v<CheckpointSaveRequest, CheckpointBarrier>);
    STATIC_REQUIRE(!std::is_constructible_v<CheckpointBarrierSource, ManualSaveRequest>);

    const CheckpointReadinessStatus ready{.revision = CheckpointReadinessRevision::from_number(1),
                                          .issues = {}};
    CHECK(ready.can_capture());
}
