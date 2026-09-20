#include "tooling_daemon_broker.hpp"
#include "tooling_native_c.h"

#include <catch2/catch_test_macros.hpp>
#include <nlohmann/json.hpp>

#include <chrono>
#include <csignal>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <future>
#include <string>
#include <thread>
#include <vector>

#if !defined(_WIN32)
#include <fcntl.h>
#include <sys/file.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>
#endif

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

Json invoke_daemon_via_scriptc_adapter(const Json& request)
{
    const auto text = request.dump();
    const auto response_path =
        std::filesystem::temp_directory_path() /
        ("noveltea-daemon-scriptc-" +
         std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()) + ".json");
    const std::string operation = "daemon";
    const auto response_path_text = response_path.generic_string();
    noveltea_tooling_scriptc_invoke_to_file(
        reinterpret_cast<const std::uint8_t*>(operation.data()), operation.size(),
        reinterpret_cast<const std::uint8_t*>(text.data()), text.size(),
        reinterpret_cast<const std::uint8_t*>(response_path_text.data()),
        response_path_text.size());
    std::ifstream input(response_path, std::ios::binary);
    const std::string response((std::istreambuf_iterator<char>(input)),
                               std::istreambuf_iterator<char>());
    std::error_code error;
    std::filesystem::remove(response_path, error);
    return Json::parse(response);
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
            {"projectSessionIdleMs", 2500}};
}

struct TempRuntimeRoot {
    std::filesystem::path path;
    ~TempRuntimeRoot()
    {
        std::error_code error;
        std::filesystem::remove_all(path, error);
    }
};

TempRuntimeRoot temp_runtime_root(std::string_view suffix)
{
    TempRuntimeRoot root{
        std::filesystem::temp_directory_path() /
        ("noveltea-daemon-test-" + std::string(suffix) + "-" +
         std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()))};
    return root;
}

} // namespace

TEST_CASE("daemon frames are length-prefixed, fragment-safe, and bounded")
{
    using namespace noveltea::tooling::daemon;
    const auto frame = encode_frame(R"({"type":"request","requestId":"abc"})");
    REQUIRE(frame.size() > 8);

    FrameDecoder decoder;
    CHECK(decoder.feed(std::span(frame).first(2)));
    CHECK(decoder.frames().empty());
    CHECK(decoder.feed(std::span(frame).subspan(2, 3)));
    CHECK(decoder.frames().empty());
    CHECK(decoder.feed(std::span(frame).subspan(5)));
    REQUIRE(decoder.frames().size() == 1);
    CHECK(decoder.frames().front() == R"({"type":"request","requestId":"abc"})");

    std::vector<std::uint8_t> oversized = {0x00, 0x10, 0x00, 0x01};
    FrameDecoder rejected;
    CHECK_FALSE(rejected.feed(oversized));
    CHECK(rejected.error() == "daemon frame exceeds maximum size");
}

TEST_CASE("daemon endpoint identity separates build and protocol")
{
    using noveltea::tooling::daemon::endpoint_identity;
    const auto first = endpoint_identity("build-a", 1);
    CHECK(first == endpoint_identity("build-a", 1));
    CHECK(first != endpoint_identity("build-b", 1));
    CHECK(first != endpoint_identity("build-a", 2));
}

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

TEST_CASE("daemon protocol event shapes preserve request identity")
{
    using namespace noveltea::tooling::daemon;
    const auto result = Json::parse(result_event_json("req-1", true, R"({"value":4})"));
    CHECK(result == Json{{"type", "result"},
                         {"requestId", "req-1"},
                         {"ok", true},
                         {"final", true},
                         {"result", Json{{"value", 4}}}});

    const auto stdout_event = Json::parse(text_event_json("stdout", "req-2", "hello"));
    CHECK(stdout_event == Json{{"type", "stdout"}, {"requestId", "req-2"}, {"text", "hello"}});
    const auto stderr_event = Json::parse(text_event_json("stderr", "req-2", "warning"));
    CHECK(stderr_event["type"] == "stderr");

    const auto progress = Json::parse(progress_event_json("req-3", "loading", 2, 5));
    CHECK(progress == Json{{"type", "progress"},
                           {"requestId", "req-3"},
                           {"message", "loading"},
                           {"completed", 2},
                           {"total", 5}});

    const auto cancellation = Json::parse(cancellation_event_json("req-4"));
    CHECK(cancellation == Json{{"type", "cancel"}, {"requestId", "req-4"}});
}

