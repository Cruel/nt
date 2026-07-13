#include <noveltea/core/runtime_user_settings_codec.hpp>

#include <catch2/catch_test_macros.hpp>

#include <limits>

using namespace noveltea::core;

TEST_CASE("runtime user settings defaults and round-trip through the strict V1 codec")
{
    const auto defaults = RuntimeUserSettings::defaults();
    CHECK(defaults.text_scale() == 1.0);

    const auto settings = RuntimeUserSettings::create(1.25);
    REQUIRE(settings);
    const auto encoded = encode_runtime_user_settings_text(settings.value());
    REQUIRE(encoded);
    CHECK(encoded.value() ==
          R"({"schema":"noveltea.runtime.user-settings","schemaVersion":1,"textScale":1.25})");

    const auto decoded = decode_runtime_user_settings_text(encoded.value(), "settings.json");
    REQUIRE(decoded);
    CHECK(decoded.value().text_scale() == 1.25);
}

TEST_CASE("runtime user settings reject invalid native text scales")
{
    CHECK_FALSE(RuntimeUserSettings::create(0.0));
    CHECK_FALSE(RuntimeUserSettings::create(-1.0));
    CHECK_FALSE(RuntimeUserSettings::create(std::numeric_limits<double>::infinity()));
    CHECK_FALSE(RuntimeUserSettings::create(std::numeric_limits<double>::quiet_NaN()));
}

TEST_CASE("runtime user settings codec is strict and versioned")
{
    const nlohmann::json valid = {
        {"schema", "noveltea.runtime.user-settings"},
        {"schemaVersion", 1},
        {"textScale", 1.0},
    };

    auto unknown = valid;
    unknown["profiles"] = nlohmann::json::array();
    const auto unknown_result = decode_runtime_user_settings(unknown, "settings.json");
    REQUIRE_FALSE(unknown_result);
    CHECK(unknown_result.error().front().code == "runtime_user_settings.unknown_field");
    CHECK(unknown_result.error().front().source_path == "settings.json");
    CHECK(unknown_result.error().front().json_pointer == "/profiles");

    auto unsupported_schema = valid;
    unsupported_schema["schema"] = "noveltea.settings";
    REQUIRE_FALSE(decode_runtime_user_settings(unsupported_schema));

    auto unsupported_version = valid;
    unsupported_version["schemaVersion"] = 2;
    REQUIRE_FALSE(decode_runtime_user_settings(unsupported_version));

    auto missing = valid;
    missing.erase("textScale");
    REQUIRE_FALSE(decode_runtime_user_settings(missing));
}

TEST_CASE("runtime user settings codec rejects malformed types and values")
{
    const nlohmann::json wrong_root = nlohmann::json::array();
    REQUIRE_FALSE(decode_runtime_user_settings(wrong_root));

    const nlohmann::json wrong_types = {
        {"schema", true},
        {"schemaVersion", 1.5},
        {"textScale", false},
    };
    REQUIRE_FALSE(decode_runtime_user_settings(wrong_types));

    const nlohmann::json nonpositive = {
        {"schema", "noveltea.runtime.user-settings"},
        {"schemaVersion", 1},
        {"textScale", 0.0},
    };
    const auto nonpositive_result = decode_runtime_user_settings(nonpositive, "settings.json");
    REQUIRE_FALSE(nonpositive_result);
    CHECK(nonpositive_result.error().front().code == "runtime_user_settings.invalid_text_scale");
    CHECK(nonpositive_result.error().front().json_pointer == "/textScale");

    const auto malformed = decode_runtime_user_settings_text("{", "settings.json");
    REQUIRE_FALSE(malformed);
    CHECK(malformed.error().front().code == "runtime_user_settings.malformed_json");
    CHECK(malformed.error().front().source_path == "settings.json");
}

TEST_CASE("runtime user settings codec rejects non-finite JSON DOM numbers")
{
    const nlohmann::json document = {
        {"schema", "noveltea.runtime.user-settings"},
        {"schemaVersion", 1},
        {"textScale", std::numeric_limits<double>::infinity()},
    };
    REQUIRE_FALSE(decode_runtime_user_settings(document));
}
