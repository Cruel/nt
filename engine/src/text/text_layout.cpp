#include "noveltea/text/text_buffer.hpp"
#include "noveltea/text/text_renderer.hpp"

#include "noveltea/renderer.hpp"

namespace noveltea {

void TextBuffer::clear()
{
    m_runs.clear();
    m_metrics = {};
}

void TextBuffer::append(TextRun run)
{
    m_runs.push_back(run);
}

TextMetrics measure_text(Renderer& renderer, FontHandle font, std::string_view text, float size)
{
    return renderer.measure_text(font, text, size);
}

TextMetrics measure_text(Renderer& renderer, const Text& text)
{
    return renderer.measure_text(text);
}

TextLayout layout_text(Renderer& renderer, const Text& text)
{
    return renderer.layout_text(text);
}

} // namespace noveltea
