#include <catch2/catch_test_macros.hpp>

#include "noveltea/assets/asset_manager.hpp"
#include "noveltea/assets/asset_cache_keys.hpp"
#include "noveltea/assets/asset_residency.hpp"
#include "noveltea/assets/asset_source.hpp"
#include "noveltea/assets/mandatory_asset_gate.hpp"
#include "noveltea/audio/audio_backend.hpp"
#include "noveltea/core/compiled_project_codec.hpp"
#include "noveltea/core/session_state.hpp"
#include "noveltea/runtime_audio_adapter.hpp"
#include "noveltea/runtime_presentation_bridge.hpp"
#include "noveltea/jobs/inline_job_executor.hpp"
#include "host/runtime_ui_asset_service.hpp"

#include <nlohmann/json.hpp>

#include <fstream>
#include <limits>
#include <memory>
#include <string>
#include <type_traits>
#include <unordered_map>
#include <vector>

using namespace noveltea;
using noveltea::host::RuntimeUiProjectAssetService;

static_assert(!std::is_copy_constructible_v<RuntimeAudioAdapter>);
static_assert(!std::is_copy_assignable_v<RuntimeAudioAdapter>);
static_assert(!std::is_move_constructible_v<RuntimeAudioAdapter>);
static_assert(!std::is_move_assignable_v<RuntimeAudioAdapter>);
static_assert(!std::is_copy_constructible_v<RuntimeUiProjectAssetService>);
static_assert(!std::is_copy_assignable_v<RuntimeUiProjectAssetService>);
static_assert(!std::is_move_constructible_v<RuntimeUiProjectAssetService>);
static_assert(!std::is_move_assignable_v<RuntimeUiProjectAssetService>);

namespace {

core::CompiledProject load_project()
{
    const std::string path = std::string(NOVELTEA_SOURCE_DIR) +
                             "/editor/src/renderer/test/fixtures/compiled-project-golden/"
                             "scene-program.json";
    std::ifstream input(path);
    REQUIRE(input.good());
    const std::string source((std::istreambuf_iterator<char>(input)),
                             std::istreambuf_iterator<char>());
    auto document = nlohmann::json::parse(source, nullptr, false);
    REQUIRE_FALSE(document.is_discarded());
    auto decoded = core::decode_compiled_project(document, path);
    REQUIRE(decoded);
    return std::move(decoded).value();
}

class FakeAudioBackend final : public AudioBackend {
public:
    AudioBackendInfo backend_info() const override { return {"fake", initialized}; }
    core::DiagnosticResult<void> initialize(const assets::AssetManager&,
                                            const jobs::JobExecutionConfig&) override
    {
        initialized = true;
        return core::DiagnosticResult<void>::success();
    }
    void shutdown() override
    {
        initialized = false;
        active.clear();
    }
    assets::AssetLoadResult<assets::AudioAsset>
    load_audio(const assets::AudioAssetRequest& request) override
    {
        last_request = request;
        return {assets::AudioAsset{.clip = AudioClipHandle{next_clip++},
                                   .path = request.path,
                                   .mode = request.mode,
                                   .kind = request.kind},
                {}};
    }
    std::unique_ptr<assets::AssetPreparationTask<assets::AudioAsset>>
    create_audio_preparation_task(const assets::AssetManager&,
                                  const assets::AudioAssetRequest& request) override
    {
        class Task final : public assets::AssetPreparationTask<assets::AudioAsset> {
        public:
            Task(FakeAudioBackend& owner, assets::AudioAssetRequest request)
                : m_owner(owner), m_request(std::move(request))
            {
            }

            [[nodiscard]] assets::ResidencyCost estimated_cost_on_owner() const noexcept override
            {
                return {.audio_bytes = 1};
            }

            [[nodiscard]] jobs::JobStepOutcome step(jobs::JobContext& context) noexcept override
            {
                m_ready = !context.cancellation_requested();
                return {.status = jobs::JobStepStatus::Completed, .diagnostics = {}};
            }

            [[nodiscard]] core::Result<assets::PreparedAsset<assets::AudioAsset>, core::Diagnostics>
            finalize_on_owner() noexcept override
            {
                if (!m_ready) {
                    return core::Result<
                        assets::PreparedAsset<assets::AudioAsset>,
                        core::Diagnostics>::failure({{.code = "test.audio_preparation_canceled",
                                                      .message =
                                                          "fake audio preparation was canceled"}});
                }
                auto loaded = m_owner.load_audio(m_request);
                if (!loaded) {
                    return core::Result<
                        assets::PreparedAsset<assets::AudioAsset>,
                        core::Diagnostics>::failure({{.code = "test.audio_preparation_failed",
                                                      .message = loaded.error}});
                }
                return core::Result<assets::PreparedAsset<assets::AudioAsset>,
                                    core::Diagnostics>::success({.asset = std::move(*loaded.value),
                                                                 .cost = {.audio_bytes = 1},
                                                                 .destroy_on_owner = {}});
            }

        private:
            FakeAudioBackend& m_owner;
            assets::AudioAssetRequest m_request;
            bool m_ready = false;
        };

        return std::make_unique<Task>(*this, request);
    }
    AudioVoiceHandle play(AudioClipHandle, const AudioPlaybackDesc& desc) override
    {
        if (max_active_voices > 0 && active_voice_count() >= max_active_voices)
            return {};
        const AudioVoiceHandle voice{next_voice++};
        active[voice.id] = true;
        last_playback = desc;
        return voice;
    }
    void stop(AudioVoiceHandle voice) override { active[voice.id] = false; }
    void set_volume(AudioVoiceHandle, float) override {}
    void set_bus_volume(AudioBus, float) override {}
    void pause() override {}
    void resume() override {}
    bool voice_active(AudioVoiceHandle voice) const override
    {
        const auto found = active.find(voice.id);
        return found != active.end() && found->second;
    }
    AudioBackendStats stats() const override { return {}; }
    void collect_finished_voices() override {}
    void finish_all()
    {
        for (auto& [unused, value] : active) {
            (void)unused;
            value = false;
        }
    }
    [[nodiscard]] std::size_t active_voice_count() const
    {
        return static_cast<std::size_t>(std::count_if(
            active.begin(), active.end(), [](const auto& entry) { return entry.second; }));
    }

