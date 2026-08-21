#include "host/screenshot_capture.hpp"

#include "noveltea/jobs/job_executor.hpp"
#include "noveltea/renderer.hpp"

#include <png.h>

#include <algorithm>
#include <cmath>
#include <cctype>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <limits>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace noveltea::host {
namespace {

constexpr std::uint32_t kThumbnailMaxWidth = 480;
constexpr std::uint32_t kThumbnailMaxHeight = 270;
constexpr std::size_t kFileWriteChunkSize = 256u * 1024u;

enum class ScreenshotDestinationKind : std::uint8_t {
    MemoryPng,
    FilePng,
    FilePpm,
};

enum class ScreenshotRequestState : std::uint8_t {
    Queued,
    GpuCapture,
    Encoding,
    Completed,
    Failed,
    Canceled,
};

struct EncodeCompletion {
    std::uint64_t request_id = 0;
    bool succeeded = false;
    std::optional<ScreenshotCapture> capture;
};

struct EncodeCompletionSink {
    std::vector<EncodeCompletion> completions;
};

[[nodiscard]] bool valid_options(const ScreenshotRequestOptions& options) noexcept
{
    if (options.png_compression_level < 0 || options.png_compression_level > 9)
        return false;
    if (options.sizing.mode == ScreenshotSizingMode::Native)
        return true;
    if (options.sizing.width == 0 || options.sizing.height == 0 ||
        options.sizing.width > kScreenshotCaptureMaxDimension ||
        options.sizing.height > kScreenshotCaptureMaxDimension)
        return false;
    if (options.sizing.mode == ScreenshotSizingMode::Fit)
        return true;
    return screenshot_rgba8_byte_size(options.sizing.width, options.sizing.height).has_value();
}

[[nodiscard]] std::optional<RendererScreenshotRequest>
resolve_renderer_request(std::uint64_t request_id, const ScreenshotRequestOptions& options,
                         const Renderer& renderer)
{
    const auto source_width = static_cast<std::uint32_t>(std::max(renderer.ui_raster_width(), 1));
    const auto source_height = static_cast<std::uint32_t>(std::max(renderer.ui_raster_height(), 1));
    RendererScreenshotRequest request;
    request.request_id = request_id;

    switch (options.sizing.mode) {
    case ScreenshotSizingMode::Native: {
        const auto viewport = renderer.presentation().viewport.host_framebuffer_rect;
        if (viewport.width <= 0 || viewport.height <= 0 || viewport.width > UINT16_MAX ||
            viewport.height > UINT16_MAX)
            return std::nullopt;
        request.width = static_cast<std::uint32_t>(viewport.width);
        request.height = static_cast<std::uint32_t>(viewport.height);
        break;
    }
    case ScreenshotSizingMode::Fit: {
        const double scale = std::min(static_cast<double>(options.sizing.width) / source_width,
                                      static_cast<double>(options.sizing.height) / source_height);
        request.width = std::max<std::uint32_t>(
            1, static_cast<std::uint32_t>(std::lround(static_cast<double>(source_width) * scale)));
        request.height = std::max<std::uint32_t>(
            1, static_cast<std::uint32_t>(std::lround(static_cast<double>(source_height) * scale)));
        request.width = std::min(request.width, options.sizing.width);
        request.height = std::min(request.height, options.sizing.height);
        break;
    }
    case ScreenshotSizingMode::Fill: {
        request.width = options.sizing.width;
        request.height = options.sizing.height;
        const double source_aspect = static_cast<double>(source_width) / source_height;
        const double target_aspect = static_cast<double>(request.width) / request.height;
        if (source_aspect > target_aspect) {
            const float width = static_cast<float>(target_aspect / source_aspect);
            request.source_uv = {(1.0f - width) * 0.5f, 0.0f, width, 1.0f};
        } else if (source_aspect < target_aspect) {
            const float height = static_cast<float>(source_aspect / target_aspect);
            request.source_uv = {0.0f, (1.0f - height) * 0.5f, 1.0f, height};
        }
        break;
    }
    case ScreenshotSizingMode::Exact:
        request.width = options.sizing.width;
        request.height = options.sizing.height;
        break;
    }

    if (!screenshot_rgba8_byte_size(request.width, request.height))
        return std::nullopt;
    return request;
}

class ScreenshotEncodeJob final : public jobs::JobTask {
public:
    ScreenshotEncodeJob(RendererScreenshotCapture source, ScreenshotDestinationKind destination,
                        std::string output_path, int compression_level,
                        std::shared_ptr<EncodeCompletionSink> sink)
        : m_source(std::move(source)), m_destination(destination),
          m_output_path(std::move(output_path)), m_compression_level(compression_level),
          m_sink(std::move(sink))
    {
    }

