#include "noveltea/audio/audio_backend.hpp"

#include "noveltea/assets/asset_manager.hpp"
#include "assets/asset_preparation_io.hpp"

#define MINIAUDIO_IMPLEMENTATION
#include <miniaudio.h>

#include <algorithm>
#include <cstdio>
#include <limits>
#include <memory>
#include <mutex>
#include <new>
#include <optional>
#include <string>
#include <string_view>
#include <unordered_map>
#include <utility>
#include <vector>

namespace noveltea {
namespace {

constexpr ma_format kPreparedAudioFormat = ma_format_f32;
constexpr ma_uint32 kPreparedAudioChannels = 2;
constexpr ma_uint32 kPreparedAudioSampleRate = 48'000;
constexpr std::uint64_t kStreamingPageCount = 2;
constexpr std::uint64_t kStreamingAudioBytes =
    kStreamingPageCount * kPreparedAudioSampleRate * kPreparedAudioChannels * sizeof(float);

template<class T> assets::AssetLoadResult<T> fail(std::string message)
{
    return {std::nullopt, std::move(message)};
}

const char* ma_error_name(ma_result result)
{
    switch (result) {
    case MA_SUCCESS:
        return "success";
    case MA_ERROR:
        return "generic error";
    case MA_INVALID_ARGS:
        return "invalid arguments";
    case MA_INVALID_OPERATION:
        return "invalid operation";
    case MA_INVALID_FILE:
        return "invalid file";
    case MA_DOES_NOT_EXIST:
        return "does not exist";
    case MA_OUT_OF_MEMORY:
        return "out of memory";
    case MA_DEVICE_NOT_INITIALIZED:
        return "device not initialized";
    case MA_DEVICE_NOT_STARTED:
        return "device not started";
    case MA_FORMAT_NOT_SUPPORTED:
        return "format not supported";
    default:
        return "miniaudio error";
    }
}

core::Diagnostic initialization_failure(std::string code, std::string operation, ma_result result)
{
    return core::Diagnostic{
        .code = std::move(code),
        .message = std::move(operation) + ": " + ma_error_name(result) + " (" +
                   std::to_string(result) + ")",
        .severity = core::ErrorSeverity::Fatal,
    };
}

AudioLoadMode resolved_mode(AudioLoadMode mode, AudioClipKind kind)
{
    if (mode != AudioLoadMode::Auto)
        return mode;
    return kind == AudioClipKind::Sfx ? AudioLoadMode::Decode : AudioLoadMode::Stream;
}

ma_result source_error_result(const assets::AssetSourceError& error)
{
    return error.code == assets::asset_source_error_code::not_found ? MA_DOES_NOT_EXIST : MA_ERROR;
}

struct AssetVfsFile {
    assets::AssetReaderPtr reader;
};

struct AssetVfs {
    AssetVfs()
    {
        callbacks.onOpen = &open;
        callbacks.onOpenW = nullptr;
        callbacks.onClose = &close;
        callbacks.onRead = &read;
        callbacks.onWrite = nullptr;
        callbacks.onSeek = &seek;
        callbacks.onTell = &tell;
        callbacks.onInfo = &info;
    }

    [[nodiscard]] ma_vfs* handle() noexcept { return reinterpret_cast<ma_vfs*>(this); }

    void register_factory(std::string name, assets::AssetReaderFactory factory)
    {
        std::scoped_lock lock(mutex);
        factories.insert_or_assign(std::move(name), std::move(factory));
    }

    void unregister_factory(std::string_view name)
    {
        std::scoped_lock lock(mutex);
        factories.erase(std::string(name));
    }

    void clear()
    {
        std::scoped_lock lock(mutex);
        factories.clear();
    }

    static ma_result open(ma_vfs* vfs, const char* path, ma_uint32 open_mode, ma_vfs_file* file)
    {
        if (vfs == nullptr || path == nullptr || file == nullptr ||
            (open_mode & MA_OPEN_MODE_READ) == 0 || (open_mode & MA_OPEN_MODE_WRITE) != 0) {
            return MA_INVALID_ARGS;
        }
        auto& self = *reinterpret_cast<AssetVfs*>(vfs);
        assets::AssetReaderFactory factory;
        {
            std::scoped_lock lock(self.mutex);
            const auto found = self.factories.find(path);
            if (found == self.factories.end())
                return MA_DOES_NOT_EXIST;
            factory = found->second;
        }
        auto opened = factory.open();
        if (!opened)
            return source_error_result(opened.error);
        auto holder = std::unique_ptr<AssetVfsFile>(new (std::nothrow) AssetVfsFile());
        if (holder == nullptr)
            return MA_OUT_OF_MEMORY;
        holder->reader = std::move(*opened.value);
        *file = holder.release();
        return MA_SUCCESS;
    }

    static ma_result close(ma_vfs*, ma_vfs_file file)
    {
        delete static_cast<AssetVfsFile*>(file);
        return MA_SUCCESS;
    }

    static ma_result read(ma_vfs* vfs, ma_vfs_file file, void* destination, std::size_t bytes,
                          std::size_t* bytes_read)
    {
        if (vfs == nullptr || file == nullptr || destination == nullptr || bytes_read == nullptr)
            return MA_INVALID_ARGS;
        auto& holder = *static_cast<AssetVfsFile*>(file);
        auto result = holder.reader->read(destination, bytes);
        if (!result)
            return source_error_result(result.error);
        *bytes_read = *result.value;
        return MA_SUCCESS;
    }

