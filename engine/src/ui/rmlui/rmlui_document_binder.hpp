#pragma once

#include <string>
#include <unordered_set>

#include <noveltea/core/runtime_ui_view.hpp>

#include <RmlUi/Core/ElementDocument.h>

namespace noveltea::ui::rmlui {

class RuntimeUiDocumentBinder {
public:
    RuntimeUiDocumentBinder();

    void bind(Rml::ElementDocument& doc, const core::RuntimeUIViewState& state);

    void clear_missing_slot_log();

private:
    std::unordered_set<std::string> m_logged_missing;
};

} // namespace noveltea::ui::rmlui
