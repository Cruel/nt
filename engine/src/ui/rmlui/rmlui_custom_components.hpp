#pragma once

#include <memory>
#include <optional>
#include <string>

#include <noveltea/core/feature_view.hpp>
#include <noveltea/core/rich_text.hpp>

#include <RmlUi/Core/Element.h>
#include <RmlUi/Core/ElementInstancer.h>

namespace Rml {
class Event;
}

namespace noveltea::ui::rmlui {

struct ActiveTextComponentSnapshot {
    std::string title;
    std::string body;
    core::RichTextDocument rich_text;
    bool awaiting_continue = false;
    bool page_break = false;
    float reveal_progress = 1.0f;
};

struct TypedMapViewComponentSnapshot {
    std::optional<core::MapView> map;
    bool open = true;
    core::compiled::InitialMapMode mode = core::compiled::InitialMapMode::FullMap;
    std::optional<core::MapLocationId> focused_location;
    double pan_x = 0.0;
    double pan_y = 0.0;
    double zoom = 1.0;
};

[[nodiscard]] std::string escape_rml(std::string_view value);
[[nodiscard]] ActiveTextComponentSnapshot
make_active_text_snapshot(const core::TypedRuntimeUIViewState& state);
[[nodiscard]] TypedMapViewComponentSnapshot
make_map_view_snapshot(const core::TypedRuntimeUIViewState& state,
                       std::optional<core::MapId> map = std::nullopt);
[[nodiscard]] std::string map_view_rml(const TypedMapViewComponentSnapshot& snapshot);

class NtActiveTextElement final : public Rml::Element {
public:
    RMLUI_RTTI_DeclareWithParent(NtActiveTextElement,
                                 Rml::Element) explicit NtActiveTextElement(const Rml::String& tag);
    void set_snapshot(const ActiveTextComponentSnapshot& snapshot);
};

class NtMapViewElement final : public Rml::Element {
public:
    RMLUI_RTTI_DeclareWithParent(NtMapViewElement,
                                 Rml::Element) explicit NtMapViewElement(const Rml::String& tag);
    void set_snapshot(const TypedMapViewComponentSnapshot& snapshot);
    [[nodiscard]] std::optional<core::MapId> requested_map() const;

protected:
    void ProcessDefaultAction(Rml::Event& event) override;
    void OnAttributeChange(const Rml::ElementAttributes& changed_attributes) override;

private:
    void refresh();
    void sync_state_attributes();
    void emit_state_change();
    void apply_state_attributes();
    [[nodiscard]] Rml::Element* semantic_location_element(const core::MapLocationId& location);
    [[nodiscard]] Rml::Element*
    semantic_connection_element(const core::MapConnectionId& connection);
    [[nodiscard]] const core::MapLocationView* pick_location(double x, double y) const;
    [[nodiscard]] const core::MapConnectionView* pick_connection(double x, double y) const;

    std::optional<core::MapView> m_map;
    std::optional<core::MapId> m_bound_map;
    bool m_initialized = false;
    bool m_open = true;
    core::compiled::InitialMapMode m_mode = core::compiled::InitialMapMode::FullMap;
    std::optional<core::MapLocationId> m_focused_location;
    double m_pan_x = 0.0;
    double m_pan_y = 0.0;
    double m_zoom = 1.0;
    bool m_syncing_attributes = false;
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
};

} // namespace noveltea::ui::rmlui
