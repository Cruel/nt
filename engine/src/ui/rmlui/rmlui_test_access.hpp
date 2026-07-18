#pragma once

#include <string>

namespace Rml {
class Element;
class ElementDocument;
} // namespace Rml

namespace noveltea {
class RuntimeUI;

namespace ui::rmlui {

class RmlUiTestAccess final {
public:
    [[nodiscard]] static Rml::ElementDocument* document(RuntimeUI& runtime_ui,
                                                        const std::string& id);
    [[nodiscard]] static Rml::Element*
    element(RuntimeUI& runtime_ui, const std::string& document_id, const std::string& element_id);
};

} // namespace ui::rmlui
} // namespace noveltea
