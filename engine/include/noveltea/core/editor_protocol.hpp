#pragma once

#include "noveltea/core/diagnostic.hpp"
#include "noveltea/core/result.hpp"

#include <cstddef>
#include <cstdint>
#include <string_view>

#include <nlohmann/json.hpp>

namespace noveltea::core::editor {

inline constexpr std::string_view runtime_input_schema = "noveltea.editor.runtime-input";
inline constexpr std::string_view playback_schema = "noveltea.editor.playback";
inline constexpr std::string_view playback_report_schema = "noveltea.editor.playback-report";
inline constexpr std::string_view debug_snapshot_schema = "noveltea.editor.debug-snapshot";
inline constexpr std::uint32_t editor_runtime_protocol_version = 1;

struct EditorRuntimeProtocolLimits {
    std::size_t max_document_bytes = 256 * 1024;
    std::size_t max_steps = 4096;
    std::size_t max_ids_per_input = 64;
    std::size_t max_string_bytes = 16 * 1024;
};

[[nodiscard]] Result<nlohmann::json, Diagnostics>
parse_editor_protocol_document(std::string_view text,
                               const EditorRuntimeProtocolLimits& limits = {});

} // namespace noveltea::core::editor
