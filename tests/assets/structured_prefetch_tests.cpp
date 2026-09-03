#include <catch2/catch_test_macros.hpp>

#include "noveltea/assets/asset_cache_keys.hpp"
#include "noveltea/assets/asset_manager.hpp"
#include "noveltea/assets/mandatory_asset_gate.hpp"
#include "noveltea/assets/structured_prefetch.hpp"
#include "noveltea/core/compiled_package_codec.hpp"
#include "noveltea/core/compiled_project_codec.hpp"
#include "noveltea/core/player_bootstrap.hpp"
#include "noveltea/jobs/inline_job_executor.hpp"
#include "noveltea/runtime/flow_prediction.hpp"
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

nlohmann::json read_compiled_project_golden(std::string_view name)
{
    const std::string path = std::string(NOVELTEA_SOURCE_DIR) +
                             "/editor/src/renderer/test/fixtures/compiled-project-golden/" +
                             std::string(name) + ".json";
    std::ifstream file(path, std::ios::binary);
    REQUIRE(file.good());
    const std::string text((std::istreambuf_iterator<char>(file)),
                           std::istreambuf_iterator<char>());
    auto value = nlohmann::json::parse(text, nullptr, false);
    REQUIRE_FALSE(value.is_discarded());
    return value;
}

nlohmann::json read_comprehensive_project()
{
    return read_compiled_project_golden("comprehensive");
}

nlohmann::json scene_prediction_test_document()
{
    auto document = read_compiled_project_golden("scene-program");
    const auto asset_ref = [](std::string_view value) {
        return nlohmann::json{{"kind", "asset"}, {"id", value}};
    };
    const auto scene_ref = [](std::string_view value) {
        return nlohmann::json{{"kind", "scene"}, {"id", value}};
    };
    const auto point = [&](std::string_view scene,
                           std::optional<std::string_view> step = std::nullopt,
                           bool terminal = false) {
        if (step)
            return nlohmann::json{
                {"kind", "scene-step"}, {"scene", scene_ref(scene)}, {"stepId", *step}};
        return nlohmann::json{{"kind", terminal ? "scene-terminal" : "scene-entry"},
                              {"scene", scene_ref(scene)}};
    };
    const auto sequential = [](std::optional<std::size_t> successor) {
        return nlohmann::json{
            {"kind", "sequential"},
            {"successor", successor ? nlohmann::json(*successor) : nlohmann::json(nullptr)}};
    };

    for (const auto scene_id :
         {"prediction-child", "prediction-detached", "prediction-horizon", "prediction-decision"}) {
        auto scene = document["definitions"]["scenes"][0];
        scene["id"] = scene_id;
        scene["displayName"] = scene_id;
        scene["program"]["events"] = nlohmann::json::array();
        scene["terminal"] = {{"kind", "return"}, {"outcome", nullptr}};
        document["definitions"]["scenes"].push_back(std::move(scene));
    }

    const std::vector<std::string> assets = {
        "image-prediction-parent-stage",       "image-prediction-child-stage",
        "image-prediction-child-late",         "image-prediction-caller-after",
        "image-prediction-after-short",        "image-prediction-detached-stage",
        "image-prediction-detached-deep",      "image-prediction-foreground",
        "image-prediction-after-strong",       "image-prediction-branch-expected",
        "image-prediction-branch-alternative", "image-prediction-choice-a",
        "image-prediction-choice-b",           "image-prediction-after-lua"};
    nlohmann::json dependency_groups = nlohmann::json::array();
    for (const auto& asset : assets) {
        document["resources"]["assets"].push_back({{"aliases", nlohmann::json::array()},
                                                   {"id", asset},
                                                   {"kind", "image"},
                                                   {"path", "assets/images/" + asset + ".png"},
                                                   {"sampling", "linear"},
                                                   {"width", 64},
                                                   {"height", 64}});
        dependency_groups.push_back(
            nlohmann::json::array({{{"kind", "asset"}, {"asset", asset_ref(asset)}}}));
    }
    const auto group = [&](std::string_view asset) {
        return static_cast<std::size_t>(
            std::distance(assets.begin(), std::find(assets.begin(), assets.end(), asset)));
    };
    const auto slice = [&](nlohmann::json prediction_point, std::optional<std::string_view> asset,
                           nlohmann::json control, std::string_view frontier = "normal",
                           nlohmann::json program = nlohmann::json::array()) {
        return nlohmann::json{{"point", std::move(prediction_point)},
                              {"dependencyGroups", asset ? nlohmann::json::array({group(*asset)})
                                                         : nlohmann::json::array()},
                              {"conditionFalseSuccessor", nullptr},
                              {"control", std::move(control)},
                              {"frontier", frontier},
                              {"program", std::move(program)}};
    };

    nlohmann::json slices = nlohmann::json::array();
    slices.push_back(
        slice(point("prediction-child"), "image-prediction-child-stage", sequential(1)));
    slices.push_back(slice(point("prediction-child", "child-late"), "image-prediction-child-late",
                           sequential(2)));
    slices.push_back(slice(point("prediction-child", std::nullopt, true), std::nullopt,
                           sequential(std::nullopt)));
    slices.push_back(
        slice(point("prediction-detached"), "image-prediction-detached-stage", sequential(4)));
    slices.push_back(slice(point("prediction-detached", "detached-deep"),
                           "image-prediction-detached-deep", sequential(5)));
    slices.push_back(slice(point("prediction-detached", std::nullopt, true), std::nullopt,
                           sequential(std::nullopt)));
    slices.push_back(
        slice(point("prediction-horizon"), "image-prediction-parent-stage", sequential(7)));
    slices.push_back(
        slice(point("prediction-horizon", "await-child"), std::nullopt, sequential(8), "normal",
              nlohmann::json::array(
                  {{{"kind", "call-scene"}, {"scene", scene_ref("prediction-child")}}})));
    slices.push_back(slice(point("prediction-horizon", "caller-after"),
                           "image-prediction-caller-after", sequential(9)));
    slices.push_back(slice(point("prediction-horizon", "short-wait"), std::nullopt, sequential(10),
                           "short-wait"));
    slices.push_back(slice(point("prediction-horizon", "after-short"),
                           "image-prediction-after-short", sequential(11)));
    slices.push_back(slice(point("prediction-horizon", "start-detached"), std::nullopt,
                           sequential(12), "normal",
                           nlohmann::json::array({{{"kind", "start-detached-scene"},
                                                   {"scene", scene_ref("prediction-detached")}}})));
    slices.push_back(slice(point("prediction-horizon", "foreground-after-detached"),
                           "image-prediction-foreground", sequential(13)));
    slices.push_back(slice(point("prediction-horizon", "strong-wait"), std::nullopt, sequential(14),
                           "strong-wait"));
    slices.push_back(slice(point("prediction-horizon", "after-strong"),
                           "image-prediction-after-strong", sequential(15)));
    slices.push_back(slice(point("prediction-horizon", std::nullopt, true), std::nullopt,
                           sequential(std::nullopt)));
    slices.push_back(slice(point("prediction-decision"), std::nullopt, sequential(17)));
    const auto count_condition =
        nlohmann::json{{"kind", "global-property-comparison"},
                       {"property", {{"kind", "property"}, {"id", "count"}}},
                       {"operator", "greater-equal"},
                       {"value", 2}};
    const auto lua_condition =
        nlohmann::json{{"kind", "lua-predicate"}, {"source", "prediction_branch()"}};
    slices.push_back(slice(
        point("prediction-decision", "decision-branch"), std::nullopt,
        {{"kind", "branch"},
         {"branches", nlohmann::json::array({{{"condition", count_condition}, {"target", 19}},
                                             {{"condition", lua_condition}, {"target", 18}}})},
         {"fallback", 19}}));
    slices.push_back(slice(point("prediction-decision", "branch-alternative"),
                           "image-prediction-branch-alternative", sequential(19)));
    slices.push_back(slice(point("prediction-decision", "branch-expected"),
                           "image-prediction-branch-expected", sequential(20)));
    const auto flag_condition = nlohmann::json{{"kind", "global-property-comparison"},
                                               {"property", {{"kind", "property"}, {"id", "flag"}}},
                                               {"operator", "truthy"}};
    slices.push_back(slice(
        point("prediction-decision", "decision-choice"), std::nullopt,
        {{"kind", "choice"},
         {"options",
          nlohmann::json::array(
              {{{"optionId", "choice-a"},
                {"condition", flag_condition},
                {"programs", nlohmann::json::array()},
                {"target", 21}},
               {{"optionId", "choice-b"},
                {"condition", {{"kind", "lua-predicate"}, {"source", "prediction_choice_b()"}}},
                {"programs", nlohmann::json::array()},
                {"target", 22}}})}},
        "decision"));
    slices.push_back(slice(point("prediction-decision", "choice-a-target"),
                           "image-prediction-choice-a", sequential(23)));
    slices.push_back(slice(point("prediction-decision", "choice-b-target"),
                           "image-prediction-choice-b", sequential(23)));
    slices.push_back(slice(point("prediction-decision", "opaque-lua"), std::nullopt, sequential(24),
                           "normal", nlohmann::json::array({{{"kind", "opaque"}}})));
    slices.push_back(slice(point("prediction-decision", "after-lua"), "image-prediction-after-lua",
                           sequential(25)));
    slices.push_back(slice(point("prediction-decision", std::nullopt, true), std::nullopt,
                           sequential(std::nullopt)));

    document["flowPrediction"] = {{"dependencyGroups", std::move(dependency_groups)},
                                  {"slices", std::move(slices)}};
    return document;
}

nlohmann::json dialogue_prediction_test_document()
{
    auto document = read_compiled_project_golden("dialogue-program");
    auto& groups = document["flowPrediction"]["dependencyGroups"];
    auto& slices = document["flowPrediction"]["slices"];

    const auto add_marker = [&](std::string_view name) {
        const std::string asset{name};
        document["resources"]["assets"].push_back({{"aliases", nlohmann::json::array()},
                                                   {"id", asset},
                                                   {"kind", "image"},
                                                   {"path", "assets/images/" + asset + ".png"},
                                                   {"sampling", "linear"},
                                                   {"width", 64},
                                                   {"height", 64}});
        const auto index = groups.size();
        groups.push_back(nlohmann::json::array(
            {{{"kind", "asset"}, {"asset", {{"kind", "asset"}, {"id", asset}}}}}));
        return index;
    };
    const auto attach = [&](std::string_view stage, std::optional<std::string_view> segment,
                            std::optional<std::string_view> edge, std::size_t cursor,
                            std::string_view marker) {
        const auto group = add_marker(marker);
        for (auto& slice : slices) {
            const auto& point = slice["point"];
            if (point.value("kind", "") != "dialogue-position" ||
                point["dialogue"].value("id", "") != "intro" || point.value("stage", "") != stage ||
                point.value("cursor", 0U) != cursor)
                continue;
            if (segment && point.value("segmentId", "") != *segment)
                continue;
            if (edge && point.value("edgeId", "") != *edge)
                continue;
            slice["dependencyGroups"].push_back(group);
            return;
        }
        FAIL("Dialogue prediction fixture point not found for marker " << marker);
    };

    attach("present-segment", "inline-line", std::nullopt, 0, "image-dialogue-before");
    attach("present-segment", "localized-line", std::nullopt, 0, "image-dialogue-current");
    attach("present-segment", "lua-line", std::nullopt, 0, "image-dialogue-after");
    attach("apply-segment-effects", "inline-line", std::nullopt, 0, "image-dialogue-effect-zero");
    attach("apply-segment-effects", "inline-line", std::nullopt, 1, "image-dialogue-effect-one");
    attach("apply-choice-effects", std::nullopt, "choice-redirect", 0,
           "image-dialogue-choice-redirect");
    attach("apply-choice-effects", std::nullopt, "choice-final", 0, "image-dialogue-choice-final");
    attach("follow-edge", std::nullopt, "start-choice", 0, "image-dialogue-continuation");

    const auto child_group = add_marker("image-dialogue-child");
    for (auto& slice : slices) {
        const auto& point = slice["point"];
        if (point.value("kind", "") == "scene-entry" &&
            point["scene"].value("id", "") == "opening") {
            slice["dependencyGroups"].push_back(child_group);
            break;
        }
    }
    const auto room_completion_group = add_marker("image-dialogue-room-completion");
    for (auto& slice : slices) {
        const auto& point = slice["point"];
        if (point.value("kind", "") == "room-lifecycle" &&
            point["room"].value("id", "") == "start" &&
            point.value("stage", "") == "presentation") {
            slice["dependencyGroups"].push_back(room_completion_group);
            break;
        }
    }
    for (auto& slice : slices) {
        const auto& point = slice["point"];
        if (point.value("kind", "") == "dialogue-position" &&
            point["dialogue"].value("id", "") == "intro" &&
            point.value("stage", "") == "present-segment" &&
            point.value("segmentId", "") == "dialogue-lua") {
            slice["program"] = nlohmann::json::array(
                {{{"kind", "call-scene"}, {"scene", {{"kind", "scene"}, {"id", "opening"}}}}});
            slice["frontier"] = "normal";
            break;
        }
    }
    return document;
}

