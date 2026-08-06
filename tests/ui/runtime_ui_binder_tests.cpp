#include <catch2/catch_test_macros.hpp>

#include <noveltea/runtime_ui_contracts.hpp>

#include "ui/rmlui/runtime_ui_binder.hpp"

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

TEST_CASE("RuntimeUiBinder owns one revisioned gameplay UI subview")
{
    noveltea::core::Diagnostics diagnostics;
    noveltea::ui::rmlui::RuntimeUiBinder binder(diagnostics);

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

TEST_CASE("RuntimeUiBinder emits typed inputs and capabilities through the host seam")
{
    noveltea::core::Diagnostics diagnostics;
    noveltea::ui::rmlui::RuntimeUiBinder binder(diagnostics);

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

TEST_CASE("RuntimeUiBinder captures event outputs without recursively invoking the host sink")
{
    noveltea::core::Diagnostics diagnostics;
    noveltea::ui::rmlui::RuntimeUiBinder binder(diagnostics);
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

TEST_CASE("RuntimeUiBinder Lua API dispatches exact hotspot activation")
{
    noveltea::core::Diagnostics diagnostics;
    noveltea::ui::rmlui::RuntimeUiBinder binder(diagnostics);
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