TEST_CASE("daemon broker exposes starting, queues work until ready, and drains on stop")
{
    auto request = context(unique_build("lifecycle"));
    request["action"] = "serve-start";
    const auto started = invoke_daemon(request);
    REQUIRE(started["ok"] == true);
    REQUIRE(started["running"] == true);
    CHECK(started["state"] == "starting");

    auto status_request = request;
    status_request["action"] = "status";
    const auto starting = invoke_daemon(status_request);
    REQUIRE(starting["running"] == true);
    CHECK(starting["state"] == "starting");
    CHECK(starting["build"] == request["build"]);
    CHECK(starting["protocol"] == noveltea::tooling::daemon::protocol_version);
    CHECK(starting["pid"].is_number_integer());

    auto work_request = request;
    work_request["action"] = "request";
    work_request["requestId"] = "queued-1";
    work_request["method"] = "future-worker-command";
    auto pending =
        std::async(std::launch::async, [work_request]() { return invoke_daemon(work_request); });
    CHECK(pending.wait_for(std::chrono::milliseconds(50)) == std::future_status::timeout);

    auto ready_request = request;
    ready_request["action"] = "serve-ready";
    const auto ready = invoke_daemon(ready_request);
    REQUIRE(ready["ok"] == true);
    CHECK(ready["state"] == "ready");

    auto next_request = request;
    next_request["action"] = "serve-next";
    const auto next = invoke_daemon(next_request);
    REQUIRE(next["ok"] == true);
    REQUIRE(next["stopped"] == false);
    CHECK(next["requestId"] == "queued-1");
    CHECK(next["method"] == "future-worker-command");
    REQUIRE(next["token"].is_number_unsigned());

    auto complete_request = request;
    complete_request["action"] = "serve-complete";
    complete_request["token"] = next["token"];
    complete_request["requestOk"] = true;
    complete_request["result"] = Json{{"value", 7}};
    REQUIRE(invoke_daemon(complete_request)["ok"] == true);

    REQUIRE(pending.wait_for(std::chrono::seconds(2)) == std::future_status::ready);
    const auto completed = pending.get();
    CHECK(completed["ok"] == true);
    CHECK(completed["requestId"] == "queued-1");
    CHECK(completed["result"] == Json{{"value", 7}});

    const auto ready_status = invoke_daemon(status_request);
    CHECK(ready_status["state"] == "ready");
    CHECK(ready_status["projectSessionIdleMs"] == 2500);
    CHECK(ready_status["daemonIdleMs"] == 5000);

    auto stop_request = request;
    stop_request["action"] = "stop";
    const auto stopped = invoke_daemon(stop_request);
    REQUIRE(stopped["ok"] == true);
    CHECK(stopped["running"] == false);
    CHECK(stopped["state"] == "stopped");

    auto wait_request = request;
    wait_request["action"] = "serve-wait";
    const auto waited = invoke_daemon(wait_request);
    CHECK(waited["ok"] == true);
    CHECK(waited["state"] == "stopped");

    const auto final_status = invoke_daemon(status_request);
    CHECK(final_status["running"] == false);
    CHECK(final_status["state"] == "stopped");
}

TEST_CASE("queued daemon request can be cancelled before worker readiness")
{
    auto request = context(unique_build("cancel"));
    request["action"] = "serve-start";
    REQUIRE(invoke_daemon(request)["ok"] == true);

    auto work_request = request;
    work_request["action"] = "request";
    work_request["requestId"] = "cancel-me";
    work_request["method"] = "future-worker-command";
    work_request["cancelAfterMs"] = 20;
    const auto cancelled = invoke_daemon(work_request);
    CHECK(cancelled["ok"] == false);
    CHECK(cancelled["requestId"] == "cancel-me");
    CHECK(cancelled["cancelled"] == true);

    auto stop_request = request;
    stop_request["action"] = "stop";
    REQUIRE(invoke_daemon(stop_request)["ok"] == true);
    request["action"] = "serve-wait";
    REQUIRE(invoke_daemon(request)["ok"] == true);
}

