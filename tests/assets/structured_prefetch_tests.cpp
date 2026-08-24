#include <catch2/catch_test_macros.hpp>

#include "noveltea/assets/asset_cache_keys.hpp"
#include "noveltea/assets/asset_manager.hpp"
#include "noveltea/assets/mandatory_asset_gate.hpp"
#include "noveltea/assets/structured_prefetch.hpp"
#include "noveltea/core/compiled_package_codec.hpp"
#include "noveltea/core/compiled_project_codec.hpp"
#include "noveltea/jobs/inline_job_executor.hpp"
#include "../support/json_test_utils.hpp"

#include <nlohmann/json.hpp>

#include <algorithm>
#include <fstream>
#include <iterator>
#include <limits>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <type_traits>
#include <utility>
#include <vector>

namespace {

using namespace noveltea;

template<class Id> Id id(std::string value)
{
    auto parsed = Id::create(std::move(value));
    REQUIRE(parsed);
    return std::move(parsed).value();
}

bool has_code(const core::Diagnostics& diagnostics, std::string_view code)
{
    return std::any_of(
        diagnostics.begin(), diagnostics.end(),
        [code](const core::Diagnostic& diagnostic) { return diagnostic.code == code; });
}

nlohmann::json read_comprehensive_project()
{
    const std::string path = std::string(NOVELTEA_SOURCE_DIR) +
                             "/editor/src/renderer/test/fixtures/compiled-project-golden/"
                             "comprehensive.json";
    std::ifstream file(path, std::ios::binary);
    REQUIRE(file.good());
    const std::string text((std::istreambuf_iterator<char>(file)),
                           std::istreambuf_iterator<char>());
    auto value = nlohmann::json::parse(text, nullptr, false);
    REQUIRE_FALSE(value.is_discarded());
    return value;
}

nlohmann::json shader_material_manifest()
{
    return nlohmann::json::parse(R"json({
      "schema":"noveltea.shader-materials.v2",
      "shaders":{
        "sprite-shader":{
          "display_name":"Sprite",
          "roles":["engine-2d"],
          "role_bindings":{},
          "stages":{
            "vertex":{"compiled":{"glsl-120":{"runtimePath":"project:/shaders/bgfx/glsl-120/sprite.vs.bin","byteHash":"sha256:0000000000000000000000000000000000000000000000000000000000000000","byteSize":1}}},
            "fragment":{"compiled":{"glsl-120":{"runtimePath":"project:/shaders/bgfx/glsl-120/sprite.fs.bin","byteHash":"sha256:0000000000000000000000000000000000000000000000000000000000000000","byteSize":1}}}
          },
          "uniforms":{},
          "samplers":{
            "s_static":{"type":"texture2d","binding":null},
            "s_draw":{"type":"texture2d","binding":null}
          }
        }
      },
      "materials":{
        "sprite-material":{
          "display_name":"Sprite",
          "role":"engine-2d",
          "shader":"sprite-shader",
          "uniforms":{},
          "textures":{
            "s_static":{"source":"project:/assets/images/main.png",
                        "sampler":"repeat-nearest"},
            "s_draw":"$draw.texture"
          },
          "blend":"premultiplied-alpha"
        }
      }
    })json");
}

nlohmann::json package_manifest_for(const core::CompiledProject& project)
{
    nlohmann::json entries = nlohmann::json::array({{{"path", "game"}, {"size", 10}}});
    for (const auto& asset : project.assets())
        entries.push_back({{"path", asset.path}, {"size", 10}});
    entries.push_back({{"path", "shader-materials.json"}, {"size", 10}});
    entries.push_back({{"path", "shaders/bgfx/glsl-120/sprite.vs.bin"}, {"size", 10}});
    entries.push_back({{"path", "shaders/bgfx/glsl-120/sprite.fs.bin"}, {"size", 10}});
    return {
        {"format", "noveltea.runtime-package"},
        {"format_version", 2},
        {"kind", "runtime"},
        {"created_by", "structured-prefetch-test"},
        {"project", {{"name", project.identity().name}, {"version", project.identity().version}}},
        {"display",
         {{"reference_resolution", {{"width", 1920}, {"height", 1080}}},
          {"world_raster_policy", "capped"},
          {"bar_color", "#000000"}}},
        {"accessibility",
         {{"ui_scale", {{"enabled", true}, {"minimum", 1.0}, {"maximum", 2.0}}},
          {"text_scale", {{"enabled", true}, {"minimum", 1.0}, {"maximum", 2.0}}}}},
        {"shader_variants", nlohmann::json::array({"glsl-120"})},
        {"shader_materials",
         {{"entry", "shader-materials.json"},
          {"schema", "noveltea.shader-materials.v2"},
          {"sources_stripped", true}}},
        {"entries", std::move(entries)},
    };
}

std::vector<core::RuntimePackageFile> inventory_for(const core::RuntimePackageManifest& manifest)
{
    std::vector<core::RuntimePackageFile> files;
    for (const auto& entry : manifest.entries)
        files.push_back({entry.path, entry.size, entry.checksum});
    return files;
}

