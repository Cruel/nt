#pragma once

#include "noveltea/core/rich_text.hpp"

#include <nlohmann/json_fwd.hpp>

namespace noveltea::core {

[[nodiscard]] nlohmann::json encode_rich_text_document(const RichTextDocument& document);
[[nodiscard]] nlohmann::json encode_rich_text_page(const RichTextPage& page);
[[nodiscard]] nlohmann::json encode_rich_text_timeline_item(const RichTextTimelineItem& item);
[[nodiscard]] bool decode_rich_text_document(const nlohmann::json& value, RichTextDocument& out);

} // namespace noveltea::core
