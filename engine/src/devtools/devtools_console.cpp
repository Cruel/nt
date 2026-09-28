#include "noveltea/devtools_console.hpp"

#include <algorithm>

namespace noveltea::devtools {
namespace {

std::string sanitize_utf8(std::string value)
{
    std::string output;
    output.reserve(value.size());
    constexpr char hex[] = "0123456789ABCDEF";
    const auto continuation = [](unsigned char byte) { return (byte & 0xC0u) == 0x80u; };
    for (std::size_t index = 0; index < value.size();) {
        const auto first = static_cast<unsigned char>(value[index]);
        std::size_t length = 0;
        bool valid = false;
        if (first <= 0x7Fu) {
            length = 1;
            valid = true;
        } else if (first >= 0xC2u && first <= 0xDFu && index + 1 < value.size()) {
            length = 2;
            valid = continuation(static_cast<unsigned char>(value[index + 1]));
        } else if (first >= 0xE0u && first <= 0xEFu && index + 2 < value.size()) {
            const auto second = static_cast<unsigned char>(value[index + 1]);
            const auto third = static_cast<unsigned char>(value[index + 2]);
            length = 3;
            valid = continuation(third) &&
                    ((first == 0xE0u && second >= 0xA0u && second <= 0xBFu) ||
                     (first == 0xEDu && second >= 0x80u && second <= 0x9Fu) ||
                     (((first >= 0xE1u && first <= 0xECu) || (first >= 0xEEu && first <= 0xEFu)) &&
                      continuation(second)));
        } else if (first >= 0xF0u && first <= 0xF4u && index + 3 < value.size()) {
            const auto second = static_cast<unsigned char>(value[index + 1]);
            length = 4;
            valid = continuation(static_cast<unsigned char>(value[index + 2])) &&
                    continuation(static_cast<unsigned char>(value[index + 3])) &&
                    ((first == 0xF0u && second >= 0x90u && second <= 0xBFu) ||
                     (first == 0xF4u && second >= 0x80u && second <= 0x8Fu) ||
                     (first >= 0xF1u && first <= 0xF3u && continuation(second)));
        }
        if (valid) {
            output.append(value, index, length);
            index += length;
            continue;
        }
        output += "\\x";
        output += hex[first >> 4u];
        output += hex[first & 0x0Fu];
        ++index;
    }
    return output;
}

void sanitize_record_strings(std::string& category, std::string& message,
                             std::optional<ConsoleSource>& source)
{
    category = sanitize_utf8(std::move(category));
    message = sanitize_utf8(std::move(message));
    if (source)
        source->chunk = sanitize_utf8(std::move(source->chunk));
}

} // namespace

ConsoleBuffer::ConsoleBuffer(std::size_t capacity, SequenceAllocator* sequence)
    : m_capacity(std::max<std::size_t>(capacity, 1)), m_global_sequence(sequence)
{
    m_records.reserve(m_capacity);
}

void ConsoleBuffer::set_generations(std::optional<std::uint64_t> host_generation,
                                    std::optional<std::uint64_t> runtime_generation,
                                    std::uint64_t frame)
{
    const auto previous_host_generation = m_host_generation;
    const auto previous_runtime_generation = m_runtime_generation;
    m_host_generation = host_generation;
    m_runtime_generation = runtime_generation;
    if (host_generation == previous_host_generation &&
        runtime_generation == previous_runtime_generation)
        return;

    std::string message;
    if (host_generation != previous_host_generation) {
        message = "Host generation ";
        message += host_generation ? std::to_string(*host_generation) : "none";
        if (previous_host_generation)
            message += " replaced " + std::to_string(*previous_host_generation);
        message += '.';
    }
    if (runtime_generation != previous_runtime_generation && runtime_generation) {
        if (!message.empty())
            message += ' ';
        message += "Runtime generation " + std::to_string(*runtime_generation) + " started";
        if (previous_runtime_generation)
            message += " (replacing " + std::to_string(*previous_runtime_generation) + ")";
        message += '.';
    } else if (runtime_generation != previous_runtime_generation && previous_runtime_generation) {
        if (!message.empty())
            message += ' ';
        message += "Runtime generation " + std::to_string(*previous_runtime_generation) + " ended.";
    }
    if (message.empty())
        return;
    append_record({.host_generation = m_host_generation,
                   .runtime_generation = m_runtime_generation,
                   .frame = frame,
                   .severity = ConsoleSeverity::Info,
                   .category = "runtime",
                   .message = std::move(message),
                   .source = std::nullopt,
                   .generation_marker = true});
}

void ConsoleBuffer::append(ConsoleSeverity severity, std::string category, std::string message,
                           std::optional<ConsoleSource> source, std::uint64_t frame)
{
    sanitize_record_strings(category, message, source);
    append_record({.host_generation = m_host_generation,
                   .runtime_generation = m_runtime_generation,
                   .frame = frame,
                   .severity = severity,
                   .category = std::move(category),
                   .message = std::move(message),
                   .source = std::move(source),
                   .generation_marker = false});
}

void ConsoleBuffer::append_with_runtime_generation(ConsoleSeverity severity, std::string category,
                                                   std::string message,
                                                   std::optional<ConsoleSource> source,
                                                   std::optional<std::uint64_t> runtime_generation,
                                                   std::uint64_t frame)
{
    sanitize_record_strings(category, message, source);
    append_record({.host_generation = m_host_generation,
                   .runtime_generation = runtime_generation,
                   .frame = frame,
                   .severity = severity,
                   .category = std::move(category),
                   .message = std::move(message),
                   .source = std::move(source),
                   .generation_marker = false});
}

void ConsoleBuffer::append_record(ConsoleRecord record)
{
    record.sequence = m_next_sequence++;
    record.global_sequence = m_global_sequence ? m_global_sequence->next() : record.sequence;
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
