#include "noveltea/devtools_trace.hpp"

#include <algorithm>
#include <limits>

namespace noveltea::devtools {

TraceBuffer::TraceBuffer(std::size_t capacity) : m_capacity(std::max<std::size_t>(capacity, 1))
{
    m_records.reserve(m_capacity);
}

void TraceBuffer::set_generations(std::optional<std::uint64_t> host_generation,
                                  std::optional<std::uint64_t> runtime_generation,
                                  std::uint64_t frame)
{
    const auto previous_runtime_generation = m_runtime_generation;
    m_host_generation = host_generation;
    m_runtime_generation = runtime_generation;
    if (runtime_generation == previous_runtime_generation)
        return;

    std::string detail;
    if (runtime_generation) {
        detail = "Runtime generation " + std::to_string(*runtime_generation) + " started";
        if (previous_runtime_generation)
            detail += " (replacing " + std::to_string(*previous_runtime_generation) + ")";
        detail += '.';
    } else if (previous_runtime_generation) {
        detail = "Runtime generation " + std::to_string(*previous_runtime_generation) + " ended.";
    } else {
        return;
    }
    append_record({.host_generation = m_host_generation,
                   .runtime_generation = m_runtime_generation,
                   .kind = TraceRecordKind::Generation,
                   .category = "runtime",
                   .repeat_count = 1,
                   .first_frame = frame,
                   .last_frame = frame,
                   .input = std::nullopt,
                   .detail = std::move(detail),
                   .generation_marker = true});
}

void TraceBuffer::append_input(TraceInputRouting input, std::uint64_t frame)
{
    if (try_coalesce_input(input, frame))
        return;
    append_record({.host_generation = m_host_generation,
                   .runtime_generation = m_runtime_generation,
                   .kind = TraceRecordKind::InputRouting,
                   .category = "input",
                   .repeat_count = 1,
                   .first_frame = frame,
                   .last_frame = frame,
                   .input = std::move(input),
                   .detail = {},
                   .generation_marker = false});
}

void TraceBuffer::append_debugger_mutation(std::string detail, std::uint64_t frame)
{
    append_record({.host_generation = m_host_generation,
                   .runtime_generation = m_runtime_generation,
                   .kind = TraceRecordKind::DebuggerMutation,
                   .category = "debugger",
                   .repeat_count = 1,
                   .first_frame = frame,
                   .last_frame = frame,
                   .input = std::nullopt,
                   .detail = std::move(detail),
                   .generation_marker = false});
}

bool TraceBuffer::try_coalesce_input(const TraceInputRouting& input, std::uint64_t frame)
{
    if (m_records.empty())
        return false;
    auto& previous = m_records.back();
    if (previous.kind != TraceRecordKind::InputRouting ||
        previous.host_generation != m_host_generation ||
        previous.runtime_generation != m_runtime_generation || !previous.input)
        return false;

    auto previous_semantic = *previous.input;
    auto input_semantic = input;
    const bool motion = input.event == "mouse-motion" || input.event == "touch-motion";
    if (motion && previous_semantic.event == input.event) {
        previous_semantic.host_x.reset();
        previous_semantic.host_y.reset();
        previous_semantic.reference_x.reset();
        previous_semantic.reference_y.reset();
        input_semantic.host_x.reset();
        input_semantic.host_y.reset();
        input_semantic.reference_x.reset();
        input_semantic.reference_y.reset();
    }
    if (previous_semantic != input_semantic)
        return false;

    previous.sequence = m_next_sequence++;
    ++previous.repeat_count;
    previous.last_frame = frame;
    previous.input = input;
    return true;
}

void TraceBuffer::append_record(TraceRecord record)
{
    record.sequence = m_next_sequence++;
    record.first_sequence = record.sequence;
    if (m_records.size() == m_capacity) {
        m_records.erase(m_records.begin());
        ++m_evicted_record_count;
    }
    m_records.push_back(std::move(record));
}

TraceDelta TraceBuffer::delta_after(std::uint64_t after_sequence) const
{
    TraceDelta result;
    result.after_sequence = after_sequence;
    result.latest_sequence = latest_sequence();
    result.earliest_retained_sequence =
        m_records.empty() ? m_next_sequence : m_records.front().first_sequence;
    const auto expected_next = after_sequence == std::numeric_limits<std::uint64_t>::max()
                                   ? after_sequence
                                   : after_sequence + 1;
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

void TraceBuffer::clear() noexcept
{
    m_records.clear();
    m_evicted_record_count = 0;
}

const char* trace_record_kind_name(TraceRecordKind kind) noexcept
{
    switch (kind) {
    case TraceRecordKind::InputRouting:
        return "input-routing";
    case TraceRecordKind::DebuggerMutation:
        return "debugger-mutation";
    case TraceRecordKind::Generation:
        return "generation";
    }
    return "input-routing";
}

} // namespace noveltea::devtools
