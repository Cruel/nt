#include "host/screenshot_capture.hpp"

#include <catch2/catch_test_macros.hpp>

#include <optional>
#include <string>
#include <utility>

namespace noveltea::host {
namespace {

class FakeScreenshotCaptureBackend final : public ScreenshotCaptureBackend {
public:
    [[nodiscard]] bool request_capture(std::uint64_t request_id) override
    {
        if (!accept_requests || requested_id)
            return false;
        requested_id = request_id;
        return true;
    }

    [[nodiscard]] std::optional<ScreenshotCapture> take_capture() override
    {
        if (!completed)
            return std::nullopt;
        auto result = std::move(completed);
        completed.reset();
        requested_id.reset();
        return result;
    }

    void complete(std::uint32_t width = 640, std::uint32_t height = 360,
                  std::string png_bytes = "\x89PNG\r\n\x1a\nfixture")
    {
        REQUIRE(requested_id);
        completed = ScreenshotCapture{*requested_id, width, height, std::move(png_bytes)};
    }

    bool accept_requests = true;
    std::optional<std::uint64_t> requested_id;
    std::optional<ScreenshotCapture> completed;
};

core::CheckpointThumbnailCaptureRequest
capture_request(std::uint64_t token, std::uint64_t checkpoint, std::uint64_t presentation)
{
    return {token, core::SaveCheckpointRevision::from_number(checkpoint),
            core::PresentationSnapshotRevision::from_number(presentation)};
}

CheckpointThumbnailCaptureContext capture_context(std::uint64_t generation,
                                                  core::CheckpointThumbnailCaptureRequest request,
                                                  std::uint64_t displayed_presentation,
                                                  bool visual_operation_active = false)
{
    return {
        .host_generation = *HostGeneration::from_number(generation),
        .pending_request = request,
        .displayed_presentation =
            core::PresentationSnapshotRevision::from_number(displayed_presentation),
        .visual_operation_active = visual_operation_active,
    };
}

TEST_CASE("checkpoint screenshot capture starts only from the matching stable rendered revision")
{
    FakeScreenshotCaptureBackend backend;
    CheckpointThumbnailCaptureCoordinator coordinator(backend);
    const auto request = capture_request(3, 5, 7);

    CHECK_FALSE(coordinator.request_if_ready(capture_context(1, request, 6)));
    CHECK_FALSE(coordinator.request_if_ready(capture_context(1, request, 7, true)));
    CHECK_FALSE(backend.requested_id);

    REQUIRE(coordinator.request_if_ready(capture_context(1, request, 7)));
    REQUIRE(backend.requested_id);
    CHECK(*backend.requested_id == 1);
    CHECK(coordinator.capture_in_flight());
}

TEST_CASE("checkpoint screenshot completion does not hold presentation state stable")
{
    FakeScreenshotCaptureBackend backend;
    CheckpointThumbnailCaptureCoordinator coordinator(backend);
    const auto request = capture_request(11, 4, 9);
    REQUIRE(coordinator.request_if_ready(capture_context(2, request, 9)));
    backend.complete(320, 180, "\x89PNG\r\n\x1a\ncompleted-later");

    auto completed = coordinator.take_completed(capture_context(2, request, 10, true));
    REQUIRE(completed);
    CHECK(completed->request == request);
    CHECK(completed->thumbnail.encoding == core::SaveCheckpointThumbnailEncoding::Png);
    CHECK(completed->thumbnail.width == 320);
    CHECK(completed->thumbnail.height == 180);
    CHECK(completed->thumbnail.bytes == "\x89PNG\r\n\x1a\ncompleted-later");
    CHECK_FALSE(coordinator.capture_in_flight());
}

TEST_CASE("stale checkpoint screenshot completion is drained and never attached")
{
    FakeScreenshotCaptureBackend backend;
    CheckpointThumbnailCaptureCoordinator coordinator(backend);
    const auto stale_request = capture_request(21, 1, 3);
    REQUIRE(coordinator.request_if_ready(capture_context(1, stale_request, 3)));
    backend.complete();

    const auto replacement_request = capture_request(22, 2, 4);
    CHECK_FALSE(coordinator.take_completed(capture_context(2, replacement_request, 4)));
    CHECK_FALSE(coordinator.capture_in_flight());
    CHECK_FALSE(backend.requested_id);

    REQUIRE(coordinator.request_if_ready(capture_context(2, replacement_request, 4)));
    REQUIRE(backend.requested_id);
    CHECK(*backend.requested_id == 2);
}

TEST_CASE("backend rejection leaves checkpoint capture optional and retryable")
{
    FakeScreenshotCaptureBackend backend;
    backend.accept_requests = false;
    CheckpointThumbnailCaptureCoordinator coordinator(backend);
    const auto request = capture_request(31, 8, 12);

    CHECK_FALSE(coordinator.request_if_ready(capture_context(4, request, 12)));
    CHECK_FALSE(coordinator.capture_in_flight());

    backend.accept_requests = true;
    CHECK(coordinator.request_if_ready(capture_context(4, request, 12)));
}

} // namespace
} // namespace noveltea::host
