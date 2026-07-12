#include <noveltea/core/runtime_value.hpp>

#include <catch2/catch_test_macros.hpp>

#include <cstdint>
#include <string>
#include <type_traits>

namespace noveltea::core {

TEST_CASE("runtime values expose the supported closed scalar alternatives")
{
    STATIC_REQUIRE(std::variant_size_v<RuntimeValue> == 5);

    CHECK(runtime_value_type(RuntimeValue{}) == RuntimeValueType::Null);
    CHECK(runtime_value_type(RuntimeValue{true}) == RuntimeValueType::Boolean);
    CHECK(runtime_value_type(RuntimeValue{std::int64_t{42}}) == RuntimeValueType::Integer);
    CHECK(runtime_value_type(RuntimeValue{3.5}) == RuntimeValueType::Number);
    CHECK(runtime_value_type(RuntimeValue{std::string{"tea"}}) == RuntimeValueType::String);
}

TEST_CASE("runtime value type names are stable wire-independent diagnostics")
{
    CHECK(runtime_value_type_name(RuntimeValueType::Null) == "null");
    CHECK(runtime_value_type_name(RuntimeValueType::Boolean) == "boolean");
    CHECK(runtime_value_type_name(RuntimeValueType::Integer) == "integer");
    CHECK(runtime_value_type_name(RuntimeValueType::Number) == "number");
    CHECK(runtime_value_type_name(RuntimeValueType::String) == "string");
}

} // namespace noveltea::core