    static ma_result seek(ma_vfs* vfs, ma_vfs_file file, ma_int64 offset, ma_seek_origin origin)
    {
        if (vfs == nullptr || file == nullptr)
            return MA_INVALID_ARGS;
        auto& holder = *static_cast<AssetVfsFile*>(file);
        assets::AssetSeekOrigin mapped = assets::AssetSeekOrigin::Begin;
        if (origin == ma_seek_origin_current)
            mapped = assets::AssetSeekOrigin::Current;
        else if (origin == ma_seek_origin_end)
            mapped = assets::AssetSeekOrigin::End;
        auto result = holder.reader->seek(offset, mapped);
        if (!result)
            return source_error_result(result.error);
        return MA_SUCCESS;
    }

    static ma_result tell(ma_vfs*, ma_vfs_file file, ma_int64* cursor)
    {
        if (file == nullptr || cursor == nullptr)
            return MA_INVALID_ARGS;
        auto& holder = *static_cast<AssetVfsFile*>(file);
        auto result = holder.reader->tell();
        if (!result)
            return source_error_result(result.error);
        if (*result.value > static_cast<std::uint64_t>(std::numeric_limits<ma_int64>::max()))
            return MA_TOO_BIG;
        *cursor = static_cast<ma_int64>(*result.value);
        return MA_SUCCESS;
    }

    static ma_result info(ma_vfs*, ma_vfs_file file, ma_file_info* file_info)
    {
        if (file == nullptr || file_info == nullptr)
            return MA_INVALID_ARGS;
        auto& holder = *static_cast<AssetVfsFile*>(file);
        auto result = holder.reader->size();
        if (!result)
            return source_error_result(result.error);
        file_info->sizeInBytes = *result.value;
        return MA_SUCCESS;
    }