core::LoadedCompiledPackage collector_package()
{
    auto document = read_comprehensive_project();
    document["resources"]["assets"].push_back({{"aliases", nlohmann::json::array()},
                                               {"id", "image-current"},
                                               {"kind", "image"},
                                               {"path", "assets/images/current.png"},
                                               {"sampling", "linear"},
                                               {"width", 64},
                                               {"height", 64}});
    document["resources"]["assets"].push_back({{"aliases", nlohmann::json::array()},
                                               {"id", "image-alt"},
                                               {"kind", "image"},
                                               {"path", "assets/images/alt.png"},
                                               {"sampling", "nearest"},
                                               {"width", 64},
                                               {"height", 64}});
    document["definitions"]["rooms"][2]["background"]["asset"] = {{"id", "image-alt"},
                                                                  {"kind", "asset"}};
    document["definitions"]["scenes"][0]["defaultBackground"]["asset"] = {{"id", "image-main"},
                                                                          {"kind", "asset"}};
    document["definitions"]["scenes"][0]["continuation"] = {
        {"kind", "scene"}, {"scene", {{"id", "opening"}, {"kind", "scene"}}}};
    auto use_verb = document["definitions"]["verbs"][0];
    use_verb["id"] = "use";
    use_verb["slots"] = nlohmann::json::array(
        {{{"id", "target"},
          {"label", {{"markup", "plain"}, {"source", {{"kind", "inline"}, {"text", "Target"}}}}},
          {"prompt", {{"markup", "plain"}, {"source", {{"kind", "inline"}, {"text", "Target"}}}}},
          {"selectors", nlohmann::json::array({{{"kind", "any-subject"}}})}}});
    use_verb["bindingOrder"] = nlohmann::json::array({"target"});
    use_verb["offers"] = nlohmann::json::array();
    document["definitions"]["verbs"].push_back(std::move(use_verb));
    const auto alpha_hotspot = nlohmann::json{{"kind", "sprite-alpha"},
                                              {"hotspot",
                                               {{"target", {{"kind", "owner"}}},
                                                {"condition", {{"kind", "always"}}},
                                                {"highlight", {{"kind", "default"}}},
                                                {"id", "shared-alpha"},
                                                {"inputOrder", 0},
                                                {"label", "Shared alpha"}}}};
    auto* coin = test_support::json_object_by_id(document["definitions"]["interactables"], "coin");
    REQUIRE(coin != nullptr);
    (*coin)["presentation"]["hotspots"] = {
        {"kind", "custom"},
        {"hotspots",
         nlohmann::json::array(
             {{{"target", {{"kind", "owner"}}},
               {"condition", {{"kind", "always"}}},
               {"highlight", {{"kind", "none"}}},
               {"id", "coin-none"},
               {"inputOrder", 0},
               {"label", "Coin none"},
               {"shape",
                {{"kind", "rect"},
                 {"bounds", {{"x", 0.0}, {"y", 0.0}, {"width", 1.0}, {"height", 1.0}}}}}}})}};
    auto* key = test_support::json_object_by_id(document["definitions"]["interactables"], "key");
    REQUIRE(key != nullptr);
    (*key)["presentation"]["hotspots"] = alpha_hotspot;
    const nlohmann::json hall_hotspot = {
        {"target", {{"kind", "exit"}, {"exitId", "south-exit"}}},
        {"condition", {{"kind", "always"}}},
        {"highlight", {{"kind", "default"}}},
        {"id", "hall-door"},
        {"inputOrder", 0},
        {"label", "Hall door"},
        {"shape",
         {{"kind", "rect"},
          {"bounds", {{"x", 0.25}, {"y", 0.25}, {"width", 0.5}, {"height", 0.5}}}}}};
    document["definitions"]["rooms"][0]["hotspots"] = nlohmann::json::array({hall_hotspot});

    auto project = core::decode_compiled_project(document, "structured-prefetch-project.json");
    if (!project) {
        for (const auto& diagnostic : project.error())
            WARN(diagnostic.code << ": " << diagnostic.message);
    }
    REQUIRE(project);
    auto manifest = core::decode_runtime_package_manifest(package_manifest_for(project.value()));
    REQUIRE(manifest);
    auto shader_materials = core::decode_shader_material_manifest(shader_material_manifest());
    if (!shader_materials) {
        for (const auto& diagnostic : shader_materials.error())
            WARN(diagnostic.code << ": " << diagnostic.message);
    }
    REQUIRE(shader_materials);
    auto inventory = inventory_for(manifest.value());
    auto package =
        core::assemble_compiled_package(std::move(project).value(), std::move(manifest).value(),
                                        std::move(shader_materials).value(), std::move(inventory));
    REQUIRE(package);
    return std::move(package).value();
}

template<class Request, class Predicate>
std::optional<std::size_t>
find_request(const std::vector<assets::StructuredAssetRequestDescriptor>& list, Predicate predicate)
{
    for (std::size_t index = 0; index < list.size(); ++index) {
        const auto* request = std::get_if<Request>(&list[index].request);
        if (request != nullptr && predicate(*request))
            return index;
    }
    return std::nullopt;
}

template<class Request>
assets::StructuredAssetRequestDescriptor descriptor(Request request,
                                                    assets::AssetSourceGeneration generation)
{
    assets::AssetCacheKey key;
    if constexpr (std::is_same_v<Request, assets::FontAssetRequest>)
        key = assets::make_font_cache_key(request, generation);
    else if constexpr (std::is_same_v<Request, assets::TextureAssetRequest>)
        key = assets::make_texture_cache_key(request, generation);
    else if constexpr (std::is_same_v<Request, assets::HotspotMaskAssetRequest>)
        key = assets::make_hotspot_mask_cache_key(request, generation);
    else if constexpr (std::is_same_v<Request, assets::ShaderProgramAssetRequest>)
        key = assets::make_shader_program_cache_key(request, generation);
    else if constexpr (std::is_same_v<Request, assets::MaterialAssetRequest>)
        key = assets::make_material_cache_key(request, generation);
    else
        key = assets::make_audio_cache_key(request, generation);
    return {.request = std::move(request), .cache_key = std::move(key)};
}

assets::ResidencyBudget generous_budget()
{
    return {.source_bytes = 1024 * 1024,
            .prepared_cpu_bytes = 1024 * 1024,
            .gpu_bytes = 1024 * 1024,
            .audio_bytes = 1024 * 1024,
            .temporary_bytes = 1024 * 1024};
}

template<class T> class ImmediatePreparationTask final : public assets::AssetPreparationTask<T> {
public:
    explicit ImmediatePreparationTask(T asset) : m_asset(std::move(asset)) {}

    [[nodiscard]] assets::ResidencyCost estimated_cost_on_owner() const noexcept override
    {
        return {.prepared_cpu_bytes = 1};
    }

    [[nodiscard]] jobs::JobStepOutcome step(jobs::JobContext& context) noexcept override
    {
        m_ready = !context.cancellation_requested();
        return {.status = jobs::JobStepStatus::Completed, .diagnostics = {}};
    }

    [[nodiscard]] core::Result<assets::PreparedAsset<T>, core::Diagnostics>
    finalize_on_owner() noexcept override
    {
        if (!m_ready) {
            return core::Result<assets::PreparedAsset<T>, core::Diagnostics>::failure(
                {{.code = "test.prefetch_not_ready", .message = "test task was canceled"}});
        }
        return core::Result<assets::PreparedAsset<T>, core::Diagnostics>::success(
            {.asset = std::move(m_asset),
             .cost = {.prepared_cpu_bytes = 1},
             .destroy_on_owner = {}});
    }

private:
    T m_asset;
    bool m_ready = false;
};

struct DispatchRecorder {
    std::vector<std::string> calls;
    bool reject_material = false;
};

class PrefetchGenerationCaptureSink final : public core::AssetTelemetrySink {
public:
    void record(core::AssetTelemetryEvent) noexcept override {}

