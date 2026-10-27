#include "native_cli_daemon.hpp"
#include "native_cli_paths.hpp"

#include "native_cli_contract.hpp"
#include "tooling_daemon_broker.hpp"
#include "tooling_native_c.h"

#include <nlohmann/json.hpp>

#include <algorithm>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cwchar>
#include <filesystem>
#include <iostream>
#include <map>
#include <sstream>
#include <stdexcept>
#include <string>

#if defined(_WIN32)
#define NOMINMAX
#include <Windows.h>
#else
#include <unistd.h>
#endif

namespace noveltea::cli {
namespace {
using Json = nlohmann::json;
using NativeOperation = std::uint64_t (*)(const std::uint8_t*, std::uint64_t, std::uint8_t*,
                                          std::uint64_t);

Json native_call(NativeOperation operation, const Json& request)
{
    const auto serialized = request.dump();
    // The broker has stateful operations: a size probe would dispatch twice.
    // Owner polls on an idle cadence; reuse the frame buffer instead of
    // allocating a multi-megabyte response area on every poll.
    thread_local std::string response(tooling::daemon::max_frame_bytes, '\0');
    const auto length =
        operation(reinterpret_cast<const std::uint8_t*>(serialized.data()), serialized.size(),
                  reinterpret_cast<std::uint8_t*>(response.data()), response.size());
    if (length == 0 || length > response.size())
        throw std::runtime_error("Native daemon reply exceeds the protocol frame limit.");
    return Json::parse(response.begin(), response.begin() + static_cast<std::ptrdiff_t>(length));
}

Json broker_context()
{
    Json result{{"build", build_identity.empty() ? "native-cli-dev" : std::string(build_identity)},
                {"protocol", tooling::daemon::protocol_version}};
    // Only the explicit certification environment can isolate a test broker.
    if (const auto root = native_daemon_certification_runtime_root())
        result["runtimeRoot"] = *root;
    return result;
}

Json broker_call(const Json& context, std::string_view action, const Json& fields = Json::object())
{
    Json request = context;
    request["action"] = action;
    request.update(fields);
    return native_call(noveltea_tooling_daemon_json, request);
}

std::string utf8_path(const std::filesystem::path& path)
{
    const auto text = path.u8string();
    return {text.begin(), text.end()};
}

#if defined(_WIN32)
std::wstring wide_from_utf8(std::string_view text)
{
    if (text.empty())
        return {};
    const auto count = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(),
                                           static_cast<int>(text.size()), nullptr, 0);
    if (count <= 0)
        throw std::runtime_error("Invalid UTF-8 native Project environment.");
    std::wstring result(static_cast<std::size_t>(count), L'\0');
    if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(),
                            static_cast<int>(text.size()), result.data(), count) != count)
        throw std::runtime_error("Invalid UTF-8 native Project environment.");
    return result;
}

std::string utf8_from_wide(std::wstring_view text)
{
    if (text.empty())
        return {};
    const auto count =
        WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, text.data(),
                            static_cast<int>(text.size()), nullptr, 0, nullptr, nullptr);
    if (count <= 0)
        throw std::runtime_error("Invalid Unicode native Project environment.");
    std::string result(static_cast<std::size_t>(count), '\0');
    if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, text.data(),
                            static_cast<int>(text.size()), result.data(), count, nullptr,
                            nullptr) != count)
        throw std::runtime_error("Invalid Unicode native Project environment.");
    return result;
}
#endif

using Environment = std::map<std::string, std::string>;

Environment current_environment()
{
    Environment result;
#if defined(_WIN32)
    const auto block = GetEnvironmentStringsW();
    if (!block)
        throw std::runtime_error("Cannot capture native Project worker environment.");
    try {
        for (const wchar_t* item = block; *item; item += std::wcslen(item) + 1) {
            const std::wstring_view setting(item);
            if (setting.starts_with(L'='))
                continue; // Win32's private per-drive entries are not user variables.
            const auto equals = setting.find(L'=', 1);
            if (equals != std::wstring_view::npos)
                result.emplace(utf8_from_wide(setting.substr(0, equals)),
                               utf8_from_wide(setting.substr(equals + 1)));
        }
    } catch (...) {
        FreeEnvironmentStringsW(block);
        throw;
    }
    FreeEnvironmentStringsW(block);
#else
    for (auto** item = ::environ; item && *item; ++item) {
        const std::string_view setting(*item);
        const auto equals = setting.find('=');
        if (equals != std::string_view::npos && equals != 0)
            result.emplace(setting.substr(0, equals), setting.substr(equals + 1));
    }
#endif
    return result;
}

