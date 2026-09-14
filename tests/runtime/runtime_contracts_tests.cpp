#include "noveltea/core/compiled_project_codec.hpp"
#include "noveltea/runtime/runtime_capabilities.hpp"
#include "noveltea/runtime/runtime_command_gateway.hpp"
#include "noveltea/runtime/runtime_commands.hpp"
#include "noveltea/runtime/runtime_contracts.hpp"

#include <catch2/catch_test_macros.hpp>
#include <nlohmann/json.hpp>

#include <array>
#include <fstream>
#include <limits>
#include <type_traits>

namespace noveltea::runtime {
namespace {

core::CompiledProject load_project()
{
    std::ifstream input(std::string(NOVELTEA_SOURCE_DIR) +
                        "/editor/src/renderer/test/fixtures/compiled-project-golden/minimal.json");
    REQUIRE(input.good());
    auto document = nlohmann::json::parse(input, nullptr, false);
    REQUIRE_FALSE(document.is_discarded());
    auto project = core::decode_compiled_project(document, "runtime-contract-test");
    REQUIRE(project);
    return std::move(project).value();
}

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
    CHECK(journal.contains(MutationImpact::StructuralStateChanged));
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
    REQUIRE(request.succeed());
    CHECK_FALSE(request.succeed());
    CHECK_FALSE(request.fail());
    CHECK_FALSE(request.cancel(RuntimeCancellationReason::RuntimeReset));
    CHECK(request.state() == ExternalRequestState::Succeeded);
    CHECK_FALSE(request.cancellation_reason().has_value());

    ExternalRequestLifecycle cancelled(*ExternalRequestId::from_number(2), {},
                                       ExternalRequestCheckpointPolicy::NonBlocking);
    REQUIRE(cancelled.cancel(RuntimeCancellationReason::ProjectReload));
    CHECK_FALSE(cancelled.succeed());
    CHECK_FALSE(cancelled.fail());
    CHECK_FALSE(cancelled.cancel(RuntimeCancellationReason::RuntimeReset));
    CHECK(cancelled.state() == ExternalRequestState::Cancelled);
    CHECK(cancelled.cancellation_reason() == RuntimeCancellationReason::ProjectReload);

    ExternalRequestLifecycle failed(*ExternalRequestId::from_number(3), {},
                                    ExternalRequestCheckpointPolicy::Barrier);
    REQUIRE(failed.fail());
    CHECK_FALSE(failed.succeed());
    CHECK_FALSE(failed.fail());
    CHECK_FALSE(failed.cancel(RuntimeCancellationReason::RuntimeReset));
    CHECK(failed.state() == ExternalRequestState::Failed);
    CHECK_FALSE(failed.cancellation_reason());
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
        RuntimeCapabilityProfile::OnGameReady,
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
    CHECK((expression.query_groups & capability_bit(RuntimeCapabilityGroup::Properties)) != 0);

    const auto composition = describe(RuntimeCapabilityProfile::RoomComposition);
    CHECK(composition.admits_room_composition_draft);
    CHECK(composition.command_groups == 0);

    const auto shell = describe(RuntimeCapabilityProfile::ShellLayoutEvent);
    CHECK((shell.command_groups & capability_bit(RuntimeCapabilityGroup::Game)) != 0);
    CHECK((shell.command_groups & capability_bit(RuntimeCapabilityGroup::Properties)) == 0);
    CHECK((shell.command_groups & capability_bit(RuntimeCapabilityGroup::Presentation)) == 0);
    CHECK_FALSE(shell.may_yield);

    const auto gameplay_layout = describe(RuntimeCapabilityProfile::GameplayLayoutEvent);
    CHECK((gameplay_layout.command_groups & capability_bit(RuntimeCapabilityGroup::Presentation)) !=
          0);
    CHECK((gameplay_layout.query_groups & capability_bit(RuntimeCapabilityGroup::Audio)) != 0);
    CHECK_FALSE(gameplay_layout.may_yield);

    const auto ready = describe(RuntimeCapabilityProfile::OnGameReady);
    CHECK_FALSE(ready.may_yield);
    CHECK(ready.command_groups == 0);
    CHECK((ready.query_groups & capability_bit(RuntimeCapabilityGroup::Properties)) != 0);
}

TEST_CASE("capability sets issue non-forgeable query and command authority")
{
    STATIC_REQUIRE(!std::is_aggregate_v<RuntimeCapabilitySet>);
    STATIC_REQUIRE(!std::is_constructible_v<RuntimeQueryCapabilities, RuntimeCommandGateway&,
                                            std::uint64_t, CapabilityGeneration>);
    STATIC_REQUIRE(!std::is_constructible_v<RuntimeCommandCapabilities, RuntimeCommandGateway&,
                                            std::uint64_t, CapabilityGeneration>);

    const auto project = load_project();
    auto created = core::SessionState::create(project);
    REQUIRE(created);
    auto state = std::move(created).value();
    RuntimeWorld world(project, state);
    const auto generation = *CapabilityGeneration::from_number(3);
    RuntimeCommandGateway gateway(project, state, world, generation);
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
    CHECK_FALSE(shell->can_command(RuntimeCapabilityGroup::Properties));
    CHECK_FALSE(shell->can_command(RuntimeCapabilityGroup::Presentation));

    const auto gameplay_layout = issuer.issue(RuntimeCapabilityProfile::GameplayLayoutEvent);
    REQUIRE(gameplay_layout.has_value());
    CHECK(gameplay_layout->can_query(RuntimeCapabilityGroup::Presentation));
    CHECK(gameplay_layout->can_command(RuntimeCapabilityGroup::Presentation));

    CHECK_FALSE(issuer.issue(RuntimeCapabilityProfile::RoomComposition).has_value());
    CHECK_FALSE(issuer.issue(static_cast<RuntimeCapabilityProfile>(255)).has_value());
    RoomCompositionDraftAccess draft;
    const auto composition = issuer.issue_room_composition(draft);
    CHECK(composition.profile() == RuntimeCapabilityProfile::RoomComposition);
    CHECK(composition.room_composition_draft() == &draft);
    CHECK_FALSE(composition.can_command(RuntimeCapabilityGroup::Properties));
    CHECK_FALSE(composition.can_query(RuntimeCapabilityGroup::Random));
    draft.close();
    CHECK(composition.room_composition_draft() == nullptr);
}

} // namespace
} // namespace noveltea::runtime