TEST_CASE("queued daemon request IDs are scoped to each client connection")
{
    auto request = context(unique_build("request-id-scope"));
    request["action"] = "serve-start";
    REQUIRE(invoke_daemon(request)["ok"] == true);

    auto work_request = request;
    work_request["action"] = "request";
    work_request["requestId"] = "shared-id";
    work_request["method"] = "future-worker-command";
    auto first =
        std::async(std::launch::async, [work_request]() { return invoke_daemon(work_request); });
    auto second =
        std::async(std::launch::async, [work_request]() { return invoke_daemon(work_request); });
    CHECK(first.wait_for(std::chrono::milliseconds(50)) == std::future_status::timeout);
    CHECK(second.wait_for(std::chrono::milliseconds(50)) == std::future_status::timeout);

    request["action"] = "serve-ready";
    REQUIRE(invoke_daemon(request)["ok"] == true);
    for (int index = 0; index < 2; ++index) {
        request["action"] = "serve-next";
        const auto next = invoke_daemon(request);
        REQUIRE(next["ok"] == true);
        CHECK(next["requestId"] == "shared-id");
        request["action"] = "serve-complete";
        request["token"] = next["token"];
        request["requestOk"] = true;
        request["result"] = Json{{"index", index}};
        REQUIRE(invoke_daemon(request)["ok"] == true);
    }
    REQUIRE(first.wait_for(std::chrono::seconds(2)) == std::future_status::ready);
    REQUIRE(second.wait_for(std::chrono::seconds(2)) == std::future_status::ready);
    for (const auto result : {first.get(), second.get()}) {
        CHECK(result["ok"] == true);
        CHECK(result["requestId"] == "shared-id");
    }

    request.erase("token");
    request.erase("requestOk");
    request.erase("result");
    request["action"] = "stop";
    REQUIRE(invoke_daemon(request)["ok"] == true);
    request["action"] = "serve-wait";
    REQUIRE(invoke_daemon(request)["ok"] == true);
}

TEST_CASE("active daemon request observes client cancellation")
{
    auto request = context(unique_build("active-cancel"));
    request["action"] = "serve-start";
    REQUIRE(invoke_daemon(request)["ok"] == true);
    request["action"] = "serve-ready";
    REQUIRE(invoke_daemon(request)["ok"] == true);

    auto work_request = request;
    work_request["action"] = "request";
    work_request["requestId"] = "active-cancel";
    work_request["method"] = "invoke";
    work_request["payload"] = Json{{"argv", Json::array({"validate"})}};
    work_request["cancelAfterMs"] = 20;
    auto pending =
        std::async(std::launch::async, [work_request]() { return invoke_daemon(work_request); });

    request["action"] = "serve-next";
    const auto next = invoke_daemon(request);
    REQUIRE(next["ok"] == true);
    REQUIRE(next["stopped"] == false);
    CHECK(next["payload"] == work_request["payload"]);

    std::this_thread::sleep_for(std::chrono::milliseconds(40));
    request["action"] = "serve-cancelled";
    request["token"] = next["token"];
    const auto cancelled = invoke_daemon(request);
    REQUIRE(cancelled["ok"] == true);
    CHECK(cancelled["active"] == true);
    CHECK(cancelled["cancelled"] == true);

    request["action"] = "serve-complete";
    request["requestOk"] = false;
    request["result"] = nullptr;
    request["error"] = "request cancelled";
    REQUIRE(invoke_daemon(request)["ok"] == true);
    REQUIRE(pending.wait_for(std::chrono::seconds(2)) == std::future_status::ready);
    const auto result = pending.get();
    CHECK(result["ok"] == false);
    CHECK(result["error"] == "request cancelled");

    request.erase("token");
    request.erase("requestOk");
    request.erase("result");
    request.erase("error");
    request["action"] = "stop";
    REQUIRE(invoke_daemon(request)["ok"] == true);
    request["action"] = "serve-wait";
    REQUIRE(invoke_daemon(request)["ok"] == true);
}

