#include <catch2/catch_test_macros.hpp>

#include "noveltea/assets/asset_manager.hpp"
#include "noveltea/audio/audio_system.hpp"
#include "noveltea/jobs/cooperative_job_executor.hpp"
#include "noveltea/jobs/inline_job_executor.hpp"
#include "noveltea/jobs/sdl_thread_pool_job_executor.hpp"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <limits>
#include <memory>
#include <string>
#include <string_view>
#include <thread>
#include <utility>
#include <vector>

#define MINIZ_NO_ZLIB_APIS
#if __has_include(<miniz/miniz.h>)
#include <miniz/miniz.h>
#else
#include <miniz.h>
#endif

namespace {

using namespace noveltea;
using namespace std::chrono_literals;

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

std::vector<std::uint8_t> silent_pcm_wav(std::uint32_t seconds)
{
    constexpr std::uint32_t sample_rate = 48'000;
    constexpr std::uint16_t channel_count = 2;
    constexpr std::uint16_t bits_per_sample = 16;
    const std::uint32_t frame_count = sample_rate * seconds;
    const std::uint32_t data_size = frame_count * channel_count * bits_per_sample / 8u;

    std::vector<std::uint8_t> bytes;
    bytes.reserve(44u + data_size);
    append_text(bytes, "RIFF");
    append_u32(bytes, 36u + data_size);
    append_text(bytes, "WAVEfmt ");
    append_u32(bytes, 16);
    append_u16(bytes, 1);
    append_u16(bytes, channel_count);
    append_u32(bytes, sample_rate);
    append_u32(bytes, sample_rate * channel_count * bits_per_sample / 8u);
    append_u16(bytes, channel_count * bits_per_sample / 8u);
    append_u16(bytes, bits_per_sample);
    append_text(bytes, "data");
    append_u32(bytes, data_size);
    bytes.resize(44u + data_size, 0);
    return bytes;
}

assets::AssetBytes stored_zip(std::string_view path, const assets::AssetBytes& bytes)
{
    mz_zip_archive archive{};
    REQUIRE(mz_zip_writer_init_heap(&archive, 0, 0));
    REQUIRE(mz_zip_writer_add_mem(&archive, std::string(path).c_str(), bytes.data(), bytes.size(),
                                  MZ_NO_COMPRESSION));
    void* data = nullptr;
    std::size_t size = 0;
    REQUIRE(mz_zip_writer_finalize_heap_archive(&archive, &data, &size));
    REQUIRE(data != nullptr);
    const auto* first = static_cast<const std::uint8_t*>(data);
    assets::AssetBytes result(first, first + size);
    mz_free(data);
    REQUIRE(mz_zip_writer_end(&archive));
    return result;
}

assets::ResidencyBudget generous_budget()
{
    return {.source_bytes = 32u * 1024u * 1024u,
            .prepared_cpu_bytes = 32u * 1024u * 1024u,
            .gpu_bytes = 32u * 1024u * 1024u,
            .audio_bytes = 32u * 1024u * 1024u,
            .temporary_bytes = 32u * 1024u * 1024u};
}

struct ReaderProbe {
    std::atomic<std::uint64_t> opens = 0;
    std::atomic<std::uint64_t> reads = 0;
    std::atomic<std::uint64_t> seeks = 0;
    std::atomic<std::uint64_t> bytes_read = 0;
    std::atomic<std::uint64_t> maximum_read = 0;
};

class ProbedReader final : public assets::AssetReader {
public:
    ProbedReader(std::shared_ptr<const assets::AssetBytes> bytes,
                 std::shared_ptr<ReaderProbe> probe)
        : m_bytes(std::move(bytes)), m_probe(std::move(probe))
    {
    }

