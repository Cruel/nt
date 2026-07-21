#pragma once

#include "host/host_lifecycle_contracts.hpp"
#include "host/runtime_host_contracts.hpp"

#include "noveltea/audio/audio_types.hpp"
#include "noveltea/render/material.hpp"
#include "noveltea/surface.hpp"

#include <cstdint>
#include <optional>
#include <string>
#include <variant>

namespace noveltea::host {

struct PreviewRequestIdTag;
using PreviewRequestId = runtime::RuntimeMonotonicId<PreviewRequestIdTag>;

enum class PreviewLayoutKind : std::uint8_t {
    Document,
    Fragment,
};

struct PreviewLayoutDocumentRequest {
    PreviewLayoutKind layout_kind = PreviewLayoutKind::Document;
    std::string rml;
    std::string rcss;
    std::string lua;
    bool script_enabled = false;
    std::string fragment_host_rml;
    std::string fragment_host_rcss;
};

struct PreviewShaderDocumentRequest {
    ShaderMaterialProject shader_materials;
    MaterialId preview_material;
    ShaderId shader;
    std::string rml;
    std::string rcss;
};

struct PreviewLoadProjectRequest {
    std::string logical_path;
};

struct PreviewRuntimeInputRequest {
    core::RuntimeInputMessage input;
};

struct PreviewExecuteScriptRequest {
    std::string source;
    std::string chunk_name = "editor_preview.lua";
};

struct PreviewFastForwardRequest {};
struct PreviewDebugSnapshotRequest {};

struct PreviewScreenshotRequest {
    std::string output_path;
};

struct PreviewPlaySfxRequest {
    std::string logical_path;
    float volume = 1.0f;
    float pitch = 1.0f;
};

struct PreviewPlayTrackRequest {
    AudioTrackId track;
    std::string logical_path;
    float volume = 1.0f;
    bool loop = true;
};

struct PreviewStopTrackRequest {
    AudioTrackId track;
    float fade_seconds = 0.0f;
};

using PreviewRequestPayload =
    std::variant<PreviewLayoutDocumentRequest, PreviewShaderDocumentRequest,
                 PreviewLoadProjectRequest, PreviewRuntimeInputRequest, PreviewExecuteScriptRequest,
                 PreviewFastForwardRequest, PreviewDebugSnapshotRequest, PreviewScreenshotRequest,
                 PreviewPlaySfxRequest, PreviewPlayTrackRequest, PreviewStopTrackRequest>;

struct PreviewRequest {
    PreviewRequestId request;
    HostGeneration host_generation;
    PreviewRequestPayload payload;
};

enum class PreviewRequestDisposition : std::uint8_t {
    Applied,
    Deferred,
    Rejected,
    Failed,
};

struct PreviewTextResult {
    std::string text;
};

struct PreviewCaptureQueuedResult {
    std::uint64_t capture_request = 0;
};

using PreviewResultPayload = std::variant<std::monostate, HostRuntimeDispatchResult,
                                          PreviewTextResult, PreviewCaptureQueuedResult>;

struct PreviewResult {
    PreviewRequestId request;
    PreviewRequestDisposition disposition = PreviewRequestDisposition::Failed;
    PreviewResultPayload payload;
    core::Diagnostics diagnostics;

    [[nodiscard]] bool accepted() const noexcept
    {
        return disposition == PreviewRequestDisposition::Applied ||
               disposition == PreviewRequestDisposition::Deferred;
    }
};

class PreviewRequestSink {
public:
    virtual ~PreviewRequestSink() = default;

    [[nodiscard]] virtual PreviewResult submit_preview_request(PreviewRequest request) = 0;
};

} // namespace noveltea::host