TEST_CASE("active daemon request turns process interrupt into cooperative cancellation")
{
    auto request = context(unique_build("active-signal-cancel"));
    request["action"] = "serve-start";
    REQUIRE(invoke_daemon(request)["ok"] == true);
    request["action"] = "serve-ready";
    REQUIRE(invoke_daemon(request)["ok"] == true);

    auto work_request = request;
    work_request["action"] = "request";
    work_request["requestId"] = "active-signal-cancel";
    work_request["method"] = "invoke";
    work_request["payload"] = Json{{"argv", Json::array({"validate"})}};
    auto pending =
        std::async(std::launch::async, [work_request]() { return invoke_daemon(work_request); });

    request["action"] = "serve-next";
    const auto next = invoke_daemon(request);
    REQUIRE(next["ok"] == true);
    REQUIRE(next["stopped"] == false);

    std::raise(SIGINT);
    std::this_thread::sleep_for(std::chrono::milliseconds(40));
    request["action"] = "serve-cancelled";
    request["token"] = next["token"];
    const auto cancelled = invoke_daemon(request);
    REQUIRE(cancelled["ok"] == true);
    CHECK(cancelled["active"] == true);
    CHECK(cancelled["cancelled"] == true);

    request["action"] = "serve-complete";
    request["requestOk"] = false;
    request["result"] = nullptr;
    request["error"] = "request cancelled";
    REQUIRE(invoke_daemon(request)["ok"] == true);
    REQUIRE(pending.wait_for(std::chrono::seconds(2)) == std::future_status::ready);
    const auto result = pending.get();
    CHECK(result["ok"] == false);
    CHECK(result["error"] == "request cancelled");

    request.erase("token");
    request.erase("requestOk");
    request.erase("result");
    request.erase("error");
    request["action"] = "stop";
    REQUIRE(invoke_daemon(request)["ok"] == true);
    request["action"] = "serve-wait";
    REQUIRE(invoke_daemon(request)["ok"] == true);
}

TEST_CASE("local ScriptC fallback observes process cancellation")
{
    auto request = context(unique_build("local-cancel"));
    request["action"] = "local-cancel-start";
    const auto started = invoke_daemon(request);
    REQUIRE(started["ok"] == true);
    CHECK(started["cancelled"] == false);

    std::raise(SIGINT);
    request["action"] = "local-cancelled";
    const auto cancelled = invoke_daemon(request);
    REQUIRE(cancelled["ok"] == true);
    CHECK(cancelled["active"] == true);
    CHECK(cancelled["cancelled"] == true);

    request["action"] = "local-cancel-stop";
    const auto stopped = invoke_daemon(request);
    REQUIRE(stopped["ok"] == true);
    CHECK(stopped["cancelled"] == true);

    request["action"] = "local-cancelled";
    const auto inactive = invoke_daemon(request);
    REQUIRE(inactive["ok"] == true);
    CHECK(inactive["active"] == false);
    CHECK(inactive["cancelled"] == false);
}

TEST_CASE("daemon client accepts streamed events before the final result")
{
    auto request = context(unique_build("stream-events"));
    request["action"] = "serve-start";
    REQUIRE(invoke_daemon(request)["ok"] == true);
    request["action"] = "serve-ready";
    REQUIRE(invoke_daemon(request)["ok"] == true);

    auto work_request = request;
    work_request["action"] = "request";
    work_request["requestId"] = "stream-events";
    work_request["method"] = "invoke";
    auto pending =
        std::async(std::launch::async, [work_request]() { return invoke_daemon(work_request); });

    request["action"] = "serve-next";
    const auto next = invoke_daemon(request);
    REQUIRE(next["ok"] == true);
    REQUIRE(next["stopped"] == false);

    request["action"] = "serve-event";
    request["token"] = next["token"];
    request["event"] = Json{{"type", "stdout"}, {"text", "streamed-event\n"}};
    const auto streamed = invoke_daemon(request);
    REQUIRE(streamed["ok"] == true);
    CHECK(streamed["delivered"] == true);
    CHECK(pending.wait_for(std::chrono::milliseconds(50)) == std::future_status::timeout);

    request.erase("event");
    request["action"] = "serve-complete";
    request["requestOk"] = true;
    request["result"] = Json{{"value", 9}};
    REQUIRE(invoke_daemon(request)["ok"] == true);
    REQUIRE(pending.wait_for(std::chrono::seconds(2)) == std::future_status::ready);
    const auto result = pending.get();
    CHECK(result["ok"] == true);
    CHECK(result["result"] == Json{{"value", 9}});

    request.erase("token");
    request.erase("requestOk");
    request.erase("result");
    request["action"] = "stop";
    REQUIRE(invoke_daemon(request)["ok"] == true);
    request["action"] = "serve-wait";
    REQUIRE(invoke_daemon(request)["ok"] == true);
}

