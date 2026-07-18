#pragma once

#include "noveltea/core/editor_protocol.hpp"
#include "noveltea/core/editor_preview_contracts.hpp"
#include "noveltea/core/runtime_messages.hpp"
#include "noveltea/runtime/runtime_contracts.hpp"

#include <cstddef>
#include <string>
#include <string_view>
#include <vector>

#include <nlohmann/json.hpp>

namespace noveltea::core::editor {

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

[[nodiscard]] Result<RuntimeValue, Diagnostics>
decode_editor_runtime_value_text(std::string_view text,
                                 const EditorRuntimeProtocolLimits& limits = {});

[[nodiscard]] Result<std::vector<compiled::InteractionSubject>, Diagnostics>
decode_editor_interaction_subjects_text(std::string_view text,
                                        const EditorRuntimeProtocolLimits& limits = {});

[[nodiscard]] Result<TypedEditorPreviewDocument, Diagnostics>
decode_editor_preview_document_text(std::string_view kind, std::string_view data_text,
                                    const EditorRuntimeProtocolLimits& limits = {});

[[nodiscard]] Result<TypedPlaybackSpec, Diagnostics>
decode_editor_playback(const nlohmann::json& document,
                       const EditorRuntimeProtocolLimits& limits = {});
[[nodiscard]] Result<TypedPlaybackSpec, Diagnostics>
decode_editor_playback_text(std::string_view text, const EditorRuntimeProtocolLimits& limits = {});

[[nodiscard]] nlohmann::json
encode_editor_playback_report(std::string_view id,
                              const std::vector<TypedPlaybackStepReport>& steps,
                              const runtime::RuntimePublication& final_publication, bool passed);
[[nodiscard]] std::string encode_editor_playback_report_text(
    std::string_view id, const std::vector<TypedPlaybackStepReport>& steps,
    const runtime::RuntimePublication& final_publication, bool passed);

[[nodiscard]] nlohmann::json
encode_editor_debug_snapshot(const runtime::RuntimePublication& publication,
                             const std::vector<runtime::RuntimeEvent>& events,
                             const Diagnostics& diagnostics, bool preview_running);
[[nodiscard]] std::string
encode_editor_debug_snapshot_text(const runtime::RuntimePublication& publication,
                                  const std::vector<runtime::RuntimeEvent>& events,
                                  const Diagnostics& diagnostics, bool preview_running);

} // namespace noveltea::core::editor
