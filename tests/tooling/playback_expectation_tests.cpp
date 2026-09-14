#include "tooling_native.hpp"

#include <catch2/catch_test_macros.hpp>
#include <nlohmann/json.hpp>

#include <filesystem>
#include <fstream>
#include <string>

namespace {

nlohmann::json load_minimal_compiled_project()
{
    const auto path = std::filesystem::path(NOVELTEA_SOURCE_DIR) /
                      "editor/src/renderer/test/fixtures/compiled-project-golden/minimal.json";
    std::ifstream stream(path);
    REQUIRE(stream.good());
    return nlohmann::json::parse(stream);
}

nlohmann::json run_playback(nlohmann::json step_expectations,
                            nlohmann::json final_expectations = nlohmann::json::array())
{
    const nlohmann::json request = {
        {"project", load_minimal_compiled_project()},
        {"spec",
         {{"schema", "noveltea.editor.playback"},
          {"version", 1},
          {"id", "expectations"},
          {"steps",
           nlohmann::json::array({{{"index", 0},
                                   {"input", {{"type", "advance-time"}, {"microseconds", 0}}},
                                   {"expectations", std::move(step_expectations)}}})},
          {"finalExpectations", std::move(final_expectations)}}},
    };
    const auto result = noveltea::tooling::run_headless_test(request.dump());
    REQUIRE(result.exit_code == 0);
    const auto response = nlohmann::json::parse(result.response_json, nullptr, false);
    REQUIRE_FALSE(response.is_discarded());
    REQUIRE(response.value("ok", false));
    REQUIRE(response.contains("report"));
    return response["report"];
}

} // namespace

TEST_CASE("native semantic playback evaluates typed expectations after a settled step")
{
    const auto report = run_playback(nlohmann::json::array(
        {{{"id", "room"},
          {"type", "current-room"},
          {"operator", "eq"},
          {"roomId", "start"}},
         {{"id", "no-error"},
          {"type", "diagnostic"},
          {"operator", "absent"},
          {"code", "runtime.synthetic"}}}));

    CHECK(report["passed"] == true);
    REQUIRE(report["steps"].size() == 1);
    REQUIRE(report["steps"][0]["expectations"].size() == 2);
    CHECK(report["steps"][0]["expectations"][0]["id"] == "room");
    CHECK(report["steps"][0]["expectations"][0]["passed"] == true);
    CHECK(report["steps"][0]["expectations"][1]["passed"] == true);
}

TEST_CASE("native semantic playback reports failed step and final expectations deterministically")
{
    const auto report = run_playback(
        nlohmann::json::array({{{"id", "wrong-room"},
                                {"type", "current-room"},
                                {"operator", "eq"},
                                {"roomId", "elsewhere"}}}),
        nlohmann::json::array({{{"id", "final-room"},
                                {"type", "current-room"},
                                {"operator", "eq"},
                                {"roomId", "elsewhere"}}}));

    CHECK(report["passed"] == false);
    CHECK(report["steps"][0]["expectations"][0]["passed"] == false);
    CHECK(report["steps"][0]["expectations"][0]["message"] == "Current Room did not match.");
    REQUIRE(report["finalExpectations"].size() == 1);
    CHECK(report["finalExpectations"][0]["passed"] == false);
}