    [[nodiscard]] core::AssetTelemetrySnapshot snapshot_on_owner() const override { return {}; }

    void record_prefetch_generation(
        const core::AssetProfilerPrefetchGenerationRecord& record) noexcept override
    {
        generations.push_back(record);
    }

    void
    record_prefetch_generation_released(assets::PrefetchGenerationId generation) noexcept override
    {
        released.push_back(generation);
    }

    void record_asset_wait_started(const core::AssetWaitStart& wait) noexcept override
    {
        wait_starts.push_back(wait);
    }

    void record_asset_wait_finished(const core::AssetWaitFinish& wait) noexcept override
    {
        wait_finishes.push_back(wait);
    }

    std::vector<core::AssetProfilerPrefetchGenerationRecord> generations;
    std::vector<assets::PrefetchGenerationId> released;
    std::vector<core::AssetWaitStart> wait_starts;
    std::vector<core::AssetWaitFinish> wait_finishes;
};

class RecordingFontLoader final : public assets::FontAssetLoader {
public:
    explicit RecordingFontLoader(DispatchRecorder& recorder) : m_recorder(recorder) {}
    assets::AssetLoadResult<assets::FontAsset>
    load_font(const assets::FontAssetRequest& request) override
    {
        return {assets::FontAsset{.resolved_alias = request.alias}, {}};
    }
    std::unique_ptr<assets::AssetPreparationTask<assets::FontAsset>>
    create_font_preparation_task(const assets::FontAssetRequest& request) override
    {
        m_recorder.calls.push_back("font:" + request.alias);
        return std::make_unique<ImmediatePreparationTask<assets::FontAsset>>(
            assets::FontAsset{.resolved_alias = request.alias});
    }

private:
    DispatchRecorder& m_recorder;
};

class RecordingTextureLoader final : public assets::TextureAssetLoader {
public:
    explicit RecordingTextureLoader(DispatchRecorder& recorder) : m_recorder(recorder) {}
    assets::AssetLoadResult<assets::TextureAsset>
    load_texture(const assets::TextureAssetRequest& request) override
    {
        return {assets::TextureAsset{.handle = 1, .path = request.path}, {}};
    }
    std::unique_ptr<assets::AssetPreparationTask<assets::TextureAsset>>
    create_texture_preparation_task(const assets::TextureAssetRequest& request) override
    {
        m_recorder.calls.push_back("texture:" + request.path);
        return std::make_unique<ImmediatePreparationTask<assets::TextureAsset>>(
            assets::TextureAsset{.handle = 1, .path = request.path, .sampler = request.sampler});
    }

private:
    DispatchRecorder& m_recorder;
};

class RecordingHotspotMaskLoader final : public assets::HotspotMaskAssetLoader {
public:
    explicit RecordingHotspotMaskLoader(DispatchRecorder& recorder) : m_recorder(recorder) {}
    std::unique_ptr<assets::AssetPreparationTask<assets::HotspotMaskAsset>>
    create_hotspot_mask_preparation_task(const assets::HotspotMaskAssetRequest& request) override
    {
        m_recorder.calls.push_back("hotspot-mask");
        return std::make_unique<ImmediatePreparationTask<assets::HotspotMaskAsset>>(
            assets::HotspotMaskAsset{.owner = request.owner,
                                     .handle = 3,
                                     .width = request.width,
                                     .height = request.height});
    }

private:
    DispatchRecorder& m_recorder;
};

class RecordingShaderLoader final : public assets::ShaderProgramAssetLoader {
public:
    explicit RecordingShaderLoader(DispatchRecorder& recorder) : m_recorder(recorder) {}
    assets::AssetLoadResult<assets::ShaderProgramAsset>
    load_shader_program(const assets::ShaderProgramAssetRequest& request) override
    {
        return {assets::ShaderProgramAsset{.handle = 2, .key = request.resolution.key}, {}};
    }
    std::unique_ptr<assets::AssetPreparationTask<assets::ShaderProgramAsset>>
    create_shader_program_preparation_task(
        const assets::ShaderProgramAssetRequest& request) override
    {
        m_recorder.calls.push_back("shader:" + request.resolution.key.material_id);
        return std::make_unique<ImmediatePreparationTask<assets::ShaderProgramAsset>>(
            assets::ShaderProgramAsset{.handle = 2, .key = request.resolution.key});
    }

private:
    DispatchRecorder& m_recorder;
};

class RecordingMaterialLoader final : public assets::MaterialAssetLoader {
public:
    explicit RecordingMaterialLoader(DispatchRecorder& recorder) : m_recorder(recorder) {}
    assets::AssetLoadResult<assets::MaterialAsset>
    load_material(const assets::MaterialAssetRequest& request) override
    {
        return {assets::MaterialAsset{.id = request.id}, {}};
    }
    std::unique_ptr<assets::AssetPreparationTask<assets::MaterialAsset>>
    create_material_preparation_task(const assets::MaterialAssetRequest& request) override
    {
        m_recorder.calls.push_back("material:" + request.id);
        if (m_recorder.reject_material)
            return {};
        return std::make_unique<ImmediatePreparationTask<assets::MaterialAsset>>(
            assets::MaterialAsset{.id = request.id});
    }

private:
    DispatchRecorder& m_recorder;
};

class RecordingAudioLoader final : public assets::AudioAssetLoader {
public:
    explicit RecordingAudioLoader(DispatchRecorder& recorder) : m_recorder(recorder) {}
    assets::AssetLoadResult<assets::AudioAsset>
    load_audio(const assets::AudioAssetRequest& request) override
    {
        return {assets::AudioAsset{.clip = AudioClipHandle{1},
                                   .path = request.path,
                                   .mode = request.mode,
                                   .kind = request.kind},
                {}};
    }
    std::unique_ptr<assets::AssetPreparationTask<assets::AudioAsset>>
    create_audio_preparation_task(const assets::AudioAssetRequest& request) override
    {
        m_recorder.calls.push_back("audio:" + request.path);
        return std::make_unique<ImmediatePreparationTask<assets::AudioAsset>>(
            assets::AudioAsset{.clip = AudioClipHandle{1},
                               .path = request.path,
                               .mode = request.mode,
                               .kind = request.kind});
    }

private:
    DispatchRecorder& m_recorder;
};

