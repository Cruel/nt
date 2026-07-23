#pragma once

#include "noveltea/core/diagnostic.hpp"

#include <cstdint>
#include <optional>
#include <string_view>

namespace noveltea::core {

enum class LoadingPhase : std::uint8_t {
    DownloadingPackage,
    VerifyingPackage,
    OpeningPackageIndex,
    LoadingStartupContent,
    LoadingRuntimeDemand,
};

enum class LoadingState : std::uint8_t {
    Active,
    Completed,
    Failed,
    Canceled,
};

struct LoadingOperationId {
    std::uint64_t value = 0;

    [[nodiscard]] constexpr bool valid() const noexcept { return value != 0; }
    friend constexpr bool operator==(LoadingOperationId, LoadingOperationId) = default;
};

struct LoadingProgress {
    LoadingOperationId operation;
    LoadingPhase phase = LoadingPhase::DownloadingPackage;
    LoadingState state = LoadingState::Active;
    std::uint64_t completed_units = 0;
    std::optional<std::uint64_t> total_units;
    bool retryable = false;
    Diagnostics diagnostics;

    [[nodiscard]] bool terminal() const noexcept
    {
        return state == LoadingState::Completed || state == LoadingState::Failed ||
               state == LoadingState::Canceled;
    }

    [[nodiscard]] bool valid() const noexcept
    {
        if (!operation.valid())
            return false;
        if (total_units && completed_units > *total_units)
            return false;
        return state != LoadingState::Failed || !diagnostics.empty();
    }
};

[[nodiscard]] constexpr std::string_view loading_phase_name(LoadingPhase phase) noexcept
{
    switch (phase) {
    case LoadingPhase::DownloadingPackage:
        return "DownloadingPackage";
    case LoadingPhase::VerifyingPackage:
        return "VerifyingPackage";
    case LoadingPhase::OpeningPackageIndex:
        return "OpeningPackageIndex";
    case LoadingPhase::LoadingStartupContent:
        return "LoadingStartupContent";
    case LoadingPhase::LoadingRuntimeDemand:
        return "LoadingRuntimeDemand";
    }
    return "DownloadingPackage";
}

[[nodiscard]] constexpr std::string_view loading_state_name(LoadingState state) noexcept
{
    switch (state) {
    case LoadingState::Active:
        return "Active";
    case LoadingState::Completed:
        return "Completed";
    case LoadingState::Failed:
        return "Failed";
    case LoadingState::Canceled:
        return "Canceled";
    }
    return "Active";
}

} // namespace noveltea::core