bool set_environment_variable(const std::string& name, const std::string* value)
{
#if defined(_WIN32)
    const auto wide_name = wide_from_utf8(name);
    const auto wide_value = value ? wide_from_utf8(*value) : std::wstring{};
    return SetEnvironmentVariableW(wide_name.c_str(), value ? wide_value.c_str() : nullptr) != 0;
#else
    return value ? ::setenv(name.c_str(), value->c_str(), 1) == 0 : ::unsetenv(name.c_str()) == 0;
#endif
}

struct ScopedEnvironment {
    Environment previous;

    explicit ScopedEnvironment(const Json& supplied) : previous(current_environment())
    {
        if (!supplied.is_object())
            throw std::invalid_argument("Native Project environment must be an object.");
        Environment next;
        for (const auto& [key, value] : supplied.items()) {
            if (key.empty() || key.find('=') != std::string::npos || !value.is_string())
                throw std::invalid_argument("Malformed native Project environment entry.");
            next.emplace(key, value.get<std::string>());
        }
        try {
            apply(next);
        } catch (...) {
            restore();
            throw;
        }
    }

    void apply(const Environment& next)
    {
        for (const auto& [key, value] : current_environment()) {
            if (!next.contains(key) && !set_environment_variable(key, nullptr))
                throw std::runtime_error("Cannot isolate native Project environment.");
        }
        for (const auto& [key, value] : next) {
            const auto previous_value = previous.find(key);
            if ((previous_value == previous.end() || previous_value->second != value) &&
                !set_environment_variable(key, &value))
                throw std::runtime_error("Cannot apply native Project environment.");
        }
    }

    void restore() noexcept
    {
        try {
            for (const auto& [key, value] : current_environment())
                if (!previous.contains(key))
                    (void)set_environment_variable(key, nullptr);
            for (const auto& [key, value] : previous)
                (void)set_environment_variable(key, &value);
        } catch (...) {
            // Destructors must never hide the command's actual result.
        }
    }

    ~ScopedEnvironment() { restore(); }
};

int report_failure(std::string_view message, bool json)
{
    if (!json) {
        std::cerr << "[error] DAEMON_BROKER /: " << message << '\n';
    } else {
        std::cout << Json{{"success", false},
                          {"exitCode", 70},
                          {"protocolVersion", 1},
                          {"diagnostics", Json::array({{{"code", "DAEMON_BROKER"},
                                                        {"severity", "error"},
                                                        {"path", "/"},
                                                        {"message", message}}})}}
                         .dump()
                  << '\n';
    }
    return 70;
}

struct ScopedDirectory {
    std::filesystem::path previous;
    explicit ScopedDirectory(std::string_view requested)
    {
        previous = std::filesystem::current_path();
        std::filesystem::current_path(native_path_from_utf8(requested));
    }
    ~ScopedDirectory()
    {
        std::error_code ignored;
        std::filesystem::current_path(previous, ignored);
    }
};

struct CapturedOutput {
    std::ostringstream out;
    std::ostringstream err;
    std::streambuf* old_out = nullptr;
    std::streambuf* old_err = nullptr;

    CapturedOutput()
    {
        old_out = std::cout.rdbuf(out.rdbuf());
        old_err = std::cerr.rdbuf(err.rdbuf());
    }
    ~CapturedOutput()
    {
        std::cout.rdbuf(old_out);
        std::cerr.rdbuf(old_err);
    }
};

