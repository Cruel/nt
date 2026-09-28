#pragma once

#include "noveltea/devtools_sequence.hpp"

#include <cstddef>
#include <cstdint>
#include <optional>
#include <span>
#include <string>
#include <vector>

namespace noveltea::devtools {

struct TraceElementRef {
    std::string context;
    std::string document_id;
    std::string tag;
    std::string id;
    std::string classes;
    std::string pointer_events;

    bool operator==(const TraceElementRef&) const = default;
};

struct TraceInputRouting {
    std::string event;
    std::optional<float> host_x;
    std::optional<float> host_y;
    std::optional<float> reference_x;
    std::optional<float> reference_y;
    std::optional<std::uint8_t> mouse_button;
    std::optional<float> wheel_x;
    std::optional<float> wheel_y;
    bool reference_valid = false;
    bool debug_processed = false;
    bool debug_consumed = false;
    bool runtime_ui_processed = false;
    bool runtime_ui_consumed = false;
    bool runtime_ui_wants_pointer = false;
    bool gameplay_event = false;
    bool gameplay_admitted = false;
    std::string gameplay_block_reason;
    std::optional<std::string> governing_layout;
    std::string governing_layout_mode;
    std::optional<TraceElementRef> rmlui_hover;
    std::optional<TraceElementRef> rmlui_focus;
    bool world_evaluated = false;
    bool world_consumed = false;
    std::optional<std::string> world_hit;
    std::optional<std::string> world_hovered;
    std::optional<std::string> world_pressed;
    std::optional<std::string> world_target;

    bool operator==(const TraceInputRouting&) const = default;
};

enum class TraceRecordKind : std::uint8_t {
    InputRouting,
    DebuggerMutation,
    Generation,
};

struct TraceDebuggerMutation {
    std::string source_frontend;
    std::string operation;

    bool operator==(const TraceDebuggerMutation&) const = default;
};

struct TraceRecord {
    std::uint64_t sequence = 0;
    std::uint64_t first_sequence = 0;
    std::uint64_t global_sequence = 0;
    std::uint64_t first_global_sequence = 0;
    std::optional<std::uint64_t> host_generation;
    std::optional<std::uint64_t> runtime_generation;
    TraceRecordKind kind = TraceRecordKind::InputRouting;
    std::string category;
    std::uint32_t repeat_count = 1;
    std::uint64_t first_frame = 0;
    std::uint64_t last_frame = 0;
    std::optional<TraceInputRouting> input;
    std::optional<TraceDebuggerMutation> debugger_mutation;
    std::string detail;
    bool generation_marker = false;
};

struct TraceDelta {
    std::uint64_t after_sequence = 0;
    std::uint64_t earliest_retained_sequence = 0;
    std::uint64_t latest_sequence = 0;
    std::uint64_t lost_record_count = 0;
    bool history_gap = false;
    std::vector<TraceRecord> records;
};

class TraceBuffer final {
public:
    explicit TraceBuffer(std::size_t capacity = 2000, SequenceAllocator* sequence = nullptr);

    void set_generations(std::optional<std::uint64_t> host_generation,
                         std::optional<std::uint64_t> runtime_generation, std::uint64_t frame);
    void append_input(TraceInputRouting input, std::uint64_t frame);
    void append_debugger_mutation(std::string source_frontend, std::string operation,
                                  std::uint64_t frame);
    [[nodiscard]] TraceDelta delta_after(std::uint64_t after_sequence) const;
    [[nodiscard]] std::span<const TraceRecord> records() const noexcept { return m_records; }
    [[nodiscard]] std::uint64_t latest_sequence() const noexcept { return m_next_sequence - 1; }
    [[nodiscard]] std::uint64_t evicted_record_count() const noexcept
    {
        return m_evicted_record_count;
    }
    void clear() noexcept;

private:
    void append_record(TraceRecord record);
    [[nodiscard]] bool try_coalesce_input(const TraceInputRouting& input, std::uint64_t frame);

    std::size_t m_capacity = 2000;
    std::uint64_t m_next_sequence = 1;
    SequenceAllocator* m_global_sequence = nullptr;
    std::optional<std::uint64_t> m_host_generation;
    std::optional<std::uint64_t> m_runtime_generation;
    std::vector<TraceRecord> m_records;
    std::uint64_t m_evicted_record_count = 0;
};

[[nodiscard]] const char* trace_record_kind_name(TraceRecordKind kind) noexcept;

} // namespace noveltea::devtools
