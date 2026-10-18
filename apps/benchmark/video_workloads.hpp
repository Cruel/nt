#pragma once

#include "benchmark_report.hpp"
#include "benchmark_runner.hpp"
#include "noveltea/assets/asset_manager.hpp"
#include "noveltea/jobs/inline_job_executor.hpp"
#include "noveltea/platform.hpp"
#include "noveltea/renderer.hpp"
#include "noveltea/world_presentation.hpp"

#ifndef __EMSCRIPTEN__
#include "media/native_video_decoder.hpp"
#endif

#include <chrono>
#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <string_view>

namespace noveltea::benchmark {

// The decode-only case exercises the production VP9 decoder without graphics.
// Upload and presentation use the production typed asset/WorldVideoStream/Renderer pipeline.
class VideoScenario final : public Scenario {
public:
    explicit VideoScenario(std::string_view id) : id_(id) {}
    ~VideoScenario() override;

    const char* id() const override { return id_.c_str(); }
    const char* description() const override;
    bool requires_graphics() const override { return id_ != "video-decode"; }
    bool prepare(const Options& options, std::string& reason) override;
    Readiness readiness(std::string& reason) override;
    bool prepare_frame(std::string& reason) override;
    bool frame(std::string& reason) override;
    bool active_operation_timing() const override { return id_ == "video-decode"; }
    void diagnostic_frame(DiagnosticObservation& observation) override;
    void diagnostic_completion(std::vector<DiagnosticObservation>& late) override;
    bool complete(std::string& reason) override;
    bool cleanup(std::string& reason) override;
    Interruption interruption() const override { return interruption_; }
    const Environment& environment() const { return environment_; }

private:
    bool render_frame(std::string& reason);
    bool admit_seed(assets::AssetLease<assets::TextureAsset> seed, std::string& reason);
    bool finish_stream_preparation(std::string& reason);
    bool advance_source(std::uint64_t time_ms, std::string& reason);
    void service_requests();

    std::string id_;
    Platform platform_;
    Renderer renderer_;
    assets::AssetManager assets_;
    std::unique_ptr<jobs::InlineJobExecutor> executor_;
    std::shared_ptr<assets::AssetResidencyManager> residency_;
    assets::AssetRequestHandle<assets::TextureAsset> pending_seed_;
#ifndef __EMSCRIPTEN__
    std::unique_ptr<media::NativeVideoDecoder> decoder_;
    std::shared_ptr<const media::NativeVideoSource> source_;
#endif
    std::shared_ptr<WorldVideoStream> stream_;
    std::optional<assets::AssetLease<assets::TextureAsset>> sample_;
    Environment environment_;
    std::chrono::steady_clock::time_point epoch_{};
    std::uint64_t packet_index_ = 0;
    bool ready_ = false;
    bool diagnostic_ = false;
    double cpu_submission_ms_ = 0;
    double bgfx_frame_cpu_ms_ = 0;
    Interruption interruption_ = Interruption::None;
};

} // namespace noveltea::benchmark
