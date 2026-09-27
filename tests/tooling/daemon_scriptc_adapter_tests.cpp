#include "tooling_daemon_broker.hpp"
#include "tooling_native_c.h"

#include <catch2/catch_test_macros.hpp>
#include <nlohmann/json.hpp>

#include <chrono>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <string>
#include <string_view>
#include <vector>

namespace {

using Json = nlohmann::json;

Json invoke_daemon(const Json& request)
{
    const auto text = request.dump();
    std::vector<std::uint8_t> response(128 * 1024);
    const auto required =
        noveltea_tooling_daemon_json(reinterpret_cast<const std::uint8_t*>(text.data()),
                                     text.size(), response.data(), response.size());
    REQUIRE(required <= response.size());
    return Json::parse(std::string(reinterpret_cast<const char*>(response.data()),
                                   static_cast<std::size_t>(required)));
}

Json invoke_scriptc_adapter(std::string_view operation, std::string_view request_text)
{
    const auto response_path =
        std::filesystem::temp_directory_path() /
        ("noveltea-daemon-scriptc-" +
         std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()) + ".json");
    const auto response_path_text = response_path.generic_string();
    noveltea_tooling_scriptc_invoke_to_file(
        reinterpret_cast<const std::uint8_t*>(operation.data()), operation.size(),
        reinterpret_cast<const std::uint8_t*>(request_text.data()), request_text.size(),
        reinterpret_cast<const std::uint8_t*>(response_path_text.data()),
        response_path_text.size());
    std::ifstream input(response_path, std::ios::binary);
    const std::string response((std::istreambuf_iterator<char>(input)),
                               std::istreambuf_iterator<char>());
    std::error_code error;
    std::filesystem::remove(response_path, error);
    return Json::parse(response);
}

Json invoke_daemon_via_scriptc_adapter(const Json& request)
{
    return invoke_scriptc_adapter("daemon", request.dump());
}

std::string unique_build(std::string_view suffix)
{
    return "daemon-test-" + std::string(suffix) + "-" +
           std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());
}

Json context(std::string build)
{
    return {{"build", std::move(build)},
            {"protocol", noveltea::tooling::daemon::protocol_version},
            {"daemonIdleMs", 5000},
            {"projectSessionIdleMs", 2500},
            {"disableDisposableWorkerProcessesForTests", true}};
}

} // namespace

TEST_CASE("ScriptC daemon adapter executes stateful broker actions once")
{
    auto request = context(unique_build("scriptc-adapter"));
    request["action"] = "serve-start";
    const auto started = invoke_daemon_via_scriptc_adapter(request);
    REQUIRE(started["ok"] == true);
    CHECK(started["state"] == "starting");

    request["action"] = "stop";
    REQUIRE(invoke_daemon(request)["ok"] == true);
    request["action"] = "serve-wait";
    REQUIRE(invoke_daemon(request)["ok"] == true);
}

TEST_CASE("ScriptC native adapter reports terminal dimensions when available")
{
    const auto terminal = invoke_scriptc_adapter("terminal-size", "");
    REQUIRE(terminal.contains("columns"));
    REQUIRE(terminal.contains("rows"));
    if (!terminal["columns"].is_null())
        CHECK(terminal["columns"].get<std::uint64_t>() > 0);
    if (!terminal["rows"].is_null())
        CHECK(terminal["rows"].get<std::uint64_t>() > 0);
}
