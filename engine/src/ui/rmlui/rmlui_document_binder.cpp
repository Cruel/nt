#include "ui/rmlui/rmlui_document_binder.hpp"

#include <RmlUi/Core/ElementDocument.h>

namespace noveltea::ui::rmlui {

RuntimeUiDocumentBinder::RuntimeUiDocumentBinder() = default;

void RuntimeUiDocumentBinder::bind(Rml::ElementDocument& doc,
                                   const core::TypedRuntimeUIViewState& state, std::string_view)
{
    (void)doc;
    (void)state;
}

} // namespace noveltea::ui::rmlui
