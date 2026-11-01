#include "tooling_native.hpp"
#include "../../tools/project_authoring/validation_work_instrumentation.hpp"

#include <catch2/catch_test_macros.hpp>
#include <nlohmann/json.hpp>

#include <filesystem>
#include <chrono>
#include <fstream>
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

TEST_CASE("font coverage retains exact per-locale text, including deterministic missing glyphs")
{
    auto request = coverage_request();
    request["locales"][0]["messages"][0]["text"] = "Missing ͸";
    auto french = request["locales"][0];
    french["locale"] = "fr";
    french["messages"][0]["text"] = "Missing ͸";
    request["locales"].push_back(french);
    const auto run = [&](const nlohmann::json& value) {
        return nlohmann::json::parse(
            noveltea::tooling::validate_font_coverage(value.dump()).response_json);
    };
    const auto first = run(request);
    CHECK(first["work"]["executedLocales"] == 2);
    CHECK(first["work"]["reusedLocales"] == 0);
    REQUIRE_FALSE(first.at("diagnostics").empty());
    REQUIRE(run(request)["work"]["executedLocales"] == 0);

    request["locales"][1]["messages"][0]["text"] = "Changed ΀";
    const auto changed = run(request);
    REQUIRE(changed["work"]["executedLocales"] == 1);
    REQUIRE(changed["work"]["reusedLocales"] == 1);
    auto english = request;
    english["locales"] = nlohmann::json::array({request["locales"][0]});
    auto only_french = request;
    only_french["locales"] = nlohmann::json::array({request["locales"][1]});
    const auto english_result = run(english);
    const auto french_result = run(only_french);
    auto expected = english_result["diagnostics"];
    for (const auto& issue : french_result["diagnostics"])
        expected.push_back(issue);
    REQUIRE(changed["diagnostics"] == expected);
}

TEST_CASE("font coverage invalidates same-size restored-mtime font changes")
{
    const auto root = std::filesystem::temp_directory_path() /
                      ("noveltea-font-cache-" +
                       std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
    struct Cleanup {
        std::filesystem::path root;
        ~Cleanup()
        {
            std::error_code ignored;
            std::filesystem::remove_all(root, ignored);
        }
    } cleanup{root};
    std::filesystem::create_directories(root / "fonts");
    const auto source = std::filesystem::path(NOVELTEA_SOURCE_DIR) /
                        "engine/assets/system/fonts/LiberationSans.ttf";
    const auto target = root / "fonts/LiberationSans.ttf";
    std::filesystem::copy_file(source, target);
    auto request = coverage_request();
    request["systemRoot"] = root.string();
    const auto run = [&]() {
        return nlohmann::json::parse(
            noveltea::tooling::validate_font_coverage(request.dump()).response_json);
    };
    REQUIRE(run()["work"]["executedLocales"] == 1);
    noveltea::authoring::ValidationWorkCounters retained_work;
    {
        noveltea::authoring::ScopedValidationWork scope(retained_work);
        REQUIRE(run()["work"]["executedLocales"] == 0);
    }
#if defined(__linux__) && NOVELTEA_ENABLE_VALIDATION_COUNTERS
    CHECK(retained_work.get<noveltea::authoring::WorkCounter::FontProofReads>() == 0);
    CHECK(retained_work.get<noveltea::authoring::WorkCounter::FontBytesHashed>() == 0);
#endif
    std::filesystem::remove(target);
    const auto missing = run();
    REQUIRE(missing["ok"] == false);
    REQUIRE(missing["work"]["executedLocales"] == 1);
    REQUIRE(run()["work"]["executedLocales"] == 0);
    std::filesystem::copy_file(source, target);
    // Restoring byte-identical content admits the existing successful result
    // even if inode and mtime differ after recreating the file.
    REQUIRE(run()["work"]["executedLocales"] == 0);
    const auto timestamp = std::filesystem::last_write_time(target);
    {
        std::fstream file(target, std::ios::binary | std::ios::in | std::ios::out);
        REQUIRE(file.good());
        char marker = 0;
        file.read(&marker, 1);
        file.seekp(0);
        marker ^= 0x01;
        file.write(&marker, 1);
    }
    std::filesystem::last_write_time(target, timestamp);
    REQUIRE(run()["work"]["executedLocales"] == 1);
    std::filesystem::copy_file(source, target, std::filesystem::copy_options::overwrite_existing);
    REQUIRE(run()["work"]["executedLocales"] == 0);
    REQUIRE(run()["work"]["executedLocales"] == 0);
}

TEST_CASE("font coverage invalidates only locales consuming an edited Project font")
{
    const auto root = std::filesystem::temp_directory_path() /
                      ("noveltea-font-consumer-" +
                       std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
    struct Cleanup {
        std::filesystem::path root;
        ~Cleanup()
        {
            std::error_code ignored;
            std::filesystem::remove_all(root, ignored);
        }
    } cleanup{root};
    std::filesystem::create_directories(root / "fonts");
    const auto original = std::filesystem::path(NOVELTEA_SOURCE_DIR) /
                          "engine/assets/system/fonts/LiberationSans.ttf";
    const auto target = root / "fonts/custom.ttf";
    std::filesystem::copy_file(original, target);

    auto request = coverage_request();
    request["projectRoot"] = root.string();
    request["locales"][0]["fonts"] = {"project:/fonts/custom.ttf"};
    auto french = request["locales"][0];
    french["locale"] = "fr";
    french["fonts"] = nlohmann::json::array();
    request["locales"].push_back(french);
    const auto run = [&] {
        return nlohmann::json::parse(
            noveltea::tooling::validate_font_coverage(request.dump()).response_json);
    };
    REQUIRE(run()["work"]["executedLocales"] == 2);
    REQUIRE(run()["work"]["executedLocales"] == 0);
    const auto timestamp = std::filesystem::last_write_time(target);
    {
        std::fstream font(target, std::ios::binary | std::ios::in | std::ios::out);
        REQUIRE(font.good());
        char changed = 0;
        font.read(&changed, 1);
        font.seekp(0);
        changed ^= 0x01;
        font.write(&changed, 1);
    }
    std::filesystem::last_write_time(target, timestamp);
    const auto after_bytes = run();
    REQUIRE(after_bytes["work"]["executedLocales"] == 1);
    REQUIRE(after_bytes["work"]["reusedLocales"] == 1);
    std::filesystem::copy_file(original, target, std::filesystem::copy_options::overwrite_existing);
    REQUIRE(run()["work"]["reusedLocales"] == 2);

    request["locales"][0]["fonts"] = nlohmann::json::array();
    const auto after_stack = run();
    REQUIRE(after_stack["work"]["executedLocales"] == 1);
    REQUIRE(after_stack["work"]["reusedLocales"] == 1);
}

} // namespace