Json owner_authority_configuration(const std::filesystem::path& root)
{
    // Match the complete Project source-discovery families used by the
    // resident Project adapter; watch Assets conservatively to include
    // physical source/attachment changes in every exact-result proof. An
    // authored Project can also reference arbitrary distribution-notice and
    // script files outside these canonical directories. Include all present
    // Project files (except private generated state) in the authoritative
    // manifest; accepting a false hit is never a performance optimization.
    Json authoritative = Json::array({"project.yaml", "editor.yaml", "traits.yaml"});
    std::error_code error;
    std::filesystem::recursive_directory_iterator files(
        root, std::filesystem::directory_options::none, error);
    if (error)
        throw std::runtime_error("Cannot establish complete Project authority inventory.");
    const std::filesystem::recursive_directory_iterator end;
    while (files != end) {
        const auto& entry = *files;
        const auto relative = entry.path().lexically_relative(root);
        const auto path = utf8_path(relative);
        if (entry.is_symlink(error) || error)
            throw std::runtime_error("Cannot prove Project authority through a symbolic link.");
        if (entry.is_directory(error)) {
            if (error)
                throw std::runtime_error("Cannot inspect Project authority directory.");
            if (path == ".git" || path == ".noveltea")
                files.disable_recursion_pending();
        } else if (entry.is_regular_file(error)) {
            if (error)
                throw std::runtime_error("Cannot inspect Project authority source.");
            if (!path.starts_with(".git/") && !path.starts_with(".noveltea/"))
                authoritative.push_back(path);
        } else if (error) {
            throw std::runtime_error("Cannot inspect Project authority entry.");
        }
        files.increment(error);
        if (error)
            throw std::runtime_error("Cannot finish Project authority discovery.");
    }
    return {{"authoritativePaths", std::move(authoritative)},
            {"discoveryScopes",
             Json::array({{{"root", "i18n"},
                           {"extensions", Json::array({".yaml", ".json"})},
                           {"excludedPrefixes", Json::array()}},
                          {{"root", "records"},
                           {"extensions", Json::array({".yaml", ".json", ".lua", ".rcss", ".rml"})},
                           {"excludedPrefixes", Json::array()}},
                          {{"root", "scripts"},
                           {"extensions", Json::array({".lua"})},
                           {"excludedPrefixes", Json::array()}},
                          {{"root", "shaders"},
                           {"extensions", Json::array({".sc", ".sh", ".inc", ".glsl", ".h"})},
                           {"excludedPrefixes", Json::array()}},
                          {{"root", "assets"},
                           {"extensions", Json::array({"*"})},
                           {"excludedPrefixes", Json::array()}}})}};
}

std::string native_validation_semantic_key()
{
    return Json{{"contract", "noveltea.authoring-validation.exact.native"},
                {"cliVersion", version},
                {"buildIdentity", build_identity},
                {"compilerIdentity", compiler_identity},
                {"validationProfile", "authoring"},
                {"validationOptions", "default"},
                {"validationConfiguration", "project-settings+native-font-coverage"}}
        .dump();
}

bool native_validation_argv(const Json& payload)
{
    return payload.value("nativeValidationRequest", false) &&
           payload.value("outputMode", std::string{}) == "json";
}

Json run_owner_command(const Json& payload,
                       const std::function<int(const std::vector<std::string>&)>& run_local)
{
    if (!payload.is_object() || !payload.contains("argv") || !payload["argv"].is_array() ||
        !payload.contains("cwd") || !payload["cwd"].is_string() ||
        !payload.contains("ownerProjectRoot") || !payload["ownerProjectRoot"].is_string())
        throw std::runtime_error("Malformed native Project-owner invocation.");
    std::vector<std::string> argv{"--no-daemon"};
    for (const auto& part : payload["argv"]) {
        if (!part.is_string())
            throw std::runtime_error("Malformed Project-owner argument.");
        argv.push_back(part.get<std::string>());
    }
    ScopedEnvironment environment(payload.at("environment"));
    ScopedDirectory cwd(payload["cwd"].get_ref<const std::string&>());
    CapturedOutput capture;
    const int code = run_local(argv);
    return Json::array({code, capture.out.str(), capture.err.str()});
}

