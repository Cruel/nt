#include <catch2/catch_test_macros.hpp>

#include <noveltea/core/compiled_package_codec.hpp>
#include <noveltea/core/compiled_project_codec.hpp>
#include <noveltea/core/player_bootstrap.hpp>
#include <noveltea/assets/asset_manager.hpp>
#include <noveltea/assets/asset_source.hpp>
#include <noveltea/runtime/running_game.hpp>
#include <noveltea/boundary/running_game_loader.hpp>
#include <noveltea/script/script_runtime.hpp>

#include <nlohmann/json.hpp>

#include <chrono>
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
    if (!decoded)
        for (const auto& diagnostic : decoded.error())
            UNSCOPED_INFO(diagnostic.code << ": " << diagnostic.message << " @ "
                                          << diagnostic.json_pointer);
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
        {"runtime_api_version", noveltea::core::player_runtime_api_version},
        {"kind", "runtime"},
        {"created_by", "compiled-runtime-test"},
        {"project",
         {{"name", decoded.value().identity().name},
          {"version", decoded.value().identity().version}}},
        {"display",
         {{"reference_resolution",
           {{"width", decoded.value().settings().display.reference_resolution.width},
            {"height", decoded.value().settings().display.reference_resolution.height}}},
          {"world_raster_policy", "capped"},
          {"bar_color", decoded.value().settings().display.bar_color}}},
        {"accessibility",
         {{"ui_scale",
           {{"enabled", decoded.value().settings().accessibility.ui_scale.enabled},
            {"minimum", decoded.value().settings().accessibility.ui_scale.minimum},
            {"maximum", decoded.value().settings().accessibility.ui_scale.maximum}}},
          {"text_scale",
           {{"enabled", decoded.value().settings().accessibility.text_scale.enabled},
            {"minimum", decoded.value().settings().accessibility.text_scale.minimum},
            {"maximum", decoded.value().settings().accessibility.text_scale.maximum}}}}},
        {"shader_variants", nlohmann::json::array({"glsl-120"})},
        {"shader_materials",
         {{"entry", "shader-materials.json"},
          {"schema", "noveltea.shader-materials"},
          {"sources_stripped", true}}},
        {"entries", std::move(entries)},
    };
    auto shader_materials = nlohmann::json::parse(R"json({
      "schema":"noveltea.shader-materials",
      "shaders":{"sprite-shader":{"display_name":"Sprite","roles":["engine-2d"],"role_bindings":{},
        "stages":{"vertex":{"compiled":{"glsl-120":{"runtimePath":"project:/shaders/bgfx/glsl-120/sprite.vs.bin","byteHash":"sha256:0000000000000000000000000000000000000000000000000000000000000000","byteSize":1}}},
                  "fragment":{"compiled":{"glsl-120":{"runtimePath":"project:/shaders/bgfx/glsl-120/sprite.fs.bin","byteHash":"sha256:0000000000000000000000000000000000000000000000000000000000000000","byteSize":1}}}},
        "uniforms":{},"samplers":{}}},
      "materials":{"sprite-material":{"display_name":"Sprite","role":"engine-2d",
        "shader":"sprite-shader","uniforms":{},"textures":{},
        "blend":"premultiplied-alpha"}}
    })json");
    auto decoded_manifest = core::decode_runtime_package_manifest(manifest, "manifest.json");
    REQUIRE(decoded_manifest.has_value());
    auto decoded_shader_materials =
        core::decode_shader_material_manifest(shader_materials, "shader-materials.json");
    REQUIRE(decoded_shader_materials.has_value());
    auto package = core::assemble_compiled_package(
        std::move(*decoded.value_if()), std::move(*decoded_manifest.value_if()),
        std::move(*decoded_shader_materials.value_if()), std::move(files));
    REQUIRE(package.has_value());
    return runtime::RunningGameLoadInput{
        .package = std::move(*package.value_if()),
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
    [[nodiscard]] core::Result<void, core::Diagnostics>
    reconcile_snapshot(const core::RuntimePresentationSnapshot&) override
    {
        ++reconcile_calls;
        return core::Result<void, core::Diagnostics>::success();
    }

    [[nodiscard]] core::Result<runtime::PresentationAcceptance, core::Diagnostics>
    accept(const core::PresentationOperation&) override
    {
        ++presentation_accept_calls;
        return core::Result<runtime::PresentationAcceptance, core::Diagnostics>::success({true});
    }

    [[nodiscard]] core::Result<runtime::PresentationAcceptance, core::Diagnostics>
    accept(const core::AudioOperation&) override
    {
        ++audio_accept_calls;
        return core::Result<runtime::PresentationAcceptance, core::Diagnostics>::success({true});
    }

    [[nodiscard]] const core::PresentationCheckpointStatus&
    checkpoint_status() const noexcept override
    {
        return status;
    }

    void terminate(core::PresentationCancellationReason reason) override
    {
        terminations.push_back(reason);
    }

    core::PresentationCheckpointStatus status{core::CheckpointStatusRevision::from_number(1), {}};
    std::size_t reconcile_calls = 0;
    std::size_t presentation_accept_calls = 0;
    std::size_t audio_accept_calls = 0;
    std::vector<core::PresentationCancellationReason> terminations;
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

TEST_CASE("Room-free Scene and Dialogue project saves restores and completes through RunningGame")
{
    RuntimeFixture runtime;
    auto loaded = runtime::load_running_game(load_input(fixture("canonical-linear")),
                                             runtime.scripts, runtime.presentation, runtime.saves);
    REQUIRE(loaded.has_value());
    auto& game = *loaded.value();

    auto started = game.session().dispatch(core::RuntimeInputMessage{core::StartRuntimeInput{}});
    REQUIRE(started.diagnostics.empty());
    REQUIRE(started.publication);
    CHECK_FALSE(started.publication->gameplay_ui.room);
    REQUIRE(started.publication->gameplay_ui.dialogue);
    CHECK(started.publication->gameplay_ui.dialogue->dialogue.text() == "conversation");
    CHECK(started.publication->gameplay_ui.can_continue);

    const auto slot = core::TypedSaveSlotId::manual(1);
    auto saved = game.session().dispatch(core::RuntimeInputMessage{core::SaveRuntimeInput{slot}});
    REQUIRE(saved.diagnostics.empty());
    const auto save_outcomes = game.session().take_checkpoint_save_outcomes();
    CHECK(std::any_of(save_outcomes.begin(), save_outcomes.end(), [&](const auto& outcome) {
        const auto* succeeded = std::get_if<core::CheckpointWriteSucceeded>(&outcome);
        return succeeded != nullptr && succeeded->slot == slot;
    }));
    REQUIRE(runtime.saves.read_slot(slot));

    auto load_candidate = game.prepare_load_candidate(slot, runtime.scripts, runtime.presentation);
    REQUIRE(load_candidate);
    REQUIRE(load_candidate.value()->initial_result().publication);
    CHECK_FALSE(load_candidate.value()->initial_result().publication->gameplay_ui.room);
    REQUIRE(load_candidate.value()->initial_result().publication->gameplay_ui.dialogue);
    CHECK(load_candidate.value()
              ->initial_result()
              .publication->gameplay_ui.dialogue->dialogue.text() == "conversation");
    auto previous = game.commit_candidate(std::move(load_candidate).value());
    REQUIRE(previous);

    auto completed = game.session().dispatch(core::RuntimeInputMessage{core::ContinueInput{}});
    REQUIRE(completed.diagnostics.empty());
    REQUIRE(completed.publication);
    CHECK_FALSE(completed.publication->gameplay_ui.room);
    CHECK_FALSE(completed.publication->gameplay_ui.dialogue);
    const auto& observations = completed.publication->observations.values;
    const auto state =
        std::find_if(observations.rbegin(), observations.rend(), [](const auto& observation) {
            return std::holds_alternative<core::RuntimeStateObservation>(observation);
        });
    REQUIRE(state != observations.rend());
    const auto& runtime_state = std::get<core::RuntimeStateObservation>(*state);
    CHECK(std::holds_alternative<core::EndedMode>(runtime_state.mode));
    CHECK(runtime_state.game_completed);
}

TEST_CASE("authored fast-forward commits semantic work suppresses one-shots and stops at input")
{
    RuntimeFixture runtime;
    auto loaded = runtime::load_running_game(load_input(fixture("canonical-fast-forward")),
                                             runtime.scripts, runtime.presentation, runtime.saves);
    REQUIRE(loaded.has_value());
    auto& game = *loaded.value();
    const auto count = core::PropertyId::create("count").value();

    auto started = game.session().dispatch(core::RuntimeInputMessage{core::StartRuntimeInput{}});
    REQUIRE(started.diagnostics.empty());
    REQUIRE(started.publication);
    REQUIRE(started.publication->gameplay_ui.scene);
    CHECK(started.publication->gameplay_ui.scene->scene.text() == "fast-forward");
    CHECK(started.publication->gameplay_ui.can_continue);
    REQUIRE(game.session().gateway().global_property(count));
    CHECK(game.session().gateway().global_property(count).value() ==
          core::RuntimeValue{std::int64_t{2}});
    CHECK(runtime.presentation.audio_accept_calls == 0);

    auto skipped = game.session().dispatch(core::RuntimeInputMessage{core::FastForwardInput{}});
    REQUIRE(skipped.diagnostics.empty());
    CHECK(skipped.disposition == runtime::RuntimeInputDisposition::Handled);
    REQUIRE(skipped.publication);
    REQUIRE(skipped.publication->gameplay_ui.scene);
    CHECK(skipped.publication->gameplay_ui.scene->scene.text() == "fast-forward");
    CHECK(skipped.publication->gameplay_ui.can_continue);
    REQUIRE(game.session().gateway().global_property(count));
    CHECK(game.session().gateway().global_property(count).value() ==
          core::RuntimeValue{std::int64_t{3}});
    CHECK(runtime.presentation.audio_accept_calls == 0);
    const auto checkpoint_outcomes = game.session().take_checkpoint_save_outcomes();
    CHECK(std::any_of(
        checkpoint_outcomes.begin(), checkpoint_outcomes.end(), [](const auto& outcome) {
            const auto* succeeded = std::get_if<core::CheckpointWriteSucceeded>(&outcome);
            return succeeded != nullptr && succeeded->slot.is_autosave();
        }));

    auto stopped = game.session().dispatch(core::RuntimeInputMessage{core::FastForwardInput{}});
    REQUIRE(stopped.diagnostics.empty());
    CHECK(stopped.disposition == runtime::RuntimeInputDisposition::Unhandled);
    REQUIRE(game.session().gateway().global_property(count));
    CHECK(game.session().gateway().global_property(count).value() ==
          core::RuntimeValue{std::int64_t{3}});
    CHECK(runtime.presentation.audio_accept_calls == 0);

    auto completed = game.session().dispatch(core::RuntimeInputMessage{core::ContinueInput{}});
    REQUIRE(completed.diagnostics.empty());
    REQUIRE(game.session().gateway().global_property(count));
    CHECK(game.session().gateway().global_property(count).value() ==
          core::RuntimeValue{std::int64_t{9}});
}

TEST_CASE("authored Layout Signal survives restore and resumes its exact mounted Layout wait")
{
    RuntimeFixture runtime;
    auto loaded = runtime::load_running_game(load_input(fixture("canonical-layout-signal")),
                                             runtime.scripts, runtime.presentation, runtime.saves);
    std::string load_failure;
    if (!loaded)
        for (const auto& diagnostic : loaded.error())
            load_failure +=
                diagnostic.code + ": " + diagnostic.message + " @ " + diagnostic.source_path + "\n";
    CAPTURE(load_failure);
    REQUIRE(loaded.has_value());
    auto& game = *loaded.value();
    const auto count = core::PropertyId::create("count").value();
    const auto signal = core::LayoutSignalId::create("confirm").value();
    const auto accepted = core::LayoutSignalFieldId::create("accepted").value();

    auto started = game.session().dispatch(core::RuntimeInputMessage{core::StartRuntimeInput{}});
    std::string start_failure;
    for (const auto& diagnostic : started.diagnostics)
        start_failure +=
            diagnostic.code + ": " + diagnostic.message + " @ " + diagnostic.source_path + "\n";
    CAPTURE(start_failure);
    REQUIRE(started.diagnostics.empty());
    REQUIRE(started.publication);
    const auto mounted =
        std::find_if(started.publication->presentation.layouts.begin(),
                     started.publication->presentation.layouts.end(),
                     [](const auto& layout) { return layout.layout.text() == "stateful-overlay"; });
    REQUIRE(mounted != started.publication->presentation.layouts.end());
    REQUIRE(mounted->occurrence);
    CHECK(std::find(mounted->connected_signals.begin(), mounted->connected_signals.end(), signal) !=
          mounted->connected_signals.end());
    REQUIRE(game.session().gateway().global_property(count));
    CHECK(game.session().gateway().global_property(count).value() ==
          core::RuntimeValue{std::int64_t{2}});

    const auto slot = core::TypedSaveSlotId::manual(3);
    auto saved = game.session().dispatch(core::RuntimeInputMessage{core::SaveRuntimeInput{slot}});
    REQUIRE(saved.diagnostics.empty());
    const auto save_outcomes = game.session().take_checkpoint_save_outcomes();
    CHECK(std::any_of(save_outcomes.begin(), save_outcomes.end(), [&](const auto& outcome) {
        const auto* succeeded = std::get_if<core::CheckpointWriteSucceeded>(&outcome);
        return succeeded != nullptr && succeeded->slot == slot;
    }));

    auto candidate = game.prepare_load_candidate(slot, runtime.scripts, runtime.presentation);
    REQUIRE(candidate);
    REQUIRE(candidate.value()->initial_result().publication);
    const auto& restored_publication = *candidate.value()->initial_result().publication;
    const auto restored =
        std::find_if(restored_publication.presentation.layouts.begin(),
                     restored_publication.presentation.layouts.end(),
                     [](const auto& layout) { return layout.layout.text() == "stateful-overlay"; });
    REQUIRE(restored != restored_publication.presentation.layouts.end());
    REQUIRE(restored->occurrence);
    CHECK(restored->owner != mounted->owner);
    CHECK(std::find(restored->connected_signals.begin(), restored->connected_signals.end(),
                    signal) != restored->connected_signals.end());
    const auto restored_owner = restored->owner;
    const auto restored_key = restored->key;
    const auto restored_occurrence = *restored->occurrence;
    auto previous = game.commit_candidate(std::move(candidate).value());
    REQUIRE(previous);

    auto signaled = game.session().dispatch(core::RuntimeInputMessage{core::LayoutSignalInput{
        restored_owner,
        restored_key,
        restored_occurrence,
        signal,
        {core::LayoutSignalFieldValue{accepted, core::RuntimeValue{true}}}}});
    REQUIRE(signaled.diagnostics.empty());
    CHECK(signaled.disposition == runtime::RuntimeInputDisposition::Handled);
    REQUIRE(signaled.publication);
    REQUIRE(signaled.publication->gameplay_ui.scene);
    CHECK(signaled.publication->gameplay_ui.scene->scene.text() == "layout-signal");
    CHECK(signaled.publication->gameplay_ui.can_continue);
    REQUIRE(game.session().gateway().global_property(count));
    CHECK(game.session().gateway().global_property(count).value() ==
          core::RuntimeValue{std::int64_t{7}});
}

TEST_CASE(
    "staged flashback and repeated Dialogue Handoff resume the exact caller through RunningGame")
{
    RuntimeFixture runtime;
    auto loaded = runtime::load_running_game(load_input(fixture("canonical-flow")), runtime.scripts,
                                             runtime.presentation, runtime.saves);
    REQUIRE(loaded.has_value());
    auto& session = loaded.value()->session();

    auto started = session.dispatch(core::RuntimeInputMessage{core::StartRuntimeInput{}});
    REQUIRE(started.diagnostics.empty());
    REQUIRE(started.publication);
    REQUIRE(started.publication->gameplay_ui.dialogue);
    CHECK(started.publication->gameplay_ui.dialogue->dialogue.text() == "handoff");
    REQUIRE(started.publication->gameplay_ui.dialogue->segment);
    CHECK(started.publication->gameplay_ui.dialogue->segment->text() == "first-line");
    CHECK_FALSE(started.publication->presentation.current_room);
    CHECK(started.publication->gameplay_ui.can_continue);

    auto handed_off_first = session.dispatch(core::RuntimeInputMessage{core::ContinueInput{}});
    REQUIRE(handed_off_first.diagnostics.empty());
    REQUIRE(handed_off_first.publication);
    CHECK_FALSE(handed_off_first.publication->gameplay_ui.dialogue);
    REQUIRE(handed_off_first.publication->gameplay_ui.scene);
    CHECK(handed_off_first.publication->gameplay_ui.scene->scene.text() == "handoff-parent");
    CHECK_FALSE(handed_off_first.publication->presentation.current_room);

    auto flashback = session.dispatch(
        core::RuntimeInputMessage{core::AdvanceTimeInput{std::chrono::microseconds{0}}});
    REQUIRE(flashback.diagnostics.empty());
    REQUIRE(flashback.publication);
    CHECK_FALSE(flashback.publication->gameplay_ui.dialogue);
    REQUIRE(flashback.publication->gameplay_ui.scene);
    CHECK(flashback.publication->gameplay_ui.scene->scene.text() == "flashback");
    CHECK_FALSE(flashback.publication->presentation.current_room);
    REQUIRE(flashback.publication->presentation.background);
    REQUIRE(flashback.publication->presentation.background->asset);
    CHECK(flashback.publication->presentation.background->asset->text() == "image-main");
    REQUIRE(flashback.publication->presentation.background->material);
    CHECK(flashback.publication->presentation.background->material->text() == "sprite-material");
    CHECK(flashback.publication->presentation.background->fit ==
          core::compiled::BackgroundFit::Contain);
    CHECK(flashback.publication->gameplay_ui.can_continue);

    auto resumed_first = session.dispatch(core::RuntimeInputMessage{core::ContinueInput{}});
    REQUIRE(resumed_first.diagnostics.empty());
    REQUIRE(resumed_first.publication);
    REQUIRE(resumed_first.publication->gameplay_ui.dialogue);
    CHECK(resumed_first.publication->gameplay_ui.dialogue->dialogue.text() == "handoff");
    REQUIRE(resumed_first.publication->gameplay_ui.dialogue->segment);
    CHECK(resumed_first.publication->gameplay_ui.dialogue->segment->text() == "second-line");
    CHECK_FALSE(resumed_first.publication->presentation.current_room);
    CHECK_FALSE(resumed_first.publication->presentation.background);
    CHECK_FALSE(resumed_first.publication->gameplay_ui.can_continue);

    auto second_line_ready = session.dispatch(
        core::RuntimeInputMessage{core::AdvanceTimeInput{std::chrono::microseconds{0}}});
    REQUIRE(second_line_ready.diagnostics.empty());
    REQUIRE(second_line_ready.publication);
    REQUIRE(second_line_ready.publication->gameplay_ui.dialogue);
    REQUIRE(second_line_ready.publication->gameplay_ui.dialogue->segment);
    CHECK(second_line_ready.publication->gameplay_ui.dialogue->segment->text() == "second-line");
    CHECK(second_line_ready.publication->gameplay_ui.can_continue);

    auto handed_off_second = session.dispatch(core::RuntimeInputMessage{core::ContinueInput{}});
    REQUIRE(handed_off_second.diagnostics.empty());
    REQUIRE(handed_off_second.publication);
    CHECK_FALSE(handed_off_second.publication->gameplay_ui.dialogue);
    REQUIRE(handed_off_second.publication->gameplay_ui.scene);
    CHECK(handed_off_second.publication->gameplay_ui.scene->scene.text() == "handoff-parent");
    CHECK_FALSE(handed_off_second.publication->presentation.current_room);

    auto interlude = session.dispatch(
        core::RuntimeInputMessage{core::AdvanceTimeInput{std::chrono::microseconds{0}}});
    REQUIRE(interlude.diagnostics.empty());
    REQUIRE(interlude.publication);
    CHECK_FALSE(interlude.publication->gameplay_ui.dialogue);
    REQUIRE(interlude.publication->gameplay_ui.scene);
    CHECK(interlude.publication->gameplay_ui.scene->scene.text() == "handoff-parent");
    CHECK_FALSE(interlude.publication->presentation.current_room);
    CHECK(interlude.publication->gameplay_ui.can_continue);

    auto resumed_second = session.dispatch(core::RuntimeInputMessage{core::ContinueInput{}});
    REQUIRE(resumed_second.diagnostics.empty());
    REQUIRE(resumed_second.publication);
    REQUIRE(resumed_second.publication->gameplay_ui.dialogue);
    CHECK(resumed_second.publication->gameplay_ui.dialogue->dialogue.text() == "handoff");
    REQUIRE(resumed_second.publication->gameplay_ui.dialogue->segment);
    CHECK(resumed_second.publication->gameplay_ui.dialogue->segment->text() == "third-line");
    CHECK_FALSE(resumed_second.publication->presentation.current_room);
    CHECK_FALSE(resumed_second.publication->gameplay_ui.can_continue);

    auto third_line_ready = session.dispatch(
        core::RuntimeInputMessage{core::AdvanceTimeInput{std::chrono::microseconds{0}}});
    REQUIRE(third_line_ready.diagnostics.empty());
    REQUIRE(third_line_ready.publication);
    REQUIRE(third_line_ready.publication->gameplay_ui.dialogue);
    REQUIRE(third_line_ready.publication->gameplay_ui.dialogue->segment);
    CHECK(third_line_ready.publication->gameplay_ui.dialogue->segment->text() == "third-line");
    CHECK(third_line_ready.publication->gameplay_ui.can_continue);

    auto completed = session.dispatch(core::RuntimeInputMessage{core::ContinueInput{}});
    REQUIRE(completed.diagnostics.empty());
    REQUIRE(completed.publication);
    CHECK_FALSE(completed.publication->gameplay_ui.dialogue);
    CHECK_FALSE(completed.publication->presentation.current_room);
    const auto& observations = completed.publication->observations.values;
    const auto state =
        std::find_if(observations.rbegin(), observations.rend(), [](const auto& observation) {
            return std::holds_alternative<core::RuntimeStateObservation>(observation);
        });
    REQUIRE(state != observations.rend());
    const auto& runtime_state = std::get<core::RuntimeStateObservation>(*state);
    CHECK(std::holds_alternative<core::EndedMode>(runtime_state.mode));
    CHECK(runtime_state.game_completed);
}

TEST_CASE("exploration state mutates saves and restores through the canonical RunningGame seam")
{
    RuntimeFixture runtime;
    auto loaded = runtime::load_running_game(load_input(fixture("canonical-exploration")),
                                             runtime.scripts, runtime.presentation, runtime.saves);
    std::string load_failure;
    if (!loaded)
        for (const auto& diagnostic : loaded.error())
            load_failure +=
                diagnostic.code + ": " + diagnostic.message + " @ " + diagnostic.source_path + "\n";
    CAPTURE(load_failure);
    REQUIRE(loaded.has_value());
    auto& game = *loaded.value();

    auto started = game.session().dispatch(core::RuntimeInputMessage{core::StartRuntimeInput{}});
    REQUIRE(started.diagnostics.empty());
    REQUIRE(started.publication);
    REQUIRE(started.publication->gameplay_ui.room);
    CHECK(started.publication->gameplay_ui.room->room.text() == "start");
    REQUIRE_FALSE(started.publication->gameplay_ui.maps.empty());
    CHECK(started.publication->gameplay_ui.maps.front().map.text() == "house");
    REQUIRE(started.publication->gameplay_ui.maps.front().current_room);
    CHECK(started.publication->gameplay_ui.maps.front().current_room->text() == "start");

    const core::compiled::InteractionSubject door_subject =
        core::compiled::FeatureInteractionSubject{core::RoomFeatureRef{
            core::RoomId::create("start").value(), core::FeatureId::create("door").value()}};
    auto selected = game.session().dispatch(
        core::RuntimeInputMessage{core::SelectInteractionSubjectsInput{{door_subject}}});
    REQUIRE(selected.diagnostics.empty());
    REQUIRE(selected.publication);
    CHECK(selected.publication->gameplay_ui.selected_subjects ==
          std::vector<core::compiled::InteractionSubject>{door_subject});
    CHECK(std::any_of(selected.publication->gameplay_ui.verb_offers.begin(),
                      selected.publication->gameplay_ui.verb_offers.end(), [](const auto& offer) {
                          return offer.verb.text() == "inspect" && offer.primary;
                      }));

    const core::compiled::InteractionSubject key_subject =
        core::compiled::InteractableInteractionSubject{
            core::InteractableInstanceId::create("key").value()};
    auto activated =
        game.session().dispatch(core::RuntimeInputMessage{core::PrimaryActivateInput{key_subject}});
    REQUIRE(activated.diagnostics.empty());
    REQUIRE(activated.publication);
    REQUIRE(activated.publication->gameplay_ui.scene);
    CHECK(activated.publication->gameplay_ui.scene->scene.text() == "exploration-mutation");
    CHECK(activated.publication->gameplay_ui.can_continue);

    std::vector<core::GameplayInstanceRef> runtime_instances;
    for (const auto& instance : activated.publication->gameplay_instances)
        if (!instance.declared)
            runtime_instances.push_back(instance.instance);
    CHECK(runtime_instances.size() == 2);

    const auto layout =
        std::find_if(activated.publication->presentation.layouts.begin(),
                     activated.publication->presentation.layouts.end(), [](const auto& candidate) {
                         return candidate.layout.text() == "stateful-overlay";
                     });
    REQUIRE(layout != activated.publication->presentation.layouts.end());
    REQUIRE(layout->occurrence);
    REQUIRE(layout->state_shape);
    const core::PersistableValue layout_value{
        core::PersistableValue::Object{{"page", core::PersistableValue{std::int64_t{4}}}}};
    auto state_committed = game.session().dispatch(core::RuntimeInputMessage{
        core::CommitLayoutStateInput{layout->owner, layout->key, *layout->occurrence,
                                     core::LayoutStateScope::Session, layout_value}});
    REQUIRE(state_committed.diagnostics.empty());
    REQUIRE(state_committed.publication);
    const auto committed_layout = std::find_if(
        state_committed.publication->presentation.layouts.begin(),
        state_committed.publication->presentation.layouts.end(),
        [](const auto& candidate) { return candidate.layout.text() == "stateful-overlay"; });
    REQUIRE(committed_layout != state_committed.publication->presentation.layouts.end());
    CHECK(std::any_of(committed_layout->state_values.begin(), committed_layout->state_values.end(),
                      [&](const auto& state) {
                          return state.scope == core::LayoutStateScope::Session && state.value &&
                                 *state.value == layout_value;
                      }));

    auto released = game.session().dispatch(core::RuntimeInputMessage{core::ContinueInput{}});
    REQUIRE(released.diagnostics.empty());
    REQUIRE(released.publication);
    REQUIRE(released.publication->gameplay_ui.room);
    CHECK(released.publication->gameplay_ui.room->room.text() == "start");

    const auto slot = core::TypedSaveSlotId::manual(2);
    auto saved = game.session().dispatch(core::RuntimeInputMessage{core::SaveRuntimeInput{slot}});
    REQUIRE(saved.diagnostics.empty());
    const auto save_outcomes = game.session().take_checkpoint_save_outcomes();
    CHECK(std::any_of(save_outcomes.begin(), save_outcomes.end(), [&](const auto& outcome) {
        const auto* succeeded = std::get_if<core::CheckpointWriteSucceeded>(&outcome);
        return succeeded != nullptr && succeeded->slot == slot;
    }));

    auto candidate = game.prepare_load_candidate(slot, runtime.scripts, runtime.presentation);
    REQUIRE(candidate);
    REQUIRE(candidate.value()->initial_result().publication);
    const auto& restored_publication = *candidate.value()->initial_result().publication;
    REQUIRE(restored_publication.gameplay_ui.room);
    CHECK(restored_publication.gameplay_ui.room->room.text() == "start");
    std::vector<core::GameplayInstanceRef> restored_runtime_instances;
    for (const auto& instance : restored_publication.gameplay_instances)
        if (!instance.declared)
            restored_runtime_instances.push_back(instance.instance);
    CHECK(restored_runtime_instances == runtime_instances);
    const auto restored_layout =
        std::find_if(restored_publication.presentation.layouts.begin(),
                     restored_publication.presentation.layouts.end(), [](const auto& candidate) {
                         return candidate.layout.text() == "stateful-overlay";
                     });
    REQUIRE(restored_layout != restored_publication.presentation.layouts.end());
    CHECK(std::any_of(restored_layout->state_values.begin(), restored_layout->state_values.end(),
                      [&](const auto& state) {
                          return state.scope == core::LayoutStateScope::Session && state.value &&
                                 *state.value == layout_value;
                      }));
    auto previous = game.commit_candidate(std::move(candidate).value());
    REQUIRE(previous);

    auto hall = game.session().dispatch(core::RuntimeInputMessage{
        core::NavigateRoomInput{core::RoomExitId::create("north-exit").value()}});
    REQUIRE(hall.diagnostics.empty());
    REQUIRE(hall.publication);
    REQUIRE(hall.publication->gameplay_ui.room);
    CHECK(hall.publication->gameplay_ui.room->room.text() == "hall");

    auto cleared_flag =
        game.session().dispatch(core::RuntimeInputMessage{core::SetVariableDebugInput{
            core::PropertyId::create("flag").value(), core::RuntimeValue{false}}});
    REQUIRE(cleared_flag.diagnostics.empty());
    auto returned = game.session().dispatch(core::RuntimeInputMessage{
        core::NavigateRoomInput{core::RoomExitId::create("south-exit").value()}});
    REQUIRE(returned.diagnostics.empty());
    REQUIRE(returned.publication);
    REQUIRE(returned.publication->gameplay_ui.room);
    CHECK(returned.publication->gameplay_ui.room->room.text() == "start");
    const auto north =
        std::find_if(returned.publication->gameplay_ui.room->exits.begin(),
                     returned.publication->gameplay_ui.room->exits.end(),
                     [](const auto& exit) { return exit.exit.text() == "north-exit"; });
    REQUIRE(north != returned.publication->gameplay_ui.room->exits.end());
    CHECK(north->enabled);
}

TEST_CASE("compiled running game preserves declared Gameplay Instance lookup and mutation")
{
    RuntimeFixture runtime;
    auto loaded = runtime::load_running_game(load_input(fixture("comprehensive")), runtime.scripts,
                                             runtime.presentation, runtime.saves);
    REQUIRE(loaded.has_value());

    auto& session = loaded.value()->session();
    const auto started = session.dispatch(core::RuntimeInputMessage{core::StartRuntimeInput{}});
    REQUIRE(started.disposition != runtime::RuntimeInputDisposition::Failed);

    const auto hero = core::CharacterId::create("hero").value();
    const auto key = core::InteractableInstanceId::create("key").value();
    const auto* hero_definition = loaded.value()->package().project().find_character(hero);
    const auto* key_instance = loaded.value()->package().project().find_interactable_instance(key);
    REQUIRE(hero_definition != nullptr);
    REQUIRE(key_instance != nullptr);
    REQUIRE(session.gateway().character_world_state(hero));
    REQUIRE(session.gateway().interactable_state(key));
    CHECK(session.gateway().character_world_state(hero).value().visible ==
          hero_definition->initial_world_state.visible);
    CHECK(session.gateway().interactable_state(key).value().visible == key_instance->visible);

    REQUIRE(
        session.gateway().request_character_world_state(hero, std::nullopt, std::nullopt, false));
    REQUIRE(session.gateway().request_interactable_state(key, std::nullopt, std::nullopt, false));
    const auto settled = session.dispatch(
        core::RuntimeInputMessage{core::AdvanceTimeInput{std::chrono::microseconds{0}}});
    REQUIRE(settled.disposition != runtime::RuntimeInputDisposition::Failed);
    REQUIRE(session.gateway().character_world_state(hero));
    REQUIRE(session.gateway().interactable_state(key));
    CHECK_FALSE(session.gateway().character_world_state(hero).value().visible);
    CHECK_FALSE(session.gateway().interactable_state(key).value().visible);
    CHECK(hero_definition->initial_world_state.visible);
    CHECK(key_instance->visible);
}

TEST_CASE("running-game creation failure leaves presentation integration untouched")
{
    RuntimeFixture runtime;
    auto invalid = fixture("minimal");
    invalid["resources"]["scripts"][0]["source"]["source"] = "local =";

    auto rejected = runtime::load_running_game(load_input(std::move(invalid)), runtime.scripts,
                                               runtime.presentation, runtime.saves);

    REQUIRE_FALSE(rejected.has_value());
    CHECK(has_code(rejected.error(), "runtime.lua_certification_failed"));
    CHECK(runtime.presentation.reconcile_calls == 0);
    CHECK(runtime.presentation.presentation_accept_calls == 0);
    CHECK(runtime.presentation.audio_accept_calls == 0);
    CHECK(runtime.presentation.terminations.empty());
    CHECK(runtime.scripts.is_initialized());
}

TEST_CASE("compiled runtime certifies modules then executes Bootstrap in module-local state")
{
    RuntimeFixture runtime;

    auto invalid = fixture("minimal");
    invalid["resources"]["scripts"][0]["source"]["source"] = "local =";
    auto rejected = runtime::load_running_game(load_input(std::move(invalid)), runtime.scripts,
                                               runtime.presentation, runtime.saves);
    REQUIRE_FALSE(rejected.has_value());
    CHECK(has_code(rejected.error(), "runtime.lua_certification_failed"));

    auto failed = fixture("minimal");
    failed["resources"]["scripts"][0]["source"]["source"] =
        "error('bootstrap executed')\nreturn {}";
    auto execution_rejected = runtime::load_running_game(
        load_input(std::move(failed)), runtime.scripts, runtime.presentation, runtime.saves);
    REQUIRE_FALSE(execution_rejected.has_value());
    CHECK(has_code(execution_rejected.error(), "runtime.project_bootstrap_failed"));

    auto valid = fixture("minimal");
    valid["resources"]["scripts"][0]["source"]["source"] =
        "local certification_only = true\nreturn { ready = certification_only }";
    auto loaded = runtime::load_running_game(load_input(std::move(valid)), runtime.scripts,
                                             runtime.presentation, runtime.saves);
    REQUIRE(loaded.has_value());
    auto value = runtime.scripts.evaluate_bool("certification_only == nil", "bootstrap-isolation");
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
