#pragma once

#include <memory>
#include <string>

#include <noveltea/core/runtime_ui_view.hpp>

#include <RmlUi/Core/Element.h>
#include <RmlUi/Core/ElementInstancer.h>

namespace noveltea::ui::rmlui {

struct ActiveTextComponentSnapshot {
    std::string title;
    std::string body;
    core::RichTextDocument rich_text;
    bool awaiting_continue = false;
    bool page_break = false;
    float reveal_progress = 1.0f;
};

struct MapViewComponentSnapshot {
    core::RuntimeUIMapView map;
};

struct TextLogComponentSnapshot {
    std::string entries_rml;
};

[[nodiscard]] std::string escape_rml(std::string_view value);
[[nodiscard]] std::string paragraph_rml(std::string_view text);
[[nodiscard]] ActiveTextComponentSnapshot
make_active_text_snapshot(const core::RuntimeUIViewState& state);
[[nodiscard]] MapViewComponentSnapshot
make_map_view_snapshot(const core::RuntimeUIViewState& state);
[[nodiscard]] TextLogComponentSnapshot
make_text_log_snapshot(const core::RuntimeUIViewState& state);
[[nodiscard]] std::string active_text_rml(const ActiveTextComponentSnapshot& snapshot);
[[nodiscard]] std::string map_view_rml(const MapViewComponentSnapshot& snapshot);
[[nodiscard]] std::string text_log_rml(const TextLogComponentSnapshot& snapshot);

class NtActiveTextElement final : public Rml::Element {
public:
    explicit NtActiveTextElement(const Rml::String& tag);
    void set_snapshot(const ActiveTextComponentSnapshot& snapshot);
};

class NtMapViewElement final : public Rml::Element {
public:
    explicit NtMapViewElement(const Rml::String& tag);
    void set_snapshot(const MapViewComponentSnapshot& snapshot);
};

class NtTextLogElement final : public Rml::Element {
public:
    explicit NtTextLogElement(const Rml::String& tag);
    void set_snapshot(const TextLogComponentSnapshot& snapshot);
};

class RuntimeUiComponentRegistry {
public:
    RuntimeUiComponentRegistry();
    ~RuntimeUiComponentRegistry();

    RuntimeUiComponentRegistry(const RuntimeUiComponentRegistry&) = delete;
    RuntimeUiComponentRegistry& operator=(const RuntimeUiComponentRegistry&) = delete;

private:
    std::unique_ptr<Rml::ElementInstancer> m_active_text;
    std::unique_ptr<Rml::ElementInstancer> m_map_view;
    std::unique_ptr<Rml::ElementInstancer> m_text_log;
};

} // namespace noveltea::ui::rmlui
