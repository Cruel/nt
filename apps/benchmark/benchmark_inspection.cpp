#include "benchmark_inspection.hpp"

#include "benchmark_report.hpp"
#include "integrated_rmlui.hpp"
#include "raw_bgfx_workloads.hpp"

#include <png.h>

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <limits>
#include <array>
#include <iterator>
#include <utility>

#if defined(__EMSCRIPTEN__)
#include <emscripten/emscripten.h>
#endif
#if defined(__ANDROID__)
#include <SDL3/SDL.h>
#endif

namespace noveltea::benchmark {
namespace {

void png_error(png_structp writer, png_const_charp) { png_longjmp(writer, 1); }
void png_warning(png_structp, png_const_charp) {}

void png_append(png_structp writer, png_bytep bytes, png_size_t count)
{
    auto* target = static_cast<std::vector<uint8_t>*>(png_get_io_ptr(writer));
    if (count > target->max_size() - target->size()) {
        png_error(writer, "inspection PNG exceeds addressable memory");
        return;
    }
    target->insert(target->end(), bytes, bytes + count);
}
void png_flush(png_structp) {}

std::filesystem::path inspection_directory(const Options& options)
{
    if (!options.output_path.empty())
        return std::filesystem::path(options.output_path).parent_path() / "screenshots";
#if defined(__ANDROID__)
    const char* pref = SDL_GetPrefPath("NovelTea", "Benchmark");
    if (!pref)
        return {};
    return std::filesystem::path(pref) / "results" / "screenshots";
#else
    return std::filesystem::path(NOVELTEA_BENCHMARK_RESULTS_DIR) / "screenshots";
#endif
}

} // namespace

bool supports_engine_inspection(std::string_view scenario)
{
    return scenario == "integrated-rmlui-controlled" || scenario == "integrated-rmlui-production" ||
           scenario == "integrated-rmlui-scaling" || scenario == "integrated-rmlui-effects";
}

bool supports_inspection(std::string_view scenario)
{
    return scenario == "raw-bgfx-geometry" || is_extended_raw_scenario(scenario) ||
           scenario == "standalone-rmlui-simple" || scenario == "standalone-rmlui-scaling" ||
           scenario == "standalone-rmlui-effects";
}

bool encode_inspection_png(const InspectionPixels& source, const Options& options,
                           std::vector<uint8_t>& output, std::string& reason)
{
    if (source.width == 0 || source.height == 0 || source.width > 16384 || source.height > 16384 ||
        source.pitch < source.width * 4ull ||
        uint64_t(source.pitch) * source.height > source.bytes.size() ||
        (source.format != bgfx::TextureFormat::BGRA8 &&
         source.format != bgfx::TextureFormat::RGBA8)) {
        reason = "unsupported screenshot readback dimensions, pitch or pixel format";
        return false;
    }
    auto* writer = png_create_write_struct(PNG_LIBPNG_VER_STRING, nullptr, png_error, png_warning);
    if (!writer) {
        reason = "unable to initialize PNG encoder";
        return false;
    }
    auto* info = png_create_info_struct(writer);
    if (!info) {
        png_destroy_write_struct(&writer, nullptr);
        reason = "unable to initialize PNG metadata";
        return false;
    }
    output.clear();
    bool ok = false;
    if (setjmp(png_jmpbuf(writer)) == 0) {
        png_set_write_fn(writer, &output, png_append, png_flush);
        png_set_IHDR(writer, info, source.width, source.height, 8, PNG_COLOR_TYPE_RGBA,
                     PNG_INTERLACE_NONE, PNG_COMPRESSION_TYPE_DEFAULT, PNG_FILTER_TYPE_DEFAULT);
        const std::string metadata =
            std::string("{\"kind\":\"untimed-inspection\",\"width_pixels\":") +
            std::to_string(source.width) + ",\"height_pixels\":" + std::to_string(source.height) +
            ",\"configuration\":" + encode_configuration(options) + "}";
        png_text text_chunk{};
        text_chunk.compression = PNG_TEXT_COMPRESSION_NONE;
        text_chunk.key = const_cast<png_charp>("NovelTea benchmark");
        text_chunk.text = const_cast<png_charp>(metadata.c_str());
        png_set_text(writer, info, &text_chunk, 1);
        png_write_info(writer, info);
        std::vector<uint8_t> row(static_cast<size_t>(source.width) * 4u);
        for (uint32_t y = 0; y < source.height; ++y) {
            const uint32_t from_y = source.yflip ? source.height - y - 1 : y;
            const auto* pixels = source.bytes.data() + size_t(from_y) * source.pitch;
            if (source.format == bgfx::TextureFormat::RGBA8) {
                std::memcpy(row.data(), pixels, row.size());
            } else {
                for (uint32_t x = 0; x < source.width; ++x) {
                    const size_t i = size_t(x) * 4u;
                    row[i] = pixels[i + 2];
                    row[i + 1] = pixels[i + 1];
                    row[i + 2] = pixels[i];
                    row[i + 3] = pixels[i + 3];
                }
            }
            png_write_row(writer, row.data());
        }
        png_write_end(writer, info);
        ok = true;
    }
    png_destroy_write_struct(&writer, &info);
    if (!ok) {
        output.clear();
        reason = "PNG encoding failed";
    }
    return ok;
}

bool InspectionCapture::request(const Options& options, int width, int height, std::string& reason)
{
    if (!supports_inspection(options.scenario)) {
        reason = "no untimed preview/readback for this scenario; Engine-owned scenes require "
                 "exclusive renderer capture";
        return false;
    }
    if (width <= 0 || height <= 0) {
        reason = "inspection requires a valid framebuffer";
        return false;
    }
    {
        std::lock_guard lock(mutex_);
        if (waiting_) {
            reason = "an inspection screenshot is still pending";
            return false;
        }
        selected_ = options;
        requested_width_ = width;
        requested_height_ = height;
        received_.reset();
        callback_error_.clear();
        waiting_ = true;
        request_name_ = "benchmark-inspection-" + std::to_string(++request_sequence_);
        started_ = std::chrono::steady_clock::now();
    }
    // Unique request identity prevents a delayed callback from a timed-out
    // request being mistaken for a later screenshot after the user retries.
    bgfx::requestScreenShot(BGFX_INVALID_HANDLE, request_name_.c_str());
    return true;
}

void InspectionCapture::screenShot(const char* name, uint32_t width, uint32_t height,
                                   uint32_t pitch,
#if BGFX_API_VERSION >= 143
                                   bgfx::TextureFormat::Enum format,
#endif
                                   const void* data, uint32_t size, bool yflip)
{
    std::lock_guard lock(mutex_);
    if (!waiting_ || !name || request_name_ != name || received_ || !callback_error_.empty())
        return;
    if (!data || size == 0 || uint64_t(pitch) * height > size || width == 0 || height == 0) {
        callback_error_ = "bgfx screenshot callback returned no valid pixels";
        return;
    }
    InspectionPixels pixels;
    pixels.width = width;
    pixels.height = height;
    pixels.pitch = pitch;
#if BGFX_API_VERSION >= 143
    pixels.format = format;
#else
    pixels.format = bgfx::TextureFormat::BGRA8;
#endif
    pixels.yflip = yflip;
    auto* source = static_cast<const uint8_t*>(data);
    pixels.bytes.assign(source, source + size);
    received_ = std::move(pixels);
}

void InspectionCapture::poll(std::string& feedback)
{
    std::optional<InspectionPixels> pixels;
    Options options;
    int width = 0;
    int height = 0;
    {
        std::lock_guard lock(mutex_);
        if (!waiting_)
            return;
        if (!callback_error_.empty()) {
            feedback = "Screenshot failed: " + callback_error_;
            waiting_ = false;
            return;
        }
        if (!received_) {
            if (std::chrono::steady_clock::now() - started_ > std::chrono::seconds(5)) {
                feedback = "Screenshot unsupported or timed out: no bgfx readback callback";
                waiting_ = false;
            }
            return;
        }
        pixels = std::move(received_);
        received_.reset();
        options = selected_;
        width = requested_width_;
        height = requested_height_;
        waiting_ = false;
    }
    if (pixels->width != static_cast<uint32_t>(width) ||
        pixels->height != static_cast<uint32_t>(height)) {
        feedback = "Screenshot failed: captured backbuffer size differs from the requested preview";
        return;
    }
    std::vector<uint8_t> encoded;
    std::string reason;
    if (!encode_inspection_png(*pixels, options, encoded, reason)) {
        feedback = "Screenshot failed: " + reason;
        return;
    }
    const auto path = make_inspection_path(options, reason);
    if (path.empty()) {
        feedback = "Screenshot failed: " + reason;
        return;
    }
    const auto dir = path.parent_path();
    std::error_code ec;
    std::filesystem::create_directories(dir, ec);
    if (ec) {
        feedback = "Screenshot directory failed: " + ec.message();
        return;
    }
    std::ofstream file(path, std::ios::binary | std::ios::trunc);
    if (!file || !file.write(reinterpret_cast<const char*>(encoded.data()),
                             static_cast<std::streamsize>(encoded.size()))) {
        feedback = "Screenshot failed to write: " + path.string();
        return;
    }
    file.close();
    if (!file) {
        feedback = "Screenshot failed to close: " + path.string();
        return;
    }
#if defined(__EMSCRIPTEN__)
    const std::string filename = path.filename().string();
    EM_ASM(
        { window.NovelTeaBenchmark.screenshot(UTF8ToString($0), HEAPU8.slice($1, $1 + $2)); },
        filename.c_str(), encoded.data(), encoded.size());
#endif
    feedback = "Untimed screenshot: " + path.string();
    std::printf("[benchmark] %s\n", feedback.c_str());
}

void InspectionCapture::cancel()
{
    std::lock_guard lock(mutex_);
    waiting_ = false;
    received_.reset();
    callback_error_.clear();
}

bool InspectionCapture::pending() const
{
    std::lock_guard lock(mutex_);
    return waiting_;
}

void InspectionCapture::fatal(const char* file, uint16_t line, bgfx::Fatal::Enum code,
                              const char* message)
{
    if (code == bgfx::Fatal::DebugCheck)
        return; // Diagnostics must never flood the measurement frame path.
    std::fprintf(stderr, "[benchmark] bgfx fatal %s:%u: %s\n", file ? file : "?", line,
                 message ? message : "");
    std::abort();
}

std::filesystem::path make_inspection_path(const Options& options, std::string& reason)
{
    const auto directory = inspection_directory(options);
    if (directory.empty()) {
        reason = "app-private screenshot directory unavailable";
        return {};
    }
    const auto stamp = std::chrono::duration_cast<std::chrono::microseconds>(
                           std::chrono::system_clock::now().time_since_epoch())
                           .count();
    return directory / (options.scenario + "-" + std::to_string(stamp) + ".png");
}

bool inspection_file_complete(const std::filesystem::path& path)
{
    std::ifstream input(path, std::ios::binary | std::ios::ate);
    if (!input || input.tellg() < std::streamoff(12))
        return false;
    input.seekg(-12, std::ios::end);
    std::array<uint8_t, 12> tail{};
    if (!input.read(reinterpret_cast<char*>(tail.data()), tail.size()))
        return false;
    constexpr std::array<uint8_t, 12> iend{0, 0, 0, 0, 'I', 'E', 'N', 'D', 0xae, 0x42, 0x60, 0x82};
    return tail == iend;
}

bool annotate_engine_inspection(const std::filesystem::path& path, const Options& options,
                                std::string& reason)
{
    if (!inspection_file_complete(path)) {
        reason = "Engine screenshot is missing or incomplete";
        return false;
    }
    std::ifstream input(path, std::ios::binary);
    const std::vector<uint8_t> source((std::istreambuf_iterator<char>(input)),
                                      std::istreambuf_iterator<char>());
    if (source.empty()) {
        reason = "cannot read Engine screenshot";
        return false;
    }
    png_image image{};
    image.version = PNG_IMAGE_VERSION;
    if (!png_image_begin_read_from_memory(&image, source.data(), source.size())) {
        reason = "cannot decode Engine screenshot PNG";
        return false;
    }
    image.format = PNG_FORMAT_RGBA;
    InspectionPixels pixels;
    pixels.width = image.width;
    pixels.height = image.height;
    if (image.width == 0 || image.height == 0 || image.width > 16384 || image.height > 16384) {
        png_image_free(&image);
        reason = "Engine screenshot dimensions are unsupported";
        return false;
    }
    pixels.pitch = pixels.width * 4u;
    pixels.format = bgfx::TextureFormat::RGBA8;
    pixels.bytes.resize(PNG_IMAGE_SIZE(image));
    const bool decoded = png_image_finish_read(&image, nullptr, pixels.bytes.data(), 0, nullptr);
    png_image_free(&image);
    if (!decoded) {
        reason = "Engine PNG pixel decoding failed";
        return false;
    }
    std::vector<uint8_t> encoded;
    if (!encode_inspection_png(pixels, options, encoded, reason))
        return false;
    std::ofstream output(path, std::ios::binary | std::ios::trunc);
    if (!output || !output.write(reinterpret_cast<const char*>(encoded.data()),
                                 static_cast<std::streamsize>(encoded.size()))) {
        reason = "unable to write annotated Engine screenshot";
        return false;
    }
    output.close();
    if (!output) {
        reason = "unable to finish annotated Engine screenshot";
        return false;
    }
#if defined(__EMSCRIPTEN__)
    const std::string filename = path.filename().string();
    EM_ASM(
        { window.NovelTeaBenchmark.screenshot(UTF8ToString($0), HEAPU8.slice($1, $1 + $2)); },
        filename.c_str(), encoded.data(), encoded.size());
#endif
    return true;
}

IntegratedInspection::~IntegratedInspection() { shutdown(); }

bool IntegratedInspection::begin(const Options& options, std::string& reason)
{
    shutdown();
    if (!supports_engine_inspection(options.scenario)) {
        reason = "inspection only supports Engine-owned integrated RmlUi references";
        return false;
    }
    path_ = make_inspection_path(options, reason);
    if (path_.empty())
        return false;
    std::error_code ec;
    std::filesystem::create_directories(path_.parent_path(), ec);
    if (ec) {
        reason = "cannot create inspection directory: " + ec.message();
        return false;
    }
    options_ = options;
    engine_ = std::make_unique<IntegratedRmlUi>(options.scenario == "integrated-rmlui-controlled",
                                                options.scenario == "integrated-rmlui-scaling",
                                                options.scenario == "integrated-rmlui-effects");
    if (!engine_->prepare(options, reason) ||
        !engine_->request_inspection_png(path_.string(), reason)) {
        shutdown();
        return false;
    }
    started_ = std::chrono::steady_clock::now();
    return true;
}

bool IntegratedInspection::step(std::string& reason)
{
    if (!engine_) {
        reason = "integrated inspection is not active";
        return true;
    }
    if (inspection_file_complete(path_)) {
        if (!annotate_engine_inspection(path_, options_, reason)) {
            shutdown();
            return true;
        }
        std::printf("[benchmark] Untimed screenshot: %s\n", path_.string().c_str());
        shutdown();
        return true;
    }
    if (std::chrono::steady_clock::now() - started_ > std::chrono::seconds(10)) {
        reason = "Engine screenshot unsupported or timed out: no completed PNG";
        shutdown();
        return true;
    }
    if (!engine_->frame(reason)) {
        shutdown();
        return true;
    }
    return false;
}

void IntegratedInspection::shutdown()
{
    if (!engine_)
        return;
    std::string cleanup;
    (void)engine_->cleanup(cleanup);
    engine_.reset();
}

} // namespace noveltea::benchmark