std::optional<Json> parse_hidden_context(const std::vector<std::string>& argv, std::string& action,
                                         std::uint64_t& worker_id)
{
    if (argv.empty() || (argv[0] != "__daemon-broker" && argv[0] != "__daemon-owner" &&
                         argv[0] != "__daemon-disposable"))
        return std::nullopt;
    action = argv[0];
    Json context = broker_context();
    Json supplied = Json::object();
    for (std::size_t i = 1; i < argv.size(); i += 2) {
        if (i + 1 == argv.size() || !argv[i].starts_with("--") || supplied.contains(argv[i]))
            throw std::invalid_argument("Malformed private daemon invocation.");
        const auto& key = argv[i];
        const auto& value = argv[i + 1];
        if (key == "--daemon-build" || key == "--daemon-runtime-root") {
            supplied[key] = value;
        } else if (key == "--daemon-protocol" || key == "--daemon-idle-ms" ||
                   key == "--project-session-idle-ms" || key == "--project-snapshot-budget-bytes" ||
                   key == "--exact-validation-budget-bytes" || key == "--owner-worker-id" ||
                   key == "--disposable-worker-id") {
            std::size_t consumed = 0;
            const auto number = std::stoull(value, &consumed);
            if (consumed != value.size() || number == 0)
                throw std::invalid_argument("Invalid private daemon numeric option.");
            supplied[key] = number;
        } else {
            throw std::invalid_argument("Unknown private daemon option.");
        }
    }
    if (supplied.value("--daemon-build", std::string{}) != context["build"].get<std::string>() ||
        supplied.value("--daemon-protocol", std::uint64_t{0}) !=
            tooling::daemon::protocol_version ||
        !supplied.contains("--daemon-idle-ms") || !supplied.contains("--project-session-idle-ms"))
        throw std::invalid_argument("Private daemon executable identity mismatch.");
    context["daemonIdleMs"] = supplied["--daemon-idle-ms"];
    context["projectSessionIdleMs"] = supplied["--project-session-idle-ms"];
    if (supplied.contains("--daemon-runtime-root"))
        context["runtimeRoot"] = supplied["--daemon-runtime-root"];
    if (action == "__daemon-broker") {
        if (!supplied.contains("--project-snapshot-budget-bytes") ||
            !supplied.contains("--exact-validation-budget-bytes") ||
            supplied.contains("--owner-worker-id") || supplied.contains("--disposable-worker-id"))
            throw std::invalid_argument("Malformed private broker invocation.");
        context["projectSnapshotBudgetBytes"] = supplied["--project-snapshot-budget-bytes"];
        context["exactValidationBudgetBytes"] = supplied["--exact-validation-budget-bytes"];
    } else {
        const auto id_key =
            action == "__daemon-owner" ? "--owner-worker-id" : "--disposable-worker-id";
        if (!supplied.contains(id_key) || supplied.contains("--project-snapshot-budget-bytes") ||
            supplied.contains("--exact-validation-budget-bytes") ||
            (action == "__daemon-owner" && supplied.contains("--disposable-worker-id")) ||
            (action == "__daemon-disposable" && supplied.contains("--owner-worker-id")))
            throw std::invalid_argument("Malformed private worker invocation.");
        worker_id = supplied[id_key].get<std::uint64_t>();
    }
    return context;
}

void require_ok(const Json& response)
{
    if (!response.value("ok", false))
        throw std::runtime_error(response.value("error", "Native daemon request failed."));
}

int broker_process(const Json& context)
{
    require_ok(broker_call(context, "serve-start"));
    try {
        require_ok(broker_call(context, "serve-ready"));
        require_ok(broker_call(context, "serve-wait"));
        return 0;
    } catch (...) {
        (void)broker_call(context, "serve-abort");
        throw;
    }
}