    ~ScreenshotEncodeJob() override
    {
        if (m_png_write != nullptr || m_png_info != nullptr)
            png_destroy_write_struct(&m_png_write, &m_png_info);
    }

    [[nodiscard]] jobs::JobStepOutcome step(jobs::JobContext& context) noexcept override
    {
        if (context.cancellation_requested())
            return {.status = jobs::JobStepStatus::Completed, .diagnostics = {}};

        if (!m_initialized) {
            if (!initialize())
                return fail("Screenshot encoding initialization failed.");
            m_initialized = true;
        }

        if (m_destination == ScreenshotDestinationKind::FilePpm) {
            if (!encode_ppm_rows(context))
                return fail("Screenshot PPM conversion failed.");
        } else {
            if (!encode_png_rows(context))
                return fail("Screenshot PNG compression failed.");
        }

        if (!m_pixels_complete)
            return {.status = jobs::JobStepStatus::Yielded, .diagnostics = {}};

        if (!m_encoding_finalized) {
            if (m_destination == ScreenshotDestinationKind::FilePpm) {
                m_encoding_finalized = true;
            } else if (!finalize_png()) {
                return fail("Screenshot PNG finalization failed.");
            }
        }
        if (!m_encoding_finalized)
            return {.status = jobs::JobStepStatus::Yielded, .diagnostics = {}};

        if (m_destination == ScreenshotDestinationKind::MemoryPng) {
            m_capture = ScreenshotCapture{
                m_source.request_id,
                m_source.width,
                m_source.height,
                std::string(reinterpret_cast<const char*>(m_png.data()), m_png_size),
            };
            m_succeeded = true;
            return {.status = jobs::JobStepStatus::Completed, .diagnostics = {}};
        }

        if (!write_file(context))
            return fail("Screenshot file write failed.");
        if (!m_file_complete)
            return {.status = jobs::JobStepStatus::Yielded, .diagnostics = {}};

        m_succeeded = true;
        return {.status = jobs::JobStepStatus::Completed, .diagnostics = {}};
    }

    void complete_on_owner(jobs::JobCompletion completion) noexcept override
    {
        const bool succeeded =
            completion.status == jobs::JobTerminalStatus::Completed && m_succeeded;
        m_sink->completions.push_back(EncodeCompletion{
            m_source.request_id, succeeded, succeeded ? std::move(m_capture) : std::nullopt});
    }

private:
    [[nodiscard]] jobs::JobStepOutcome fail(std::string message) noexcept
    {
        return {
            .status = jobs::JobStepStatus::Failed,
            .diagnostics = {{.code = "screenshot.encode_failed", .message = std::move(message)}}};
    }

    [[nodiscard]] bool source_valid() const noexcept
    {
        if (m_source.width == 0 || m_source.height == 0 || m_source.pitch < m_source.width * 4u)
            return false;
        const auto required = static_cast<std::uint64_t>(m_source.pitch) * m_source.height;
        return required <= m_source.pixels.size();
    }

    [[nodiscard]] bool initialize() noexcept
    {
        if (!source_valid())
            return false;
        if (m_destination == ScreenshotDestinationKind::FilePpm)
            return initialize_ppm();
        return initialize_png();
    }