nlohmann::json shader_material_manifest()
{
    return nlohmann::json::parse(R"json({
      "schema":"noveltea.shader-materials",
      "shaders":{
        "sprite-shader":{
          "display_name":"Sprite",
          "roles":["engine-2d","postprocess"],
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
        },
        "scene-postprocess-material":{
          "display_name":"Scene Postprocess",
          "role":"postprocess",
          "shader":"sprite-shader",
          "uniforms":{},
          "textures":{},
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
        {"runtime_api_version", noveltea::core::player_runtime_api_version},
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
          {"schema", "noveltea.shader-materials"},
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

core::LoadedCompiledPackage package_from_document(nlohmann::json document, std::string source_path)
{
    auto project = core::decode_compiled_project(document, std::move(source_path));
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
    document["definitions"]["scenes"][0]["stage"]["background"]["asset"] = {{"id", "image-main"},
                                                                            {"kind", "asset"}};
    document["definitions"]["scenes"][0]["terminal"] = {
        {"kind", "continue-dialogue"}, {"dialogue", {{"id", "intro"}, {"kind", "dialogue"}}}};
    document["definitions"]["dialogues"][0]["completion"] = {
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

    return package_from_document(std::move(document), "structured-prefetch-project.json");
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
    constexpr std::uint64_t generous = 64u * 1024u * 1024u;
    return {.source_bytes = generous,
            .prepared_cpu_bytes = generous,
            .gpu_bytes = generous,
            .audio_bytes = generous,
            .temporary_bytes = generous};
}

template<class T> class ImmediatePreparationTask final : public assets::AssetPreparationTask<T> {
public:
    explicit ImmediatePreparationTask(T asset, std::size_t* steps = nullptr)
        : m_asset(std::move(asset)), m_steps(steps)
    {
    }

    [[nodiscard]] assets::ResidencyCost estimated_cost_on_owner() const noexcept override
    {
        return {.prepared_cpu_bytes = 1};
    }

    [[nodiscard]] jobs::JobStepOutcome step(jobs::JobContext& context) noexcept override
    {
        if (m_steps != nullptr)
            ++*m_steps;
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
    std::size_t* m_steps = nullptr;
    bool m_ready = false;
};

struct DispatchRecorder {
    std::vector<std::string> calls;
    std::size_t preparation_steps = 0;
    bool reject_material = false;
};

class PrefetchGenerationCaptureSink final : public core::AssetTelemetrySink {
public:
    void record(core::AssetTelemetryEvent event) noexcept override
    {
        events.push_back(std::move(event));
    }

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
    std::vector<core::AssetTelemetryEvent> events;
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
            assets::FontAsset{.resolved_alias = request.alias}, &m_recorder.preparation_steps);
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
        requests.push_back(request);
        m_recorder.calls.push_back("texture:" + request.path);
        return std::make_unique<ImmediatePreparationTask<assets::TextureAsset>>(
            assets::TextureAsset{.handle = 1, .path = request.path, .sampler = request.sampler},
            &m_recorder.preparation_steps);
    }

    std::vector<assets::TextureAssetRequest> requests;

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
                                     .height = request.height},
            &m_recorder.preparation_steps);
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
            assets::ShaderProgramAsset{.handle = 2, .key = request.resolution.key},
            &m_recorder.preparation_steps);
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
            assets::MaterialAsset{.id = request.id}, &m_recorder.preparation_steps);
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
                               .kind = request.kind},
            &m_recorder.preparation_steps);
    }

private:
    DispatchRecorder& m_recorder;
};

struct PlannerFixture {
    jobs::InlineJobExecutor executor;
    std::shared_ptr<assets::AssetResidencyManager> residency;
    assets::AssetManager manager;
    DispatchRecorder recorder;
    RecordingFontLoader fonts{recorder};
    RecordingTextureLoader textures{recorder};
    RecordingHotspotMaskLoader hotspot_masks{recorder};
    RecordingShaderLoader shaders{recorder};
    RecordingMaterialLoader materials{recorder};
    RecordingAudioLoader audio{recorder};