struct PlannerFixture {
    jobs::InlineJobExecutor executor;
    std::shared_ptr<assets::AssetResidencyManager> residency =
        std::make_shared<assets::AssetResidencyManager>(generous_budget());
    assets::AssetManager manager;
    DispatchRecorder recorder;
    RecordingFontLoader fonts{recorder};
    RecordingTextureLoader textures{recorder};
    RecordingHotspotMaskLoader hotspot_masks{recorder};
    RecordingShaderLoader shaders{recorder};
    RecordingMaterialLoader materials{recorder};
    RecordingAudioLoader audio{recorder};

    explicit PlannerFixture(core::AssetTelemetrySink* telemetry = nullptr)
    {
        REQUIRE(manager.configure_async_requests(executor, residency, telemetry));
        manager.bind_font_loader(&fonts);
        manager.bind_texture_loader(&textures);
        manager.bind_hotspot_mask_loader(&hotspot_masks);
        manager.bind_shader_program_loader(&shaders);
        manager.bind_material_loader(&materials);
        manager.bind_audio_loader(&audio);
    }

    ~PlannerFixture()
    {
        executor.begin_shutdown();
        (void)executor.dispatch_owner_completions(std::numeric_limits<std::size_t>::max());
    }

    void run_until_idle()
    {
        for (std::size_t iteration = 0; iteration < 256; ++iteration) {
            (void)executor.dispatch_owner_completions(std::numeric_limits<std::size_t>::max());
            if (!executor.advance_one_step()) {
                (void)executor.dispatch_owner_completions(std::numeric_limits<std::size_t>::max());
                return;
            }
        }
        FAIL("inline executor did not become idle");
    }
};

assets::ShaderProgramAssetRequest shader_request(std::string material)
{
    assets::ShaderProgramAssetRequest request;
    request.resolution.key.material_id = std::move(material);
    request.resolution.key.variant = "glsl-120";
    request.resolution.key.vertex_path = "project:/shaders/test.vs.bin";
    request.resolution.key.fragment_path = "project:/shaders/test.fs.bin";
    return request;
}

} // namespace

TEST_CASE("structured collector builds typed ordered closure without dynamic sources",
          "[assets][structured-prefetch]")
{
    auto package = collector_package();
    const assets::AssetSourceGeneration generation{41};
    const auto index =
        assets::StructuredAssetDependencyIndex::build(package, "glsl-120", generation);
    CHECK_FALSE(has_code(index.diagnostics(), "assets.prefetch_shader_resolution_failed"));
    const auto& requirements = index.texture_preparation_requirements();
    REQUIRE(requirements.size() == 1);
    const assets::TextureAssetRequest canonical_image{
        .path = "project:/assets/images/main.png",
        .sampler = MaterialTextureSampler::ClampLinear,
    };
    REQUIRE(requirements.contains(assets::make_texture_cache_key(canonical_image, generation)));
    CHECK(requirements.at(assets::make_texture_cache_key(canonical_image, generation))
              .retain_alpha_coverage);

    core::RuntimePresentationSnapshot snapshot;
    snapshot.current_room = id<core::RoomId>("start");
    snapshot.background = core::PresentationBackground{.asset = id<core::AssetId>("image-current"),
                                                       .color = std::nullopt,
                                                       .fit = core::compiled::BackgroundFit::Cover,
                                                       .material = std::nullopt};
    snapshot.desired_audio.push_back(core::PresentationDesiredAudio{
        .instance = id<core::DesiredAudioInstanceId>("voice-current"),
        .owner = core::RoomPresentationOwner{id<core::RoomId>("start")},
        .purpose = core::compiled::AudioPurpose::Voice,
        .pause_policy = core::compiled::AudioPausePolicy::Gameplay,
        .asset = id<core::AssetId>("audio-voice")});

    assets::StructuredAssetDependencyContext context;
    context.current_presentation = &snapshot;
    context.direct_next = core::compiled::Entrypoint{id<core::RoomId>("hall")};
    context.adjacent_alternatives = {core::compiled::Entrypoint{id<core::RoomId>("tower")},
                                     core::compiled::Entrypoint{id<core::RoomId>("tower")}};

    const assets::StructuredAssetDependencyCollector collector(index);
    const auto collected = collector.collect(context);

    REQUIRE(find_request<assets::TextureAssetRequest>(
        collected.current_mandatory,
        [](const auto& request) { return request.path == "project:/assets/images/current.png"; }));
    REQUIRE(find_request<assets::AudioAssetRequest>(
        collected.current_mandatory, [](const auto& request) {
            return request.path == "project:/assets/audio/voice.ogg" &&
                   request.kind == AudioClipKind::Voice;
        }));

    const auto material = find_request<assets::MaterialAssetRequest>(
        collected.direct_next, [](const auto& request) { return request.id == "sprite-material"; });
    const auto shader = find_request<assets::ShaderProgramAssetRequest>(
        collected.direct_next, [](const auto& request) {
            return request.resolution.key.material_id == "sprite-material" &&
                   request.resolution.key.variant == "glsl-120";
        });
    const auto static_texture =
        find_request<assets::TextureAssetRequest>(collected.direct_next, [](const auto& request) {
            return request.path == "project:/assets/images/main.png" &&
                   request.sampler == MaterialTextureSampler::RepeatNearest;
        });
    REQUIRE(material);
    REQUIRE(shader);
    REQUIRE(static_texture);
    CHECK(*material < *shader);
    CHECK(*shader < *static_texture);
    CHECK_FALSE(
        find_request<assets::TextureAssetRequest>(collected.direct_next, [](const auto& request) {
            return request.path == "$draw.texture";
        }));
    const auto room_mask = find_request<assets::HotspotMaskAssetRequest>(
        collected.direct_next, [](const auto& request) {
            const auto* owner = std::get_if<core::compiled::RoomHotspotOwnerRef>(&request.owner);
            return owner != nullptr && owner->room.text() == "hall" && request.width == 1920 &&
                   request.height == 1080 && request.regions.size() == 1;
        });
    REQUIRE(room_mask);
    CHECK_FALSE(find_request<assets::HotspotMaskAssetRequest>(
        collected.direct_next, [](const auto& request) {
            return std::holds_alternative<core::compiled::InteractableHotspotOwnerRef>(
                request.owner);
        }));

    REQUIRE(find_request<assets::TextureAssetRequest>(
        collected.adjacent_alternatives, [](const auto& request) {
            return request.path == "project:/assets/images/alt.png" &&
                   request.sampler == MaterialTextureSampler::ClampNearest;
        }));

    std::vector<assets::AssetCacheKey> keys;
    for (const auto* bucket :
         {&collected.current_mandatory, &collected.direct_next, &collected.adjacent_alternatives}) {
        for (const auto& item : *bucket) {
            CHECK(item.cache_key.source_generation == generation);
            CHECK(std::find(keys.begin(), keys.end(), item.cache_key) == keys.end());
            keys.push_back(item.cache_key);
        }
    }

    assets::StructuredAssetDependencyContext cyclic;
    cyclic.direct_next = core::compiled::Entrypoint{id<core::SceneId>("opening")};
    const auto cycle = collector.collect(cyclic);
    CHECK(has_code(cycle.diagnostics, "assets.prefetch_dependency_cycle"));
    CHECK(cycle.mandatory_diagnostics.empty());
}