    [[nodiscard]] bool initialize_ppm() noexcept
    {
        const std::string header = "P6\n" + std::to_string(m_source.width) + " " +
                                   std::to_string(m_source.height) + "\n255\n";
        const auto pixel_bytes = static_cast<std::uint64_t>(m_source.width) * m_source.height * 3u;
        const auto total = static_cast<std::uint64_t>(header.size()) + pixel_bytes;
        if (total > std::numeric_limits<std::size_t>::max())
            return false;
        m_ppm.resize(static_cast<std::size_t>(total));
        std::memcpy(m_ppm.data(), header.data(), header.size());
        m_ppm_pixel_offset = header.size();
        return true;
    }

    static void png_error_callback(png_structp png, png_const_charp) { png_longjmp(png, 1); }

    static void png_warning_callback(png_structp, png_const_charp) {}

    static void png_write_callback(png_structp png, png_bytep data, png_size_t size)
    {
        auto* self = static_cast<ScreenshotEncodeJob*>(png_get_io_ptr(png));
        if (self == nullptr || size > self->m_png.max_size() - self->m_png.size()) {
            png_error(png, "Screenshot PNG output exceeds addressable memory.");
            return;
        }
        const auto offset = self->m_png.size();
        self->m_png.resize(offset + size);
        std::memcpy(self->m_png.data() + offset, data, size);
    }

    static void png_flush_callback(png_structp) {}

    [[nodiscard]] bool initialize_png() noexcept
    {
        const auto row_bytes = static_cast<std::uint64_t>(m_source.width) * 4u;
        const auto raw_size = row_bytes * m_source.height;
        if (row_bytes > std::numeric_limits<std::size_t>::max() ||
            raw_size > std::numeric_limits<std::size_t>::max())
            return false;

        m_row.resize(static_cast<std::size_t>(row_bytes));
        const auto reserve_size = static_cast<std::size_t>(raw_size);
        m_png.clear();
        m_png.reserve(reserve_size);

        m_png_write = png_create_write_struct(PNG_LIBPNG_VER_STRING, nullptr, png_error_callback,
                                              png_warning_callback);
        if (m_png_write == nullptr)
            return false;
        m_png_info = png_create_info_struct(m_png_write);
        if (m_png_info == nullptr)
            return false;

        if (setjmp(png_jmpbuf(m_png_write)) != 0)
            return false;

        png_set_write_fn(m_png_write, this, png_write_callback, png_flush_callback);
        png_set_IHDR(m_png_write, m_png_info, m_source.width, m_source.height, 8,
                     PNG_COLOR_TYPE_RGBA, PNG_INTERLACE_NONE, PNG_COMPRESSION_TYPE_DEFAULT,
                     PNG_FILTER_TYPE_DEFAULT);
        png_set_compression_level(m_png_write, m_compression_level);
        png_set_filter(m_png_write, PNG_FILTER_TYPE_BASE, PNG_ALL_FILTERS);
        png_write_info(m_png_write, m_png_info);
        return true;
    }

    void fill_rgba_row(std::uint32_t row, std::uint8_t* output) const noexcept
    {
        const auto source_row = m_source.yflip ? m_source.height - 1u - row : row;
        const auto* source =
            m_source.pixels.data() + static_cast<std::size_t>(source_row) * m_source.pitch;
        if (m_source.format == RendererScreenshotPixelFormat::Rgba8) {
            std::memcpy(output, source, static_cast<std::size_t>(m_source.width) * 4u);
            return;
        }
        for (std::uint32_t x = 0; x < m_source.width; ++x) {
            const auto offset = static_cast<std::size_t>(x) * 4u;
            output[offset + 0u] = source[offset + 2u];
            output[offset + 1u] = source[offset + 1u];
            output[offset + 2u] = source[offset + 0u];
            output[offset + 3u] = source[offset + 3u];
        }
    }

