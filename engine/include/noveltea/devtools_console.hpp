#pragma once

#include "noveltea/devtools_sequence.hpp"

#include <cstddef>
#include <cstdint>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <vector>

namespace noveltea::devtools {

enum class ConsoleSeverity : std::uint8_t {
    Info,
    Warning,
    Error,
};

struct ConsoleSource {
    std::string chunk;
    std::optional<std::uint32_t> line;
};

struct ConsoleRecord {
    std::uint64_t sequence = 0;
    std::uint64_t global_sequence = 0;
    std::optional<std::uint64_t> host_generation;
    std::optional<std::uint64_t> runtime_generation;
    std::uint64_t frame = 0;
    ConsoleSeverity severity = ConsoleSeverity::Info;
    std::string category;
    std::string message;
    std::optional<ConsoleSource> source;
    bool generation_marker = false;
};

struct ConsoleDelta {
    std::uint64_t after_sequence = 0;
    std::uint64_t earliest_retained_sequence = 0;
    std::uint64_t latest_sequence = 0;
    std::uint64_t lost_record_count = 0;
    bool history_gap = false;
    std::vector<ConsoleRecord> records;
};

class ConsoleBuffer final {
public:
    explicit ConsoleBuffer(std::size_t capacity = 1000, SequenceAllocator* sequence = nullptr);

    void set_generations(std::optional<std::uint64_t> host_generation,
                         std::optional<std::uint64_t> runtime_generation, std::uint64_t frame = 0);
    void append(ConsoleSeverity severity, std::string category, std::string message,
                std::optional<ConsoleSource> source = std::nullopt, std::uint64_t frame = 0);
    void append_with_runtime_generation(ConsoleSeverity severity, std::string category,
                                        std::string message, std::optional<ConsoleSource> source,
                                        std::optional<std::uint64_t> runtime_generation,
                                        std::uint64_t frame = 0);
    [[nodiscard]] ConsoleDelta delta_after(std::uint64_t after_sequence) const;
    [[nodiscard]] std::span<const ConsoleRecord> records() const noexcept { return m_records; }
    [[nodiscard]] std::uint64_t latest_sequence() const noexcept { return m_next_sequence - 1; }
    void clear() noexcept;

private:
    void append_record(ConsoleRecord record);

    std::size_t m_capacity = 1000;
    std::uint64_t m_next_sequence = 1;
    SequenceAllocator* m_global_sequence = nullptr;
    std::optional<std::uint64_t> m_host_generation;
    std::optional<std::uint64_t> m_runtime_generation;
    std::vector<ConsoleRecord> m_records;
};

[[nodiscard]] std::string_view console_severity_name(ConsoleSeverity severity) noexcept;

} // namespace noveltea::devtools
