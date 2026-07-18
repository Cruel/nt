#pragma once

#include "noveltea/core/compiled_project.hpp"
#include "noveltea/core/diagnostic.hpp"
#include "noveltea/core/editor_preview_contracts.hpp"
#include "noveltea/core/runtime_messages.hpp"
#include "noveltea/runtime/runtime_contracts.hpp"
#include "noveltea/surface.hpp"

#include <cstdint>
#include <compare>
#include <optional>
#include <string>
#include <vector>

namespace noveltea {

namespace host {
class PreviewHost;
}

struct RuntimePreviewHandle {
    std::uint64_t session_generation = 0;
    std::uint64_t backend_generation = 0;
    auto operator<=>(const RuntimePreviewHandle&) const = default;
};

class RuntimePreviewController {
public:
    explicit RuntimePreviewController(host::PreviewHost& preview_host) noexcept;

    bool load_project(const std::string& logical_path);
    bool reset();
    bool reload();
    bool start();
    bool stop();
    bool step(double delta_seconds);

    [[nodiscard]] RuntimePreviewHandle runtime_handle() const noexcept;
    bool dispatch(RuntimePreviewHandle handle, core::RuntimeInputMessage input);

    bool continue_dialogue();
    bool select_dialogue_option(int option_index);
    bool navigate(int direction);
    bool select_subjects(std::vector<core::compiled::InteractionSubject> subjects);
    bool clear_subject_selection();
    bool run_interaction(const std::string& verb_id,
                         std::vector<core::compiled::InteractionSubject> operands);

    std::string set_variable(const std::string& variable_id, core::RuntimeValue value);
    std::string reset_variable(const std::string& variable_id);
    std::string give_object(const std::string& object_id);
    std::string remove_inventory_object(const std::string& object_id);
    std::string teleport_room(const std::string& room_id);

    bool begin_recording();
    bool end_recording();
    bool clear_recording();
    bool undo_recording_step();
    bool replay_recording();

    bool load_document(std::string rml, std::string source_url = "preview://layout/current.rml");
    bool execute_lua(std::string source, std::string chunk_name = "editor_preview.lua");
    bool apply_editor_document(core::editor::TypedEditorPreviewDocument document);
    void set_display_override(std::optional<DisplayProfile> profile);
    bool request_screenshot(std::string path);

    std::string fast_forward_to_input();
    std::string debug_snapshot() const;

    [[nodiscard]] const std::optional<runtime::RuntimePublication>& publication() const noexcept;
    [[nodiscard]] const runtime::RuntimeObservationSnapshot& observations() const noexcept;
    [[nodiscard]] const std::vector<runtime::RuntimeEvent>& events() const noexcept;
    [[nodiscard]] const core::Diagnostics& preview_diagnostics() const noexcept;
    [[nodiscard]] core::Diagnostics take_preview_diagnostics();
    void report_diagnostics(core::Diagnostics diagnostics);

private:
    host::PreviewHost* m_preview_host = nullptr;
};

} // namespace noveltea