    ma_vfs_callbacks callbacks{};
    std::mutex mutex;
    std::unordered_map<std::string, assets::AssetReaderFactory> factories;
};

struct PreparedAudioClipData {
    assets::AudioAssetRequest request;
    AudioLoadMode mode = AudioLoadMode::Auto;
    assets::AssetReaderFactory stream_factory;
    std::vector<float> pcm_frames;
    std::uint64_t source_bytes = 0;
};

class AudioPreparationOwner {
public:
    virtual ~AudioPreparationOwner() = default;
    [[nodiscard]] virtual core::Result<assets::PreparedAsset<assets::AudioAsset>, core::Diagnostics>
    finalize_audio_on_owner(PreparedAudioClipData prepared) noexcept = 0;
};

class MiniaudioAudioPreparationTask final
    : public assets::AssetPreparationTask<assets::AudioAsset> {
public:
    MiniaudioAudioPreparationTask(const assets::AssetManager& assets, AudioPreparationOwner& owner,
                                  assets::AudioAssetRequest request)
        : m_assets(assets), m_owner(owner), m_request(std::move(request)),
          m_mode(resolved_mode(m_request.mode, m_request.kind)),
          m_read(m_assets, m_request.path, "audio.prepare")
    {
        const auto source_size = assets::detail::estimated_source_size(m_assets, m_request.path);
        m_estimated_cost = {.temporary_bytes = m_mode == AudioLoadMode::Decode ? source_size : 0};
    }

    ~MiniaudioAudioPreparationTask() override
    {
        if (m_decoder_initialized)
            ma_decoder_uninit(&m_decoder);
    }

    [[nodiscard]] assets::ResidencyCost estimated_cost_on_owner() const noexcept override
    {
        return m_estimated_cost;
    }

    [[nodiscard]] bool reservation_update_required_on_owner() const noexcept override
    {
        return m_awaiting_reservation_update;
    }

    void reservation_update_granted_on_owner() noexcept override
    {
        if (!m_awaiting_reservation_update || m_decode_state != DecodeState::AwaitingReservation)
            return;
        m_awaiting_reservation_update = false;
        constexpr std::size_t bytes_per_frame = sizeof(float) * kPreparedAudioChannels;
        const std::size_t frames_per_step = std::max<std::size_t>(
            1, assets::detail::asset_preparation_read_chunk_bytes / bytes_per_frame);
        m_decode_chunk.resize(frames_per_step * kPreparedAudioChannels);
        m_pcm_frames.reserve(m_expected_sample_count);
        m_decode_state = DecodeState::Decoding;
    }

    [[nodiscard]] assets::AssetCacheState cache_state_for_next_step() const noexcept override
    {
        if (m_mode == AudioLoadMode::Stream || m_decode_state == DecodeState::Reading)
            return assets::AssetCacheState::Reading;
        return assets::AssetCacheState::Preparing;
    }

    [[nodiscard]] assets::AssetPreparationTelemetry telemetry_on_owner() const noexcept override
    {
        if (m_mode == AudioLoadMode::Stream)
            return {};
        return {.compressed_bytes = m_compressed_source_bytes,
                .uncompressed_bytes = m_source_bytes};
    }

    [[nodiscard]] jobs::JobStepOutcome step(jobs::JobContext& context) noexcept override
    {
        if (context.cancellation_requested())
            return {.status = jobs::JobStepStatus::Completed, .diagnostics = {}};
        if (m_failed)
            return {.status = jobs::JobStepStatus::Failed, .diagnostics = m_diagnostics};
        if (m_ready)
            return {.status = jobs::JobStepStatus::Completed, .diagnostics = {}};
        if (m_request.path.empty())
            return fail("audio.invalid_path", "audio asset path is empty");
        if (m_mode == AudioLoadMode::Stream)
            return prepare_stream();
        return prepare_decoded(context);
    }

    [[nodiscard]] core::Result<assets::PreparedAsset<assets::AudioAsset>, core::Diagnostics>
    finalize_on_owner() noexcept override
    {
        if (!m_ready) {
            return core::Result<assets::PreparedAsset<assets::AudioAsset>, core::Diagnostics>::
                failure({{.code = "audio.preparation_incomplete",
                          .message = "audio preparation did not complete before finalization"}});
        }
        return m_owner.finalize_audio_on_owner({.request = std::move(m_request),
                                                .mode = m_mode,
                                                .stream_factory = std::move(m_stream_factory),
                                                .pcm_frames = std::move(m_pcm_frames),
                                                .source_bytes = m_source_bytes});
    }

private:
    enum class DecodeState : std::uint8_t {
        Reading,
        Initializing,
        AwaitingReservation,
        Decoding,
    };

    [[nodiscard]] jobs::JobStepOutcome prepare_stream() noexcept
    {
        auto factory = m_assets.reader_factory(m_request.path);
        if (!factory) {
            return fail("audio.stream_source_unavailable",
                        "failed to resolve seekable stream source '" + m_request.path +
                            "': " + factory.error.message);
        }
        auto metadata = factory.value->stat();
        if (!metadata) {
            return fail("audio.stream_source_unavailable", "failed to inspect stream source '" +
                                                               m_request.path +
                                                               "': " + metadata.error.message);
        }
        if (!metadata.value->seekable) {
            return fail("audio.stream_not_seekable",
                        "long-form audio requires a directly seekable source: '" + m_request.path +
                            "'");
        }
        m_compressed_source_bytes =
            metadata.value->compressed_size.value_or(metadata.value->uncompressed_size);
        auto opened = factory.value->open();
        if (!opened) {
            return fail("audio.stream_open_failed", "failed to open stream source '" +
                                                        m_request.path +
                                                        "': " + opened.error.message);
        }
        auto size = (*opened.value)->size();
        if (!size) {
            return fail("audio.stream_size_failed", "failed to determine stream size for '" +
                                                        m_request.path +
                                                        "': " + size.error.message);
        }
        auto end_seek = (*opened.value)->seek(0, assets::AssetSeekOrigin::End);
        auto begin_seek = (*opened.value)->seek(0, assets::AssetSeekOrigin::Begin);
        if (!end_seek || !begin_seek) {
            const auto& error = !end_seek ? end_seek.error : begin_seek.error;
            return fail("audio.stream_seek_failed",
                        "stream source failed direct seek validation for '" + m_request.path +
                            "': " + error.message);
        }
        m_source_bytes = *size.value;
        m_stream_factory = std::move(*factory.value);
        m_ready = true;
        return {.status = jobs::JobStepStatus::Completed, .diagnostics = {}};
    }

    [[nodiscard]] jobs::JobStepOutcome prepare_decoded(jobs::JobContext& context) noexcept
    {
        if (m_decode_state == DecodeState::Reading) {
            auto outcome = m_read.step(context);
            if (outcome.status == jobs::JobStepStatus::Failed)
                return outcome;
            if (!m_read.ready())
                return outcome;
            m_source_bytes = m_read.total_bytes();
            m_compressed_source_bytes = m_read.compressed_bytes();
            m_decode_state = DecodeState::Initializing;
            return {.status = jobs::JobStepStatus::Yielded, .diagnostics = {}};
        }

        if (m_decode_state == DecodeState::Initializing) {
            if (m_read.bytes().empty())
                return fail("audio.decode_empty", "audio asset is empty: '" + m_request.path + "'");
            const auto config = ma_decoder_config_init(kPreparedAudioFormat, kPreparedAudioChannels,
                                                       kPreparedAudioSampleRate);
            const auto result = ma_decoder_init_memory(m_read.bytes().data(), m_read.bytes().size(),
                                                       &config, &m_decoder);
            if (result != MA_SUCCESS) {
                return fail("audio.decode_initialization_failed",
                            "failed to initialize audio decoder for '" + m_request.path +
                                "': " + ma_error_name(result));
            }
            m_decoder_initialized = true;
            constexpr std::size_t bytes_per_frame = sizeof(float) * kPreparedAudioChannels;
            const std::size_t frames_per_step = std::max<std::size_t>(
                1, assets::detail::asset_preparation_read_chunk_bytes / bytes_per_frame);
            ma_uint64 total_frames = 0;
            if (ma_data_source_get_length_in_pcm_frames(&m_decoder, &total_frames) != MA_SUCCESS) {
                return fail("audio.decode_length_unavailable",
                            "decoded audio length is unavailable for bounded preparation: '" +
                                m_request.path + "'");
            }
            if (total_frames > std::numeric_limits<std::size_t>::max() / kPreparedAudioChannels) {
                return fail("audio.decode_too_large",
                            "decoded audio exceeds addressable memory: '" + m_request.path + "'");
            }
            m_expected_sample_count =
                static_cast<std::size_t>(total_frames) * kPreparedAudioChannels;
            if constexpr (sizeof(std::size_t) >= sizeof(std::uint64_t)) {
                if (m_expected_sample_count >
                    static_cast<std::size_t>(std::numeric_limits<std::uint64_t>::max() /
                                             sizeof(float))) {
                    return fail("audio.decode_too_large",
                                "decoded audio byte size overflows residency accounting: '" +
                                    m_request.path + "'");
                }
            }
            const std::uint64_t decoded_bytes =
                static_cast<std::uint64_t>(m_expected_sample_count) * sizeof(float);
            const std::uint64_t chunk_bytes =
                static_cast<std::uint64_t>(frames_per_step) * bytes_per_frame;
            if (m_source_bytes > std::numeric_limits<std::uint64_t>::max() - decoded_bytes ||
                m_source_bytes + decoded_bytes >
                    std::numeric_limits<std::uint64_t>::max() - chunk_bytes) {
                return fail("audio.decode_too_large",
                            "decoded audio temporary size overflows residency accounting: '" +
                                m_request.path + "'");
            }
            m_estimated_cost.temporary_bytes = m_source_bytes + decoded_bytes + chunk_bytes;
            m_awaiting_reservation_update = true;
            m_decode_state = DecodeState::AwaitingReservation;
            return {.status = jobs::JobStepStatus::Completed, .diagnostics = {}};
        }

        if (m_decode_state == DecodeState::AwaitingReservation) {
            return fail("audio.decode_reservation_not_updated",
                        "audio decoding resumed before memory reservation update: '" +
                            m_request.path + "'");
        }

        const ma_uint64 requested_frames = m_decode_chunk.size() / kPreparedAudioChannels;
        ma_uint64 frames_read = 0;
        const auto result = ma_decoder_read_pcm_frames(&m_decoder, m_decode_chunk.data(),
                                                       requested_frames, &frames_read);
        if (result != MA_SUCCESS && result != MA_AT_END) {
            return fail("audio.decode_failed", "failed while decoding audio asset '" +
                                                   m_request.path + "': " + ma_error_name(result));
        }
        if (frames_read > std::numeric_limits<std::size_t>::max() / kPreparedAudioChannels) {
            return fail("audio.decode_too_large",
                        "decoded audio exceeds addressable memory: '" + m_request.path + "'");
        }
        const auto sample_count = static_cast<std::size_t>(frames_read) * kPreparedAudioChannels;
        if (sample_count > std::numeric_limits<std::size_t>::max() - m_pcm_frames.size()) {
            return fail("audio.decode_too_large",
                        "decoded audio exceeds addressable memory: '" + m_request.path + "'");
        }
        m_pcm_frames.insert(m_pcm_frames.end(), m_decode_chunk.begin(),
                            m_decode_chunk.begin() + static_cast<std::ptrdiff_t>(sample_count));
        if (result == MA_AT_END || frames_read == 0) {
            ma_decoder_uninit(&m_decoder);
            m_decoder_initialized = false;
            m_decode_chunk.clear();
            m_ready = true;
            return {.status = jobs::JobStepStatus::Completed, .diagnostics = {}};
        }
        return {.status = jobs::JobStepStatus::Yielded, .diagnostics = {}};
    }

    [[nodiscard]] jobs::JobStepOutcome fail(std::string code, std::string message) noexcept
    {
        if (m_decoder_initialized) {
            ma_decoder_uninit(&m_decoder);
            m_decoder_initialized = false;
        }
        m_failed = true;
        m_diagnostics = {{.code = std::move(code), .message = std::move(message)}};
        return {.status = jobs::JobStepStatus::Failed, .diagnostics = m_diagnostics};
    }

    const assets::AssetManager& m_assets;
    AudioPreparationOwner& m_owner;
    assets::AudioAssetRequest m_request;
    AudioLoadMode m_mode = AudioLoadMode::Auto;
    assets::detail::IncrementalAssetRead m_read;
    assets::ResidencyCost m_estimated_cost;
    assets::AssetReaderFactory m_stream_factory;
    ma_decoder m_decoder{};
    std::vector<float> m_decode_chunk;
    std::vector<float> m_pcm_frames;
    core::Diagnostics m_diagnostics;
    std::uint64_t m_source_bytes = 0;
    std::uint64_t m_compressed_source_bytes = 0;
    std::size_t m_expected_sample_count = 0;
    DecodeState m_decode_state = DecodeState::Reading;
    bool m_decoder_initialized = false;
    bool m_awaiting_reservation_update = false;
    bool m_ready = false;
    bool m_failed = false;
};

class MiniaudioBackend final : public AudioBackend, private AudioPreparationOwner {
public:
    explicit MiniaudioBackend(MiniaudioBackendConfig config) : m_config(config) {}
    ~MiniaudioBackend() override { shutdown(); }

