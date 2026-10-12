#include "tooling_native.hpp"

#include <catch2/catch_test_macros.hpp>
#include <nlohmann/json.hpp>

#include <filesystem>
#include <string>

namespace {

nlohmann::json coverage_request()
{
    return {
        {"projectRoot", NOVELTEA_SOURCE_DIR},
        {"systemRoot", std::string(NOVELTEA_SOURCE_DIR) + "/engine/assets/system"},
        {"locales",
         {{{"locale", "en"},
           {"supported", true},
           {"fonts", nlohmann::json::array()},
           {"messages",
            {{{"messageId", "probe"}, {"sourcePath", "/probe"}, {"text", "Readable text"}}}}}}}};
}

TEST_CASE("font coverage tooling loads system assets from an explicit root")
{
    const auto result = noveltea::tooling::validate_font_coverage(coverage_request().dump());
    const auto response = nlohmann::json::parse(result.response_json);
    INFO(result.response_json);
    CHECK(response.at("ok") == true);
    CHECK(response.at("success") == true);
}

TEST_CASE("font coverage diagnoses an explicit unavailable system root without falling back")
{
    auto request = coverage_request();
    const auto root = std::filesystem::path(NOVELTEA_SOURCE_DIR) / "tests/missing-font-system-root";
    REQUIRE_FALSE(std::filesystem::exists(root));
    request["systemRoot"] = root.string();
    const auto result = noveltea::tooling::validate_font_coverage(request.dump());
    const auto response = nlohmann::json::parse(result.response_json);
    CHECK(response.at("ok") == false);
    const auto message = response.at("error").get<std::string>();
    CHECK(message.find("system:/fonts/LiberationSans.ttf") != std::string::npos);
    CHECK(message.find(root.string()) != std::string::npos);
}

TEST_CASE("font coverage sharing preserves per-message and per-locale results")
{
    auto combined = coverage_request();
    auto first = combined["locales"][0];
    first["messages"] = {
        {{"messageId", "first"}, {"sourcePath", "/first"}, {"text", "Repeated test \u0378"}}};
    auto second = first;
    second["locale"] = "fr";
    second["messages"] = {
        {{"messageId", "second"}, {"sourcePath", "/second"}, {"text", "Repeated test \u0378"}}};
    combined["locales"] = nlohmann::json::array({first, second});
    auto only_first = combined;
    only_first["locales"] = nlohmann::json::array({first});
    auto only_second = combined;
    only_second["locales"] = nlohmann::json::array({second});

    const auto all = nlohmann::json::parse(
        noveltea::tooling::validate_font_coverage(combined.dump()).response_json);
    const auto a = nlohmann::json::parse(
        noveltea::tooling::validate_font_coverage(only_first.dump()).response_json);
    const auto b = nlohmann::json::parse(
        noveltea::tooling::validate_font_coverage(only_second.dump()).response_json);
    REQUIRE(all.at("ok") == true);
    REQUIRE(a.at("ok") == true);
    REQUIRE(b.at("ok") == true);
    auto expected = a.at("diagnostics");
    for (const auto& diagnostic : b.at("diagnostics"))
        expected.push_back(diagnostic);
    CHECK(all.at("diagnostics") == expected);
}

} // namespace