int owner_process(const Json& context, std::uint64_t worker_id,
                  const std::function<int(const std::vector<std::string>&)>& run_local)
{
    const auto descriptor =
        broker_call(context, "owner-snapshot-describe", {{"ownerWorkerId", worker_id}});
    require_ok(descriptor);
    const std::string canonical_root = descriptor.at("canonicalRoot").get<std::string>();
    const auto session_epoch = descriptor.at("coldSessionEpoch").get<std::uint64_t>();
    std::optional<Json> last_manifest;
    std::uint64_t generation = 0;
    const auto observe = [&]() -> std::optional<Json> {
        Json request;
        try {
            request = owner_authority_configuration(native_path_from_utf8(canonical_root));
        } catch (const std::exception&) {
            return std::nullopt; // A failed proof must never produce an exact result.
        }
        request["ownerWorkerId"] = worker_id;
        request["projectRoot"] = canonical_root;
        const auto observed = broker_call(context, "owner-project-observe", request);
        if (!observed.value("ok", false))
            return std::nullopt; // The native command still diagnoses source errors.
        const auto& manifest = observed.at("manifest");
        if (!last_manifest || *last_manifest != manifest) {
            ++generation;
            require_ok(broker_call(context, "owner-project-generation",
                                   {{"ownerWorkerId", worker_id},
                                    {"sessionEpoch", session_epoch},
                                    {"generation", generation}}));
            last_manifest = manifest;
        }
        return std::optional<Json>(std::in_place, observed);
    };
    for (;;) {
        const auto next = broker_call(context, "owner-next", {{"ownerWorkerId", worker_id}});
        require_ok(next);
        if (next.value("stopped", false))
            return 0;
        if (next.value("idle", false)) {
            const auto pending =
                broker_call(context, "owner-needs-reconcile", {{"ownerWorkerId", worker_id}});
            if (pending.value("ok", false) && pending.value("needsReconcile", false)) {
                const auto before = generation;
                (void)observe();
                require_ok(broker_call(
                    context, "owner-reconcile-complete",
                    {{"ownerWorkerId", worker_id}, {"advanced", generation != before}}));
            }
            continue;
        }
        const auto token = next.at("token").get<std::uint64_t>();
        Json completion{{"ownerWorkerId", worker_id}, {"token", token}};
        try {
            if (next.value("prepareDisposable", false))
                throw std::runtime_error("Native pinned disposable preparation is owned by #550.");
            if (next.value("method", "") != "invoke")
                throw std::runtime_error("Native owner received an unsupported method.");
            const auto before = observe();
            const auto& payload = next.at("payload");
            const bool validation = native_validation_argv(payload);
            const auto cancelled = [&] {
                const auto status = broker_call(context, "owner-cancelled",
                                                {{"ownerWorkerId", worker_id}, {"token", token}});
                return !status.value("ok", false) || status.value("cancelled", true);
            };
            if (cancelled())
                throw std::runtime_error("Native Project request cancelled before execution.");
            completion["result"] = run_owner_command(payload, run_local);
            if (cancelled())
                throw std::runtime_error(
                    "Native Project request cancelled during execution; its disk outcome must be "
                    "verified before retrying.");
            const auto after = observe();
            // The broker only retains a result when two authoritative observations
            // bracket the validated source generation with no physical changes.
            if (validation && before && after && before->at("manifest") == after->at("manifest")) {
                const auto& result = completion.at("result");
                const auto structured =
                    Json::parse(result.at(1).get<std::string>(), nullptr, false);
                if (structured.is_object() && structured.contains("success") &&
                    structured["success"].is_boolean() && structured.contains("diagnostics") &&
                    structured["diagnostics"].is_array() &&
                    result.at(0).get<int>() == structured.value("exitCode", -1) &&
                    (structured.value("exitCode", -1) == 0 ||
                     structured.value("exitCode", -1) == 4)) {
                    (void)broker_call(
                        context, "owner-validation-result",
                        {{"ownerWorkerId", worker_id},
                         {"token", token},
                         {"semanticKey", native_validation_semantic_key()},
                         {"validationResult", Json{{"success", structured.at("success")},
                                                   {"exitCode", structured.at("exitCode")},
                                                   {"diagnostics", structured.at("diagnostics")},
                                                   {"editorDiagnostics", Json::array()}}}});
                }
            }
            completion["requestOk"] = true;
        } catch (const std::exception& error) {
            completion["requestOk"] = false;
            completion["error"] = error.what();
        }
        require_ok(broker_call(context, "owner-complete", completion));
    }
}