    assets::AssetResult<std::size_t> read(void* destination, std::size_t bytes) noexcept override
    {
        if (bytes != 0 && destination == nullptr) {
            return {std::nullopt,
                    {.code = std::string(assets::asset_source_error_code::read_failed),
                     .message = "test reader received a null destination",
                     .source_description = "probed-audio-source"}};
        }
        const auto count = std::min(bytes, m_bytes->size() - m_offset);
        if (count != 0)
            std::memcpy(destination, m_bytes->data() + m_offset, count);
        m_offset += count;
        m_probe->reads.fetch_add(1, std::memory_order_relaxed);
        m_probe->bytes_read.fetch_add(count, std::memory_order_relaxed);
        auto maximum = m_probe->maximum_read.load(std::memory_order_relaxed);
        while (maximum < bytes && !m_probe->maximum_read.compare_exchange_weak(
                                      maximum, bytes, std::memory_order_relaxed)) {}
        return {count, {}};
    }

    assets::AssetResult<void> seek(std::int64_t offset,
                                   assets::AssetSeekOrigin origin) noexcept override
    {
        std::int64_t base = 0;
        if (origin == assets::AssetSeekOrigin::Current)
            base = static_cast<std::int64_t>(m_offset);
        else if (origin == assets::AssetSeekOrigin::End)
            base = static_cast<std::int64_t>(m_bytes->size());
        const auto next = base + offset;
        if (next < 0 || static_cast<std::uint64_t>(next) > m_bytes->size()) {
            return {false,
                    {.code = std::string(assets::asset_source_error_code::seek_failed),
                     .message = "test seek is out of range",
                     .source_description = "probed-audio-source"}};
        }
        m_offset = static_cast<std::size_t>(next);
        m_probe->seeks.fetch_add(1, std::memory_order_relaxed);
        return {true, {}};
    }

    assets::AssetResult<std::uint64_t> tell() const noexcept override { return {m_offset, {}}; }
    assets::AssetResult<std::uint64_t> size() const noexcept override
    {
        return {m_bytes->size(), {}};
    }

private:
    std::shared_ptr<const assets::AssetBytes> m_bytes;
    std::shared_ptr<ReaderProbe> m_probe;
    std::size_t m_offset = 0;
};

class ProbedAudioSource final : public assets::AssetSource {
public:
    ProbedAudioSource(std::string path, assets::AssetBytes bytes, bool seekable,
                      std::shared_ptr<ReaderProbe> probe)
        : m_path(std::move(path)),
          m_bytes(std::make_shared<const assets::AssetBytes>(std::move(bytes))),
          m_seekable(seekable), m_probe(std::move(probe))
    {
    }

    assets::AssetResult<assets::AssetEntryMetadata>
    stat(const assets::AssetPath& path) const override
    {
        if (!exists(path)) {
            return {std::nullopt,
                    {.code = std::string(assets::asset_source_error_code::not_found),
                     .message = "missing test audio",
                     .logical_path = path,
                     .source_description = describe()}};
        }
        return {assets::AssetEntryMetadata{.uncompressed_size = m_bytes->size(),
                                           .compressed_size = std::nullopt,
                                           .seekable = m_seekable},
                {}};
    }

    assets::AssetResult<assets::AssetReaderPtr> open(const assets::AssetPath& path) const override
    {
        if (!exists(path)) {
            return {std::nullopt,
                    {.code = std::string(assets::asset_source_error_code::not_found),
                     .message = "missing test audio",
                     .logical_path = path,
                     .source_description = describe()}};
        }
        m_probe->opens.fetch_add(1, std::memory_order_relaxed);
        return {std::make_unique<ProbedReader>(m_bytes, m_probe), {}};
    }

    bool exists(const assets::AssetPath& path) const override
    {
        return path.relative_path() == m_path;
    }

    std::string describe() const override { return "probed-audio-source"; }
    const char* kind() const override { return "test-audio"; }

private:
    std::string m_path;
    std::shared_ptr<const assets::AssetBytes> m_bytes;
    bool m_seekable = true;
    std::shared_ptr<ReaderProbe> m_probe;
};

class BinaryReadCountingSource final : public assets::AssetSource {
public:
    explicit BinaryReadCountingSource(assets::AssetSourcePtr source) : m_source(std::move(source))
    {
    }

    assets::AssetResult<assets::AssetEntryMetadata>
    stat(const assets::AssetPath& path) const override
    {
        return m_source->stat(path);
    }