    [[nodiscard]] bool encode_png_rows(jobs::JobContext& context) noexcept
    {
        while (m_next_row < m_source.height) {
            fill_rgba_row(m_next_row, m_row.data());
            if (setjmp(png_jmpbuf(m_png_write)) != 0)
                return false;
            png_write_row(m_png_write, m_row.data());
            ++m_next_row;
            context.report_progress({m_next_row, m_source.height});
            if (context.cooperative_budget_expired())
                return true;
        }
        m_pixels_complete = true;
        return true;
    }

    [[nodiscard]] bool encode_ppm_rows(jobs::JobContext& context) noexcept
    {
        while (m_next_row < m_source.height) {
            const auto source_row = m_source.yflip ? m_source.height - 1u - m_next_row : m_next_row;
            const auto* source =
                m_source.pixels.data() + static_cast<std::size_t>(source_row) * m_source.pitch;
            auto* output = m_ppm.data() + m_ppm_pixel_offset +
                           static_cast<std::size_t>(m_next_row) * m_source.width * 3u;
            for (std::uint32_t x = 0; x < m_source.width; ++x) {
                const auto source_offset = static_cast<std::size_t>(x) * 4u;
                const auto output_offset = static_cast<std::size_t>(x) * 3u;
                if (m_source.format == RendererScreenshotPixelFormat::Bgra8) {
                    output[output_offset + 0u] = source[source_offset + 2u];
                    output[output_offset + 1u] = source[source_offset + 1u];
                    output[output_offset + 2u] = source[source_offset + 0u];
                } else {
                    output[output_offset + 0u] = source[source_offset + 0u];
                    output[output_offset + 1u] = source[source_offset + 1u];
                    output[output_offset + 2u] = source[source_offset + 2u];
                }
            }
            ++m_next_row;
            context.report_progress({m_next_row, m_source.height});
            if (context.cooperative_budget_expired())
                return true;
        }
        m_pixels_complete = true;
        return true;
    }

    [[nodiscard]] bool finalize_png() noexcept
    {
        if (setjmp(png_jmpbuf(m_png_write)) != 0)
            return false;
        png_write_end(m_png_write, m_png_info);
        png_destroy_write_struct(&m_png_write, &m_png_info);
        m_png_size = m_png.size();
        m_encoding_finalized = true;
        return true;
    }

    [[nodiscard]] bool open_output_file() noexcept
    {
        const std::filesystem::path output(m_output_path);
        if (output.has_parent_path()) {
            std::error_code ec;
            std::filesystem::create_directories(output.parent_path(), ec);
            if (ec)
                return false;
        }
        m_file.open(output, std::ios::binary | std::ios::trunc);
        return static_cast<bool>(m_file);
    }

    [[nodiscard]] bool write_file(jobs::JobContext& context) noexcept
    {
        if (!m_file.is_open() && !open_output_file())
            return false;
        const std::uint8_t* data =
            m_destination == ScreenshotDestinationKind::FilePpm ? m_ppm.data() : m_png.data();
        const std::size_t size =
            m_destination == ScreenshotDestinationKind::FilePpm ? m_ppm.size() : m_png_size;
        while (m_file_offset < size) {
            const auto count = std::min(kFileWriteChunkSize, size - m_file_offset);
            m_file.write(reinterpret_cast<const char*>(data + m_file_offset),
                         static_cast<std::streamsize>(count));
            if (!m_file)
                return false;
            m_file_offset += count;
            if (context.cooperative_budget_expired())
                return true;
        }
        m_file.close();
        m_file_complete = true;
        return true;
    }

    RendererScreenshotCapture m_source;
    ScreenshotDestinationKind m_destination = ScreenshotDestinationKind::MemoryPng;
    std::string m_output_path;
    int m_compression_level = 6;
    std::shared_ptr<EncodeCompletionSink> m_sink;
    bool m_initialized = false;
    bool m_pixels_complete = false;
    bool m_encoding_finalized = false;
    bool m_file_complete = false;
    bool m_succeeded = false;
    std::uint32_t m_next_row = 0;

