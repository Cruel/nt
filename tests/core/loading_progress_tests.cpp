#include <catch2/catch_test_macros.hpp>

#include <noveltea/core/loading_progress.hpp>

using namespace noveltea::core;

TEST_CASE("loading progress uses the shared phase and state vocabulary")
{
    CHECK(loading_phase_name(LoadingPhase::DownloadingPackage) == "DownloadingPackage");
    CHECK(loading_phase_name(LoadingPhase::VerifyingPackage) == "VerifyingPackage");
    CHECK(loading_phase_name(LoadingPhase::OpeningPackageIndex) == "OpeningPackageIndex");
    CHECK(loading_phase_name(LoadingPhase::LoadingStartupContent) == "LoadingStartupContent");
    CHECK(loading_phase_name(LoadingPhase::LoadingRuntimeDemand) == "LoadingRuntimeDemand");
    CHECK(loading_state_name(LoadingState::Active) == "Active");
    CHECK(loading_state_name(LoadingState::Completed) == "Completed");
    CHECK(loading_state_name(LoadingState::Failed) == "Failed");
    CHECK(loading_state_name(LoadingState::Canceled) == "Canceled");
}

TEST_CASE("loading progress validates operation totals and terminal diagnostics")
{
    LoadingProgress indeterminate{
        .operation = {1}, .phase = LoadingPhase::DownloadingPackage, .completed_units = 128};
    CHECK(indeterminate.valid());
    CHECK_FALSE(indeterminate.total_units.has_value());
    CHECK_FALSE(indeterminate.terminal());

    auto invalid_operation = indeterminate;
    invalid_operation.operation = {};
    CHECK_FALSE(invalid_operation.valid());

    auto invalid_total = indeterminate;
    invalid_total.total_units = 64;
    CHECK_FALSE(invalid_total.valid());

    LoadingProgress failed{
        .operation = {2}, .phase = LoadingPhase::VerifyingPackage, .state = LoadingState::Failed};
    CHECK_FALSE(failed.valid());
    failed.diagnostics.push_back(
        {.code = "player.package_checksum", .message = "checksum mismatch"});
    CHECK(failed.valid());
    CHECK(failed.terminal());

    LoadingProgress canceled{.operation = {3},
                             .phase = LoadingPhase::DownloadingPackage,
                             .state = LoadingState::Canceled};
    CHECK(canceled.valid());
    CHECK(canceled.terminal());
}