    assets::AssetResult<assets::AssetReaderPtr> open(const assets::AssetPath& path) const override
    {
        return m_source->open(path);
    }

    assets::AssetResult<assets::AssetBlob> read_binary(const assets::AssetPath& path) const override
    {
        m_binary_reads.fetch_add(1, std::memory_order_relaxed);
        return m_source->read_binary(path);
    }

    bool exists(const assets::AssetPath& path) const override { return m_source->exists(path); }
    std::string describe() const override { return "counted " + m_source->describe(); }
    const char* kind() const override { return "counted-package"; }
    [[nodiscard]] std::uint64_t binary_reads() const noexcept
    {
        return m_binary_reads.load(std::memory_order_relaxed);
    }

private:
    assets::AssetSourcePtr m_source;
    mutable std::atomic<std::uint64_t> m_binary_reads = 0;
};

template<class Predicate> bool drive_until(jobs::InlineJobExecutor& executor, Predicate predicate)
{
    for (std::size_t iteration = 0; iteration < 4096; ++iteration) {
        (void)executor.dispatch_owner_completions(std::numeric_limits<std::size_t>::max());
        if (predicate())
            return true;
        if (!executor.advance_one_step())
            return predicate();
    }
    return false;
}

template<class Predicate>
bool drive_until(jobs::CooperativeJobExecutor& executor, Predicate predicate)
{
    for (std::size_t iteration = 0; iteration < 4096; ++iteration) {
        executor.pump(5ms);
        (void)executor.dispatch_owner_completions(std::numeric_limits<std::size_t>::max());
        if (predicate())
            return true;
    }
    return false;
}

template<class Predicate>
bool drive_until(jobs::SdlThreadPoolJobExecutor& executor, Predicate predicate)
{
    const auto deadline = std::chrono::steady_clock::now() + 10s;
    while (std::chrono::steady_clock::now() < deadline) {
        executor.pump(0ns);
        (void)executor.dispatch_owner_completions(std::numeric_limits<std::size_t>::max());
        if (predicate())
            return true;
        std::this_thread::sleep_for(1ms);
    }
    return false;
}

void shutdown(jobs::InlineJobExecutor& executor)
{
    executor.begin_shutdown();
    (void)executor.dispatch_owner_completions(std::numeric_limits<std::size_t>::max());
    REQUIRE(executor.shutdown_complete());
}

void shutdown(jobs::CooperativeJobExecutor& executor)
{
    executor.begin_shutdown();
    (void)executor.dispatch_owner_completions(std::numeric_limits<std::size_t>::max());
    REQUIRE(executor.shutdown_complete());
}

void shutdown(jobs::SdlThreadPoolJobExecutor& executor)
{
    executor.begin_shutdown();
    REQUIRE(drive_until(executor, [&] { return executor.shutdown_complete(); }));
}

template<class Executor> jobs::JobExecutionConfig execution_config(const Executor& executor)
{
    return {.mode = executor.mode(),
            .worker_count = executor.mode() == jobs::JobExecutionMode::Threaded ? 1u : 0u};
}

template<class Executor> void run_decoded_cache_contract(Executor& executor)
{
    auto probe = std::make_shared<ReaderProbe>();
    core::AssetTelemetryRecorder telemetry(256);
    auto residency = std::make_shared<assets::AssetResidencyManager>(generous_budget(), &telemetry,
                                                                     executor.mode());

    {
        assets::AssetManager manager;
        manager.mount("project", std::make_shared<ProbedAudioSource>(
                                     "audio/sfx.wav", silent_pcm_wav(2), true, probe));
        AudioSystem audio(make_miniaudio_backend({.enable_device = false}));
        REQUIRE(audio.initialize(manager, execution_config(executor)));
        manager.bind_audio_loader(&audio);
        REQUIRE(manager.configure_async_requests(executor, residency, &telemetry));

        const assets::AudioAssetRequest request{.path = "project:/audio/sfx.wav",
                                                .mode = AudioLoadMode::Decode,
                                                .kind = AudioClipKind::Sfx};
        auto requested = manager.request_audio(request, assets::AssetRequestReason::Demand);
        REQUIRE(requested);
        auto handle = std::move(requested).value();
        REQUIRE(drive_until(executor,
                            [&] { return handle.state() == assets::AssetRequestState::Ready; }));
        CHECK(probe->maximum_read.load(std::memory_order_relaxed) <= 256u * 1024u);
        CHECK(probe->bytes_read.load(std::memory_order_relaxed) == silent_pcm_wav(2).size());
        CHECK(residency->accounting_on_owner().current.audio_bytes ==
              2u * 48'000u * 2u * sizeof(float));

        auto lease = std::move(handle).take_ready();
        REQUIRE(lease);
        const auto key = lease->cache_key();
        const auto voice = audio.play(std::move(*lease), {});
        REQUIRE(voice);
        CHECK_FALSE(
            residency->evict_on_owner(key, assets::ResidencyEvictionReason::ExplicitRelease));

        audio.stop(voice);
        audio.update(0.0f);
        CHECK(residency->evict_on_owner(key, assets::ResidencyEvictionReason::BudgetPressure));
        CHECK(residency->accounting_on_owner().current.audio_bytes == 0);

        auto reloaded_result = manager.request_audio(request, assets::AssetRequestReason::Demand);
        REQUIRE(reloaded_result);
        auto reloaded = std::move(reloaded_result).value();
        REQUIRE(drive_until(executor,
                            [&] { return reloaded.state() == assets::AssetRequestState::Ready; }));
        auto reloaded_lease = std::move(reloaded).take_ready();
        REQUIRE(reloaded_lease);
        const auto reload_key = reloaded_lease->cache_key();
        reloaded_lease->reset();
        CHECK(residency->evict_on_owner(reload_key,
                                        assets::ResidencyEvictionReason::ExplicitRelease));
        CHECK(audio.backend_stats().clips_loaded == 2);

        const auto source_size = silent_pcm_wav(2).size();
        const auto snapshot = telemetry.snapshot_on_owner();
        CHECK(snapshot.aggregates.compressed_bytes_read == source_size * 2u);
        CHECK(snapshot.aggregates.uncompressed_bytes_read == source_size * 2u);
        CHECK(snapshot.aggregates.source_read_duration > 0ns);
        CHECK(snapshot.aggregates.preparation_duration > 0ns);
        CHECK(snapshot.aggregates.owner_finalization_duration > 0ns);
        CHECK(snapshot.memory.high_water.audio_bytes == 2u * 48'000u * 2u * sizeof(float));
        CHECK(snapshot.event_counts[static_cast<std::size_t>(
                  core::AssetTelemetryEventKind::ReloadedAfterEviction)] == 1);

        manager.bind_audio_loader(nullptr);
        audio.shutdown();
    }
    shutdown(executor);
}

TEST_CASE("Audio preparation builds bounded decoded caches in every executor mode",
          "[assets][residency-matrix][telemetry-matrix]")
{
    SECTION("inline")
    {
        jobs::InlineJobExecutor executor;
        run_decoded_cache_contract(executor);
    }
    SECTION("cooperative")
    {
        jobs::CooperativeJobExecutor executor;
        run_decoded_cache_contract(executor);
    }
    SECTION("threaded")
    {
        jobs::SdlThreadPoolJobExecutor executor(1);
        run_decoded_cache_contract(executor);
    }
}

TEST_CASE("Decoded audio prefetch expands its reservation before allocating PCM")
{
    jobs::InlineJobExecutor executor;
    auto budget = generous_budget();
    budget.temporary_bytes = 300u * 1024u;
    core::AssetTelemetryRecorder telemetry(128);
    auto residency =
        std::make_shared<assets::AssetResidencyManager>(budget, &telemetry, executor.mode());
    auto probe = std::make_shared<ReaderProbe>();

    {
        assets::AssetManager manager;
        manager.mount("project", std::make_shared<ProbedAudioSource>(
                                     "audio/sfx.wav", silent_pcm_wav(1), true, probe));
        AudioSystem audio(make_miniaudio_backend({.enable_device = false}));
        REQUIRE(audio.initialize(manager, execution_config(executor)));
        manager.bind_audio_loader(&audio);
        REQUIRE(manager.configure_async_requests(executor, residency, &telemetry));

        const auto generation = manager.create_prefetch_generation_on_owner();
        REQUIRE(generation);
        auto requested = manager.prefetch_audio({.path = "project:/audio/sfx.wav",
                                                 .mode = AudioLoadMode::Decode,
                                                 .kind = AudioClipKind::Sfx},
                                                generation.value());
        REQUIRE(requested);
        auto ticket = std::move(requested).value();

        for (std::size_t iteration = 0; iteration < 32; ++iteration) {
            (void)executor.dispatch_owner_completions(std::numeric_limits<std::size_t>::max());
            if (!executor.advance_one_step())
                break;
        }
        (void)executor.dispatch_owner_completions(std::numeric_limits<std::size_t>::max());

        CHECK(audio.backend_stats().clips_loaded == 0);
        CHECK(residency->accounting_on_owner().current.temporary_bytes == 0);
        CHECK(residency->accounting_on_owner().high_water.temporary_bytes < budget.temporary_bytes);
        const auto snapshot = telemetry.snapshot_on_owner();
        CHECK(snapshot.event_counts[static_cast<std::size_t>(
                  core::AssetTelemetryEventKind::RequestCanceled)] == 1);
        ticket.reset();
        manager.bind_audio_loader(nullptr);
        audio.shutdown();
    }
    shutdown(executor);
}

template<class Executor> void run_streaming_contract(Executor& executor)
{
    const auto long_wav = silent_pcm_wav(12);
    auto original_probe = std::make_shared<ReaderProbe>();
    auto replacement_probe = std::make_shared<ReaderProbe>();
    auto residency = std::make_shared<assets::AssetResidencyManager>(generous_budget());

    {
        assets::AssetManager manager;
        manager.mount("project", std::make_shared<ProbedAudioSource>("audio/music.wav", long_wav,
                                                                     true, original_probe));
        AudioSystem audio(make_miniaudio_backend({.enable_device = false}));
        REQUIRE(audio.initialize(manager, execution_config(executor)));
        manager.bind_audio_loader(&audio);
        REQUIRE(manager.configure_async_requests(executor, residency));

        const assets::AudioAssetRequest request{.path = "project:/audio/music.wav",
                                                .mode = AudioLoadMode::Stream,
                                                .kind = AudioClipKind::Music};
        auto requested = manager.request_audio(request, assets::AssetRequestReason::Demand);
        REQUIRE(requested);
        auto handle = std::move(requested).value();
        REQUIRE(drive_until(executor,
                            [&] { return handle.state() == assets::AssetRequestState::Ready; }));
        CHECK(original_probe->bytes_read.load(std::memory_order_relaxed) == 0);
        CHECK(residency->accounting_on_owner().current.audio_bytes ==
              2u * 48'000u * 2u * sizeof(float));

        auto lease = std::move(handle).take_ready();
        REQUIRE(lease);
        const auto key = lease->cache_key();
        assets::AssetManager::NamespaceMounts replacement;
        replacement.push_back(std::make_shared<ProbedAudioSource>(
            "audio/music.wav", silent_pcm_wav(12), true, replacement_probe));
        (void)manager.replace_namespace("project", std::move(replacement));

        const auto track =
            audio.play_track("bgm", std::move(*lease), {.bus = AudioBus::Music, .loop = true});
        REQUIRE(track);
        CHECK(audio.track_active("bgm"));
        CHECK(original_probe->bytes_read.load(std::memory_order_relaxed) > 0);
        CHECK(original_probe->bytes_read.load(std::memory_order_relaxed) < long_wav.size());
        CHECK(original_probe->maximum_read.load(std::memory_order_relaxed) < long_wav.size());
        CHECK(original_probe->seeks.load(std::memory_order_relaxed) >= 2);
        CHECK(replacement_probe->bytes_read.load(std::memory_order_relaxed) == 0);
        CHECK_FALSE(
            residency->evict_on_owner(key, assets::ResidencyEvictionReason::ExplicitRelease));

        audio.stop_track("bgm");
        audio.update(0.0f);
        CHECK_FALSE(audio.track_active("bgm"));
        CHECK_FALSE(residency->resident_on_owner(key));
        CHECK(residency->accounting_on_owner().current.audio_bytes == 0);

        manager.bind_audio_loader(nullptr);
        audio.shutdown();
    }
    shutdown(executor);
}

TEST_CASE("Seekable audio streaming stays bounded and source-generation stable",
          "[assets][residency-matrix]")
{
    SECTION("cooperative")
    {
        jobs::CooperativeJobExecutor executor;
        run_streaming_contract(executor);
    }
    SECTION("threaded")
    {
        jobs::SdlThreadPoolJobExecutor executor(1);
        run_streaming_contract(executor);
    }
}

TEST_CASE("Stored package audio streams without whole-entry AssetBlob residency",
          "[assets][residency-matrix][telemetry-matrix]")
{
    jobs::CooperativeJobExecutor executor;
    const auto wav = silent_pcm_wav(8);
    auto package = std::make_shared<assets::ZipAssetSource>(stored_zip("audio/music.wav", wav));
    auto counted = std::make_shared<BinaryReadCountingSource>(package);
    core::AssetTelemetryRecorder telemetry(128);
    auto residency = std::make_shared<assets::AssetResidencyManager>(generous_budget(), &telemetry,
                                                                     executor.mode());

    {
        assets::AssetManager manager;
        manager.mount("project", counted);
        AudioSystem audio(make_miniaudio_backend({.enable_device = false}));
        REQUIRE(audio.initialize(manager, execution_config(executor)));
        manager.bind_audio_loader(&audio);
        REQUIRE(manager.configure_async_requests(executor, residency, &telemetry));

        auto requested = manager.request_audio({.path = "project:/audio/music.wav",
                                                .mode = AudioLoadMode::Stream,
                                                .kind = AudioClipKind::Music},
                                               assets::AssetRequestReason::Demand);
        REQUIRE(requested);
        auto handle = std::move(requested).value();
        REQUIRE(drive_until(executor,
                            [&] { return handle.state() == assets::AssetRequestState::Ready; }));
        CHECK(counted->binary_reads() == 0);

        auto lease = std::move(handle).take_ready();
        REQUIRE(lease);
        const auto key = lease->cache_key();
        const auto voice = audio.play(std::move(*lease), {.bus = AudioBus::Music});
        REQUIRE(voice);
        CHECK(counted->binary_reads() == 0);
        CHECK_FALSE(
            residency->evict_on_owner(key, assets::ResidencyEvictionReason::ExplicitRelease));

        audio.stop(voice);
        audio.update(0.0f);
        CHECK(residency->evict_on_owner(key, assets::ResidencyEvictionReason::ExplicitRelease));
        const auto snapshot = telemetry.snapshot_on_owner();
        CHECK(snapshot.aggregates.compressed_bytes_read == 0);
        CHECK(snapshot.aggregates.uncompressed_bytes_read == 0);
        CHECK(snapshot.aggregates.source_read_duration > 0ns);
        CHECK(snapshot.aggregates.owner_finalization_duration > 0ns);
        CHECK(snapshot.memory.high_water.audio_bytes == 2u * 48'000u * 2u * sizeof(float));
        manager.bind_audio_loader(nullptr);
        audio.shutdown();
    }
    shutdown(executor);
}

TEST_CASE("Long-form audio rejects non-seekable package entries with typed diagnostics")
{
    jobs::InlineJobExecutor executor;
    auto residency = std::make_shared<assets::AssetResidencyManager>(generous_budget());
    auto probe = std::make_shared<ReaderProbe>();

    {
        assets::AssetManager manager;
        manager.mount("project", std::make_shared<ProbedAudioSource>(
                                     "audio/music.wav", silent_pcm_wav(1), false, probe));
        AudioSystem audio(make_miniaudio_backend({.enable_device = false}));
        REQUIRE(audio.initialize(manager, execution_config(executor)));
        manager.bind_audio_loader(&audio);
        REQUIRE(manager.configure_async_requests(executor, residency));

        auto requested = manager.request_audio({.path = "project:/audio/music.wav",
                                                .mode = AudioLoadMode::Stream,
                                                .kind = AudioClipKind::Music},
                                               assets::AssetRequestReason::Demand);
        REQUIRE(requested);
        auto handle = std::move(requested).value();
        REQUIRE(drive_until(executor,
                            [&] { return handle.state() == assets::AssetRequestState::Failed; }));
        REQUIRE_FALSE(handle.diagnostics().empty());
        CHECK(handle.diagnostics().front().code == "audio.stream_not_seekable");
        CHECK(probe->bytes_read.load(std::memory_order_relaxed) == 0);
        CHECK(residency->accounting_on_owner().current.audio_bytes == 0);

        manager.bind_audio_loader(nullptr);
        audio.shutdown();
    }
    shutdown(executor);
}

TEST_CASE("Canceled audio preparation never enters the resident cache")
{
    jobs::InlineJobExecutor executor;
    auto residency = std::make_shared<assets::AssetResidencyManager>(generous_budget());
    auto probe = std::make_shared<ReaderProbe>();

    {
        assets::AssetManager manager;
        manager.mount("project", std::make_shared<ProbedAudioSource>(
                                     "audio/sfx.wav", silent_pcm_wav(4), true, probe));
        AudioSystem audio(make_miniaudio_backend({.enable_device = false}));
        REQUIRE(audio.initialize(manager, execution_config(executor)));
        manager.bind_audio_loader(&audio);
        REQUIRE(manager.configure_async_requests(executor, residency));

        auto requested = manager.request_audio({.path = "project:/audio/sfx.wav",
                                                .mode = AudioLoadMode::Decode,
                                                .kind = AudioClipKind::Sfx},
                                               assets::AssetRequestReason::Demand);
        REQUIRE(requested);
        auto handle = std::move(requested).value();
        REQUIRE(executor.advance_one_step());
        handle.cancel();
        REQUIRE(drive_until(executor,
                            [&] { return handle.state() == assets::AssetRequestState::Canceled; }));
        CHECK(audio.backend_stats().clips_loaded == 0);
        CHECK(residency->accounting_on_owner().current.audio_bytes == 0);

        manager.bind_audio_loader(nullptr);
        audio.shutdown();
    }
    shutdown(executor);
}

TEST_CASE("Mandatory audio demand reports cache pressure without losing residency accounting")
{
    jobs::InlineJobExecutor executor;
    auto budget = generous_budget();
    budget.audio_bytes = 64u * 1024u;
    auto residency = std::make_shared<assets::AssetResidencyManager>(budget);
    auto probe = std::make_shared<ReaderProbe>();

    {
        assets::AssetManager manager;
        manager.mount("project", std::make_shared<ProbedAudioSource>(
                                     "audio/sfx.wav", silent_pcm_wav(1), true, probe));
        AudioSystem audio(make_miniaudio_backend({.enable_device = false}));
        REQUIRE(audio.initialize(manager, execution_config(executor)));
        manager.bind_audio_loader(&audio);
        REQUIRE(manager.configure_async_requests(executor, residency));

        auto requested = manager.request_audio({.path = "project:/audio/sfx.wav",
                                                .mode = AudioLoadMode::Decode,
                                                .kind = AudioClipKind::Sfx},
                                               assets::AssetRequestReason::Demand);
        REQUIRE(requested);
        auto handle = std::move(requested).value();
        REQUIRE(drive_until(executor,
                            [&] { return handle.state() == assets::AssetRequestState::Ready; }));
        REQUIRE_FALSE(handle.diagnostics().empty());
        CHECK(handle.diagnostics().front().code == "assets.mandatory_residency_over_budget");
        CHECK(residency->accounting_on_owner().current.audio_bytes > budget.audio_bytes);

        auto lease = std::move(handle).take_ready();
        REQUIRE(lease);
        const auto key = lease->cache_key();
        lease->reset();
        CHECK_FALSE(residency->resident_on_owner(key));
        CHECK(residency->accounting_on_owner().current.audio_bytes == 0);

        manager.bind_audio_loader(nullptr);
        audio.shutdown();
    }
    shutdown(executor);
}

} // namespace
