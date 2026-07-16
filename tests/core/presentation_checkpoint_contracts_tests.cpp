#include "noveltea/core/checkpoint_contracts.hpp"
#include "noveltea/core/runtime_messages.hpp"

#include <catch2/catch_test_macros.hpp>
#include <array>
#include <filesystem>
#include <fstream>
#include <optional>
#include <string>
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

std::string read_source_file(const std::filesystem::path& path)
{
    std::ifstream input(path);
    REQUIRE(input.good());
    return {std::istreambuf_iterator<char>(input), std::istreambuf_iterator<char>()};
}

std::size_t occurrence_count(const std::string& source, const std::string& needle)
{
    std::size_t count = 0;
    std::size_t position = 0;
    while ((position = source.find(needle, position)) != std::string::npos) {
        ++count;
        position += needle.size();
    }
    return count;
}

template<class Enum, std::size_t Size> void check_closed_enum(const std::array<Enum, Size>& values)
{
    for (std::size_t index = 0; index < values.size(); ++index) {
        CHECK(static_cast<std::size_t>(values[index]) == index);
    }
}
} // namespace

TEST_CASE("presentation and checkpoint identities are strong domain types")
{
    STATIC_REQUIRE(is_strong_session_id<PresentationOperationId>);
    STATIC_REQUIRE(is_strong_session_id<AudioOperationId>);
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
    STATIC_REQUIRE(std::variant_size_v<CheckpointBarrierSource> == 5);
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
        CheckpointReadinessReason::PresentationBarrierActive,
        CheckpointReadinessReason::ReconstructibleStateInvalid,
        CheckpointReadinessReason::SaveProjectionFailed,
        CheckpointReadinessReason::SaveValidationFailed,
        CheckpointReadinessReason::SaveEncodingFailed};
    constexpr std::array layout_clocks{LayoutClockDomain::Gameplay,
                                       LayoutClockDomain::UnscaledPresentation};
    constexpr std::array layout_inputs{LayoutInputMode::None, LayoutInputMode::Normal,
                                       LayoutInputMode::BlockGameplay, LayoutInputMode::Modal};
    constexpr std::array pause_policies{GameplayPausePolicy::Continue,
                                        GameplayPausePolicy::PauseWhileVisible};
    constexpr std::array visibility{LayoutVisibility::Hidden, LayoutVisibility::Visible};
    constexpr std::array dismissal{EscapeDismissalPolicy::Ignore, EscapeDismissalPolicy::Dismiss};
    constexpr std::array mount_owners{MountedLayoutOwner::Gameplay, MountedLayoutOwner::Shell};
    constexpr std::array operation_owners{PresentationOperationOwner::GameplayRuntime,
                                          PresentationOperationOwner::Shell};
    constexpr std::array cancellation_reasons{PresentationCancellationReason::ExplicitRequest,
                                              PresentationCancellationReason::OwnerEnded,
                                              PresentationCancellationReason::FastForward,
                                              PresentationCancellationReason::RuntimeReset,
                                              PresentationCancellationReason::ProjectReload,
                                              PresentationCancellationReason::CheckpointLoad};
    constexpr std::array failure_domains{PresentationFailureDomain::WorldPresentation,
                                         PresentationFailureDomain::LayoutPresentation,
                                         PresentationFailureDomain::AudioPresentation};
    constexpr std::array queue_kinds{
        RuntimeQueueKind::Input, RuntimeQueueKind::Output, RuntimeQueueKind::ScriptInput,
        RuntimeQueueKind::DeferredCommand, RuntimeQueueKind::PresentationAcknowledgement};
    constexpr std::array barrier_kinds{CheckpointBarrierKind::RuntimeTransaction,
                                       CheckpointBarrierKind::UnsettledQueue,
                                       CheckpointBarrierKind::UnserializableFlow,
                                       CheckpointBarrierKind::ImmediateScriptInvocation,
                                       CheckpointBarrierKind::SuspendedScriptInvocation,
                                       CheckpointBarrierKind::PresentationCausalOperation,
                                       CheckpointBarrierKind::InvalidReconstructibleState};
    constexpr std::array write_sources{CheckpointWriteSource::CapturedCurrentState,
                                       CheckpointWriteSource::RetainedCheckpoint};
    constexpr std::array failure_stages{CheckpointSaveFailureStage::InvalidRequest,
                                        CheckpointSaveFailureStage::NoRetainedCheckpoint,
                                        CheckpointSaveFailureStage::Capture,
                                        CheckpointSaveFailureStage::SlotWrite};

    check_closed_enum(checkpoint_classes);
    check_closed_enum(planes);
    check_closed_enum(readiness_reasons);
    check_closed_enum(layout_clocks);
    check_closed_enum(layout_inputs);
    check_closed_enum(pause_policies);
    check_closed_enum(visibility);
    check_closed_enum(dismissal);
    check_closed_enum(mount_owners);
    check_closed_enum(operation_owners);
    check_closed_enum(cancellation_reasons);
    check_closed_enum(failure_domains);
    check_closed_enum(queue_kinds);
    check_closed_enum(barrier_kinds);
    check_closed_enum(write_sources);
    check_closed_enum(failure_stages);

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
                              [](const PresentationCheckpointBarrierSource&) { return 4; }},
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
    STATIC_REQUIRE(!std::is_constructible_v<MountedLayoutInstanceId, PresentationOperationId>);
    STATIC_REQUIRE(!std::is_constructible_v<MountedLayoutInstance, PresentationOperationId,
                                            LayoutId, MountedLayoutOwner, MountedLayoutPolicy>);
    STATIC_REQUIRE(
        !std::is_constructible_v<PresentationOperationMetadata, MountedLayoutInstanceId,
                                 PresentationOperationSequence, PresentationOperationOwner,
                                 CheckpointClass, PresentationCompletionTarget>);
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

