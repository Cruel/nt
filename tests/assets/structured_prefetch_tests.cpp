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
#include <set>
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

TEST_CASE("mandatory collector builds typed publication closure without speculative traversal",
          "[assets][structured-prefetch][mandatory-assets]")
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

    assets::MandatoryAssetDependencyContext context;
    context.current_presentation = &snapshot;

    const assets::MandatoryAssetDependencyCollector collector(index);
    const auto collected = collector.collect(context);

    REQUIRE(find_request<assets::TextureAssetRequest>(collected.requests, [](const auto& request) {
        return request.path == "project:/assets/images/current.png";
    }));
    REQUIRE(find_request<assets::AudioAssetRequest>(collected.requests, [](const auto& request) {
        return request.path == "project:/assets/audio/voice.ogg" &&
               request.kind == AudioClipKind::Voice;
    }));

    std::vector<assets::AssetCacheKey> keys;
    for (const auto& item : collected.requests) {
        CHECK(item.cache_key.source_generation == generation);
        CHECK(std::find(keys.begin(), keys.end(), item.cache_key) == keys.end());
        keys.push_back(item.cache_key);
    }
}

TEST_CASE("structured texture dependencies carry alpha coverage into mandatory and prefetch work",
          "[assets][structured-prefetch][texture-alpha]")
{
    PlannerFixture fixture;
    auto package = collector_package();
    const auto generation = fixture.manager.source_generation_on_owner();
    const auto index =
        assets::StructuredAssetDependencyIndex::build(package, "glsl-120", generation);
    const assets::MandatoryAssetDependencyCollector collector(index);

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
    assets::MandatoryAssetDependencyContext mandatory_context;
    mandatory_context.current_presentation = &snapshot;
    const auto mandatory = collector.collect(mandatory_context);
    const auto mandatory_texture =
        find_request<assets::TextureAssetRequest>(mandatory.requests, [](const auto& request) {
            return request.path == "project:/assets/images/main.png" &&
                   request.sampler == MaterialTextureSampler::ClampLinear;
        });
    REQUIRE(mandatory_texture);
    CHECK(std::get<assets::TextureAssetRequest>(mandatory.requests[*mandatory_texture].request)
              .retain_alpha_coverage);

    assets::MandatoryAssetRequestGroup mandatory_group(
        fixture.manager, {mandatory.requests[*mandatory_texture]},
        {.reason = assets::AssetRequestReason::Demand, .show_overlay_immediately = true});
    fixture.run_until_idle();
    mandatory_group.poll_on_owner();
    REQUIRE(mandatory_group.state_on_owner() == assets::MandatoryAssetGroupState::Ready);
    REQUIRE_FALSE(fixture.textures.requests.empty());
    CHECK(fixture.textures.requests.back().retain_alpha_coverage);

    fixture.textures.requests.clear();
    runtime::FlowPredictionProjection projection;
    projection.entries.push_back(
        {.dependency =
             core::compiled::FlowPredictionRoomDependency{.room = id<core::RoomId>("start")},
         .provenance = {.root_kind = runtime::FlowPredictionRootKind::FlowExecution}});
    const auto speculative = assets::resolve_flow_prediction(index, projection);
    const auto speculative_texture = std::find_if(
        speculative.candidates.begin(), speculative.candidates.end(), [](const auto& candidate) {
            const auto* request =
                std::get_if<assets::TextureAssetRequest>(&candidate.descriptor.request);
            return request != nullptr && request->path == "project:/assets/images/main.png" &&
                   request->sampler == MaterialTextureSampler::ClampLinear;
        });
    REQUIRE(speculative_texture != speculative.candidates.end());
    CHECK(std::get<assets::TextureAssetRequest>(speculative_texture->descriptor.request)
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

TEST_CASE("speculative index diagnostics do not become mandatory publication failures",
          "[assets][structured-prefetch][mandatory-assets][flow-prediction]")
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

    assets::MandatoryAssetDependencyContext context;
    context.current_presentation = &snapshot;
    const assets::MandatoryAssetDependencyCollector collector(index);
    const auto collected = collector.collect(context);
    CHECK_FALSE(has_code(collected.diagnostics, "assets.prefetch_shader_resolution_failed"));

    runtime::FlowPredictionProjection projection;
    projection.entries.push_back(
        {.dependency =
             core::compiled::FlowPredictionRoomDependency{.room = id<core::RoomId>("hall")},
         .provenance = {.root_kind = runtime::FlowPredictionRootKind::FlowExecution}});
    const auto speculative = assets::resolve_flow_prediction(index, projection);
    CHECK(has_code(speculative.diagnostics, "assets.prefetch_shader_resolution_failed"));

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
    const assets::MandatoryAssetDependencyCollector collector(index);

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

    assets::MandatoryAssetDependencyContext context;
    context.current_presentation = &snapshot;
    const auto collected = collector.collect(context);

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

    runtime::FlowPredictionContext prediction_context{
        .prospective_room_entries = {runtime::ProspectiveRoomEntryPredictionRoot{
            .source_room = id<core::RoomId>("hall"),
            .target_room = id<core::RoomId>("tower")}}};
    CHECK(gate.update_active_scene_prediction_on_owner(nullptr, prediction_context).empty());

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
    const auto interaction_slice = document["flowPrediction"]["slices"].size();
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
    document["flowPrediction"]["supplementalHints"] = nlohmann::json::array(
        {{{"id", "resident-click-hint"},
          {"target",
           {{"kind", "asset"},
            {"asset", {{"kind", "asset"}, {"id", "resident-image"}}}}},
          {"attachment", {{"kind", "point"}, {"slice", interaction_slice}}}}});
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
    CHECK(std::ranges::any_of(resident.entries, [](const auto& entry) {
        const auto* asset =
            std::get_if<core::compiled::FlowPredictionAssetDependency>(&entry.dependency);
        return asset != nullptr && asset->asset == id<core::AssetId>("resident-image") &&
               entry.provenance.supplemental_hint_id == "resident-click-hint";
    }));

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
    SECTION("malformed prediction metadata degrades without invalidating gameplay")
    {
        REQUIRE(document.contains("flowPrediction"));
        document["flowPrediction"]["slices"] = "not-an-array";
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

TEST_CASE("Flow prediction resolves semantic dependencies against the current source generation",
          "[assets][structured-prefetch][flow-prediction][source-generation]")
{
    auto package =
        package_from_document(read_compiled_project_golden("scene-program"), "scene-program.json");
    const auto projection = runtime::FlowPredictor(package.project()).predict(
        core::compiled::Entrypoint{id<core::SceneId>("opening")});
    REQUIRE(projection.diagnostics.empty());

    const assets::AssetSourceGeneration first_generation{41};
    const assets::AssetSourceGeneration second_generation{42};
    const auto first_index =
        assets::StructuredAssetDependencyIndex::build(package, "glsl-120", first_generation);
    const auto second_index =
        assets::StructuredAssetDependencyIndex::build(package, "glsl-120", second_generation);
    const auto first_plan = assets::resolve_flow_prediction(first_index, projection);
    const auto second_plan = assets::resolve_flow_prediction(second_index, projection);
    REQUIRE(first_plan.diagnostics.empty());
    REQUIRE(second_plan.diagnostics.empty());

    const auto find_main = [](const assets::PrefetchPlan& plan) {
        return std::ranges::find_if(plan.candidates, [](const auto& candidate) {
            const auto* texture =
                std::get_if<assets::TextureAssetRequest>(&candidate.descriptor.request);
            return texture != nullptr && texture->path == "project:/assets/images/main.png";
        });
    };
    const auto first = find_main(first_plan);
    const auto second = find_main(second_plan);
    REQUIRE(first != first_plan.candidates.end());
    REQUIRE(second != second_plan.candidates.end());
    CHECK(first->descriptor.cache_key.stable_identity == second->descriptor.cache_key.stable_identity);
    CHECK(first->descriptor.cache_key.source_generation == first_generation);
    CHECK(second->descriptor.cache_key.source_generation == second_generation);
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

TEST_CASE("Flow-predicted Room hotspot mask is ready for later mandatory Demand",
          "[assets][structured-prefetch][flow-prediction][hotspot-mask]")
{
    PlannerFixture fixture;
    auto package = collector_package();
    const auto generation = fixture.manager.source_generation_on_owner();
    const auto index =
        assets::StructuredAssetDependencyIndex::build(package, "glsl-120", generation);
    runtime::FlowPredictionProjection projection;
    projection.entries.push_back(
        {.dependency =
             core::compiled::FlowPredictionRoomDependency{.room = id<core::RoomId>("hall")},
         .provenance = {.root_kind = runtime::FlowPredictionRootKind::FlowExecution}});
    const auto plan = assets::resolve_flow_prediction(index, projection);
    const auto mask =
        std::find_if(plan.candidates.begin(), plan.candidates.end(), [](const auto& candidate) {
            return std::holds_alternative<assets::HotspotMaskAssetRequest>(
                candidate.descriptor.request);
        });
    REQUIRE(mask != plan.candidates.end());

    assets::PrefetchPlanner planner(fixture.manager);
    const auto report = planner.replace_generation_on_owner(plan);
    REQUIRE(report);
    fixture.run_until_idle();
    CHECK(std::count(fixture.recorder.calls.begin(), fixture.recorder.calls.end(),
                     "hotspot-mask") == 1);

    assets::MandatoryAssetRequestGroup mandatory(
        fixture.manager, {mask->descriptor},
        {.reason = assets::AssetRequestReason::Demand, .show_overlay_immediately = true});
    mandatory.poll_on_owner();
    CHECK(mandatory.state_on_owner() == assets::MandatoryAssetGroupState::Ready);
    auto leases = mandatory.take_ready_leases_on_owner();
    REQUIRE(leases);
    CHECK(leases->find_hotspot_mask(mask->descriptor.cache_key) != nullptr);
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

TEST_CASE("mandatory gate includes live detached Flow positions in the speculative plan",
          "[assets][flow-prediction][mandatory-assets][structured-prefetch][detached]")
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
    for (auto& slice : document["flowPrediction"]["slices"]) {
        if (slice["point"]["kind"] == "scene-entry" &&
            slice["point"]["scene"]["id"] == "prediction-horizon") {
            slice["control"]["successor"] = nullptr;
            break;
        }
    }

    auto package = package_from_document(std::move(document), "detached-live-prediction.json");
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

    runtime::ActiveScenePredictionRoot foreground{
        .scene = id<core::SceneId>("prediction-horizon"),
        .position = core::SceneFramePosition{id<core::SceneStepId>("after-short"),
                                             core::SceneStepReady{}, true}};
    runtime::FlowPredictionContext context;
    context.detached_scenes.push_back(
        {.scene = id<core::SceneId>("prediction-detached"),
         .position = core::SceneFramePosition{}});
    context.detached_suspended_scenes.push_back(
        {.scene = id<core::SceneId>("prediction-horizon"),
         .position = core::SceneFramePosition{id<core::SceneStepId>("caller-after"),
                                              core::SceneStepReady{}, true}});
    CHECK(gate.update_active_scene_prediction_on_owner(&foreground, context).empty());
    CHECK(std::ranges::find(
              fixture.recorder.calls,
              "texture:project:/assets/images/image-prediction-after-short.png") !=
          fixture.recorder.calls.end());
    CHECK(std::ranges::find(
              fixture.recorder.calls,
              "texture:project:/assets/images/image-prediction-detached-stage.png") !=
          fixture.recorder.calls.end());
    CHECK(std::ranges::find(
              fixture.recorder.calls,
              "texture:project:/assets/images/image-prediction-detached-deep.png") !=
          fixture.recorder.calls.end());
    CHECK(std::ranges::find(fixture.recorder.calls,
                            "texture:project:/assets/images/image-prediction-caller-after.png") !=
          fixture.recorder.calls.end());
    const auto with_detached = gate.active_prefetch_generation_on_owner();
    REQUIRE(with_detached);
#if NOVELTEA_ENABLE_EDITOR_ASSET_PROFILER
    REQUIRE_FALSE(sink.generations.empty());
    const auto& detached_generation = sink.generations.back();
    const auto detached_plan =
        std::ranges::find_if(detached_generation.prediction_plan, [](const auto& entry) {
            return std::ranges::any_of(entry.provenance, [](const auto& provenance) {
                return provenance.root == core::AssetProfilerPredictionRoot::DetachedFlowExecution;
            });
        });
    REQUIRE(detached_plan != detached_generation.prediction_plan.end());
    CHECK(std::ranges::any_of(detached_plan->provenance, [](const auto& provenance) {
        return provenance.root == core::AssetProfilerPredictionRoot::DetachedFlowExecution;
    }));
    const auto detached_current_plan =
        std::ranges::find_if(detached_generation.prediction_plan, [](const auto& entry) {
            return entry.cache_key.stable_identity.find("image-prediction-detached-stage.png") !=
                   std::string::npos;
        });
    const auto detached_deep_plan =
        std::ranges::find_if(detached_generation.prediction_plan, [](const auto& entry) {
            return entry.cache_key.stable_identity.find("image-prediction-detached-deep.png") !=
                   std::string::npos;
        });
    const auto detached_caller_plan =
        std::ranges::find_if(detached_generation.prediction_plan, [](const auto& entry) {
            return entry.cache_key.stable_identity.find("image-prediction-caller-after.png") !=
                   std::string::npos;
        });
    REQUIRE(detached_current_plan != detached_generation.prediction_plan.end());
    REQUIRE(detached_deep_plan != detached_generation.prediction_plan.end());
    REQUIRE(detached_caller_plan != detached_generation.prediction_plan.end());
    CHECK(detached_current_plan->prediction == core::PrefetchPredictionKind::ExpectedNext);
    CHECK(detached_deep_plan->prediction == core::PrefetchPredictionKind::PossibleNext);
    CHECK(detached_deep_plan->execution_distance >= detached_current_plan->execution_distance + 2);
    CHECK(detached_caller_plan->prediction == core::PrefetchPredictionKind::PossibleNext);
    CHECK(detached_caller_plan->execution_distance >=
          detached_current_plan->execution_distance + 3);
    CHECK(std::ranges::any_of(detached_caller_plan->provenance, [](const auto& provenance) {
        return provenance.root == core::AssetProfilerPredictionRoot::DetachedFlowExecution;
    }));
#endif

    // Publishing the same detached semantic frontier again is a no-op; its runtime bookkeeping
    // does not create a second speculative generation.
    CHECK(gate.update_active_scene_prediction_on_owner(&foreground, context).empty());
    CHECK(gate.active_prefetch_generation_on_owner() == with_detached);

    context.detached_scenes.clear();
    context.detached_suspended_scenes.clear();
    CHECK(gate.update_active_scene_prediction_on_owner(&foreground, context).empty());
    REQUIRE(gate.active_prefetch_generation_on_owner());
    CHECK(gate.active_prefetch_generation_on_owner() != with_detached);

    gate.clear_package_on_owner();
}

TEST_CASE("mandatory gate consumes context-only active Room transition prediction",
          "[assets][flow-prediction][mandatory-assets][structured-prefetch][active][room-lifecycle]")
{
    PlannerFixture fixture;
    auto document = read_compiled_project_golden("scene-program");
    for (auto& system_layout : document["settings"]["systemLayouts"])
        system_layout["layout"] = nullptr;
    for (auto& slice : document["flowPrediction"]["slices"]) {
        const auto& point = slice["point"];
        if (point.value("kind", "") == "scene-entry" &&
            point["scene"].value("id", "") == "opening") {
            slice["dependencyGroups"] = nlohmann::json::array();
            slice["control"]["successor"] = nullptr;
        } else if (point.value("kind", "") == "room-lifecycle" &&
                   point["room"].value("id", "") == "tower" &&
                   point.value("stage", "") == "after-enter") {
            slice["program"] = nlohmann::json::array(
                {{{"commandId", "active-dialogue"},
                  {"kind", "call-dialogue"},
                  {"dialogue", {{"kind", "dialogue"}, {"id", "arrival"}}}}});
        }
    }

    auto package = package_from_document(std::move(document), "active-room-gate.json");
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

    runtime::FlowPredictionContext context;
    context.active_room_transition = runtime::ActiveRoomTransitionPredictionRoot{
        .source_room = id<core::RoomId>("hall"),
        .target_room = id<core::RoomId>("tower"),
        .source_exit = id<core::RoomExitId>("east-exit"),
        .stage = core::RoomTransitionStage::AfterEnter,
        .command_id = id<core::InteractionInstructionId>("active-dialogue")};
    CHECK(gate.update_active_scene_prediction_on_owner(nullptr, context).empty());
    CHECK(std::ranges::find(fixture.recorder.calls,
                            "texture:project:/assets/images/arrival-dialogue.png") !=
          fixture.recorder.calls.end());
    const auto active_generation = gate.active_prefetch_generation_on_owner();
    REQUIRE(active_generation);

    CHECK(gate.update_active_scene_prediction_on_owner(nullptr, context).empty());
    CHECK(gate.active_prefetch_generation_on_owner() == active_generation);

    gate.clear_package_on_owner();
}

TEST_CASE("mandatory gate keeps suspended Room continuation below foreground Flow and refreshes its cursor",
          "[assets][flow-prediction][mandatory-assets][structured-prefetch][suspended][room-lifecycle]")
{
    PrefetchGenerationCaptureSink sink;
    PlannerFixture fixture(&sink);
    auto document = read_compiled_project_golden("scene-program");
    for (auto& system_layout : document["settings"]["systemLayouts"])
        system_layout["layout"] = nullptr;
    for (auto& slice : document["flowPrediction"]["slices"]) {
        const auto& point = slice["point"];
        if (point.value("kind", "") == "scene-step" &&
            point["scene"].value("id", "") == "opening" &&
            point.value("stepId", "") == "background") {
            slice["control"]["successor"] = nullptr;
        } else if (point.value("kind", "") == "room-lifecycle" &&
                   point["room"].value("id", "") == "tower" &&
                   point.value("stage", "") == "after-enter") {
            slice["program"] = nlohmann::json::array(
                {{{"commandId", "suspended-dialogue"},
                  {"kind", "call-dialogue"},
                  {"dialogue", {{"kind", "dialogue"}, {"id", "arrival"}}}}});
        }
    }

    auto package = package_from_document(std::move(document), "suspended-room-gate.json");
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

    runtime::ActiveScenePredictionRoot foreground{
        .scene = id<core::SceneId>("opening"),
        .position = core::SceneFramePosition{id<core::SceneStepId>("background"),
                                             core::SceneStepReady{}, true}};
    runtime::FlowPredictionContext context;
    context.suspended_room_transitions.push_back(runtime::ActiveRoomTransitionPredictionRoot{
        .source_room = id<core::RoomId>("hall"),
        .target_room = id<core::RoomId>("tower"),
        .source_exit = id<core::RoomExitId>("east-exit"),
        .stage = core::RoomTransitionStage::AfterEnter,
        .command_id = id<core::InteractionInstructionId>("suspended-dialogue")});
    const auto suspended_projection = runtime::FlowPredictor(package.project())
                                          .predict(context.suspended_room_transitions.front());
    REQUIRE(std::ranges::any_of(suspended_projection.entries, [](const auto& entry) {
        const auto* dependency =
            std::get_if<core::compiled::FlowPredictionAssetDependency>(&entry.dependency);
        return dependency != nullptr &&
               dependency->asset == id<core::AssetId>("image-arrival-dialogue");
    }));
    CHECK(gate.update_active_scene_prediction_on_owner(&foreground, context).empty());
#if NOVELTEA_ENABLE_EDITOR_ASSET_PROFILER
    REQUIRE_FALSE(sink.generations.empty());

    const auto foreground_key = assets::make_texture_cache_key(
        assets::TextureAssetRequest{.path = "project:/assets/images/main.png",
                                    .sampler = MaterialTextureSampler::ClampLinear},
        generation);
    const auto suspended_key = assets::make_texture_cache_key(
        assets::TextureAssetRequest{.path = "project:/assets/images/arrival-dialogue.png",
                                    .sampler = MaterialTextureSampler::ClampLinear},
        generation);
    const auto& with_suspended = sink.generations.back();
    const auto foreground_entry =
        std::ranges::find_if(with_suspended.prediction_plan,
                             [&](const auto& entry) { return entry.cache_key == foreground_key; });
    const auto suspended_entry =
        std::ranges::find_if(with_suspended.prediction_plan,
                             [&](const auto& entry) { return entry.cache_key == suspended_key; });
    REQUIRE(foreground_entry != with_suspended.prediction_plan.end());
    REQUIRE(suspended_entry != with_suspended.prediction_plan.end());
    CHECK(foreground_entry->prediction == core::PrefetchPredictionKind::ExpectedNext);
    CHECK(suspended_entry->prediction == core::PrefetchPredictionKind::PossibleNext);
    const auto first_generation = with_suspended.generation;

    context.suspended_room_transitions.front().command_id.reset();
    CHECK(gate.update_active_scene_prediction_on_owner(&foreground, context).empty());
    REQUIRE(gate.active_prefetch_generation_on_owner());
    CHECK(*gate.active_prefetch_generation_on_owner() != first_generation);
    REQUIRE(sink.generations.size() >= 2);
    CHECK(std::ranges::none_of(sink.generations.back().prediction_plan, [&](const auto& entry) {
        return entry.cache_key == suspended_key;
    }));
#else
    const auto first_generation = gate.active_prefetch_generation_on_owner();
    REQUIRE(first_generation);
    context.suspended_room_transitions.front().command_id.reset();
    CHECK(gate.update_active_scene_prediction_on_owner(&foreground, context).empty());
    REQUIRE(gate.active_prefetch_generation_on_owner());
    CHECK(gate.active_prefetch_generation_on_owner() != first_generation);
#endif

    gate.clear_package_on_owner();
}

TEST_CASE("mandatory gate refreshes the same live prediction root when typed state changes",
          "[assets][flow-prediction][mandatory-assets][structured-prefetch][context]")
{
    PlannerFixture fixture;
    auto document = scene_prediction_test_document();
    for (auto& system_layout : document["settings"]["systemLayouts"])
        system_layout["layout"] = nullptr;
    for (auto& scene : document["definitions"]["scenes"]) {
        if (scene["id"] == "prediction-decision") {
            scene["terminal"] = {{"kind", "continue-scene"},
                                 {"scene", {{"kind", "scene"}, {"id", "closing"}}},
                                 {"inputs", nlohmann::json::array()}};
            break;
        }
    }
    document["entrypoint"] = {{"kind", "scene"},
                              {"scene", {{"kind", "scene"}, {"id", "prediction-decision"}}}};
    for (auto& slice : document["flowPrediction"]["slices"]) {
        if (slice["point"]["kind"] == "scene-entry" &&
            slice["point"]["scene"]["id"] == "prediction-decision") {
            slice["control"]["successor"] = nullptr;
            break;
        }
    }

    auto package = package_from_document(std::move(document), "prediction-context-gate.json");
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

    runtime::ActiveScenePredictionRoot root{
        .scene = id<core::SceneId>("prediction-decision"),
        .position = core::SceneFramePosition{id<core::SceneStepId>("decision-branch"),
                                             core::SceneStepReady{}, true}};
    runtime::FlowPredictionContext selected_context{
        .global_properties = {
            {id<core::PropertyId>("count"), core::RuntimeValue{std::int64_t{3}}}}};
    CHECK(gate.update_active_scene_prediction_on_owner(&root, selected_context).empty());
    const auto selected_generation = gate.active_prefetch_generation_on_owner();
    REQUIRE(selected_generation);
    CHECK(std::ranges::find(
              fixture.recorder.calls,
              "texture:project:/assets/images/image-prediction-branch-expected.png") !=
          fixture.recorder.calls.end());
    CHECK(std::ranges::find(
              fixture.recorder.calls,
              "texture:project:/assets/images/image-prediction-branch-alternative.png") ==
          fixture.recorder.calls.end());

    runtime::FlowPredictionContext unrelated_context = selected_context;
    unrelated_context.global_properties.push_back(
        {id<core::PropertyId>("unrelated"), core::RuntimeValue{true}});
    CHECK(gate.update_active_scene_prediction_on_owner(&root, unrelated_context).empty());
    CHECK(gate.active_prefetch_generation_on_owner() == selected_generation);

    runtime::FlowPredictionContext widened_context{
        .global_properties = {
            {id<core::PropertyId>("count"), core::RuntimeValue{std::int64_t{0}}}}};
    CHECK(gate.update_active_scene_prediction_on_owner(&root, widened_context).empty());
    REQUIRE(gate.active_prefetch_generation_on_owner());
    CHECK(*gate.active_prefetch_generation_on_owner() != *selected_generation);
    CHECK(std::ranges::find(
              fixture.recorder.calls,
              "texture:project:/assets/images/image-prediction-branch-alternative.png") !=
          fixture.recorder.calls.end());

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

    const auto* current_room = package.project().find_room(id<core::RoomId>("start"));
    REQUIRE(current_room);
    REQUIRE_FALSE(current_room->exits.empty());
    runtime::FlowPredictionContext prediction_context{
        .prospective_room_entries = {runtime::ProspectiveRoomEntryPredictionRoot{
            .source_room = id<core::RoomId>("start"),
            .target_room = current_room->exits.front().target}}};
    CHECK(gate.update_active_scene_prediction_on_owner(nullptr, prediction_context).empty());

    REQUIRE_FALSE(sink.generations.empty());
    const auto& record = sink.generations.back();
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
    REQUIRE_FALSE(sink.released.empty());
    CHECK(sink.released.back() == record.generation);
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

TEST_CASE("prefetch planner dispatches ranked Flow candidates deterministically",
          "[assets][structured-prefetch][flow-prediction]")
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

    assets::PrefetchPlan plan;
    const auto add = [&](const assets::StructuredAssetRequestDescriptor& descriptor,
                         assets::PrefetchPredictionKind prediction, std::size_t order) {
        plan.candidates.push_back(
            {.descriptor = descriptor, .prediction = prediction, .execution_order = order});
    };
    add(font, assets::PrefetchPredictionKind::ExpectedNext, 0);
    add(texture, assets::PrefetchPredictionKind::ExpectedNext, 1);
    add(texture, assets::PrefetchPredictionKind::ExpectedNext, 1);
    add(shader, assets::PrefetchPredictionKind::ExpectedNext, 2);
    add(material, assets::PrefetchPredictionKind::PossibleNext, 3);
    add(font, assets::PrefetchPredictionKind::PossibleNext, 4);
    add(audio, assets::PrefetchPredictionKind::PossibleNext, 5);
    auto submitted = planner.replace_generation_on_owner(plan);
    REQUIRE(submitted);
    CHECK(submitted.value().expected_submitted == 3);
    CHECK(submitted.value().possible_submitted == 2);
    CHECK(submitted.value().failures.empty());
    CHECK(planner.retained_ticket_count_on_owner() == 5);
    CHECK(fixture.recorder.calls ==
          std::vector<std::string>{"font:body", "texture:project:/textures/direct.png",
                                   "shader:direct-material", "audio:project:/audio/adjacent.ogg",
                                   "material:adjacent-material"});
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
    CHECK(submitted.value().expected_submitted >= 1);
    CHECK(submitted.value().possible_submitted >= 1);
    CHECK(submitted.value().failures.empty());
    CHECK(std::ranges::find(fixture.recorder.calls, "texture:project:/assets/images/main.png") !=
          fixture.recorder.calls.end());
    std::vector<std::string> main_texture_keys;
    for (const auto& candidate : plan.candidates) {
        const auto* texture = std::get_if<assets::TextureAssetRequest>(&candidate.descriptor.request);
        if (texture != nullptr && texture->path == "project:/assets/images/main.png")
            main_texture_keys.push_back(candidate.descriptor.cache_key.stable_identity);
    }
    CHECK(std::set(main_texture_keys.begin(), main_texture_keys.end()).size() ==
          main_texture_keys.size());
    CHECK(std::ranges::count(fixture.recorder.calls,
                             "texture:project:/assets/images/main.png") ==
          main_texture_keys.size());
    fixture.run_until_idle();
    planner.clear_on_owner();
}

TEST_CASE(
    "supplemental prefetch hints enter ordinary Flow prediction and preserve authored provenance",
    "[assets][structured-prefetch][flow-prediction][prefetch-hint]")
{
    PlannerFixture fixture;
    auto document = read_compiled_project_golden("scene-program");
    document["flowPrediction"]["supplementalHints"] = nlohmann::json::array(
        {{{"id", "opening-image"},
          {"target", {{"kind", "asset"}, {"asset", {{"kind", "asset"}, {"id", "image-main"}}}}},
          {"attachment", {{"kind", "point"}, {"slice", 3}}}},
         {{"id", "opening-closing-scene"},
          {"target", {{"kind", "scene"}, {"scene", {{"kind", "scene"}, {"id", "closing"}}}}},
          {"attachment", {{"kind", "point"}, {"slice", 3}}}}});
    auto package = package_from_document(document, "scene-program-with-hints.json");

    runtime::FlowPredictor predictor(package.project());
    const auto projection =
        predictor.predict(core::compiled::Entrypoint{id<core::SceneId>("opening")});
    REQUIRE(projection.diagnostics.empty());

    const auto direct = std::ranges::find_if(projection.entries, [](const auto& entry) {
        const auto* dependency =
            std::get_if<core::compiled::FlowPredictionAssetDependency>(&entry.dependency);
        return dependency != nullptr && dependency->asset == id<core::AssetId>("image-main") &&
               entry.provenance.supplemental_hint_id == "opening-image";
    });
    REQUIRE(direct != projection.entries.end());
    CHECK(direct->execution_distance == 0);
    CHECK(direct->confidence == runtime::FlowPredictionConfidence::Expected);

    const auto semantic = std::ranges::find_if(projection.entries, [](const auto& entry) {
        const auto* dependency =
            std::get_if<core::compiled::FlowPredictionAssetDependency>(&entry.dependency);
        return dependency != nullptr && dependency->asset == id<core::AssetId>("image-main") &&
               entry.provenance.supplemental_hint_id == "opening-closing-scene";
    });
    REQUIRE(semantic != projection.entries.end());
    CHECK(semantic->execution_distance == 0);
    CHECK_FALSE(semantic->provenance.points.empty());

    const auto dependency_index = assets::StructuredAssetDependencyIndex::build(
        package, "glsl-120", fixture.manager.source_generation_on_owner());
    const auto plan = assets::resolve_flow_prediction(dependency_index, projection);
    REQUIRE(plan.diagnostics.empty());
    const auto merged = std::ranges::find_if(plan.candidates, [](const auto& candidate) {
        const auto* texture =
            std::get_if<assets::TextureAssetRequest>(&candidate.descriptor.request);
        return texture != nullptr && texture->path == "project:/assets/images/main.png";
    });
    REQUIRE(merged != plan.candidates.end());
    CHECK(std::ranges::any_of(merged->provenance, [](const auto& path) {
        return path.supplemental_hint_id == "opening-image";
    }));
    CHECK(std::ranges::any_of(merged->provenance,
                              [](const auto& path) { return !path.supplemental_hint_id; }));
}

TEST_CASE("explicit Asset hints remain speculative and obey Warm admission",
          "[assets][structured-prefetch][flow-prediction][prefetch-hint][budget]")
{
    auto budget = generous_budget();
    budget.prepared_cpu_bytes = 0;
    budget.gpu_bytes = 0;
    budget.audio_bytes = 0;
    PlannerFixture fixture(nullptr, budget);

    auto document = read_compiled_project_golden("scene-program");
    auto& prediction = document["flowPrediction"];
    std::size_t opening_entry = 0;
    for (std::size_t index = 0; index < prediction["slices"].size(); ++index) {
        const auto& point = prediction["slices"][index]["point"];
        if (point.value("kind", "") == "scene-entry" &&
            point["scene"].value("id", "") == "opening") {
            opening_entry = index;
            break;
        }
    }
    prediction["supplementalHints"] = nlohmann::json::array(
        {{{"id", "budgeted-explicit-image"},
          {"target", {{"kind", "asset"}, {"asset", {{"kind", "asset"}, {"id", "image-main"}}}}},
          {"attachment", {{"kind", "point"}, {"slice", opening_entry}}}},
         {{"id", "budgeted-explicit-audio"},
          {"target", {{"kind", "asset"}, {"asset", {{"kind", "asset"}, {"id", "audio-voice"}}}}},
          {"attachment", {{"kind", "point"}, {"slice", opening_entry}}}}});
    auto package = package_from_document(std::move(document), "explicit-hint-warm-budget.json");

    const auto projection = runtime::FlowPredictor(package.project())
                                .predict(core::compiled::Entrypoint{id<core::SceneId>("opening")});
    const auto hinted = std::ranges::find_if(projection.entries, [](const auto& entry) {
        return entry.provenance.supplemental_hint_id == "budgeted-explicit-image";
    });
    REQUIRE(hinted != projection.entries.end());

    const auto dependency_index = assets::StructuredAssetDependencyIndex::build(
        package, "glsl-120", fixture.manager.source_generation_on_owner());
    const auto plan = assets::resolve_flow_prediction(dependency_index, projection);
    REQUIRE(plan.diagnostics.empty());
    CHECK(std::ranges::any_of(plan.candidates, [](const auto& candidate) {
        const auto* audio = std::get_if<assets::AudioAssetRequest>(&candidate.descriptor.request);
        return audio != nullptr && audio->path == "project:/assets/audio/voice.ogg" &&
               audio->mode == AudioLoadMode::Auto && audio->kind == AudioClipKind::Auto;
    }));
    assets::PrefetchPlanner planner(fixture.manager);
    const auto report = planner.replace_generation_on_owner(plan);
    REQUIRE(report);
    CHECK(report.value().submitted_entries.empty());
    CHECK_FALSE(report.value().admission_rejections.empty());
    CHECK(fixture.recorder.calls.empty());

    PlannerFixture admitted_fixture;
    const auto admitted_index = assets::StructuredAssetDependencyIndex::build(
        package, "glsl-120", admitted_fixture.manager.source_generation_on_owner());
    const auto admitted_plan = assets::resolve_flow_prediction(admitted_index, projection);
    assets::PrefetchPlanner admitted_planner(admitted_fixture.manager);
    const auto admitted_report = admitted_planner.replace_generation_on_owner(admitted_plan);
    REQUIRE(admitted_report);
    CHECK(std::ranges::find(admitted_fixture.recorder.calls,
                            "audio:project:/assets/audio/voice.ogg") !=
          admitted_fixture.recorder.calls.end());
}

TEST_CASE("semantic Scene hints enter ordinary prediction horizons instead of eager closure",
          "[assets][structured-prefetch][flow-prediction][prefetch-hint][scene][horizon]")
{
    auto document = scene_prediction_test_document();
    document["flowPrediction"]["supplementalHints"] = nlohmann::json::array(
        {{{"id", "decision-prefetch-horizon"},
          {"target",
           {{"kind", "scene"}, {"scene", {{"kind", "scene"}, {"id", "prediction-horizon"}}}}},
          {"attachment", {{"kind", "point"}, {"slice", 16}}}}});
    auto package = package_from_document(std::move(document), "scene-hint-horizon.json");
    runtime::FlowPredictor predictor(package.project());
    const auto projection = predictor.predict(
        core::compiled::Entrypoint{id<core::SceneId>("prediction-decision")},
        runtime::FlowPredictionContext{
            .global_properties = {
                {id<core::PropertyId>("count"), core::RuntimeValue{std::int64_t{3}}},
                {id<core::PropertyId>("flag"), core::RuntimeValue{true}},
            }});
    REQUIRE(projection.diagnostics.empty());

    const auto find_hinted = [&](std::string_view asset) {
        return std::ranges::find_if(projection.entries, [&](const auto& entry) {
            const auto* dependency =
                std::get_if<core::compiled::FlowPredictionAssetDependency>(&entry.dependency);
            return dependency != nullptr &&
                   dependency->asset == id<core::AssetId>(std::string(asset)) &&
                   entry.provenance.supplemental_hint_id == "decision-prefetch-horizon";
        });
    };
    const auto near = find_hinted("image-prediction-parent-stage");
    const auto after_short = find_hinted("image-prediction-after-short");
    const auto after_strong = find_hinted("image-prediction-after-strong");
    REQUIRE(near != projection.entries.end());
    REQUIRE(after_short != projection.entries.end());
    REQUIRE(after_strong != projection.entries.end());
    CHECK(near->confidence == runtime::FlowPredictionConfidence::Expected);
    CHECK(after_short->confidence == runtime::FlowPredictionConfidence::Expected);
    CHECK(after_strong->confidence == runtime::FlowPredictionConfidence::Alternative);
    CHECK(near->execution_distance < after_short->execution_distance);
    CHECK(after_short->execution_distance < after_strong->execution_distance);
}

TEST_CASE("semantic Room hints compose Current Room lifecycle and entry-path hints",
          "[assets][structured-prefetch][flow-prediction][prefetch-hint][room][current-room]")
{
    auto document = read_compiled_project_golden("scene-program");
    auto& prediction = document["flowPrediction"];
    const auto source_group = prediction["dependencyGroups"].size();
    prediction["dependencyGroups"].push_back(nlohmann::json::array(
        {{{"kind", "asset"},
          {"asset", {{"kind", "asset"}, {"id", "image-arrival-dialogue"}}}}}));
    std::optional<std::size_t> opening_entry;
    for (std::size_t index = 0; index < prediction["slices"].size(); ++index) {
        auto& slice = prediction["slices"][index];
        const auto& point = slice["point"];
        if (point.value("kind", "") == "scene-entry" &&
            point["scene"].value("id", "") == "opening")
            opening_entry = index;
        if (point.value("kind", "") == "room-lifecycle" &&
            point["room"].value("id", "") == "hall" &&
            point.value("stage", "") == "before-leave") {
            slice["dependencyGroups"] = nlohmann::json::array({source_group});
        }
    }
    REQUIRE(opening_entry);
    prediction["supplementalHints"] = nlohmann::json::array(
        {{{"id", "decision-enter-tower"},
          {"target", {{"kind", "room"}, {"room", {{"kind", "room"}, {"id", "tower"}}}}},
          {"attachment", {{"kind", "point"}, {"slice", *opening_entry}}}},
         {{"id", "tower-entry-extra"},
          {"target",
           {{"kind", "asset"},
            {"asset", {{"kind", "asset"}, {"id", "image-main"}}}}},
          {"attachment",
           {{"kind", "room"},
            {"room", {{"kind", "room"}, {"id", "tower"}}},
            {"scope", "entry-path"}}}}});
    auto package = package_from_document(std::move(document), "room-hint-current-room.json");
    runtime::FlowPredictor predictor(package.project());
    const auto projection = predictor.predict(
        core::compiled::Entrypoint{id<core::SceneId>("opening")},
        runtime::FlowPredictionContext{
            .current_room = id<core::RoomId>("hall"),
            .global_properties = {{id<core::PropertyId>("flag"), core::RuntimeValue{true}}}});
    REQUIRE(projection.diagnostics.empty());

    const auto source_lifecycle = std::ranges::find_if(projection.entries, [](const auto& entry) {
        const auto* dependency =
            std::get_if<core::compiled::FlowPredictionAssetDependency>(&entry.dependency);
        return dependency != nullptr &&
               dependency->asset == id<core::AssetId>("image-arrival-dialogue") &&
               entry.provenance.supplemental_hint_id == "decision-enter-tower";
    });
    REQUIRE(source_lifecycle != projection.entries.end());
    CHECK(std::ranges::any_of(source_lifecycle->provenance.points, [](const auto& point) {
        const auto* lifecycle =
            std::get_if<core::compiled::RoomLifecyclePredictionPoint>(&point);
        return lifecycle != nullptr && lifecycle->room == id<core::RoomId>("hall") &&
               lifecycle->stage == core::compiled::RoomLifecyclePredictionStage::BeforeLeave;
    }));

    const auto broad_entry = std::ranges::find_if(projection.entries, [](const auto& entry) {
        const auto* dependency =
            std::get_if<core::compiled::FlowPredictionAssetDependency>(&entry.dependency);
        return dependency != nullptr &&
               dependency->asset == id<core::AssetId>("image-main") &&
               entry.provenance.supplemental_hint_id == "tower-entry-extra";
    });
    REQUIRE(broad_entry != projection.entries.end());
    CHECK(broad_entry->confidence == runtime::FlowPredictionConfidence::Expected);
}

TEST_CASE("prospective after-enter opacity can be covered by a semantic Scene hint",
          "[assets][structured-prefetch][flow-prediction][prefetch-hint][room][opaque]")
{
    auto document = read_compiled_project_golden("scene-program");
    auto& prediction = document["flowPrediction"];
    std::optional<std::size_t> after_enter;
    for (std::size_t index = 0; index < prediction["slices"].size(); ++index) {
        auto& slice = prediction["slices"][index];
        const auto& point = slice["point"];
        if (point.value("kind", "") != "room-lifecycle" ||
            point["room"].value("id", "") != "tower" ||
            point.value("stage", "") != "after-enter")
            continue;
        after_enter = index;
        slice["program"] = nlohmann::json::array({{{"kind", "opaque"}}});
        break;
    }
    REQUIRE(after_enter);
    prediction["supplementalHints"] = nlohmann::json::array(
        {{{"id", "tower-after-enter-closing"},
          {"target", {{"kind", "scene"}, {"scene", {{"kind", "scene"}, {"id", "closing"}}}}},
          {"attachment", {{"kind", "point"}, {"slice", *after_enter}}}}});
    auto package = package_from_document(std::move(document), "room-after-enter-opaque-hint.json");

    const auto projection = runtime::FlowPredictor(package.project()).predict(
        runtime::ProspectiveRoomEntryPredictionRoot{
            .source_room = id<core::RoomId>("hall"), .target_room = id<core::RoomId>("tower")});
    CHECK(std::ranges::any_of(projection.opaque_frontiers, [](const auto& frontier) {
        const auto* point =
            std::get_if<core::compiled::RoomLifecyclePredictionPoint>(&frontier.attachment_point);
        return point != nullptr && point->room == id<core::RoomId>("tower") &&
               point->stage == core::compiled::RoomLifecyclePredictionStage::AfterEnter;
    }));
    const auto hinted = std::ranges::find_if(projection.entries, [](const auto& entry) {
        return entry.provenance.supplemental_hint_id == "tower-after-enter-closing";
    });
    REQUIRE(hinted != projection.entries.end());
    CHECK(std::ranges::any_of(hinted->provenance.points, [](const auto& point) {
        const auto* lifecycle = std::get_if<core::compiled::RoomLifecyclePredictionPoint>(&point);
        return lifecycle != nullptr && lifecycle->room == id<core::RoomId>("tower") &&
               lifecycle->stage == core::compiled::RoomLifecyclePredictionStage::AfterEnter;
    }));
}

TEST_CASE("broad Room supplemental hints honor entry and resident scopes",
          "[assets][structured-prefetch][flow-prediction][prefetch-hint][room]")
{
    auto document = read_compiled_project_golden("scene-program");
    document["flowPrediction"]["supplementalHints"] = nlohmann::json::array(
        {{{"id", "tower-entry-image"},
          {"target", {{"kind", "asset"}, {"asset", {{"kind", "asset"}, {"id", "image-main"}}}}},
          {"attachment",
           {{"kind", "room"},
            {"room", {{"kind", "room"}, {"id", "tower"}}},
            {"scope", "entry-path"}}}},
         {{"id", "tower-resident-image"},
          {"target", {{"kind", "asset"}, {"asset", {{"kind", "asset"}, {"id", "image-main"}}}}},
          {"attachment",
           {{"kind", "room"},
            {"room", {{"kind", "room"}, {"id", "tower"}}},
            {"scope", "resident"}}}}});
    auto package = package_from_document(document, "scene-program-with-room-hints.json");
    runtime::FlowPredictor predictor(package.project());

    const auto entry = predictor.predict(runtime::ProspectiveRoomEntryPredictionRoot{
        .source_room = id<core::RoomId>("hall"), .target_room = id<core::RoomId>("tower")});
    CHECK(std::ranges::any_of(entry.entries, [](const auto& item) {
        return item.provenance.supplemental_hint_id == "tower-entry-image";
    }));
    CHECK_FALSE(std::ranges::any_of(entry.entries, [](const auto& item) {
        return item.provenance.supplemental_hint_id == "tower-resident-image";
    }));

    const runtime::ResidentRoomPredictionRoot resident{.room = id<core::RoomId>("tower")};
    const auto current = predictor.predict(resident);
    CHECK(std::ranges::any_of(current.entries, [](const auto& item) {
        return item.provenance.supplemental_hint_id == "tower-resident-image";
    }));
    CHECK_FALSE(std::ranges::any_of(current.entries, [](const auto& item) {
        return item.provenance.supplemental_hint_id == "tower-entry-image";
    }));
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
    CHECK(submitted.value().possible_submitted >= 1);
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

TEST_CASE("active Room transition prediction resumes the exact lifecycle command cursor",
          "[assets][structured-prefetch][flow-prediction][room-lifecycle][active]")
{
    auto document = read_compiled_project_golden("scene-program");
    for (auto& slice : document["flowPrediction"]["slices"]) {
        const auto& point = slice["point"];
        if (point.value("kind", "") != "room-lifecycle" ||
            point["room"].value("id", "") != "tower" || point.value("stage", "") != "after-enter")
            continue;
        slice["program"] =
            nlohmann::json::array({{{"kind", "call-dialogue"},
                                    {"commandId", "already-consumed-dialogue"},
                                    {"dialogue", {{"kind", "dialogue"}, {"id", "arrival"}}}},
                                   {{"kind", "call-scene"},
                                    {"commandId", "next-scene"},
                                    {"scene", {{"kind", "scene"}, {"id", "closing"}}}}});
        break;
    }
    auto package = package_from_document(std::move(document), "active-room-transition.json");
    runtime::FlowPredictor predictor(package.project());
    const runtime::ActiveRoomTransitionPredictionRoot root{
        .source_room = id<core::RoomId>("hall"),
        .target_room = id<core::RoomId>("tower"),
        .source_exit = id<core::RoomExitId>("north-exit"),
        .stage = core::RoomTransitionStage::AfterEnter,
        .command_id = id<core::InteractionInstructionId>("next-scene")};

    const auto projection = predictor.predict(
        root, runtime::FlowPredictionContext{.current_room = id<core::RoomId>("tower")});
    REQUIRE(projection.diagnostics.empty());
    CHECK(std::ranges::any_of(projection.entries, [](const auto& entry) {
        const auto* dependency =
            std::get_if<core::compiled::FlowPredictionAssetDependency>(&entry.dependency);
        return dependency != nullptr && dependency->asset == id<core::AssetId>("image-main") &&
               entry.confidence == runtime::FlowPredictionConfidence::Expected;
    }));
    CHECK_FALSE(std::ranges::any_of(projection.entries, [](const auto& entry) {
        const auto* dependency =
            std::get_if<core::compiled::FlowPredictionAssetDependency>(&entry.dependency);
        return dependency != nullptr &&
               dependency->asset == id<core::AssetId>("image-arrival-dialogue");
    }));

    auto completed = root;
    completed.command_id.reset();
    const auto completed_projection = predictor.predict(
        completed, runtime::FlowPredictionContext{.current_room = id<core::RoomId>("tower")});
    CHECK(completed_projection.entries.empty());
}

TEST_CASE("committed Room transition wait retains authoritative typed facts for post-commit Flow",
          "[assets][structured-prefetch][flow-prediction][room-lifecycle][condition][active]")
{
    auto document = read_compiled_project_golden("scene-program");
    const auto trait_condition = nlohmann::json{
        {"kind", "trait-presence"},
        {"owner",
         {{"kind", "interactable"},
          {"interactable", {{"kind", "interactable"}, {"id", "wallet"}}}}},
        {"trait", {{"kind", "trait"}, {"id", "currency"}}},
        {"present", true}};
    for (auto& slice : document["flowPrediction"]["slices"]) {
        const auto& point = slice["point"];
        if (point.value("kind", "") != "room-lifecycle" ||
            point["room"].value("id", "") != "tower" ||
            point.value("stage", "") != "after-enter")
            continue;
        slice["program"] = nlohmann::json::array(
            {{{"commandId", "post-commit-branch"},
              {"kind", "if"},
              {"condition", trait_condition},
              {"thenCommands",
               nlohmann::json::array(
                   {{{"commandId", "post-commit-dialogue"},
                     {"kind", "call-dialogue"},
                     {"dialogue", {{"kind", "dialogue"}, {"id", "arrival"}}}}})},
              {"elseCommands",
               nlohmann::json::array(
                   {{{"commandId", "post-commit-scene"},
                     {"kind", "call-scene"},
                     {"scene", {{"kind", "scene"}, {"id", "closing"}}}}})}}});
        break;
    }
    auto package = package_from_document(std::move(document), "active-room-transition-facts.json");
    REQUIRE(package.project().flow_prediction());

    std::optional<core::Condition> condition;
    for (const auto& slice : package.project().flow_prediction()->slices) {
        const auto* point =
            std::get_if<core::compiled::RoomLifecyclePredictionPoint>(&slice.point);
        if (point == nullptr || point->room != id<core::RoomId>("tower") ||
            point->stage != core::compiled::RoomLifecyclePredictionStage::AfterEnter ||
            slice.program.empty())
            continue;
        const auto* branch =
            std::get_if<core::compiled::FlowPredictionIf>(&slice.program.front().value);
        REQUIRE(branch);
        condition = branch->condition;
        break;
    }
    REQUIRE(condition);

    const runtime::ActiveRoomTransitionPredictionRoot root{
        .source_room = std::nullopt,
        .target_room = id<core::RoomId>("tower"),
        .stage = core::RoomTransitionStage::CommitRoomSwitch,
        .awaiting_completion = true,
        .condition_facts = {{*condition, true}}};
    const auto projection = runtime::FlowPredictor(package.project()).predict(root);
    REQUIRE(projection.diagnostics.empty());
    CHECK(std::ranges::any_of(projection.entries, [](const auto& entry) {
        const auto* dependency =
            std::get_if<core::compiled::FlowPredictionAssetDependency>(&entry.dependency);
        return dependency != nullptr &&
               dependency->asset == id<core::AssetId>("image-arrival-dialogue") &&
               entry.confidence == runtime::FlowPredictionConfidence::Alternative;
    }));
    CHECK_FALSE(std::ranges::any_of(projection.entries, [](const auto& entry) {
        const auto* dependency =
            std::get_if<core::compiled::FlowPredictionAssetDependency>(&entry.dependency);
        return dependency != nullptr && dependency->asset == id<core::AssetId>("image-main");
    }));
}

TEST_CASE("prospective Room prediction honors authoritative navigation guards",
          "[assets][structured-prefetch][flow-prediction][room-lifecycle][guard]")
{
    auto package =
        package_from_document(read_compiled_project_golden("scene-program"), "scene-program.json");
    runtime::FlowPredictor predictor(package.project());
    const auto flag_truthy = core::Condition{core::GlobalPropertyComparison{
        core::GlobalPropertyTruthiness{id<core::PropertyId>("flag"),
                                       core::TruthinessOperator::Truthy}}};
    const runtime::ProspectiveRoomEntryPredictionRoot guarded{
        .source_room = id<core::RoomId>("hall"),
        .target_room = id<core::RoomId>("tower"),
        .source_exit = id<core::RoomExitId>("north-exit"),
        .source_can_leave = core::Condition{core::Always{}},
        .exit_condition = flag_truthy,
        .target_can_enter = core::Condition{core::Always{}},
    };

    const auto blocked = predictor.predict(
        guarded, runtime::FlowPredictionContext{.global_properties = {
                     {id<core::PropertyId>("flag"), core::RuntimeValue{false}}}});
    CHECK(blocked.entries.empty());

    auto opaque_root = guarded;
    opaque_root.exit_condition = core::Condition{core::LuaPredicate{"dynamic_exit_open()"}};
    const auto uncertain = predictor.predict(
        opaque_root, runtime::FlowPredictionContext{.global_properties = {
                         {id<core::PropertyId>("flag"), core::RuntimeValue{false}}}});
    const auto room_dependency = std::ranges::find_if(uncertain.entries, [](const auto& entry) {
        const auto* room =
            std::get_if<core::compiled::FlowPredictionRoomDependency>(&entry.dependency);
        return room != nullptr && room->room == id<core::RoomId>("tower");
    });
    REQUIRE(room_dependency != uncertain.entries.end());
    CHECK(room_dependency->confidence == runtime::FlowPredictionConfidence::Alternative);
    REQUIRE(room_dependency->provenance.exit);
    CHECK(*room_dependency->provenance.exit == id<core::RoomExitId>("north-exit"));
    const auto guard_frontier =
        std::ranges::find_if(uncertain.opaque_frontiers, [](const auto& frontier) {
            const auto* point = std::get_if<core::compiled::RoomLifecyclePredictionPoint>(
                &frontier.attachment_point);
            return point != nullptr && point->room == id<core::RoomId>("hall") &&
                   point->stage == core::compiled::RoomLifecyclePredictionStage::BeforeLeave &&
                   frontier.provenance.exit &&
                   *frontier.provenance.exit == id<core::RoomExitId>("north-exit");
        });
    REQUIRE(guard_frontier != uncertain.opaque_frontiers.end());
    const auto* guard_point = std::get_if<core::compiled::RoomLifecyclePredictionPoint>(
        &guard_frontier->attachment_point);
    REQUIRE(guard_point != nullptr);
    CHECK(guard_point->room == id<core::RoomId>("hall"));
    CHECK(guard_point->stage == core::compiled::RoomLifecyclePredictionStage::BeforeLeave);
    REQUIRE(guard_frontier->provenance.exit);
    CHECK(*guard_frontier->provenance.exit == id<core::RoomExitId>("north-exit"));
}

TEST_CASE("Room entrypoint prediction honors the target can-enter guard",
          "[assets][structured-prefetch][flow-prediction][room-lifecycle][entrypoint][guard]")
{
    auto document = read_compiled_project_golden("scene-program");
    for (auto& room : document["definitions"]["rooms"]) {
        if (room["id"] != "start")
            continue;
        room["lifecycle"]["canEnter"] = {
            {"kind", "global-property-comparison"},
            {"property", {{"kind", "property"}, {"id", "flag"}}},
            {"operator", "truthy"},
        };
        break;
    }
    auto package = package_from_document(std::move(document), "room-entrypoint-guard.json");
    runtime::FlowPredictor predictor(package.project());
    const core::compiled::Entrypoint entry{id<core::RoomId>("start")};

    const auto blocked = predictor.predict(
        entry, runtime::FlowPredictionContext{.global_properties = {
                   {id<core::PropertyId>("flag"), core::RuntimeValue{false}}}});
    CHECK(blocked.entries.empty());

    const auto allowed = predictor.predict(
        entry, runtime::FlowPredictionContext{.global_properties = {
                   {id<core::PropertyId>("flag"), core::RuntimeValue{true}}}});
    CHECK(std::ranges::any_of(allowed.entries, [](const auto& entry_item) {
        const auto* room =
            std::get_if<core::compiled::FlowPredictionRoomDependency>(&entry_item.dependency);
        return room != nullptr && room->room == id<core::RoomId>("start");
    }));
}

TEST_CASE("opaque prospective Room guards invalidate projected facts before lifecycle Flow",
          "[assets][structured-prefetch][flow-prediction][room-lifecycle][guard][opaque]")
{
    auto document = read_compiled_project_golden("scene-program");
    const auto player_name_condition =
        nlohmann::json{{"kind", "global-property-comparison"},
                       {"property", {{"kind", "property"}, {"id", "player-name"}}},
                       {"operator", "equal"},
                       {"value", "Ada"}};
    for (auto& slice : document["flowPrediction"]["slices"]) {
        const auto& point = slice["point"];
        if (point.value("kind", "") != "room-lifecycle" ||
            point["room"].value("id", "") != "tower" ||
            point.value("stage", "") != "after-enter")
            continue;
        slice["program"] = nlohmann::json::array(
            {{{"kind", "if"},
              {"condition", player_name_condition},
              {"thenCommands",
               nlohmann::json::array(
                   {{{"kind", "call-dialogue"},
                     {"dialogue", {{"kind", "dialogue"}, {"id", "arrival"}}}}})},
              {"elseCommands",
               nlohmann::json::array(
                   {{{"kind", "call-scene"},
                     {"scene", {{"kind", "scene"}, {"id", "closing"}}}}})}}});
        break;
    }
    auto package = package_from_document(std::move(document), "room-opaque-guard-facts.json");
    runtime::FlowPredictor predictor(package.project());
    const runtime::ProspectiveRoomEntryPredictionRoot root{
        .source_room = id<core::RoomId>("hall"),
        .target_room = id<core::RoomId>("tower"),
        .source_exit = id<core::RoomExitId>("north-exit"),
        .exit_condition = core::Condition{core::LuaPredicate{"dynamic_exit_open()"}},
    };
    const auto projection = predictor.predict(
        root, runtime::FlowPredictionContext{.global_properties = {
                  {id<core::PropertyId>("player-name"), core::RuntimeValue{std::string{"Ada"}}}}});
    REQUIRE(projection.diagnostics.empty());

    const auto has_asset = [&](std::string_view asset) {
        return std::ranges::any_of(projection.entries, [&](const auto& entry) {
            const auto* dependency =
                std::get_if<core::compiled::FlowPredictionAssetDependency>(&entry.dependency);
            return dependency != nullptr && dependency->asset == id<core::AssetId>(std::string(asset)) &&
                   entry.confidence == runtime::FlowPredictionConfidence::Alternative;
        });
    };
    const auto has_asset_at_any_confidence = [&](std::string_view asset) {
        return std::ranges::any_of(projection.entries, [&](const auto& entry) {
            const auto* dependency =
                std::get_if<core::compiled::FlowPredictionAssetDependency>(&entry.dependency);
            return dependency != nullptr && dependency->asset == id<core::AssetId>(std::string(asset));
        });
    };
    CHECK(has_asset("image-arrival-dialogue"));
    CHECK(has_asset_at_any_confidence("image-main"));
    CHECK(std::ranges::find(projection.context_requirements.global_properties,
                            id<core::PropertyId>("player-name")) !=
          projection.context_requirements.global_properties.end());
}

TEST_CASE("opaque compound Conditions invalidate facts even when their final truth is known",
          "[assets][structured-prefetch][flow-prediction][condition][opaque]")
{
    auto document = read_compiled_project_golden("scene-program");
    const auto player_name_condition =
        nlohmann::json{{"kind", "global-property-comparison"},
                       {"property", {{"kind", "property"}, {"id", "player-name"}}},
                       {"operator", "equal"},
                       {"value", "Ada"}};
    const auto opaque_but_true =
        nlohmann::json{{"kind", "any"},
                       {"conditions",
                        nlohmann::json::array(
                            {{{"kind", "lua-predicate"}, {"source", "mutating_probe()"}},
                             {{"kind", "always"}}})}};
    for (auto& slice : document["flowPrediction"]["slices"]) {
        const auto& point = slice["point"];
        if (point.value("kind", "") != "room-lifecycle" ||
            point["room"].value("id", "") != "tower" ||
            point.value("stage", "") != "after-enter")
            continue;
        slice["program"] = nlohmann::json::array(
            {{{"kind", "if"},
              {"condition", opaque_but_true},
              {"thenCommands", nlohmann::json::array()},
              {"elseCommands", nlohmann::json::array()}},
             {{"kind", "if"},
              {"condition", player_name_condition},
              {"thenCommands",
               nlohmann::json::array(
                   {{{"kind", "call-dialogue"},
                     {"dialogue", {{"kind", "dialogue"}, {"id", "arrival"}}}}})},
              {"elseCommands",
               nlohmann::json::array(
                   {{{"kind", "call-scene"},
                     {"scene", {{"kind", "scene"}, {"id", "closing"}}}}})}}});
        break;
    }
    auto package = package_from_document(std::move(document), "opaque-known-condition-facts.json");
    runtime::FlowPredictor predictor(package.project());
    const runtime::ActiveRoomTransitionPredictionRoot root{
        .source_room = id<core::RoomId>("hall"),
        .target_room = id<core::RoomId>("tower"),
        .stage = core::RoomTransitionStage::AfterEnter,
    };
    const auto projection = predictor.predict(
        root, runtime::FlowPredictionContext{.global_properties = {
                  {id<core::PropertyId>("player-name"), core::RuntimeValue{std::string{"Ada"}}}}});
    REQUIRE(projection.diagnostics.empty());
    CHECK_FALSE(projection.opaque_frontiers.empty());
    const auto has_asset = [&](std::string_view asset) {
        return std::ranges::any_of(projection.entries, [&](const auto& entry) {
            const auto* dependency =
                std::get_if<core::compiled::FlowPredictionAssetDependency>(&entry.dependency);
            return dependency != nullptr && dependency->asset == id<core::AssetId>(std::string(asset)) &&
                   entry.confidence == runtime::FlowPredictionConfidence::Alternative;
        });
    };
    CHECK(has_asset("image-arrival-dialogue"));
    CHECK(has_asset("image-main"));
    CHECK(std::ranges::find(projection.context_requirements.global_properties,
                            id<core::PropertyId>("player-name")) !=
          projection.context_requirements.global_properties.end());
}

TEST_CASE("prospective Room commit invalidates source-context typed facts before post-commit Flow",
          "[assets][structured-prefetch][flow-prediction][room-lifecycle][condition]")
{
    auto document = read_compiled_project_golden("scene-program");
    const auto trait_condition = nlohmann::json{
        {"kind", "trait-presence"},
        {"owner",
         {{"kind", "interactable"},
          {"interactable", {{"kind", "interactable"}, {"id", "wallet"}}}}},
        {"trait", {{"kind", "trait"}, {"id", "currency"}}},
        {"present", true}};
    for (auto& slice : document["flowPrediction"]["slices"]) {
        const auto& point = slice["point"];
        if (point.value("kind", "") != "room-lifecycle" ||
            point["room"].value("id", "") != "tower" ||
            point.value("stage", "") != "after-enter")
            continue;
        slice["program"] = nlohmann::json::array(
            {{{"kind", "if"},
              {"condition", trait_condition},
              {"thenCommands",
               nlohmann::json::array(
                   {{{"kind", "call-dialogue"},
                     {"dialogue", {{"kind", "dialogue"}, {"id", "arrival"}}}}})},
              {"elseCommands", nlohmann::json::array()}}});
        break;
    }
    auto package = package_from_document(std::move(document), "room-post-commit-facts.json");
    REQUIRE(package.project().flow_prediction());

    std::optional<core::Condition> condition;
    for (const auto& slice : package.project().flow_prediction()->slices) {
        const auto* point =
            std::get_if<core::compiled::RoomLifecyclePredictionPoint>(&slice.point);
        if (point == nullptr || point->room != id<core::RoomId>("tower") ||
            point->stage != core::compiled::RoomLifecyclePredictionStage::AfterEnter ||
            slice.program.empty())
            continue;
        const auto* conditional =
            std::get_if<core::compiled::FlowPredictionIf>(&slice.program.front().value);
        REQUIRE(conditional);
        condition = conditional->condition;
        break;
    }
    REQUIRE(condition);

    runtime::FlowPredictor predictor(package.project());
    const auto projection = predictor.predict(
        runtime::ProspectiveRoomEntryPredictionRoot{
            .source_room = id<core::RoomId>("hall"), .target_room = id<core::RoomId>("tower")},
        runtime::FlowPredictionContext{.condition_facts = {{*condition, true}}});
    const auto arrival = std::ranges::find_if(projection.entries, [](const auto& entry) {
        const auto* dependency =
            std::get_if<core::compiled::FlowPredictionAssetDependency>(&entry.dependency);
        return dependency != nullptr &&
               dependency->asset == id<core::AssetId>("image-arrival-dialogue");
    });
    REQUIRE(arrival != projection.entries.end());
    CHECK(arrival->confidence == runtime::FlowPredictionConfidence::Alternative);
}

TEST_CASE("typed EnterRoom prediction composes source and target lifecycle from Current Room",
          "[assets][structured-prefetch][flow-prediction][room-lifecycle][current-room]")
{
    auto document = read_compiled_project_golden("scene-program");
    for (auto& slice : document["flowPrediction"]["slices"]) {
        const auto& point = slice["point"];
        if (point.value("kind", "") == "scene-entry" &&
            point["scene"].value("id", "") == "opening") {
            slice["dependencyGroups"] = nlohmann::json::array();
            slice["program"] = nlohmann::json::array(
                {{{"kind", "enter-room"},
                  {"room", {{"kind", "room"}, {"id", "tower"}}}}});
            slice["control"] = {{"kind", "sequential"}, {"successor", nullptr}};
        }
        if (point.value("kind", "") == "room-lifecycle" &&
            point["room"].value("id", "") == "hall" &&
            point.value("stage", "") == "before-leave") {
            slice["program"].push_back(
                {{"kind", "call-scene"},
                 {"scene", {{"kind", "scene"}, {"id", "closing"}}}});
        }
    }

    auto package = package_from_document(std::move(document), "enter-room-current-room.json");
    runtime::FlowPredictor predictor(package.project());
    const auto with_source = predictor.predict(
        core::compiled::Entrypoint{id<core::SceneId>("opening")},
        runtime::FlowPredictionContext{.current_room = id<core::RoomId>("hall")});
    REQUIRE(with_source.diagnostics.empty());

    const auto has_source_before_leave = [](const auto& projection) {
        return std::ranges::any_of(projection.entries, [](const auto& entry) {
            const auto* dependency =
                std::get_if<core::compiled::FlowPredictionAssetDependency>(&entry.dependency);
            if (dependency == nullptr || dependency->asset != id<core::AssetId>("image-main"))
                return false;
            return std::ranges::any_of(entry.provenance.points, [](const auto& point) {
                const auto* lifecycle =
                    std::get_if<core::compiled::RoomLifecyclePredictionPoint>(&point);
                return lifecycle != nullptr && lifecycle->room == id<core::RoomId>("hall") &&
                       lifecycle->stage ==
                           core::compiled::RoomLifecyclePredictionStage::BeforeLeave;
            });
        });
    };
    CHECK(has_source_before_leave(with_source));

    const auto without_source =
        predictor.predict(core::compiled::Entrypoint{id<core::SceneId>("opening")});
    REQUIRE(without_source.diagnostics.empty());
    CHECK_FALSE(has_source_before_leave(without_source));
}

TEST_CASE(
    "projected typed locations survive Room commit and resolve current-room conditions",
    "[assets][structured-prefetch][flow-prediction][room-lifecycle][current-room][projection]")
{
    auto document = read_compiled_project_golden("scene-program");
    for (auto& slice : document["flowPrediction"]["slices"]) {
        const auto& point = slice["point"];
        if (point.value("kind", "") != "room-lifecycle" ||
            point["room"].value("id", "") != "tower" || point.value("stage", "") != "after-enter")
            continue;
        // This regression isolates Room-commit projection. The shared golden also exercises an
        // opaque Lua predicate in tower.after_enter; that opacity is allowed to mutate arbitrary
        // gameplay state and therefore correctly invalidates the projected facts asserted here.
        auto& program = slice["program"];
        for (auto command = program.begin(); command != program.end();) {
            if (command->value("kind", "") == "if" && command->contains("condition") &&
                (*command)["condition"].value("kind", "") == "lua-predicate")
                command = program.erase(command);
            else
                ++command;
        }
        break;
    }
    const auto scene_ref = [](std::string_view value) {
        return nlohmann::json{{"kind", "scene"}, {"id", value}};
    };
    const auto room_ref = [](std::string_view value) {
        return nlohmann::json{{"kind", "room"}, {"id", value}};
    };
    for (const auto [scene_id, asset_id] :
         {std::pair{"location-true", "image-location-true"},
          std::pair{"location-false", "image-location-false"}}) {
        auto scene = document["definitions"]["scenes"][0];
        scene["id"] = scene_id;
        scene["displayName"] = scene_id;
        scene["program"]["events"] = nlohmann::json::array();
        scene["terminal"] = {{"kind", "return"}, {"outcome", nullptr}};
        document["definitions"]["scenes"].push_back(std::move(scene));
        document["resources"]["assets"].push_back(
            {{"aliases", nlohmann::json::array()},
             {"id", asset_id},
             {"kind", "image"},
             {"path", "assets/images/" + std::string(asset_id) + ".png"},
             {"sampling", "linear"},
             {"width", 64},
             {"height", 64}});
        const auto group = document["flowPrediction"]["dependencyGroups"].size();
        document["flowPrediction"]["dependencyGroups"].push_back(
            nlohmann::json::array({{{"kind", "asset"},
                                    {"asset", {{"kind", "asset"}, {"id", asset_id}}}}}));
        document["flowPrediction"]["slices"].push_back(
            {{"point", {{"kind", "scene-entry"}, {"scene", scene_ref(scene_id)}}},
             {"dependencyGroups", nlohmann::json::array({group})},
             {"conditionFalseSuccessor", nullptr},
             {"control", {{"kind", "sequential"}, {"successor", nullptr}}},
             {"frontier", "normal"},
             {"program", nlohmann::json::array()}});
    }

    for (auto& slice : document["flowPrediction"]["slices"]) {
        const auto& point = slice["point"];
        if (point.value("kind", "") != "scene-entry" ||
            point["scene"].value("id", "") != "opening")
            continue;
        slice["dependencyGroups"] = nlohmann::json::array();
        slice["program"] = nlohmann::json::array(
            {{{"kind", "set-identity-property"},
              {"owner", {{"kind", "current-room"}}},
              {"property", {{"kind", "property"}, {"id", "visit-count"}}},
              {"value", 9}},
             {{"kind", "set-location"},
              {"subject",
               {{"kind", "interactable"},
                {"interactable", {{"kind", "interactable"}, {"id", "wallet"}}}}},
              {"location",
               {{"kind", "room"},
                {"room", {{"kind", "room"}, {"room", room_ref("tower")}}}}}},
             {{"kind", "enter-room"}, {"room", room_ref("tower")}},
             {{"kind", "if"},
              {"condition",
               {{"kind", "all"},
                {"conditions",
                 nlohmann::json::array(
                     {{{"kind", "location-comparison"},
                       {"subject",
                        {{"kind", "interactable"},
                         {"interactable",
                          {{"kind", "interactable"}, {"id", "wallet"}}}}},
                       {"operator", "equal"},
                       {"location",
                        {{"kind", "room"}, {"room", {{"kind", "current-room"}}}}}},
                      {{"kind", "property-comparison"},
                       {"owner",
                        {{"kind", "room"},
                         {"room", {{"kind", "room"}, {"id", "hall"}}}}},
                       {"propertyId", "visit-count"},
                       {"operator", "equal"},
                       {"value", 9}}})}}},
              {"thenCommands",
               nlohmann::json::array(
                   {{{"kind", "call-scene"}, {"scene", scene_ref("location-true")}}})},
              {"elseCommands",
               nlohmann::json::array(
                   {{{"kind", "call-scene"}, {"scene", scene_ref("location-false")}}})}}});
        slice["control"] = {{"kind", "sequential"}, {"successor", nullptr}};
        break;
    }

    auto package = package_from_document(std::move(document), "current-room-location-projection.json");
    const auto projection = runtime::FlowPredictor(package.project()).predict(
        core::compiled::Entrypoint{id<core::SceneId>("opening")},
        runtime::FlowPredictionContext{.current_room = id<core::RoomId>("hall")});
    REQUIRE(projection.diagnostics.empty());
    CHECK(projection.context_requirements.condition_facts.empty());
    const auto has_asset = [&](std::string_view asset) {
        return std::ranges::any_of(projection.entries, [&](const auto& entry) {
            const auto* dependency =
                std::get_if<core::compiled::FlowPredictionAssetDependency>(&entry.dependency);
            return dependency != nullptr &&
                   dependency->asset == id<core::AssetId>(std::string(asset));
        });
    };
    CHECK(has_asset("image-location-true"));
    CHECK_FALSE(has_asset("image-location-false"));
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

TEST_CASE("awaited child Flow returns deterministic projected state to caller continuation",
          "[assets][structured-prefetch][flow-prediction][scene][projection][child]")
{
    auto document = scene_prediction_test_document();
    auto& slices = document["flowPrediction"]["slices"];
    slices[2]["program"] = nlohmann::json::array(
        {{{"kind", "set-global-property"},
          {"property", {{"kind", "property"}, {"id", "flag"}}},
          {"value", true}}});
    slices[8]["condition"] = nlohmann::json{{"kind", "global-property-comparison"},
                                            {"property",
                                             {{"kind", "property"}, {"id", "flag"}}},
                                            {"operator", "truthy"}};
    slices[8]["conditionFalseSuccessor"] = 18;

    auto package = package_from_document(std::move(document), "scene-child-projection.json");
    runtime::FlowPredictor predictor(package.project());
    const auto projection = predictor.predict(
        core::compiled::Entrypoint{id<core::SceneId>("prediction-horizon")},
        runtime::FlowPredictionContext{
            .global_properties = {{id<core::PropertyId>("flag"), core::RuntimeValue{false}}}});
    REQUIRE(projection.diagnostics.empty());

    const auto caller = std::ranges::find_if(projection.entries, [](const auto& entry) {
        const auto* dependency =
            std::get_if<core::compiled::FlowPredictionAssetDependency>(&entry.dependency);
        return dependency != nullptr &&
               dependency->asset == id<core::AssetId>("image-prediction-caller-after");
    });
    REQUIRE(caller != projection.entries.end());
    CHECK(caller->confidence == runtime::FlowPredictionConfidence::Expected);
}

TEST_CASE("active Scene prediction preserves an aliased resume point in provenance",
          "[assets][structured-prefetch][flow-prediction][scene][provenance]")
{
    auto document = scene_prediction_test_document();
    document["flowPrediction"]["slices"][8]["resumePoints"] = nlohmann::json::array(
        {{{"kind", "scene-step"},
          {"scene", {{"kind", "scene"}, {"id", "prediction-horizon"}}},
          {"stepId", "caller-after-resume"}}});
    auto package = package_from_document(std::move(document), "scene-resume-provenance.json");
    runtime::FlowPredictor predictor(package.project());

    const auto projection = predictor.predict(runtime::ActiveScenePredictionRoot{
        .scene = id<core::SceneId>("prediction-horizon"),
        .position = core::SceneFramePosition{id<core::SceneStepId>("caller-after-resume"),
                                             core::SceneStepReady{}, true}});
    REQUIRE(projection.diagnostics.empty());
    const auto caller = std::ranges::find_if(projection.entries, [](const auto& entry) {
        const auto* dependency =
            std::get_if<core::compiled::FlowPredictionAssetDependency>(&entry.dependency);
        return dependency != nullptr &&
               dependency->asset == id<core::AssetId>("image-prediction-caller-after");
    });
    REQUIRE(caller != projection.entries.end());
    REQUIRE_FALSE(caller->provenance.points.empty());
    const auto* root_point =
        std::get_if<core::compiled::SceneStepPredictionPoint>(&caller->provenance.points.front());
    REQUIRE(root_point);
    CHECK(root_point->scene == id<core::SceneId>("prediction-horizon"));
    CHECK(root_point->step == id<core::SceneStepId>("caller-after-resume"));
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
    CHECK_FALSE(std::ranges::any_of(projection.opaque_frontiers, [](const auto& frontier) {
        const auto* point = std::get_if<core::compiled::SceneStepPredictionPoint>(
            &frontier.attachment_point);
        return point != nullptr && point->scene == id<core::SceneId>("prediction-decision") &&
               point->step == id<core::SceneStepId>("decision-branch");
    }));

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
    REQUIRE(opaque_root.opaque_frontiers.size() == 1);
    const auto* opaque_point = std::get_if<core::compiled::SceneStepPredictionPoint>(
        &opaque_root.opaque_frontiers.front().attachment_point);
    REQUIRE(opaque_point != nullptr);
    CHECK(opaque_point->scene == id<core::SceneId>("prediction-decision"));
    CHECK(opaque_point->step == id<core::SceneStepId>("opaque-lua"));
    CHECK(opaque_root.opaque_frontiers.front().provenance.supplemental_hint_id == std::nullopt);
    CHECK(find_asset(opaque_root, "image-prediction-branch-alternative") ==
          opaque_root.entries.end());

    auto hinted_document = scene_prediction_test_document();
    hinted_document["flowPrediction"]["supplementalHints"] = nlohmann::json::array(
        {{{"id", "opaque-dynamic-image"},
          {"target",
           {{"kind", "asset"},
            {"asset", {{"kind", "asset"}, {"id", "image-prediction-branch-alternative"}}}}},
          {"attachment", {{"kind", "point"}, {"slice", 23}}}}});
    auto hinted_package =
        package_from_document(hinted_document, "scene-prediction-test-with-opaque-hint.json");
    runtime::FlowPredictor hinted_predictor(hinted_package.project());
    const auto hinted = hinted_predictor.predict(runtime::ActiveScenePredictionRoot{
        .scene = id<core::SceneId>("prediction-decision"),
        .position = core::SceneFramePosition{id<core::SceneStepId>("opaque-lua"),
                                             core::SceneStepReady{}, true}});
    REQUIRE(hinted.diagnostics.empty());
    const auto dynamic = find_asset(hinted, "image-prediction-branch-alternative");
    REQUIRE(dynamic != hinted.entries.end());
    CHECK(dynamic->provenance.supplemental_hint_id == "opaque-dynamic-image");
}

TEST_CASE("Lua predicates in Flow Conditions publish opaque frontiers without executing Lua",
          "[assets][structured-prefetch][flow-prediction][condition][opaque]")
{
    auto document = scene_prediction_test_document();
    auto& slices = document["flowPrediction"]["slices"];
    auto decision = std::ranges::find_if(slices, [](const auto& slice) {
        return slice["point"]["kind"] == "scene-step" &&
               slice["point"]["scene"]["id"] == "prediction-decision" &&
               slice["point"]["stepId"] == "decision-branch";
    });
    REQUIRE(decision != slices.end());
    (*decision)["condition"] = {
        {"kind", "not"},
        {"condition", {{"kind", "lua-predicate"}, {"source", "dynamic_slice_gate()"}}},
    };
    (*decision)["control"]["branches"][0]["condition"] = {
        {"kind", "all"},
        {"conditions",
         nlohmann::json::array({{{"kind", "always"}},
                                {{"kind", "lua-predicate"},
                                 {"source", "dynamic_branch_gate()"}}})},
    };

    auto package = package_from_document(std::move(document), "scene-lua-condition-opacity.json");
    runtime::FlowPredictor predictor(package.project());
    const auto projection = predictor.predict(runtime::ActiveScenePredictionRoot{
        .scene = id<core::SceneId>("prediction-decision"),
        .position = core::SceneFramePosition{id<core::SceneStepId>("decision-branch"),
                                             core::SceneStepReady{}, true}});

    REQUIRE(projection.diagnostics.empty());
    CHECK(std::ranges::any_of(projection.opaque_frontiers, [](const auto& frontier) {
        const auto* point = std::get_if<core::compiled::SceneStepPredictionPoint>(
            &frontier.attachment_point);
        return point != nullptr && point->scene == id<core::SceneId>("prediction-decision") &&
               point->step == id<core::SceneStepId>("decision-branch");
    }));
}

TEST_CASE("active Scene choice prediction resumes after an awaited effect frontier",
          "[assets][structured-prefetch][flow-prediction][scene][choice][wait]")
{
    auto document = scene_prediction_test_document();
    auto& option = document["flowPrediction"]["slices"][20]["control"]["options"][0];
    option["programs"] =
        nlohmann::json::array({nlohmann::json::array({{{"kind", "opaque"}}})});
    auto package = package_from_document(std::move(document), "scene-choice-wait-prediction.json");
    runtime::FlowPredictor predictor(package.project());

    const auto root = [&](bool awaiting_completion) {
        return runtime::ActiveScenePredictionRoot{
            .scene = id<core::SceneId>("prediction-decision"),
            .position = core::SceneFramePosition{
                id<core::SceneStepId>("decision-choice"),
                core::SceneChoiceEffectPosition{id<core::SceneChoiceOptionId>("choice-a"), 0,
                                                awaiting_completion},
                true}};
    };
    const auto active = predictor.predict(root(false));
    CHECK(std::ranges::any_of(active.opaque_frontiers, [](const auto& frontier) {
        const auto* point = std::get_if<core::compiled::SceneStepPredictionPoint>(
            &frontier.attachment_point);
        return point != nullptr && point->step == id<core::SceneStepId>("decision-choice");
    }));

    const auto waiting = predictor.predict(root(true));
    CHECK_FALSE(std::ranges::any_of(waiting.opaque_frontiers, [](const auto& frontier) {
        const auto* point = std::get_if<core::compiled::SceneStepPredictionPoint>(
            &frontier.attachment_point);
        return point != nullptr && point->step == id<core::SceneStepId>("decision-choice");
    }));
    const auto target = std::ranges::find_if(waiting.entries, [](const auto& entry) {
        const auto* dependency =
            std::get_if<core::compiled::FlowPredictionAssetDependency>(&entry.dependency);
        return dependency != nullptr &&
               dependency->asset == id<core::AssetId>("image-prediction-choice-a");
    });
    REQUIRE(target != waiting.entries.end());
    CHECK(target->confidence == runtime::FlowPredictionConfidence::Alternative);
    CHECK(target->execution_distance >= 3);
}

TEST_CASE("typed gameplay mutations invalidate non-global prediction facts before downstream branches",
          "[assets][structured-prefetch][flow-prediction][condition][projection]")
{
    const auto trait_condition = nlohmann::json{
        {"kind", "trait-presence"},
        {"owner",
         {{"kind", "interactable"},
          {"interactable", {{"kind", "interactable"}, {"id", "wallet"}}}}},
        {"trait", {{"kind", "trait"}, {"id", "currency"}}},
        {"present", true}};
    const auto amend_branch = [&](nlohmann::json& document, bool invalidate) {
        for (auto& slice : document["flowPrediction"]["slices"]) {
            if (slice["point"]["kind"] != "scene-step" ||
                slice["point"]["scene"]["id"] != "prediction-decision" ||
                slice["point"]["stepId"] != "decision-branch")
                continue;
            slice["control"]["branches"][0]["condition"] = trait_condition;
            slice["program"] = invalidate
                                   ? nlohmann::json::array(
                                         {{{"kind", "invalidate-condition-facts"}}})
                                   : nlohmann::json::array();
            return;
        }
        FAIL("prediction decision branch slice is missing");
    };
    const auto branch_condition = [](const core::CompiledProject& project) -> core::Condition {
        REQUIRE(project.flow_prediction());
        for (const auto& slice : project.flow_prediction()->slices) {
            const auto* point = std::get_if<core::compiled::SceneStepPredictionPoint>(&slice.point);
            if (point == nullptr || point->scene != id<core::SceneId>("prediction-decision") ||
                point->step != id<core::SceneStepId>("decision-branch"))
                continue;
            const auto* control =
                std::get_if<core::compiled::FlowPredictionBranchControl>(&slice.control);
            REQUIRE(control != nullptr);
            REQUIRE_FALSE(control->branches.empty());
            return control->branches.front().condition;
        }
        FAIL("decoded prediction decision branch slice is missing");
        return core::Condition{core::Always{}};
    };
    const auto has_asset = [](const runtime::FlowPredictionProjection& projection,
                              std::string_view asset) {
        return std::ranges::any_of(projection.entries, [&](const auto& entry) {
            const auto* dependency =
                std::get_if<core::compiled::FlowPredictionAssetDependency>(&entry.dependency);
            return dependency != nullptr &&
                   dependency->asset == id<core::AssetId>(std::string(asset));
        });
    };
    const runtime::ActiveScenePredictionRoot root{
        .scene = id<core::SceneId>("prediction-decision"),
        .position = core::SceneFramePosition{id<core::SceneStepId>("decision-branch"),
                                             core::SceneStepReady{}, true}};

    auto known_document = scene_prediction_test_document();
    amend_branch(known_document, false);
    auto known_package = package_from_document(std::move(known_document), "known-typed-fact.json");
    const auto known_condition = branch_condition(known_package.project());
    const auto known_projection = runtime::FlowPredictor(known_package.project())
                                      .predict(root, runtime::FlowPredictionContext{
                                                         .condition_facts = {{known_condition, true}}});
    REQUIRE(known_projection.diagnostics.empty());
    CHECK(has_asset(known_projection, "image-prediction-branch-expected"));
    CHECK_FALSE(has_asset(known_projection, "image-prediction-branch-alternative"));

    auto invalidated_document = scene_prediction_test_document();
    amend_branch(invalidated_document, true);
    auto invalidated_package =
        package_from_document(std::move(invalidated_document), "invalidated-typed-fact.json");
    const auto invalidated_condition = branch_condition(invalidated_package.project());
    const auto invalidated_projection = runtime::FlowPredictor(invalidated_package.project())
                                            .predict(root, runtime::FlowPredictionContext{
                                                               .condition_facts = {
                                                                   {invalidated_condition, true}}});
    REQUIRE(invalidated_projection.diagnostics.empty());
    CHECK(has_asset(invalidated_projection, "image-prediction-branch-expected"));
    CHECK(has_asset(invalidated_projection, "image-prediction-branch-alternative"));
}

TEST_CASE("deterministic typed mutation projects a changed non-global fact into a later branch",
          "[assets][structured-prefetch][flow-prediction][condition][projection][typed]")
{
    const auto trait_condition = nlohmann::json{
        {"kind", "trait-presence"},
        {"owner",
         {{"kind", "interactable"},
          {"interactable", {{"kind", "interactable"}, {"id", "wallet"}}}}},
        {"trait", {{"kind", "trait"}, {"id", "currency"}}},
        {"present", true}};
    auto document = scene_prediction_test_document();
    for (auto& slice : document["flowPrediction"]["slices"]) {
        if (slice["point"]["kind"] != "scene-step" ||
            slice["point"]["scene"]["id"] != "prediction-decision" ||
            slice["point"]["stepId"] != "decision-branch")
            continue;
        slice["control"]["branches"][0]["condition"] = trait_condition;
        slice["program"] = nlohmann::json::array(
            {{{"kind", "set-trait-presence"},
              {"owner",
               {{"kind", "interactable"},
                {"interactable", {{"kind", "interactable"}, {"id", "wallet"}}}}},
              {"trait", {{"kind", "trait"}, {"id", "currency"}}},
              {"present", true}}});
        break;
    }

    auto package = package_from_document(std::move(document), "projected-typed-fact.json");
    REQUIRE(package.project().flow_prediction());
    const auto branch = std::ranges::find_if(
        package.project().flow_prediction()->slices, [](const auto& slice) {
            const auto* point = std::get_if<core::compiled::SceneStepPredictionPoint>(&slice.point);
            return point != nullptr && point->scene == id<core::SceneId>("prediction-decision") &&
                   point->step == id<core::SceneStepId>("decision-branch");
        });
    REQUIRE(branch != package.project().flow_prediction()->slices.end());
    const auto* control = std::get_if<core::compiled::FlowPredictionBranchControl>(&branch->control);
    REQUIRE(control != nullptr);
    REQUIRE_FALSE(control->branches.empty());
    const auto projection = runtime::FlowPredictor(package.project())
                                .predict(runtime::ActiveScenePredictionRoot{
                                             .scene = id<core::SceneId>("prediction-decision"),
                                             .position = core::SceneFramePosition{
                                                 id<core::SceneStepId>("decision-branch"),
                                                 core::SceneStepReady{}, true}});
    REQUIRE(projection.diagnostics.empty());
    const auto has_asset = [&](std::string_view asset) {
        return std::ranges::any_of(projection.entries, [&](const auto& entry) {
            const auto* dependency =
                std::get_if<core::compiled::FlowPredictionAssetDependency>(&entry.dependency);
            return dependency != nullptr &&
                   dependency->asset == id<core::AssetId>(std::string(asset));
        });
    };
    CHECK(has_asset("image-prediction-branch-expected"));
    CHECK_FALSE(has_asset("image-prediction-branch-alternative"));
}

TEST_CASE("context-bound typed mutation operands widen without a binding environment",
          "[assets][structured-prefetch][flow-prediction][condition][projection][binding]")
{
    const auto slot_owner = nlohmann::json{{"kind", "interaction-slot"}, {"slotId", "target"}};
    const auto trait_condition = nlohmann::json{
        {"kind", "trait-presence"},
        {"owner", slot_owner},
        {"trait", {{"kind", "trait"}, {"id", "currency"}}},
        {"present", true}};
    auto document = scene_prediction_test_document();
    for (auto& slice : document["flowPrediction"]["slices"]) {
        if (slice["point"].value("kind", "") != "scene-step" ||
            slice["point"]["scene"].value("id", "") != "prediction-decision" ||
            slice["point"].value("stepId", "") != "decision-branch")
            continue;
        slice["control"]["branches"][0]["condition"] = trait_condition;
        slice["program"] = nlohmann::json::array(
            {{{"kind", "set-trait-presence"},
              {"owner", slot_owner},
              {"trait", {{"kind", "trait"}, {"id", "currency"}}},
              {"present", true}}});
        break;
    }

    auto package = package_from_document(std::move(document), "context-bound-projection.json");
    const auto projection = runtime::FlowPredictor(package.project()).predict(
        runtime::ActiveScenePredictionRoot{
            .scene = id<core::SceneId>("prediction-decision"),
            .position = core::SceneFramePosition{id<core::SceneStepId>("decision-branch"),
                                                 core::SceneStepReady{}, true}});
    REQUIRE(projection.diagnostics.empty());
    const auto find_asset = [&](std::string_view asset) {
        return std::ranges::find_if(projection.entries, [&](const auto& entry) {
            const auto* dependency =
                std::get_if<core::compiled::FlowPredictionAssetDependency>(&entry.dependency);
            return dependency != nullptr &&
                   dependency->asset == id<core::AssetId>(std::string(asset));
        });
    };
    const auto expected = find_asset("image-prediction-branch-expected");
    const auto alternative = find_asset("image-prediction-branch-alternative");
    REQUIRE(expected != projection.entries.end());
    REQUIRE(alternative != projection.entries.end());
    CHECK(expected->confidence == runtime::FlowPredictionConfidence::Alternative);
    CHECK(alternative->confidence == runtime::FlowPredictionConfidence::Alternative);
}

TEST_CASE("active Interaction bindings project slot-targeted mutations into later Conditions",
          "[assets][structured-prefetch][flow-prediction][condition][projection][binding]")
{
    auto document = read_compiled_project_golden("interaction-program");
    const auto slot_owner = nlohmann::json{{"kind", "interaction-slot"}, {"slotId", "target"}};
    const auto trait_condition = nlohmann::json{
        {"kind", "trait-presence"},
        {"owner", slot_owner},
        {"trait", {{"kind", "trait"}, {"id", "currency"}}},
        {"present", true}};
    auto& groups = document["flowPrediction"]["dependencyGroups"];
    const auto scene_group = groups.size();
    groups.push_back(nlohmann::json::array(
        {{{"kind", "asset"}, {"asset", {{"kind", "asset"}, {"id", "image-main"}}}}}));
    const auto dialogue_group = groups.size();
    groups.push_back(nlohmann::json::array(
        {{{"kind", "asset"}, {"asset", {{"kind", "asset"}, {"id", "audio-voice"}}}}}));

    for (auto& verb : document["definitions"]["verbs"]) {
        if (verb["id"] != "unlock")
            continue;
        verb["defaultProgram"]["instructions"] = nlohmann::json::array(
            {{{"id", "slot-trait"},
              {"kind", "add-trait"},
              {"owner", slot_owner},
              {"trait", {{"kind", "trait"}, {"id", "currency"}}}},
             {{"id", "slot-branch"},
              {"kind", "if"},
              {"condition", trait_condition},
              {"then",
               nlohmann::json::array(
                   {{{"id", "slot-true"},
                     {"kind", "call-scene"},
                     {"scene", {{"kind", "scene"}, {"id", "opening"}}}}})},
              {"else",
               nlohmann::json::array(
                   {{{"id", "slot-false"},
                     {"kind", "call-dialogue"},
                     {"dialogue", {{"kind", "dialogue"}, {"id", "intro"}}}}})}}});
    }

    for (auto& slice : document["flowPrediction"]["slices"]) {
        const auto& point = slice["point"];
        if (point.value("kind", "") == "scene-entry" &&
            point["scene"].value("id", "") == "opening")
            slice["dependencyGroups"] = nlohmann::json::array({scene_group});
        else if (point.value("kind", "") == "dialogue-entry" &&
                 point["dialogue"].value("id", "") == "intro")
            slice["dependencyGroups"] = nlohmann::json::array({dialogue_group});
        else if (point.value("kind", "") == "verb-default" &&
                 point["verb"].value("id", "") == "unlock") {
            slice["program"] = nlohmann::json::array(
                {{{"commandId", "slot-trait"},
                  {"kind", "set-trait-presence"},
                  {"owner", slot_owner},
                  {"trait", {{"kind", "trait"}, {"id", "currency"}}},
                  {"present", true}},
                 {{"commandId", "slot-branch"},
                  {"kind", "if"},
                  {"condition", trait_condition},
                  {"thenCommands",
                   nlohmann::json::array(
                       {{{"kind", "call-scene"},
                         {"scene", {{"kind", "scene"}, {"id", "opening"}}}}})},
                  {"elseCommands",
                   nlohmann::json::array(
                       {{{"kind", "call-dialogue"},
                         {"dialogue", {{"kind", "dialogue"}, {"id", "intro"}}}}})}}});
        }
    }

    auto decoded =
        core::decode_compiled_project(document, "interaction-slot-projection.json");
    REQUIRE(decoded);
    auto project = std::move(decoded).value();
    const runtime::ActiveInteractionPredictionRoot root{
        .program = core::VerbDefaultProgramRef{id<core::VerbId>("unlock")},
        .position = core::InteractionFramePosition{
            .next_instruction = id<core::InteractionInstructionId>("slot-trait"),
            .fallback_stage = core::InteractionFallbackStage::VerbDefault,
            .outcome = core::InteractionExecutionOutcome::Pending,
            .awaiting_completion = false},
        .interaction_bindings =
            {{id<core::VerbSlotId>("target"),
              core::compiled::InteractableInteractionSubject{id<core::InteractableInstanceId>(
                  "key")}}},
        .command_results = {},
        .condition_facts = {}};
    const auto projection = runtime::FlowPredictor(project).predict(root);
    REQUIRE(projection.diagnostics.empty());
    const auto has_asset = [&](std::string_view asset) {
        return std::ranges::any_of(projection.entries, [&](const auto& entry) {
            const auto* dependency =
                std::get_if<core::compiled::FlowPredictionAssetDependency>(&entry.dependency);
            return dependency != nullptr &&
                   dependency->asset == id<core::AssetId>(std::string(asset));
        });
    };
    CHECK(has_asset("image-main"));
    CHECK_FALSE(has_asset("audio-voice"));
    CHECK(projection.context_requirements.condition_facts.empty());
}

TEST_CASE("typed identity mutations invalidate inventory quantity facts they may change",
          "[assets][structured-prefetch][flow-prediction][condition][projection][inventory]")
{
    auto document = scene_prediction_test_document();
    const auto inventory_condition = nlohmann::json{
        {"kind", "inventory-quantity-comparison"},
        {"inventory",
         {{"kind", "inventory"},
          {"inventory", {{"owner", {{"kind", "project"}}}, {"inventoryId", "player"}}}}},
        {"matcher",
         {{"traits", nlohmann::json::array()},
          {"properties", nlohmann::json::array()},
          {"exact",
           {{"kind", "interactable"},
            {"interactable", {{"kind", "interactable"}, {"id", "key"}}}}}}},
        {"operator", "greater-equal"},
        {"quantity", 1}};
    for (auto& slice : document["flowPrediction"]["slices"]) {
        if (slice["point"].value("kind", "") != "scene-step" ||
            slice["point"]["scene"].value("id", "") != "prediction-decision" ||
            slice["point"].value("stepId", "") != "decision-branch")
            continue;
        slice["control"]["branches"][0]["condition"] = inventory_condition;
        slice["program"] = nlohmann::json::array(
            {{{"kind", "set-location"},
              {"subject",
               {{"kind", "interactable"},
                {"interactable", {{"kind", "interactable"}, {"id", "key"}}}}},
              {"location",
               {{"kind", "room"},
                {"room", {{"kind", "room"}, {"room", {{"kind", "room"}, {"id", "start"}}}}}}}}});
        break;
    }
    auto package = package_from_document(std::move(document), "inventory-fact-invalidation.json");
    REQUIRE(package.project().flow_prediction());

    std::optional<core::Condition> condition;
    for (const auto& slice : package.project().flow_prediction()->slices) {
        const auto* point = std::get_if<core::compiled::SceneStepPredictionPoint>(&slice.point);
        if (point == nullptr || point->scene != id<core::SceneId>("prediction-decision") ||
            point->step != id<core::SceneStepId>("decision-branch"))
            continue;
        const auto* control =
            std::get_if<core::compiled::FlowPredictionBranchControl>(&slice.control);
        REQUIRE(control);
        REQUIRE_FALSE(control->branches.empty());
        condition = control->branches.front().condition;
        break;
    }
    REQUIRE(condition);

    const runtime::ActiveScenePredictionRoot root{
        .scene = id<core::SceneId>("prediction-decision"),
        .position = core::SceneFramePosition{id<core::SceneStepId>("decision-branch"),
                                             core::SceneStepReady{}, true}};
    const auto projection = runtime::FlowPredictor(package.project()).predict(
        root, runtime::FlowPredictionContext{.condition_facts = {{*condition, true}}});
    const auto has_asset = [&](std::string_view asset) {
        return std::ranges::any_of(projection.entries, [&](const auto& entry) {
            const auto* dependency =
                std::get_if<core::compiled::FlowPredictionAssetDependency>(&entry.dependency);
            return dependency != nullptr &&
                   dependency->asset == id<core::AssetId>(std::string(asset));
        });
    };
    CHECK(has_asset("image-prediction-branch-expected"));
    CHECK(has_asset("image-prediction-branch-alternative"));
}

TEST_CASE("Ordered prediction branches do not retain fallback after a definitely true branch",
          "[assets][structured-prefetch][flow-prediction][scene][condition][ordered]")
{
    auto document = scene_prediction_test_document();
    auto& control = document["flowPrediction"]["slices"][17]["control"];
    control["branches"] = nlohmann::json::array(
        {{{"condition", {{"kind", "lua-predicate"}, {"source", "unknown_first()"}}},
          {"target", 18}},
         {{"condition", {{"kind", "always"}}}, {"target", 19}}});
    // Slice 0 has a unique child-stage dependency. It is impossible once the second ordered branch
    // is statically true, even though the first branch remains an alternative.
    control["fallback"] = 0;

    auto package = package_from_document(std::move(document), "ordered-prediction-branch.json");
    runtime::FlowPredictor predictor(package.project());
    const auto projection =
        predictor.predict(core::compiled::Entrypoint{id<core::SceneId>("prediction-decision")});

    const auto find_asset = [&](std::string_view asset) {
        return std::ranges::find_if(projection.entries, [&](const auto& entry) {
            const auto* dependency =
                std::get_if<core::compiled::FlowPredictionAssetDependency>(&entry.dependency);
            return dependency != nullptr &&
                   dependency->asset == id<core::AssetId>(std::string(asset));
        });
    };
    CHECK(find_asset("image-prediction-branch-alternative") != projection.entries.end());
    CHECK(find_asset("image-prediction-branch-expected") != projection.entries.end());
    CHECK(find_asset("image-prediction-child-stage") == projection.entries.end());
}

TEST_CASE("Flow prediction bounds pathological acyclic expansion before planner resolution",
          "[assets][structured-prefetch][flow-prediction][ceiling]")
{
    auto document = read_compiled_project_golden("scene-program");
    nlohmann::json slices = nlohmann::json::array();
    constexpr std::size_t slice_count = 4100;
    for (std::size_t index = 0; index < slice_count; ++index) {
        nlohmann::json point = index == 0
                                   ? nlohmann::json{{"kind", "scene-entry"},
                                                    {"scene", {{"kind", "scene"}, {"id", "opening"}}}}
                                   : nlohmann::json{{"kind", "scene-step"},
                                                    {"scene", {{"kind", "scene"}, {"id", "opening"}}},
                                                    {"stepId", "bounded-" + std::to_string(index)}};
        slices.push_back(
            {{"point", std::move(point)},
             {"dependencyGroups", nlohmann::json::array({0})},
             {"conditionFalseSuccessor", nullptr},
             {"control",
              {{"kind", "sequential"},
               {"successor", index + 1 < slice_count ? nlohmann::json(index + 1)
                                                       : nlohmann::json(nullptr)}}},
             {"frontier", "normal"},
             {"program", nlohmann::json::array()}});
    }
    document["flowPrediction"] = {
        {"dependencyGroups",
         nlohmann::json::array({nlohmann::json::array(
             {{{"kind", "asset"}, {"asset", {{"kind", "asset"}, {"id", "image-main"}}}}})})},
        {"slices", std::move(slices)},
    };

    auto package = package_from_document(std::move(document), "bounded-flow-prediction.json");
    runtime::FlowPredictor predictor(package.project());
    const auto projection = predictor.predict(core::compiled::Entrypoint{id<core::SceneId>("opening")});
    CHECK_FALSE(projection.entries.empty());
    CHECK(projection.entries.size() <= runtime::FlowPredictor::structural_ceiling);
    CHECK(std::ranges::any_of(projection.diagnostics, [](const auto& diagnostic) {
        return diagnostic.code == "assets.flow_prediction_structural_limit";
    }));
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

    assets::PrefetchPlan first_plan;
    first_plan.candidates.push_back({.descriptor = descriptor(first, source_generation),
                                     .prediction = assets::PrefetchPredictionKind::ExpectedNext});
    auto first_report = planner.replace_generation_on_owner(first_plan);
    REQUIRE(first_report);
    const auto first_generation = first_report.value().generation;

    auto demand = fixture.manager.request_texture(first, assets::AssetRequestReason::Demand);
    REQUIRE(demand);

    assets::PrefetchPlan second_plan;
    second_plan.candidates.push_back({.descriptor = descriptor(second, source_generation),
                                      .prediction = assets::PrefetchPredictionKind::ExpectedNext});
    auto second_report = planner.replace_generation_on_owner(second_plan);
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

TEST_CASE("prefetch generation replacement can reuse Warm capacity from obsolete interests",
          "[assets][structured-prefetch][budget][replacement]")
{
    auto budget = generous_budget();
    budget.prepared_cpu_bytes = 1;
    budget.gpu_bytes = 0;
    budget.audio_bytes = 0;
    PlannerFixture fixture(nullptr, budget);
    assets::PrefetchPlanner planner(fixture.manager);
    const auto generation = fixture.manager.source_generation_on_owner();
    const assets::TextureAssetRequest first{.path = "project:/textures/replaced-first.png"};
    const assets::TextureAssetRequest second{.path = "project:/textures/replaced-second.png"};
    const auto candidate = [&](const assets::TextureAssetRequest& request) {
        return assets::PrefetchCandidate{
            .descriptor = descriptor(request, generation),
            .prediction = assets::PrefetchPredictionKind::ExpectedNext,
            .estimated_cost = {.prepared_cpu_bytes = 1},
            .cost_estimate = assets::PrefetchCostEstimateKind::Metadata};
    };

    assets::PrefetchPlan first_plan;
    first_plan.candidates.push_back(candidate(first));
    auto first_report = planner.replace_generation_on_owner(first_plan);
    REQUIRE(first_report);
    REQUIRE(first_report.value().submitted_entries.size() == 1);
    fixture.run_until_idle();

    assets::PrefetchPlan second_plan;
    second_plan.candidates.push_back(candidate(second));
    auto second_report = planner.replace_generation_on_owner(second_plan);
    REQUIRE(second_report);
    CHECK(second_report.value().admission_rejections.empty());
    CHECK(second_report.value().submitted_entries.size() == 1);
    CHECK(planner.retained_ticket_count_on_owner() == 1);
    CHECK(std::ranges::find(fixture.recorder.calls,
                            "texture:project:/textures/replaced-second.png") !=
          fixture.recorder.calls.end());
    fixture.run_until_idle();
    CHECK(fixture.manager.prefetch_residency_class_on_owner(
              assets::make_texture_cache_key(second, generation)) == assets::ResidencyClass::Warm);
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

TEST_CASE("mandatory gate expands Flow prediction in Warm-budget-aware waves",
          "[assets][structured-prefetch][flow-prediction][budget][horizon]")
{
    const auto make_document = [] {
        auto document = scene_prediction_test_document();
        for (auto& system_layout : document["settings"]["systemLayouts"])
            system_layout["layout"] = nullptr;

        auto idle = document["definitions"]["scenes"][0];
        idle["id"] = "prediction-idle";
        idle["displayName"] = "prediction-idle";
        idle["program"]["events"] = nlohmann::json::array();
        idle["terminal"] = {{"kind", "continue-dialogue"},
                            {"dialogue", {{"kind", "dialogue"}, {"id", "intro"}}}};
        document["definitions"]["scenes"].push_back(std::move(idle));

        auto wave = document["definitions"]["scenes"][0];
        wave["id"] = "prediction-wave";
        wave["displayName"] = "prediction-wave";
        wave["program"]["events"] = nlohmann::json::array();
        wave["terminal"] = {{"kind", "return"}, {"outcome", nullptr}};
        document["definitions"]["scenes"].push_back(std::move(wave));
        document["entrypoint"] = {
            {"kind", "scene"},
            {"scene", {{"kind", "scene"}, {"id", "prediction-idle"}}},
        };

        auto& prediction = document["flowPrediction"];
        const auto idle_slice = prediction["slices"].size();
        prediction["slices"].push_back(
            {{"point",
              {{"kind", "scene-entry"},
               {"scene", {{"kind", "scene"}, {"id", "prediction-idle"}}}}},
             {"dependencyGroups", nlohmann::json::array()},
             {"conditionFalseSuccessor", nullptr},
             {"control", {{"kind", "sequential"}, {"successor", nullptr}}},
             {"frontier", "normal"},
             {"program", nlohmann::json::array()}});
        (void)idle_slice;

        constexpr std::size_t candidate_count = 80;
        const auto first_group = prediction["dependencyGroups"].size();
        const auto first_slice = prediction["slices"].size();
        for (std::size_t index = 0; index < candidate_count; ++index) {
            const auto id = "prediction-wave-" + std::to_string(index);
            document["resources"]["assets"].push_back(
                {{"aliases", nlohmann::json::array()},
                 {"id", id},
                 {"kind", "image"},
                 {"path", "assets/images/" + id + ".png"},
                 {"sampling", "linear"},
                 {"width", 64},
                 {"height", 64}});
            prediction["dependencyGroups"].push_back(nlohmann::json::array(
                {{{"kind", "asset"}, {"asset", {{"kind", "asset"}, {"id", id}}}}}));

            nlohmann::json point =
                index == 0
                    ? nlohmann::json{{"kind", "scene-entry"},
                                     {"scene", {{"kind", "scene"}, {"id", "prediction-wave"}}}}
                    : nlohmann::json{{"kind", "scene-step"},
                                     {"scene", {{"kind", "scene"}, {"id", "prediction-wave"}}},
                                     {"stepId", "wave-" + std::to_string(index)}};
            prediction["slices"].push_back(
                {{"point", std::move(point)},
                 {"dependencyGroups", nlohmann::json::array({first_group + index})},
                 {"conditionFalseSuccessor", nullptr},
                 {"control",
                  {{"kind", "sequential"},
                   {"successor",
                    index + 1 < candidate_count ? nlohmann::json(first_slice + index + 1)
                                                : nlohmann::json(nullptr)}}},
                 {"frontier", "normal"},
                 {"program", nlohmann::json::array()}});
        }
        return document;
    };

    const auto run = [&](assets::ResidencyBudget budget) {
        PlannerFixture fixture(nullptr, budget);
        auto package = package_from_document(make_document(), "prediction-wave-budget.json");
        const auto generation = fixture.manager.source_generation_on_owner();
        assets::MandatoryAssetGate gate(fixture.manager);
        REQUIRE(gate.bind_package_on_owner(package, "glsl-120", generation));

        core::RuntimePresentationSnapshot snapshot;
        snapshot.revision = core::PresentationSnapshotRevision::from_number(154);
        snapshot.mode = core::PresentationRuntimeMode::Ended;
        REQUIRE(gate.begin_on_owner(snapshot).disposition ==
                assets::MandatoryAssetGateDisposition::Ready);
        auto transaction = gate.take_ready_transaction_on_owner();
        REQUIRE(transaction);
        REQUIRE(transaction->commit_on_owner(false));
        fixture.recorder.calls.clear();

        const runtime::ActiveScenePredictionRoot root{.scene = id<core::SceneId>("prediction-wave"),
                                                      .position = core::SceneFramePosition{}};
        CHECK(gate.update_active_scene_prediction_on_owner(&root).empty());
        return fixture.recorder.calls;
    };

    SECTION("a saturated Warm allowance stops after the first prediction wave")
    {
        auto budget = generous_budget();
        budget.prepared_cpu_bytes = 512u * 1024u * 1024u;
        budget.gpu_bytes = 64u * 64u * 4u;
        budget.audio_bytes = 512u * 1024u * 1024u;
        const auto calls = run(budget);
        CHECK(std::ranges::find(calls, "texture:project:/assets/images/prediction-wave-0.png") !=
              calls.end());
        CHECK(std::ranges::find(calls, "texture:project:/assets/images/prediction-wave-64.png") ==
              calls.end());
    }

    SECTION("available Warm capacity expands into later prediction waves")
    {
        const auto calls = run(generous_budget());
        CHECK(std::ranges::find(calls,
                                "texture:project:/assets/images/prediction-wave-79.png") !=
              calls.end());
    }
}

TEST_CASE("prediction waves give uncertain sibling branches equal path-depth opportunity",
          "[assets][structured-prefetch][flow-prediction][budget][horizon][branch]")
{
    auto document = read_compiled_project_golden("scene-program");
    auto& prediction = document["flowPrediction"];
    prediction["dependencyGroups"] = nlohmann::json::array(
        {nlohmann::json::array(
             {{{"kind", "asset"},
               {"asset", {{"kind", "asset"}, {"id", "image-arrival-dialogue"}}}}})});
    prediction["supplementalHints"] = nlohmann::json::array();

    nlohmann::json slices = nlohmann::json::array();
    constexpr std::size_t deep_count = 70;
    const auto sibling = deep_count + 1;
    slices.push_back(
        {{"point",
          {{"kind", "scene-entry"}, {"scene", {{"kind", "scene"}, {"id", "opening"}}}}},
         {"dependencyGroups", nlohmann::json::array()},
         {"conditionFalseSuccessor", nullptr},
         {"control",
          {{"kind", "branch"},
           {"branches",
            nlohmann::json::array(
                {{{"condition", {{"kind", "lua-predicate"}, {"source", "unknown_first()"}}},
                  {"target", 1}},
                 {{"condition", {{"kind", "always"}}}, {"target", sibling}}})},
           {"fallback", sibling}}},
         {"frontier", "normal"},
         {"program", nlohmann::json::array()}});
    for (std::size_t index = 0; index < deep_count; ++index) {
        slices.push_back(
            {{"point",
              {{"kind", "scene-step"},
               {"scene", {{"kind", "scene"}, {"id", "opening"}}},
               {"stepId", "deep-wave-" + std::to_string(index)}}},
             {"dependencyGroups", nlohmann::json::array()},
             {"conditionFalseSuccessor", nullptr},
             {"control",
              {{"kind", "sequential"},
               {"successor",
                index + 1 < deep_count ? nlohmann::json(index + 2)
                                       : nlohmann::json(nullptr)}}},
             {"frontier", "normal"},
             {"program", nlohmann::json::array()}});
    }
    slices.push_back(
        {{"point",
          {{"kind", "scene-step"},
           {"scene", {{"kind", "scene"}, {"id", "opening"}}},
           {"stepId", "fair-sibling"}}},
         {"dependencyGroups", nlohmann::json::array({0})},
         {"conditionFalseSuccessor", nullptr},
         {"control", {{"kind", "sequential"}, {"successor", nullptr}}},
         {"frontier", "normal"},
         {"program", nlohmann::json::array()}});
    prediction["slices"] = std::move(slices);

    auto package = package_from_document(std::move(document), "prediction-wave-branch-fairness.json");
    const auto projection = runtime::FlowPredictor(package.project(), 64).predict(
        core::compiled::Entrypoint{id<core::SceneId>("opening")});
    CHECK(std::ranges::any_of(projection.diagnostics, [](const auto& diagnostic) {
        return diagnostic.code == "assets.flow_prediction_structural_limit";
    }));
    CHECK(std::ranges::any_of(projection.entries, [](const auto& entry) {
        const auto* dependency =
            std::get_if<core::compiled::FlowPredictionAssetDependency>(&entry.dependency);
        return dependency != nullptr &&
               dependency->asset == id<core::AssetId>("image-arrival-dialogue");
    }));
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

    assets::PrefetchPlan plan;
    plan.candidates.push_back(
        {.descriptor =
             descriptor(assets::MaterialAssetRequest{.id = "rejected"}, source_generation),
         .prediction = assets::PrefetchPredictionKind::ExpectedNext});
    auto report = planner.replace_generation_on_owner(plan);
    REQUIRE(report);
    REQUIRE(report.value().failures.size() == 1);
    CHECK(report.value().failures[0].diagnostic.code == "assets.material_preparation_unavailable");
    CHECK(report.value().expected_count == 1);
    CHECK(report.value().possible_count == 0);
    CHECK(report.value().submitted_keys.empty());
    CHECK(report.value().expected_count + report.value().possible_count ==
          report.value().submitted_entries.size() + report.value().failures.size());
    CHECK(planner.retained_ticket_count_on_owner() == 0);
}

TEST_CASE("prefetch planner counts deduplicated prediction confidence before submission",
          "[assets][structured-prefetch][flow-prediction]")
{
    PlannerFixture fixture;
    assets::PrefetchPlanner planner(fixture.manager);
    const auto generation = fixture.manager.source_generation_on_owner();
    const auto expected = descriptor(
        assets::TextureAssetRequest{.path = "project:/textures/expected.png"}, generation);
    const auto possible = descriptor(
        assets::TextureAssetRequest{.path = "project:/textures/possible.png"}, generation);

    assets::PrefetchPlan plan;
    plan.candidates = {
        {.descriptor = expected, .prediction = assets::PrefetchPredictionKind::ExpectedNext},
        {.descriptor = expected, .prediction = assets::PrefetchPredictionKind::ExpectedNext},
        {.descriptor = expected, .prediction = assets::PrefetchPredictionKind::PossibleNext},
        {.descriptor = possible, .prediction = assets::PrefetchPredictionKind::PossibleNext},
        {.descriptor = possible, .prediction = assets::PrefetchPredictionKind::PossibleNext},
    };
    auto report = planner.replace_generation_on_owner(plan);
    REQUIRE(report);
    CHECK(report.value().expected_count == 1);
    CHECK(report.value().possible_count == 1);
    CHECK(report.value().submitted_entries.size() == 2);
    CHECK(report.value().failures.empty());
    CHECK(report.value().expected_count + report.value().possible_count ==
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
