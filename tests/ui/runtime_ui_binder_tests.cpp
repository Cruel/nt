#include <catch2/catch_test_macros.hpp>

#include <noveltea/runtime_ui_contracts.hpp>

#include "ui/rmlui/runtime_ui_binder.hpp"

#include <cstddef>
#include <functional>
#include <optional>
#include <utility>
#include <variant>

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

    RecordingRuntimeUiInputSink sink;
    binder.bind_input_sink(&sink);
    binder.bind_layout_gameplay_admission([]() { return false; });
    CHECK_FALSE(binder.dispatch_layout_input(
        noveltea::core::RuntimeInputMessage{noveltea::core::ContinueInput{}}));
    CHECK(sink.gameplay_inputs == 0);

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
