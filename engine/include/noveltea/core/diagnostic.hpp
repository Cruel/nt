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
    std::string source_path;
    std::string json_pointer;
    std::vector<Diagnostic> causes;
    [[nodiscard]] Diagnostic with_context(std::string path, std::string pointer = {}) const
    {
        Diagnostic copy = *this;
        copy.source_path = std::move(path);
        copy.json_pointer = std::move(pointer);
        return copy;
    }
};
using Diagnostics = std::vector<Diagnostic>;
inline void append_diagnostics(Diagnostics& destination, Diagnostics source)
{
    destination.insert(destination.end(), std::make_move_iterator(source.begin()),
                       std::make_move_iterator(source.end()));
}
} // namespace noveltea::core