TEST_CASE("daemon graceful stop waits for active requests to settle")
{
    auto request = context(unique_build("active-drain"));
    request["action"] = "serve-start";
    REQUIRE(invoke_daemon(request)["ok"] == true);
    request["action"] = "serve-ready";
    REQUIRE(invoke_daemon(request)["ok"] == true);

    auto work_request = request;
    work_request["action"] = "request";
    work_request["requestId"] = "active-drain";
    work_request["method"] = "invoke";
    work_request["payload"] = Json{{"argv", Json::array({"validate"})}};
    auto pending =
        std::async(std::launch::async, [work_request]() { return invoke_daemon(work_request); });

    request["action"] = "serve-next";
    const auto next = invoke_daemon(request);
    REQUIRE(next["ok"] == true);
    REQUIRE(next["stopped"] == false);

    auto stop_request = request;
    stop_request.erase("token");
    stop_request["action"] = "stop";
    auto stopping =
        std::async(std::launch::async, [stop_request]() { return invoke_daemon(stop_request); });
    CHECK(stopping.wait_for(std::chrono::milliseconds(80)) == std::future_status::timeout);

    request["action"] = "serve-complete";
    request["token"] = next["token"];
    request["requestOk"] = false;
    request["result"] = nullptr;
    request["error"] = "request cancelled";
    REQUIRE(invoke_daemon(request)["ok"] == true);

    REQUIRE(stopping.wait_for(std::chrono::seconds(2)) == std::future_status::ready);
    const auto stopped = stopping.get();
    REQUIRE(stopped["ok"] == true);
    CHECK(stopped["running"] == false);
    REQUIRE(pending.wait_for(std::chrono::seconds(2)) == std::future_status::ready);
    (void)pending.get();

    request.erase("token");
    request.erase("requestOk");
    request.erase("result");
    request.erase("error");
    request["action"] = "serve-wait";
    REQUIRE(invoke_daemon(request)["ok"] == true);
}

TEST_CASE("daemon idle timeout ignores active and queued work")
{
    auto request = context(unique_build("active-idle"));
    request["daemonIdleMs"] = 60;
    request["action"] = "serve-start";
    REQUIRE(invoke_daemon(request)["ok"] == true);
    request["action"] = "serve-ready";
    REQUIRE(invoke_daemon(request)["ok"] == true);

    auto work_request = request;
    work_request["action"] = "request";
    work_request["requestId"] = "active-idle";
    work_request["method"] = "invoke";
    auto pending =
        std::async(std::launch::async, [work_request]() { return invoke_daemon(work_request); });

    request["action"] = "serve-next";
    const auto next = invoke_daemon(request);
    REQUIRE(next["ok"] == true);
    REQUIRE(next["stopped"] == false);
    std::this_thread::sleep_for(std::chrono::milliseconds(140));

    auto status_request = request;
    status_request.erase("token");
    status_request["action"] = "status";
    const auto active_status = invoke_daemon(status_request);
    CHECK(active_status["running"] == true);
    CHECK(active_status["state"] == "ready");

    request["action"] = "serve-complete";
    request["token"] = next["token"];
    request["requestOk"] = true;
    request["result"] = Json{{"done", true}};
    REQUIRE(invoke_daemon(request)["ok"] == true);
    REQUIRE(pending.wait_for(std::chrono::seconds(2)) == std::future_status::ready);
    (void)pending.get();

    request.erase("token");
    request.erase("requestOk");
    request.erase("result");
    request["action"] = "serve-wait";
    auto waiting = std::async(std::launch::async, [request]() { return invoke_daemon(request); });
    REQUIRE(waiting.wait_for(std::chrono::seconds(2)) == std::future_status::ready);
    CHECK(waiting.get()["state"] == "stopped");
}

