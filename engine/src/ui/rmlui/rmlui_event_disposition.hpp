#pragma once

namespace noveltea::ui::rmlui {

enum class UiEventDisposition {
    Ignored,
    Consumed,
};

[[nodiscard]] constexpr UiEventDisposition rml_result_to_disposition(bool rml_event_not_consumed)
{
    return rml_event_not_consumed ? UiEventDisposition::Ignored : UiEventDisposition::Consumed;
}

[[nodiscard]] constexpr bool is_consumed(UiEventDisposition disposition)
{
    return disposition == UiEventDisposition::Consumed;
}

} // namespace noveltea::ui::rmlui
