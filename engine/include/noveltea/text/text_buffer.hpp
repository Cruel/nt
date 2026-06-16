#pragma once

#include "noveltea/text/font.hpp"
#include "noveltea/text/text_lab.hpp"
#include "noveltea/text/text_layout.hpp"

#include <vector>

namespace noveltea {

class TextBuffer {
public:
    void clear();
    void append(TextRun run);

    [[nodiscard]] const std::vector<TextRun>& runs() const { return m_runs; }
    [[nodiscard]] TextMetrics metrics() const { return m_metrics; }
    void set_metrics(TextMetrics metrics) { m_metrics = metrics; }

private:
    std::vector<TextRun> m_runs;
    TextMetrics m_metrics{};
};

} // namespace noveltea