    bool initialized = false;
    std::uint32_t next_clip = 1;
    std::uint32_t next_voice = 1;
    std::unordered_map<std::uint32_t, bool> active;
    std::optional<assets::AudioAssetRequest> last_request;
    std::optional<AudioPlaybackDesc> last_playback;
    std::size_t max_active_voices = 0;
};

class PublishedAudioAssets final {
public:
    explicit PublishedAudioAssets(assets::AssetManager& assets)
        : m_assets(assets), m_executor(shared_executor())
    {
        m_residency = std::make_shared<assets::AssetResidencyManager>(assets::ResidencyBudget{
            .source_bytes = 64 * 1024 * 1024,
            .prepared_cpu_bytes = 64 * 1024 * 1024,
            .gpu_bytes = 64 * 1024 * 1024,
            .audio_bytes = 64 * 1024 * 1024,
            .temporary_bytes = 64 * 1024 * 1024,
        });
        REQUIRE(m_assets.configure_async_requests(m_executor, m_residency));

        std::vector<assets::StructuredAssetRequestDescriptor> requests;
        for (const auto kind : {AudioClipKind::Sfx, AudioClipKind::Music, AudioClipKind::Ambience,
                                AudioClipKind::Voice}) {
            assets::AudioAssetRequest request{.path = "project:/assets/audio/voice.ogg",
                                              .mode = AudioLoadMode::Auto,
                                              .kind = kind};
            requests.push_back({.request = request,
                                .cache_key = assets::make_audio_cache_key(
                                    request, m_assets.source_generation_on_owner())});
        }

        assets::MandatoryAssetRequestGroup group(m_assets, std::move(requests));
        REQUIRE(m_executor.run_until_idle(32));
        group.poll_on_owner();
        REQUIRE(group.state_on_owner() == assets::MandatoryAssetGroupState::Ready);
        auto leases = group.take_ready_leases_on_owner();
        REQUIRE(leases);
        m_assets.stage_candidate_leases_on_owner(std::move(*leases));
        m_assets.commit_candidate_leases_on_owner();
    }

private:
    [[nodiscard]] static jobs::InlineJobExecutor& shared_executor()
    {
        struct SharedExecutor final {
            ~SharedExecutor()
            {
                executor.begin_shutdown();
                (void)executor.dispatch_owner_completions(std::numeric_limits<std::size_t>::max());
            }

            jobs::InlineJobExecutor executor;
        };
        static SharedExecutor shared;
        return shared.executor;
    }

