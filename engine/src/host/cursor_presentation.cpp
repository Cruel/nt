#include "host/cursor_presentation.hpp"

#include <algorithm>
#include <cmath>
#include <functional>
#include <utility>

namespace noveltea::host {

std::string_view cursor_shape_name(CursorShape shape) noexcept
{
    switch (shape) {
    case CursorShape::Default:
        return "default";
    case CursorShape::Pointer:
        return "pointer";
    case CursorShape::Text:
        return "text";
    case CursorShape::Wait:
        return "wait";
    case CursorShape::Progress:
        return "progress";
    case CursorShape::Crosshair:
        return "crosshair";
    case CursorShape::Move:
        return "move";
    case CursorShape::NotAllowed:
        return "not-allowed";
    case CursorShape::NsResize:
        return "ns-resize";
    case CursorShape::EwResize:
        return "ew-resize";
    case CursorShape::NeswResize:
        return "nesw-resize";
    case CursorShape::NwseResize:
        return "nwse-resize";
    case CursorShape::Hidden:
        return "none";
    }
    return "default";
}

CursorImageSize fit_cursor_image_size(std::uint32_t width, std::uint32_t height) noexcept
{
    constexpr std::uint32_t portable_bound = 128;
    if (width == 0 || height == 0 || (width <= portable_bound && height <= portable_bound))
        return {width, height};
    const double scale =
        static_cast<double>(portable_bound) / static_cast<double>(std::max(width, height));
    return {.width = std::max(1U, static_cast<std::uint32_t>(std::lround(width * scale))),
            .height = std::max(1U, static_cast<std::uint32_t>(std::lround(height * scale)))};
}

std::string_view cursor_request_source_name(CursorRequestSource source) noexcept
{
    switch (source) {
    case CursorRequestSource::LayoutLua:
        return "layout-lua";
    case CursorRequestSource::GameplayLua:
        return "gameplay-lua";
    case CursorRequestSource::RmlUi:
        return "rmlui";
    case CursorRequestSource::WorldHotspot:
        return "world-hotspot";
    case CursorRequestSource::ProjectDefault:
        return "project-default";
    case CursorRequestSource::Count:
        break;
    }
    return "unknown";
}

CursorAuthority::CursorAuthority(CursorRealizer* realizer) noexcept : m_realizer(realizer) {}

void CursorAuthority::bind_realizer(CursorRealizer* realizer) noexcept
{
    m_realizer = realizer;
    invalidate_realization();
}

void CursorAuthority::invalidate_realization() noexcept
{
    m_realization_request.reset();
    m_realized.reset();
    resolve();
}

void CursorAuthority::publish(CursorRequestSource source, OwnerToken owner, CursorShape shape,
                              std::string owner_label)
{
    publish(source, owner, CursorPresentation{.shape = shape, .custom = std::nullopt},
            std::move(owner_label));
}

void CursorAuthority::publish(CursorRequestSource source, OwnerToken owner,
                              CursorPresentation presentation, std::string owner_label)
{
    m_requests.insert_or_assign(RequestKey{source, owner},
                                Request{std::move(presentation), std::move(owner_label)});
}

void CursorAuthority::clear(CursorRequestSource source, OwnerToken owner)
{
    m_requests.erase(RequestKey{source, owner});
}

void CursorAuthority::clear_source(CursorRequestSource source)
{
    for (auto it = m_requests.begin(); it != m_requests.end();) {
        if (it->first.source == source)
            it = m_requests.erase(it);
        else
            ++it;
    }
    m_eligible[source_index(source)].clear();
}

void CursorAuthority::set_eligible_order(CursorRequestSource source,
                                         std::vector<OwnerToken> front_to_back)
{
    m_eligible[source_index(source)] = std::move(front_to_back);
}

void CursorAuthority::resolve() noexcept
{
    CursorInspection next{};
    CursorPresentation requested{};
    bool found = false;
    for (std::size_t source_index_value = 0;
         source_index_value < source_index(CursorRequestSource::Count) && !found;
         ++source_index_value) {
        const auto source = static_cast<CursorRequestSource>(source_index_value);
        for (const OwnerToken owner : m_eligible[source_index_value]) {
            const auto request = m_requests.find(RequestKey{source, owner});
            if (request == m_requests.end())
                continue;
            requested = request->second.presentation;
            next.source = std::string(cursor_request_source_name(source));
            next.owner = request->second.owner_label;
            found = true;
            break;
        }
    }

    if (!m_realization_request || *m_realization_request != requested) {
        m_realized = m_realizer ? m_realizer->realize(requested) : requested;
        m_realization_request = requested;
    }
    const CursorPresentation& realized = m_realized ? *m_realized : requested;
    next.effective = realized.shape;
    next.effective_name =
        realized.custom ? realized.custom->id : std::string(cursor_shape_name(realized.shape));
    next.custom = realized.custom;
    m_inspection = std::move(next);
}

void CursorAuthority::reset() noexcept
{
    m_requests.clear();
    for (auto& eligible : m_eligible)
        eligible.clear();
    m_inspection = {};
    const CursorPresentation presentation{.shape = CursorShape::Default, .custom = std::nullopt};
    if (!m_realization_request || *m_realization_request != presentation) {
        m_realized = m_realizer ? m_realizer->realize(presentation) : presentation;
        m_realization_request = presentation;
    }
}

const CursorInspection& CursorAuthority::inspection() const noexcept { return m_inspection; }

std::size_t CursorAuthority::RequestKeyHash::operator()(const RequestKey& key) const noexcept
{
    const auto source = static_cast<std::size_t>(key.source);
    const auto owner = std::hash<OwnerToken>{}(key.owner);
    return owner ^ (source + 0x9e3779b9U + (owner << 6U) + (owner >> 2U));
}

} // namespace noveltea::host
