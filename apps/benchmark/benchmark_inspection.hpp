#pragma once

#include "benchmark_options.hpp"

#include <bgfx/bgfx.h>

#include <chrono>
#include <cstdint>
#include <filesystem>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <vector>

namespace noveltea::benchmark {

struct InspectionPixels {
    uint32_t width = 0;
    uint32_t height = 0;
    uint32_t pitch = 0;
    bgfx::TextureFormat::Enum format = bgfx::TextureFormat::Count;
    bool yflip = false;
    std::vector<uint8_t> bytes;
};

// Encodes the actual readback, with a canonical configuration and effective
// framebuffer dimensions in the PNG's "NovelTea benchmark" text chunk.
bool encode_inspection_png(const InspectionPixels& source, const Options& options,
                           std::vector<uint8_t>& png, std::string& reason);

// Only the dashboard's untimed Preview/Inspection path may request a capture.
// bgfx invokes screenShot on its render thread; encoding and I/O run on the UI
// thread when poll() observes the completed copy.
class InspectionCapture final : public bgfx::CallbackI {
public:
    bool request(const Options& options, int width, int height, std::string& reason);
    void poll(std::string& feedback);
    void cancel();
    [[nodiscard]] bool pending() const;

    void fatal(const char* file, uint16_t line, bgfx::Fatal::Enum code,
               const char* message) override;
    void traceVargs(const char*, uint16_t, const char*, va_list) override {}
    void profilerBegin(const char*, uint32_t, const char*, uint16_t) override {}
    void profilerBeginLiteral(const char*, uint32_t, const char*, uint16_t) override {}
    void profilerEnd() override {}
    uint32_t cacheReadSize(uint64_t) override { return 0; }
    bool cacheRead(uint64_t, void*, uint32_t) override { return false; }
    void cacheWrite(uint64_t, const void*, uint32_t) override {}
    void screenShot(const char*, uint32_t width, uint32_t height, uint32_t pitch,
#if BGFX_API_VERSION >= 143
                    bgfx::TextureFormat::Enum format,
#endif
                    const void* data, uint32_t size, bool yflip) override;
    void captureBegin(uint32_t, uint32_t, uint32_t, bgfx::TextureFormat::Enum, bool) override {}
    void captureEnd() override {}
    void captureFrame(const void*, uint32_t) override {}

private:
    mutable std::mutex mutex_;
    bool waiting_ = false;
    uint64_t request_sequence_ = 0;
    std::string request_name_;
    Options selected_;
    int requested_width_ = 0;
    int requested_height_ = 0;
    std::chrono::steady_clock::time_point started_;
    std::optional<InspectionPixels> received_;
    std::string callback_error_;
};

bool supports_inspection(std::string_view scenario);
bool supports_engine_inspection(std::string_view scenario);
// Use an independent screenshot area under the same results collection.
std::filesystem::path make_inspection_path(const Options& options, std::string& reason);
bool inspection_file_complete(const std::filesystem::path& path);
// Re-encode EngineTooling's already-completed PNG to include the same
// inspection metadata as the standalone bgfx screenshot callback.
bool annotate_engine_inspection(const std::filesystem::path& path, const Options& options,
                                std::string& reason);

class IntegratedRmlUi;
class IntegratedInspection {
public:
    ~IntegratedInspection();
    bool begin(const Options& options, std::string& reason);
    // Returns true when finished; reason is empty on success.
    bool step(std::string& reason);
    void shutdown();
    [[nodiscard]] bool running() const { return engine_ != nullptr; }
    [[nodiscard]] const std::filesystem::path& path() const { return path_; }

private:
    std::unique_ptr<IntegratedRmlUi> engine_;
    Options options_;
    std::filesystem::path path_;
    std::chrono::steady_clock::time_point started_;
};

} // namespace noveltea::benchmark