    png_structp m_png_write = nullptr;
    png_infop m_png_info = nullptr;
    std::vector<std::uint8_t> m_row;
    std::vector<std::uint8_t> m_png;
    std::size_t m_png_size = 0;

    std::vector<std::uint8_t> m_ppm;
    std::size_t m_ppm_pixel_offset = 0;
    std::ofstream m_file;
    std::size_t m_file_offset = 0;
    std::optional<ScreenshotCapture> m_capture;
};

} // namespace

struct ScreenshotService::Impl {
    struct RequestRecord {
        std::uint64_t id = 0;
        ScreenshotRequestOptions options{};
        ScreenshotDestinationKind destination = ScreenshotDestinationKind::MemoryPng;
        std::string output_path;
        ScreenshotRequestState state = ScreenshotRequestState::Queued;
        jobs::JobId job_id{};
        std::optional<ScreenshotCapture> capture;
    };

    Impl(Renderer& configured_renderer, jobs::JobExecutor& configured_jobs)
        : renderer(configured_renderer), jobs(configured_jobs),
          sink(std::make_shared<EncodeCompletionSink>())
    {
    }

    [[nodiscard]] RequestRecord* find(std::uint64_t id) noexcept
    {
        const auto found =
            std::find_if(records.begin(), records.end(),
                         [id](const RequestRecord& record) { return record.id == id; });
        return found == records.end() ? nullptr : &*found;
    }

    [[nodiscard]] const RequestRecord* find(std::uint64_t id) const noexcept
    {
        const auto found =
            std::find_if(records.begin(), records.end(),
                         [id](const RequestRecord& record) { return record.id == id; });
        return found == records.end() ? nullptr : &*found;
    }

    void erase(std::uint64_t id)
    {
        std::erase_if(records, [id](const RequestRecord& record) { return record.id == id; });
    }

    [[nodiscard]] std::optional<std::uint64_t> allocate_id() noexcept
    {
        if (next_request_id == 0)
            return std::nullopt;
        const auto id = next_request_id;
        if (next_request_id == std::numeric_limits<std::uint64_t>::max())
            next_request_id = 0;
        else
            ++next_request_id;
        return id;
    }

    Renderer& renderer;
    jobs::JobExecutor& jobs;
    std::shared_ptr<EncodeCompletionSink> sink;
    std::vector<RequestRecord> records;
    std::optional<std::uint64_t> gpu_request;
    std::uint64_t next_request_id = 1;
};

ScreenshotService::ScreenshotService(Renderer& renderer, jobs::JobExecutor& jobs)
    : m_impl(std::make_unique<Impl>(renderer, jobs))
{
}

ScreenshotService::~ScreenshotService() = default;

std::optional<std::uint64_t> ScreenshotService::request_capture(ScreenshotRequestOptions options)
{
    if (!valid_options(options))
        return std::nullopt;
    if (options.require_next_frame &&
        (m_impl->gpu_request || m_impl->renderer.game_viewport_capture_pending() ||
         std::any_of(m_impl->records.begin(), m_impl->records.end(), [](const auto& record) {
             return record.state == ScreenshotRequestState::Queued ||
                    record.state == ScreenshotRequestState::GpuCapture;
         })))
        return std::nullopt;
    auto id = m_impl->allocate_id();
    if (!id)
        return std::nullopt;
    m_impl->records.push_back(Impl::RequestRecord{
        .id = *id,
        .options = options,
        .destination = ScreenshotDestinationKind::MemoryPng,
        .output_path = {},
        .state = ScreenshotRequestState::Queued,
        .job_id = {},
        .capture = std::nullopt,
    });
    return id;
}