TEST_CASE("optional adjacency diagnostics do not block current mandatory publication",
          "[assets][structured-prefetch][mandatory-assets][optional-prefetch]")
{
    PlannerFixture fixture;
    auto package = collector_package();
    const auto generation = fixture.manager.source_generation_on_owner();
    const auto index =
        assets::StructuredAssetDependencyIndex::build(package, "missing-variant", generation);

    core::RuntimePresentationSnapshot snapshot;
    snapshot.revision = core::PresentationSnapshotRevision::from_number(9);
    snapshot.mode = core::PresentationRuntimeMode::Ended;
    snapshot.current_room = id<core::RoomId>("start");
    snapshot.background = core::PresentationBackground{.asset = id<core::AssetId>("image-current"),
                                                       .color = std::nullopt,
                                                       .fit = core::compiled::BackgroundFit::Cover,
                                                       .material = std::nullopt};

    assets::StructuredAssetDependencyContext context;
    context.current_presentation = &snapshot;
    const assets::StructuredAssetDependencyCollector collector(index);
    const auto collected = collector.collect(context);
    CHECK(has_code(collected.diagnostics, "assets.prefetch_shader_resolution_failed"));
    CHECK_FALSE(
        has_code(collected.mandatory_diagnostics, "assets.prefetch_shader_resolution_failed"));

    assets::MandatoryAssetGate gate(fixture.manager);
    REQUIRE(gate.bind_package_on_owner(package, "missing-variant", generation));
    const auto begun = gate.begin_on_owner(snapshot);
    REQUIRE(begun.disposition == assets::MandatoryAssetGateDisposition::Pending);
    fixture.run_until_idle();
    const auto ready = gate.poll_on_owner();
    REQUIRE(ready.disposition == assets::MandatoryAssetGateDisposition::Ready);
    REQUIRE(gate.activate_candidate_on_owner());
    gate.commit_candidate_on_owner();
    CHECK(fixture.manager.has_published_leases_on_owner());
    gate.clear_package_on_owner();
}

TEST_CASE("mandatory package rebinding reuses identical generation-scoped texture requirements",
          "[assets][structured-prefetch][mandatory-assets][texture-alpha]")
{
    PlannerFixture fixture;
    auto package = collector_package();
    const auto generation = fixture.manager.source_generation_on_owner();
    assets::MandatoryAssetGate gate(fixture.manager);

    REQUIRE(gate.bind_package_on_owner(package, "glsl-120", generation));
    gate.clear_package_on_owner();
    REQUIRE(gate.bind_package_on_owner(package, "glsl-120", generation));
}

TEST_CASE("mandatory gate rebuilds generation-scoped dependency keys after project source refresh",
          "[assets][structured-prefetch][mandatory-assets][source-generation]")
{
    PlannerFixture fixture;
    auto package = collector_package();
    const auto bound_generation = fixture.manager.source_generation_on_owner();
    assets::MandatoryAssetGate gate(fixture.manager);
    REQUIRE(gate.bind_package_on_owner(package, "glsl-120", bound_generation));

    fixture.manager.mount("project", std::make_shared<assets::MemoryAssetSource>());
    const auto refreshed_generation = fixture.manager.source_generation_on_owner();
    REQUIRE(refreshed_generation != bound_generation);

    core::RuntimePresentationSnapshot snapshot;
    snapshot.revision = core::PresentationSnapshotRevision::from_number(10);
    snapshot.mode = core::PresentationRuntimeMode::Room;
    snapshot.current_room = id<core::RoomId>("start");
    snapshot.background = core::PresentationBackground{.asset = id<core::AssetId>("image-current"),
                                                       .color = std::nullopt,
                                                       .fit = core::compiled::BackgroundFit::Cover,
                                                       .material = std::nullopt};

    const auto begun = gate.begin_on_owner(snapshot);
    REQUIRE(begun.disposition == assets::MandatoryAssetGateDisposition::Pending);
    fixture.run_until_idle();
    const auto ready = gate.poll_on_owner();
    REQUIRE(ready.disposition == assets::MandatoryAssetGateDisposition::Ready);
    REQUIRE(gate.activate_candidate_on_owner());

    const assets::TextureAssetRequest background{
        .path = "project:/assets/images/current.png",
        .sampler = MaterialTextureSampler::ClampLinear,
    };
    CHECK(fixture.manager.leased_texture_on_owner(background) != nullptr);
    gate.commit_candidate_on_owner();
    CHECK(fixture.manager.leased_texture_on_owner(background) != nullptr);
    gate.clear_package_on_owner();
}

TEST_CASE("mandatory gate restarts pending requests after a project source refresh",
          "[assets][structured-prefetch][mandatory-assets][source-generation]")
{
    PlannerFixture fixture;
    auto package = collector_package();
    auto project_source = std::make_shared<assets::MemoryAssetSource>();
    fixture.manager.mount("project", project_source);
    const auto initial_generation = fixture.manager.source_generation_on_owner();

    assets::MandatoryAssetGate gate(fixture.manager);
    REQUIRE(gate.bind_package_on_owner(package, "glsl-120", initial_generation));

    core::RuntimePresentationSnapshot snapshot;
    snapshot.revision = core::PresentationSnapshotRevision::from_number(31);
    snapshot.mode = core::PresentationRuntimeMode::Room;
    snapshot.current_room = id<core::RoomId>("start");
    snapshot.background = core::PresentationBackground{.asset = id<core::AssetId>("image-current"),
                                                       .color = std::nullopt,
                                                       .fit = core::compiled::BackgroundFit::Cover,
                                                       .material = std::nullopt};

    const auto begun = gate.begin_on_owner(snapshot);
    REQUIRE(begun.disposition == assets::MandatoryAssetGateDisposition::Pending);

    auto refreshed = fixture.manager.refresh_namespace_on_owner("project");
    REQUIRE(refreshed);
    const auto refreshed_generation = *refreshed.value_if();
    REQUIRE(refreshed_generation != initial_generation);

    const auto restarted = gate.poll_on_owner();
    REQUIRE(restarted.disposition == assets::MandatoryAssetGateDisposition::Pending);
    fixture.run_until_idle();
    const auto ready = gate.poll_on_owner();
    REQUIRE(ready.disposition == assets::MandatoryAssetGateDisposition::Ready);
    REQUIRE(gate.activate_candidate_on_owner());

    const assets::TextureAssetRequest request{
        .path = "project:/assets/images/current.png",
        .sampler = MaterialTextureSampler::ClampLinear,
    };
    REQUIRE(fixture.manager.leased_texture_on_owner(request) != nullptr);
    gate.commit_candidate_on_owner();
    REQUIRE(fixture.manager.leased_texture_on_owner(request) != nullptr);
    gate.clear_package_on_owner();
}

