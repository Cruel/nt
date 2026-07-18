#pragma once

#include <string>

namespace Rml {
class Element;
class ElementDocument;
} // namespace Rml

namespace noveltea {
class RuntimeUI;

namespace ui::rmlui {

class RmlUiDocumentRegistry;
class RmlUiHost;

enum class RuntimeUiPlaybackClickStatus {
    Dispatched,
    UiNotInitialized,
    DocumentNotFound,
    DocumentHidden,
    TargetNotFound,
    TargetHidden,
    TargetEmptyBounds,
    TargetDisabled,
    TargetBlocked,
    TargetNotInteractive,
};

struct RuntimeUiPlaybackClickRequest {
    std::string document_id;
    std::string selector;
};

struct RuntimeUiPlaybackClickResult {
    RuntimeUiPlaybackClickStatus status = RuntimeUiPlaybackClickStatus::UiNotInitialized;
    std::string message;
    std::string document_id;
    std::string selector;
    std::string target_id;
    std::string target_tag;
    float x = 0.0f;
    float y = 0.0f;
    float width = 0.0f;
    float height = 0.0f;
    bool dispatched = false;
};

[[nodiscard]] const char* to_string(RuntimeUiPlaybackClickStatus status) noexcept;

class RuntimeUiPlaybackDriver final {
public:
    RuntimeUiPlaybackDriver(RmlUiHost& host, RmlUiDocumentRegistry& documents) noexcept;

    RuntimeUiPlaybackDriver(const RuntimeUiPlaybackDriver&) = delete;
    RuntimeUiPlaybackDriver& operator=(const RuntimeUiPlaybackDriver&) = delete;

    [[nodiscard]] static RuntimeUiPlaybackDriver* from(RuntimeUI& runtime_ui) noexcept;

    [[nodiscard]] RuntimeUiPlaybackClickResult click(const RuntimeUiPlaybackClickRequest& request);

    [[nodiscard]] Rml::ElementDocument* document(const std::string& id) const noexcept;
    [[nodiscard]] Rml::Element* element(const std::string& document_id,
                                        const std::string& element_id) const noexcept;

private:
    RmlUiHost& m_host;
    RmlUiDocumentRegistry& m_documents;
};

} // namespace ui::rmlui
} // namespace noveltea