std::optional<std::uint64_t> ScreenshotService::request_file(std::string path,
                                                             ScreenshotRequestOptions options)
{
    if (path.empty() || !valid_options(options))
        return std::nullopt;
    auto id = m_impl->allocate_id();
    if (!id)
        return std::nullopt;

    std::string extension = std::filesystem::path(path).extension().string();
    std::transform(extension.begin(), extension.end(), extension.begin(),
                   [](unsigned char value) { return static_cast<char>(std::tolower(value)); });
    const auto destination = extension == ".png" ? ScreenshotDestinationKind::FilePng
                                                 : ScreenshotDestinationKind::FilePpm;
    m_impl->records.push_back(Impl::RequestRecord{
        .id = *id,
        .options = options,
        .destination = destination,
        .output_path = std::move(path),
        .state = ScreenshotRequestState::Queued,
        .job_id = {},
        .capture = std::nullopt,
    });
    return id;
}

std::optional<ScreenshotCapture> ScreenshotService::take_capture(std::uint64_t request_id)
{
    auto* record = m_impl->find(request_id);
    if (!record)
        return std::nullopt;
    if (record->state == ScreenshotRequestState::Failed ||
        record->state == ScreenshotRequestState::Canceled) {
        m_impl->erase(request_id);
        return std::nullopt;
    }
    if (record->state != ScreenshotRequestState::Completed || !record->capture)
        return std::nullopt;
    auto capture = std::move(record->capture);
    m_impl->erase(request_id);
    return capture;
}

bool ScreenshotService::capture_pending(std::uint64_t request_id) const noexcept
{
    const auto* record = m_impl->find(request_id);
    if (!record)
        return false;
    return record->state == ScreenshotRequestState::Queued ||
           record->state == ScreenshotRequestState::GpuCapture ||
           record->state == ScreenshotRequestState::Encoding;
}

bool ScreenshotService::has_pending_requests() const noexcept
{
    return std::any_of(m_impl->records.begin(), m_impl->records.end(), [](const auto& record) {
        return record.state == ScreenshotRequestState::Queued ||
               record.state == ScreenshotRequestState::GpuCapture ||
               record.state == ScreenshotRequestState::Encoding;
    });
}

void ScreenshotService::cancel_capture(std::uint64_t request_id) noexcept
{
    auto* record = m_impl->find(request_id);
    if (!record)
        return;
    if (record->state == ScreenshotRequestState::Encoding && record->job_id.valid())
        (void)m_impl->jobs.request_cancel(record->job_id);
    if (record->state == ScreenshotRequestState::Queued ||
        record->state == ScreenshotRequestState::Completed ||
        record->state == ScreenshotRequestState::Failed) {
        m_impl->erase(request_id);
        return;
    }
    record->state = ScreenshotRequestState::Canceled;
}

void ScreenshotService::poll()
{
    for (auto& completion : m_impl->sink->completions) {
        auto* record = m_impl->find(completion.request_id);
        if (!record)
            continue;
        if (record->state == ScreenshotRequestState::Canceled) {
            m_impl->erase(record->id);
            continue;
        }
        if (!completion.succeeded) {
            if (record->destination == ScreenshotDestinationKind::MemoryPng)
                record->state = ScreenshotRequestState::Failed;
            else
                m_impl->erase(record->id);
            continue;
        }
        if (record->destination == ScreenshotDestinationKind::MemoryPng) {
            record->capture = std::move(completion.capture);
            record->state = ScreenshotRequestState::Completed;
        } else {
            m_impl->erase(record->id);
        }
    }
    m_impl->sink->completions.clear();

    if (m_impl->gpu_request) {
        const auto request_id = *m_impl->gpu_request;
        auto capture = m_impl->renderer.take_screenshot_capture();
        if (capture) {
            auto* record = m_impl->find(request_id);
            if (record && capture->request_id == request_id &&
                record->state != ScreenshotRequestState::Canceled) {
                auto task = std::make_unique<ScreenshotEncodeJob>(
                    std::move(*capture), record->destination, record->output_path,
                    record->options.png_compression_level, m_impl->sink);
                auto submitted = m_impl->jobs.submit(jobs::JobPriority::Normal, std::move(task));
                if (submitted) {
                    record->job_id = *submitted.value_if();
                    record->state = ScreenshotRequestState::Encoding;
                } else {
                    record->state = ScreenshotRequestState::Failed;
                }
            } else if (record) {
                m_impl->erase(request_id);
            }
            m_impl->gpu_request.reset();
        } else if (!m_impl->renderer.game_viewport_capture_pending()) {
            if (auto* record = m_impl->find(request_id)) {
                if (record->state == ScreenshotRequestState::Canceled ||
                    record->destination != ScreenshotDestinationKind::MemoryPng)
                    m_impl->erase(request_id);
                else
                    record->state = ScreenshotRequestState::Failed;
            }
            m_impl->gpu_request.reset();
        }
    }

    if (m_impl->gpu_request)
        return;
    const auto queued = std::find_if(m_impl->records.begin(), m_impl->records.end(),
                                     [](const Impl::RequestRecord& record) {
                                         return record.state == ScreenshotRequestState::Queued;
                                     });
    if (queued == m_impl->records.end())
        return;
    auto request = resolve_renderer_request(queued->id, queued->options, m_impl->renderer);
    if (!request) {
        queued->state = ScreenshotRequestState::Failed;
        return;
    }
    if (!m_impl->renderer.request_screenshot_capture(*request))
        return;
    queued->state = ScreenshotRequestState::GpuCapture;
    m_impl->gpu_request = queued->id;
}

