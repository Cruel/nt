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

} // namespace