    assets::AssetManager& m_assets;
    jobs::InlineJobExecutor& m_executor;
    std::shared_ptr<assets::AssetResidencyManager> m_residency;
};

} // namespace

TEST_CASE("runtime audio adapter executes typed playback and completes exact pending operation")
{
    const auto project = load_project();
    auto state = core::SessionState::create(project);
    REQUIRE(state);
    const auto owner = core::flow_frame_id(state.value().flow_stack().back());
    auto invocation = core::ScriptInvocationHandle::create(17);
    REQUIRE(invocation);

    auto source = std::make_shared<assets::MemoryAssetSource>();
    assets::AssetManager assets;
    assets.mount("project", source);
    auto backend = std::make_unique<FakeAudioBackend>();
    auto* backend_ptr = backend.get();
    AudioSystem audio(std::move(backend));
    REQUIRE(audio.initialize(assets));
    assets.bind_audio_loader(&audio);
    PublishedAudioAssets published_audio(assets);
    RuntimeUiProjectAssetService resolver;
    resolver.install(project);
    RuntimeAudioAdapter adapter(audio, resolver, assets);

    const core::AudioOperation operation{
        .id = core::AudioOperationId::from_number(4),
        .action = core::compiled::AudioAction::FadeIn,
        .channel = core::compiled::AudioChannel::Voice,
        .asset = project.find_asset(core::AssetId::create("audio-voice").value())->id,
        .fade = std::chrono::milliseconds{25},
        .loop = false,
        .volume = 0.5,
        .owner = owner,
        .completion = core::AudioCompletionHandle{invocation.value()}};
    auto applied = adapter.apply(operation);
    REQUIRE(applied);
    CHECK(applied.value() == TypedRuntimeOperationDisposition::Pending);
    REQUIRE(backend_ptr->last_request);
    CHECK(backend_ptr->last_request->path == "project:/assets/audio/voice.ogg");
    CHECK(backend_ptr->last_request->kind == AudioClipKind::Voice);
    REQUIRE(backend_ptr->last_playback);
    CHECK(backend_ptr->last_playback->bus == AudioBus::Voice);
    CHECK(adapter.take_completions().empty());

    backend_ptr->finish_all();
    auto completed = adapter.take_completions();
    REQUIRE(completed.size() == 1);
    CHECK(completed.front() ==
          core::CompleteAudioInput{operation.id, owner, *operation.completion});
    CHECK(adapter.take_completions().empty());

    auto missing = operation;
    missing.id = core::AudioOperationId::from_number(5);
    missing.asset = core::AssetId::create("missing").value();
    auto failed = adapter.apply(missing);
    REQUIRE_FALSE(failed);
    CHECK(failed.error().code == "runtime_audio.asset_unavailable");
}

