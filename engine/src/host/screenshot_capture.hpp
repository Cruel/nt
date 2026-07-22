#pragma once

#include "host/host_lifecycle_contracts.hpp"

#include "noveltea/core/checkpoint_contracts.hpp"

#include <cstdint>
#include <optional>
#include <string>

namespace noveltea {

class Renderer;

namespace host {

struct ScreenshotCapture {
    std::uint64_t request_id = 0;
    std::uint32_t width = 0;
    std::uint32_t height = 0;
    std::string png_bytes;
};

class ScreenshotCaptureBackend {
public:
    virtual ~ScreenshotCaptureBackend() = default;

    [[nodiscard]] virtual bool request_capture(std::uint64_t request_id) = 0;
    [[nodiscard]] virtual std::optional<ScreenshotCapture> take_capture() = 0;
    [[nodiscard]] virtual bool capture_pending() const noexcept = 0;
};

class RendererScreenshotCaptureBackend final : public ScreenshotCaptureBackend {
public:
    explicit RendererScreenshotCaptureBackend(Renderer& renderer) noexcept;

    [[nodiscard]] bool request_capture(std::uint64_t request_id) override;
    [[nodiscard]] std::optional<ScreenshotCapture> take_capture() override;
    [[nodiscard]] bool capture_pending() const noexcept override;

private:
    Renderer& m_renderer;
};

struct CheckpointThumbnailCaptureContext {
    std::optional<HostGeneration> host_generation;
    std::optional<core::CheckpointThumbnailCaptureRequest> pending_request;
    std::optional<core::PresentationSnapshotRevision> displayed_presentation;
    bool visual_operation_active = false;
};

struct CompletedCheckpointThumbnailCapture {
    core::CheckpointThumbnailCaptureRequest request;
    core::SaveCheckpointThumbnail thumbnail;
};

class CheckpointThumbnailCaptureCoordinator final {
public:
    explicit CheckpointThumbnailCaptureCoordinator(ScreenshotCaptureBackend& backend) noexcept;

    [[nodiscard]] bool request_if_ready(const CheckpointThumbnailCaptureContext& context);
    [[nodiscard]] std::optional<CompletedCheckpointThumbnailCapture>
    take_completed(const CheckpointThumbnailCaptureContext& context);
    void reset() noexcept;

    [[nodiscard]] bool capture_in_flight() const noexcept { return m_in_flight.has_value(); }

private:
    struct CaptureBinding {
        HostGeneration host_generation;
        core::CheckpointThumbnailCaptureRequest request;
    };

    struct InFlightCapture {
        std::uint64_t renderer_request = 0;
        std::optional<CaptureBinding> binding;
    };

    [[nodiscard]] bool binding_is_current(const CaptureBinding& binding,
                                          const CheckpointThumbnailCaptureContext& context) const;
    void advance_request_id() noexcept;

    ScreenshotCaptureBackend& m_backend;
    std::optional<InFlightCapture> m_in_flight;
    std::uint64_t m_next_request_id = 1;
};

} // namespace host
} // namespace noveltea
