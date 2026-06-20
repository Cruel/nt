#pragma once

#include <memory>
#include <optional>
#include <string>
#include <vector>

#include <noveltea/core/game_session.hpp>
#include <noveltea/core/runtime_controller.hpp>
#include <noveltea/core/runtime_io.hpp>
#include <noveltea/core/runtime_ui_view.hpp>
#include <noveltea/core/save_document.hpp>

namespace noveltea::core {

class RuntimeSessionHost {
public:
    RuntimeSessionHost();
    ~RuntimeSessionHost();

    RuntimeSessionHost(const RuntimeSessionHost&) = delete;
    RuntimeSessionHost& operator=(const RuntimeSessionHost&) = delete;

    [[nodiscard]] GameSessionLoadResult load(ProjectDocument project,
                                             SaveDocument save = SaveDocument::new_save());
    void set_save_slot_store(SaveSlotStore* store) noexcept { m_save_slots = store; }
    [[nodiscard]] bool has_save_slot_store() const noexcept { return m_save_slots != nullptr; }
    void reset();
    void tick(double delta_seconds);

    [[nodiscard]] bool loaded() const noexcept
    {
        return m_session.loaded() && m_controller != nullptr;
    }
    [[nodiscard]] GameSession& session() noexcept { return m_session; }
    [[nodiscard]] const GameSession& session() const noexcept { return m_session; }
    [[nodiscard]] RuntimeController* controller() noexcept { return m_controller.get(); }
    [[nodiscard]] const RuntimeController* controller() const noexcept
    {
        return m_controller.get();
    }
    [[nodiscard]] const RuntimeUIViewState& view_state() const noexcept { return m_view.state(); }
    [[nodiscard]] const std::vector<ControllerCommand>& last_commands() const noexcept
    {
        return m_last_commands;
    }
    [[nodiscard]] const std::vector<RuntimeOutput>& last_outputs() const noexcept
    {
        return m_last_outputs;
    }
    [[nodiscard]] const std::vector<RuntimeDiagnostic>& last_diagnostics() const noexcept
    {
        return m_last_diagnostics;
    }
    [[nodiscard]] std::string_view current_mode_name() const noexcept;

    RuntimeInputResult apply_input(const RuntimeInput& input);
    RuntimeInputResult
    flush_pending_outputs(std::optional<std::uint64_t> step_index = std::nullopt);

    bool navigate_path(int direction);
    bool select_dialogue_option(int option_index);
    bool continue_active();
    bool process_action(const std::string& verb_id, const std::vector<std::string>& object_ids);
    [[nodiscard]] SaveDocument snapshot_save() const;
    RuntimeInputResult save(SaveSlotId slot);
    RuntimeInputResult autosave();
    RuntimeInputResult load_save(SaveSlotId slot);
    RuntimeInputResult load_save(SaveDocument save);

private:
    RuntimeInputResult make_result(bool handled, std::vector<ControllerCommand> commands,
                                   std::vector<RuntimeDiagnostic> diagnostics = {},
                                   std::optional<std::uint64_t> step_index = std::nullopt);
    RuntimeDiagnostic make_warning(const RuntimeInput& input, std::string message) const;
    RuntimeDiagnostic make_input_diagnostic(const RuntimeInput& input, std::string category,
                                            std::string message) const;
    void consume_commands(const std::vector<ControllerCommand>& commands);
    void sync_room_interactions();
    [[nodiscard]] bool visible_object_available(const std::string& object_id) const;
    [[nodiscard]] bool selected_objects_available() const;
    [[nodiscard]] RuntimeOutput
    make_selection_observation(std::optional<std::uint64_t> step_index) const;
    [[nodiscard]] std::vector<ControllerCommand> make_save_hook_commands(bool before,
                                                                         bool autosave) const;
    [[nodiscard]] RuntimeInputResult finish_save(SaveSlotId slot, bool autosave,
                                                 std::vector<ControllerCommand> commands);
    [[nodiscard]] std::vector<RuntimeOutput>
    commands_to_outputs(const std::vector<ControllerCommand>& commands,
                        std::optional<std::uint64_t> step_index) const;

    GameSession m_session;
    std::unique_ptr<RuntimeController> m_controller;
    RuntimeUIViewAdapter m_view;
    std::vector<ControllerCommand> m_last_commands;
    std::vector<RuntimeOutput> m_last_outputs;
    std::vector<RuntimeDiagnostic> m_last_diagnostics;
    std::vector<std::string> m_selected_object_ids;
    std::optional<ProjectDocument> m_loaded_project;
    SaveSlotStore* m_save_slots = nullptr;
};

} // namespace noveltea::core