    AudioBackendInfo backend_info() const override
    {
        return AudioBackendInfo{
            .name = "miniaudio",
            .available = m_initialized,
            .resource_manager_job_thread_count = m_resource_manager_job_thread_count,
            .resource_manager_no_threading = m_resource_manager_no_threading,
        };
    }

    core::DiagnosticResult<void> initialize(const assets::AssetManager& assets,
                                            const jobs::JobExecutionConfig& job_execution) override
    {
        shutdown();
        m_assets = &assets;

        ma_resource_manager_config resource_config = ma_resource_manager_config_init();
        resource_config.decodedFormat = kPreparedAudioFormat;
        resource_config.decodedChannels = kPreparedAudioChannels;
        resource_config.decodedSampleRate = kPreparedAudioSampleRate;
        resource_config.pVFS = m_vfs.handle();
        if (job_execution.mode == jobs::JobExecutionMode::Threaded) {
            if (job_execution.worker_count == 0) {
                m_assets = nullptr;
                return core::DiagnosticResult<void>::failure(core::Diagnostic{
                    .code = "audio.invalid_job_execution_config",
                    .message = "Threaded audio initialization requires a non-zero NovelTea worker "
                               "count.",
                    .severity = core::ErrorSeverity::Fatal,
                });
            }
            resource_config.jobThreadCount = NOVELTEA_MINIAUDIO_RESOURCE_MANAGER_JOB_THREAD_COUNT;
        } else {
            if (job_execution.worker_count != 0) {
                m_assets = nullptr;
                return core::DiagnosticResult<void>::failure(core::Diagnostic{
                    .code = "audio.invalid_job_execution_config",
                    .message = "Non-threaded audio initialization requires a zero NovelTea worker "
                               "count.",
                    .severity = core::ErrorSeverity::Fatal,
                });
            }
            resource_config.jobThreadCount = 0;
            resource_config.flags |= MA_RESOURCE_MANAGER_FLAG_NO_THREADING;
        }
        m_resource_manager_job_thread_count = resource_config.jobThreadCount;
        m_resource_manager_no_threading =
            (resource_config.flags & MA_RESOURCE_MANAGER_FLAG_NO_THREADING) != 0;

        ma_result result = ma_resource_manager_init(&resource_config, &m_resource_manager);
        if (result != MA_SUCCESS) {
            ++m_stats.backend_errors;
            m_assets = nullptr;
            return core::DiagnosticResult<void>::failure(
                initialization_failure("audio.resource_manager_initialization_failed",
                                       "Miniaudio resource manager initialization failed", result));
        }
        m_resource_manager_initialized = true;

        ma_engine_config engine_config = ma_engine_config_init();
        engine_config.pResourceManager = &m_resource_manager;
        engine_config.noDevice = m_config.enable_device ? MA_FALSE : MA_TRUE;
        if (!m_config.enable_device) {
            engine_config.channels = 2;
            engine_config.sampleRate = 48'000;
        }
        result = ma_engine_init(&engine_config, &m_engine);
        if (result != MA_SUCCESS) {
            ++m_stats.backend_errors;
            auto diagnostic =
                initialization_failure("audio.engine_initialization_failed",
                                       "Miniaudio engine initialization failed", result);
            shutdown();
            return core::DiagnosticResult<void>::failure(std::move(diagnostic));
        }
        m_engine_initialized = true;

        if (auto groups = init_groups(); !groups) {
            auto diagnostic = std::move(groups.error());
            shutdown();
            return core::DiagnosticResult<void>::failure(std::move(diagnostic));
        }
        m_initialized = true;
        std::fprintf(stderr, "[audio:miniaudio] initialized\n");
        return core::DiagnosticResult<void>::success();
    }

