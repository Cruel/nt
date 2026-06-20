#pragma once

#include <string>
#include <unordered_set>

#include <noveltea/core/runtime_ui_view.hpp>

#if defined(NOVELTEA_HAS_RMLUI)
#include <RmlUi/Core/ElementDocument.h>
#endif

namespace noveltea::ui::rmlui {

class RuntimeUiDocumentBinder {
public:
    RuntimeUiDocumentBinder();

#if defined(NOVELTEA_HAS_RMLUI)
    void bind(Rml::ElementDocument& doc, const core::RuntimeUIViewState& state);

    void clear_missing_slot_log();
#endif

private:
    std::unordered_set<std::string> m_logged_missing;
};

} // namespace noveltea::ui::rmlui
