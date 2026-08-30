#include <catch2/catch_test_macros.hpp>

#include <noveltea/runtime_ui_contracts.hpp>

#include "ui/rmlui/runtime_ui_action_gateway.hpp"

#include <bit>
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

TEST_CASE("RuntimeUiActionGateway opens only the configured exact Player Inventory")
{
    noveltea::core::Diagnostics diagnostics;
    noveltea::ui::rmlui::RuntimeUiActionGateway gateway(diagnostics);
    RecordingRuntimeUiInputSink sink;
    gateway.bind_input_sink(&sink);
    gateway.bind_layout_gameplay_admission([]() { return true; });

    auto inventory_id = noveltea::core::InventoryId::create("player");
    REQUIRE(inventory_id);
    const noveltea::core::compiled::InventoryRef player_inventory{
        noveltea::core::compiled::ProjectInventoryOwner{}, *inventory_id.value_if()};
    noveltea::RuntimeUiGameplayValues values;
    values.revision = 1;
    values.view.inventory.player_inventory = player_inventory;
    values.view.inventory.player_inventory_available = true;
    REQUIRE(gateway.apply(values));

    REQUIRE(gateway.action_present_player_inventory());
    REQUIRE(sink.last_gameplay_input);
    const auto* presented =
        std::get_if<noveltea::core::PresentInventoryInput>(&*sink.last_gameplay_input);
    REQUIRE(presented != nullptr);
    CHECK(presented->inventory == player_inventory);
    CHECK_FALSE(presented->layout);

    values.revision = 2;
    values.view.inventory.player_inventory_available = false;
    REQUIRE(gateway.apply(values));
    CHECK_FALSE(gateway.action_present_player_inventory());
    REQUIRE_FALSE(diagnostics.empty());
    CHECK(diagnostics.back().code == "runtime_ui.player_inventory_unavailable");
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

TEST_CASE("RuntimeUiActionGateway validates save and load actions against current shell slots")
{
    noveltea::core::Diagnostics diagnostics;
    noveltea::ui::rmlui::RuntimeUiActionGateway gateway(diagnostics);
    RecordingRuntimeUiInputSink sink;
    gateway.bind_input_sink(&sink);

    const std::vector<noveltea::core::RuntimeShellSaveSlotView> slots{
        {.slot = noveltea::core::TypedSaveSlotId::autosave(), .occupied = true},
        {.slot = noveltea::core::TypedSaveSlotId::manual(1), .occupied = false},
        {.slot = noveltea::core::TypedSaveSlotId::manual(2), .occupied = true},
    };
    gateway.set_shell_slots(slots);

    CHECK(gateway.action_save_slot(1));
    CHECK(sink.shell_commands == 1);
    REQUIRE(sink.last_shell_command);
    CHECK(*sink.last_shell_command ==
          noveltea::core::RuntimeShellCommand{
              noveltea::core::SaveShellSlotCommand{noveltea::core::TypedSaveSlotId::manual(1)}});

    CHECK_FALSE(gateway.action_save_slot(0));
    CHECK_FALSE(gateway.action_save_slot(9));
    CHECK(sink.shell_commands == 1);
    REQUIRE_FALSE(diagnostics.empty());
    CHECK(diagnostics.back().code == "runtime_ui.invalid_save_slot");

    CHECK(gateway.action_load_slot("autosave", 0));
    CHECK(gateway.action_load_slot("manual", 2));
    CHECK(sink.shell_commands == 3);

    CHECK_FALSE(gateway.action_load_slot("manual", 1));
    CHECK_FALSE(gateway.action_load_slot("manual", 9));
    CHECK_FALSE(gateway.action_load_slot("autosave", 1));
    CHECK(sink.shell_commands == 3);
    REQUIRE_FALSE(diagnostics.empty());
    CHECK(diagnostics.back().code == "runtime_ui.invalid_load_slot");

    gateway.clear_shell_slots();
    CHECK_FALSE(gateway.action_save_slot(1));
    CHECK_FALSE(gateway.action_load_slot("manual", 2));
    CHECK(sink.shell_commands == 3);
}

TEST_CASE("RuntimeUiActionGateway does not expose Hotspot geometry as a Lua gameplay action")
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
    REQUIRE(luaL_dostring(state, "assert(Game.ui.activate_hotspot == nil)") == LUA_OK);
    CHECK_FALSE(sink.last_gameplay_input);

    binder.set_lua_state(nullptr);
    lua_close(state);
}

