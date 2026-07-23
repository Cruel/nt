#include "host/job_executor_bootstrap.hpp"

#include "noveltea/assets/asset_manager.hpp"
#include "noveltea/audio/audio_backend.hpp"

#include <catch2/catch_test_macros.hpp>

#include <array>
#include <cstdio>
#include <cstdint>
#include <memory>
#include <string_view>
#include <vector>

namespace noveltea::host {
namespace {

void append_u16(std::vector<std::uint8_t>& bytes, std::uint16_t value)
{
    bytes.push_back(static_cast<std::uint8_t>(value & 0xffu));
    bytes.push_back(static_cast<std::uint8_t>((value >> 8u) & 0xffu));
}

void append_u32(std::vector<std::uint8_t>& bytes, std::uint32_t value)
{
    for (std::uint32_t shift = 0; shift < 32; shift += 8)
        bytes.push_back(static_cast<std::uint8_t>((value >> shift) & 0xffu));
}

void append_text(std::vector<std::uint8_t>& bytes, std::string_view text)
{
    bytes.insert(bytes.end(), text.begin(), text.end());
}

std::vector<std::uint8_t> short_pcm_wav()
{
    constexpr std::uint32_t sample_rate = 8'000;
    constexpr std::uint16_t channel_count = 1;
    constexpr std::uint16_t bits_per_sample = 16;
    constexpr std::array<std::int16_t, 64> samples{};
    constexpr std::uint32_t data_size = samples.size() * sizeof(samples.front());

    std::vector<std::uint8_t> bytes;
    bytes.reserve(44 + data_size);
    append_text(bytes, "RIFF");
    append_u32(bytes, 36 + data_size);
    append_text(bytes, "WAVEfmt ");
    append_u32(bytes, 16);
    append_u16(bytes, 1);
    append_u16(bytes, channel_count);
    append_u32(bytes, sample_rate);
    append_u32(bytes, sample_rate * channel_count * bits_per_sample / 8);
    append_u16(bytes, channel_count * bits_per_sample / 8);
    append_u16(bytes, bits_per_sample);
    append_text(bytes, "data");
    append_u32(bytes, data_size);
    for (const auto sample : samples)
        append_u16(bytes, static_cast<std::uint16_t>(sample));
    return bytes;
}

assets::AssetManager audio_assets()
{
    auto source = std::make_shared<assets::MemoryAssetSource>();
    source->add("project:/audio/phase3.wav", short_pcm_wav());
    assets::AssetManager assets;
    assets.mount("project", std::move(source));
    return assets;
}

void verify_resource_progress(const jobs::JobExecutionConfig& job_execution)
{
    auto assets = audio_assets();
    auto backend = make_miniaudio_backend({.enable_device = false});

    auto initialized = backend->initialize(assets, job_execution);
    if (!initialized) {
        std::fprintf(stderr, "%s: %s\n", initialized.error().code.c_str(),
                     initialized.error().message.c_str());
        CHECK(static_cast<bool>(initialized));
        return;
    }

    const auto info = backend->backend_info();
    CHECK(info.available);
    if (job_execution.mode == jobs::JobExecutionMode::Threaded) {
        CHECK(info.resource_manager_job_thread_count == 1);
        CHECK_FALSE(info.resource_manager_no_threading);
    } else {
        CHECK(info.resource_manager_job_thread_count == 0);
        CHECK(info.resource_manager_no_threading);
    }

    auto audio = backend->load_audio(assets::AudioAssetRequest{
        .path = "project:/audio/phase3.wav",
        .mode = AudioLoadMode::Decode,
        .kind = AudioClipKind::Sfx,
    });
    REQUIRE(audio);
    const auto voice = backend->play(audio.value->clip, {});
    REQUIRE(voice);

    const auto stats = backend->stats();
    CHECK(stats.clips_loaded == 1);
    CHECK(stats.voices_started == 1);
    CHECK(stats.backend_errors == 0);
    backend->shutdown();
}

TEST_CASE("miniaudio no-thread resource progress is target-independent")
{
    verify_resource_progress({.mode = jobs::JobExecutionMode::Cooperative, .worker_count = 0});
}

TEST_CASE("miniaudio threaded resource manager progresses in threaded host builds")
{
    auto bootstrap = make_job_executor_bootstrap();
    REQUIRE_FALSE(bootstrap.startup_failure.has_value());
    if (bootstrap.config.mode != jobs::JobExecutionMode::Threaded) {
        bootstrap.executor->begin_shutdown();
        SUCCEED("Host build has no threaded execution capability.");
        return;
    }
    verify_resource_progress(bootstrap.config);
    bootstrap.executor->begin_shutdown();
}

TEST_CASE("miniaudio follows the resolved host bootstrap capability")
{
    auto bootstrap = make_job_executor_bootstrap();
    REQUIRE_FALSE(bootstrap.startup_failure.has_value());
    verify_resource_progress(bootstrap.config);
    bootstrap.executor->begin_shutdown();
}

TEST_CASE("miniaudio rejects inconsistent execution configuration with typed diagnostics")
{
    auto assets = audio_assets();
    auto backend = make_miniaudio_backend({.enable_device = false});
    auto initialized =
        backend->initialize(assets, {.mode = jobs::JobExecutionMode::Threaded, .worker_count = 0});

    REQUIRE_FALSE(initialized);
    CHECK(initialized.error().code == "audio.invalid_job_execution_config");
    CHECK(initialized.error().severity == core::ErrorSeverity::Fatal);
}

} // namespace
} // namespace noveltea::host