    explicit PlannerFixture(core::AssetTelemetrySink* telemetry = nullptr,
                            assets::ResidencyBudget budget = generous_budget())
        : residency(std::make_shared<assets::AssetResidencyManager>(budget))
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

TEST_CASE("structured texture dependencies carry alpha coverage into mandatory and prefetch work",
          "[assets][structured-prefetch][texture-alpha]")
{
    PlannerFixture fixture;
    auto package = collector_package();
    const auto generation = fixture.manager.source_generation_on_owner();
    const auto index =
        assets::StructuredAssetDependencyIndex::build(package, "glsl-120", generation);
    const assets::StructuredAssetDependencyCollector collector(index);

    core::RuntimePresentationSnapshot snapshot;
    snapshot.background = core::PresentationBackground{.asset = id<core::AssetId>("image-main"),
                                                       .color = std::nullopt,
                                                       .fit = core::compiled::BackgroundFit::Cover,
                                                       .material = std::nullopt};
    snapshot.interactables.push_back(
        {.interactable = id<core::InteractableInstanceId>("key"),
         .placement = {.room = id<core::RoomId>("start"),
                       .placement_id = id<core::RoomPlacementId>("key-placement")},
         .bounds = {.x = 0.0, .y = 0.0, .width = 1.0, .height = 1.0},
         .sprite = id<core::AssetId>("image-main"),
         .material = std::nullopt});
    assets::StructuredAssetDependencyContext mandatory_context;
    mandatory_context.current_presentation = &snapshot;
    const auto mandatory = collector.collect(mandatory_context);
    const auto mandatory_texture = find_request<assets::TextureAssetRequest>(
        mandatory.current_mandatory, [](const auto& request) {
            return request.path == "project:/assets/images/main.png" &&
                   request.sampler == MaterialTextureSampler::ClampLinear;
        });
    REQUIRE(mandatory_texture);
    CHECK(std::get<assets::TextureAssetRequest>(
              mandatory.current_mandatory[*mandatory_texture].request)
              .retain_alpha_coverage);

    assets::MandatoryAssetRequestGroup mandatory_group(
        fixture.manager, {mandatory.current_mandatory[*mandatory_texture]},
        {.reason = assets::AssetRequestReason::Demand, .show_overlay_immediately = true});
    fixture.run_until_idle();
    mandatory_group.poll_on_owner();
    REQUIRE(mandatory_group.state_on_owner() == assets::MandatoryAssetGroupState::Ready);
    REQUIRE_FALSE(fixture.textures.requests.empty());
    CHECK(fixture.textures.requests.back().retain_alpha_coverage);

    fixture.textures.requests.clear();
    assets::StructuredAssetDependencyContext speculative_context;
    speculative_context.direct_next = core::compiled::Entrypoint{id<core::RoomId>("start")};
    const auto speculative = collector.collect(speculative_context);
    const auto speculative_texture =
        find_request<assets::TextureAssetRequest>(speculative.direct_next, [](const auto& request) {
            return request.path == "project:/assets/images/main.png" &&
                   request.sampler == MaterialTextureSampler::ClampLinear;
        });
    REQUIRE(speculative_texture);
    CHECK(
        std::get<assets::TextureAssetRequest>(speculative.direct_next[*speculative_texture].request)
            .retain_alpha_coverage);

    assets::PrefetchPlanner planner(fixture.manager);
    REQUIRE(planner.replace_generation_on_owner(speculative));
    fixture.run_until_idle();
    const auto submitted =
        std::find_if(fixture.textures.requests.begin(), fixture.textures.requests.end(),
                     [](const auto& request) {
                         return request.path == "project:/assets/images/main.png" &&
                                request.sampler == MaterialTextureSampler::ClampLinear;
                     });
    REQUIRE(submitted != fixture.textures.requests.end());
    CHECK(submitted->retain_alpha_coverage);
}

TEST_CASE("strong speculative texture capability survives weaker current dependency dedupe",
          "[assets][structured-prefetch][texture-alpha][capabilities]")
{
    PlannerFixture fixture;
    auto package = collector_package();
    const auto generation = fixture.manager.source_generation_on_owner();
    const auto index =
        assets::StructuredAssetDependencyIndex::build(package, "glsl-120", generation);
    const assets::StructuredAssetDependencyCollector collector(index);

    core::RuntimePresentationSnapshot snapshot;
    snapshot.background = core::PresentationBackground{.asset = id<core::AssetId>("image-main"),
                                                       .color = std::nullopt,
                                                       .fit = core::compiled::BackgroundFit::Cover,
                                                       .material = std::nullopt};
    assets::StructuredAssetDependencyContext context;
    context.current_presentation = &snapshot;
    context.direct_next = core::compiled::Entrypoint{id<core::RoomId>("start")};

    const auto collected = collector.collect(context);
    const auto current_texture = find_request<assets::TextureAssetRequest>(
        collected.current_mandatory, [](const auto& request) {
            return request.path == "project:/assets/images/main.png" &&
                   request.sampler == MaterialTextureSampler::ClampLinear;
        });
    REQUIRE(current_texture);
    CHECK_FALSE(
        std::get<assets::TextureAssetRequest>(collected.current_mandatory[*current_texture].request)
            .retain_alpha_coverage);

    const auto speculative_texture =
        find_request<assets::TextureAssetRequest>(collected.direct_next, [](const auto& request) {
            return request.path == "project:/assets/images/main.png" &&
                   request.sampler == MaterialTextureSampler::ClampLinear;
        });
    REQUIRE(speculative_texture);
    CHECK(std::get<assets::TextureAssetRequest>(collected.direct_next[*speculative_texture].request)
              .retain_alpha_coverage);

    fixture.textures.requests.clear();
    assets::PrefetchPlanner planner(fixture.manager);
    auto replaced = planner.replace_generation_on_owner(collected);
    REQUIRE(replaced);
    fixture.run_until_idle();
    const auto submitted =
        std::find_if(fixture.textures.requests.begin(), fixture.textures.requests.end(),
                     [](const auto& request) {
                         return request.path == "project:/assets/images/main.png" &&
                                request.sampler == MaterialTextureSampler::ClampLinear;
                     });
    REQUIRE(submitted != fixture.textures.requests.end());
    CHECK(submitted->retain_alpha_coverage);
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
    auto transaction = gate.take_ready_transaction_on_owner();
    REQUIRE(transaction);
    REQUIRE(transaction->commit_on_owner(false));
    CHECK(fixture.manager.has_published_leases_on_owner());
    gate.clear_package_on_owner();
}

TEST_CASE("built-in contextual Layouts do not block mandatory publication",
          "[assets][structured-prefetch][mandatory-assets][layouts]")
{
    PlannerFixture fixture;
    auto package = collector_package();
    const auto generation = fixture.manager.source_generation_on_owner();
    const auto index =
        assets::StructuredAssetDependencyIndex::build(package, "glsl-120", generation);
    const assets::StructuredAssetDependencyCollector collector(index);

    core::RuntimePresentationSnapshot snapshot;
    snapshot.revision = core::PresentationSnapshotRevision::from_number(10);
    snapshot.current_room = id<core::RoomId>("start");
    snapshot.layouts.push_back(core::PresentationMountedLayout{
        .key = core::ScopedLayoutMountKey{id<core::ScopedLayoutInstanceId>("inventory-ui")},
        .owner = core::RoomPresentationOwner{id<core::RoomId>("start")},
        .layout = id<core::LayoutId>(std::string(core::compiled::builtin_inventory_layout_id)),
    });
    snapshot.layouts.push_back(core::PresentationMountedLayout{
        .key = core::ScopedLayoutMountKey{id<core::ScopedLayoutInstanceId>("verb-menu-ui")},
        .owner = core::RoomPresentationOwner{id<core::RoomId>("start")},
        .layout = id<core::LayoutId>(std::string(core::compiled::builtin_verb_menu_layout_id)),
    });

    assets::StructuredAssetDependencyContext context;
    context.current_presentation = &snapshot;
    const auto collected = collector.collect(context);

    CHECK_FALSE(has_code(collected.mandatory_diagnostics, "assets.prefetch_missing_layout"));
    CHECK_FALSE(has_code(collected.diagnostics, "assets.prefetch_missing_layout"));

    assets::MandatoryAssetGate gate(fixture.manager);
    REQUIRE(gate.bind_package_on_owner(package, "glsl-120", generation));
    const auto begun = gate.begin_on_owner(snapshot);
    CHECK(begun.disposition != assets::MandatoryAssetGateDisposition::Failed);
    gate.clear_package_on_owner();
}

TEST_CASE("mandatory package rebinding reuses self-describing texture dependencies",
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

TEST_CASE("mandatory package binding submits compiled Scene-entry prediction through real prefetch",
          "[assets][flow-prediction][mandatory-assets][structured-prefetch]")
{
    PlannerFixture fixture;
    auto document = read_compiled_project_golden("scene-program");
    for (auto& system_layout : document["settings"]["systemLayouts"])
        system_layout["layout"] = nullptr;
    auto package = package_from_document(std::move(document), "scene-program.json");
    const auto generation = fixture.manager.source_generation_on_owner();
    assets::MandatoryAssetGate gate(fixture.manager);

    REQUIRE(gate.bind_package_on_owner(package, "glsl-120", generation));
    CHECK(fixture.recorder.calls.empty());

    core::RuntimePresentationSnapshot snapshot;
    snapshot.revision = core::PresentationSnapshotRevision::from_number(149);
    snapshot.mode = core::PresentationRuntimeMode::Flow;
    REQUIRE(gate.begin_on_owner(snapshot).disposition ==
            assets::MandatoryAssetGateDisposition::Ready);
    auto transaction = gate.take_ready_transaction_on_owner();
    REQUIRE(transaction);
    REQUIRE(transaction->commit_on_owner(false));
    CHECK(std::ranges::find(fixture.recorder.calls, "texture:project:/assets/images/main.png") !=
          fixture.recorder.calls.end());
    CHECK(fixture.recorder.calls.size() > 1);

    fixture.run_until_idle();
    gate.clear_package_on_owner();
}

TEST_CASE(
    "mandatory Room publication submits adjacent lifecycle Flow prediction through real prefetch",
    "[assets][flow-prediction][mandatory-assets][structured-prefetch][room-lifecycle]")
{
    PlannerFixture fixture;
    auto document = read_compiled_project_golden("scene-program");
    for (auto& system_layout : document["settings"]["systemLayouts"])
        system_layout["layout"] = nullptr;
    auto package = package_from_document(std::move(document), "scene-program.json");
    const auto generation = fixture.manager.source_generation_on_owner();
    assets::MandatoryAssetGate gate(fixture.manager);

    REQUIRE(gate.bind_package_on_owner(package, "glsl-120", generation));
    core::RuntimePresentationSnapshot snapshot;
    snapshot.revision = core::PresentationSnapshotRevision::from_number(151);
    snapshot.mode = core::PresentationRuntimeMode::Room;
    snapshot.current_room = id<core::RoomId>("hall");

    REQUIRE(gate.begin_on_owner(snapshot).disposition ==
            assets::MandatoryAssetGateDisposition::Ready);
    auto transaction = gate.take_ready_transaction_on_owner();
    REQUIRE(transaction);
    REQUIRE(transaction->commit_on_owner(false));

    CHECK(std::ranges::find(fixture.recorder.calls, "texture:project:/assets/images/main.png") !=
          fixture.recorder.calls.end());
    CHECK(std::ranges::find(fixture.recorder.calls,
                            "texture:project:/assets/images/arrival-dialogue.png") !=
          fixture.recorder.calls.end());

    fixture.run_until_idle();
    gate.clear_package_on_owner();
}

TEST_CASE("resident Room actions are excluded prospectively and admitted only after Room commit",
          "[assets][flow-prediction][mandatory-assets][structured-prefetch][resident-room]")
{
    PlannerFixture fixture;
    auto document = read_compiled_project_golden("scene-program");
    for (auto& system_layout : document["settings"]["systemLayouts"])
        system_layout["layout"] = nullptr;
    document["resources"]["assets"].push_back({{"aliases", nlohmann::json::array()},
                                               {"height", 64},
                                               {"id", "resident-image"},
                                               {"kind", "image"},
                                               {"path", "assets/images/resident.png"},
                                               {"sampling", "linear"},
                                               {"width", 64}});
    const auto dependency_group = document["flowPrediction"]["dependencyGroups"].size();
    document["flowPrediction"]["dependencyGroups"].push_back(nlohmann::json::array(
        {{{"kind", "asset"}, {"asset", {{"kind", "asset"}, {"id", "resident-image"}}}}}));
    document["flowPrediction"]["slices"].push_back(
        {{"conditionFalseSuccessor", nullptr},
         {"control", {{"kind", "sequential"}, {"successor", nullptr}}},
         {"dependencyGroups", nlohmann::json::array({dependency_group})},
         {"frontier", "normal"},
         {"point",
          {{"kind", "interaction-rule"},
           {"interaction", {{"kind", "interaction"}, {"id", "look"}}},
           {"ruleId", "resident-click"}}},
         {"program", nlohmann::json::array()}});
    auto package = package_from_document(std::move(document), "resident-room-prediction.json");

    runtime::FlowPredictor predictor(package.project());
    const auto prospective = predictor.predict(runtime::ProspectiveRoomEntryPredictionRoot{
        .source_room = id<core::RoomId>("hall"), .target_room = id<core::RoomId>("tower")});
    CHECK_FALSE(std::ranges::any_of(prospective.entries, [](const auto& entry) {
        const auto* asset =
            std::get_if<core::compiled::FlowPredictionAssetDependency>(&entry.dependency);
        return asset != nullptr && asset->asset == id<core::AssetId>("resident-image");
    }));

    const runtime::ResidentRoomPredictionRoot resident_root{
        .room = id<core::RoomId>("hall"),
        .programs = {core::InteractionRuleProgramRef{
            id<core::InteractionId>("look"), id<core::InteractionRuleId>("resident-click")}},
        .layouts = {}};
    const auto resident = predictor.predict(resident_root);
    const auto resident_entry = std::ranges::find_if(resident.entries, [](const auto& entry) {
        const auto* asset =
            std::get_if<core::compiled::FlowPredictionAssetDependency>(&entry.dependency);
        return asset != nullptr && asset->asset == id<core::AssetId>("resident-image");
    });
    REQUIRE(resident_entry != resident.entries.end());
    CHECK(resident_entry->confidence == runtime::FlowPredictionConfidence::Alternative);
    CHECK(resident_entry->provenance.root_kind ==
          runtime::FlowPredictionRootKind::ResidentRoomContext);
    CHECK(resident_entry->provenance.room == id<core::RoomId>("hall"));

    const auto generation = fixture.manager.source_generation_on_owner();
    const auto dependency_index =
        assets::StructuredAssetDependencyIndex::build(package, "glsl-120", generation);
    const auto resident_plan = assets::resolve_flow_prediction(dependency_index, resident);
    const auto resident_candidate =
        std::ranges::find_if(resident_plan.candidates, [](const auto& candidate) {
            const auto* texture =
                std::get_if<assets::TextureAssetRequest>(&candidate.descriptor.request);
            return texture != nullptr && texture->path == "project:/assets/images/resident.png";
        });
    REQUIRE(resident_candidate != resident_plan.candidates.end());
    CHECK(resident_candidate->prediction == assets::PrefetchPredictionKind::PossibleNext);

    assets::MandatoryAssetGate gate(fixture.manager);
    REQUIRE(gate.bind_package_on_owner(package, "glsl-120", generation));
    core::RuntimePresentationSnapshot snapshot;
    snapshot.revision = core::PresentationSnapshotRevision::from_number(155);
    snapshot.mode = core::PresentationRuntimeMode::Room;
    snapshot.current_room = id<core::RoomId>("hall");
    REQUIRE(gate.begin_on_owner(snapshot).disposition ==
            assets::MandatoryAssetGateDisposition::Ready);
    auto transaction = gate.take_ready_transaction_on_owner();
    REQUIRE(transaction);
    REQUIRE(transaction->commit_on_owner(false));
    CHECK(
        std::ranges::find(fixture.recorder.calls, "texture:project:/assets/images/resident.png") ==
        fixture.recorder.calls.end());

    const auto before_resident = gate.active_prefetch_generation_on_owner();
    CHECK(gate.update_resident_room_prediction_on_owner(&resident_root).empty());
    const auto after_resident = gate.active_prefetch_generation_on_owner();
    REQUIRE(after_resident);
    CHECK(after_resident != before_resident);
    CHECK(
        std::ranges::find(fixture.recorder.calls, "texture:project:/assets/images/resident.png") !=
        fixture.recorder.calls.end());
    CHECK(gate.update_resident_room_prediction_on_owner(&resident_root).empty());
    CHECK(gate.active_prefetch_generation_on_owner() == after_resident);

    fixture.run_until_idle();
    gate.clear_package_on_owner();
}

TEST_CASE("mandatory publication remains correct when Flow Prediction metadata is unavailable",
          "[assets][flow-prediction][mandatory-assets][structured-prefetch]")
{
    PlannerFixture fixture;
    auto document = read_compiled_project_golden("scene-program");

    SECTION("prediction metadata is disabled") { document.erase("flowPrediction"); }
    SECTION("prediction metadata degrades at an invalid successor")
    {
        REQUIRE(document.contains("flowPrediction"));
        document["flowPrediction"]["slices"][1]["control"]["successor"] = 999999;
    }

    auto package = package_from_document(std::move(document), "scene-program-no-prediction.json");
    const auto generation = fixture.manager.source_generation_on_owner();
    assets::MandatoryAssetGate gate(fixture.manager);
    REQUIRE(gate.bind_package_on_owner(package, "glsl-120", generation));
    CHECK(fixture.recorder.calls.empty());

    core::RuntimePresentationSnapshot snapshot;
    snapshot.revision = core::PresentationSnapshotRevision::from_number(150);
    snapshot.mode = core::PresentationRuntimeMode::Ended;
    snapshot.background = core::PresentationBackground{.asset = id<core::AssetId>("image-main"),
                                                       .color = std::nullopt,
                                                       .fit = core::compiled::BackgroundFit::Cover,
                                                       .material = std::nullopt};
    REQUIRE(gate.begin_on_owner(snapshot).disposition ==
            assets::MandatoryAssetGateDisposition::Pending);
    CHECK(fixture.recorder.calls ==
          std::vector<std::string>{"texture:project:/assets/images/main.png"});
    fixture.run_until_idle();
    REQUIRE(gate.poll_on_owner().disposition == assets::MandatoryAssetGateDisposition::Ready);
    auto transaction = gate.take_ready_transaction_on_owner();
    REQUIRE(transaction);
    REQUIRE(transaction->commit_on_owner(false));
    CHECK(fixture.manager.has_published_leases_on_owner());
    gate.clear_package_on_owner();
}

TEST_CASE("mandatory package binding rejects a stale source generation",
          "[assets][structured-prefetch][mandatory-assets][source-generation]")
{
    PlannerFixture fixture;
    auto package = collector_package();
    const auto stale_generation = fixture.manager.source_generation_on_owner();
    fixture.manager.mount("project", std::make_shared<assets::MemoryAssetSource>());
    REQUIRE(fixture.manager.source_generation_on_owner() != stale_generation);

    assets::MandatoryAssetGate gate(fixture.manager);
    const auto bound = gate.bind_package_on_owner(package, "glsl-120", stale_generation);
    REQUIRE_FALSE(bound);
    CHECK(bound.error().code == "assets.mandatory_gate_stale_source_generation");
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
    auto transaction = gate.take_ready_transaction_on_owner();
    REQUIRE(transaction);

    const assets::TextureAssetRequest background{
        .path = "project:/assets/images/current.png",
        .sampler = MaterialTextureSampler::ClampLinear,
    };
    CHECK(fixture.manager.leased_texture_on_owner(background) != nullptr);
    REQUIRE(transaction->commit_on_owner(false));
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
    auto transaction = gate.take_ready_transaction_on_owner();
    REQUIRE(transaction);

    const assets::TextureAssetRequest request{
        .path = "project:/assets/images/current.png",
        .sampler = MaterialTextureSampler::ClampLinear,
    };
    REQUIRE(fixture.manager.leased_texture_on_owner(request) != nullptr);
    REQUIRE(transaction->commit_on_owner(false));
    REQUIRE(fixture.manager.leased_texture_on_owner(request) != nullptr);
    gate.clear_package_on_owner();
}

TEST_CASE(
    "runtime prefetch generation advances only after a current publication transaction commits",
    "[assets][structured-prefetch][mandatory-assets][transaction][source-generation]")
{
    PlannerFixture fixture;
    auto package = collector_package();
    const auto generation = fixture.manager.source_generation_on_owner();
    assets::MandatoryAssetGate gate(fixture.manager);
    REQUIRE(gate.bind_package_on_owner(package, "glsl-120", generation));

    core::RuntimePresentationSnapshot snapshot;
    snapshot.revision = core::PresentationSnapshotRevision::from_number(41);
    snapshot.mode = core::PresentationRuntimeMode::Room;
    snapshot.current_room = id<core::RoomId>("start");
    snapshot.background = core::PresentationBackground{.asset = id<core::AssetId>("image-current"),
                                                       .color = std::nullopt,
                                                       .fit = core::compiled::BackgroundFit::Cover,
                                                       .material = std::nullopt};

    REQUIRE(gate.begin_on_owner(snapshot).disposition ==
            assets::MandatoryAssetGateDisposition::Pending);
    fixture.run_until_idle();
    REQUIRE(gate.poll_on_owner().disposition == assets::MandatoryAssetGateDisposition::Ready);
    auto stale_transaction = gate.take_ready_transaction_on_owner();
    REQUIRE(stale_transaction);
    CHECK_FALSE(gate.active_prefetch_generation_on_owner());

    fixture.manager.mount("project", std::make_shared<assets::MemoryAssetSource>());
    REQUIRE(fixture.manager.source_generation_on_owner() != generation);
    auto stale_commit = stale_transaction->commit_on_owner(false);
    REQUIRE_FALSE(stale_commit);
    CHECK(stale_commit.error().code == "assets.mandatory_publication_stale_source_generation");
    CHECK_FALSE(gate.active_prefetch_generation_on_owner());
    CHECK_FALSE(fixture.manager.has_published_leases_on_owner());

    REQUIRE(gate.begin_on_owner(snapshot).disposition ==
            assets::MandatoryAssetGateDisposition::Pending);
    fixture.run_until_idle();
    REQUIRE(gate.poll_on_owner().disposition == assets::MandatoryAssetGateDisposition::Ready);
    auto current_transaction = gate.take_ready_transaction_on_owner();
    REQUIRE(current_transaction);
    REQUIRE(current_transaction->commit_on_owner(false));
    CHECK(gate.active_prefetch_generation_on_owner().has_value());
    CHECK(fixture.manager.has_published_leases_on_owner());
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

    assets::MandatoryPublicationScope publication(fixture.manager,
                                                  assets::MandatoryPublicationScopeKind::Runtime);
    auto transaction =
        publication.begin_transaction_on_owner(std::move(*leases), request_generation);
    CHECK(fixture.manager.leased_texture_on_owner(request) != nullptr);
    transaction.rollback_on_owner();
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

TEST_CASE("mandatory gate advances speculative Scene prediction from the live execution position",
          "[assets][flow-prediction][mandatory-assets][structured-prefetch][scene]")
{
    PlannerFixture fixture;
    auto document = scene_prediction_test_document();
    for (auto& system_layout : document["settings"]["systemLayouts"])
        system_layout["layout"] = nullptr;
    for (auto& scene : document["definitions"]["scenes"]) {
        if (scene["id"] == "prediction-horizon") {
            scene["terminal"] = {{"kind", "continue-scene"},
                                 {"scene", {{"kind", "scene"}, {"id", "closing"}}},
                                 {"inputs", nlohmann::json::array()}};
            break;
        }
    }
    document["entrypoint"] = {{"kind", "scene"},
                              {"scene", {{"kind", "scene"}, {"id", "prediction-horizon"}}}};
    for (auto& slice : document["flowPrediction"]["slices"]) {
        if (slice["point"]["kind"] == "scene-entry" &&
            slice["point"]["scene"]["id"] == "prediction-horizon") {
            slice["control"]["successor"] = nullptr;
            break;
        }
    }
    auto package = package_from_document(std::move(document), "scene-prediction-test.json");
    const auto generation = fixture.manager.source_generation_on_owner();
    assets::MandatoryAssetGate gate(fixture.manager);
    REQUIRE(gate.bind_package_on_owner(package, "glsl-120", generation));

    core::RuntimePresentationSnapshot snapshot;
    snapshot.revision = core::PresentationSnapshotRevision::from_number(152);
    snapshot.mode = core::PresentationRuntimeMode::Flow;
    REQUIRE(gate.begin_on_owner(snapshot).disposition ==
            assets::MandatoryAssetGateDisposition::Ready);
    auto transaction = gate.take_ready_transaction_on_owner();
    REQUIRE(transaction);
    REQUIRE(transaction->commit_on_owner(false));
    CHECK(std::ranges::find(fixture.recorder.calls,
                            "texture:project:/assets/images/image-prediction-parent-stage.png") !=
          fixture.recorder.calls.end());
    CHECK(std::ranges::find(fixture.recorder.calls,
                            "texture:project:/assets/images/image-prediction-after-short.png") ==
          fixture.recorder.calls.end());
    const auto entry_generation = gate.active_prefetch_generation_on_owner();
    REQUIRE(entry_generation);

    runtime::ActiveScenePredictionRoot root{
        .scene = id<core::SceneId>("prediction-horizon"),
        .position = core::SceneFramePosition{id<core::SceneStepId>("after-short"),
                                             core::SceneStepReady{}, true}};
    const auto diagnostics = gate.update_active_scene_prediction_on_owner(&root);
    CHECK(diagnostics.empty());
    CHECK(std::ranges::find(fixture.recorder.calls,
                            "texture:project:/assets/images/image-prediction-after-short.png") !=
          fixture.recorder.calls.end());
    REQUIRE(gate.active_prefetch_generation_on_owner());
    CHECK(*gate.active_prefetch_generation_on_owner() != *entry_generation);
    const auto live_generation = gate.active_prefetch_generation_on_owner();
    REQUIRE(live_generation);
    CHECK(gate.update_active_scene_prediction_on_owner(&root).empty());
    CHECK(gate.active_prefetch_generation_on_owner() == live_generation);

    gate.clear_package_on_owner();
}

TEST_CASE("mandatory gate ignores Dialogue reveal microstate when reconciling prediction",
          "[assets][flow-prediction][mandatory-assets][structured-prefetch][dialogue]")
{
    PlannerFixture fixture;
    auto document = dialogue_prediction_test_document();
    for (auto& system_layout : document["settings"]["systemLayouts"])
        system_layout["layout"] = nullptr;
    document["entrypoint"] = {{"kind", "dialogue"},
                              {"dialogue", {{"kind", "dialogue"}, {"id", "intro"}}}};
    auto package = package_from_document(std::move(document), "dialogue-prediction-gate.json");
    const auto generation = fixture.manager.source_generation_on_owner();
    assets::MandatoryAssetGate gate(fixture.manager);
    REQUIRE(gate.bind_package_on_owner(package, "glsl-120", generation));

    core::RuntimePresentationSnapshot snapshot;
    snapshot.revision = core::PresentationSnapshotRevision::from_number(153);
    snapshot.mode = core::PresentationRuntimeMode::Flow;
    REQUIRE(gate.begin_on_owner(snapshot).disposition ==
            assets::MandatoryAssetGateDisposition::Ready);
    auto transaction = gate.take_ready_transaction_on_owner();
    REQUIRE(transaction);
    REQUIRE(transaction->commit_on_owner(false));

    runtime::ActiveDialoguePredictionRoot root{
        .dialogue = id<core::DialogueId>("intro"),
        .position = core::DialogueFramePosition{
            id<core::DialogueBlockId>("start"), id<core::DialogueSegmentId>("localized-line"),
            std::nullopt, core::DialogueFramePosition::Stage::PresentSegment, 0, false, 0, 1}};
    CHECK(gate.update_active_dialogue_prediction_on_owner(&root).empty());
    const auto live_generation = gate.active_prefetch_generation_on_owner();
    REQUIRE(live_generation);

    root.position.reveal_offset = 2;
    CHECK(gate.update_active_dialogue_prediction_on_owner(&root).empty());
    CHECK(gate.active_prefetch_generation_on_owner() == live_generation);

    gate.clear_package_on_owner();
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
    auto transaction = gate.take_ready_transaction_on_owner();
    REQUIRE(transaction);
    REQUIRE(transaction->commit_on_owner(false));

    REQUIRE(sink.generations.size() == 1);
    const auto& record = sink.generations.front();
    CHECK(record.generation.valid());
    CHECK(record.presentation_revision == snapshot.revision);
    CHECK(record.expected_next_count + record.possible_next_count ==
          record.submitted_entries.size() + record.submission_failures.size());
    CHECK(record.possible_next_count > 0);
    CHECK(record.prediction_plan.size() == record.expected_next_count + record.possible_next_count);
    CHECK(std::ranges::all_of(record.submitted_entries, [](const auto& entry) {
        return entry.prediction == core::PrefetchPredictionKind::ExpectedNext ||
               entry.prediction == core::PrefetchPredictionKind::PossibleNext;
    }));
    CHECK(gate.active_prefetch_generation_on_owner() == record.generation);

    gate.clear_package_on_owner();
    REQUIRE(sink.released.size() == 1);
    CHECK(sink.released.front() == record.generation);
}

TEST_CASE("mandatory gate profiler advances logical Flow generations while retaining shared work",
          "[assets][structured-prefetch][flow-prediction][mandatory-assets][profiler][reconcile]")
{
    PrefetchGenerationCaptureSink sink;
    PlannerFixture fixture(&sink);
    auto document = scene_prediction_test_document();
    for (auto& system_layout : document["settings"]["systemLayouts"])
        system_layout["layout"] = nullptr;
    for (auto& scene : document["definitions"]["scenes"]) {
        if (scene["id"] == "prediction-horizon") {
            scene["terminal"] = {{"kind", "continue-scene"},
                                 {"scene", {{"kind", "scene"}, {"id", "closing"}}},
                                 {"inputs", nlohmann::json::array()}};
            break;
        }
    }
    document["entrypoint"] = {{"kind", "scene"},
                              {"scene", {{"kind", "scene"}, {"id", "prediction-horizon"}}}};

    std::optional<std::size_t> shared_group;
    for (const auto& slice : document["flowPrediction"]["slices"]) {
        const auto& point = slice["point"];
        if (point.value("kind", "") == "scene-entry" &&
            point["scene"].value("id", "") == "prediction-horizon") {
            REQUIRE(slice["dependencyGroups"].size() == 1);
            shared_group = slice["dependencyGroups"][0].get<std::size_t>();
            break;
        }
    }
    REQUIRE(shared_group);
    for (auto& slice : document["flowPrediction"]["slices"]) {
        const auto& point = slice["point"];
        if (point.value("kind", "") == "scene-step" &&
            point["scene"].value("id", "") == "prediction-horizon" &&
            point.value("stepId", "") == "after-short") {
            slice["dependencyGroups"].push_back(*shared_group);
            break;
        }
    }

    auto package = package_from_document(std::move(document), "profiler-reconcile.json");
    const auto generation = fixture.manager.source_generation_on_owner();
    assets::MandatoryAssetGate gate(fixture.manager);
    REQUIRE(gate.bind_package_on_owner(package, "glsl-120", generation));

    core::RuntimePresentationSnapshot snapshot;
    snapshot.revision = core::PresentationSnapshotRevision::from_number(154);
    snapshot.mode = core::PresentationRuntimeMode::Flow;
    REQUIRE(gate.begin_on_owner(snapshot).disposition ==
            assets::MandatoryAssetGateDisposition::Ready);
    auto transaction = gate.take_ready_transaction_on_owner();
    REQUIRE(transaction);
    REQUIRE(transaction->commit_on_owner(false));
    REQUIRE(sink.generations.size() == 1);
    const auto entry_generation = sink.generations.front().generation;

    const assets::TextureAssetRequest shared_request{
        .path = "project:/assets/images/image-prediction-parent-stage.png",
        .sampler = MaterialTextureSampler::ClampLinear,
    };
    const auto shared_key = assets::make_texture_cache_key(shared_request, generation);
    REQUIRE(
        std::ranges::find_if(sink.generations.front().submitted_entries, [&](const auto& entry) {
            return entry.cache_key == shared_key;
        }) != sink.generations.front().submitted_entries.end());
    CHECK(std::count(fixture.recorder.calls.begin(), fixture.recorder.calls.end(),
                     "texture:project:/assets/images/image-prediction-parent-stage.png") == 1);

    runtime::ActiveScenePredictionRoot root{
        .scene = id<core::SceneId>("prediction-horizon"),
        .position = core::SceneFramePosition{id<core::SceneStepId>("after-short"),
                                             core::SceneStepReady{}, true}};
    CHECK(gate.update_active_scene_prediction_on_owner(&root).empty());
    REQUIRE(sink.generations.size() == 2);
    REQUIRE(sink.released.size() == 1);
    CHECK(sink.released.front() == entry_generation);
    const auto& replacement = sink.generations.back();
    CHECK(replacement.generation != entry_generation);
    REQUIRE_FALSE(replacement.prediction_plan.empty());
    CHECK(std::ranges::any_of(replacement.prediction_plan, [&](const auto& entry) {
        return entry.cache_key == shared_key && !entry.provenance.empty() &&
               !entry.provenance.front().reason_chain.empty();
    }));
    CHECK(std::ranges::find_if(replacement.submitted_entries, [&](const auto& entry) {
              return entry.cache_key == shared_key;
          }) != replacement.submitted_entries.end());
    CHECK(std::count(fixture.recorder.calls.begin(), fixture.recorder.calls.end(),
                     "texture:project:/assets/images/image-prediction-parent-stage.png") == 1);
    CHECK(gate.active_prefetch_generation_on_owner() == replacement.generation);

    gate.clear_package_on_owner();
    REQUIRE(sink.released.size() == 2);
    CHECK(sink.released.back() == replacement.generation);
}

TEST_CASE("mandatory gate profiler reports planner Warm admission rejection",
          "[assets][structured-prefetch][flow-prediction][mandatory-assets][profiler][budget]")
{
    PrefetchGenerationCaptureSink sink;
    auto budget = generous_budget();
    budget.gpu_bytes = 1;
    budget.prefetch_allowance_percent = 100;
    PlannerFixture fixture(&sink, budget);
    auto document = scene_prediction_test_document();
    for (auto& system_layout : document["settings"]["systemLayouts"])
        system_layout["layout"] = nullptr;
    for (auto& scene : document["definitions"]["scenes"]) {
        if (scene["id"] == "prediction-horizon") {
            scene["terminal"] = {{"kind", "continue-scene"},
                                 {"scene", {{"kind", "scene"}, {"id", "closing"}}},
                                 {"inputs", nlohmann::json::array()}};
            break;
        }
    }
    document["entrypoint"] = {{"kind", "scene"},
                              {"scene", {{"kind", "scene"}, {"id", "prediction-horizon"}}}};
    auto package = package_from_document(std::move(document), "profiler-budget.json");
    const auto generation = fixture.manager.source_generation_on_owner();
    assets::MandatoryAssetGate gate(fixture.manager);
    REQUIRE(gate.bind_package_on_owner(package, "glsl-120", generation));

    core::RuntimePresentationSnapshot snapshot;
    snapshot.revision = core::PresentationSnapshotRevision::from_number(155);
    snapshot.mode = core::PresentationRuntimeMode::Flow;
    REQUIRE(gate.begin_on_owner(snapshot).disposition ==
            assets::MandatoryAssetGateDisposition::Ready);
    auto transaction = gate.take_ready_transaction_on_owner();
    REQUIRE(transaction);
    REQUIRE(transaction->commit_on_owner(false));

    REQUIRE(sink.generations.size() == 1);
    const auto& record = sink.generations.front();
    CHECK(record.expected_next_count + record.possible_next_count > 0);
    CHECK_FALSE(record.prediction_plan.empty());
    CHECK(record.submitted_entries.empty());
    REQUIRE_FALSE(record.submission_failures.empty());
    CHECK(std::ranges::any_of(record.submission_failures, [](const auto& failure) {
        return failure.diagnostic.code == "assets.prefetch_plan_warm_budget";
    }));
    CHECK(fixture.recorder.calls.empty());

    gate.clear_package_on_owner();
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

TEST_CASE("compiled Flow Prediction Index drives semantic prediction into real prefetch",
          "[assets][structured-prefetch][flow-prediction]")
{
    PlannerFixture fixture;
    auto package =
        package_from_document(read_compiled_project_golden("scene-program"), "scene-program.json");
    REQUIRE(package.project().flow_prediction().has_value());

    runtime::FlowPredictor predictor(package.project());
    const auto projection =
        predictor.predict(core::compiled::Entrypoint{id<core::SceneId>("opening")});
    REQUIRE(projection.diagnostics.empty());
    const auto predicted_main = std::ranges::find_if(projection.entries, [](const auto& entry) {
        const auto* dependency =
            std::get_if<core::compiled::FlowPredictionAssetDependency>(&entry.dependency);
        return dependency != nullptr && dependency->asset == id<core::AssetId>("image-main");
    });
    REQUIRE(predicted_main != projection.entries.end());
    CHECK(predicted_main->execution_distance == 1);

    const auto generation = fixture.manager.source_generation_on_owner();
    const auto dependency_index =
        assets::StructuredAssetDependencyIndex::build(package, "glsl-120", generation);
    const auto plan = assets::resolve_flow_prediction(dependency_index, projection);
    REQUIRE(plan.diagnostics.empty());
    const auto planned_main = std::ranges::find_if(plan.candidates, [](const auto& candidate) {
        const auto* texture =
            std::get_if<assets::TextureAssetRequest>(&candidate.descriptor.request);
        return texture != nullptr && texture->path == "project:/assets/images/main.png";
    });
    REQUIRE(planned_main != plan.candidates.end());
    CHECK(planned_main->execution_distance == 0);

    assets::PrefetchPlanner planner(fixture.manager);
    const auto submitted = planner.replace_generation_on_owner(plan);
    REQUIRE(submitted);
    CHECK(submitted.value().direct_next_submitted >= 1);
    CHECK(submitted.value().adjacent_submitted >= 1);
    CHECK(submitted.value().failures.empty());
    CHECK(std::ranges::find(fixture.recorder.calls, "texture:project:/assets/images/main.png") !=
          fixture.recorder.calls.end());
    fixture.run_until_idle();
    planner.clear_on_owner();
}

TEST_CASE("prospective Room entry predicts successful lifecycle Flow and widens opaque branches",
          "[assets][structured-prefetch][flow-prediction][room-lifecycle]")
{
    PlannerFixture fixture;
    auto package =
        package_from_document(read_compiled_project_golden("scene-program"), "scene-program.json");
    REQUIRE(package.project().flow_prediction().has_value());

    runtime::FlowPredictor predictor(package.project());
    const auto projection = predictor.predict(runtime::ProspectiveRoomEntryPredictionRoot{
        .source_room = id<core::RoomId>("hall"), .target_room = id<core::RoomId>("tower")});
    REQUIRE(projection.diagnostics.empty());

    const auto room_dependency = std::ranges::find_if(projection.entries, [](const auto& entry) {
        const auto* room =
            std::get_if<core::compiled::FlowPredictionRoomDependency>(&entry.dependency);
        return room != nullptr && room->room == id<core::RoomId>("tower");
    });
    REQUIRE(room_dependency != projection.entries.end());
    CHECK(room_dependency->execution_distance == 2);
    CHECK(room_dependency->confidence == runtime::FlowPredictionConfidence::Expected);

    const auto has_asset = [&](std::string_view asset,
                               runtime::FlowPredictionConfidence confidence) {
        return std::ranges::any_of(projection.entries, [&](const auto& entry) {
            const auto* dependency =
                std::get_if<core::compiled::FlowPredictionAssetDependency>(&entry.dependency);
            return dependency != nullptr &&
                   dependency->asset == id<core::AssetId>(std::string(asset)) &&
                   entry.confidence == confidence;
        });
    };
    // The direct after-enter Scene call and the typed branch selected after the projected flag
    // mutation are expected. The Lua-predicate branch widens without executing Lua.
    CHECK(has_asset("image-main", runtime::FlowPredictionConfidence::Expected));
    const auto expected_scene_entries =
        std::ranges::count_if(projection.entries, [](const auto& entry) {
            const auto* dependency =
                std::get_if<core::compiled::FlowPredictionAssetDependency>(&entry.dependency);
            return dependency != nullptr && dependency->asset == id<core::AssetId>("image-main") &&
                   entry.confidence == runtime::FlowPredictionConfidence::Expected;
        });
    // Three expected Scene entries prove the source before-leave, target before-enter, and source
    // after-leave projected mutations made the first after-enter condition fully decidable, in
    // addition to the direct handoff and the later locally projected typed branch.
    CHECK(expected_scene_entries == 3);
    CHECK(has_asset("image-arrival-dialogue", runtime::FlowPredictionConfidence::Alternative));
    // onEnterRejected also calls the Dialogue, but successful prospective entry must exclude the
    // rejection lifecycle entirely.
    CHECK_FALSE(has_asset("image-arrival-dialogue", runtime::FlowPredictionConfidence::Expected));

    const auto generation = fixture.manager.source_generation_on_owner();
    const auto dependency_index =
        assets::StructuredAssetDependencyIndex::build(package, "glsl-120", generation);
    const auto plan = assets::resolve_flow_prediction(dependency_index, projection);
    REQUIRE(plan.diagnostics.empty());
    const auto dialogue_prefetch = std::ranges::find_if(plan.candidates, [](const auto& candidate) {
        const auto* texture =
            std::get_if<assets::TextureAssetRequest>(&candidate.descriptor.request);
        return texture != nullptr && texture->path == "project:/assets/images/arrival-dialogue.png";
    });
    REQUIRE(dialogue_prefetch != plan.candidates.end());
    CHECK(dialogue_prefetch->prediction == assets::PrefetchPredictionKind::PossibleNext);

    assets::PrefetchPlanner planner(fixture.manager);
    const auto submitted = planner.replace_generation_on_owner(plan);
    REQUIRE(submitted);
    CHECK(submitted.value().adjacent_submitted >= 1);
    fixture.run_until_idle();
    planner.clear_on_owner();

    const auto context_projection = predictor.predict(
        runtime::ProspectiveRoomEntryPredictionRoot{
            .source_room = std::nullopt,
            .target_room = id<core::RoomId>("hall"),
        },
        runtime::FlowPredictionContext{
            .global_properties = {
                {id<core::PropertyId>("player-name"), core::RuntimeValue{std::string{"Ada"}}}}});
    CHECK(std::ranges::any_of(context_projection.entries, [](const auto& entry) {
        const auto* dependency =
            std::get_if<core::compiled::FlowPredictionAssetDependency>(&entry.dependency);
        return dependency != nullptr && dependency->asset == id<core::AssetId>("image-main") &&
               entry.confidence == runtime::FlowPredictionConfidence::Expected;
    }));
    CHECK_FALSE(std::ranges::any_of(context_projection.entries, [](const auto& entry) {
        const auto* dependency =
            std::get_if<core::compiled::FlowPredictionAssetDependency>(&entry.dependency);
        return dependency != nullptr &&
               dependency->asset == id<core::AssetId>("image-arrival-dialogue");
    }));
}

TEST_CASE("Scene prediction starts at the requested execution slice and ranks semantic horizons",
          "[assets][structured-prefetch][flow-prediction][scene]")
{
    auto package =
        package_from_document(scene_prediction_test_document(), "scene-prediction-test.json");
    runtime::FlowPredictor predictor(package.project());

    const auto prospective =
        predictor.predict(core::compiled::Entrypoint{id<core::SceneId>("prediction-horizon")});
    REQUIRE(prospective.diagnostics.empty());

    const auto find_asset = [](const runtime::FlowPredictionProjection& projection,
                               std::string_view asset) {
        return std::ranges::find_if(projection.entries, [&](const auto& entry) {
            const auto* dependency =
                std::get_if<core::compiled::FlowPredictionAssetDependency>(&entry.dependency);
            return dependency != nullptr &&
                   dependency->asset == id<core::AssetId>(std::string(asset));
        });
    };

    const auto parent_stage = find_asset(prospective, "image-prediction-parent-stage");
    const auto child_stage = find_asset(prospective, "image-prediction-child-stage");
    const auto child_late = find_asset(prospective, "image-prediction-child-late");
    const auto caller_after = find_asset(prospective, "image-prediction-caller-after");
    const auto after_short = find_asset(prospective, "image-prediction-after-short");
    const auto detached_stage = find_asset(prospective, "image-prediction-detached-stage");
    const auto detached_deep = find_asset(prospective, "image-prediction-detached-deep");
    const auto foreground = find_asset(prospective, "image-prediction-foreground");
    const auto after_strong = find_asset(prospective, "image-prediction-after-strong");
    REQUIRE(parent_stage != prospective.entries.end());
    REQUIRE(child_stage != prospective.entries.end());
    REQUIRE(child_late != prospective.entries.end());
    REQUIRE(caller_after != prospective.entries.end());
    REQUIRE(after_short != prospective.entries.end());
    REQUIRE(detached_stage != prospective.entries.end());
    REQUIRE(detached_deep != prospective.entries.end());
    REQUIRE(foreground != prospective.entries.end());
    REQUIRE(after_strong != prospective.entries.end());

    CHECK(parent_stage->execution_distance == 0);
    CHECK(child_stage->execution_distance < caller_after->execution_distance);
    CHECK(child_late->execution_distance < caller_after->execution_distance);
    CHECK(caller_after->execution_distance < after_short->execution_distance);
    CHECK(after_short->confidence == runtime::FlowPredictionConfidence::Expected);
    // Detached Flow starts immediately alongside the foreground path, but its deeper closure is
    // demoted so it cannot outrank the caller's own continuation.
    CHECK(detached_stage->confidence == runtime::FlowPredictionConfidence::Expected);
    CHECK(detached_stage->execution_distance <= foreground->execution_distance);
    CHECK(detached_deep->confidence == runtime::FlowPredictionConfidence::Alternative);
    CHECK(detached_deep->execution_distance > foreground->execution_distance);
    // Player input is a strong semantic frontier: later deterministic content remains reachable,
    // but it is no longer treated as the expected immediate path.
    CHECK(after_strong->confidence == runtime::FlowPredictionConfidence::Alternative);

    const auto active = predictor.predict(runtime::ActiveScenePredictionRoot{
        .scene = id<core::SceneId>("prediction-horizon"),
        .position = core::SceneFramePosition{id<core::SceneStepId>("caller-after"),
                                             core::SceneStepReady{}, true}});
    REQUIRE(active.diagnostics.empty());
    CHECK(find_asset(active, "image-prediction-caller-after") != active.entries.end());
    CHECK(find_asset(active, "image-prediction-parent-stage") == active.entries.end());
    CHECK(find_asset(active, "image-prediction-child-stage") == active.entries.end());
}

TEST_CASE("Scene prediction selects known branches, widens choices, and continues past opaque Lua",
          "[assets][structured-prefetch][flow-prediction][scene][condition]")
{
    auto package =
        package_from_document(scene_prediction_test_document(), "scene-prediction-test.json");
    runtime::FlowPredictor predictor(package.project());
    const auto find_asset = [](const runtime::FlowPredictionProjection& projection,
                               std::string_view asset) {
        return std::ranges::find_if(projection.entries, [&](const auto& entry) {
            const auto* dependency =
                std::get_if<core::compiled::FlowPredictionAssetDependency>(&entry.dependency);
            return dependency != nullptr &&
                   dependency->asset == id<core::AssetId>(std::string(asset));
        });
    };

    const auto projection = predictor.predict(
        core::compiled::Entrypoint{id<core::SceneId>("prediction-decision")},
        runtime::FlowPredictionContext{
            .global_properties = {
                {id<core::PropertyId>("count"), core::RuntimeValue{std::int64_t{3}}},
                {id<core::PropertyId>("flag"), core::RuntimeValue{true}},
            }});
    REQUIRE(projection.diagnostics.empty());
    const auto branch_expected = find_asset(projection, "image-prediction-branch-expected");
    REQUIRE(branch_expected != projection.entries.end());
    CHECK(branch_expected->confidence == runtime::FlowPredictionConfidence::Expected);
    CHECK(find_asset(projection, "image-prediction-branch-alternative") ==
          projection.entries.end());

    const auto choice_a = find_asset(projection, "image-prediction-choice-a");
    const auto choice_b = find_asset(projection, "image-prediction-choice-b");
    REQUIRE(choice_a != projection.entries.end());
    REQUIRE(choice_b != projection.entries.end());
    CHECK(choice_a->confidence == runtime::FlowPredictionConfidence::Alternative);
    CHECK(choice_b->confidence == runtime::FlowPredictionConfidence::Alternative);

    const auto opaque_root = predictor.predict(runtime::ActiveScenePredictionRoot{
        .scene = id<core::SceneId>("prediction-decision"),
        .position = core::SceneFramePosition{id<core::SceneStepId>("opaque-lua"),
                                             core::SceneStepReady{}, true}});
    REQUIRE(opaque_root.diagnostics.empty());
    const auto after_lua = find_asset(opaque_root, "image-prediction-after-lua");
    REQUIRE(after_lua != opaque_root.entries.end());
    CHECK(after_lua->confidence == runtime::FlowPredictionConfidence::Expected);
}

TEST_CASE("Dialogue prediction starts at the live execution slice and preserves semantic horizons",
          "[assets][structured-prefetch][flow-prediction][dialogue]")
{
    auto package =
        package_from_document(dialogue_prediction_test_document(), "dialogue-prediction-test.json");
    runtime::FlowPredictor predictor(package.project());
    const auto find_asset = [](const runtime::FlowPredictionProjection& projection,
                               std::string_view asset) {
        return std::ranges::find_if(projection.entries, [&](const auto& entry) {
            const auto* dependency =
                std::get_if<core::compiled::FlowPredictionAssetDependency>(&entry.dependency);
            return dependency != nullptr &&
                   dependency->asset == id<core::AssetId>(std::string(asset));
        });
    };

    const auto prospective =
        predictor.predict(core::compiled::Entrypoint{id<core::DialogueId>("intro")});
    REQUIRE(prospective.diagnostics.empty());
    CHECK(find_asset(prospective, "image-dialogue-before") != prospective.entries.end());

    const auto active = predictor.predict(
        runtime::ActiveDialoguePredictionRoot{
            .dialogue = id<core::DialogueId>("intro"),
            .position =
                core::DialogueFramePosition{id<core::DialogueBlockId>("start"),
                                            id<core::DialogueSegmentId>("localized-line"),
                                            std::nullopt,
                                            core::DialogueFramePosition::Stage::PresentSegment}},
        runtime::FlowPredictionContext{
            .global_properties = {
                {id<core::PropertyId>("count"), core::RuntimeValue{std::int64_t{0}}}}});
    REQUIRE(active.diagnostics.empty());
    const auto current = find_asset(active, "image-dialogue-current");
    const auto after = find_asset(active, "image-dialogue-after");
    REQUIRE(current != active.entries.end());
    REQUIRE(after != active.entries.end());
    CHECK(current->execution_distance == 0);
    CHECK(current->confidence == runtime::FlowPredictionConfidence::Expected);
    CHECK(after->execution_distance > current->execution_distance);
    CHECK(after->confidence == runtime::FlowPredictionConfidence::Alternative);
    CHECK(find_asset(active, "image-dialogue-before") == active.entries.end());

    const auto active_effect = predictor.predict(runtime::ActiveDialoguePredictionRoot{
        .dialogue = id<core::DialogueId>("intro"),
        .position = core::DialogueFramePosition{
            id<core::DialogueBlockId>("start"), id<core::DialogueSegmentId>("inline-line"),
            std::nullopt, core::DialogueFramePosition::Stage::ApplySegmentEffects, 1}});
    REQUIRE(active_effect.diagnostics.empty());
    CHECK(find_asset(active_effect, "image-dialogue-effect-zero") == active_effect.entries.end());
    const auto effect_one = find_asset(active_effect, "image-dialogue-effect-one");
    REQUIRE(effect_one != active_effect.entries.end());
    CHECK(effect_one->execution_distance == 0);
}

TEST_CASE("Dialogue nested effect prediction resumes from the exact generated command cursor",
          "[assets][structured-prefetch][flow-prediction][dialogue][effects]")
{
    auto document = dialogue_prediction_test_document();
    for (auto& slice : document["flowPrediction"]["slices"]) {
        const auto& point = slice["point"];
        if (point.value("kind", "") != "dialogue-position" ||
            point["dialogue"].value("id", "") != "intro" ||
            point.value("stage", "") != "apply-segment-effects" ||
            point.value("segmentId", "") != "inline-line" || point.value("cursor", 0U) != 0U)
            continue;
        slice["program"] = nlohmann::json::array({
            {{"commandId", "outer-if"},
             {"kind", "if"},
             {"condition", {{"kind", "lua-predicate"}, {"source", "unknown_branch()"}}},
             {"thenCommands",
              nlohmann::json::array({{{"commandId", "nested-call"},
                                      {"kind", "call-scene"},
                                      {"scene", {{"kind", "scene"}, {"id", "opening"}}}}})},
             {"elseCommands", nlohmann::json::array()}},
        });
        break;
    }
    auto package = package_from_document(std::move(document), "dialogue-nested-effect.json");
    runtime::FlowPredictor predictor(package.project());
    const auto projection = predictor.predict(runtime::ActiveDialoguePredictionRoot{
        .dialogue = id<core::DialogueId>("intro"),
        .position = core::DialogueFramePosition{
            id<core::DialogueBlockId>("start"), id<core::DialogueSegmentId>("inline-line"),
            std::nullopt, core::DialogueFramePosition::Stage::ApplySegmentEffects, 0, false, 0, 0,
            id<core::InteractionInstructionId>("nested-call")}});
    REQUIRE(projection.diagnostics.empty());
    const auto child = std::ranges::find_if(projection.entries, [](const auto& entry) {
        const auto* dependency =
            std::get_if<core::compiled::FlowPredictionAssetDependency>(&entry.dependency);
        return dependency != nullptr &&
               dependency->asset == id<core::AssetId>("image-dialogue-child");
    });
    REQUIRE(child != projection.entries.end());
    CHECK(child->confidence == runtime::FlowPredictionConfidence::Expected);
}

TEST_CASE("Dialogue choices expose enabled outcomes as alternatives without guessing selection",
          "[assets][structured-prefetch][flow-prediction][dialogue][choice]")
{
    auto package = package_from_document(dialogue_prediction_test_document(),
                                         "dialogue-choice-prediction.json");
    runtime::FlowPredictor predictor(package.project());
    const auto has_asset = [](const runtime::FlowPredictionProjection& projection,
                              std::string_view asset) {
        return std::ranges::find_if(projection.entries, [&](const auto& entry) {
            const auto* dependency =
                std::get_if<core::compiled::FlowPredictionAssetDependency>(&entry.dependency);
            return dependency != nullptr &&
                   dependency->asset == id<core::AssetId>(std::string(asset));
        });
    };
    const runtime::ActiveDialoguePredictionRoot choice_root{
        .dialogue = id<core::DialogueId>("intro"),
        .position = core::DialogueFramePosition{
            id<core::DialogueBlockId>("choice"), std::nullopt, std::nullopt,
            core::DialogueFramePosition::Stage::PresentChoices}};

    const auto enabled = predictor.predict(
        choice_root,
        runtime::FlowPredictionContext{
            .global_properties = {{id<core::PropertyId>("flag"), core::RuntimeValue{true}}}});
    REQUIRE(enabled.diagnostics.empty());
    const auto redirect = has_asset(enabled, "image-dialogue-choice-redirect");
    const auto opaque = has_asset(enabled, "image-dialogue-choice-final");
    REQUIRE(redirect != enabled.entries.end());
    REQUIRE(opaque != enabled.entries.end());
    CHECK(redirect->confidence == runtime::FlowPredictionConfidence::Alternative);
    CHECK(opaque->confidence == runtime::FlowPredictionConfidence::Alternative);

    const auto disabled = predictor.predict(
        choice_root,
        runtime::FlowPredictionContext{
            .global_properties = {{id<core::PropertyId>("flag"), core::RuntimeValue{false}}}});
    REQUIRE(disabled.diagnostics.empty());
    CHECK(has_asset(disabled, "image-dialogue-choice-redirect") == disabled.entries.end());
    CHECK(has_asset(disabled, "image-dialogue-choice-final") != disabled.entries.end());
}

TEST_CASE(
    "Dialogue child Flow runs before retained continuation and cyclic child topology terminates",
    "[assets][structured-prefetch][flow-prediction][dialogue][cycle]")
{
    auto document = dialogue_prediction_test_document();
    for (auto& slice : document["flowPrediction"]["slices"]) {
        const auto& point = slice["point"];
        if (point.value("kind", "") == "scene-terminal" &&
            point["scene"].value("id", "") == "opening") {
            slice["program"] =
                nlohmann::json::array({{{"kind", "call-dialogue"},
                                        {"dialogue", {{"kind", "dialogue"}, {"id", "intro"}}}}});
            break;
        }
    }
    auto package = package_from_document(std::move(document), "dialogue-child-cycle.json");
    runtime::FlowPredictor predictor(package.project());
    const auto projection = predictor.predict(runtime::ActiveDialoguePredictionRoot{
        .dialogue = id<core::DialogueId>("intro"),
        .position = core::DialogueFramePosition{
            id<core::DialogueBlockId>("start"), id<core::DialogueSegmentId>("dialogue-lua"),
            std::nullopt, core::DialogueFramePosition::Stage::PresentSegment}});
    REQUIRE(projection.diagnostics.empty());
    const auto find_asset = [&](std::string_view asset) {
        return std::ranges::find_if(projection.entries, [&](const auto& entry) {
            const auto* dependency =
                std::get_if<core::compiled::FlowPredictionAssetDependency>(&entry.dependency);
            return dependency != nullptr &&
                   dependency->asset == id<core::AssetId>(std::string(asset));
        });
    };
    const auto child = find_asset("image-dialogue-child");
    const auto continuation = find_asset("image-dialogue-continuation");
    REQUIRE(child != projection.entries.end());
    REQUIRE(continuation != projection.entries.end());
    CHECK(child->execution_distance < continuation->execution_distance);
    CHECK(projection.entries.size() < 128);
}

TEST_CASE("Dialogue completion follows Dialogue and Room targets through the generated index",
          "[assets][structured-prefetch][flow-prediction][dialogue][completion]")
{
    auto package =
        package_from_document(dialogue_prediction_test_document(), "dialogue-completion.json");
    runtime::FlowPredictor predictor(package.project());
    const auto direct = predictor.predict(runtime::ActiveDialoguePredictionRoot{
        .dialogue = id<core::DialogueId>("epilogue"),
        .position = core::DialogueFramePosition{id<core::DialogueBlockId>("epilogue-block"),
                                                std::nullopt, std::nullopt,
                                                core::DialogueFramePosition::Stage::Complete}});
    REQUIRE(direct.diagnostics.empty());
    const auto find_room = [](const runtime::FlowPredictionProjection& projection) {
        return std::ranges::find_if(projection.entries, [](const auto& entry) {
            const auto* dependency =
                std::get_if<core::compiled::FlowPredictionAssetDependency>(&entry.dependency);
            return dependency != nullptr &&
                   dependency->asset == id<core::AssetId>("image-dialogue-room-completion");
        });
    };
    const auto direct_room = find_room(direct);
    REQUIRE(direct_room != direct.entries.end());
    CHECK(direct_room->confidence == runtime::FlowPredictionConfidence::Expected);

    const auto transitive = predictor.predict(runtime::ActiveDialoguePredictionRoot{
        .dialogue = id<core::DialogueId>("intro"),
        .position = core::DialogueFramePosition{id<core::DialogueBlockId>("choice"), std::nullopt,
                                                std::nullopt,
                                                core::DialogueFramePosition::Stage::Complete}});
    REQUIRE(transitive.diagnostics.empty());
    const auto transitive_room = find_room(transitive);
    REQUIRE(transitive_room != transitive.entries.end());
    CHECK(transitive_room->confidence == runtime::FlowPredictionConfidence::Alternative);
}

TEST_CASE("Scene prediction terminates cyclic generated topology without executing gameplay",
          "[assets][structured-prefetch][flow-prediction][scene][cycle]")
{
    auto document = scene_prediction_test_document();
    auto& slices = document["flowPrediction"]["slices"];
    std::optional<std::size_t> entry_index;
    std::optional<std::size_t> terminal_index;
    for (std::size_t index = 0; index < slices.size(); ++index) {
        const auto& point = slices[index]["point"];
        if (point.value("kind", "") == "scene-entry" &&
            point["scene"].value("id", "") == "prediction-horizon")
            entry_index = index;
        if (point.value("kind", "") == "scene-terminal" &&
            point["scene"].value("id", "") == "prediction-horizon")
            terminal_index = index;
    }
    REQUIRE(entry_index);
    REQUIRE(terminal_index);
    slices[*terminal_index]["control"] =
        nlohmann::json{{"kind", "sequential"}, {"successor", *entry_index}};

    auto package = package_from_document(std::move(document), "scene-program-cycle.json");
    runtime::FlowPredictor predictor(package.project());
    const auto projection =
        predictor.predict(core::compiled::Entrypoint{id<core::SceneId>("prediction-horizon")});
    REQUIRE(projection.diagnostics.empty());
    CHECK(projection.entries.size() < 32);
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

TEST_CASE("Flow prefetch planner ranks usefulness before cost and admits only the Warm fit",
          "[assets][structured-prefetch][flow-prediction][budget]")
{
    auto budget = generous_budget();
    budget.gpu_bytes = 100;
    budget.prefetch_allowance_percent = 50;
    PlannerFixture fixture(nullptr, budget);
    assets::PrefetchPlanner planner(fixture.manager);
    const auto generation = fixture.manager.source_generation_on_owner();

    const auto candidate = [&](std::string path, std::size_t distance, std::size_t execution_order,
                               std::size_t dependency_priority, std::uint64_t gpu_bytes) {
        return assets::PrefetchCandidate{
            .descriptor =
                descriptor(assets::TextureAssetRequest{.path = std::move(path)}, generation),
            .prediction = assets::PrefetchPredictionKind::ExpectedNext,
            .execution_distance = distance,
            .execution_order = execution_order,
            .dependency_priority = dependency_priority,
            .estimated_cost = {.gpu_bytes = gpu_bytes},
            .cost_estimate = assets::PrefetchCostEstimateKind::Metadata,
        };
    };

    assets::PrefetchPlan plan;
    plan.candidates = {
        candidate("project:/textures/far-cheap.png", 3, 2, 0, 1),
        candidate("project:/textures/near-expensive.png", 0, 0, 0, 30),
        candidate("project:/textures/near-cheap.png", 0, 0, 0, 10),
        candidate("project:/textures/near-too-large.png", 0, 0, 0, 20),
    };

    const auto report = planner.replace_generation_on_owner(plan);
    REQUIRE(report);
    CHECK(fixture.recorder.calls ==
          std::vector<std::string>{"texture:project:/textures/near-cheap.png",
                                   "texture:project:/textures/near-too-large.png",
                                   "texture:project:/textures/far-cheap.png"});
    REQUIRE(report.value().admission_rejections.size() == 1);
    CHECK(report.value().admission_rejections.front().cache_key ==
          assets::make_texture_cache_key(
              assets::TextureAssetRequest{.path = "project:/textures/near-expensive.png"},
              generation));
    CHECK(report.value().budget_exhausted == false);
    planner.clear_on_owner();
}

TEST_CASE("Flow prefetch planner uses conservative prediction cost without preparing rejected work",
          "[assets][structured-prefetch][flow-prediction][budget]")
{
    auto constrained = generous_budget();
    constrained.prepared_cpu_bytes = 64u * 1024u - 1u;
    constrained.prefetch_allowance_percent = 100;
    PlannerFixture fixture(nullptr, constrained);
    auto package =
        package_from_document(scene_prediction_test_document(), "unknown-prediction-cost.json");
    const auto generation = fixture.manager.source_generation_on_owner();
    const auto dependency_index =
        assets::StructuredAssetDependencyIndex::build(package, "glsl-120", generation);
    runtime::FlowPredictionProjection projection;
    projection.entries.push_back({.dependency =
                                      core::compiled::FlowPredictionMaterialDependency{
                                          id<core::MaterialId>("sprite-material")},
                                  .execution_distance = 0,
                                  .confidence = runtime::FlowPredictionConfidence::Expected,
                                  .execution_order = 0,
                                  .dependency_priority = 0,
                                  .provenance = {{core::compiled::SceneEntryPredictionPoint{
                                      id<core::SceneId>("prediction-horizon")}}}});
    const auto plan = assets::resolve_flow_prediction(dependency_index, projection);
    const auto unknown = std::ranges::find_if(plan.candidates, [](const auto& candidate) {
        const auto* material =
            std::get_if<assets::MaterialAssetRequest>(&candidate.descriptor.request);
        return material != nullptr && material->id == "sprite-material";
    });
    REQUIRE(unknown != plan.candidates.end());
    CHECK(unknown->cost_estimate == assets::PrefetchCostEstimateKind::Conservative);
    CHECK(unknown->estimated_cost.prepared_cpu_bytes > 0);
    CHECK_FALSE(unknown->provenance.empty());

    REQUIRE(unknown->estimated_cost.prepared_cpu_bytes > constrained.prepared_cpu_bytes);
    assets::PrefetchPlanner planner(fixture.manager);
    assets::PrefetchPlan one_candidate;
    one_candidate.candidates.push_back(*unknown);
    const auto report = planner.replace_generation_on_owner(one_candidate);
    REQUIRE(report);
    CHECK(report.value().submitted_entries.empty());
    REQUIRE(report.value().admission_rejections.size() == 1);
    CHECK(fixture.recorder.calls.empty());
}

TEST_CASE("Flow prefetch plan replacement retains equivalent work across logical generations",
          "[assets][structured-prefetch][flow-prediction][reconcile]")
{
    PrefetchGenerationCaptureSink sink;
    PlannerFixture fixture(&sink);
    assets::PrefetchPlanner planner(fixture.manager);
    const auto generation = fixture.manager.source_generation_on_owner();
    const assets::TextureAssetRequest request{.path = "project:/textures/retained.png"};

    assets::PrefetchPlan plan;
    plan.candidates.push_back({
        .descriptor = descriptor(request, generation),
        .prediction = assets::PrefetchPredictionKind::ExpectedNext,
        .execution_distance = 0,
        .execution_order = 0,
        .dependency_priority = 0,
        .estimated_cost = {.gpu_bytes = 1},
        .cost_estimate = assets::PrefetchCostEstimateKind::Metadata,
        .provenance = {{.points = {core::compiled::SceneEntryPredictionPoint{
                            id<core::SceneId>("prediction-horizon")}}}},
    });
    const auto first = planner.replace_generation_on_owner(plan);
    REQUIRE(first);
    REQUIRE(first.value().submitted_entries.size() == 1);
    REQUIRE(fixture.recorder.calls.size() == 1);

    const auto second = planner.replace_generation_on_owner(plan);
    REQUIRE(second);
    CHECK(second.value().generation != first.value().generation);
    CHECK(second.value().submitted_entries.empty());
    REQUIRE(second.value().retained_entries.size() == 1);
    CHECK(second.value().retained_entries.front().provenance == plan.candidates.front().provenance);
    CHECK(fixture.recorder.calls.size() == 1);
    CHECK(planner.retained_ticket_count_on_owner() == 1);

    auto demand = fixture.manager.request_texture(request, assets::AssetRequestReason::Demand);
    REQUIRE(demand);
    fixture.run_until_idle();
    CHECK(demand.value().state() == assets::AssetRequestState::Ready);
    CHECK(fixture.recorder.preparation_steps == 1);
    auto lease = std::move(demand).value().take_ready();
    REQUIRE(lease);
    const auto late = std::ranges::find_if(sink.events, [](const auto& event) {
        return event.kind == core::AssetTelemetryEventKind::PrefetchLate;
    });
    REQUIRE(late != sink.events.end());
    CHECK(late->prefetch_generation == second.value().generation);
    planner.clear_on_owner();
}

TEST_CASE("Flow prefetch plan replacement retags completed work for later Demand attribution",
          "[assets][structured-prefetch][flow-prediction][reconcile]")
{
    PrefetchGenerationCaptureSink sink;
    PlannerFixture fixture(&sink);
    assets::PrefetchPlanner planner(fixture.manager);
    const auto generation = fixture.manager.source_generation_on_owner();
    const assets::TextureAssetRequest request{.path = "project:/textures/retained-ready.png"};

    assets::PrefetchPlan plan;
    plan.candidates.push_back({
        .descriptor = descriptor(request, generation),
        .prediction = assets::PrefetchPredictionKind::ExpectedNext,
        .execution_distance = 0,
        .estimated_cost = {.gpu_bytes = 1},
        .cost_estimate = assets::PrefetchCostEstimateKind::Metadata,
    });
    const auto first = planner.replace_generation_on_owner(plan);
    REQUIRE(first);
    fixture.run_until_idle();
    CHECK(fixture.recorder.preparation_steps == 1);

    const auto second = planner.replace_generation_on_owner(plan);
    REQUIRE(second);
    CHECK(second.value().generation != first.value().generation);
    REQUIRE(second.value().retained_entries.size() == 1);
    CHECK(fixture.recorder.calls.size() == 1);

    auto demand = fixture.manager.request_texture(request, assets::AssetRequestReason::Demand);
    REQUIRE(demand);
    CHECK(demand.value().state() == assets::AssetRequestState::Ready);
    auto lease = std::move(demand).value().take_ready();
    REQUIRE(lease);
    const auto used = std::ranges::find_if(sink.events, [](const auto& event) {
        return event.kind == core::AssetTelemetryEventKind::PrefetchUsed;
    });
    REQUIRE(used != sink.events.end());
    CHECK(used->prefetch_generation == second.value().generation);
    CHECK(fixture.recorder.preparation_steps == 1);
    planner.clear_on_owner();
}

TEST_CASE("Flow prefetch alternative peers do not inherit traversal-order priority",
          "[assets][structured-prefetch][flow-prediction][budget][alternative]")
{
    auto budget = generous_budget();
    budget.gpu_bytes = 10;
    PlannerFixture fixture(nullptr, budget);
    assets::PrefetchPlanner planner(fixture.manager);
    const auto generation = fixture.manager.source_generation_on_owner();

    assets::PrefetchPlan plan;
    plan.candidates = {
        {.descriptor = descriptor(
             assets::TextureAssetRequest{.path = "project:/textures/first-branch.png"}, generation),
         .prediction = assets::PrefetchPredictionKind::PossibleNext,
         .execution_distance = 1,
         .execution_order = 1,
         .estimated_cost = {.gpu_bytes = 10},
         .cost_estimate = assets::PrefetchCostEstimateKind::Metadata},
        {.descriptor =
             descriptor(assets::TextureAssetRequest{.path = "project:/textures/second-branch.png"},
                        generation),
         .prediction = assets::PrefetchPredictionKind::PossibleNext,
         .execution_distance = 1,
         .execution_order = 999,
         .estimated_cost = {.gpu_bytes = 1},
         .cost_estimate = assets::PrefetchCostEstimateKind::Metadata},
    };

    const auto report = planner.replace_generation_on_owner(plan);
    REQUIRE(report);
    REQUIRE(report.value().submitted_entries.size() == 1);
    CHECK(report.value().submitted_entries.front().cache_key ==
          plan.candidates[1].descriptor.cache_key);
    REQUIRE(report.value().admission_rejections.size() == 1);
    CHECK(report.value().admission_rejections.front().cache_key ==
          plan.candidates[0].descriptor.cache_key);
    planner.clear_on_owner();
}

TEST_CASE("Flow prefetch planner caps pathological candidate sets before dispatch",
          "[assets][structured-prefetch][flow-prediction][budget][ceiling]")
{
    auto budget = generous_budget();
    budget.gpu_bytes = 0;
    PlannerFixture fixture(nullptr, budget);
    assets::PrefetchPlanner planner(fixture.manager);
    const auto generation = fixture.manager.source_generation_on_owner();

    assets::PrefetchPlan plan;
    for (std::size_t index = 0; index < 4100; ++index) {
        const auto path = "project:/textures/pathological-" + std::to_string(index) + ".png";
        plan.candidates.push_back(
            {.descriptor = descriptor(assets::TextureAssetRequest{.path = path}, generation),
             .prediction = assets::PrefetchPredictionKind::PossibleNext,
             .execution_distance = 1,
             .execution_order = index,
             .estimated_cost = {.gpu_bytes = 1},
             .cost_estimate = assets::PrefetchCostEstimateKind::Metadata});
    }

    const auto report = planner.replace_generation_on_owner(plan);
    REQUIRE(report);
    CHECK(report.value().structural_limit_reached);
    CHECK(report.value().budget_exhausted);
    CHECK(report.value().submitted_entries.empty());
    CHECK(fixture.recorder.calls.empty());
    planner.clear_on_owner();
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
    auto transaction = gate.take_ready_transaction_on_owner();
    REQUIRE(transaction);
    const assets::AudioAssetRequest request{.path = "project:/assets/audio/voice.ogg",
                                            .mode = AudioLoadMode::Auto,
                                            .kind = AudioClipKind::Voice};
    REQUIRE(fixture.manager.leased_audio_on_owner(request));
    REQUIRE(transaction->commit_on_owner(false));
    REQUIRE(fixture.manager.has_published_leases_on_owner());
    gate.clear_package_on_owner();
}
