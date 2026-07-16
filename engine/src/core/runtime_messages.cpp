#include "noveltea/core/runtime_messages.hpp"

#include <type_traits>

namespace noveltea::core {

namespace {

template<typename> inline constexpr bool always_false = false;

} // namespace

RuntimeMessageCategory category(const RuntimeOutputMessage& message) noexcept
{
    return std::visit(
        [](const auto& value) {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, RuntimeViewPublication>)
                return RuntimeMessageCategory::StatePublication;
            else if constexpr (std::is_same_v<T, PresentationOperation> ||
                               std::is_same_v<T, AudioOperation> ||
                               std::is_same_v<T, UserCommunicationOutput> ||
                               std::is_same_v<T, SaveOutcome>)
                return RuntimeMessageCategory::HostOperation;
            else if constexpr (std::is_same_v<T, RuntimeObservation>)
                return RuntimeMessageCategory::Observation;
            else if constexpr (std::is_same_v<T, Diagnostic>)
                return RuntimeMessageCategory::Diagnostic;
            else
                static_assert(always_false<T>, "Unhandled RuntimeOutputMessage alternative");
        },
        message);
}

RuntimeOutputKind output_kind(const RuntimeOutputMessage& message) noexcept
{
    return std::visit(
        [](const auto& value) {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, RuntimeViewPublication>)
                return RuntimeOutputKind::ViewPublication;
            else if constexpr (std::is_same_v<T, PresentationOperation>)
                return RuntimeOutputKind::PresentationOperation;
            else if constexpr (std::is_same_v<T, AudioOperation>)
                return RuntimeOutputKind::AudioOperation;
            else if constexpr (std::is_same_v<T, UserCommunicationOutput>)
                return RuntimeOutputKind::UserCommunication;
            else if constexpr (std::is_same_v<T, SaveOutcome>)
                return RuntimeOutputKind::SaveOutcome;
            else if constexpr (std::is_same_v<T, RuntimeObservation>)
                return RuntimeOutputKind::Observation;
            else if constexpr (std::is_same_v<T, Diagnostic>)
                return RuntimeOutputKind::Diagnostic;
            else
                static_assert(always_false<T>, "Unhandled RuntimeOutputMessage alternative");
        },
        message);
}

} // namespace noveltea::core
