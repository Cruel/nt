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

} // namespace noveltea
