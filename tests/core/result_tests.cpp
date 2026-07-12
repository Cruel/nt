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
TEST_CASE("result transforms error types")
{
    const auto result =
        DiagnosticResult<int>::failure(Diagnostic{"parse.failed", "bad input"})
            .transform_error([](const Diagnostic& diagnostic) { return diagnostic.code; });
    REQUIRE_FALSE(result);
    CHECK(result.error() == "parse.failed");
}
TEST_CASE("diagnostics preserve nested causes and fatal classification")
{
    const auto diagnostic = Diagnostic{"project.load_failed", "Could not load project"}.caused_by(
        Diagnostic{"json.invalid", "Malformed JSON"});
    CHECK(diagnostic.causes.size() == 1);
    CHECK(diagnostic.causes.front().code == "json.invalid");

    noveltea::core::Diagnostics diagnostics{diagnostic};
    CHECK_FALSE(noveltea::core::has_fatal_diagnostic(diagnostics));
    diagnostics.push_back(Diagnostic{"runtime.invariant", "Runtime invariant failed",
                                     noveltea::core::ErrorSeverity::Fatal});
    CHECK(noveltea::core::has_fatal_diagnostic(diagnostics));
}
