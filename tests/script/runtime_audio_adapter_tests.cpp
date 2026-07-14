#include <catch2/catch_test_macros.hpp>

#include "noveltea/assets/asset_manager.hpp"
#include "noveltea/assets/asset_source.hpp"
#include "noveltea/audio/audio_backend.hpp"
#include "noveltea/core/compiled_project_codec.hpp"
#include "noveltea/core/session_state.hpp"
#include "noveltea/runtime_audio_adapter.hpp"

#include <nlohmann/json.hpp>

#include <fstream>
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

using namespace noveltea;

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
    bool initialize(const assets::AssetManager&) override
    {
        initialized = true;
        return true;
    }
    void shutdown() override
    {
        initialized = false;
        active.clear();
    }
    assets::AssetResult<assets::AudioAsset>
    load_audio(const assets::AudioAssetRequest& request) override
    {
        last_request = request;
        return {assets::AudioAsset{.clip = AudioClipHandle{next_clip++},
                                   .path = request.path,
                                   .mode = request.mode,
                                   .kind = request.kind},
                {}};
    }
    AudioVoiceHandle play(AudioClipHandle, const AudioPlaybackDesc& desc) override
    {
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
    RuntimeUiAssetResolver resolver;
    resolver.bind(project);
    RuntimeAudioAdapter adapter(audio, resolver);

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
    RuntimeUiAssetResolver resolver;
    resolver.bind(project);
    RuntimeAudioAdapter adapter(audio, resolver);
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

    auto stopped =
        adapter.apply(core::AudioOperation{.id = core::AudioOperationId::from_number(22),
                                           .action = core::compiled::AudioAction::Stop,
                                           .channel = core::compiled::AudioChannel::SoundEffect,
                                           .asset = std::nullopt,
                                           .loop = false,
                                           .volume = 1.0});
    REQUIRE(stopped);
    CHECK(backend_ptr->active_voice_count() == 0);
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
    RuntimeUiAssetResolver resolver;
    resolver.bind(project);
    RuntimeAudioAdapter adapter(audio, resolver);
    const auto asset = core::AssetId::create("audio-voice").value();

    REQUIRE(adapter.apply(core::AudioOperation{.id = core::AudioOperationId::from_number(6),
                                               .action = core::compiled::AudioAction::Play,
                                               .channel = core::compiled::AudioChannel::Music,
                                               .asset = asset,
                                               .loop = true,
                                               .volume = 1.0}));
    const core::AudioOperation stop{.id = core::AudioOperationId::from_number(7),
                                    .action = core::compiled::AudioAction::FadeOut,
                                    .channel = core::compiled::AudioChannel::Music,
                                    .asset = std::nullopt,
                                    .fade = std::chrono::milliseconds{50},
                                    .loop = false,
                                    .volume = 1.0,
                                    .owner = owner,
                                    .completion = core::AudioCompletionHandle{invocation.value()}};
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
