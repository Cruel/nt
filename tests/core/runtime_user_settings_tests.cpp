#include <noveltea/core/runtime_user_settings_codec.hpp>

#include <catch2/catch_test_macros.hpp>

#include <limits>

using namespace noveltea::core;

namespace {

const compiled::AccessibilitySettings kAccessibility{
    .ui_scale = {.enabled = true, .minimum = 0.8, .maximum = 1.5},
    .text_scale = {.enabled = true, .minimum = 1.0, .maximum = 2.0},
};

} // namespace

TEST_CASE("runtime user settings defaults and round-trip through the strict V2 codec")
{
    const auto defaults = RuntimeUserSettings::defaults();
    CHECK(defaults.ui_scale() == 1.0);
    CHECK(defaults.text_scale() == 1.0);

    const auto settings = RuntimeUserSettings::create(1.25, 1.5);
    REQUIRE(settings);
    const auto encoded = encode_runtime_user_settings_text(settings.value());
    REQUIRE(encoded);
    CHECK(
        encoded.value() ==
        R"({"schema":"noveltea.runtime.user-settings","schemaVersion":2,"textScale":1.5,"uiScale":1.25})");

    const auto decoded =
        decode_runtime_user_settings_text(encoded.value(), kAccessibility, "settings.json");
    REQUIRE(decoded);
    CHECK(decoded.value().ui_scale() == 1.25);
    CHECK(decoded.value().text_scale() == 1.5);
}

TEST_CASE("runtime user settings reject invalid native scales")
{
    CHECK_FALSE(RuntimeUserSettings::create(0.0, 1.0));
    CHECK_FALSE(RuntimeUserSettings::create(1.0, -1.0));
    CHECK_FALSE(RuntimeUserSettings::create(std::numeric_limits<double>::infinity(), 1.0));
    CHECK_FALSE(RuntimeUserSettings::create(1.0, std::numeric_limits<double>::quiet_NaN()));
}

TEST_CASE("persisted runtime settings clamp to the loaded project accessibility policy")
{
    const auto clamped = RuntimeUserSettings::load(0.5, 3.0, kAccessibility);
    REQUIRE(clamped);
    CHECK(clamped.value().ui_scale() == 0.8);
    CHECK(clamped.value().text_scale() == 2.0);

    auto disabled = kAccessibility;
    disabled.ui_scale.enabled = false;
    disabled.ui_scale.minimum = 0.5;
    disabled.ui_scale.maximum = 3.0;
    const auto normalized = RuntimeUserSettings::load(0.0, 1.25, disabled);
    REQUIRE(normalized);
    CHECK(normalized.value().ui_scale() == 1.0);
    CHECK(normalized.value().text_scale() == 1.25);
}

TEST_CASE("live runtime settings commands reject enabled out-of-range values")
{
    const auto settings = RuntimeUserSettings::create(1.0, 1.0);
    REQUIRE(settings);
    const auto ui = settings.value().with_ui_scale(1.25, kAccessibility);
    REQUIRE(ui);
    CHECK(ui.value().ui_scale() == 1.25);
    CHECK(ui.value().text_scale() == 1.0);

    const auto text = ui.value().with_text_scale(2.5, kAccessibility);
    REQUIRE_FALSE(text);
    CHECK(text.error().front().code == "runtime_user_settings.text_scale_out_of_range");

    auto disabled = kAccessibility;
    disabled.text_scale.enabled = false;
    const auto forced = ui.value().with_text_scale(0.0, disabled);
    REQUIRE(forced);
    CHECK(forced.value().text_scale() == 1.0);
}

TEST_CASE("runtime user settings codec is strict and versioned")
{
    const nlohmann::json valid = {
        {"schema", "noveltea.runtime.user-settings"},
        {"schemaVersion", 2},
        {"uiScale", 1.0},
        {"textScale", 1.0},
    };

    auto unknown = valid;
    unknown["profiles"] = nlohmann::json::array();
    const auto unknown_result =
        decode_runtime_user_settings(unknown, kAccessibility, "settings.json");
    REQUIRE_FALSE(unknown_result);
    CHECK(unknown_result.error().front().code == "runtime_user_settings.unknown_field");
    CHECK(unknown_result.error().front().source_path == "settings.json");
    CHECK(unknown_result.error().front().json_pointer == "/profiles");

    auto unsupported_schema = valid;
    unsupported_schema["schema"] = "noveltea.settings";
    REQUIRE_FALSE(decode_runtime_user_settings(unsupported_schema, kAccessibility));

    auto unsupported_version = valid;
    unsupported_version["schemaVersion"] = 1;
    REQUIRE_FALSE(decode_runtime_user_settings(unsupported_version, kAccessibility));

    auto missing = valid;
    missing.erase("uiScale");
    REQUIRE_FALSE(decode_runtime_user_settings(missing, kAccessibility));
}

TEST_CASE("runtime user settings codec rejects malformed types and values")
{
    const nlohmann::json wrong_root = nlohmann::json::array();
    REQUIRE_FALSE(decode_runtime_user_settings(wrong_root, kAccessibility));

    const nlohmann::json wrong_types = {
        {"schema", true},
        {"schemaVersion", 1.5},
        {"uiScale", "large"},
        {"textScale", false},
    };
    REQUIRE_FALSE(decode_runtime_user_settings(wrong_types, kAccessibility));

    const nlohmann::json nonpositive = {
        {"schema", "noveltea.runtime.user-settings"},
        {"schemaVersion", 2},
        {"uiScale", 1.0},
        {"textScale", 0.0},
    };
    const auto nonpositive_result =
        decode_runtime_user_settings(nonpositive, kAccessibility, "settings.json");
    REQUIRE_FALSE(nonpositive_result);
    CHECK(nonpositive_result.error().front().code == "runtime_user_settings.invalid_text_scale");
    CHECK(nonpositive_result.error().front().json_pointer == "/textScale");

    const auto malformed = decode_runtime_user_settings_text("{", kAccessibility, "settings.json");
    REQUIRE_FALSE(malformed);
    CHECK(malformed.error().front().code == "runtime_user_settings.malformed_json");
    CHECK(malformed.error().front().source_path == "settings.json");
}

TEST_CASE("runtime user settings codec rejects non-finite JSON DOM numbers")
{
    const nlohmann::json document = {
        {"schema", "noveltea.runtime.user-settings"},
        {"schemaVersion", 2},
        {"uiScale", 1.0},
        {"textScale", std::numeric_limits<double>::infinity()},
    };
    REQUIRE_FALSE(decode_runtime_user_settings(document, kAccessibility));
}