TEST_CASE("runtime audio play operations overlap by default and channel stop ends all instances")
{
    const auto project = load_project();
    auto source = std::make_shared<assets::MemoryAssetSource>();
    assets::AssetManager assets;
    assets.mount("project", source);
    auto backend = std::make_unique<FakeAudioBackend>();
    auto* backend_ptr = backend.get();
    AudioSystem audio(std::move(backend));
    REQUIRE(audio.initialize(assets));
    assets.bind_audio_loader(&audio);
    PublishedAudioAssets published_audio(assets);
    RuntimeUiProjectAssetService resolver;
    resolver.install(project);
    RuntimeAudioAdapter adapter(audio, resolver, assets);
    const auto asset = core::AssetId::create("audio-voice").value();

    auto first =
        adapter.apply(core::AudioOperation{.id = core::AudioOperationId::from_number(20),
                                           .action = core::compiled::AudioAction::Play,
                                           .channel = core::compiled::AudioChannel::SoundEffect,
                                           .asset = asset,
                                           .loop = false,
                                           .volume = 1.0});
    REQUIRE(first);
    auto second =
        adapter.apply(core::AudioOperation{.id = core::AudioOperationId::from_number(21),
                                           .action = core::compiled::AudioAction::Play,
                                           .channel = core::compiled::AudioChannel::SoundEffect,
                                           .asset = asset,
                                           .loop = false,
                                           .volume = 1.0});
    REQUIRE(second);
    CHECK(backend_ptr->active_voice_count() == 2);

    auto stopped = adapter.apply(core::AudioOperation{
        .id = core::AudioOperationId::from_number(22),
        .action = core::compiled::AudioAction::Stop,
        .channel = core::compiled::AudioChannel::SoundEffect,
        .asset = std::nullopt,
        .loop = false,
        .volume = 1.0,
        .target = core::AudioBusOperationTarget{core::compiled::AudioChannel::SoundEffect}});
    REQUIRE(stopped);
    CHECK(backend_ptr->active_voice_count() == 0);
}

TEST_CASE("runtime audio adapter destruction releases active backend tracks")
{
    const auto project = load_project();
    auto source = std::make_shared<assets::MemoryAssetSource>();
    assets::AssetManager assets;
    assets.mount("project", source);
    auto backend = std::make_unique<FakeAudioBackend>();
    auto* backend_ptr = backend.get();
    AudioSystem audio(std::move(backend));
    REQUIRE(audio.initialize(assets));
    assets.bind_audio_loader(&audio);
    PublishedAudioAssets published_audio(assets);
    RuntimeUiProjectAssetService resolver;
    resolver.install(project);

    {
        RuntimeAudioAdapter adapter(audio, resolver, assets);
        auto applied = adapter.apply(
            core::AudioOperation{.id = core::AudioOperationId::from_number(23),
                                 .action = core::compiled::AudioAction::Play,
                                 .channel = core::compiled::AudioChannel::Ambient,
                                 .asset = core::AssetId::create("audio-voice").value(),
                                 .loop = true,
                                 .volume = 1.0});
        REQUIRE(applied);
        CHECK(backend_ptr->active_voice_count() == 1);
    }

    CHECK(backend_ptr->active_voice_count() == 0);
}

TEST_CASE("runtime presentation bridge owns live audio barrier until backend termination")
{
    const auto project = load_project();
    auto source = std::make_shared<assets::MemoryAssetSource>();
    assets::AssetManager assets;
    assets.mount("project", source);
    auto backend = std::make_unique<FakeAudioBackend>();
    auto* backend_ptr = backend.get();
    AudioSystem audio(std::move(backend));
    REQUIRE(audio.initialize(assets));
    assets.bind_audio_loader(&audio);
    PublishedAudioAssets published_audio(assets);
    RuntimeUiProjectAssetService resolver;
    resolver.install(project);
    RuntimeAudioAdapter adapter(audio, resolver, assets);
    RuntimePresentationBridge bridge(adapter);

    const core::AudioOperation operation{.id = core::AudioOperationId::from_number(91),
                                         .action = core::compiled::AudioAction::Play,
                                         .channel = core::compiled::AudioChannel::SoundEffect,
                                         .asset = core::AssetId::create("audio-voice").value(),
                                         .loop = false,
                                         .volume = 1.0};
    auto accepted = bridge.accept(operation);
    REQUIRE(accepted);
    CHECK(accepted.value().accepted);
    REQUIRE(bridge.checkpoint_status().active_barriers.size() == 1);
    REQUIRE(bridge.flush().diagnostics.empty());

    backend_ptr->finish_all();
    auto completed = bridge.poll_audio();
    REQUIRE(completed.diagnostics.empty());
    REQUIRE(completed.inputs.size() == 1);
    CHECK(std::holds_alternative<core::AcknowledgeAudioTerminationInput>(completed.inputs.front()));
    CHECK(bridge.checkpoint_status().active_barriers.empty());
}

