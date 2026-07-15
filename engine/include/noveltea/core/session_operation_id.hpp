#pragma once

#include "noveltea/core/flow.hpp"

#include <compare>
#include <cstdint>
#include <variant>

namespace noveltea::core {

template<class Tag> class SessionOperationId {
public:
    SessionOperationId() = delete;
    [[nodiscard]] static constexpr SessionOperationId from_number(std::uint64_t value) noexcept
    {
        return SessionOperationId(value);
    }
    [[nodiscard]] constexpr std::uint64_t number() const noexcept { return m_value; }
    auto operator<=>(const SessionOperationId&) const = default;

private:
    explicit constexpr SessionOperationId(std::uint64_t value) noexcept : m_value(value) {}
    std::uint64_t m_value;
};

template<class Tag> class SessionSequence {
public:
    SessionSequence() = delete;
    [[nodiscard]] static constexpr SessionSequence from_number(std::uint64_t value) noexcept
    {
        return SessionSequence(value);
    }
    [[nodiscard]] constexpr std::uint64_t number() const noexcept { return m_value; }
    auto operator<=>(const SessionSequence&) const = default;

private:
    explicit constexpr SessionSequence(std::uint64_t value) noexcept : m_value(value) {}
    std::uint64_t m_value;
};

struct PresentationOperationTag;
struct AudioOperationTag;
struct HostRequestTag;
using PresentationOperationId = SessionOperationId<PresentationOperationTag>;
using AudioOperationId = SessionOperationId<AudioOperationTag>;
using HostRequestId = SessionOperationId<HostRequestTag>;
using AudioCompletionHandle = std::variant<AudioFlowBlockerHandle, ScriptInvocationHandle>;

} // namespace noveltea::core
