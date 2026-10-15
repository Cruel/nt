#pragma once

#include "benchmark_options.hpp"
#include "benchmark_runner.hpp"

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
    DashboardAction frame(Options& options, const SuiteResult* last_result,
                          std::string_view report_path, std::string_view error,
                          const std::function<void()>& preview = {});
    [[nodiscard]] bool initialized() const { return initialized_; }

private:
    bool create_resources(std::string& error);
    void render();

    SDL_Window* window_ = nullptr;
    bool initialized_ = false;
    bool first_frame_ = true;
    bgfx::ProgramHandle program_ = BGFX_INVALID_HANDLE;
    bgfx::UniformHandle sampler_ = BGFX_INVALID_HANDLE;
    bgfx::TextureHandle font_ = BGFX_INVALID_HANDLE;
    std::array<char, 512> output_path_{};
};

} // namespace noveltea::benchmark