TEST_CASE(
    "desired audio reconciliation layers loops and reset rebuilds without replaying one-shots")
{
    const auto project = load_project();
    auto state = core::SessionState::create(project);
    REQUIRE(state);
    const auto owner = state.value().session_presentation_owner();
    auto source = std::make_shared<assets::MemoryAssetSource>();
    assets::AssetManager assets;
    assets.mount("project", source);
    auto backend = std::make_unique<FakeAudioBackend>();
    auto* backend_ptr = backend.get();
    AudioSystem audio(std::move(backend));
    REQUIRE(audio.initialize(assets));
    assets.bind_audio_loader(&audio);
    PublishedAudioAssets published_audio(assets);
    RuntimeUiProjectAssetService resolver;
    resolver.install(project);
    RuntimeAudioAdapter adapter(audio, resolver, assets);
    const auto asset = core::AssetId::create("audio-voice").value();

    const std::vector<core::PresentationDesiredAudio> desired = {
        {core::DesiredAudioInstanceId::create("background-music").value(), owner,
         core::compiled::AudioChannel::Music, asset, 0.8, std::chrono::milliseconds{20},
         std::chrono::milliseconds{30},
         core::DesiredAudioReplacementKey::create("background-music").value()},
        {core::DesiredAudioInstanceId::create("rain-near").value(), owner,
         core::compiled::AudioChannel::Ambient, asset, 0.4},
        {core::DesiredAudioInstanceId::create("rain-far").value(), owner,
         core::compiled::AudioChannel::Ambient, asset, 0.2}};
    REQUIRE(adapter.reconcile_desired(desired));
    CHECK(backend_ptr->active_voice_count() == 3);
    REQUIRE(adapter.reconcile_desired(desired));
    CHECK(backend_ptr->active_voice_count() == 3);

    const core::AudioOperation transient_music{.id = core::AudioOperationId::from_number(198),
                                               .action = core::compiled::AudioAction::Play,
                                               .channel = core::compiled::AudioChannel::Music,
                                               .asset = asset,
                                               .loop = false,
                                               .volume = 1.0};
    REQUIRE(adapter.apply(transient_music));
    CHECK(backend_ptr->active_voice_count() == 4);
    REQUIRE(adapter.apply(core::AudioOperation{
        .id = core::AudioOperationId::from_number(199),
        .action = core::compiled::AudioAction::Stop,
        .channel = core::compiled::AudioChannel::Music,
        .asset = std::nullopt,
        .loop = false,
        .volume = 1.0,
        .target = core::AudioBusOperationTarget{core::compiled::AudioChannel::Music}}));
    CHECK(backend_ptr->active_voice_count() == 3);

    REQUIRE(adapter.apply(core::AudioOperation{
        .id = core::AudioOperationId::from_number(200),
        .action = core::compiled::AudioAction::Stop,
        .channel = core::compiled::AudioChannel::Ambient,
        .asset = std::nullopt,
        .loop = false,
        .volume = 1.0,
        .target = core::DesiredAudioOperationTarget{
            core::DesiredAudioInstanceId::create("rain-near").value(), owner}}));
    CHECK(backend_ptr->active_voice_count() == 2);
    REQUIRE(adapter.reconcile_desired(desired));
    CHECK(backend_ptr->active_voice_count() == 3);

    const core::AudioOperation one_shot{.id = core::AudioOperationId::from_number(201),
                                        .action = core::compiled::AudioAction::Play,
                                        .channel = core::compiled::AudioChannel::Voice,
                                        .asset = asset,
                                        .loop = false,
                                        .volume = 1.0};
    REQUIRE(adapter.apply(one_shot));
    CHECK(backend_ptr->active_voice_count() == 4);

    adapter.reset(core::PresentationCancellationReason::CheckpointLoad);
    CHECK(backend_ptr->active_voice_count() == 0);
    CHECK(adapter.take_completions().empty());
    CHECK(adapter.take_terminations().empty());
    REQUIRE(adapter.reconcile_desired(desired));
    CHECK(backend_ptr->active_voice_count() == 3);
    CHECK(adapter.take_completions().empty());
    CHECK(adapter.take_terminations().empty());
}