int disposable_process(const Json& context, std::uint64_t worker_id)
{
    require_ok(broker_call(context, "disposable-ready", {{"disposableWorkerId", worker_id}}));
    const auto next = broker_call(context, "disposable-next", {{"disposableWorkerId", worker_id}});
    require_ok(next);
    if (next.value("stopped", false))
        return 0;
    // #550 adds the native immutable snapshot hydration/execution boundary.
    require_ok(broker_call(context, "disposable-complete",
                           {{"disposableWorkerId", worker_id},
                            {"token", next.at("token")},
                            {"requestOk", false},
                            {"error", "Native disposable execution is not available."}}));
    return 0;
}

} // namespace

std::optional<std::string> native_daemon_certification_runtime_root()
{
    if (const char* certified = std::getenv("NOVELTEA_CLI_CERTIFICATION");
        certified && std::string_view(certified) == "1") {
        if (const char* root = std::getenv("NOVELTEA_CLI_CERTIFICATION_DAEMON_RUNTIME_ROOT");
            root && *root)
            return root;
    }
    return std::nullopt;
}

std::optional<int> route_native_project_owner(const std::vector<std::string>& argv,
                                              std::string_view project_root, bool explicit_project,
                                              bool mutation, bool json, bool validation)
{
    auto context = broker_context();
    const auto ready = broker_call(context, "ensure");
    if (!ready.value("ok", false) || !ready.value("running", false))
        return std::nullopt; // No dispatched request: safe native local execution.
    static std::atomic<std::uint64_t> sequence{1};
    const auto request_id =
        "native-owner-" + std::to_string(sequence.fetch_add(1, std::memory_order_relaxed));
    const Json payload{{"argv", argv},
                       {"cwd", utf8_path(std::filesystem::current_path())},
                       {"environment", current_environment()},
                       {"executionClass", mutation ? "owner-mutation" : "owner-short"},
                       {"ownerProjectRoot", project_root},
                       {"ownerProjectRootExplicit", explicit_project},
                       {"replaySafe", !mutation},
                       {"streamedEvents", false},
                       {"outputMode", json ? "json" : "human"},
                       {"nativeValidationRequest", validation},
                       {"authoringValidationSemanticKey",
                        json && validation ? native_validation_semantic_key() : std::string{}}};
    const auto reply =
        broker_call(context, "request",
                    {{"requestId", request_id}, {"method", "invoke"}, {"payload", payload}});
    // A failed in-flight read is safe to re-execute locally. A mutation may
    // already have committed, so it must never be replayed after dispatch.
    // Cancellation is the caller's decision, not an acceleration failure.
    if (!reply.value("ok", false) && !mutation && !reply.value("cancelled", false) &&
        reply.value("error", std::string{}).find("cancel") == std::string::npos)
        return std::nullopt;
    if (reply.value("ok", false) && reply.contains("retainedValidationResult") &&
        reply["retainedValidationResult"].is_object()) {
        Json cached = reply["retainedValidationResult"];
        cached["projectRoot"] = project_root;
        cached["protocolVersion"] = 1;
        std::cout << cached.dump() << '\n';
        return cached.at("exitCode").get<int>();
    }
    if (!reply.value("ok", false) || !reply.contains("result") || !reply["result"].is_array() ||
        reply["result"].size() != 3 || !reply["result"][0].is_number_integer() ||
        !reply["result"][1].is_string() || !reply["result"][2].is_string()) {
        return report_failure(reply.value("error", "Invalid Project-owner completion."), json);
    }
    const auto& result = reply["result"];
    const auto& output = result[1].get_ref<const std::string&>();
    const auto& diagnostics = result[2].get_ref<const std::string&>();
    std::fwrite(output.data(), 1, output.size(), stdout);
    std::fwrite(diagnostics.data(), 1, diagnostics.size(), stderr);
    return result[0].get<int>();
}

std::optional<int>
run_native_daemon_process(const std::vector<std::string>& argv,
                          const std::function<int(const std::vector<std::string>&)>& run_local)
{
    std::string action;
    std::uint64_t worker_id = 0;
    const auto context = parse_hidden_context(argv, action, worker_id);
    if (!context)
        return std::nullopt;
    if (action == "__daemon-broker")
        return broker_process(*context);
    if (action == "__daemon-owner")
        return owner_process(*context, worker_id, run_local);
    return disposable_process(*context, worker_id);
}

} // namespace noveltea::cli
