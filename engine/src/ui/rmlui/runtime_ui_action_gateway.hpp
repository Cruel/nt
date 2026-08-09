#pragma once

#include "noveltea/runtime_ui_contracts.hpp"

#include <cstdint>
#include <functional>
#include <optional>
#include <string_view>
#include <vector>

struct lua_State;

namespace noveltea::ui::rmlui {

class RuntimeUiActionGateway {
public:
    explicit RuntimeUiActionGateway(core::Diagnostics& diagnostics);
    ~RuntimeUiActionGateway();

    RuntimeUiActionGateway(const RuntimeUiActionGateway&) = delete;
    RuntimeUiActionGateway& operator=(const RuntimeUiActionGateway&) = delete;

    void set_lua_state(lua_State* state) noexcept;
    void bind_input_sink(RuntimeUiInputSink* sink) noexcept;
    void bind_layout_gameplay_admission(std::function<bool()> admission);

    [[nodiscard]] bool apply(const RuntimeUiGameplayValues& values);
    [[nodiscard]] bool can_apply(const RuntimeUiGameplayValues& values) const noexcept;
    void commit(RuntimeUiGameplayValues values) noexcept;
    void clear_gameplay_values();
    void set_shell_slots(const std::vector<core::RuntimeShellSaveSlotView>& slots);
    void clear_shell_slots() noexcept;

    [[nodiscard]] const core::TypedRuntimeUIViewState* view() const noexcept;
    [[nodiscard]] std::uint64_t revision() const noexcept;
    [[nodiscard]] bool has_input_sink() const noexcept { return m_input_sink != nullptr; }

    [[nodiscard]] bool dispatch_input(const core::RuntimeInputMessage& input);
    [[nodiscard]] bool dispatch_layout_input(const core::RuntimeInputMessage& input);
    [[nodiscard]] bool dispatch_shell_command(const core::RuntimeShellCommand& command);
    [[nodiscard]] bool dispatch_layout_event(core::MountedLayoutOwner owner,
                                             const std::function<bool()>& dispatch);

    [[nodiscard]] bool action_continue();
    [[nodiscard]] bool action_choose(std::string kind, std::string id);
    [[nodiscard]] bool action_navigate_room(std::string id);
    [[nodiscard]] bool action_toggle_subject(std::string kind, std::string id);
    [[nodiscard]] bool action_clear_selection();
    [[nodiscard]] bool action_invoke_interaction(std::string id);
    [[nodiscard]] bool action_save_slot(std::uint64_t number);
    [[nodiscard]] bool action_load_slot(std::string kind, std::uint64_t number);

    void begin_event_capture() noexcept;
    [[nodiscard]] RuntimeUiEventResult finish_event_capture() noexcept;

private:
    struct ShellSlotState {
        core::TypedSaveSlotId slot;
        bool occupied = false;
    };

    void install_lua_api();
    void remove_lua_api() noexcept;
    [[nodiscard]] bool invalid(std::string code, std::string message);
    [[nodiscard]] bool require_view();
    [[nodiscard]] const ShellSlotState* shell_slot(core::TypedSaveSlotId slot) const noexcept;

    core::Diagnostics& m_diagnostics;
    lua_State* m_lua_state = nullptr;
    RuntimeUiInputSink* m_input_sink = nullptr;
    std::function<bool()> m_layout_gameplay_admission;
    std::optional<RuntimeUiGameplayValues> m_values;
    std::vector<ShellSlotState> m_shell_slots;
    bool m_event_capture_active = false;
    std::vector<core::RuntimeInputMessage> m_captured_runtime_inputs;
    std::vector<core::RuntimeShellCommand> m_captured_shell_commands;
};

} // namespace noveltea::ui::rmlui