TEST_CASE(
    "runtime audio adapter reports backend concurrency exhaustion and reuses released capacity")
{
    const auto project = load_project();
    auto source = std::make_shared<assets::MemoryAssetSource>();
    assets::AssetManager assets;
    assets.mount("project", source);
    auto backend = std::make_unique<FakeAudioBackend>();
    auto* backend_ptr = backend.get();
    backend_ptr->max_active_voices = 1;
    AudioSystem audio(std::move(backend));
    REQUIRE(audio.initialize(assets));
    assets.bind_audio_loader(&audio);
    PublishedAudioAssets published_audio(assets);
    RuntimeUiProjectAssetService resolver;
    resolver.install(project);
    RuntimeAudioAdapter adapter(audio, resolver, assets);
    const auto asset = core::AssetId::create("audio-voice").value();

    const core::AudioOperation first{.id = core::AudioOperationId::from_number(210),
                                     .action = core::compiled::AudioAction::Play,
                                     .channel = core::compiled::AudioChannel::SoundEffect,
                                     .asset = asset,
                                     .loop = false,
                                     .volume = 1.0};
    auto accepted = adapter.apply(first);
    REQUIRE(accepted);
    CHECK(backend_ptr->active_voice_count() == 1);

    auto exhausted =
        adapter.apply(core::AudioOperation{.id = core::AudioOperationId::from_number(211),
                                           .action = core::compiled::AudioAction::Play,
                                           .channel = core::compiled::AudioChannel::SoundEffect,
                                           .asset = asset,
                                           .loop = false,
                                           .volume = 1.0});
    REQUIRE_FALSE(exhausted);
    CHECK(exhausted.error().code == "runtime_audio.play_failed");
    CHECK(backend_ptr->active_voice_count() == 1);

    backend_ptr->finish_all();
    audio.update(0.0F);
    CHECK(adapter.take_completions().empty());
    auto retried =
        adapter.apply(core::AudioOperation{.id = core::AudioOperationId::from_number(212),
                                           .action = core::compiled::AudioAction::Play,
                                           .channel = core::compiled::AudioChannel::SoundEffect,
                                           .asset = asset,
                                           .loop = false,
                                           .volume = 1.0});
    REQUIRE(retried);
    CHECK(backend_ptr->active_voice_count() == 1);
}

TEST_CASE("runtime presentation bridge owns ActiveText barrier without hidden backend dispatch")
{
    const auto project = load_project();
    auto source = std::make_shared<assets::MemoryAssetSource>();
    assets::AssetManager assets;
    assets.mount("project", source);
    AudioSystem audio(std::make_unique<FakeAudioBackend>());
    REQUIRE(audio.initialize(assets));
    assets.bind_audio_loader(&audio);
    PublishedAudioAssets published_audio(assets);
    RuntimeUiProjectAssetService resolver;
    resolver.install(project);
    RuntimeAudioAdapter adapter(audio, resolver, assets);
    RuntimePresentationBridge bridge(adapter);
    std::uint64_t next_operation = 1;
    bridge.bind_presentation_id_allocator(
        [&]() { return core::PresentationOperationId::from_number(next_operation++); });

    REQUIRE(bridge.set_active_text_phase(core::ActiveTextPresentationPhase::Reveal).empty());
    REQUIRE(bridge.checkpoint_status().active_barriers.size() == 1);
    REQUIRE(bridge.set_active_text_phase(core::ActiveTextPresentationPhase::Reveal).empty());
    REQUIRE(bridge.checkpoint_status().active_barriers.size() == 1);
    REQUIRE(bridge.set_active_text_phase(core::ActiveTextPresentationPhase::Fade).empty());
    REQUIRE(bridge.checkpoint_status().active_barriers.size() == 1);
    REQUIRE(bridge.set_active_text_phase(core::ActiveTextPresentationPhase::Stable).empty());
    CHECK(bridge.checkpoint_status().active_barriers.empty());
}

