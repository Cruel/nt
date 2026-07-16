#include "noveltea/runtime/runtime_capabilities.hpp"
#include "noveltea/runtime/runtime_commands.hpp"
#include "noveltea/runtime/runtime_contracts.hpp"
#include "noveltea/runtime/runtime_ports.hpp"

#include <catch2/catch_test_macros.hpp>

#include <array>
#include <limits>
#include <type_traits>

namespace noveltea::runtime {
class RuntimeCommandGateway {};

namespace {

class FakeScriptInvocationPort final : public ScriptInvocationPort {
public:
    [[nodiscard]] core::Result<ScriptInvocationOutcome, ScriptInvocationError>
    invoke(const ScriptInvocationRequest&, const RuntimeCapabilitySet&) override
    {
        return core::Result<ScriptInvocationOutcome, ScriptInvocationError>::success(
            ScriptInvocationCompleted{});
    }

    [[nodiscard]] core::Result<ScriptInvocationOutcome, ScriptInvocationError>
    resume(const core::ScriptInvocationHandle&, const RuntimeCapabilitySet&) override
    {
        return core::Result<ScriptInvocationOutcome, ScriptInvocationError>::failure(
            {.code = ScriptInvocationErrorCode::StaleInvocation,
             .message = "stale test invocation",
             .chunk = "runtime-contract-test",
             .traceback = "runtime-contract-test:1: stale test invocation"});
    }

    void cancel(const core::ScriptInvocationHandle&, ScriptCancellationReason) override {}
    void invalidate_capabilities(CapabilityGeneration) noexcept override {}
};

class FakePresentationRuntimePort final : public PresentationRuntimePort {
public:
    [[nodiscard]] core::Result<PresentationAcceptance, core::Diagnostics>
    accept(const core::PresentationOperation&) override
    {
        return core::Result<PresentationAcceptance, core::Diagnostics>::success({true});
    }

    [[nodiscard]] core::Result<PresentationAcceptance, core::Diagnostics>
    accept(const core::AudioOperation&) override
    {
        return core::Result<PresentationAcceptance, core::Diagnostics>::success({true});
    }

    [[nodiscard]] const core::PresentationCheckpointStatus&
    checkpoint_status() const noexcept override
    {
        return m_status;
    }

    void terminate(core::PresentationCancellationReason) override {}

private:
    core::PresentationCheckpointStatus m_status{core::CheckpointStatusRevision::from_number(1), {}};
};

class FakeExternalRequestSink final : public ExternalRequestSink {
public:
    void cancel_all(RuntimeCancellationReason reason) override { last_reason = reason; }