    void shutdown() override
    {
        for (auto& [id, voice] : m_voices) {
            (void)id;
            if (voice) {
                cleanup_voice_source(*voice);
            }
        }
        m_voices.clear();

        if (m_resource_manager_initialized) {
            for (auto& [_, clip] : m_clips)
                unregister_clip_source(clip);
        }
        m_clips.clear();
        m_clip_lookup.clear();
        m_vfs.clear();

        for (auto& group : m_groups) {
            if (group.initialized) {
                ma_sound_group_uninit(&group.group);
                group.initialized = false;
            }
        }

        if (m_engine_initialized) {
            ma_engine_uninit(&m_engine);
            m_engine_initialized = false;
        }
        if (m_resource_manager_initialized) {
            ma_resource_manager_uninit(&m_resource_manager);
            m_resource_manager_initialized = false;
        }
        m_initialized = false;
        m_resource_manager_job_thread_count = 0;
        m_resource_manager_no_threading = true;
        m_assets = nullptr;
        m_next_clip_id = 1;
        m_next_voice_id = 1;
        m_pause_depth = 0;
        m_stats = {};
    }

    assets::AssetLoadResult<assets::AudioAsset>
    load_audio(const assets::AudioAssetRequest& request) override
    {
        if (!m_initialized || !m_assets) {
            return fail<assets::AudioAsset>("miniaudio backend is not initialized");
        }
        if (request.path.empty()) {
            return fail<assets::AudioAsset>("audio asset path is empty");
        }

        const std::string key = request.path + "|" +
                                std::to_string(static_cast<int>(request.mode)) + "|" +
                                std::to_string(static_cast<int>(request.kind));
        if (auto it = m_clip_lookup.find(key); it != m_clip_lookup.end()) {
            const auto clip_it = m_clips.find(it->second.id);
            if (clip_it == m_clips.end())
                return fail<assets::AudioAsset>("audio clip lookup referenced a missing clip");
            const Clip& clip = clip_it->second;
            return {
                assets::AudioAsset{
                    .clip = it->second, .path = clip.path, .mode = clip.mode, .kind = clip.kind},
                {}};
        }

        Clip clip;
        clip.handle = AudioClipHandle{m_next_clip_id++};
        clip.path = request.path;
        clip.mode = resolved_mode(request.mode, request.kind);
        clip.kind = request.kind;
        clip.resource_name = make_resource_name(clip.handle);

        if (clip.mode == AudioLoadMode::Stream) {
            auto factory = m_assets->reader_factory(request.path);
            if (!factory) {
                return fail<assets::AudioAsset>("failed to resolve stream source '" + request.path +
                                                "': " + factory.error.message);
            }
            auto metadata = factory.value->stat();
            if (!metadata) {
                return fail<assets::AudioAsset>("failed to inspect stream source '" + request.path +
                                                "': " + metadata.error.message);
            }
            if (!metadata.value->seekable) {
                return fail<assets::AudioAsset>(
                    "long-form audio requires a directly seekable source: '" + request.path + "'");
            }
            auto opened = factory.value->open();
            if (!opened) {
                return fail<assets::AudioAsset>("failed to open stream source '" + request.path +
                                                "': " + opened.error.message);
            }
            auto end_seek = (*opened.value)->seek(0, assets::AssetSeekOrigin::End);
            auto begin_seek = (*opened.value)->seek(0, assets::AssetSeekOrigin::Begin);
            if (!end_seek || !begin_seek) {
                const auto& error = !end_seek ? end_seek.error : begin_seek.error;
                return fail<assets::AudioAsset>(
                    "stream source failed direct seek validation for '" + request.path +
                    "': " + error.message);
            }
            clip.storage = ClipStorage::Stream;
            m_vfs.register_factory(clip.resource_name, std::move(*factory.value));
        } else {
            auto blob = m_assets->read_binary(request.path);
            if (!blob) {
                return fail<assets::AudioAsset>("failed to read audio asset '" + request.path +
                                                "': " + blob.error.message);
            }
            if (blob.value->bytes.empty()) {
                return fail<assets::AudioAsset>("audio asset is empty: " + request.path);
            }
            clip.storage = ClipStorage::RegisteredEncoded;
            clip.encoded_bytes = std::move(blob.value->bytes);
            const auto result = ma_resource_manager_register_encoded_data(
                &m_resource_manager, clip.resource_name.c_str(), clip.encoded_bytes.data(),
                clip.encoded_bytes.size());
            if (result != MA_SUCCESS) {
                ++m_stats.backend_errors;
                return fail<assets::AudioAsset>("miniaudio failed to register encoded data for '" +
                                                request.path + "': " + ma_error_name(result));
            }
        }

        AudioClipHandle handle = clip.handle;
        const auto [stored_it, inserted] = m_clips.emplace(handle.id, std::move(clip));
        if (!inserted) {
            return fail<assets::AudioAsset>("audio clip insertion failed");
        }
        m_clip_lookup.emplace(key, handle);
        const Clip& stored = stored_it->second;
        ++m_stats.clips_loaded;
        std::fprintf(stderr,
                     "[audio:miniaudio] loaded clip id=%u path='%s' encoded-bytes=%zu mode=%d "
                     "kind=%d\n",
                     handle.id, stored.path.c_str(), stored.encoded_bytes.size(),
                     static_cast<int>(stored.mode), static_cast<int>(stored.kind));
        return {assets::AudioAsset{
                    .clip = handle, .path = stored.path, .mode = stored.mode, .kind = stored.kind},
                {}};
    }