TEST_CASE(
    "structured lease lookup uses the ready lease cache key rather than stale descriptor metadata",
    "[assets][structured-prefetch][mandatory-assets][source-generation]")
{
    PlannerFixture fixture;
    const assets::TextureAssetRequest request{
        .path = "project:/assets/images/current.png",
        .sampler = MaterialTextureSampler::ClampLinear,
    };
    const auto descriptor_generation = fixture.manager.source_generation_on_owner();
    const auto stale_descriptor = descriptor(request, descriptor_generation);

    fixture.manager.mount("project", std::make_shared<assets::MemoryAssetSource>());
    const auto request_generation = fixture.manager.source_generation_on_owner();
    REQUIRE(request_generation != descriptor_generation);

    assets::MandatoryAssetRequestGroup group(
        fixture.manager, {stale_descriptor},
        {.reason = assets::AssetRequestReason::Demand, .show_overlay_immediately = true});
    fixture.run_until_idle();
    group.poll_on_owner();
    REQUIRE(group.state_on_owner() == assets::MandatoryAssetGroupState::Ready);
    auto leases = group.take_ready_leases_on_owner();
    REQUIRE(leases);

    const auto current_key = assets::make_texture_cache_key(request, request_generation);
    REQUIRE(leases->find_texture(current_key) != nullptr);
    CHECK(leases->find_texture(stale_descriptor.cache_key) == nullptr);

    fixture.manager.stage_candidate_leases_on_owner(std::move(*leases));
    CHECK(fixture.manager.leased_texture_on_owner(request) != nullptr);
    fixture.manager.rollback_candidate_leases_on_owner();
}

TEST_CASE("direct-next hotspot mask prefetch is ready for the mandatory publication gate",
          "[assets][structured-prefetch][hotspot-mask]")
{
    PlannerFixture fixture;
    auto package = collector_package();
    const auto generation = fixture.manager.source_generation_on_owner();
    const auto index =
        assets::StructuredAssetDependencyIndex::build(package, "glsl-120", generation);
    assets::StructuredAssetDependencyContext context;
    context.direct_next = core::compiled::Entrypoint{id<core::RoomId>("hall")};
    const assets::StructuredAssetDependencyCollector collector(index);
    const auto collected = collector.collect(context);
    const auto mask = find_request<assets::HotspotMaskAssetRequest>(
        collected.direct_next, [](const auto&) { return true; });
    REQUIRE(mask);

    assets::PrefetchPlanner planner(fixture.manager);
    const auto report = planner.replace_generation_on_owner(collected);
    REQUIRE(report);
    fixture.run_until_idle();
    CHECK(std::count(fixture.recorder.calls.begin(), fixture.recorder.calls.end(),
                     "hotspot-mask") == 1);

    assets::MandatoryAssetRequestGroup mandatory(
        fixture.manager, {collected.direct_next[*mask]},
        {.reason = assets::AssetRequestReason::Demand, .show_overlay_immediately = true});
    mandatory.poll_on_owner();
    CHECK(mandatory.state_on_owner() == assets::MandatoryAssetGroupState::Ready);
    auto leases = mandatory.take_ready_leases_on_owner();
    REQUIRE(leases);
    CHECK(leases->find_hotspot_mask(collected.direct_next[*mask].cache_key) != nullptr);
}

#if NOVELTEA_ENABLE_EDITOR_ASSET_PROFILER
TEST_CASE("mandatory gate publishes bucket-aware prefetch generation reports",
          "[assets][structured-prefetch][mandatory-assets][profiler]")
{
    PrefetchGenerationCaptureSink sink;
    PlannerFixture fixture(&sink);
    auto package = collector_package();
    const auto generation = fixture.manager.source_generation_on_owner();
    assets::MandatoryAssetGate gate(fixture.manager);
    REQUIRE(gate.bind_package_on_owner(package, "glsl-120", generation));

    core::RuntimePresentationSnapshot snapshot;
    snapshot.revision = core::PresentationSnapshotRevision::from_number(23);
    snapshot.mode = core::PresentationRuntimeMode::Ended;
    snapshot.current_room = id<core::RoomId>("start");
    snapshot.background = core::PresentationBackground{.asset = id<core::AssetId>("image-current"),
                                                       .color = std::nullopt,
                                                       .fit = core::compiled::BackgroundFit::Cover,
                                                       .material = std::nullopt};
    auto begun = gate.begin_on_owner(snapshot);
    REQUIRE(begun.disposition == assets::MandatoryAssetGateDisposition::Pending);
    fixture.run_until_idle();
    auto ready = gate.poll_on_owner();
    REQUIRE(ready.disposition == assets::MandatoryAssetGateDisposition::Ready);
    REQUIRE(gate.activate_candidate_on_owner());
    gate.commit_candidate_on_owner();

    REQUIRE(sink.generations.size() == 1);
    const auto& record = sink.generations.front();
    CHECK(record.generation.valid());
    CHECK(record.presentation_revision == snapshot.revision);
    CHECK(record.expected_next_count + record.possible_next_count ==
          record.submitted_entries.size() + record.submission_failures.size());
    CHECK(record.possible_next_count > 0);
    CHECK(std::ranges::all_of(record.submitted_entries, [](const auto& entry) {
        return entry.prediction == core::PrefetchPredictionKind::ExpectedNext ||
               entry.prediction == core::PrefetchPredictionKind::PossibleNext;
    }));
    CHECK(gate.active_prefetch_generation_on_owner() == record.generation);

    gate.clear_package_on_owner();
    REQUIRE(sink.released.size() == 1);
    CHECK(sink.released.front() == record.generation);
}