    std::optional<RuntimeCancellationReason> last_reason;
};

TEST_CASE("runtime publication revisions reject zero and never wrap")
{
    CHECK_FALSE(RuntimePublicationRevision::from_number(0).has_value());
    const auto first = RuntimePublicationRevision::from_number(1);
    REQUIRE(first.has_value());
    REQUIRE(first->next().has_value());
    CHECK(first->next()->number() == 2);

    const auto maximum =
        RuntimePublicationRevision::from_number(std::numeric_limits<std::uint64_t>::max());
    REQUIRE(maximum.has_value());
    CHECK_FALSE(maximum->next().has_value());

    RuntimePublication publication{
        .revision = *first, .gameplay_ui = {}, .presentation = {}, .observations = {}};
    RuntimeDispatchResult result{.disposition = RuntimeInputDisposition::Handled,
                                 .publication = publication};
    REQUIRE(result.publication.has_value());
    CHECK(result.publication->revision == *first);
}

TEST_CASE("runtime contract vocabularies are closed typed variants")
{
    STATIC_REQUIRE(std::variant_size_v<RuntimeEvent> == 3);
    STATIC_REQUIRE(std::variant_size_v<DeferredRuntimeCommandPayload> == 10);
    STATIC_REQUIRE(std::variant_size_v<ScriptInvocationOutcome> == 2);

    const RuntimeBudgetConfiguration budget;
    CHECK(budget.instruction_limit > 0);
    CHECK(budget.command_limit > 0);
    const RuntimeBudgetOutcome yielded{.kind = RuntimeBudgetOutcomeKind::Yielded,
                                       .exhausted = RuntimeBudgetKind::Instruction,
                                       .consumed = budget.instruction_limit};
    CHECK(yielded.exhausted == RuntimeBudgetKind::Instruction);
}

TEST_CASE("mutation impacts coalesce and can be merged")
{
    MutationImpactJournal journal;
    journal.record(MutationImpact::StructuralStateChanged);
    journal.record(MutationImpact::StructuralStateChanged);
    CHECK(journal.contains(MutationImpact::StructuralStateChanged));

    MutationImpactJournal other;
    other.record(MutationImpact::PresentationInvalidated);
    journal.merge(other);
    CHECK(journal.contains(MutationImpact::PresentationInvalidated));
    CHECK_FALSE(journal.contains(MutationImpact::TimeStateChanged));
}

TEST_CASE("runtime command identities and external request lifecycles are terminal once")
{
    CHECK_FALSE(RuntimeCommandSequence::from_number(0).has_value());
    CHECK_FALSE(ExternalRequestId::from_number(0).has_value());

    ExternalRequestLifecycle request(*ExternalRequestId::from_number(1), {},
                                     ExternalRequestCheckpointPolicy::Barrier);
    CHECK(request.state() == ExternalRequestState::Pending);
    CHECK(request.succeed());
    CHECK_FALSE(request.fail());
    CHECK_FALSE(request.cancel(RuntimeCancellationReason::RuntimeReset));
    CHECK(request.state() == ExternalRequestState::Succeeded);
    CHECK_FALSE(request.cancellation_reason().has_value());

    ExternalRequestLifecycle cancelled(*ExternalRequestId::from_number(2), {},
                                       ExternalRequestCheckpointPolicy::NonBlocking);
    CHECK(cancelled.cancel(RuntimeCancellationReason::ProjectReload));
    CHECK(cancelled.state() == ExternalRequestState::Cancelled);
    CHECK(cancelled.cancellation_reason() == RuntimeCancellationReason::ProjectReload);
}

TEST_CASE("deferred runtime commands preserve assigned FIFO identity and source context")
{
    DeferredRuntimeCommandQueue queue;
    const RuntimeSourceContext source{};
    const auto first = queue.enqueue({source, RequestAutosaveCommand{}});
    const auto second = queue.enqueue({source, RequestAutosaveCommand{}});
    REQUIRE(first);
    REQUIRE(second);
    CHECK(first.value().number() == 1);
    CHECK(second.value().number() == 2);
    CHECK(queue.size() == 2);

    const auto first_command = queue.pop_front();
    const auto second_command = queue.pop_front();
    REQUIRE(first_command);
    REQUIRE(second_command);
    CHECK(first_command->sequence == first.value());
    CHECK(second_command->sequence == second.value());
    CHECK(first_command->source == source);
    CHECK(second_command->source == source);
    CHECK(queue.empty());
    CHECK_FALSE(queue.pop_front().has_value());
}

TEST_CASE("capability profiles are closed engine-selected values")
{
    constexpr std::array profiles{
        RuntimeCapabilityProfile::GameplayScript,   RuntimeCapabilityProfile::SynchronousExpression,
        RuntimeCapabilityProfile::RoomComposition,  RuntimeCapabilityProfile::GameplayLayoutEvent,
        RuntimeCapabilityProfile::ShellLayoutEvent, RuntimeCapabilityProfile::Tooling,
    };
    for (const auto profile : profiles) {
        CHECK(is_valid(profile));
        CHECK(describe(profile).profile == profile);
    }

    const auto invalid = static_cast<RuntimeCapabilityProfile>(255);
    CHECK_FALSE(is_valid(invalid));

    const auto gameplay = describe(RuntimeCapabilityProfile::GameplayScript);
    CHECK(gameplay.may_yield);
    CHECK((gameplay.command_groups & capability_bit(RuntimeCapabilityGroup::Flow)) != 0);

    const auto expression = describe(RuntimeCapabilityProfile::SynchronousExpression);
    CHECK_FALSE(expression.may_yield);
    CHECK(expression.command_groups == 0);
    CHECK((expression.query_groups & capability_bit(RuntimeCapabilityGroup::Variables)) != 0);

    const auto composition = describe(RuntimeCapabilityProfile::RoomComposition);
    CHECK(composition.admits_room_composition_draft);
    CHECK(composition.command_groups == 0);

    const auto shell = describe(RuntimeCapabilityProfile::ShellLayoutEvent);
    CHECK((shell.command_groups & capability_bit(RuntimeCapabilityGroup::Game)) != 0);
    CHECK((shell.command_groups & capability_bit(RuntimeCapabilityGroup::Variables)) == 0);
}

TEST_CASE("capability sets are lightweight non-owning query and command views")
{
    STATIC_REQUIRE(std::is_trivially_copyable_v<RuntimeQueryCapabilities>);
    STATIC_REQUIRE(std::is_trivially_copyable_v<RuntimeCommandCapabilities>);
    STATIC_REQUIRE(std::is_trivially_copyable_v<RuntimeCapabilitySet>);
    STATIC_REQUIRE(!std::is_polymorphic_v<RuntimeCapabilitySet>);
    STATIC_REQUIRE(!std::is_aggregate_v<RuntimeCapabilitySet>);
    STATIC_REQUIRE(!std::is_constructible_v<RuntimeQueryCapabilities, RuntimeCommandGateway&,
                                            std::uint64_t, CapabilityGeneration>);
    STATIC_REQUIRE(!std::is_constructible_v<RuntimeCommandCapabilities, RuntimeCommandGateway&,
                                            std::uint64_t, CapabilityGeneration>);

    RuntimeCommandGateway gateway;
    const auto generation = *CapabilityGeneration::from_number(3);
    RuntimeCapabilityIssuer issuer(gateway, generation);
    const auto capabilities = issuer.issue(RuntimeCapabilityProfile::GameplayScript);
    REQUIRE(capabilities.has_value());

    CHECK(capabilities->profile() == RuntimeCapabilityProfile::GameplayScript);
    CHECK(capabilities->generation() == generation);
    CHECK(capabilities->can_query(RuntimeCapabilityGroup::Room));
    CHECK(capabilities->can_query(RuntimeCapabilityGroup::Flow));
    CHECK(capabilities->can_command(RuntimeCapabilityGroup::Flow));
    CHECK(capabilities->can_command(RuntimeCapabilityGroup::Room));
    CHECK(capabilities->room_composition_draft() == nullptr);

    const auto shell = issuer.issue(RuntimeCapabilityProfile::ShellLayoutEvent);
    REQUIRE(shell.has_value());
    CHECK(shell->can_command(RuntimeCapabilityGroup::Save));
    CHECK_FALSE(shell->can_command(RuntimeCapabilityGroup::Variables));

    CHECK_FALSE(issuer.issue(RuntimeCapabilityProfile::RoomComposition).has_value());
    CHECK_FALSE(issuer.issue(static_cast<RuntimeCapabilityProfile>(255)).has_value());
    RoomCompositionDraftAccess draft;
    const auto composition = issuer.issue_room_composition(draft);
    CHECK(composition.profile() == RuntimeCapabilityProfile::RoomComposition);
    CHECK(composition.room_composition_draft() == &draft);
    CHECK_FALSE(composition.can_command(RuntimeCapabilityGroup::Variables));
    CHECK_FALSE(composition.can_query(RuntimeCapabilityGroup::Random));
    draft.close();
    CHECK(composition.room_composition_draft() == nullptr);
}

TEST_CASE("runtime ports expose no backend ownership in their contracts")
{
    STATIC_REQUIRE(std::is_abstract_v<ScriptInvocationPort>);
    STATIC_REQUIRE(std::is_abstract_v<PresentationRuntimePort>);
    STATIC_REQUIRE(std::is_abstract_v<ExternalRequestSink>);
    STATIC_REQUIRE(std::has_virtual_destructor_v<ScriptInvocationPort>);
    STATIC_REQUIRE(std::has_virtual_destructor_v<PresentationRuntimePort>);

    FakeScriptInvocationPort scripts;
    FakePresentationRuntimePort presentation;
    FakeExternalRequestSink external_requests;
    CHECK(presentation.checkpoint_status().active_barriers.empty());
    external_requests.cancel_all(RuntimeCancellationReason::CheckpointLoad);
    CHECK(external_requests.last_reason == RuntimeCancellationReason::CheckpointLoad);

    RuntimeCommandGateway gateway;
    RuntimeCapabilityIssuer issuer(gateway, *CapabilityGeneration::from_number(1));
    const auto capabilities = issuer.issue(RuntimeCapabilityProfile::GameplayScript);
    REQUIRE(capabilities.has_value());
    const auto invocation = scripts.invoke({}, *capabilities);
    REQUIRE(invocation.has_value());
    CHECK(std::holds_alternative<ScriptInvocationCompleted>(invocation.value()));

    const auto handle = core::ScriptInvocationHandle::create(1);
    REQUIRE(handle.has_value());
    const auto resumed = scripts.resume(handle.value(), *capabilities);
    REQUIRE_FALSE(resumed.has_value());
    CHECK(resumed.error().code == ScriptInvocationErrorCode::StaleInvocation);
    CHECK(resumed.error().message == "stale test invocation");
    CHECK(resumed.error().chunk == "runtime-contract-test");
    CHECK(resumed.error().traceback == "runtime-contract-test:1: stale test invocation");
}

} // namespace
} // namespace noveltea::runtime