    std::unique_ptr<assets::AssetPreparationTask<assets::AudioAsset>>
    create_audio_preparation_task(const assets::AssetManager& assets,
                                  const assets::AudioAssetRequest& request) override
    {
        if (!m_initialized)
            return {};
        return std::make_unique<MiniaudioAudioPreparationTask>(
            assets, static_cast<AudioPreparationOwner&>(*this), request);
    }

    AudioVoiceHandle play(AudioClipHandle clip_handle, const AudioPlaybackDesc& desc) override
    {
        if (!m_initialized || !clip_handle)
            return {};
        auto clip_it = m_clips.find(clip_handle.id);
        if (clip_it == m_clips.end()) {
            std::fprintf(stderr, "[audio:miniaudio] unknown clip handle: %u\n", clip_handle.id);
            return {};
        }
        Clip& clip = clip_it->second;

        auto voice = std::make_unique<Voice>();
        ma_sound_group* group = group_for(desc.bus);
        ma_uint32 source_flags = MA_RESOURCE_MANAGER_DATA_SOURCE_FLAG_WAIT_INIT;
        if (clip.storage == ClipStorage::Stream) {
            source_flags |= MA_RESOURCE_MANAGER_DATA_SOURCE_FLAG_STREAM;
            if (desc.loop)
                source_flags |= MA_RESOURCE_MANAGER_DATA_SOURCE_FLAG_LOOPING;
        } else if (clip.storage == ClipStorage::RegisteredEncoded) {
            source_flags |= MA_RESOURCE_MANAGER_DATA_SOURCE_FLAG_DECODE;
        }
        ma_result result =
            ma_resource_manager_data_source_init(&m_resource_manager, clip.resource_name.c_str(),
                                                 source_flags, nullptr, &voice->data_source);
        if (result != MA_SUCCESS) {
            ++m_stats.backend_errors;
            std::fprintf(stderr, "[audio:miniaudio] data source init failed for '%s': %s (%d)\n",
                         clip.path.c_str(), ma_error_name(result), result);
            return {};
        }
        voice->data_source_initialized = true;
        result = ma_sound_init_from_data_source(
            &m_engine, &voice->data_source, MA_SOUND_FLAG_NO_SPATIALIZATION, group, &voice->sound);
        if (result != MA_SUCCESS) {
            ++m_stats.backend_errors;
            std::fprintf(stderr, "[audio:miniaudio] sound init failed for '%s': %s (%d)\n",
                         clip.path.c_str(), ma_error_name(result), result);
            cleanup_voice_source(*voice);
            return {};
        }
        voice->sound_initialized = true;
        voice->clip = clip_handle;
        voice->path = clip.path;
        ma_sound_set_volume(&voice->sound, desc.volume);
        ma_sound_set_pitch(&voice->sound, desc.pitch > 0.0f ? desc.pitch : 1.0f);
        ma_sound_set_looping(&voice->sound, desc.loop ? MA_TRUE : MA_FALSE);

        result = ma_sound_start(&voice->sound);
        if (result != MA_SUCCESS) {
            ++m_stats.backend_errors;
            std::fprintf(stderr, "[audio:miniaudio] sound start failed for '%s': %s (%d)\n",
                         clip.path.c_str(), ma_error_name(result), result);
            cleanup_voice_source(*voice);
            return {};
        }

        const AudioVoiceHandle handle{m_next_voice_id++};
        m_voices.emplace(handle.id, std::move(voice));
        ++clip.active_voice_count;
        ++m_stats.voices_started;
        std::fprintf(stderr,
                     "[audio:miniaudio] started voice id=%u clip=%u path='%s' bus=%d volume=%.3f "
                     "pitch=%.3f loop=%d\n",
                     handle.id, clip_handle.id, clip.path.c_str(), static_cast<int>(desc.bus),
                     desc.volume, desc.pitch, desc.loop ? 1 : 0);
        return handle;
    }

    void stop(AudioVoiceHandle voice) override
    {
        auto it = m_voices.find(voice.id);
        if (it != m_voices.end() && it->second) {
            ma_sound_stop(&it->second->sound);
        }
    }

    void set_volume(AudioVoiceHandle voice, float volume) override
    {
        auto it = m_voices.find(voice.id);
        if (it != m_voices.end() && it->second) {
            ma_sound_set_volume(&it->second->sound, volume);
        }
    }

    void set_bus_volume(AudioBus bus, float volume) override
    {
        if (bus == AudioBus::Master) {
            ma_engine_set_volume(&m_engine, volume);
            return;
        }
        ma_sound_group* group = group_for(bus);
        if (group) {
            ma_sound_group_set_volume(group, volume);
        }
    }

