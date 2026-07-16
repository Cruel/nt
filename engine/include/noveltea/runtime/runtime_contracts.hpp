#pragma once

#include "noveltea/core/diagnostic.hpp"
#include "noveltea/core/feature_view.hpp"
#include "noveltea/core/runtime_messages.hpp"
#include "noveltea/core/runtime_presentation.hpp"
#include "noveltea/runtime/runtime_identity.hpp"

#include <compare>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <variant>
#include <vector>

namespace noveltea::runtime {

enum class RuntimeInputDisposition : std::uint8_t {
    Handled,
    Unhandled,
    Failed
};

struct RuntimePublicationRevisionTag;
using RuntimePublicationRevision = RuntimeMonotonicId<RuntimePublicationRevisionTag>;

struct RuntimeObservationSnapshot {
    std::vector<core::RuntimeObservation> values;
    bool operator==(const RuntimeObservationSnapshot&) const = default;
};

struct RuntimePublication {
    RuntimePublicationRevision revision;
    core::TypedRuntimeUIViewState gameplay_ui;
    core::RuntimePresentationSnapshot presentation;
    RuntimeObservationSnapshot observations;
};

struct NotificationEvent {
    std::string message;
    bool operator==(const NotificationEvent&) const = default;
};

struct SaveOutcomeEvent {
    core::SaveOutcome outcome;
    bool operator==(const SaveOutcomeEvent&) const = default;
};

struct ObservationEvent {
    core::RuntimeObservation observation;
    bool operator==(const ObservationEvent&) const = default;
};

using RuntimeEvent = std::variant<NotificationEvent, SaveOutcomeEvent, ObservationEvent>;

struct RuntimeDispatchResult {
    RuntimeInputDisposition disposition = RuntimeInputDisposition::Unhandled;
    std::optional<RuntimePublication> publication;
    std::vector<RuntimeEvent> events;
    core::Diagnostics diagnostics;
};

enum class MutationImpact : std::uint8_t {
    StructuralStateChanged,
    TimeStateChanged,
    GameplayUiInvalidated,
    PresentationInvalidated,
    CheckpointReadinessInvalidated,
    ObservationInvalidated,
    Count
};

class MutationImpactJournal {
public:
    void record(MutationImpact impact) noexcept
    {
        m_bits |= std::uint64_t{1} << static_cast<std::uint8_t>(impact);
    }

    [[nodiscard]] bool contains(MutationImpact impact) const noexcept
    {
        return (m_bits & (std::uint64_t{1} << static_cast<std::uint8_t>(impact))) != 0;
    }

    [[nodiscard]] bool empty() const noexcept { return m_bits == 0; }
    [[nodiscard]] std::uint64_t bits() const noexcept { return m_bits; }
    void clear() noexcept { m_bits = 0; }

    void merge(const MutationImpactJournal& other) noexcept { m_bits |= other.m_bits; }

    auto operator<=>(const MutationImpactJournal&) const = default;

private:
    static_assert(static_cast<std::uint8_t>(MutationImpact::Count) <= 64);
    std::uint64_t m_bits = 0;
};

struct RuntimeBudgetConfiguration {
    std::size_t instruction_limit = 100'000;
    std::size_t command_limit = 4'096;
    auto operator<=>(const RuntimeBudgetConfiguration&) const = default;
};

enum class RuntimeBudgetKind : std::uint8_t {
    Instruction,
    Command
};

enum class RuntimeBudgetOutcomeKind : std::uint8_t {
    WithinBudget,
    Yielded,
    CycleRejected,
    Faulted
};

struct RuntimeBudgetOutcome {
    RuntimeBudgetOutcomeKind kind = RuntimeBudgetOutcomeKind::WithinBudget;
    std::optional<RuntimeBudgetKind> exhausted;
    std::size_t consumed = 0;
    auto operator<=>(const RuntimeBudgetOutcome&) const = default;
};

} // namespace noveltea::runtime
