#pragma once

#include <memory>
#include <string>

#include <noveltea/core/feature_view.hpp>
#include <noveltea/core/rich_text.hpp>

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

struct TypedMapViewComponentSnapshot {
    std::optional<core::MapView> map;
};

[[nodiscard]] std::string escape_rml(std::string_view value);
[[nodiscard]] ActiveTextComponentSnapshot
make_active_text_snapshot(const core::TypedRuntimeUIViewState& state);
[[nodiscard]] TypedMapViewComponentSnapshot
make_map_view_snapshot(const core::TypedRuntimeUIViewState& state);
[[nodiscard]] std::string map_view_rml(const TypedMapViewComponentSnapshot& snapshot);

class NtActiveTextElement final : public Rml::Element {
public:
    RMLUI_RTTI_DefineWithParent(NtActiveTextElement,
                                Rml::Element) explicit NtActiveTextElement(const Rml::String& tag);
    void set_snapshot(const ActiveTextComponentSnapshot& snapshot);
};

class NtMapViewElement final : public Rml::Element {
public:
    RMLUI_RTTI_DefineWithParent(NtMapViewElement,
                                Rml::Element) explicit NtMapViewElement(const Rml::String& tag);
    void set_snapshot(const TypedMapViewComponentSnapshot& snapshot);
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
