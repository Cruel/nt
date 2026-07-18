#pragma once

#include "ui/rmlui/runtime_ui.hpp"

#include <cstdint>
#include <functional>
#include <string>

namespace noveltea::ui::rmlui {

// Private surface for named preview, fixture, shell-template, and lifecycle-test workflows that are
// intentionally isolated from the host-facing RuntimeUI facade.
class RuntimeUiFacadeAccess final {
public:
    static void set_base_direct_compatibility(RuntimeUI& runtime_ui, bool enabled);
    static void set_density(RuntimeUI& runtime_ui, float density);

    [[nodiscard]] static bool load_document(RuntimeUI& runtime_ui, const std::string& id,
                                            const std::string& path, bool show = true);
    [[nodiscard]] static bool
    load_document_from_memory(RuntimeUI& runtime_ui, const std::string& id, const std::string& rml,
                              const std::string& source_url = "preview://document.rml",
                              bool show = true);
    [[nodiscard]] static bool hide_document(RuntimeUI& runtime_ui, const std::string& id);
    static void set_preview_virtual_file(RuntimeUI& runtime_ui, std::string path,
                                         std::string contents);
    static void clear_preview_virtual_files(RuntimeUI& runtime_ui);

    [[nodiscard]] static bool load_title_document(RuntimeUI& runtime_ui);
    [[nodiscard]] static bool load_runtime_document(RuntimeUI& runtime_ui);
    [[nodiscard]] static bool load_pause_menu_document(RuntimeUI& runtime_ui);
    [[nodiscard]] static bool load_builtin_system_document(RuntimeUI& runtime_ui,
                                                           const std::string& id,
                                                           const std::string& path);

    static void bind_game_started_handler(RuntimeUI& runtime_ui, std::function<void()> handler);
    [[nodiscard]] static std::uintptr_t add_event_listener(RuntimeUI& runtime_ui,
                                                           const std::string& document_id,
                                                           const std::string& element_id,
                                                           const std::string& event,
                                                           std::function<void()> callback);
    [[nodiscard]] static bool remove_event_listener(RuntimeUI& runtime_ui,
                                                    std::uintptr_t listener_id);
};

} // namespace noveltea::ui::rmlui