TEST_CASE("runtime presentation bridge tracks nonlooping music until backend termination")
{
    const auto project = load_project();
    auto source = std::make_shared<assets::MemoryAssetSource>();
    assets::AssetManager assets;
    assets.mount("project", source);
    auto backend = std::make_unique<FakeAudioBackend>();
    auto* backend_ptr = backend.get();
    AudioSystem audio(std::move(backend));
    REQUIRE(audio.initialize(assets));
    assets.bind_audio_loader(&audio);
    PublishedAudioAssets published_audio(assets);
    RuntimeUiProjectAssetService resolver;
    resolver.install(project);
    RuntimeAudioAdapter adapter(audio, resolver, assets);
    RuntimePresentationBridge bridge(adapter);

    const core::AudioOperation operation{.id = core::AudioOperationId::from_number(92),
                                         .action = core::compiled::AudioAction::Play,
                                         .channel = core::compiled::AudioChannel::Music,
                                         .asset = core::AssetId::create("audio-voice").value(),
                                         .loop = false,
                                         .volume = 1.0};
    REQUIRE(bridge.accept(operation));
    REQUIRE(bridge.flush().diagnostics.empty());
    REQUIRE(bridge.checkpoint_status().active_barriers.size() == 1);

    backend_ptr->finish_all();
    auto completed = bridge.poll_audio();
    REQUIRE(completed.diagnostics.empty());
    REQUIRE(completed.inputs.size() == 1);
    CHECK(std::holds_alternative<core::AcknowledgeAudioTerminationInput>(completed.inputs.front()));
    CHECK(bridge.checkpoint_status().active_barriers.empty());
}

TEST_CASE("runtime presentation bridge retains exact script audio completion target")
{
    const auto project = load_project();
    auto state = core::SessionState::create(project);
    REQUIRE(state);
    const auto owner = core::flow_frame_id(state.value().flow_stack().back());
    auto invocation = core::ScriptInvocationHandle::create(93);
    REQUIRE(invocation);

    auto source = std::make_shared<assets::MemoryAssetSource>();
    assets::AssetManager assets;
    assets.mount("project", source);
    auto backend = std::make_unique<FakeAudioBackend>();
    auto* backend_ptr = backend.get();
    AudioSystem audio(std::move(backend));
    REQUIRE(audio.initialize(assets));
    assets.bind_audio_loader(&audio);
    PublishedAudioAssets published_audio(assets);
    RuntimeUiProjectAssetService resolver;
    resolver.install(project);
    RuntimeAudioAdapter adapter(audio, resolver, assets);
    RuntimePresentationBridge bridge(adapter);

    const core::AudioCompletionHandle completion = invocation.value();
    const core::AudioOperation operation{.id = core::AudioOperationId::from_number(93),
                                         .action = core::compiled::AudioAction::Play,
                                         .channel = core::compiled::AudioChannel::Voice,
                                         .asset = core::AssetId::create("audio-voice").value(),
                                         .loop = false,
                                         .volume = 1.0,
                                         .owner = owner,
                                         .completion = completion};
    REQUIRE(bridge.accept(operation));
    REQUIRE(bridge.flush().diagnostics.empty());

    backend_ptr->finish_all();
    auto completed = bridge.poll_audio();
    REQUIRE(completed.diagnostics.empty());
    REQUIRE(completed.inputs.size() == 1);
    const auto* input = std::get_if<core::CompleteAudioInput>(&completed.inputs.front());
    REQUIRE(input != nullptr);
    CHECK(*input == core::CompleteAudioInput{operation.id, owner, completion});
    CHECK(bridge.checkpoint_status().active_barriers.empty());
}

