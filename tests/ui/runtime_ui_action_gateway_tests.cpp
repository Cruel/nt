#include <catch2/catch_test_macros.hpp>

#include <noveltea/runtime_ui_contracts.hpp>

#include "ui/rmlui/runtime_ui_action_gateway.hpp"

#include <cstddef>
#include <functional>
#include <optional>
#include <utility>
#include <variant>

#include <lua.hpp>

namespace {

class RecordingRuntimeUiInputSink final : public noveltea::RuntimeUiInputSink {
public:
    [[nodiscard]] bool submit_gameplay_input(noveltea::core::RuntimeInputMessage input) override
    {
        ++gameplay_inputs;
        last_gameplay_input = std::move(input);
        return true;
    }

    [[nodiscard]] bool submit_shell_command(noveltea::core::RuntimeShellCommand command) override
    {
        ++shell_commands;
        last_shell_command = std::move(command);
        return true;
    }

    [[nodiscard]] bool dispatch_layout_event(noveltea::core::MountedLayoutOwner owner,
                                             const std::function<bool()>& dispatch) override
    {
        ++layout_events;
        last_layout_owner = owner;
        return dispatch && dispatch();
    }

    std::size_t gameplay_inputs = 0;
    std::size_t shell_commands = 0;
    std::size_t layout_events = 0;
    std::optional<noveltea::core::RuntimeInputMessage> last_gameplay_input;
    std::optional<noveltea::core::RuntimeShellCommand> last_shell_command;
    noveltea::core::MountedLayoutOwner last_layout_owner =
        noveltea::core::MountedLayoutOwner::Gameplay;
};

} // namespace

TEST_CASE("RuntimeUiActionGateway owns one revisioned gameplay UI subview")
{
    noveltea::core::Diagnostics diagnostics;
    noveltea::ui::rmlui::RuntimeUiActionGateway binder(diagnostics);

    noveltea::RuntimeUiGameplayValues values;
    values.revision = 2;
    values.view.mode = "current";
    REQUIRE(binder.apply(values));
    REQUIRE(binder.view());
    CHECK(binder.revision() == 2);
    CHECK(binder.view()->mode == "current");

    values.revision = 1;
    values.view.mode = "stale";
    CHECK_FALSE(binder.apply(values));
    REQUIRE(binder.view());
    CHECK(binder.revision() == 2);
    CHECK(binder.view()->mode == "current");
    REQUIRE_FALSE(diagnostics.empty());
    CHECK(diagnostics.back().code == "runtime_ui.stale_gameplay_values");

    binder.clear_gameplay_values();
    CHECK_FALSE(binder.view());
    CHECK(binder.revision() == 0);
}

TEST_CASE("RuntimeUiActionGateway emits typed inputs and capabilities through the host seam")
{
    noveltea::core::Diagnostics diagnostics;
    noveltea::ui::rmlui::RuntimeUiActionGateway binder(diagnostics);

    CHECK_FALSE(binder.dispatch_input(
        noveltea::core::RuntimeInputMessage{noveltea::core::ContinueInput{}}));
    REQUIRE_FALSE(diagnostics.empty());
    CHECK(diagnostics.back().code == "runtime_ui.input_sink_unavailable");

    bool dispatched_without_sink = false;
    CHECK(binder.dispatch_layout_event(noveltea::core::MountedLayoutOwner::Gameplay,
                                       [&dispatched_without_sink]() {
                                           dispatched_without_sink = true;
                                           return true;
                                       }));
    CHECK(dispatched_without_sink);

    RecordingRuntimeUiInputSink sink;
    binder.bind_input_sink(&sink);
    binder.bind_layout_gameplay_admission([]() { return false; });
    CHECK_FALSE(binder.dispatch_layout_input(
        noveltea::core::RuntimeInputMessage{noveltea::core::ContinueInput{}}));
    CHECK(sink.gameplay_inputs == 0);
    REQUIRE_FALSE(diagnostics.empty());
    CHECK(diagnostics.back().code == "runtime_ui.layout_input_blocked");

    binder.bind_layout_gameplay_admission([]() { return true; });
    CHECK(binder.dispatch_layout_input(
        noveltea::core::RuntimeInputMessage{noveltea::core::ContinueInput{}}));
    CHECK(sink.gameplay_inputs == 1);
    REQUIRE(sink.last_gameplay_input);
    CHECK(std::holds_alternative<noveltea::core::ContinueInput>(*sink.last_gameplay_input));

    bool dispatched = false;
    CHECK(binder.dispatch_layout_event(noveltea::core::MountedLayoutOwner::Shell, [&dispatched]() {
        dispatched = true;
        return true;
    }));
    CHECK(dispatched);
    CHECK(sink.layout_events == 1);
    CHECK(sink.last_layout_owner == noveltea::core::MountedLayoutOwner::Shell);
}