void ScreenshotService::reset() noexcept
{
    for (auto& record : m_impl->records) {
        if (record.state == ScreenshotRequestState::Encoding && record.job_id.valid())
            (void)m_impl->jobs.request_cancel(record.job_id);
        record.state = ScreenshotRequestState::Canceled;
    }
    std::erase_if(m_impl->records, [](const Impl::RequestRecord& record) {
        return record.state == ScreenshotRequestState::Canceled && !record.job_id.valid();
    });
}

CheckpointThumbnailCaptureCoordinator::CheckpointThumbnailCaptureCoordinator(
    ScreenshotCaptureBackend& backend) noexcept
    : m_backend(backend)
{
}

bool CheckpointThumbnailCaptureCoordinator::request_if_ready(
    const CheckpointThumbnailCaptureContext& context)
{
    if (m_in_flight || !context.host_generation || !context.pending_request ||
        !context.displayed_presentation || context.visual_operation_active ||
        *context.displayed_presentation != context.pending_request->presentation)
        return false;

    auto request_id = m_backend.request_capture(ScreenshotRequestOptions{
        .sizing = {ScreenshotSizingMode::Fit, kThumbnailMaxWidth, kThumbnailMaxHeight},
        .png_compression_level = 6,
        .require_next_frame = true,
    });
    if (!request_id)
        return false;

    m_in_flight = InFlightCapture{
        *request_id, CaptureBinding{*context.host_generation, *context.pending_request}};
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

    auto capture = m_backend.take_capture(m_in_flight->renderer_request);
    if (!capture) {
        if (!m_backend.capture_pending(m_in_flight->renderer_request))
            m_in_flight.reset();
        return std::nullopt;
    }

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
    if (m_in_flight)
        m_backend.cancel_capture(m_in_flight->renderer_request);
    m_in_flight.reset();
}

std::optional<core::CheckpointThumbnailCaptureRequest>
CheckpointThumbnailCaptureCoordinator::stale_pending_request(
    const CheckpointThumbnailCaptureContext& context) const noexcept
{
    if (m_in_flight || !context.pending_request || !context.displayed_presentation ||
        context.displayed_presentation->number() <= context.pending_request->presentation.number())
        return std::nullopt;
    return context.pending_request;
}

bool CheckpointThumbnailCaptureCoordinator::binding_is_current(
    const CaptureBinding& binding, const CheckpointThumbnailCaptureContext& context) const
{
    return context.host_generation && *context.host_generation == binding.host_generation &&
           context.pending_request && *context.pending_request == binding.request;
}

} // namespace noveltea::host
