#include "ui/rmlui/rmlui_event_disposition.hpp"

#include <catch2/catch_test_macros.hpp>

using noveltea::ui::rmlui::UiEventDisposition;
using noveltea::ui::rmlui::is_consumed;
using noveltea::ui::rmlui::rml_result_to_disposition;

TEST_CASE("RmlUi true result is ignored by gameplay-consumption contract")
{
    CHECK(rml_result_to_disposition(true) == UiEventDisposition::Ignored);
    CHECK_FALSE(is_consumed(rml_result_to_disposition(true)));
}

TEST_CASE("RmlUi false result is consumed by gameplay-consumption contract")
{
    CHECK(rml_result_to_disposition(false) == UiEventDisposition::Consumed);
    CHECK(is_consumed(rml_result_to_disposition(false)));
}
