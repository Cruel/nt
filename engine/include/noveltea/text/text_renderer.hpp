#pragma once

#include "noveltea/text/font.hpp"
#include "noveltea/text/text.hpp"
#include "noveltea/text/text_lab.hpp"
#include "noveltea/text/text_layout.hpp"

#include <string_view>

namespace noveltea {

class Renderer;

TextMetrics measure_text(Renderer& renderer, FontHandle font, std::string_view text, float size);
TextMetrics measure_text(Renderer& renderer, const Text& text);
TextLayout layout_text(Renderer& renderer, const Text& text);

} // namespace noveltea
