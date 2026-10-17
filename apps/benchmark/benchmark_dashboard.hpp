#pragma once

#include "benchmark_completed_run.hpp"

#include <SDL3/SDL.h>
#include <bgfx/bgfx.h>

#include <array>
#include <functional>
#include <string>
#include <string_view>

namespace noveltea::benchmark {

enum class DashboardAction {
    None,
    Run,
    QuickSuite,
    Capture,
    CaptureEngine,
    Exit,
};

// Independent of NovelTea Engine/Devtools. It must be fully destroyed before
// run_suite enters Preparation, not merely hidden while it samples.
class Dashboard {
public:
    Dashboard() = default;
    ~Dashboard();
    Dashboard(const Dashboard&) = delete;
    Dashboard& operator=(const Dashboard&) = delete;

    bool initialize(SDL_Window* window, const Options& options, std::string& error);
    void shutdown();
    void process_event(const SDL_Event& event);
    DashboardAction frame(Options& options, const CompletedRun* last_run, std::string_view error,
                          const std::function<void()>& preview = {},
                          const std::function<void()>& capture = {});
    // Supports automated full-reference inspection in the GPU lifecycle smoke.
    void set_inspection_only(bool value) { inspection_only_ = value; }
    [[nodiscard]] bool inspection_only() const { return inspection_only_; }
    [[nodiscard]] bool initialized() const { return initialized_; }

private:
    bool create_resources(std::string& error);
    void render();

    SDL_Window* window_ = nullptr;
    bool initialized_ = false;
    bool first_frame_ = true;
    bool inspection_only_ = false;
    bool capture_requested_ = false;
    bgfx::ProgramHandle program_ = BGFX_INVALID_HANDLE;
    bgfx::UniformHandle sampler_ = BGFX_INVALID_HANDLE;
    bgfx::TextureHandle font_ = BGFX_INVALID_HANDLE;
    std::array<char, 512> output_path_{};
    std::array<char, 1024> feature_lab_path_{};
};

} // namespace noveltea::benchmark
