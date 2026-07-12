#include "noveltea/core/result.hpp"
#include <catch2/catch_test_macros.hpp>
using noveltea::core::Diagnostic;
using noveltea::core::DiagnosticResult;
TEST_CASE("result transforms values")
{
    const auto result =
        DiagnosticResult<int>::success(20).transform([](int value) { return value + 2; });
    REQUIRE(result);
    CHECK(result.value() == 22);
}
TEST_CASE("result preserves diagnostic context")
{
    const Diagnostic error{"project.missing_field", "Required field is absent",
                           noveltea::core::ErrorSeverity::Error, "project.json", "/rooms/0"};
    const auto result = DiagnosticResult<int>::failure(error).and_then(
        [](int) { return DiagnosticResult<std::string>::success("unreachable"); });
    REQUIRE_FALSE(result);
    CHECK(result.error().code == "project.missing_field");
    CHECK(result.error().source_path == "project.json");
    CHECK(result.error().json_pointer == "/rooms/0");
}
TEST_CASE("void result propagates failures")
{
    const auto result =
        DiagnosticResult<void>::failure(Diagnostic{"io.failed", "write failed"}).and_then([] {
            return DiagnosticResult<int>::success(1);
        });
    REQUIRE_FALSE(result);
    CHECK(result.error().code == "io.failed");
}
