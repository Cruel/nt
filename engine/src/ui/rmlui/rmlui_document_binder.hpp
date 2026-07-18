#pragma once

#include <string>
#include <string_view>
#include <unordered_set>

#include <noveltea/core/feature_view.hpp>
#include <noveltea/ui_runtime.hpp>

#include <RmlUi/Core/ElementDocument.h>

namespace noveltea::ui::rmlui {

class RuntimeUiDocumentBinder {
public:
    RuntimeUiDocumentBinder();

    void bind(Rml::ElementDocument& doc, const core::TypedRuntimeUIViewState& state,
              const RuntimeUiAssetService* asset_service, std::string_view notification = {});

    void clear_missing_slot_log();

private:
    std::unordered_set<std::string> m_logged_missing;
};

} // namespace noveltea::ui::rmlui
