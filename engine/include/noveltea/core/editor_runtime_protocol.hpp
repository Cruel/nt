#pragma once

#include "noveltea/core/editor_protocol.hpp"
#include "noveltea/core/editor_preview_contracts.hpp"
#include "noveltea/core/runtime_messages.hpp"
#include "noveltea/runtime/runtime_contracts.hpp"

#include <cstddef>
#include <string>
#include <string_view>
#include <variant>
#include <vector>

#include <nlohmann/json.hpp>

namespace noveltea::core::editor {

enum class TypedPlaybackExpectationKind : std::uint8_t {
    Property,
    CurrentRoom,
    Location,
    Quantity,
    Trait,
    EntityState,
    ActiveFlow,
    Layout,
    Event,
    Diagnostic,
};

enum class TypedPlaybackExpectationOperator : std::uint8_t {
    Equal,
    NotEqual,
    Present,
    Absent,
    Greater,
    GreaterEqual,
    Less,
    LessEqual,
};

struct TypedPlaybackExpectation {
    std::string id;
    TypedPlaybackExpectationKind kind = TypedPlaybackExpectationKind::CurrentRoom;
    TypedPlaybackExpectationOperator op = TypedPlaybackExpectationOperator::Equal;
    nlohmann::json fields = nlohmann::json::object();
};

struct TypedPlaybackUiClickInput {
    std::string document_id;
    std::string selector;
};

using TypedPlaybackInput = std::variant<RuntimeInputMessage, TypedPlaybackUiClickInput>;

struct TypedPlaybackStep {
    std::uint64_t index = 0;
    TypedPlaybackInput input;
    std::vector<TypedPlaybackExpectation> expectations;
};

struct TypedPlaybackSpec {
    std::string id;
    std::vector<TypedPlaybackStep> steps;
    std::vector<TypedPlaybackExpectation> final_expectations;
};

struct TypedPlaybackExpectationReport {
    std::string id;
    bool passed = false;
    std::string message;
};

struct TypedPlaybackStepReport {
    std::uint64_t index = 0;
    bool handled = false;
    std::vector<runtime::RuntimeEvent> events;
    Diagnostics diagnostics;
    std::vector<TypedPlaybackExpectationReport> expectations;
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
[[nodiscard]] Result<std::vector<InteractionSubjectBinding>, Diagnostics>
decode_editor_interaction_bindings_text(std::string_view text,
                                        const EditorRuntimeProtocolLimits& limits = {});

[[nodiscard]] Result<TypedEditorPreviewDocument, Diagnostics>
decode_editor_preview_document_text(std::string_view kind, std::string_view data_text,
                                    const EditorRuntimeProtocolLimits& limits = {});

[[nodiscard]] Result<FocusedEditorDocumentRequest, Diagnostics>
decode_focused_editor_document_request_text(std::string_view request_text,
                                            const FocusedEditorDocumentLimits& limits = {});

[[nodiscard]] Result<TypedEditorRoomPreviewDocument, Diagnostics>
decode_editor_room_preview_document_text(std::string_view data_text,
                                         const FocusedEditorDocumentLimits& limits = {});

[[nodiscard]] Result<TypedPlaybackSpec, Diagnostics>
decode_editor_playback(const nlohmann::json& document,
                       const EditorRuntimeProtocolLimits& limits = {});
[[nodiscard]] Result<TypedPlaybackSpec, Diagnostics>
decode_editor_playback_text(std::string_view text, const EditorRuntimeProtocolLimits& limits = {});

[[nodiscard]] nlohmann::json
encode_editor_playback_report(std::string_view id,
                              const std::vector<TypedPlaybackStepReport>& steps,
                              const std::vector<TypedPlaybackExpectationReport>& final_expectations,
                              const runtime::RuntimePublication& final_publication, bool passed);
[[nodiscard]] std::string encode_editor_playback_report_text(
    std::string_view id, const std::vector<TypedPlaybackStepReport>& steps,
    const std::vector<TypedPlaybackExpectationReport>& final_expectations,
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
