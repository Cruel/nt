#pragma once

#include "host/host_lifecycle_contracts.hpp"

#include "noveltea/core/checkpoint_contracts.hpp"

#include <cstdint>
#include <memory>
#include <optional>
#include <string>

namespace noveltea {

class Renderer;

namespace jobs {
class JobExecutor;
}

namespace host {

enum class ScreenshotSizingMode : std::uint8_t {
    Native,
    Fit,
    Fill,
    Exact,
};

struct ScreenshotSizing {
    ScreenshotSizingMode mode = ScreenshotSizingMode::Native;
    std::uint32_t width = 0;
    std::uint32_t height = 0;
};

struct ScreenshotRequestOptions {
    ScreenshotSizing sizing{};
    int png_compression_level = 6;
    bool require_next_frame = false;
};

struct ScreenshotCapture {
    std::uint64_t request_id = 0;
    std::uint32_t width = 0;
    std::uint32_t height = 0;
    std::string png_bytes;
};

class ScreenshotCaptureBackend {
public:
    virtual ~ScreenshotCaptureBackend() = default;

    [[nodiscard]] virtual std::optional<std::uint64_t>
    request_capture(ScreenshotRequestOptions options) = 0;
    [[nodiscard]] virtual std::optional<ScreenshotCapture>
    take_capture(std::uint64_t request_id) = 0;
    [[nodiscard]] virtual bool capture_pending(std::uint64_t request_id) const noexcept = 0;
    virtual void cancel_capture(std::uint64_t request_id) noexcept = 0;
};

class ScreenshotService final : public ScreenshotCaptureBackend {
public:
    ScreenshotService(Renderer& renderer, jobs::JobExecutor& jobs);
    ~ScreenshotService() override;

    ScreenshotService(const ScreenshotService&) = delete;
    ScreenshotService& operator=(const ScreenshotService&) = delete;

    [[nodiscard]] std::optional<std::uint64_t>
    request_capture(ScreenshotRequestOptions options = {}) override;
    [[nodiscard]] std::optional<std::uint64_t> request_file(std::string path,
                                                            ScreenshotRequestOptions options = {});
    [[nodiscard]] std::optional<ScreenshotCapture> take_capture(std::uint64_t request_id) override;
    [[nodiscard]] bool capture_pending(std::uint64_t request_id) const noexcept override;
    [[nodiscard]] bool has_pending_requests() const noexcept;
    void cancel_capture(std::uint64_t request_id) noexcept override;
    void poll();
    void reset() noexcept;

private:
    struct Impl;
    std::unique_ptr<Impl> m_impl;
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
    [[nodiscard]] std::optional<core::CheckpointThumbnailCaptureRequest>
    stale_pending_request(const CheckpointThumbnailCaptureContext& context) const noexcept;

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

    ScreenshotCaptureBackend& m_backend;
    std::optional<InFlightCapture> m_in_flight;
};

} // namespace host
} // namespace noveltea