TEST_CASE("RuntimeUiActionGateway directly submits one-slot offers and progressively builds "
          "multi-slot commands")
{
    noveltea::core::Diagnostics diagnostics;
    noveltea::ui::rmlui::RuntimeUiActionGateway gateway(diagnostics);
    RecordingRuntimeUiInputSink sink;
    gateway.bind_input_sink(&sink);
    gateway.bind_layout_gameplay_admission([]() { return true; });

    const auto room = noveltea::core::RoomId::create("room");
    const auto placement = noveltea::core::RoomPlacementId::create("placement");
    const auto key = noveltea::core::InteractableInstanceId::create("key");
    const auto coin = noveltea::core::InteractableInstanceId::create("coin");
    const auto use = noveltea::core::VerbId::create("use");
    const auto combine = noveltea::core::VerbId::create("combine");
    const auto target = noveltea::core::VerbSlotId::create("target");
    const auto first = noveltea::core::VerbSlotId::create("first");
    const auto second = noveltea::core::VerbSlotId::create("second");
    REQUIRE(room);
    REQUIRE(placement);
    REQUIRE(key);
    REQUIRE(coin);
    REQUIRE(use);
    REQUIRE(combine);
    REQUIRE(target);
    REQUIRE(first);
    REQUIRE(second);

    const noveltea::core::compiled::InteractionSubject key_subject =
        noveltea::core::compiled::InteractableInteractionSubject{key.value()};
    const noveltea::core::compiled::InteractionSubject coin_subject =
        noveltea::core::compiled::InteractableInteractionSubject{coin.value()};

    noveltea::RuntimeUiGameplayValues values;
    values.revision = 1;
    values.view.mode = "room";
    values.view.room = noveltea::core::RoomView{
        .room = room.value(),
        .placements =
            {{.placement = placement.value(),
              .occupants = {{.subject = key_subject, .enabled = true, .visible = true},
                            {.subject = coin_subject, .enabled = true, .visible = true}}}},
        .controls = {{use.value(), "Use", {target.value()}, true},
                     {combine.value(), "Combine", {first.value(), second.value()}, true}}};
    values.view.selected_subjects = {key_subject};
    values.view.verb_offers = {{.verb = use.value(),
                                .slot = target.value(),
                                .label = "Use",
                                .binding_order = {target.value()},
                                .rank = 0,
                                .primary = false},
                               {.verb = combine.value(),
                                .slot = first.value(),
                                .label = "Combine",
                                .binding_order = {first.value(), second.value()},
                                .rank = 0,
                                .primary = false}};
    REQUIRE(gateway.apply(values));

    REQUIRE(gateway.action_invoke_interaction("use"));
    REQUIRE(sink.last_gameplay_input);
    const auto* one_slot =
        std::get_if<noveltea::core::InvokeInteractionInput>(&*sink.last_gameplay_input);
    REQUIRE(one_slot != nullptr);
    REQUIRE(one_slot->bindings.size() == 1);
    CHECK(one_slot->bindings.front().slot_id == target.value());
    CHECK(one_slot->bindings.front().subject == key_subject);
    CHECK_FALSE(gateway.command_builder_draft().active);

    REQUIRE(gateway.action_invoke_interaction("combine"));
    REQUIRE(sink.last_gameplay_input);
    CHECK(std::holds_alternative<noveltea::core::BeginCommandBuilderInput>(
        *sink.last_gameplay_input));
    auto draft = gateway.command_builder_draft();
    REQUIRE(draft.active);
    CHECK(draft.verb_id == "combine");
    REQUIRE(draft.bound_slots.size() == 1);
    CHECK(draft.bound_slots.front() == "first");
    CHECK(draft.focused_slot == "second");
    CHECK_FALSE(draft.complete);

    values.revision = 2;
    values.view.command_builder.active = true;
    values.view.command_builder.occurrence =
        noveltea::core::CommandBuilderOccurrenceId::from_number(7);
    REQUIRE(gateway.apply(values));

    const auto inputs_before_press = sink.gameplay_inputs;
    REQUIRE(gateway.action_primary_activate("interactable", "coin"));
    CHECK(sink.gameplay_inputs == inputs_before_press + 1);
    REQUIRE(sink.last_gameplay_input);
    const auto* captured =
        std::get_if<noveltea::core::CommandBuilderSubjectPressInput>(&*sink.last_gameplay_input);
    REQUIRE(captured != nullptr);
    CHECK(captured->subject == coin_subject);

    values.revision = 3;
    values.view.command_builder.capture_revision = 1;
    values.view.command_builder.captured_subject = coin_subject;
    REQUIRE(gateway.apply(values));
    CHECK(sink.gameplay_inputs == inputs_before_press + 2);
    REQUIRE(sink.last_gameplay_input);
    const auto* watch =
        std::get_if<noveltea::core::UpdateCommandBuilderWatchInput>(&*sink.last_gameplay_input);
    REQUIRE(watch != nullptr);
    CHECK(watch->occurrence == noveltea::core::CommandBuilderOccurrenceId::from_number(7));
    REQUIRE(watch->watched_subjects.size() == 2);
    CHECK(watch->watched_subjects[0] == key_subject);
    CHECK(watch->watched_subjects[1] == coin_subject);
    draft = gateway.command_builder_draft();
    CHECK(draft.complete);
    CHECK(draft.focused_slot.empty());
    REQUIRE(draft.bound_slots.size() == 2);
    CHECK(draft.bound_slots[1] == "second");

    const auto inputs_before_rebind = sink.gameplay_inputs;
    REQUIRE(gateway.action_rebind_command_builder("second"));
    CHECK(sink.gameplay_inputs == inputs_before_rebind + 1);
    REQUIRE(sink.last_gameplay_input);
    watch = std::get_if<noveltea::core::UpdateCommandBuilderWatchInput>(&*sink.last_gameplay_input);
    REQUIRE(watch != nullptr);
    REQUIRE(watch->watched_subjects.size() == 1);
    CHECK(watch->watched_subjects.front() == key_subject);
    draft = gateway.command_builder_draft();
    CHECK_FALSE(draft.complete);
    CHECK(draft.focused_slot == "second");
    REQUIRE(draft.bound_slots.size() == 1);
    CHECK(draft.bound_slots.front() == "first");

    REQUIRE(gateway.action_primary_activate("interactable", "coin"));
    values.revision = 4;
    values.view.command_builder.capture_revision = 2;
    values.view.command_builder.captured_subject = coin_subject;
    REQUIRE(gateway.apply(values));
    draft = gateway.command_builder_draft();
    CHECK(draft.complete);
    CHECK(draft.focused_slot.empty());

    REQUIRE(gateway.action_submit_command_builder());
    REQUIRE(sink.last_gameplay_input);
    const auto* submitted =
        std::get_if<noveltea::core::SubmitCommandBuilderInput>(&*sink.last_gameplay_input);
    REQUIRE(submitted != nullptr);
    CHECK(submitted->occurrence == noveltea::core::CommandBuilderOccurrenceId::from_number(7));
    CHECK(submitted->verb == combine.value());
    REQUIRE(submitted->bindings.size() == 2);
    CHECK(submitted->bindings[0].subject == key_subject);
    CHECK(submitted->bindings[1].subject == coin_subject);
}

