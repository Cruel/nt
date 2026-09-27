#include "noveltea/devtools_console.hpp"

#include <algorithm>

namespace noveltea::devtools {

ConsoleBuffer::ConsoleBuffer(std::size_t capacity) : m_capacity(std::max<std::size_t>(capacity, 1))
{
    m_records.reserve(m_capacity);
}

void ConsoleBuffer::set_generations(std::optional<std::uint64_t> host_generation,
                                    std::optional<std::uint64_t> runtime_generation)
{
    const auto previous_runtime_generation = m_runtime_generation;
    m_host_generation = host_generation;
    m_runtime_generation = runtime_generation;
    if (runtime_generation == previous_runtime_generation)
        return;

    std::string message;
    if (runtime_generation) {
        message = "Runtime generation " + std::to_string(*runtime_generation) + " started";
        if (previous_runtime_generation)
            message += " (replacing " + std::to_string(*previous_runtime_generation) + ")";
        message += '.';
    } else if (previous_runtime_generation) {
        message = "Runtime generation " + std::to_string(*previous_runtime_generation) + " ended.";
    } else {
        return;
    }
    append_record({.host_generation = m_host_generation,
                   .runtime_generation = m_runtime_generation,
                   .severity = ConsoleSeverity::Info,
                   .category = "runtime",
                   .message = std::move(message),
                   .source = std::nullopt,
                   .generation_marker = true});
}

void ConsoleBuffer::append(ConsoleSeverity severity, std::string category, std::string message,
                           std::optional<ConsoleSource> source)
{
    append_record({.host_generation = m_host_generation,
                   .runtime_generation = m_runtime_generation,
                   .severity = severity,
                   .category = std::move(category),
                   .message = std::move(message),
                   .source = std::move(source),
                   .generation_marker = false});
}

void ConsoleBuffer::append_record(ConsoleRecord record)
{
    record.sequence = m_next_sequence++;
    if (m_records.size() == m_capacity)
        m_records.erase(m_records.begin());
    m_records.push_back(std::move(record));
}

ConsoleDelta ConsoleBuffer::delta_after(std::uint64_t after_sequence) const
{
    ConsoleDelta result;
    result.after_sequence = after_sequence;
    result.latest_sequence = latest_sequence();
    result.earliest_retained_sequence =
        m_records.empty() ? m_next_sequence : m_records.front().sequence;
    const std::uint64_t expected_next =
        after_sequence == UINT64_MAX ? UINT64_MAX : after_sequence + 1;
    if (!m_records.empty() && expected_next < result.earliest_retained_sequence) {
        result.history_gap = true;
        result.lost_record_count = result.earliest_retained_sequence - expected_next;
    }
    for (const auto& record : m_records) {
        if (record.sequence > after_sequence)
            result.records.push_back(record);
    }
    return result;
}

void ConsoleBuffer::clear() noexcept { m_records.clear(); }

std::string_view console_severity_name(ConsoleSeverity severity) noexcept
{
    switch (severity) {
    case ConsoleSeverity::Info:
        return "info";
    case ConsoleSeverity::Warning:
        return "warning";
    case ConsoleSeverity::Error:
        return "error";
    }
    return "info";
}

} // namespace noveltea::devtools