TEST_CASE("daemon graceful stop waits for transaction critical sections")
{
    auto request = context(unique_build("critical"));
    request["action"] = "serve-start";
    REQUIRE(invoke_daemon(request)["ok"] == true);
    request["action"] = "serve-ready";
    REQUIRE(invoke_daemon(request)["ok"] == true);
    request["action"] = "serve-enter-critical";
    const auto entered = invoke_daemon(request);
    REQUIRE(entered["ok"] == true);
    CHECK(entered["criticalSections"] == 1);

    auto stop_request = request;
    stop_request["action"] = "stop";
    auto stopping =
        std::async(std::launch::async, [stop_request]() { return invoke_daemon(stop_request); });
    CHECK(stopping.wait_for(std::chrono::milliseconds(50)) == std::future_status::timeout);

    request["action"] = "serve-leave-critical";
    const auto left = invoke_daemon(request);
    REQUIRE(left["ok"] == true);
    CHECK(left["criticalSections"] == 0);

    REQUIRE(stopping.wait_for(std::chrono::seconds(2)) == std::future_status::ready);
    const auto stopped = stopping.get();
    REQUIRE(stopped["ok"] == true);
    CHECK(stopped["running"] == false);

    request["action"] = "serve-wait";
    REQUIRE(invoke_daemon(request)["ok"] == true);
}

TEST_CASE("daemon broker expires after internal idle timeout")
{
    auto request = context(unique_build("idle"));
    request["daemonIdleMs"] = 60;
    request["action"] = "serve-start";
    REQUIRE(invoke_daemon(request)["ok"] == true);

    const auto started_at = std::chrono::steady_clock::now();
    request["action"] = "serve-wait";
    const auto waited = invoke_daemon(request);
    const auto elapsed = std::chrono::steady_clock::now() - started_at;
    REQUIRE(waited["ok"] == true);
    CHECK(waited["state"] == "stopped");
    CHECK(elapsed < std::chrono::seconds(2));
}

TEST_CASE("daemon idle drain preserves transaction critical sections")
{
    auto request = context(unique_build("idle-critical"));
    request["daemonIdleMs"] = 60;
    request["action"] = "serve-start";
    REQUIRE(invoke_daemon(request)["ok"] == true);
    request["action"] = "serve-enter-critical";
    REQUIRE(invoke_daemon(request)["ok"] == true);

    request["action"] = "serve-wait";
    auto waiting = std::async(std::launch::async, [request]() { return invoke_daemon(request); });
    CHECK(waiting.wait_for(std::chrono::milliseconds(120)) == std::future_status::timeout);

    request["action"] = "serve-leave-critical";
    REQUIRE(invoke_daemon(request)["ok"] == true);
    REQUIRE(waiting.wait_for(std::chrono::seconds(2)) == std::future_status::ready);
    const auto stopped = waiting.get();
    CHECK(stopped["state"] == "stopped");
}

#if !defined(_WIN32)
TEST_CASE("daemon ensure bounds hung status I/O by the startup deadline")
{
    auto runtime = temp_runtime_root("hung-status");
    std::filesystem::create_directories(runtime.path);
    auto request = context(unique_build("hung-status"));
    request["runtimeRoot"] = runtime.path.generic_string();
    request["action"] = "ensure";
    request["executablePath"] = "/bin/false";
    request["startupTimeoutMs"] = 80;

    const auto identity = noveltea::tooling::daemon::endpoint_identity(
        request["build"].get<std::string>(), request["protocol"].get<std::uint32_t>());
    const auto socket_path = runtime.path / ("daemon-" + identity + ".sock");
    const auto lifetime_path = runtime.path / ("daemon-" + identity + ".live.lock");
    const auto listener = ::socket(AF_UNIX, SOCK_STREAM, 0);
    REQUIRE(listener >= 0);
    sockaddr_un address{};
    address.sun_family = AF_UNIX;
    const auto socket_text = socket_path.string();
    REQUIRE(socket_text.size() < sizeof(address.sun_path));
    std::memcpy(address.sun_path, socket_text.c_str(), socket_text.size() + 1);
    REQUIRE(::bind(listener, reinterpret_cast<const sockaddr*>(&address), sizeof(address)) == 0);
    REQUIRE(::listen(listener, 1) == 0);

    const auto lifetime = ::open(lifetime_path.c_str(), O_CREAT | O_RDWR | O_CLOEXEC, 0600);
    REQUIRE(lifetime >= 0);
    REQUIRE(::flock(lifetime, LOCK_EX | LOCK_NB) == 0);

    std::thread hung([listener] {
        const auto connection = ::accept(listener, nullptr, nullptr);
        if (connection >= 0) {
            std::this_thread::sleep_for(std::chrono::milliseconds(350));
            ::close(connection);
        }
    });
    const auto started = std::chrono::steady_clock::now();
    const auto rejected = invoke_daemon(request);
    const auto elapsed = std::chrono::steady_clock::now() - started;
    CHECK(rejected["ok"] == false);
    CHECK(elapsed < std::chrono::milliseconds(250));

    ::shutdown(listener, SHUT_RDWR);
    ::close(listener);
    hung.join();
    ::flock(lifetime, LOCK_UN);
    ::close(lifetime);
}