TEST_CASE("runtime audio adapter completes an awaited fade-out after AudioSystem update")
{
    const auto project = load_project();
    auto state = core::SessionState::create(project);
    REQUIRE(state);
    const auto owner = core::flow_frame_id(state.value().flow_stack().back());
    auto invocation = core::ScriptInvocationHandle::create(18);
    REQUIRE(invocation);

    auto source = std::make_shared<assets::MemoryAssetSource>();
    assets::AssetManager assets;
    assets.mount("project", source);
    auto backend = std::make_unique<FakeAudioBackend>();
    AudioSystem audio(std::move(backend));
    REQUIRE(audio.initialize(assets));
    assets.bind_audio_loader(&audio);
    PublishedAudioAssets published_audio(assets);
    RuntimeUiProjectAssetService resolver;
    resolver.install(project);
    RuntimeAudioAdapter adapter(audio, resolver, assets);
    const auto asset = core::AssetId::create("audio-voice").value();

    REQUIRE(adapter.apply(core::AudioOperation{.id = core::AudioOperationId::from_number(6),
                                               .action = core::compiled::AudioAction::Play,
                                               .channel = core::compiled::AudioChannel::Music,
                                               .asset = asset,
                                               .loop = true,
                                               .volume = 1.0}));
    const core::AudioOperation stop{
        .id = core::AudioOperationId::from_number(7),
        .action = core::compiled::AudioAction::FadeOut,
        .channel = core::compiled::AudioChannel::Music,
        .asset = std::nullopt,
        .fade = std::chrono::milliseconds{50},
        .loop = false,
        .volume = 1.0,
        .owner = owner,
        .completion = core::AudioCompletionHandle{invocation.value()},
        .target = core::AudioBusOperationTarget{core::compiled::AudioChannel::Music}};
    auto pending = adapter.apply(stop);
    REQUIRE(pending);
    CHECK(pending.value() == TypedRuntimeOperationDisposition::Pending);
    audio.update(0.025F);
    CHECK(adapter.take_completions().empty());
    audio.update(0.025F);
    auto completed = adapter.take_completions();
    REQUIRE(completed.size() == 1);
    CHECK(completed.front() == core::CompleteAudioInput{stop.id, owner, *stop.completion});
}

TEST_CASE("checkpoint load reset stops audio without fabricating completion")
{
    const auto project = load_project();
    auto state = core::SessionState::create(project);
    REQUIRE(state);
    const auto owner = core::flow_frame_id(state.value().flow_stack().back());
    auto completion = core::ScriptInvocationHandle::create(19);
    REQUIRE(completion);

    auto source = std::make_shared<assets::MemoryAssetSource>();
    assets::AssetManager assets;
    assets.mount("project", source);
    auto backend = std::make_unique<FakeAudioBackend>();
    auto* backend_ptr = backend.get();
    AudioSystem audio(std::move(backend));
    REQUIRE(audio.initialize(assets));
    assets.bind_audio_loader(&audio);
    PublishedAudioAssets published_audio(assets);
    RuntimeUiProjectAssetService resolver;
    resolver.install(project);
    RuntimeAudioAdapter adapter(audio, resolver, assets);

    const auto operation =
        core::AudioOperation{.id = core::AudioOperationId::from_number(8),
                             .action = core::compiled::AudioAction::Play,
                             .channel = core::compiled::AudioChannel::Voice,
                             .asset = core::AssetId::create("audio-voice").value(),
                             .loop = false,
                             .volume = 1.0,
                             .owner = owner,
                             .completion = core::AudioCompletionHandle{completion.value()}};
    auto pending = adapter.apply(operation);
    REQUIRE(pending);
    CHECK(pending.value() == TypedRuntimeOperationDisposition::Pending);
    REQUIRE(backend_ptr->active_voice_count() == 1);

    adapter.reset(core::PresentationCancellationReason::CheckpointLoad);
    CHECK(backend_ptr->active_voice_count() == 0);
    CHECK(adapter.take_completions().empty());
    CHECK(adapter.take_terminations().empty());
}