TEST_CASE(
    "RuntimeUiActionGateway captures event outputs without recursively invoking the host sink")
{
    noveltea::core::Diagnostics diagnostics;
    noveltea::ui::rmlui::RuntimeUiActionGateway binder(diagnostics);
    RecordingRuntimeUiInputSink sink;
    binder.bind_input_sink(&sink);

    binder.begin_event_capture();
    CHECK(binder.dispatch_input(
        noveltea::core::RuntimeInputMessage{noveltea::core::ContinueInput{}}));
    CHECK(binder.dispatch_shell_command(
        noveltea::core::RuntimeShellCommand{noveltea::core::OpenPauseShellCommand{}}));
    CHECK(sink.gameplay_inputs == 0);
    CHECK(sink.shell_commands == 0);

    auto captured = binder.finish_event_capture();
    REQUIRE(captured.runtime_inputs.size() == 1);
    CHECK(std::holds_alternative<noveltea::core::ContinueInput>(captured.runtime_inputs.front()));
    REQUIRE(captured.shell_commands.size() == 1);
    CHECK(std::holds_alternative<noveltea::core::OpenPauseShellCommand>(
        captured.shell_commands.front()));

    CHECK(binder.dispatch_input(
        noveltea::core::RuntimeInputMessage{noveltea::core::ContinueInput{}}));
    CHECK(sink.gameplay_inputs == 1);
}

TEST_CASE("RuntimeUiActionGateway Lua API dispatches exact hotspot activation")
{
    noveltea::core::Diagnostics diagnostics;
    noveltea::ui::rmlui::RuntimeUiActionGateway binder(diagnostics);
    RecordingRuntimeUiInputSink sink;
    binder.bind_input_sink(&sink);
    binder.bind_layout_gameplay_admission([]() { return true; });
    noveltea::RuntimeUiGameplayValues values;
    values.revision = 1;
    values.view.mode = "room";
    REQUIRE(binder.apply(values));

    lua_State* state = luaL_newstate();
    REQUIRE(state != nullptr);
    luaL_openlibs(state);
    binder.set_lua_state(state);
    REQUIRE(
        luaL_dostring(
            state, "assert(Game.ui.activate_hotspot('interactable-hotspot', 'key', 'primary'))") ==
        LUA_OK);
    REQUIRE(sink.last_gameplay_input);
    const auto* activation =
        std::get_if<noveltea::core::ActivateHotspotInput>(&*sink.last_gameplay_input);
    REQUIRE(activation != nullptr);
    CHECK(activation->hotspot ==
          noveltea::core::compiled::HotspotRef{noveltea::core::compiled::InteractableHotspotRef{
              noveltea::core::InteractableId::create("key").value(),
              noveltea::core::HotspotId::create("primary").value()}});

    binder.set_lua_state(nullptr);
    lua_close(state);
}

