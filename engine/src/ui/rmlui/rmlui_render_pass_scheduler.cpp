#include "ui/rmlui/rmlui_render_pass_scheduler.hpp"

#include <cstdio>

namespace noveltea::ui::rmlui {

RmlUiRenderPassScheduler::RmlUiRenderPassScheduler(RmlUiViewId begin, RmlUiViewId end)
    : m_begin(begin), m_end(end), m_next(begin)
{
}

void RmlUiRenderPassScheduler::reset()
{
    m_next = m_begin;
    m_exhausted = false;
    m_error.clear();
    m_current.reset();
    m_passes.clear();
}

bool RmlUiRenderPassScheduler::can_reuse_current_pass(const RmlUiPassRequest& request) const
{
    if (!m_current || request.kind != RmlUiPassKind::Geometry)
        return false;
    const RmlUiPassRequest& current = m_current->request;
    return current.kind == RmlUiPassKind::Geometry && current.framebuffer == request.framebuffer &&
           !request.clears_color && !request.clears_stencil && current.x == request.x &&
           current.y == request.y && current.width == request.width &&
           current.height == request.height;
}

std::optional<RmlUiPass> RmlUiRenderPassScheduler::acquire(const RmlUiPassRequest& request)
{
    if (can_reuse_current_pass(request)) {
        return m_current;
    }

    if (m_next > m_end) {
        if (!m_exhausted) {
            m_error = "RmlUi bgfx view range exhausted";
            std::fprintf(stderr, "[rmlui] %s (%u..%u)\n", m_error.c_str(), unsigned(m_begin),
                         unsigned(m_end));
        }
        m_exhausted = true;
        return std::nullopt;
    }

    RmlUiPass pass{m_next++, request};
    m_passes.push_back(pass);
    m_current = pass;
    return pass;
}

} // namespace noveltea::ui::rmlui