    void pause() override
    {
        if (!m_initialized)
            return;
        ++m_pause_depth;
        if (m_pause_depth == 1) {
            const ma_result result = ma_engine_stop(&m_engine);
            if (result != MA_SUCCESS) {
                ++m_stats.backend_errors;
                std::fprintf(stderr, "[audio:miniaudio] pause failed: %s (%d)\n",
                             ma_error_name(result), result);
            } else {
                std::fprintf(stderr, "[audio:miniaudio] paused\n");
            }
        }
    }

    void resume() override
    {
        if (!m_initialized || m_pause_depth == 0)
            return;
        --m_pause_depth;
        if (m_pause_depth == 0) {
            const ma_result result = ma_engine_start(&m_engine);
            if (result != MA_SUCCESS) {
                ++m_stats.backend_errors;
                std::fprintf(stderr, "[audio:miniaudio] resume failed: %s (%d)\n",
                             ma_error_name(result), result);
            } else {
                std::fprintf(stderr, "[audio:miniaudio] resumed\n");
            }
        }
    }

    bool voice_active(AudioVoiceHandle voice) const override
    {
        auto it = m_voices.find(voice.id);
        if (it == m_voices.end() || !it->second)
            return false;
        return ma_sound_is_playing(&it->second->sound) == MA_TRUE &&
               ma_sound_at_end(&it->second->sound) == MA_FALSE;
    }

    AudioBackendStats stats() const override
    {
        AudioBackendStats snapshot = m_stats;
        snapshot.voices_active = static_cast<uint32_t>(m_voices.size());
        return snapshot;
    }

    void collect_finished_voices() override
    {
        for (auto it = m_voices.begin(); it != m_voices.end();) {
            if (!it->second || ma_sound_at_end(&it->second->sound) == MA_TRUE ||
                ma_sound_is_playing(&it->second->sound) == MA_FALSE) {
                if (it->second)
                    finish_voice(*it->second);
                ++m_stats.voices_finished;
                it = m_voices.erase(it);
            } else {
                ++it;
            }
        }
    }

private:
    enum class ClipStorage : std::uint8_t {
        RegisteredEncoded,
        RegisteredDecoded,
        Stream,
    };

    struct Clip {
        AudioClipHandle handle;
        std::string path;
        std::string resource_name;
        AudioLoadMode mode = AudioLoadMode::Auto;
        AudioClipKind kind = AudioClipKind::Auto;
        ClipStorage storage = ClipStorage::RegisteredEncoded;
        assets::AssetBytes encoded_bytes;
        std::vector<float> pcm_frames;
        std::uint32_t active_voice_count = 0;
        bool release_requested = false;
    };

    struct Voice {
        ma_resource_manager_data_source data_source{};
        ma_sound sound{};
        AudioClipHandle clip;
        std::string path;
        bool data_source_initialized = false;
        bool sound_initialized = false;
    };

    [[nodiscard]] core::Result<assets::PreparedAsset<assets::AudioAsset>, core::Diagnostics>
    finalize_audio_on_owner(PreparedAudioClipData prepared) noexcept override
    {
        if (!m_initialized) {
            return core::Result<assets::PreparedAsset<assets::AudioAsset>, core::Diagnostics>::
                failure({{.code = "audio.backend_not_initialized",
                          .message = "audio backend is not initialized during finalization"}});
        }

        Clip clip;
        clip.handle = AudioClipHandle{m_next_clip_id++};
        clip.path = prepared.request.path;
        clip.resource_name = make_resource_name(clip.handle);
        clip.mode = prepared.mode;
        clip.kind = prepared.request.kind;

        assets::ResidencyCost cost;
        if (prepared.mode == AudioLoadMode::Stream) {
            if (!prepared.stream_factory) {
                return core::Result<assets::PreparedAsset<assets::AudioAsset>, core::Diagnostics>::
                    failure({{.code = "audio.stream_factory_missing",
                              .message = "prepared stream has no reader factory"}});
            }
            clip.storage = ClipStorage::Stream;
            m_vfs.register_factory(clip.resource_name, std::move(prepared.stream_factory));
            cost.audio_bytes = kStreamingAudioBytes;
        } else {
            if (prepared.pcm_frames.empty()) {
                return core::Result<assets::PreparedAsset<assets::AudioAsset>, core::Diagnostics>::
                    failure({{.code = "audio.decoded_cache_empty",
                              .message = "prepared decoded audio cache is empty"}});
            }
            clip.storage = ClipStorage::RegisteredDecoded;
            clip.pcm_frames = std::move(prepared.pcm_frames);
            cost.audio_bytes = clip.pcm_frames.size() * sizeof(float);
        }

        const auto handle = clip.handle;
        const auto [stored_it, inserted] = m_clips.emplace(handle.id, std::move(clip));
        if (!inserted) {
            return core::Result<assets::PreparedAsset<assets::AudioAsset>, core::Diagnostics>::
                failure({{.code = "audio.clip_insertion_failed",
                          .message = "prepared audio clip insertion failed"}});
        }

        if (stored_it->second.storage == ClipStorage::RegisteredDecoded) {
            const auto frame_count = stored_it->second.pcm_frames.size() / kPreparedAudioChannels;
            const auto result = ma_resource_manager_register_decoded_data(
                &m_resource_manager, stored_it->second.resource_name.c_str(),
                stored_it->second.pcm_frames.data(), frame_count, kPreparedAudioFormat,
                kPreparedAudioChannels, kPreparedAudioSampleRate);
            if (result != MA_SUCCESS) {
                ++m_stats.backend_errors;
                m_clips.erase(stored_it);
                return core::Result<assets::PreparedAsset<assets::AudioAsset>, core::Diagnostics>::
                    failure({{.code = "audio.decoded_cache_registration_failed",
                              .message = "miniaudio failed to register decoded audio cache for '" +
                                         prepared.request.path + "': " + ma_error_name(result)}});
            }
        }

        ++m_stats.clips_loaded;
        std::fprintf(stderr,
                     "[audio:miniaudio] prepared clip id=%u path='%s' source-bytes=%llu "
                     "audio-bytes=%llu mode=%d kind=%d\n",
                     handle.id, stored_it->second.path.c_str(),
                     static_cast<unsigned long long>(prepared.source_bytes),
                     static_cast<unsigned long long>(cost.audio_bytes),
                     static_cast<int>(stored_it->second.mode),
                     static_cast<int>(stored_it->second.kind));

        return core::Result<assets::PreparedAsset<assets::AudioAsset>, core::Diagnostics>::success(
            {.asset = assets::AudioAsset{.clip = handle,
                                         .path = std::move(prepared.request.path),
                                         .mode = prepared.mode,
                                         .kind = prepared.request.kind},
             .cost = cost,
             .destroy_on_owner = [this](assets::AudioAsset& asset) {
                 release_clip_on_owner(asset.clip);
                 asset.clip = {};
             }});
    }