TEST_CASE("RuntimeUiActionGateway rejects stale hidden and disabled typed gameplay actions "
          "independent of "
          "DOM markup")
{
    noveltea::core::Diagnostics diagnostics;
    noveltea::ui::rmlui::RuntimeUiActionGateway binder(diagnostics);
    RecordingRuntimeUiInputSink sink;
    binder.bind_input_sink(&sink);
    binder.bind_layout_gameplay_admission([]() { return true; });

    const auto scene = noveltea::core::SceneId::create("scene");
    const auto step = noveltea::core::SceneStepId::create("step");
    const auto scene_enabled = noveltea::core::SceneChoiceOptionId::create("scene-enabled");
    const auto scene_disabled = noveltea::core::SceneChoiceOptionId::create("scene-disabled");
    const auto dialogue = noveltea::core::DialogueId::create("dialogue");
    const auto block = noveltea::core::DialogueBlockId::create("block");
    const auto dialogue_enabled = noveltea::core::DialogueEdgeId::create("dialogue-enabled");
    const auto dialogue_disabled = noveltea::core::DialogueEdgeId::create("dialogue-disabled");
    const auto room = noveltea::core::RoomId::create("room");
    const auto target = noveltea::core::RoomId::create("target");
    const auto exit_enabled = noveltea::core::RoomExitId::create("exit-enabled");
    const auto exit_disabled = noveltea::core::RoomExitId::create("exit-disabled");
    const auto placement = noveltea::core::RoomPlacementId::create("placement");
    const auto interactable = noveltea::core::InteractableId::create("key");
    const auto hidden_interactable = noveltea::core::InteractableId::create("hidden-key");
    const auto character = noveltea::core::CharacterId::create("alice");
    const auto disabled_character = noveltea::core::CharacterId::create("bob");
    const auto verb_enabled = noveltea::core::VerbId::create("inspect");
    const auto verb_disabled = noveltea::core::VerbId::create("use");
    REQUIRE(scene);
    REQUIRE(step);
    REQUIRE(scene_enabled);
    REQUIRE(scene_disabled);
    REQUIRE(dialogue);
    REQUIRE(block);
    REQUIRE(dialogue_enabled);
    REQUIRE(dialogue_disabled);
    REQUIRE(room);
    REQUIRE(target);
    REQUIRE(exit_enabled);
    REQUIRE(exit_disabled);
    REQUIRE(placement);
    REQUIRE(interactable);
    REQUIRE(hidden_interactable);
    REQUIRE(character);
    REQUIRE(disabled_character);
    REQUIRE(verb_enabled);
    REQUIRE(verb_disabled);

    noveltea::RuntimeUiGameplayValues values;
    values.revision = 1;
    values.view.scene =
        noveltea::core::SceneView{.scene = scene.value(),
                                  .choice = noveltea::core::SceneChoiceState{
                                      .scene = scene.value(),
                                      .step = step.value(),
                                      .options = {{scene_enabled.value(), "Enabled", true},
                                                  {scene_disabled.value(), "Disabled", false}}}};
    values.view.dialogue = noveltea::core::DialogueView{
        .dialogue = dialogue.value(),
        .choice = noveltea::core::DialogueChoiceState{
            .dialogue = dialogue.value(),
            .block = block.value(),
            .options = {{dialogue_enabled.value(), "Enabled", true},
                        {dialogue_disabled.value(), "Disabled", false}}}};
    values.view.room = noveltea::core::RoomView{
        .room = room.value(),
        .placements = {{.placement = placement.value(),
                        .occupants = {{.subject =
                                           noveltea::core::compiled::InteractableInteractionSubject{
                                               interactable.value()},
                                       .enabled = true,
                                       .visible = true},
                                      {.subject =
                                           noveltea::core::compiled::InteractableInteractionSubject{
                                               hidden_interactable.value()},
                                       .enabled = true,
                                       .visible = false},
                                      {.subject =
                                           noveltea::core::compiled::CharacterInteractionSubject{
                                               character.value()},
                                       .enabled = true,
                                       .visible = true},
                                      {.subject =
                                           noveltea::core::compiled::CharacterInteractionSubject{
                                               disabled_character.value()},
                                       .enabled = false,
                                       .visible = true}}}},
        .exits = {{exit_enabled.value(), target.value(),
                   noveltea::core::compiled::RoomExitDirection::North, "Enabled", true},
                  {exit_disabled.value(), target.value(),
                   noveltea::core::compiled::RoomExitDirection::South, "Disabled", false}},
        .controls = {{verb_enabled.value(), "Inspect", 1, false, true},
                     {verb_disabled.value(), "Use", 1, false, false}}};
    REQUIRE(binder.apply(values));

    lua_State* state = luaL_newstate();
    REQUIRE(state != nullptr);
    luaL_openlibs(state);
    binder.set_lua_state(state);

    const auto expect_rejected = [&](const char* script, std::string_view code) {
        const auto before = sink.gameplay_inputs;
        REQUIRE(luaL_dostring(state, script) == LUA_OK);
        CHECK(sink.gameplay_inputs == before);
        REQUIRE_FALSE(diagnostics.empty());
        CHECK(diagnostics.back().code == code);
    };

    expect_rejected("assert(not Game.ui.choose_scene('scene-disabled'))",
                    "runtime_ui.invalid_scene_choice");
    expect_rejected("assert(not Game.ui.choose_scene('scene-stale'))",
                    "runtime_ui.invalid_scene_choice");
    expect_rejected("assert(not Game.ui.choose_dialogue('dialogue-disabled'))",
                    "runtime_ui.invalid_dialogue_choice");
    expect_rejected("assert(not Game.ui.navigate_room('exit-disabled'))",
                    "runtime_ui.invalid_room_exit");
    expect_rejected("assert(not Game.ui.toggle_interactable('hidden-key'))",
                    "runtime_ui.invalid_interactable");
    expect_rejected("assert(not Game.ui.toggle_character('bob'))", "runtime_ui.invalid_character");
    expect_rejected("assert(not Game.ui.invoke_interaction('use'))",
                    "runtime_ui.invalid_interaction");

    REQUIRE(luaL_dostring(state, "assert(Game.ui.choose_scene('scene-enabled'))") == LUA_OK);
    REQUIRE(luaL_dostring(state, "assert(Game.ui.choose_dialogue('dialogue-enabled'))") == LUA_OK);
    REQUIRE(luaL_dostring(state, "assert(Game.ui.navigate_room('exit-enabled'))") == LUA_OK);
    REQUIRE(luaL_dostring(state, "assert(Game.ui.toggle_interactable('key'))") == LUA_OK);
    REQUIRE(luaL_dostring(state, "assert(Game.ui.toggle_character('alice'))") == LUA_OK);
    REQUIRE(luaL_dostring(state, "assert(Game.ui.invoke_interaction('inspect'))") == LUA_OK);
    CHECK(sink.gameplay_inputs == 6);

    values.revision = 2;
    values.view.scene->choice.reset();
    REQUIRE(binder.apply(values));
    expect_rejected("assert(not Game.ui.choose_scene('scene-enabled'))",
                    "runtime_ui.invalid_scene_choice");

    binder.set_lua_state(nullptr);
    lua_close(state);
}
