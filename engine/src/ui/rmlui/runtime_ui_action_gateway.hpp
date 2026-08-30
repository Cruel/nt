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
    struct CommandBuilderDraftSnapshot {
        bool active = false;
        std::string verb_id;
        std::string label;
        std::vector<std::string> binding_order;
        std::vector<std::string> bound_slots;
        std::string focused_slot;
        bool complete = false;
    };

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
    [[nodiscard]] bool action_primary_activate(
        std::string kind, std::string id,
        std::optional<core::TriggerContext> trigger_context = std::nullopt,
        std::optional<core::LayoutPresentationParent> presentation_parent = std::nullopt);
    [[nodiscard]] bool action_open_verb_menu(
        std::string kind, std::string id,
        std::optional<core::TriggerContext> trigger_context = std::nullopt,
        std::optional<core::LayoutPresentationParent> presentation_parent = std::nullopt);
    [[nodiscard]] bool action_present_player_inventory(
        std::optional<core::TriggerContext> trigger_context = std::nullopt,
        std::optional<core::LayoutPresentationParent> presentation_parent = std::nullopt,
        bool coexist = false);
    [[nodiscard]] bool
    action_present_child_layout(std::string layout_id, std::optional<std::string> instance_id,
                                std::optional<core::TriggerContext> trigger_context,
                                core::LayoutPresentationParent presentation_parent);
    [[nodiscard]] bool action_clear_selection();
    [[nodiscard]] bool action_invoke_interaction(std::string id);
    [[nodiscard]] bool
    action_begin_command_builder(std::vector<core::compiled::InteractionSubject> subjects);
    [[nodiscard]] bool
    action_set_command_builder_watch(std::vector<core::compiled::InteractionSubject> subjects);
    [[nodiscard]] bool action_submit_command_builder();
    [[nodiscard]] bool
    action_submit_command_builder(std::string verb_id,
                                  std::vector<core::InteractionSubjectBinding> bindings);
    [[nodiscard]] bool action_rebind_command_builder(std::string slot_id);
    [[nodiscard]] bool action_cancel_command_builder();
    [[nodiscard]] CommandBuilderDraftSnapshot command_builder_draft() const;
    [[nodiscard]] bool action_save_slot(std::uint64_t number);
    [[nodiscard]] bool action_load_slot(std::string kind, std::uint64_t number);

    void begin_event_capture() noexcept;
    [[nodiscard]] RuntimeUiEventResult finish_event_capture() noexcept;

private:
    struct CommandBuilderDraft {
        core::VerbId verb;
        std::string label;
        std::vector<core::VerbSlotId> binding_order;
        std::vector<core::InteractionSubjectBinding> bindings;
        std::optional<core::CommandBuilderOccurrenceId> occurrence;
        std::uint64_t last_capture_revision = 0;
    };

    struct ShellSlotState {
        core::TypedSaveSlotId slot;
        bool occupied = false;
    };

    void install_lua_api();
    void remove_lua_api() noexcept;
    [[nodiscard]] bool invalid(std::string code, std::string message);
    [[nodiscard]] bool require_view();
    [[nodiscard]] std::optional<core::compiled::InteractionSubject>
    resolve_subject(std::string kind, std::string id);
    [[nodiscard]] const ShellSlotState* shell_slot(core::TypedSaveSlotId slot) const noexcept;
    void sync_command_builder_watches();

    core::Diagnostics& m_diagnostics;
    lua_State* m_lua_state = nullptr;
    RuntimeUiInputSink* m_input_sink = nullptr;
    std::function<bool()> m_layout_gameplay_admission;
    std::optional<RuntimeUiGameplayValues> m_values;
    std::optional<CommandBuilderDraft> m_command_builder_draft;
    bool m_command_builder_watch_dirty = false;
    std::vector<ShellSlotState> m_shell_slots;
    bool m_event_capture_active = false;
    std::vector<core::RuntimeInputMessage> m_captured_runtime_inputs;
    std::vector<core::RuntimeShellCommand> m_captured_shell_commands;
};

} // namespace noveltea::ui::rmlui