TEST_CASE("mandatory wait ownership closes once across rollback replacement and destruction",
          "[assets][structured-prefetch][mandatory-assets][profiler][wait]")
{
    PrefetchGenerationCaptureSink sink;
    PlannerFixture fixture(&sink);
    auto package = collector_package();
    const auto generation = fixture.manager.source_generation_on_owner();
    const auto snapshot_for = [](std::uint64_t revision) {
        core::RuntimePresentationSnapshot snapshot;
        snapshot.revision = core::PresentationSnapshotRevision::from_number(revision);
        snapshot.mode = core::PresentationRuntimeMode::Ended;
        snapshot.current_room = id<core::RoomId>("start");
        snapshot.background =
            core::PresentationBackground{.asset = id<core::AssetId>("image-current"),
                                         .color = std::nullopt,
                                         .fit = core::compiled::BackgroundFit::Cover,
                                         .material = std::nullopt};
        return snapshot;
    };

    {
        assets::MandatoryAssetGate gate(fixture.manager);
        REQUIRE(gate.bind_package_on_owner(package, "glsl-120", generation));

        REQUIRE(gate.begin_on_owner(snapshot_for(31)).disposition ==
                assets::MandatoryAssetGateDisposition::Pending);
        REQUIRE(sink.wait_starts.size() == 1);
        gate.cancel_on_owner();
        gate.cancel_on_owner();
        REQUIRE(sink.wait_finishes.size() == 1);
        CHECK(sink.wait_finishes.back().operation == sink.wait_starts[0].operation);
        CHECK(sink.wait_finishes.back().result == core::AssetWaitResult::Canceled);

        REQUIRE(gate.begin_on_owner(snapshot_for(32)).disposition ==
                assets::MandatoryAssetGateDisposition::Pending);
        REQUIRE(sink.wait_starts.size() == 2);
        REQUIRE(gate.bind_package_on_owner(package, "glsl-120", generation));
        REQUIRE(sink.wait_finishes.size() == 2);
        CHECK(sink.wait_finishes.back().operation == sink.wait_starts[1].operation);
        CHECK(sink.wait_finishes.back().result == core::AssetWaitResult::Canceled);

        REQUIRE(gate.begin_on_owner(snapshot_for(33)).disposition ==
                assets::MandatoryAssetGateDisposition::Pending);
        REQUIRE(sink.wait_starts.size() == 3);
    }
    REQUIRE(sink.wait_finishes.size() == 3);
    CHECK(sink.wait_finishes.back().operation == sink.wait_starts[2].operation);
    CHECK(sink.wait_finishes.back().result == core::AssetWaitResult::Canceled);

    const auto standalone = descriptor(
        assets::TextureAssetRequest{.path = "project:/textures/shutdown-wait.png"}, generation);
    {
        assets::MandatoryAssetRequestGroup group(fixture.manager, {standalone});
        group.poll_on_owner();
        REQUIRE(group.state_on_owner() == assets::MandatoryAssetGroupState::Pending);
        REQUIRE(sink.wait_starts.size() == 4);
    }
    REQUIRE(sink.wait_finishes.size() == 4);
    CHECK(sink.wait_finishes.back().operation == sink.wait_starts[3].operation);
    CHECK(sink.wait_finishes.back().result == core::AssetWaitResult::Canceled);

    const auto replaced = descriptor(
        assets::TextureAssetRequest{.path = "project:/textures/replaced-wait.png"}, generation);
    const auto replacing = descriptor(
        assets::TextureAssetRequest{.path = "project:/textures/replacing-wait.png"}, generation);
    {
        assets::MandatoryAssetRequestGroup target(fixture.manager, {replaced});
        target.poll_on_owner();
        assets::MandatoryAssetRequestGroup source(fixture.manager, {replacing});
        source.poll_on_owner();
        REQUIRE(sink.wait_starts.size() == 6);
        target = std::move(source);
        REQUIRE(sink.wait_finishes.size() == 5);
        CHECK(sink.wait_finishes.back().operation == sink.wait_starts[4].operation);
        CHECK(sink.wait_finishes.back().result == core::AssetWaitResult::Canceled);
    }
    REQUIRE(sink.wait_finishes.size() == 6);
    CHECK(sink.wait_finishes.back().operation == sink.wait_starts[5].operation);
    CHECK(sink.wait_finishes.back().result == core::AssetWaitResult::Canceled);
    CHECK(std::ranges::all_of(sink.wait_starts, [](const auto& wait) {
        return wait.operation.valid() && !wait.waiting_requests.empty();
    }));
}
#endif

TEST_CASE("prefetch planner dispatches typed requests in deterministic bucket order",
          "[assets][structured-prefetch]")
{
    PlannerFixture fixture;
    assets::PrefetchPlanner planner(fixture.manager);
    const auto generation = fixture.manager.source_generation_on_owner();

    const auto font = descriptor(
        assets::FontAssetRequest{.alias = "body", .source_path = std::nullopt}, generation);
    const auto texture =
        descriptor(assets::TextureAssetRequest{.path = "project:/textures/direct.png"}, generation);
    const auto shader = descriptor(shader_request("direct-material"), generation);
    const auto material =
        descriptor(assets::MaterialAssetRequest{.id = "adjacent-material"}, generation);
    const auto audio = descriptor(assets::AudioAssetRequest{.path = "project:/audio/adjacent.ogg",
                                                            .mode = AudioLoadMode::Stream,
                                                            .kind = AudioClipKind::Music},
                                  generation);

    assets::StructuredAssetDependencyBuckets dependencies;
    dependencies.direct_next = {font, texture, texture, shader};
    dependencies.adjacent_alternatives = {material, font, audio};
    auto submitted = planner.replace_generation_on_owner(dependencies);
    REQUIRE(submitted);
    CHECK(submitted.value().direct_next_submitted == 3);
    CHECK(submitted.value().adjacent_submitted == 2);
    CHECK(submitted.value().failures.empty());
    CHECK(planner.retained_ticket_count_on_owner() == 5);
    CHECK(fixture.recorder.calls ==
          std::vector<std::string>{"font:body", "texture:project:/textures/direct.png",
                                   "shader:direct-material", "material:adjacent-material",
                                   "audio:project:/audio/adjacent.ogg"});
    fixture.run_until_idle();
    planner.clear_on_owner();
}

