#include <catch2/catch_test_macros.hpp>

#include "noveltea/assets/asset_cache_keys.hpp"
#include "noveltea/assets/asset_manager.hpp"
#include "noveltea/assets/mandatory_asset_gate.hpp"
#include "noveltea/assets/structured_prefetch.hpp"
#include "noveltea/core/compiled_package_codec.hpp"
#include "noveltea/core/compiled_project_codec.hpp"
#include "noveltea/jobs/inline_job_executor.hpp"

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
      "schema":"noveltea.shader-materials.v1",
      "shaders":{
        "sprite-shader":{
          "display_name":"Sprite",
          "roles":["engine-2d"],
          "stages":{
            "vertex":{"compiled":{"glsl-120":"shaders/bgfx/glsl-120/sprite.vs.bin"}},
            "fragment":{"compiled":{"glsl-120":"shaders/bgfx/glsl-120/sprite.fs.bin"}}
          },
          "uniforms":{},
          "samplers":{
            "s_static":{"type":"texture2d"},
            "s_draw":{"type":"texture2d"}
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
          {"schema", "noveltea.shader-materials.v1"},
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
                                               {"sampling", "linear"}});
    document["resources"]["assets"].push_back({{"aliases", nlohmann::json::array()},
                                               {"id", "image-alt"},
                                               {"kind", "image"},
                                               {"path", "assets/images/alt.png"},
                                               {"sampling", "nearest"}});
    document["definitions"]["rooms"][2]["background"]["asset"] = {{"id", "image-alt"},
                                                                  {"kind", "asset"}};
    document["definitions"]["scenes"][0]["defaultBackground"]["asset"] = {{"id", "image-main"},
                                                                          {"kind", "asset"}};
    document["definitions"]["scenes"][0]["continuation"] = {
        {"kind", "scene"}, {"scene", {{"id", "opening"}, {"kind", "scene"}}}};

    auto project = core::decode_compiled_project(document, "structured-prefetch-project.json");
    REQUIRE(project);
    auto manifest = core::decode_runtime_package_manifest(package_manifest_for(project.value()));
    REQUIRE(manifest);
    auto shader_materials = core::decode_shader_material_manifest(shader_material_manifest());
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
    RecordingShaderLoader shaders{recorder};
    RecordingMaterialLoader materials{recorder};
    RecordingAudioLoader audio{recorder};

    PlannerFixture()
    {
        REQUIRE(manager.configure_async_requests(executor, residency));
        manager.bind_font_loader(&fonts);
        manager.bind_texture_loader(&textures);
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

    core::RuntimePresentationSnapshot snapshot;
    snapshot.current_room = id<core::RoomId>("start");
    snapshot.background = core::PresentationBackground{.asset = id<core::AssetId>("image-current"),
                                                       .color = std::nullopt,
                                                       .fit = core::compiled::BackgroundFit::Cover,
                                                       .material = std::nullopt};
    snapshot.desired_audio.push_back(core::PresentationDesiredAudio{
        .instance = id<core::DesiredAudioInstanceId>("voice-current"),
        .owner = core::RoomPresentationOwner{id<core::RoomId>("start")},
        .bus = core::compiled::AudioChannel::Voice,
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
    gate.bind_package_on_owner(package, "missing-variant", generation);
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

TEST_CASE("prefetch planner dispatches typed requests in deterministic bucket order",
          "[assets][structured-prefetch]")
{
    PlannerFixture fixture;
    assets::PrefetchPlanner planner(fixture.manager);
    const auto generation = fixture.manager.source_generation_on_owner();

    const auto font = descriptor(assets::FontAssetRequest{.alias = "body"}, generation);
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
    CHECK(report.value().submitted_keys.empty());
    CHECK(planner.retained_ticket_count_on_owner() == 0);
}

TEST_CASE("mandatory gate includes transient audio in publication leases",
          "[assets][mandatory-assets][audio]")
{
    PlannerFixture fixture;
    auto package = collector_package();
    assets::MandatoryAssetGate gate(fixture.manager);
    gate.bind_package_on_owner(package, "glsl-120", fixture.manager.source_generation_on_owner());

    core::RuntimePresentationSnapshot snapshot;
    snapshot.revision = core::PresentationSnapshotRevision::from_number(7);
    snapshot.mode = core::PresentationRuntimeMode::Ended;
    auto begun = gate.begin_on_owner(snapshot);
    REQUIRE(begun.disposition == assets::MandatoryAssetGateDisposition::Ready);

    const core::AudioOperation operation{.id = core::AudioOperationId::from_number(17),
                                         .action = core::compiled::AudioAction::Play,
                                         .channel = core::compiled::AudioChannel::Voice,
                                         .asset = id<core::AssetId>("audio-voice"),
                                         .fade = std::chrono::milliseconds{0},
                                         .loop = false,
                                         .volume = 1.0,
                                         .owner = std::nullopt,
                                         .completion = std::nullopt,
                                         .purpose = core::AudioOperationPurpose::Gameplay};
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
