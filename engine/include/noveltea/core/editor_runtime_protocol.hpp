#pragma once

#include "noveltea/core/diagnostic.hpp"
#include "noveltea/core/result.hpp"
#include "noveltea/core/runtime_messages.hpp"
#include "noveltea/runtime/runtime_contracts.hpp"

#include <cstddef>
#include <string>
#include <string_view>
#include <vector>

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

struct TypedPlaybackStep {
    std::uint64_t index = 0;
    RuntimeInputMessage input;
};

struct TypedPlaybackSpec {
    std::string id;
    std::vector<TypedPlaybackStep> steps;
};

struct TypedPlaybackStepReport {
    std::uint64_t index = 0;
    bool handled = false;
    std::vector<runtime::RuntimeEvent> events;
    Diagnostics diagnostics;
};

[[nodiscard]] Result<RuntimeInputMessage, Diagnostics>
decode_editor_runtime_input(const nlohmann::json& document,
                            const EditorRuntimeProtocolLimits& limits = {});
[[nodiscard]] Result<RuntimeInputMessage, Diagnostics>
decode_editor_runtime_input_text(std::string_view text,
                                 const EditorRuntimeProtocolLimits& limits = {});

[[nodiscard]] Result<TypedPlaybackSpec, Diagnostics>
decode_editor_playback(const nlohmann::json& document,
                       const EditorRuntimeProtocolLimits& limits = {});
[[nodiscard]] Result<TypedPlaybackSpec, Diagnostics>
decode_editor_playback_text(std::string_view text, const EditorRuntimeProtocolLimits& limits = {});

[[nodiscard]] nlohmann::json
encode_editor_playback_report(std::string_view id,
                              const std::vector<TypedPlaybackStepReport>& steps,
                              const TypedRuntimeUIViewState& final_view, bool passed);
[[nodiscard]] std::string
encode_editor_playback_report_text(std::string_view id,
                                   const std::vector<TypedPlaybackStepReport>& steps,
                                   const TypedRuntimeUIViewState& final_view, bool passed);

[[nodiscard]] nlohmann::json
encode_editor_debug_snapshot(const TypedRuntimeUIViewState& view,
                             const std::vector<runtime::RuntimeEvent>& events,
                             const Diagnostics& diagnostics, bool preview_running);
[[nodiscard]] std::string
encode_editor_debug_snapshot_text(const TypedRuntimeUIViewState& view,
                                  const std::vector<runtime::RuntimeEvent>& events,
                                  const Diagnostics& diagnostics, bool preview_running);

} // namespace noveltea::core::editor