TEST_CASE("shared contract headers enforce canonical definitions and dependency boundaries")
{
    const auto source_root = std::filesystem::path{NOVELTEA_SOURCE_DIR};
    const auto include_root = source_root / "engine/include";
    const std::array canonical_headers{include_root / "noveltea/core/session_operation_id.hpp",
                                       include_root / "noveltea/core/presentation_contracts.hpp",
                                       include_root / "noveltea/core/checkpoint_contracts.hpp"};

    std::string contracts;
    for (const auto& header : canonical_headers) {
        contracts += read_source_file(header);
    }

    const std::array forbidden_tokens{
        "nlohmann",  "json.hpp",     "RmlUi",        "Rml::",         "bgfx",
        "Renderer",  "AudioBackend", "miniaudio",    "std::function", "std::exception",
        "type_info", "typeid(",      "dynamic_cast", "std::any",      "unordered_map"};
    for (const auto& token : forbidden_tokens) {
        CAPTURE(token);
        CHECK(contracts.find(token) == std::string::npos);
    }

    std::string public_headers;
    for (const auto& entry :
         std::filesystem::recursive_directory_iterator(include_root / "noveltea")) {
        if (entry.is_regular_file() && entry.path().extension() == ".hpp") {
            public_headers += read_source_file(entry.path());
        }
    }
    CHECK(occurrence_count(public_headers, "using PresentationOperationId =") == 1);
    CHECK(occurrence_count(public_headers, "using AudioOperationId =") == 1);
    CHECK(occurrence_count(public_headers, "using HostRequestId =") == 0);
    CHECK(occurrence_count(public_headers, "using MountedLayoutInstanceId =") == 1);
    CHECK(occurrence_count(public_headers, "struct PresentationOperationTag;") == 1);
    CHECK(occurrence_count(public_headers, "struct MountedLayoutInstanceTag;") == 1);

    const auto runtime_messages =
        read_source_file(include_root / "noveltea/core/runtime_messages.hpp");
    CHECK(runtime_messages.find("noveltea/core/session_operation_id.hpp") != std::string::npos);
    CHECK(runtime_messages.find("using PresentationOperationId =") == std::string::npos);
    CHECK(runtime_messages.find("using AudioCompletionHandle =") == std::string::npos);
}
