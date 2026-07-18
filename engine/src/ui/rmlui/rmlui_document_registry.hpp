#pragma once

#include "ui/rmlui/rmlui_lifecycle.hpp"

#include <cstdint>
#include <functional>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

namespace Rml {
class Context;
class Element;
class ElementDocument;
class EventListener;
} // namespace Rml

namespace noveltea {

namespace presentation {
enum class RuntimeLayoutBuiltinDocument : std::uint8_t;
} // namespace presentation

namespace ui::rmlui {

inline constexpr char kRuntimeTitleDocumentId[] = "runtime_title";
inline constexpr char kRuntimeGameDocumentId[] = "runtime_game";
inline constexpr char kRuntimePauseMenuDocumentId[] = "runtime_pause_menu";
inline constexpr char kRuntimeSaveMenuDocumentId[] = "runtime_save_menu";
inline constexpr char kRuntimeLoadMenuDocumentId[] = "runtime_load_menu";
inline constexpr char kRuntimeSettingsMenuDocumentId[] = "runtime_settings_menu";
inline constexpr char kRuntimeTextLogDocumentId[] = "runtime_text_log";
inline constexpr char kRuntimeModalDocumentId[] = "runtime_modal";

class RmlUiHost;

class RmlUiDocumentRegistry final {
public:
    using ContextKey = LifecycleContextKey;

    explicit RmlUiDocumentRegistry(RmlUiHost& host);
    ~RmlUiDocumentRegistry();

    RmlUiDocumentRegistry(const RmlUiDocumentRegistry&) = delete;
    RmlUiDocumentRegistry& operator=(const RmlUiDocumentRegistry&) = delete;

    [[nodiscard]] static ContextKey default_context_key() noexcept;
    [[nodiscard]] static std::string_view
    builtin_document_id(presentation::RuntimeLayoutBuiltinDocument document) noexcept;

    void set_runtime_input_listener(Rml::EventListener* listener) noexcept;

    [[nodiscard]] bool load_path(const std::string& id, const std::string& path, bool show,
                                 ContextKey context = default_context_key(),
                                 bool runtime_input = false);
    [[nodiscard]] bool load_memory(const std::string& id, const std::string& rml,
                                   const std::string& source_url, bool show,
                                   ContextKey context = default_context_key(),
                                   bool runtime_input = false);
    [[nodiscard]] bool load_builtin(presentation::RuntimeLayoutBuiltinDocument document,
                                    const std::string& runtime_document_path, bool show,
                                    ContextKey context = default_context_key());
    [[nodiscard]] bool recreate_in_context(const std::string& id, ContextKey context);
    [[nodiscard]] bool reload_all();
    [[nodiscard]] bool unload(const std::string& id);
    void clear();

    [[nodiscard]] bool show(const std::string& id);
    [[nodiscard]] bool hide(const std::string& id);
    [[nodiscard]] bool set_opacity(const std::string& id, float opacity);
    [[nodiscard]] bool apply_order(const std::vector<std::string>& ordered_document_ids);

    [[nodiscard]] Rml::ElementDocument* document(const std::string& id) const noexcept;
    [[nodiscard]] Rml::Element* element(const std::string& document_id,
                                        const std::string& element_id) const noexcept;
    [[nodiscard]] Rml::Context* document_context(const std::string& id) const noexcept;
    [[nodiscard]] ContextKey context_key_or_default(const std::string& id) const noexcept;
    [[nodiscard]] bool has_document(const std::string& id) const noexcept;
    [[nodiscard]] bool has_visible_document(Rml::Context* context) const noexcept;

    [[nodiscard]] std::uintptr_t add_event_listener(const std::string& document_id,
                                                    const std::string& element_id,
                                                    const std::string& event,
                                                    std::function<void()> callback);
    [[nodiscard]] bool remove_event_listener(std::uintptr_t listener_id);
    [[nodiscard]] bool has_event_listener(const Rml::Element& element,
                                          std::string_view event) const noexcept;

    void set_virtual_file(std::string path, std::string contents);
    void clear_virtual_files();

private:
    struct DocumentSource {
        std::string path;
        std::optional<std::string> memory_rml;
    };

    struct DocumentRecord {
        Rml::ElementDocument* document = nullptr;
        DocumentSource source;
        ContextKey context = default_context_key();
        bool runtime_input = false;
    };

    class CallbackListener;
    struct ListenerRecord {
        std::string document_id;
        std::string element_id;
        Rml::Element* element = nullptr;
        std::string event;
        std::unique_ptr<CallbackListener> listener;
    };

    [[nodiscard]] Rml::ElementDocument* instantiate(const DocumentSource& source,
                                                    ContextKey context) const;
    [[nodiscard]] bool replace(const std::string& id, DocumentSource source, bool show,
                               ContextKey context, bool runtime_input);
    void remember_order(const std::string& id);
    [[nodiscard]] std::vector<std::string> recreation_order() const;
    void restore_order();
    void attach_runtime_input(DocumentRecord& record);
    void detach_runtime_input(DocumentRecord& record);
    void detach_custom_listeners(const std::string& document_id, bool erase_records);
    void retire(DocumentRecord& record);

    RmlUiHost& m_host;
    Rml::EventListener* m_runtime_input_listener = nullptr;
    std::unordered_map<std::string, DocumentRecord> m_documents;
    std::vector<std::string> m_ordered_document_ids;
    std::unordered_map<std::uintptr_t, ListenerRecord> m_listeners;
    std::uintptr_t m_next_listener_id = 1;
};

} // namespace ui::rmlui
} // namespace noveltea