    [[nodiscard]] static std::string make_resource_name(AudioClipHandle handle)
    {
        return "noveltea-audio-resource-" + std::to_string(handle.id);
    }

    void unregister_clip_source(Clip& clip) noexcept
    {
        if (clip.storage == ClipStorage::Stream) {
            m_vfs.unregister_factory(clip.resource_name);
            return;
        }
        const auto result =
            ma_resource_manager_unregister_data(&m_resource_manager, clip.resource_name.c_str());
        if (result != MA_SUCCESS && result != MA_DOES_NOT_EXIST)
            ++m_stats.backend_errors;
    }

    void erase_clip_on_owner(std::unordered_map<std::uint32_t, Clip>::iterator clip_it) noexcept
    {
        const auto handle = clip_it->second.handle;
        unregister_clip_source(clip_it->second);
        std::erase_if(m_clip_lookup, [&](const auto& item) { return item.second == handle; });
        m_clips.erase(clip_it);
    }

    void release_clip_on_owner(AudioClipHandle handle) noexcept
    {
        const auto clip_it = m_clips.find(handle.id);
        if (clip_it == m_clips.end())
            return;
        if (clip_it->second.active_voice_count != 0) {
            clip_it->second.release_requested = true;
            return;
        }
        erase_clip_on_owner(clip_it);
    }

    void finish_voice(Voice& voice) noexcept
    {
        const auto clip_handle = voice.clip;
        cleanup_voice_source(voice);
        const auto clip_it = m_clips.find(clip_handle.id);
        if (clip_it == m_clips.end())
            return;
        if (clip_it->second.active_voice_count != 0)
            --clip_it->second.active_voice_count;
        if (clip_it->second.active_voice_count == 0 && clip_it->second.release_requested)
            erase_clip_on_owner(clip_it);
    }

    void cleanup_voice_source(Voice& voice)
    {
        if (voice.sound_initialized) {
            ma_sound_uninit(&voice.sound);
            voice.sound_initialized = false;
        }
        if (voice.data_source_initialized) {
            ma_resource_manager_data_source_uninit(&voice.data_source);
            voice.data_source_initialized = false;
        }
    }

    struct Group {
        ma_sound_group group{};
        bool initialized = false;
    };

    core::DiagnosticResult<void> init_groups()
    {
        for (const AudioBus bus :
             {AudioBus::Sfx, AudioBus::Music, AudioBus::Ambience, AudioBus::Voice}) {
            if (auto initialized = init_group(bus, nullptr); !initialized)
                return initialized;
        }
        return core::DiagnosticResult<void>::success();
    }

    core::DiagnosticResult<void> init_group(AudioBus bus, ma_sound_group* parent)
    {
        Group& group = m_groups[index_for(bus)];
        ma_result result =
            ma_sound_group_init(&m_engine, MA_SOUND_FLAG_NO_SPATIALIZATION, parent, &group.group);
        if (result != MA_SUCCESS) {
            ++m_stats.backend_errors;
            group.initialized = false;
            return core::DiagnosticResult<void>::failure(
                initialization_failure("audio.sound_group_initialization_failed",
                                       "Miniaudio sound group initialization failed", result));
        }
        group.initialized = true;
        return core::DiagnosticResult<void>::success();
    }

    static std::size_t index_for(AudioBus bus)
    {
        switch (bus) {
        case AudioBus::Sfx:
            return 0;
        case AudioBus::Music:
            return 1;
        case AudioBus::Ambience:
            return 2;
        case AudioBus::Voice:
            return 3;
        case AudioBus::Master:
            return 0;
        }
        return 0;
    }

    ma_sound_group* group_for(AudioBus bus)
    {
        if (bus == AudioBus::Master)
            return nullptr;
        Group& group = m_groups[index_for(bus)];
        return group.initialized ? &group.group : nullptr;
    }

    const assets::AssetManager* m_assets = nullptr;
    MiniaudioBackendConfig m_config{};
    ma_resource_manager m_resource_manager{};
    ma_engine m_engine{};
    AssetVfs m_vfs;
    bool m_resource_manager_initialized = false;
    bool m_engine_initialized = false;
    bool m_initialized = false;
    std::uint32_t m_resource_manager_job_thread_count = 0;
    bool m_resource_manager_no_threading = true;
    uint32_t m_next_clip_id = 1;
    uint32_t m_next_voice_id = 1;
    uint32_t m_pause_depth = 0;
    AudioBackendStats m_stats{};
    std::unordered_map<uint32_t, Clip> m_clips;
    std::unordered_map<std::string, AudioClipHandle> m_clip_lookup;
    std::unordered_map<uint32_t, std::unique_ptr<Voice>> m_voices;
    Group m_groups[4]{};
};

} // namespace

std::unique_ptr<AudioBackend> make_miniaudio_backend(MiniaudioBackendConfig config)
{
    return std::make_unique<MiniaudioBackend>(config);
}

} // namespace noveltea
