#pragma once

#include <string>
#include <string_view>

#include <noveltea/core/feature_view.hpp>
#include <noveltea/runtime_ui_contracts.hpp>

namespace Rml {
class ElementDocument;
}

namespace noveltea::ui::rmlui {

class RuntimeUiDocumentBinder {
public:
    RuntimeUiDocumentBinder();

    void bind(Rml::ElementDocument& doc, const core::TypedRuntimeUIViewState& state,
              std::string_view notification = {});
};

} // namespace noveltea::ui::rmlui
