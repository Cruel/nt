#pragma once
#include <cstdint>
#include <iterator>
#include <string>
#include <utility>
#include <vector>
namespace noveltea::core {
enum class ErrorSeverity : std::uint8_t {
    Info,
    Warning,
    Error,
    Fatal
};
struct Diagnostic {
    std::string code;
    std::string message;
    ErrorSeverity severity = ErrorSeverity::Error;
    std::string source_path{};
    std::string json_pointer{};
    std::vector<Diagnostic> causes{};
    [[nodiscard]] bool is_fatal() const noexcept { return severity == ErrorSeverity::Fatal; }
    [[nodiscard]] Diagnostic with_context(std::string path, std::string pointer = {}) const
    {
        Diagnostic copy = *this;
        copy.source_path = std::move(path);
        copy.json_pointer = std::move(pointer);
        return copy;
    }
    [[nodiscard]] Diagnostic caused_by(Diagnostic cause) const
    {
        Diagnostic copy = *this;
        copy.causes.push_back(std::move(cause));
        return copy;
    }
};
using Diagnostics = std::vector<Diagnostic>;
inline void append_diagnostics(Diagnostics& destination, Diagnostics source)
{
    destination.insert(destination.end(), std::make_move_iterator(source.begin()),
                       std::make_move_iterator(source.end()));
}
[[nodiscard]] inline bool has_fatal_diagnostic(const Diagnostics& diagnostics) noexcept
{
    for (const auto& diagnostic : diagnostics) {
        if (diagnostic.is_fatal()) {
            return true;
        }
    }
    return false;
}
} // namespace noveltea::core