TEST_CASE("prefetch generation replacement releases stale tickets but preserves shared demand",
          "[assets][structured-prefetch]")
{
    PlannerFixture fixture;
    assets::PrefetchPlanner planner(fixture.manager);
    const auto source_generation = fixture.manager.source_generation_on_owner();
    const assets::TextureAssetRequest first{.path = "project:/textures/first.png"};
    const assets::TextureAssetRequest second{.path = "project:/textures/second.png"};

    assets::StructuredAssetDependencyBuckets first_dependencies;
    first_dependencies.direct_next = {descriptor(first, source_generation)};
    auto first_report = planner.replace_generation_on_owner(first_dependencies);
    REQUIRE(first_report);
    const auto first_generation = first_report.value().generation;

    auto demand = fixture.manager.request_texture(first, assets::AssetRequestReason::Demand);
    REQUIRE(demand);

    assets::StructuredAssetDependencyBuckets second_dependencies;
    second_dependencies.direct_next = {descriptor(second, source_generation)};
    auto second_report = planner.replace_generation_on_owner(second_dependencies);
    REQUIRE(second_report);
    CHECK(second_report.value().generation.valid());
    CHECK(second_report.value().generation != first_generation);
    CHECK(planner.active_generation_on_owner() == second_report.value().generation);
    CHECK(planner.retained_ticket_count_on_owner() == 1);

    fixture.run_until_idle();
    CHECK(demand.value().state() == assets::AssetRequestState::Ready);
    auto lease = std::move(demand).value().take_ready();
    REQUIRE(lease);

    const auto second_key = assets::make_texture_cache_key(second, source_generation);
    CHECK(fixture.residency->classification_on_owner(second_key) == assets::ResidencyClass::Warm);
    planner.clear_on_owner();
    CHECK(fixture.residency->classification_on_owner(second_key) == assets::ResidencyClass::Cold);
}

TEST_CASE("prefetch planner reports rejected typed submissions without retaining tickets",
          "[assets][structured-prefetch]")
{
    PlannerFixture fixture;
    fixture.recorder.reject_material = true;
    assets::PrefetchPlanner planner(fixture.manager);
    const auto source_generation = fixture.manager.source_generation_on_owner();

    assets::StructuredAssetDependencyBuckets dependencies;
    dependencies.direct_next.push_back(
        descriptor(assets::MaterialAssetRequest{.id = "rejected"}, source_generation));
    auto report = planner.replace_generation_on_owner(dependencies);
    REQUIRE(report);
    REQUIRE(report.value().failures.size() == 1);
    CHECK(report.value().failures[0].diagnostic.code == "assets.material_preparation_unavailable");
    CHECK(report.value().direct_next_count == 1);
    CHECK(report.value().adjacent_count == 0);
    CHECK(report.value().submitted_keys.empty());
    CHECK(report.value().direct_next_count + report.value().adjacent_count ==
          report.value().submitted_entries.size() + report.value().failures.size());
    CHECK(planner.retained_ticket_count_on_owner() == 0);
}

TEST_CASE("prefetch planner counts deduplicated prediction buckets before submission",
          "[assets][structured-prefetch]")
{
    PlannerFixture fixture;
    assets::PrefetchPlanner planner(fixture.manager);
    const auto generation = fixture.manager.source_generation_on_owner();
    const auto mandatory = descriptor(
        assets::TextureAssetRequest{.path = "project:/textures/current.png"}, generation);
    const auto expected = descriptor(
        assets::TextureAssetRequest{.path = "project:/textures/expected.png"}, generation);
    const auto possible = descriptor(
        assets::TextureAssetRequest{.path = "project:/textures/possible.png"}, generation);

    assets::StructuredAssetDependencyBuckets dependencies;
    dependencies.current_mandatory = {mandatory};
    dependencies.direct_next = {mandatory, expected, expected};
    dependencies.adjacent_alternatives = {expected, possible, possible};
    auto report = planner.replace_generation_on_owner(dependencies);
    REQUIRE(report);
    CHECK(report.value().direct_next_count == 1);
    CHECK(report.value().adjacent_count == 1);
    CHECK(report.value().submitted_entries.size() == 2);
    CHECK(report.value().failures.empty());
    CHECK(report.value().direct_next_count + report.value().adjacent_count ==
          report.value().submitted_entries.size() + report.value().failures.size());
    CHECK(report.value().submitted_entries[0].prediction ==
          assets::PrefetchPredictionKind::ExpectedNext);
    CHECK(report.value().submitted_entries[1].prediction ==
          assets::PrefetchPredictionKind::PossibleNext);
}

TEST_CASE("mandatory gate includes transient audio in publication leases",
          "[assets][mandatory-assets][audio]")
{
    PlannerFixture fixture;
    auto package = collector_package();
    assets::MandatoryAssetGate gate(fixture.manager);
    REQUIRE(gate.bind_package_on_owner(package, "glsl-120",
                                       fixture.manager.source_generation_on_owner()));

    core::RuntimePresentationSnapshot snapshot;
    snapshot.revision = core::PresentationSnapshotRevision::from_number(7);
    snapshot.mode = core::PresentationRuntimeMode::Ended;
    auto begun = gate.begin_on_owner(snapshot);
    REQUIRE(begun.disposition == assets::MandatoryAssetGateDisposition::Ready);

    const core::AudioOperation operation{
        .id = core::AudioOperationId::from_number(17),
        .action = core::compiled::AudioAction::Play,
        .purpose = core::compiled::AudioPurpose::Voice,
        .pause_policy = core::compiled::AudioPausePolicy::Gameplay,
        .audio_owner = core::SessionPresentationOwner{core::PresentationSessionId::from_number(1)},
        .asset = id<core::AssetId>("audio-voice"),
        .fade = std::chrono::milliseconds{0},
        .gain = 1.0,
        .causality = core::compiled::AudioCausality::Causal};
    auto included = gate.include_audio_operation_on_owner(operation);
    REQUIRE(included);
    REQUIRE(gate.overlay_visible_on_owner());

    fixture.run_until_idle();
    auto polled = gate.poll_on_owner();
    REQUIRE(polled.disposition == assets::MandatoryAssetGateDisposition::Ready);
    REQUIRE(gate.activate_candidate_on_owner());
    const assets::AudioAssetRequest request{.path = "project:/assets/audio/voice.ogg",
                                            .mode = AudioLoadMode::Auto,
                                            .kind = AudioClipKind::Voice};
    REQUIRE(fixture.manager.leased_audio_on_owner(request));
    gate.commit_candidate_on_owner();
    REQUIRE(fixture.manager.has_published_leases_on_owner());
    gate.clear_package_on_owner();
}
