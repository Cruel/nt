#include <catch2/catch_test_macros.hpp>

#include <noveltea/core/compiled_project_codec.hpp>
#include <noveltea/assets/asset_manager.hpp>
#include <noveltea/assets/asset_source.hpp>
#include <noveltea/runtime/running_game.hpp>
#include <noveltea/boundary/running_game_loader.hpp>
#include <noveltea/script/script_runtime.hpp>

#include <nlohmann/json.hpp>

#include <fstream>
#include <iterator>
#include <memory>
#include <string>
#include <string_view>
#include <vector>

using namespace noveltea;

namespace {

nlohmann::json fixture(std::string_view name)
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

runtime::RunningGameLoadInput load_input(nlohmann::json gameplay)
{
    auto decoded = core::decode_compiled_project(gameplay, "gameplay.json");
    REQUIRE(decoded.has_value());
    nlohmann::json entries = nlohmann::json::array({{{"path", "game"}, {"size", 10}}});
    std::vector<core::RuntimePackageFile> files{{"game", 10, std::nullopt}};
    for (const auto& asset : decoded.value().assets()) {
        entries.push_back({{"path", asset.path}, {"size", 10}});
        files.push_back({asset.path, 10, std::nullopt});
    }
    entries.push_back({{"path", "shader-materials.json"}, {"size", 10}});
    entries.push_back({{"path", "shaders/bgfx/glsl-120/sprite.vs.bin"}, {"size", 10}});
    entries.push_back({{"path", "shaders/bgfx/glsl-120/sprite.fs.bin"}, {"size", 10}});
    files.push_back({"shader-materials.json", 10, std::nullopt});
    files.push_back({"shaders/bgfx/glsl-120/sprite.vs.bin", 10, std::nullopt});
    files.push_back({"shaders/bgfx/glsl-120/sprite.fs.bin", 10, std::nullopt});
    nlohmann::json manifest = {
        {"format", "noveltea.runtime-package"},
        {"format_version", 1},
        {"kind", "runtime"},
        {"created_by", "phase-10a-test"},
        {"project",
         {{"name", decoded.value().identity().name},
          {"version", decoded.value().identity().version}}},
        {"shader_variants", nlohmann::json::array({"glsl-120"})},
        {"shader_materials",
         {{"entry", "shader-materials.json"},
          {"schema", "noveltea.shader-materials.v1"},
          {"sources_stripped", true}}},
        {"entries", std::move(entries)},
    };
    auto shader_materials = nlohmann::json::parse(R"json({
      "schema":"noveltea.shader-materials.v1",
      "shaders":{"sprite-shader":{"display_name":"Sprite","roles":["engine-2d"],
        "stages":{"vertex":{"compiled":{"glsl-120":"shaders/bgfx/glsl-120/sprite.vs.bin"}},
                  "fragment":{"compiled":{"glsl-120":"shaders/bgfx/glsl-120/sprite.fs.bin"}}},
        "uniforms":{},"samplers":{}}},
      "materials":{"sprite-material":{"display_name":"Sprite","role":"engine-2d",
        "shader":"sprite-shader","uniforms":{},"textures":{},
        "blend":"premultiplied-alpha"}}
    })json");
    return runtime::RunningGameLoadInput{
        .gameplay = std::move(gameplay),
        .manifest = std::move(manifest),
        .shader_materials = std::move(shader_materials),
        .files = std::move(files),
        .runtime_locale = "en",
    };
}

bool has_code(const core::Diagnostics& diagnostics, std::string_view code)
{
    for (const auto& diagnostic : diagnostics)
        if (diagnostic.code == code)
            return true;
    return false;
}

class PassivePresentationRuntime final : public runtime::PresentationRuntimePort {
public:
    [[nodiscard]] core::Result<runtime::PresentationAcceptance, core::Diagnostics>
    accept(const core::PresentationOperation&) override
    {
        return core::Result<runtime::PresentationAcceptance, core::Diagnostics>::success({true});
    }

    [[nodiscard]] core::Result<runtime::PresentationAcceptance, core::Diagnostics>
    accept(const core::AudioOperation&) override
    {
        return core::Result<runtime::PresentationAcceptance, core::Diagnostics>::success({true});
    }

    [[nodiscard]] const core::PresentationCheckpointStatus&
    checkpoint_status() const noexcept override
    {
        return status;
    }

    void terminate(core::PresentationCancellationReason) override {}

    core::PresentationCheckpointStatus status{core::CheckpointStatusRevision::from_number(1), {}};
};

struct RuntimeFixture {
    std::shared_ptr<assets::MemoryAssetSource> source =
        std::make_shared<assets::MemoryAssetSource>();
    assets::AssetManager assets;
    script::ScriptRuntime scripts;
    PassivePresentationRuntime presentation;
    core::TypedMemorySaveSlotStore saves;