TEST_CASE("RuntimeUiActionGateway exposes replacement Command Builder transport through Game.ui")
{
    noveltea::core::Diagnostics diagnostics;
    noveltea::ui::rmlui::RuntimeUiActionGateway gateway(diagnostics);
    RecordingRuntimeUiInputSink sink;
    gateway.bind_input_sink(&sink);
    gateway.bind_layout_gameplay_admission([]() { return true; });

    noveltea::RuntimeUiGameplayValues values;
    values.revision = 1;
    values.view.mode = "room";
    REQUIRE(gateway.apply(values));

    lua_State* state = luaL_newstate();
    REQUIRE(state != nullptr);
    luaL_openlibs(state);
    gateway.set_lua_state(state);

    REQUIRE(luaL_dostring(state, "assert(Game.ui.begin_command_builder({"
                                 "  { kind = 'interactable', id = 'key' }"
                                 "}))") == LUA_OK);
    REQUIRE(sink.last_gameplay_input);
    const auto* begun =
        std::get_if<noveltea::core::BeginCommandBuilderInput>(&*sink.last_gameplay_input);
    REQUIRE(begun);
    REQUIRE(begun->watched_subjects.size() == 1);
    CHECK(begun->watched_subjects.front() ==
          noveltea::core::compiled::InteractionSubject{
              noveltea::core::compiled::InteractableInteractionSubject{
                  noveltea::core::InteractableInstanceId::create("key").value()}});

    values.revision = 2;
    values.view.command_builder.active = true;
    values.view.command_builder.occurrence =
        noveltea::core::CommandBuilderOccurrenceId::from_number(17);
    REQUIRE(gateway.apply(values));

    REQUIRE(luaL_dostring(state, "assert(Game.ui.set_command_builder_watch({"
                                 "  { kind = 'interactable', id = 'key' },"
                                 "  { kind = 'feature', id = 'room:room#door' }"
                                 "}))") == LUA_OK);
    REQUIRE(sink.last_gameplay_input);
    const auto* watched =
        std::get_if<noveltea::core::UpdateCommandBuilderWatchInput>(&*sink.last_gameplay_input);
    REQUIRE(watched);
    CHECK(watched->occurrence == noveltea::core::CommandBuilderOccurrenceId::from_number(17));
    REQUIRE(watched->watched_subjects.size() == 2);
    CHECK(watched->watched_subjects[1] ==
          noveltea::core::compiled::InteractionSubject{
              noveltea::core::compiled::FeatureInteractionSubject{noveltea::core::RoomFeatureRef{
                  noveltea::core::RoomId::create("room").value(),
                  noveltea::core::FeatureId::create("door").value()}}});

    REQUIRE(luaL_dostring(
                state, "assert(Game.ui.submit_command_builder('combine', {"
                       "  { slotId = 'first', subject = { kind = 'interactable', id = 'key' } },"
                       "  { slotId = 'second', subject = { kind = 'interactable', id = 'coin' } }"
                       "}))") == LUA_OK);
    REQUIRE(sink.last_gameplay_input);
    const auto* submitted =
        std::get_if<noveltea::core::SubmitCommandBuilderInput>(&*sink.last_gameplay_input);
    REQUIRE(submitted);
    CHECK(submitted->occurrence == noveltea::core::CommandBuilderOccurrenceId::from_number(17));
    CHECK(submitted->verb == noveltea::core::VerbId::create("combine").value());
    REQUIRE(submitted->bindings.size() == 2);
    CHECK(submitted->bindings[1].slot_id == noveltea::core::VerbSlotId::create("second").value());
    CHECK(submitted->bindings[1].subject ==
          noveltea::core::compiled::InteractionSubject{
              noveltea::core::compiled::InteractableInteractionSubject{
                  noveltea::core::InteractableInstanceId::create("coin").value()}});

    const auto before_invalid = sink.gameplay_inputs;
    REQUIRE(
        luaL_dostring(
            state,
            "assert(not Game.ui.set_command_builder_watch({{ kind = 'feature', id = 'door' }}))") ==
        LUA_OK);
    CHECK(sink.gameplay_inputs == before_invalid);
    REQUIRE_FALSE(diagnostics.empty());
    CHECK(diagnostics.back().code == "runtime_ui.invalid_command_builder_subject");

    gateway.set_lua_state(nullptr);
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
    const auto interactable = noveltea::core::InteractableInstanceId::create("key");
    const auto hidden_interactable = noveltea::core::InteractableInstanceId::create("hidden-key");
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
        .frame = std::bit_cast<noveltea::core::FlowFrameId>(std::uint64_t{1}),
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
        .controls = {{verb_enabled.value(),
                      "Inspect",
                      {noveltea::core::VerbSlotId::create("target").value()},
                      true},
                     {verb_disabled.value(),
                      "Use",
                      {noveltea::core::VerbSlotId::create("target").value()},
                      false}}};
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
