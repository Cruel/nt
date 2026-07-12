#include "noveltea/core/json_access.hpp"

#include <catch2/catch_test_macros.hpp>

#include <limits>

using noveltea::core::json_access::get;
using noveltea::core::json_access::member;
using noveltea::core::json_access::require_member;
using noveltea::core::json_access::value_or;

TEST_CASE("checked JSON extraction accepts compatible scalar values")
{
    const nlohmann::json value = {
        {"string", "tea"}, {"boolean", true}, {"integer", -4}, {"unsigned", 7u}, {"float", 1.5}};

    CHECK(get<std::string>(*member(value, "string")) == "tea");
    CHECK(get<bool>(*member(value, "boolean")) == true);
    CHECK(get<int>(*member(value, "integer")) == -4);
    CHECK(get<std::uint64_t>(*member(value, "unsigned")) == 7);
    CHECK(get<double>(*member(value, "float")) == 1.5);
    CHECK(get<double>(*member(value, "integer")) == -4.0);
}

TEST_CASE("checked JSON extraction rejects mismatches and range errors")
{
    const nlohmann::json value = {
        {"wrong", "7"},
        {"negative", -1},
        {"large", static_cast<std::uint64_t>(std::numeric_limits<std::uint32_t>::max()) + 1},
    };

    CHECK_FALSE(get<int>(*member(value, "wrong")));
    CHECK_FALSE(get<std::uint32_t>(*member(value, "negative")));
    CHECK_FALSE(get<std::uint32_t>(*member(value, "large")));
    CHECK(value_or(value, "wrong", 9) == 9);
    CHECK(value_or(value, "missing", std::string("fallback")) == "fallback");
}

TEST_CASE("required JSON members preserve source and pointer diagnostics")
{
    const nlohmann::json value = {{"count", "wrong"}};
    const auto result = require_member<int>(value, "count", "json.type", "count must be integer",
                                            "project.json", "/count");

    REQUIRE_FALSE(result);
    CHECK(result.error().code == "json.type");
    CHECK(result.error().source_path == "project.json");
    CHECK(result.error().json_pointer == "/count");
}