    RuntimeFixture()
    {
        const std::string layout_script = "return { layout = true }";
        source->add("project:/assets/scripts/layout.lua",
                    assets::AssetBytes(layout_script.begin(), layout_script.end()));
        assets.mount("project", source);
        REQUIRE(scripts.initialize({&assets}));
        REQUIRE(scripts.execute("function initialize_fixture() end\n"
                                "function after_enter_start() end\n"
                                "function before_leave_start() end\n"
                                "function can_leave_start() return true end\n"
                                "function can_unlock() return true end\n"
                                "function combine_items() end\n"
                                "function show_hero() return true end\n"
                                "function dynamic_line() return 'Dynamic' end\n"
                                "function run_scene_effect() end\n"
                                "function take_layout_branch() return false end\n"
                                "function can_transition() return false end\n"
                                "function prepare_transition() end\n"
                                "function transition_label() return 'Transition' end\n"
                                "function after_localized_line() end\n"
                                "function show_lua_line() end\n"
                                "function dialogue_line() return 'Dialogue' end\n"
                                "function yielding_dialogue_effect() end\n"
                                "function can_finish_dialogue() return true end\n"
                                "function finish_dialogue() end\n"
                                "function final_choice_label() return 'Finish' end\n"
                                "function hall_description() return 'Hall' end\n"
                                "function key_label() return 'Key' end\n"
                                "function tower_open() return true end\n",
                                "compiled-runtime-fixture"));
    }
};

} // namespace

TEST_CASE("compiled runtime final loader owns package and starts representative entrypoints")
{
    for (const auto* name : {"minimal", "scene-program", "dialogue-program"}) {
        CAPTURE(name);
        RuntimeFixture runtime;
        auto loaded = runtime::load_running_game(load_input(fixture(name)), runtime.scripts,
                                                 runtime.presentation, runtime.saves);
        std::string failure;
        if (!loaded) {
            for (const auto& diagnostic : loaded.error()) {
                failure += diagnostic.code + ": " + diagnostic.message + " @ " +
                           diagnostic.source_path + "\n";
            }
        }
        CAPTURE(failure);
        REQUIRE(loaded.has_value());
        auto& session = loaded.value()->session();
        auto started = session.dispatch(core::RuntimeInputMessage{core::StartRuntimeInput{}});
        CHECK(started.disposition != runtime::RuntimeInputDisposition::Failed);
        CHECK(loaded.value()->package().project().identity().name.size() > 0);
        CHECK(session.gateway().active(session.gateway().generation()));
    }
}

TEST_CASE("compiled runtime rejects malformed package data before session construction")
{
    RuntimeFixture runtime;
    auto input = load_input(fixture("minimal"));
    input.manifest["entries"][0]["path"] = "../game";
    auto loaded = runtime::load_running_game(std::move(input), runtime.scripts,
                                             runtime.presentation, runtime.saves);
    REQUIRE_FALSE(loaded.has_value());
    CHECK(has_code(loaded.error(), "runtime_package.invalid_path"));
}

TEST_CASE("compiled runtime certifies Lua without executing it")
{
    RuntimeFixture runtime;

    auto invalid = fixture("minimal");
    invalid["startupHook"] = {{"source", "local ="}};
    auto rejected = runtime::load_running_game(load_input(std::move(invalid)), runtime.scripts,
                                               runtime.presentation, runtime.saves);
    REQUIRE_FALSE(rejected.has_value());
    CHECK(has_code(rejected.error(), "runtime.lua_certification_failed"));

    auto valid = fixture("minimal");
    valid["startupHook"] = {{"source", "certification_only = true"}};
    auto loaded = runtime::load_running_game(load_input(std::move(valid)), runtime.scripts,
                                             runtime.presentation, runtime.saves);
    REQUIRE(loaded.has_value());
    auto value = runtime.scripts.evaluate_bool("certification_only == nil", "certification-result");
    REQUIRE(value.has_value());
    CHECK(value.value());
}

TEST_CASE("compiled runtime certifies asset-backed layout Lua")
{
    RuntimeFixture runtime;
    const std::string invalid = "local =";
    runtime.source->add("project:/assets/scripts/layout.lua",
                        assets::AssetBytes(invalid.begin(), invalid.end()));

    auto rejected = runtime::load_running_game(
        load_input(fixture("scene-program")), runtime.scripts, runtime.presentation, runtime.saves);
    REQUIRE_FALSE(rejected.has_value());
    CHECK(has_code(rejected.error(), "runtime.lua_certification_failed"));
}

TEST_CASE("compiled runtime certifies room placement and map text Lua")
{
    RuntimeFixture runtime;

    auto invalid_placement = fixture("scene-program");
    invalid_placement["definitions"]["rooms"][0]["placements"][0]["presentation"]["label"] = {
        {"markup", "plain"},
        {"source", {{"kind", "lua-expression"}, {"source", "local ="}}},
    };
    auto rejected_placement =
        runtime::load_running_game(load_input(std::move(invalid_placement)), runtime.scripts,
                                   runtime.presentation, runtime.saves);
    REQUIRE_FALSE(rejected_placement.has_value());
    CHECK(has_code(rejected_placement.error(), "runtime.lua_certification_failed"));

    auto invalid_map_title = fixture("scene-program");
    invalid_map_title["definitions"]["maps"][0]["presentation"]["title"] = {
        {"markup", "plain"},
        {"source", {{"kind", "lua-expression"}, {"source", "local ="}}},
    };
    auto rejected_map_title =
        runtime::load_running_game(load_input(std::move(invalid_map_title)), runtime.scripts,
                                   runtime.presentation, runtime.saves);
    REQUIRE_FALSE(rejected_map_title.has_value());
    CHECK(has_code(rejected_map_title.error(), "runtime.lua_certification_failed"));
}
