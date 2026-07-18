#include "host/screenshot_capture.hpp"

#include "noveltea/renderer.hpp"

#include <limits>
#include <utility>

namespace noveltea::host {

RendererScreenshotCaptureBackend::RendererScreenshotCaptureBackend(Renderer& renderer) noexcept
    : m_renderer(renderer)
{
}

bool RendererScreenshotCaptureBackend::request_capture(std::uint64_t request_id)
{
    return m_renderer.request_screenshot_capture(request_id);
}

std::optional<ScreenshotCapture> RendererScreenshotCaptureBackend::take_capture()
{
    auto capture = m_renderer.take_screenshot_capture();
    if (!capture)
        return std::nullopt;
    return ScreenshotCapture{capture->request_id, capture->width, capture->height,
                             std::move(capture->png_bytes)};
}

CheckpointThumbnailCaptureCoordinator::CheckpointThumbnailCaptureCoordinator(
    ScreenshotCaptureBackend& backend) noexcept
    : m_backend(backend)
{
}

bool CheckpointThumbnailCaptureCoordinator::request_if_ready(
    const CheckpointThumbnailCaptureContext& context)
{
    if (m_in_flight || m_next_request_id == 0 || !context.host_generation ||
        !context.pending_request || !context.displayed_presentation ||
        context.visual_operation_active ||
        *context.displayed_presentation != context.pending_request->presentation)
        return false;

    const auto request_id = m_next_request_id;
    if (!m_backend.request_capture(request_id))
        return false;

    m_in_flight = InFlightCapture{
        request_id, CaptureBinding{*context.host_generation, *context.pending_request}};
    advance_request_id();
    return true;
}

std::optional<CompletedCheckpointThumbnailCapture>
CheckpointThumbnailCaptureCoordinator::take_completed(
    const CheckpointThumbnailCaptureContext& context)
{
    if (!m_in_flight)
        return std::nullopt;

    if (m_in_flight->binding && !binding_is_current(*m_in_flight->binding, context))
        m_in_flight->binding.reset();

    auto capture = m_backend.take_capture();
    if (!capture)
        return std::nullopt;

    auto in_flight = std::move(*m_in_flight);
    m_in_flight.reset();
    if (capture->request_id != in_flight.renderer_request || !in_flight.binding)
        return std::nullopt;

    return CompletedCheckpointThumbnailCapture{
        in_flight.binding->request,
        core::SaveCheckpointThumbnail{core::SaveCheckpointThumbnailEncoding::Png, capture->width,
                                      capture->height, std::move(capture->png_bytes)}};
}

void CheckpointThumbnailCaptureCoordinator::reset() noexcept
{
    m_in_flight.reset();
    m_next_request_id = 1;
}

bool CheckpointThumbnailCaptureCoordinator::binding_is_current(
    const CaptureBinding& binding, const CheckpointThumbnailCaptureContext& context) const
{
    return context.host_generation && *context.host_generation == binding.host_generation &&
           context.pending_request && *context.pending_request == binding.request;
}

void CheckpointThumbnailCaptureCoordinator::advance_request_id() noexcept
{
    if (m_next_request_id == std::numeric_limits<std::uint64_t>::max())
        m_next_request_id = 0;
    else
        ++m_next_request_id;
}

} // namespace noveltea::host