TEST_CASE("daemon startup refuses to unlink an endpoint with live ownership")
{
    auto runtime = temp_runtime_root("live-endpoint");
    std::filesystem::create_directories(runtime.path);
    auto request = context(unique_build("live-endpoint"));
    request["runtimeRoot"] = runtime.path.generic_string();
    const auto identity = noveltea::tooling::daemon::endpoint_identity(
        request["build"].get<std::string>(), request["protocol"].get<std::uint32_t>());
    const auto socket_path = runtime.path / ("daemon-" + identity + ".sock");
    const auto lifetime_path = runtime.path / ("daemon-" + identity + ".live.lock");

    const auto socket_handle = ::socket(AF_UNIX, SOCK_STREAM, 0);
    REQUIRE(socket_handle >= 0);
    sockaddr_un address{};
    address.sun_family = AF_UNIX;
    const auto socket_text = socket_path.string();
    REQUIRE(socket_text.size() < sizeof(address.sun_path));
    std::memcpy(address.sun_path, socket_text.c_str(), socket_text.size() + 1);
    REQUIRE(::bind(socket_handle, reinterpret_cast<const sockaddr*>(&address), sizeof(address)) ==
            0);
    ::close(socket_handle);

    const auto lifetime_handle = ::open(lifetime_path.c_str(), O_CREAT | O_RDWR | O_CLOEXEC, 0600);
    REQUIRE(lifetime_handle >= 0);
    REQUIRE(::flock(lifetime_handle, LOCK_EX | LOCK_NB) == 0);

    request["action"] = "ensure";
    request["executablePath"] = "/bin/false";
    request["startupTimeoutMs"] = 50;
    const auto rejected = invoke_daemon(request);
    CHECK(rejected["ok"] == false);
    CHECK(rejected["error"] == "refusing unsafe daemon endpoint takeover");
    CHECK(std::filesystem::is_socket(socket_path));

    ::flock(lifetime_handle, LOCK_UN);
    ::close(lifetime_handle);
}

TEST_CASE("daemon Unix runtime root rejects symlink takeover")
{
    auto runtime = temp_runtime_root("symlink");
    std::filesystem::create_directories(runtime.path);
    const auto target = runtime.path / "target";
    const auto link = runtime.path / "runtime-link";
    std::filesystem::create_directory(target);
    std::filesystem::create_directory_symlink(target, link);

    auto request = context(unique_build("symlink"));
    request["runtimeRoot"] = link.generic_string();
    request["action"] = "serve-start";
    const auto rejected = invoke_daemon(request);
    CHECK(rejected["ok"] == false);
    CHECK(rejected["error"] == "daemon runtime directory is not owned by the current user");
}

TEST_CASE("daemon Unix endpoint is private to the current user")
{
    auto runtime = temp_runtime_root("permissions");
    auto request = context(unique_build("permissions"));
    request["runtimeRoot"] = runtime.path.generic_string();
    request["action"] = "serve-start";
    REQUIRE(invoke_daemon(request)["ok"] == true);

    struct stat directory_info {};
    REQUIRE(::lstat(runtime.path.c_str(), &directory_info) == 0);
    CHECK(directory_info.st_uid == geteuid());
    CHECK((directory_info.st_mode & 0077) == 0);

    const auto identity = noveltea::tooling::daemon::endpoint_identity(
        request["build"].get<std::string>(), request["protocol"].get<std::uint32_t>());
    const auto socket_path = runtime.path / ("daemon-" + identity + ".sock");
    struct stat socket_info {};
    REQUIRE(::lstat(socket_path.c_str(), &socket_info) == 0);
    CHECK(S_ISSOCK(socket_info.st_mode));
    CHECK(socket_info.st_uid == geteuid());
    CHECK((socket_info.st_mode & 0077) == 0);

    request["action"] = "stop";
    REQUIRE(invoke_daemon(request)["ok"] == true);
    request["action"] = "serve-wait";
    REQUIRE(invoke_daemon(request)["ok"] == true);
}
#endif
