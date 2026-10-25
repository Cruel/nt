#include "native_cli_contract.hpp"
#include "native_cli_test_catalog.hpp"
#include "tooling_native_c.h"
#include "../project_authoring/material_semantics.hpp"

#include <noveltea/core/player_bootstrap.hpp>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <array>
#include <cctype>
#include <chrono>
#include <cstdio>
#include <filesystem>
#include <iterator>
#include <iostream>
#include <map>
#include <random>
#include <regex>
#include <set>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>
#if defined(_WIN32)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <Windows.h>
#include <io.h>
#include <fcntl.h>
#else
#include <fcntl.h>
#include <unistd.h>
#endif

namespace noveltea::cli {
namespace {
using Json = nlohmann::ordered_json;

struct Arguments {
    bool json = false;
    bool no_daemon = false;
    bool help = false;
    bool version = false;
    std::string project;
    std::vector<std::string> command;
};

Arguments parse(const std::vector<std::string>& args)
{
    Arguments result;
    std::size_t i = 0;
    for (; i < args.size() && args[i].starts_with("--"); ++i) {
        const auto& arg = args[i];
        bool* flag = arg == "--json"        ? &result.json
                     : arg == "--no-daemon" ? &result.no_daemon
                                            : nullptr;
        if (flag) {
            if (*flag)
                throw std::invalid_argument("Global option '" + arg +
                                            "' may be supplied only once.");
            *flag = true;
        } else if (arg == "--help") {
            result.help = true;
        } else if (arg == "--version") {
            result.version = true;
        } else if (arg == "--project") {
            if (!result.project.empty())
                throw std::invalid_argument("Global option '--project' may be supplied only once.");
            if (i + 1 == args.size() || args[i + 1].empty() || args[i + 1].starts_with("--"))
                throw std::invalid_argument(
                    "Global option '--project' requires a project directory.");
            result.project = args[++i];
        } else {
            throw std::invalid_argument("Unknown global option '" + arg + "'.");
        }
    }
    result.command.assign(args.begin() + static_cast<std::ptrdiff_t>(i), args.end());
    if ((result.help || result.version) && !result.command.empty())
        throw std::invalid_argument("--help and --version do not accept a command path.");
    if (result.help && result.version)
        throw std::invalid_argument("--help and --version cannot be combined.");
    return result;
}

Json diagnostic(std::string code, std::string path, std::string message)
{
    return {{"code", code}, {"severity", "error"}, {"path", path}, {"message", message}};
}

int emit(Json envelope, bool json, const std::string& message = {})
{
    envelope["protocolVersion"] = 1;
    auto& diagnostics = envelope["diagnostics"];
    std::sort(diagnostics.begin(), diagnostics.end(), [](const Json& a, const Json& b) {
        for (const auto* key : {"code", "path", "sourceUrl"}) {
            const auto left = a.value(key, std::string{}), right = b.value(key, std::string{});
            if (left != right)
                return left < right;
        }
        for (const auto* key : {"line", "column"}) {
            const auto left = a.value(key, 0), right = b.value(key, 0);
            if (left != right)
                return left < right;
        }
        return a.value("message", std::string{}) < b.value("message", std::string{});
    });
    if (json) {
        std::cout << envelope.dump() << '\n';
    } else {
        for (const auto& item : diagnostics) {
            std::cerr << '[' << item.at("severity").get<std::string>() << "] "
                      << item.at("code").get<std::string>() << ' '
                      << item.at("path").get<std::string>();
            if (item.contains("sourceUrl")) {
                std::cerr << " (" << item.at("sourceUrl").get<std::string>();
                if (item.contains("line")) {
                    std::cerr << ':' << item.at("line");
                    if (item.contains("column"))
                        std::cerr << ':' << item.at("column");
                }
                std::cerr << ')';
            }
            std::cerr << ": " << item.at("message").get<std::string>() << '\n';
        }
        if (!message.empty())
            (envelope.at("success").get<bool>() ? std::cout : std::cerr) << message << '\n';
    }
    return envelope.at("exitCode").get<int>();
}

int failure(bool json, int code, const std::string& category, const std::string& path,
            const std::string& message, const std::string& human)
{
    return emit({{"success", false},
                 {"exitCode", code},
                 {"diagnostics", Json::array({diagnostic(category, path, message)})}},
                json, human);
}

int usage(bool json, const std::string& message)
{
    std::string text(help);
    while (!text.empty() && text.back() == '\n')
        text.pop_back();
    return failure(json, 2, "CLI_USAGE", "/", message, message + "\n\n" + text);
}

std::string path_text(const std::filesystem::path& path)
{
    const auto text = path.u8string();
    return {text.begin(), text.end()};
}

std::filesystem::path project_root(const std::string& selected)
{
    auto current =
        std::filesystem::absolute(std::filesystem::u8path(selected.empty() ? "." : selected))
            .lexically_normal();
    if (current.filename().empty() && current != current.root_path())
        current = current.parent_path();
    for (;;) {
        std::error_code error;
        if (std::filesystem::is_regular_file(current / "project.yaml", error))
            return current;
        if (!selected.empty() || current.parent_path() == current)
            return {};
        current = current.parent_path();
    }
}

// Derive recognition from the complete public help, not a reduced candidate inventory.
bool known_command(const std::vector<std::string>& command)
{
    const auto start = help.find("\nCommands:\n");
    const auto end = help.find("\nGlobal options:\n");
    std::istringstream lines(std::string(help.substr(start, end - start)));
    std::string line;
    while (std::getline(lines, line)) {
        if (line.size() < 3 || line.substr(0, 2) != "  " || line[2] < 'a' || line[2] > 'z')
            continue;
        std::istringstream words(line);
        std::string word;
        std::size_t index = 0;
        bool matches = true;
        while (words >> word) {
            if (word[0] < 'a' || word[0] > 'z')
                break;
            if (index >= command.size() || word != command[index])
                matches = false;
            ++index;
        }
        if (matches)
            return true;
    }
    return false;
}

Json project_diagnostics(const Json& response)
{
    auto diagnostics = response.value("cliDiagnostics", Json::array());
    for (auto& item : diagnostics)
        if (item.value("code", "") == "schema.const" && item.value("path", "") == "/schemaVersion")
            item["code"] = "WORKSPACE_VERSION_UNSUPPORTED";
    return diagnostics;
}

Json native_request(const Json& request)
{
    const auto serialized = request.dump();
    // No length probe or retry: an operation may have committed before its response is read.
    std::vector<std::uint8_t> buffer(16 * 1024 * 1024);
    const auto size = noveltea_tooling_native_project_commands_json(
        reinterpret_cast<const std::uint8_t*>(serialized.data()), serialized.size(), buffer.data(),
        buffer.size());
    if (size > buffer.size())
        throw std::runtime_error("Native Project response exceeds the CLI response limit.");
    return Json::parse(buffer.begin(), buffer.begin() + static_cast<std::ptrdiff_t>(size));
}

using NativeJsonOperation = std::uint64_t (*)(const std::uint8_t*, std::uint64_t, std::uint8_t*,
                                              std::uint64_t);

Json invoke_native_json(NativeJsonOperation operation, const Json& request)
{
    const auto serialized = request.dump();
    std::vector<std::uint8_t> buffer(16 * 1024 * 1024);
    const auto size = operation(reinterpret_cast<const std::uint8_t*>(serialized.data()),
                                serialized.size(), buffer.data(), buffer.size());
    if (size > buffer.size())
        throw std::runtime_error("Native runtime response exceeds CLI limit.");
    return Json::parse(buffer.begin(), buffer.begin() + static_cast<std::ptrdiff_t>(size));
}

Json native_font_coverage(const std::string& project_root, const Json& locales)
{
    const auto serialized = Json{{"projectRoot", project_root}, {"locales", locales}}.dump();
    std::vector<std::uint8_t> buffer(16 * 1024 * 1024);
    const auto size = noveltea_tooling_validate_font_coverage_json(
        reinterpret_cast<const std::uint8_t*>(serialized.data()), serialized.size(), buffer.data(),
        buffer.size());
    if (size > buffer.size())
        throw std::runtime_error("Native font coverage response exceeds the CLI response limit.");
    return Json::parse(buffer.begin(), buffer.begin() + static_cast<std::ptrdiff_t>(size));
}

std::string shader_program_id(const Json& program, const std::string& requested_id, bool custom)
{
    if (!custom)
        return requested_id;
    const auto serialized = program.dump();
    const auto hash =
        core::sha256_hex(std::as_bytes(std::span(serialized.data(), serialized.size())));
    return "program-" + hash.substr(0, 24);
}

Json native_material_compile(const std::string& root, const Json& programs,
                             const Json& variants = Json::array({"glsl-330", "essl-300", "metal"}),
                             bool force_rebuild = false,
                             const Json& source_overlays = Json::object(),
                             const Json& effective_materials = Json::object())
{
    // bgfx's embedded shaderc writes annotated failure excerpts to process
    // stdout. They are not JSON and must never corrupt the public CLI stream.
    // The standalone CLI invokes the compiler synchronously on one thread.
    struct StdoutSilencer {
        int saved = -1;
        StdoutSilencer()
        {
            std::fflush(stdout);
#if defined(_WIN32)
            saved = _dup(_fileno(stdout));
            const int sink = _open("NUL", _O_WRONLY);
            const int redirected = saved >= 0 && sink >= 0 ? _dup2(sink, _fileno(stdout)) : -1;
            if (sink >= 0)
                _close(sink);
#else
            saved = dup(fileno(stdout));
            const int sink = open("/dev/null", O_WRONLY);
            const int redirected = saved >= 0 && sink >= 0 ? dup2(sink, fileno(stdout)) : -1;
            if (sink >= 0)
                close(sink);
#endif
            if (redirected < 0) {
#if defined(_WIN32)
                if (saved >= 0)
                    _close(saved);
#else
                if (saved >= 0)
                    close(saved);
#endif
                throw std::runtime_error("Could not isolate native shader compiler output.");
            }
        }
        ~StdoutSilencer()
        {
            std::fflush(stdout);
#if defined(_WIN32)
            _dup2(saved, _fileno(stdout));
            _close(saved);
#else
            dup2(saved, fileno(stdout));
            close(saved);
#endif
        }
    };
    Json combined = Json::object();
    std::map<std::string, std::string> canonical_programs;
    std::map<std::string, std::string> material_program_aliases;
    for (const auto& [material_id, collection] : programs.items()) {
        for (const auto& [id, program] : collection.items()) {
            const auto identity = program.dump();
            const bool custom = effective_materials.contains(material_id) &&
                                effective_materials.at(material_id).value("custom", false);
            const auto program_id = shader_program_id(program, id, custom);
            const auto [found, unique] = canonical_programs.emplace(identity, program_id);
            if (unique)
                combined[program_id] = program;
            material_program_aliases[material_id] = found->second;
        }
    }
    const auto serialized = Json{
        {"shaderProject", {{"schema", "noveltea.shader-source-programs"}, {"programs", combined}}},
        {"options",
         {{"projectRoot", root},
          {"outputRoot", root + "/.noveltea/build"},
          {"cacheRoot", root + "/.noveltea/cache"},
          {"shaderVariants", variants},
          {"forceRebuild", force_rebuild},
          {"sourceOverlays",
           source_overlays}}}}.dump();
    std::vector<std::uint8_t> buffer(16 * 1024 * 1024);
    std::uint64_t size;
    {
        StdoutSilencer silence;
        size = noveltea_tooling_compile_shaders_json(
            reinterpret_cast<const std::uint8_t*>(serialized.data()), serialized.size(),
            buffer.data(), buffer.size());
    }
    if (size > buffer.size())
        throw std::runtime_error("Native shader compiler response exceeds CLI limit.");
    auto result = Json::parse(buffer.begin(), buffer.begin() + static_cast<std::ptrdiff_t>(size));
    if (result.contains("outputs") && result.at("outputs").is_array()) {
        Json aliases = Json::array();
        for (const auto& output : result.at("outputs")) {
            const auto program = output.value("program", std::string{});
            for (const auto& [material_id, representative] : material_program_aliases) {
                if (representative != program || material_id == representative)
                    continue;
                auto output_alias = output;
                output_alias["program"] = material_id;
                aliases.push_back(std::move(output_alias));
            }
        }
        for (auto& output_alias : aliases)
            result["outputs"].push_back(std::move(output_alias));
    }
    return result;
}

Json native_failure_diagnostics(const Json& response, std::string code, std::string path,
                                const std::string& message)
{
    Json errors = Json::array();
    for (const auto& item : response.value("diagnostics", Json::array())) {
        if (item.is_object() && item.value("severity", "") == "error" && item.contains("code") &&
            item.contains("path") && item.contains("message"))
            errors.push_back(diagnostic(item.at("code"), item.at("path"), item.at("message")));
    }
    if (errors.empty())
        errors.push_back(diagnostic(std::move(code), std::move(path), message));
    for (const auto& item : project_diagnostics(response))
        errors.push_back(item);
    return errors;
}

int native_failure(const Arguments& args, const Json& response, std::string code, std::string path,
                   int exit_code, const std::string& fallback, const std::string& root = {},
                   Json fields = Json::object())
{
    const auto message = response.value("error", fallback);
    auto diagnostics =
        native_failure_diagnostics(response, std::move(code), std::move(path), message);
    int status = response.value("exitCode", 0);
    if (status != 2 && status != 3 && status != 4 && status != 5 && status != 6 && status != 70 &&
        status != 130) {
        status = exit_code;
        for (const auto& item : diagnostics) {
            const auto category = item.at("code").get<std::string>();
            if (category == "WORKSPACE_BUSY" || category == "WORKSPACE_REVISION_CONFLICT" ||
                category == "WORKSPACE_TRANSACTION_RECOVERY_CONFLICT")
                status = 5;
            else if (category.starts_with("WORKSPACE_") && status != 5)
                status = 3;
        }
    }
    Json envelope{{"success", false}, {"exitCode", status}, {"diagnostics", diagnostics}};
    if (!root.empty())
        envelope["projectRoot"] = root;
    envelope.update(fields);
    return emit(std::move(envelope), args.json, message);
}

int native_success(const Arguments& args, Json fields, const std::string& human,
                   const std::string& root = {}, Json diagnostics = Json::array())
{
    Json envelope{{"success", true}, {"exitCode", 0}, {"diagnostics", std::move(diagnostics)}};
    if (!root.empty())
        envelope["projectRoot"] = root;
    envelope.update(fields);
    return emit(std::move(envelope), args.json, human);
}

int missing_project(const Arguments& args, bool formatter = false)
{
    const std::string message =
        formatter ? "No project.yaml found."
                  : "No NovelTea project.yaml was found from the current directory upward.";
    return failure(args.json, 3, formatter ? "WORKSPACE_UNAVAILABLE" : "WORKSPACE_NOT_FOUND",
                   "/project.yaml", message, message);
}

int tests_from_native_runtime(const Arguments& args)
{
    const auto operation = args.command.size() > 1 ? args.command[1] : std::string{};
    const bool authored = operation == "run";
    const bool stdin_spec = operation == "run-spec" || operation == "run-ui-spec";
    if ((!authored && !stdin_spec) || (authored && args.command.size() > 3) ||
        (stdin_spec && args.command.size() != 2) ||
        (authored && args.command.size() == 3 && args.command[2].starts_with("--")))
        return usage(args.json, authored ? "test run accepts at most one test ID."
                                         : "test " + operation + " does not accept arguments.");

    Json spec;
    if (stdin_spec) {
        std::string source;
        std::array<char, 4096> buffer{};
        while (std::cin) {
            std::cin.read(buffer.data(), buffer.size());
            const auto count = std::cin.gcount();
            if (count > 0)
                source.append(buffer.data(), static_cast<std::size_t>(count));
            if (source.size() > 8 * 1024 * 1024)
                return usage(args.json, "Test spec stdin exceeds the native input limit.");
        }
        if (source.find_first_not_of(" \r\n\t") == std::string::npos)
            return usage(args.json, "Command requires one UTF-8 JSON value on stdin.");
        spec = Json::parse(source, nullptr, false);
        if (spec.is_discarded())
            return usage(args.json, "Test spec stdin is not valid JSON.");
    }
    const auto root = project_root(args.project);
    if (root.empty())
        return missing_project(args);
    const auto root_text = path_text(root);
    const auto command_error = [&](int code, const std::string& diagnostic_code,
                                   const std::string& path, const std::string& message,
                                   const Json& fields = Json::object()) {
        Json envelope{{"success", false},
                      {"exitCode", code},
                      {"diagnostics", Json::array({diagnostic(diagnostic_code, path, message)})},
                      {"projectRoot", root_text}};
        envelope.update(fields);
        return emit(std::move(envelope), args.json, message);
    };
    if (compiler_identity.empty())
        return command_error(70, "CLI_NATIVE_RUNTIME_COMPILER_UNBOUND", "/tests",
                             "Native Test requires an exactly bound runtime compiler identity.");

    const auto probe = [&]() {
        return invoke_native_json(
            noveltea_tooling_probe_runtime_cache_json,
            {{"projectRoot", root_text}, {"compilerIdentity", compiler_identity}});
    };
    const auto cached = probe();
    const auto cache_observation = [&](const Json& value) {
        Json observation{{"status", value.value("status", "unusable")},
                         {"reason", value.value("reason", "native-probe-failed")}};
        for (const auto* key : {"testCatalogStatus", "testCatalogReason"})
            if (value.contains(key) && value.at(key).is_string())
                observation[key] = value.at(key);
        return Json{{"runtimeCache", std::move(observation)}};
    };
    auto fields = cache_observation(cached);
    if (!cached.value("ok", false) || cached.value("status", "") != "hit")
        return command_error(70, "CLI_NATIVE_RUNTIME_PREPARATION_REQUIRED", "/tests",
                             "No current compiled runtime artifact is available; native cold "
                             "runtime preparation is not yet implemented.",
                             fields);
    if (!cached.contains("artifact") || !cached.at("artifact").is_object() ||
        !cached.at("artifact").contains("compiledProject"))
        return command_error(70, "CLI_NATIVE_RUNTIME_CACHE_INVALID", "/tests",
                             "Verified runtime cache omitted compiled Project data.", fields);
    const bool needs_catalog = authored;
    const bool cached_catalog = needs_catalog && cached.value("testCatalogStatus", "") == "hit" &&
                                cached.contains("catalog") && cached.at("catalog").is_object() &&
                                cached.at("catalog").contains("entries") &&
                                cached.at("catalog").at("entries").is_array();
    Json catalog = cached_catalog ? cached.at("catalog") : Json::object();
    std::string catalog_source_generation;
    if (needs_catalog && !cached_catalog) {
        // Tests do not enter the compiled gameplay fingerprint. Rebuild their
        // authored playback catalog from the current native-admitted generation
        // without reusing a damaged or stale published Test catalog.
        const auto source =
            native_request({{"action", "shader-preparation"}, {"projectRoot", root_text}});
        if (!source.value("ok", false) || !source.contains("project") ||
            !source.at("project").is_object() || !source.contains("sourceGeneration") ||
            !source.at("sourceGeneration").is_string())
            return command_error(70, "CLI_NATIVE_TEST_CATALOG_PREPARATION_REQUIRED", "/tests",
                                 "Native Test catalog source admission failed.", fields);
        catalog_source_generation = source.at("sourceGeneration").get<std::string>();
        catalog = lower_test_catalog(source.at("project"), project_diagnostics(source));
    }
    const auto& artifact = cached.at("artifact");
    const auto& options = artifact.at("packageOptions");
    Json request{{"project", artifact.at("compiledProject")},
                 {"projectRoot", root_text},
                 {"shaderMaterialMetadata", artifact.value("shaderMaterialMetadata", Json())},
                 {"shaderVariants", options.value("shaderVariants", Json::array())}};
    for (const auto& item : options.value("textEntries", Json::array())) {
        if (item.value("packagePath", "") == "assets/.prepared-media/manifest.json") {
            request["preparedMediaManifest"] = item.at("text");
            break;
        }
    }
    NativeJsonOperation native_operation = noveltea_tooling_run_headless_test_json;
    std::string success_message;
    Json diagnostics = cached.value("diagnostics", Json::array());
    if (!diagnostics.is_array())
        return command_error(70, "CLI_NATIVE_RUNTIME_CACHE_INVALID", "/tests",
                             "Native runtime cache returned malformed diagnostics.", fields);
    if (stdin_spec) {
        request["spec"] = std::move(spec);
        if (operation == "run-ui-spec")
            native_operation = noveltea_tooling_run_ui_test_json;
        success_message = "NovelTea test " + operation + " succeeded.";
    } else if (args.command.size() == 3) {
        const auto& id = args.command[2];
        const auto& entries = catalog.at("entries");
        const auto found = std::find_if(entries.begin(), entries.end(), [&](const Json& item) {
            return item.value("id", "") == id;
        });
        if (found == entries.end())
            return command_error(6, "native.test.spec", "/tests/" + id,
                                 "Test record does not exist.", fields);
        if (found->value("status", "") == "blocked") {
            for (const auto& item : found->at("diagnostics")) {
                auto result = diagnostic("native.test.spec", item.value("path", "/tests/" + id),
                                         item.value("message", "Test is blocked."));
                result["severity"] = item.value("severity", "error");
                diagnostics.push_back(std::move(result));
            }
            Json response{{"success", false},
                          {"exitCode", 6},
                          {"diagnostics", diagnostics},
                          {"projectRoot", root_text}};
            response.update(fields);
            return emit(std::move(response), args.json);
        }
        if (found->value("status", "") != "runnable")
            return command_error(70, "CLI_NATIVE_TEST_CATALOG_INVALID", "/tests/" + id,
                                 "Native Test catalog entry is not runnable.", fields);
        request["spec"] = found->at("spec");
        if (found->value("runner", "") == "runtime-ui")
            native_operation = noveltea_tooling_run_ui_test_json;
        success_message = "NovelTea test run " + id + " succeeded.";
    } else {
        request["catalog"] = catalog;
        native_operation = noveltea_tooling_run_test_suite_json;
    }

    // Recheck the current artifact before and after using the same native
    // verifier. Never return a result against a replaced or stale generation.
    const auto current = [&]() {
        const auto verified = probe();
        if (!verified.value("ok", false) || verified.value("status", "") != "hit" ||
            verified.value("artifact", Json()) != cached.at("artifact"))
            return false;
        if (!needs_catalog)
            return true;
        if (cached_catalog)
            return verified.value("testCatalogStatus", "") == "hit" &&
                   verified.value("catalog", Json()) == catalog;
        const auto proof =
            native_request({{"action", "source-generation-proof"},
                            {"projectRoot", root_text},
                            {"expectedSourceGeneration", catalog_source_generation}});
        return proof.value("ok", false);
    };
    if (!current())
        return command_error(5, "WORKSPACE_REVISION_CONFLICT", "/tests",
                             "Native Test runtime cache changed before execution.", fields);
    const auto native = invoke_native_json(native_operation, request);
    if (!current())
        return command_error(5, "WORKSPACE_REVISION_CONFLICT", "/tests",
                             "Native Test runtime cache changed during execution.", fields);
    const bool has_report = native.contains("report") && native.at("report").is_object() &&
                            (native_operation == noveltea_tooling_run_test_suite_json
                                 ? (native.at("report").contains("entries") &&
                                    native.at("report").at("entries").is_array() &&
                                    native.at("report").contains("counts") &&
                                    native.at("report").at("counts").is_object())
                                 : (native.at("report").contains("passed") &&
                                    native.at("report").at("passed").is_boolean()));
    bool passed = native.value("ok", false) && native.value("success", true) && has_report;
    if (!native.value("ok", false)) {
        const auto prior_count = diagnostics.size();
        if (native.contains("diagnostics") && native.at("diagnostics").is_array()) {
            for (const auto& item : native.at("diagnostics")) {
                auto finding =
                    diagnostic("native." + item.value("code", std::string("test")),
                               item.value("path", std::string("/tests")),
                               item.value("message", native.value("error", "Test failed.")));
                finding["severity"] = item.value("severity", "error");
                diagnostics.push_back(std::move(finding));
            }
        }
        if (diagnostics.size() == prior_count)
            diagnostics.push_back(diagnostic("native.test", "/tests",
                                             native.value("error", "Test execution failed.")));
    } else if (has_report) {
        const auto& report = native.at("report");
        passed = passed && report.value("passed", true);
        if (authored && args.command.size() == 2 && report.contains("entries")) {
            const auto& counts = report.value("counts", Json::object());
            success_message = "Test suite: " + std::to_string(counts.value("passed", 0)) +
                              " passed, " + std::to_string(counts.value("failed", 0)) +
                              " failed, " + std::to_string(counts.value("blocked", 0)) +
                              " blocked, " + std::to_string(counts.value("error", 0)) + " errors.";
            for (const auto& item : report.at("entries")) {
                const auto id = item.value("id", "");
                const auto status = item.value("status", "");
                if (status == "passed")
                    continue;
                if (status == "failed") {
                    diagnostics.push_back(diagnostic("native.test.failed", "/tests/" + id,
                                                     "Test '" + id + "' failed."));
                    passed = false;
                } else if (status == "error") {
                    const auto before = diagnostics.size();
                    for (const auto& finding : item.value("diagnostics", Json::array()))
                        diagnostics.push_back(
                            diagnostic("native.test.error", finding.value("path", "/tests/" + id),
                                       finding.value("message", "Native Test execution failed.")));
                    if (diagnostics.size() == before)
                        diagnostics.push_back(diagnostic("native.test.error", "/tests/" + id,
                                                         "Test '" + id + "' could not execute."));
                    passed = false;
                } else if (status == "blocked") {
                    const auto before = diagnostics.size();
                    for (const auto& item_diagnostic : item.value("diagnostics", Json::array())) {
                        Json warning = diagnostic(
                            "native.test.blocked", item_diagnostic.value("path", "/tests/" + id),
                            item_diagnostic.value("message", "Test is blocked."));
                        warning["severity"] = "warning";
                        diagnostics.push_back(std::move(warning));
                    }
                    if (diagnostics.size() == before) {
                        auto warning =
                            diagnostic("native.test.blocked", "/tests/" + id,
                                       "Test '" + id + "' is blocked and was not executed.");
                        warning["severity"] = "warning";
                        diagnostics.push_back(std::move(warning));
                    }
                }
            }
            if (!passed)
                diagnostics.push_back(
                    diagnostic("native.test.suite.summary", "/tests", success_message));
        } else if (!passed) {
            const auto before = diagnostics.size();
            for (const auto& finding : report.value("diagnostics", Json::array())) {
                if (!finding.is_object() || !finding.contains("message") ||
                    !finding.at("message").is_string())
                    continue;
                auto item = diagnostic("native.test.failed", finding.value("path", "/tests"),
                                       finding.at("message"));
                item["severity"] = finding.value("severity", "error");
                diagnostics.push_back(std::move(item));
            }
            if (diagnostics.size() == before)
                diagnostics.push_back(
                    diagnostic("native.test.failed", "/tests", "Authored Test failed."));
        }
    } else {
        diagnostics.push_back(diagnostic("native.test.invalid_report", "/tests",
                                         "Native Test runner returned no valid execution report."));
    }
    if (needs_catalog && !cached_catalog) {
        // A stale Test catalog does not invalidate compiled gameplay. After
        // native execution and the final source proof, publish a fresh
        // generation through the native cache writer. This is best-effort
        // maintenance: a failed cache write must not falsify the Test verdict.
        const auto published = invoke_native_json(
            noveltea_tooling_publish_runtime_cache_json,
            {{"projectRoot", root_text},
             {"compilerIdentity", compiler_identity},
             {"artifact", artifact},
             {"catalog", catalog},
             {"runtimeInputPaths", cached.value("runtimeInputPaths", Json::array())},
             {"testInputPaths", cached.value("testInputPaths", Json::array())},
             {"authoringDiagnostics", cached.value("diagnostics", Json::array())}});
        fields["runtimeCache"]["published"] = published.value("published", false);
        if (!published.value("published", false))
            fields["runtimeCache"]["publicationReason"] =
                published.value("reason", "native-publication-failed");
    }
    Json response{{"success", passed},
                  {"exitCode", passed ? 0 : 6},
                  {"diagnostics", diagnostics},
                  {"projectRoot", root_text},
                  {"native", native}};
    response.update(fields);
    return emit(std::move(response), args.json,
                passed ? success_message : "Native Test execution failed.");
}

int package_from_native_runtime(const Arguments& args)
{
    const auto& command = args.command;
    std::string output, requested_profile;
    bool unused_assets = false, shader_sources = false, allow_localization_warnings = false;
    if (command.size() < 2 || command[1] != "export")
        return usage(args.json, "Unknown package command.");
    for (std::size_t i = 2; i < command.size(); ++i) {
        const auto& option = command[i];
        if (option == "--output" || option == "--profile") {
            if (++i == command.size() || command[i].starts_with("--"))
                return usage(args.json, option + " requires a value.");
            auto& destination = option == "--output" ? output : requested_profile;
            if (destination.empty())
                destination = command[i];
        } else if (option == "--include-unused-assets") {
            unused_assets = true;
        } else if (option == "--include-shader-sources") {
            shader_sources = true;
        } else if (option == "--allow-localization-warnings") {
            allow_localization_warnings = true;
        } else {
            return usage(args.json, "Unknown command option '" + option + "'.");
        }
    }
    if (output.empty())
        return usage(args.json, "package export requires '--output <path>'.");
    const auto root = project_root(args.project);
    if (root.empty())
        return missing_project(args);
    const auto root_text = path_text(root);
    const auto fail = [&](int code, const std::string& category, const std::string& message,
                          Json fields = Json::object()) {
        const auto path = category == "export.output_invalid" ||
                                  category == "export.publish_failed" ||
                                  category == "WORKSPACE_REVISION_CONFLICT"
                              ? "/output"
                              : "/export/runtime";
        Json response{{"success", false},
                      {"exitCode", code},
                      {"diagnostics", Json::array({diagnostic(category, path, message)})},
                      {"projectRoot", root_text}};
        response.update(fields);
        return emit(std::move(response), args.json, message);
    };
    if (compiler_identity.empty())
        return fail(70, "CLI_NATIVE_RUNTIME_COMPILER_UNBOUND",
                    "Runtime Package export requires an exactly bound compiler identity.");
    const auto probe = [&]() {
        return invoke_native_json(
            noveltea_tooling_probe_runtime_cache_json,
            {{"projectRoot", root_text}, {"compilerIdentity", compiler_identity}});
    };
    const auto cached = probe();
    const Json cache_fields{{"runtimeCache",
                             {{"status", cached.value("status", "unusable")},
                              {"reason", cached.value("reason", "native-probe-failed")}}}};
    if (!cached.value("ok", false) || cached.value("status", "") != "hit")
        return fail(70, "CLI_NATIVE_RUNTIME_PREPARATION_REQUIRED",
                    "No verified current runtime artifact is available for native Runtime "
                    "Package export. Cold preparation is not yet implemented.",
                    cache_fields);
    const auto& artifact = cached.at("artifact");
    if (!artifact.is_object() || !artifact.contains("profile") ||
        !artifact.at("profile").is_object() || !artifact.contains("packageOptions") ||
        !artifact.at("packageOptions").is_object() || !artifact.contains("compiledProject"))
        return fail(70, "CLI_NATIVE_RUNTIME_CACHE_INVALID",
                    "Verified runtime cache omitted export authority.", cache_fields);
    const auto& profile = artifact.at("profile");
    if (!requested_profile.empty() && requested_profile != profile.value("id", ""))
        return fail(4, "export.profile_missing",
                    "Export profile '" + requested_profile + "' does not exist.", cache_fields);
    if ((unused_assets && profile.value("excludeUnusedAssets", true)) ||
        (shader_sources && !profile.value("includeShaderSources", false)))
        return fail(70, "CLI_NATIVE_RUNTIME_PREPARATION_REQUIRED",
                    "Requested export overrides require a new native runtime build; "
                    "the cached artifact cannot be repurposed.",
                    cache_fields);

    Json localization_warnings = Json::array();
    for (const auto& item : artifact.value("diagnostics", Json::array())) {
        if (item.value("severity", "") == "warning" &&
            item.value("code", std::string{}).starts_with("localization.export.")) {
            Json warning = diagnostic(item.value("code", "localization.export.warning"),
                                      item.value("path", "/export/runtime/localization"),
                                      item.value("message", ""));
            warning["severity"] = "warning";
            localization_warnings.push_back(std::move(warning));
        }
    }
    if (!localization_warnings.empty() && !allow_localization_warnings) {
        localization_warnings.push_back(diagnostic(
            "localization.export.warning_override_required", "/export/runtime/localization",
            "Localization quality warnings require explicit acknowledgement; pass "
            "--allow-localization-warnings to continue."));
        Json response{{"success", false},
                      {"exitCode", 4},
                      {"diagnostics", std::move(localization_warnings)},
                      {"projectRoot", root_text}};
        response.update(cache_fields);
        return emit(std::move(response), args.json, "Runtime Package export was blocked.");
    }

    // Canonical runtime caches are machine-local, not portable artifacts.
    // File entries in the prepared package must still belong to THIS Project,
    // not an old checkout copied together with an otherwise valid cache.
    const auto& options = artifact.at("packageOptions");
    if (options.value("kind", "") != "runtime" || !options.contains("fileEntries") ||
        !options.at("fileEntries").is_array())
        return fail(70, "CLI_NATIVE_RUNTIME_CACHE_INVALID",
                    "Runtime Package options omitted physical source entries.", cache_fields);
    const auto canonical_root = std::filesystem::canonical(root);
    const auto confined = [&](const std::string& path) {
        const auto selected = std::filesystem::u8path(path);
        if (!selected.is_absolute())
            return false;
        std::error_code error;
        if (std::filesystem::is_symlink(std::filesystem::symlink_status(selected, error)) ||
            error || !std::filesystem::is_regular_file(selected, error) || error)
            return false;
        const auto relative = std::filesystem::relative(std::filesystem::canonical(selected, error),
                                                        canonical_root, error);
        if (error || relative.empty() || relative.is_absolute())
            return false;
        for (const auto& component : relative)
            if (component == "..")
                return false;
        return true;
    };
    for (const auto& entry : options.at("fileEntries")) {
        if (!entry.is_object() || !entry.contains("source") || !entry.at("source").is_string() ||
            !confined(entry.at("source").get<std::string>()))
            return fail(70, "CLI_NATIVE_RUNTIME_CACHE_INVALID",
                        "Runtime Package contains a missing, external, or unsafe source path.",
                        cache_fields);
    }
    // All paths consumed by the native writer must remain under the current
    // Project root. A cached package copied between checkouts is not portable.
    const auto confined_root = [&](const std::string& path) {
        const auto selected = std::filesystem::u8path(path);
        if (!selected.is_absolute())
            return false;
        std::error_code error;
        const auto relative = std::filesystem::relative(
            std::filesystem::weakly_canonical(selected, error), canonical_root, error);
        if (error || relative.empty() || relative.is_absolute())
            return false;
        for (const auto& component : relative)
            if (component == "..")
                return false;
        return true;
    };
    if (options.contains("shaderAssetRoot") &&
        (!options.at("shaderAssetRoot").is_string() ||
         !confined_root(options.at("shaderAssetRoot").get<std::string>())))
        return fail(70, "CLI_NATIVE_RUNTIME_CACHE_INVALID",
                    "Runtime Package shader sources are outside the current Project.",
                    cache_fields);
    for (const auto& asset_root : options.value("assetRoots", Json::array())) {
        if (!asset_root.is_object() || !asset_root.contains("root") ||
            !asset_root.at("root").is_string() ||
            !confined_root(asset_root.at("root").get<std::string>()))
            return fail(70, "CLI_NATIVE_RUNTIME_CACHE_INVALID",
                        "Runtime Package asset roots are outside the current Project.",
                        cache_fields);
    }

    const auto target =
        std::filesystem::absolute(std::filesystem::u8path(output)).lexically_normal();
    if (target.filename().empty())
        return fail(4, "export.output_invalid", "Runtime Package output path is invalid.",
                    cache_fields);
    const auto target_status = std::filesystem::symlink_status(target);
    if (std::filesystem::exists(target_status) &&
        (!std::filesystem::is_regular_file(target_status) ||
         std::filesystem::is_symlink(target_status)))
        return fail(4, "export.output_invalid",
                    "Runtime Package output is not a replaceable regular file.", cache_fields);

    // Fail cheap path checks before native Project admission. Publication
    // still requires physical source authority from the current owner.
    const auto owner =
        native_request({{"action", "runtime-package-preparation"}, {"projectRoot", root_text}});
    if (!owner.value("ok", false))
        return native_failure(args, owner, "WORKSPACE_SOURCE_READ", "/export/runtime", 3,
                              "Native Runtime Package Project admission failed.", root_text);
    const auto generation = owner.value("sourceGeneration", std::string{});
    if (generation.empty())
        return fail(70, "CLI_NATIVE_RUNTIME_CACHE_INVALID",
                    "Native package admission omitted its physical source generation.",
                    cache_fields);

    struct StagedOutput {
        std::filesystem::path path;
        ~StagedOutput()
        {
            if (!path.empty()) {
                std::error_code ignored;
                std::filesystem::remove(path, ignored);
            }
        }
    } staged;
    std::random_device random;
    for (int retry = 0; retry < 8; ++retry) {
        const auto candidate = std::filesystem::u8path(
            path_text(target) + ".tmp-" + std::to_string(random()) + "-" +
            std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
#if defined(_WIN32)
        HANDLE handle = CreateFileW(candidate.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW,
                                    FILE_ATTRIBUTE_NORMAL, nullptr);
        if (handle != INVALID_HANDLE_VALUE) {
            CloseHandle(handle);
            staged.path = candidate;
            break;
        }
#else
        const auto handle = open(candidate.c_str(), O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW, 0600);
        if (handle >= 0) {
            close(handle);
            staged.path = candidate;
            break;
        }
#endif
    }
    if (staged.path.empty())
        return fail(4, "export.output_invalid", "Could not reserve a safe staged output.",
                    cache_fields);

    const auto unchanged = [&]() {
        const auto proof = native_request({{"action", "source-generation-proof"},
                                           {"projectRoot", root_text},
                                           {"expectedSourceGeneration", generation}});
        if (!proof.value("ok", false))
            return false;
        const auto verified = probe();
        return verified.value("ok", false) && verified.value("status", "") == "hit" &&
               verified.value("artifact", Json()) == artifact;
    };
    if (!unchanged())
        return fail(5, "WORKSPACE_REVISION_CONFLICT",
                    "Runtime inputs changed before package export.", cache_fields);
    const auto written = invoke_native_json(noveltea_tooling_export_package_json,
                                            {{"project", artifact.at("compiledProject")},
                                             {"outputPath", path_text(staged.path)},
                                             {"options", options}});
    if (!written.value("ok", false) || !written.value("success", false)) {
        Json errors = Json::array();
        for (const auto& item : written.value("diagnostics", Json::array()))
            errors.push_back(diagnostic(
                "native." + item.value("code", std::string("operation")),
                item.value("path", std::string("/export/runtime")),
                item.value("message", std::string("Native Runtime Package writer failed."))));
        if (errors.empty())
            errors.push_back(diagnostic(
                "native.operation", "/",
                written.value("error", std::string("Native Runtime Package writer failed."))));
        Json response{{"success", false},
                      {"exitCode", 6},
                      {"diagnostics", std::move(errors)},
                      {"projectRoot", root_text}};
        response.update(cache_fields);
        return emit(std::move(response), args.json, "Runtime Package export failed.");
    }
    if (!unchanged())
        return fail(5, "WORKSPACE_REVISION_CONFLICT",
                    "Runtime inputs changed before package publication.", cache_fields);
    const auto latest_status = std::filesystem::symlink_status(target);
    if (std::filesystem::exists(latest_status) &&
        (!std::filesystem::is_regular_file(latest_status) ||
         std::filesystem::is_symlink(latest_status)))
        return fail(4, "export.output_invalid",
                    "Runtime Package output changed to an unsafe target.", cache_fields);
    std::error_code error;
#if defined(_WIN32)
    const bool published = MoveFileExW(staged.path.c_str(), target.c_str(),
                                       MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) != 0;
    if (!published)
        error = std::error_code(static_cast<int>(GetLastError()), std::system_category());
#else
    std::filesystem::rename(staged.path, target, error);
    const bool published = !error;
#endif
    if (!published)
        return fail(4, "export.publish_failed",
                    "Runtime Package publication failed: " + error.message(), cache_fields);
    staged.path.clear();
    Json result_diagnostics = project_diagnostics(owner);
    for (const auto& item : written.value("diagnostics", Json::array())) {
        auto finding = diagnostic("native." + item.value("code", std::string("operation")),
                                  item.value("path", std::string("/export/runtime")),
                                  item.value("message", std::string{}));
        finding["severity"] = item.value("severity", std::string("warning"));
        result_diagnostics.push_back(std::move(finding));
    }
    Json response{{"success", true},
                  {"exitCode", 0},
                  {"diagnostics", std::move(result_diagnostics)},
                  {"projectRoot", root_text},
                  {"native", written}};
    return emit(std::move(response), args.json, "NovelTea package export succeeded.");
}

// The public validator and standalone shader command must attribute the same
// native reflected-interface findings to their authored Material records.
void append_material_reflection_diagnostics(Json& diagnostics, const Json& compiled,
                                            const Json& materials)
{
    for (const auto& [material_id, effective] : materials.items()) {
        if (!effective.value("custom", false))
            continue;
        Json outputs = Json::array();
        for (const auto& output : compiled.value("outputs", Json::array()))
            if (output.value("program", std::string{}) == material_id)
                outputs.push_back(output);
        const auto reflected = noveltea::authoring::validate_material_shader_compiler_result(
            Json{{"ok", true},
                 {"success", true},
                 {"diagnostics", Json::array()},
                 {"outputs", std::move(outputs)}}
                .dump(),
            material_id, effective.dump());
        for (const auto& finding : reflected.diagnostics) {
            auto message = finding.message;
            if (finding.code == "material.shader.orphan") {
                const auto name = finding.path.substr(finding.path.find_last_of('/') + 1);
                std::string unescaped;
                for (std::size_t i = 0; i < name.size(); ++i) {
                    if (name[i] == '~' && i + 1 < name.size() &&
                        (name[i + 1] == '0' || name[i + 1] == '1'))
                        unescaped += name[++i] == '0' ? '~' : '/';
                    else
                        unescaped += name[i];
                }
                const bool texture = finding.path.find("/textures/") != std::string::npos;
                message = "Material " + std::string(texture ? "texture" : "parameter") + " '" +
                          unescaped +
                          "' is not present in the reflected shader interface and remains "
                          "orphaned.";
            }
            Json mapped = diagnostic("shader.material_project", finding.path, message);
            mapped["severity"] = finding.severity;
            diagnostics.push_back(std::move(mapped));
        }
    }
}

int shaders_compile(const Arguments& args)
{
    Json variants = Json::array();
    bool force_rebuild = false;
    for (std::size_t i = 2; i < args.command.size(); ++i) {
        const auto& option = args.command[i];
        if (option == "--force-rebuild") {
            if (force_rebuild)
                throw std::invalid_argument("Option '--force-rebuild' may be supplied only once.");
            force_rebuild = true;
        } else if (option == "--variant") {
            if (++i == args.command.size() || args.command[i].starts_with("--"))
                throw std::invalid_argument("--variant requires a value.");
            const auto& variant = args.command[i];
            if (variant != "glsl-330" && variant != "essl-300" && variant != "metal")
                throw std::invalid_argument("Unknown shader variant '" + variant + "'.");
            if (std::find(variants.begin(), variants.end(), variant) == variants.end())
                variants.push_back(variant);
        } else {
            throw std::invalid_argument("Unknown command option '" + option + "'.");
        }
    }
    if (variants.empty())
        variants = Json::array({"glsl-330", "essl-300", "metal"});
    const auto root = project_root(args.project);
    if (root.empty())
        return missing_project(args);
    const auto root_text = path_text(root);
    const auto fail = [&](const std::string& code, const std::string& message, int exit_code) {
        return emit({{"success", false},
                     {"exitCode", exit_code},
                     {"diagnostics", Json::array({diagnostic(code, "/", message)})},
                     {"projectRoot", root_text}},
                    args.json, message);
    };
    const auto admitted = native_request({{"action", "project-validate"},
                                          {"projectRoot", root_text},
                                          {"includeFontCoverageInputs", true}});
    if (!admitted.value("ok", false))
        return native_failure(args, admitted, "WORKSPACE_SOURCE_READ", "/", 3,
                              "Native shader Project admission failed.", root_text);
    if (!admitted.value("valid", false))
        return emit({{"success", false},
                     {"exitCode", 4},
                     {"diagnostics", project_diagnostics(admitted)},
                     {"projectRoot", root_text}},
                    args.json, "Native shader Project admission failed.");
    if (!admitted.contains("materialCompilerPrograms") ||
        !admitted.at("materialCompilerPrograms").is_object() ||
        !admitted.contains("materialEffectiveInputs") ||
        !admitted.at("materialEffectiveInputs").is_object() ||
        !admitted.contains("sourceGeneration") || !admitted.at("sourceGeneration").is_string())
        return fail("CLI_INTERNAL", "Native shader preparation omitted Material authority.", 70);
    const auto generation = admitted.at("sourceGeneration");
    const auto prepared =
        native_request({{"action", "shader-preparation"}, {"projectRoot", root_text}});
    if (!prepared.value("ok", false))
        return native_failure(args, prepared, "WORKSPACE_SOURCE_READ", "/", 3,
                              "Native shader source preparation failed.", root_text);
    if (prepared.value("sourceGeneration", std::string{}) != generation.get<std::string>() ||
        !prepared.contains("sourceOverlays") || !prepared.at("sourceOverlays").is_object())
        return fail("WORKSPACE_REVISION_CONFLICT",
                    "Project sources changed during shader admission.", 3);
    const auto prove = [&]() {
        return native_request({{"action", "source-generation-proof"},
                               {"projectRoot", root_text},
                               {"expectedSourceGeneration", generation}})
            .value("ok", false);
    };
    if (!prove())
        return fail("WORKSPACE_REVISION_CONFLICT", "Project sources changed before compilation.",
                    3);

    const auto& programs = admitted.at("materialCompilerPrograms");
    Json compiled = Json{{"ok", true},
                         {"success", true},
                         {"diagnostics", Json::array()},
                         {"outputs", Json::array()}};
    if (!programs.empty())
        compiled = native_material_compile(root_text, programs, variants, force_rebuild,
                                           prepared.at("sourceOverlays"),
                                           admitted.at("materialEffectiveInputs"));
    Json diagnostics = project_diagnostics(admitted);
    for (const auto& item : compiled.value("diagnostics", Json::array())) {
        auto finding = diagnostic("native." + item.value("code", std::string("operation")),
                                  item.value("path", item.value("sourcePath", std::string("/"))),
                                  item.value("message", std::string{}));
        finding["severity"] = item.value("severity", std::string("error"));
        diagnostics.push_back(std::move(finding));
    }
    if (!compiled.value("ok", false) || !compiled.value("success", false)) {
        if (compiled.value("diagnostics", Json::array()).empty())
            diagnostics.push_back(diagnostic(
                "native.operation", "/",
                compiled.value("error", std::string("Native shader compilation failed."))));
    } else
        append_material_reflection_diagnostics(diagnostics, compiled,
                                               admitted.at("materialEffectiveInputs"));
    if (!prove())
        return fail("WORKSPACE_REVISION_CONFLICT", "Project sources changed during compilation.",
                    3);
    const bool failed = std::any_of(diagnostics.begin(), diagnostics.end(), [](const Json& item) {
        return item.value("severity", "error") == "error";
    });
    const bool native_error =
        std::any_of(diagnostics.begin(), diagnostics.end(), [](const Json& item) {
            return item.value("severity", "error") == "error" &&
                   item.value("code", std::string{}).starts_with("native.");
        });
    Json response{{"success", !failed},
                  {"exitCode", failed ? (native_error ? 6 : 4) : 0},
                  {"diagnostics", diagnostics},
                  {"projectRoot", root_text}};
    if (!failed) {
        // Aliases are needed for per-Material reflection, but are not
        // independent shader programs in the public compiler response.
        std::set<std::string> requested_programs;
        for (const auto& [material_id, collection] : programs.items())
            for (const auto& [program_id, program] : collection.items())
                requested_programs.insert(shader_program_id(
                    program, program_id,
                    admitted.at("materialEffectiveInputs").at(material_id).value("custom", false)));
        Json unique_outputs = Json::array();
        for (const auto& output : compiled.at("outputs"))
            if (requested_programs.contains(output.value("program", std::string{})))
                unique_outputs.push_back(output);
        compiled["outputs"] = std::move(unique_outputs);
        response["native"] = std::move(compiled);
    }
    return emit(std::move(response), args.json,
                failed ? "Shader compilation failed." : "NovelTea shaders compile succeeded.");
}

int validation_source_failure(const Arguments& args, const std::string& root,
                              const std::string& message)
{
    return emit({{"success", false},
                 {"exitCode", 4},
                 {"diagnostics", Json::array({diagnostic("WORKSPACE_SOURCE_READ", "/", message)})},
                 {"projectRoot", root}},
                args.json, message);
}

struct CommandFlags {
    std::vector<std::string> positionals;
    std::set<std::string> flags;
};

CommandFlags parse_flags(const std::vector<std::string>& args, std::size_t start,
                         std::initializer_list<std::string_view> allowed)
{
    CommandFlags parsed;
    for (std::size_t i = start; i < args.size(); ++i) {
        const auto& value = args[i];
        if (!value.starts_with("--")) {
            parsed.positionals.push_back(value);
        } else if (std::find(allowed.begin(), allowed.end(), value) == allowed.end()) {
            throw std::invalid_argument("Unknown command option '" + value + "'.");
        } else if (!parsed.flags.insert(value).second) {
            throw std::invalid_argument("Option '" + value + "' may be supplied only once.");
        }
    }
    return parsed;
}

bool valid_collection(const std::string& collection)
{
    return std::find(std::begin(collections), std::end(collections), collection) !=
           std::end(collections);
}

void require_collection(const std::string& collection)
{
    if (!valid_collection(collection))
        throw std::invalid_argument("Unknown collection '" + collection + "'.");
}

std::string absolute_path(const std::string& value)
{
    return path_text(std::filesystem::absolute(std::filesystem::u8path(value)).lexically_normal());
}

int inspect(const Arguments& args)
{
    bool provenance = false;
    std::vector<std::string> values;
    for (std::size_t i = 2; i < args.command.size(); ++i) {
        if (args.command[i] == "--provenance" && !provenance)
            provenance = true;
        else
            values.push_back(args.command[i]);
    }
    if (values.size() != 2 || values[0].starts_with("--") || values[1].starts_with("--"))
        return usage(args.json, "Usage: noveltea entity inspect <collection> <id> [--provenance]");
    const auto& collection = values[0];
    const auto& id = values[1];
    if (std::find(std::begin(collections), std::end(collections), collection) ==
        std::end(collections))
        return usage(args.json, "Unknown collection '" + collection + "'.");
    if (!std::regex_match(id, std::regex("[a-z][a-z0-9]*(-[a-z0-9]+)*")))
        return usage(args.json, "Invalid record ID '" + id + "'.");
    const auto root = project_root(args.project);
    if (root.empty()) {
        const std::string message =
            "No NovelTea project.yaml was found from the current directory upward.";
        return failure(args.json, 3, "WORKSPACE_NOT_FOUND", "/project.yaml", message, message);
    }
    const auto root_text = path_text(root);
    const auto request = Json{
        {"action", "entity-inspect"},
        {"projectRoot", root_text},
        {"collection", collection},
        {"id", id},
        {"provenance",
         provenance}}.dump();
    // Execute once: response-size retries must not observe a different source generation.
    std::vector<std::uint8_t> buffer(16 * 1024 * 1024);
    const auto size = noveltea_tooling_native_project_commands_json(
        reinterpret_cast<const std::uint8_t*>(request.data()), request.size(), buffer.data(),
        buffer.size());
    if (size > buffer.size())
        throw std::runtime_error("Native Project response exceeds the CLI response limit.");
    const auto response =
        Json::parse(buffer.begin(), buffer.begin() + static_cast<std::ptrdiff_t>(size));
    auto diagnostics = project_diagnostics(response);
    if (!response.value("ok", false)) {
        Json errors = Json::array();
        for (const auto& item : response.value("diagnostics", Json::array()))
            if (item.value("severity", "") == "error")
                errors.push_back(diagnostic(item.at("code"), item.at("path"), item.at("message")));
        const auto message =
            response.value("error", errors.empty() ? std::string("Native Project read failed.")
                                                   : errors[0].at("message").get<std::string>());
        const bool missing = std::regex_search(
            message,
            std::regex("does not exist|cannot read .* source|unknown record", std::regex::icase));
        const bool malformed =
            std::regex_search(message, std::regex("^Invalid (Room|Map|record) YAML:"));
        const auto diagnostic_path = malformed
                                         ? "/records/" + collection + "/" + id +
                                               (collection == "layouts" ? "/layout.yaml" : ".yaml")
                                         : "/" + collection + "/" + id;
        if (errors.empty())
            errors.push_back(
                diagnostic(missing ? "authoring.entity.not_found" : "WORKSPACE_SOURCE_READ",
                           diagnostic_path, malformed ? "Record is malformed." : message));
        for (const auto& item : diagnostics)
            errors.push_back(item);
        int code = response.value("exitCode", 0);
        if (code < 3 || code > 6) {
            code = 4;
            for (const auto& item : errors)
                if (item.at("code").get<std::string>().starts_with("WORKSPACE_"))
                    code = 3;
            for (const auto& item : errors)
                if (item.at("code") == "WORKSPACE_TRANSACTION_RECOVERY_CONFLICT")
                    code = 5;
        }
        return emit({{"success", false},
                     {"exitCode", code},
                     {"diagnostics", errors},
                     {"projectRoot", root_text}},
                    args.json, message);
    }
    const auto& fields = response.at("fields");
    Json result{{"success", true},
                {"exitCode", 0},
                {"diagnostics", diagnostics},
                {"projectRoot", root_text}};
    result.update(fields);
    const auto human =
        provenance ? Json{{"record", fields.at("record")}, {"provenance", fields.at("provenance")}}
                   : fields.at("record");
    return emit(std::move(result), args.json, human.dump(2));
}

int project_read(const Arguments& args, std::string action)
{
    Json request{{"action", action}};
    if (action == "project-validate")
        request["includeFontCoverageInputs"] = true;
    std::string missing_path = "/";
    std::string human;
    if (action == "entity-usages") {
        if (args.command.size() != 3 || args.command[1].starts_with("--") ||
            args.command[2].starts_with("--"))
            return usage(args.json, "Usage: noveltea usages <collection> <id>");
        require_collection(args.command[1]);
        request["collection"] = args.command[1];
        request["id"] = args.command[2];
        missing_path = "/" + args.command[1] + "/" + args.command[2];
        human = "Found usages for " + args.command[1] + "/" + args.command[2] + ".";
    } else if (action == "localization-view") {
        const auto& command = args.command;
        std::vector<std::string> locales, statuses;
        for (std::size_t i = 2; i < command.size(); ++i) {
            if (command[i] == "--status" && i + 1 < command.size())
                statuses.push_back(command[++i]);
            else
                locales.push_back(command[i]);
        }
        const std::set<std::string> allowed = {"missing",  "current",  "outdated", "needs-review",
                                               "reviewed", "human",    "ai",       "imported",
                                               "unknown",  "attention"};
        if (locales.size() != 1 || locales[0].starts_with("--") || statuses.size() > 1 ||
            (statuses.size() == 1 && !allowed.contains(statuses[0])) ||
            command.size() != 3 + statuses.size() * 2)
            return usage(args.json,
                         "Usage: noveltea localization view <locale> [--status <status>]");
        request["locale"] = locales[0];
        if (!statuses.empty())
            request["status"] = statuses[0];
    } else if (action == "asset-audit") {
        if (args.command.size() != 2)
            return usage(args.json, "Usage: noveltea asset audit");
    } else if (action == "project-validate" && args.command.size() != 1) {
        return usage(args.json, "validate does not accept arguments.");
    }
    const auto root = project_root(args.project);
    if (root.empty())
        return missing_project(args);
    const auto root_text = path_text(root);
    request["projectRoot"] = root_text;
    const auto response = native_request(request);
    if (action == "project-validate") {
        if (!response.value("ok", false) &&
            response.value("error", std::string{})
                .starts_with("Portable Project source is missing:")) {
            const auto message = response.at("error").get<std::string>();
            return validation_source_failure(args, root_text, message);
        }
        if (response.contains("portableFailure") && response.at("portableFailure").is_string()) {
            const auto message = response.at("portableFailure").get<std::string>();
            return validation_source_failure(args, root_text, message);
        }
        if (!response.value("ok", false) || !response.contains("valid") ||
            !response.at("valid").is_boolean() || !response.contains("cliDiagnostics") ||
            !response.at("cliDiagnostics").is_array()) {
            const auto message = response.value(
                "error", std::string("Native Project validation returned an invalid response."));
            return failure(args.json, 70, "NATIVE_PROJECT_VALIDATION_UNAVAILABLE", "/", message,
                           message);
        }
        auto diagnostics = project_diagnostics(response);
        bool valid = response.at("valid").get<bool>();
        bool workspace = false;
        for (const auto& item : diagnostics) {
            if (item.at("severity") == "error")
                valid = false;
            if (item.at("code").get<std::string>().starts_with("WORKSPACE_"))
                workspace = true;
        }
        if (valid) {
            // Static Project admission alone is not public validate: the compiler
            // also requires an entrypoint from the same validated native generation.
            if (!response.contains("entrypointConfigured") ||
                !response.at("entrypointConfigured").is_boolean() ||
                !response.contains("sourceGeneration") ||
                !response.at("sourceGeneration").is_string())
                return failure(args.json, 70, "NATIVE_PROJECT_VALIDATION_UNAVAILABLE", "/",
                               "Native validation omitted entrypoint or generation authority.",
                               "Native validation omitted entrypoint or generation authority.");
            if (!response.at("entrypointConfigured").get<bool>()) {
                Json entrypoint = diagnostic(
                    "COMPILER_ENTRYPOINT_REQUIRED", "/entrypoint",
                    "A Room, Scene, or Dialogue entrypoint is required for compiled gameplay.");
                const auto locations =
                    native_request({{"action", "project-diagnostic-locations"},
                                    {"projectRoot", root_text},
                                    {"expectedSourceGeneration", response.at("sourceGeneration")},
                                    {"paths", Json::array({"/entrypoint"})}});
                if (!locations.value("ok", false) || !locations.contains("locations") ||
                    locations.at("locations").size() != 1)
                    return failure(args.json, 5, "WORKSPACE_REVISION_CONFLICT", "/",
                                   "Project sources changed during diagnostic source lookup.",
                                   "Project sources changed during diagnostic source lookup.");
                for (const auto* field : {"sourceUrl", "line", "column"})
                    if (locations.at("locations")[0].contains(field))
                        entrypoint[field] = locations.at("locations")[0].at(field);
                diagnostics.push_back(entrypoint);
                valid = false;
            }
        }
        if (response.at("valid").get<bool>()) {
            if (response.contains("noticeValidationFailure") &&
                response.at("noticeValidationFailure").is_string()) {
                diagnostics.push_back(diagnostic(
                    "authoring.distribution-notice.invalid", "/settings/distributionNotices",
                    response.at("noticeValidationFailure").get<std::string>()));
                valid = false;
            }
            if (valid) {
                if (!response.contains("fontCoverageInputs") ||
                    !response.at("fontCoverageInputs").is_array())
                    return failure(args.json, 70, "NATIVE_PROJECT_VALIDATION_UNAVAILABLE", "/",
                                   "Native validation omitted its localization coverage inputs.",
                                   "Native validation omitted its localization coverage inputs.");
                const auto coverage =
                    native_font_coverage(root_text, response.at("fontCoverageInputs"));
                for (const auto& item : coverage.value("diagnostics", Json::array())) {
                    std::string stack;
                    for (const auto& font : item.value("fontStack", Json::array())) {
                        if (!stack.empty())
                            stack += ", ";
                        stack += font.get<std::string>();
                    }
                    Json projected =
                        diagnostic(item.value("code", "localization.font_coverage"),
                                   item.value("path", "/localization"),
                                   item.value("message", std::string{}) +
                                       " Message: " + item.value("messageId", std::string{}) +
                                       ". Effective stack: " + stack + ".");
                    projected["severity"] = item.value("severity", "error");
                    diagnostics.push_back(std::move(projected));
                }
                if (!coverage.value("ok", false) || !coverage.value("success", false)) {
                    diagnostics.push_back(diagnostic(
                        "native.localization.font_coverage", "/localization",
                        coverage.value("error", std::string("Font coverage validation failed."))));
                }
                if (std::none_of(diagnostics.begin(), diagnostics.end(),
                                 [](const Json& item) {
                                     return item.value("severity", "error") == "error";
                                 }) &&
                    response.contains("materialCompilerPrograms") &&
                    response.at("materialCompilerPrograms").is_object() &&
                    !response.at("materialCompilerPrograms").empty()) {
                    if (std::getenv("NOVELTEA_CLI_TRACE"))
                        std::cerr << "[native-cli] materials with compiler requests: "
                                  << response.at("materialCompilerPrograms").size() << '\n';
                    const auto compiled =
                        native_material_compile(root_text, response.at("materialCompilerPrograms"));
                    if (std::getenv("NOVELTEA_CLI_TRACE"))
                        std::cerr << "[native-cli] shader compile success: "
                                  << compiled.value("success", false) << " diagnostics: "
                                  << compiled.value("diagnostics", Json::array()).size() << '\n';
                    for (const auto& item : compiled.value("diagnostics", Json::array())) {
                        const auto path =
                            item.value("path", item.value("sourcePath", std::string("/materials")));
                        Json projected = diagnostic("native.shader." +
                                                        item.value("code", std::string("compile")),
                                                    path, item.value("message", std::string{}));
                        projected["severity"] = item.value("severity", std::string("error"));
                        diagnostics.push_back(std::move(projected));
                    }
                    if ((!compiled.value("ok", false) || !compiled.value("success", false)) &&
                        std::none_of(diagnostics.begin(), diagnostics.end(), [](const Json& item) {
                            return item.value("severity", "error") == "error";
                        }))
                        diagnostics.push_back(diagnostic(
                            "native.shader.compile", "/shaders",
                            compiled.value("error", std::string("Shader compilation failed."))));
                    if (compiled.value("ok", false) && compiled.value("success", false) &&
                        response.contains("materialEffectiveInputs") &&
                        response.at("materialEffectiveInputs").is_object())
                        append_material_reflection_diagnostics(
                            diagnostics, compiled, response.at("materialEffectiveInputs"));
                }
            }
            const auto proof =
                native_request({{"action", "source-generation-proof"},
                                {"projectRoot", root_text},
                                {"expectedSourceGeneration", response.at("sourceGeneration")}});
            if (!proof.value("ok", false))
                return failure(
                    args.json, 5, "WORKSPACE_REVISION_CONFLICT", "/",
                    proof.value("error", std::string("Project sources changed during validation.")),
                    "Project sources changed during validation.");
            Json paths = Json::array();
            std::vector<std::size_t> indices;
            for (std::size_t i = 0; i < diagnostics.size(); ++i) {
                if (!diagnostics[i].contains("sourceUrl") || !diagnostics[i].contains("line")) {
                    indices.push_back(i);
                    paths.push_back(diagnostics[i].at("path"));
                }
            }
            if (!indices.empty()) {
                const auto locations =
                    native_request({{"action", "project-diagnostic-locations"},
                                    {"projectRoot", root_text},
                                    {"expectedSourceGeneration", response.at("sourceGeneration")},
                                    {"paths", paths}});
                if (!locations.value("ok", false) || !locations.contains("locations") ||
                    locations.at("locations").size() != indices.size())
                    return failure(args.json, 5, "WORKSPACE_REVISION_CONFLICT", "/",
                                   "Project sources changed during diagnostic source lookup.",
                                   "Project sources changed during diagnostic source lookup.");
                for (std::size_t i = 0; i < indices.size(); ++i)
                    for (const auto* field : {"sourceUrl", "line", "column"})
                        if (locations.at("locations")[i].contains(field))
                            diagnostics[indices[i]][field] = locations.at("locations")[i].at(field);
            }
        }
        const bool errors =
            std::any_of(diagnostics.begin(), diagnostics.end(), [](const Json& item) {
                return item.value("severity", "error") == "error";
            });
        const bool native_error =
            std::any_of(diagnostics.begin(), diagnostics.end(), [](const Json& item) {
                return item.value("code", std::string{}).starts_with("native.");
            });
        valid = valid && !errors;
        return emit({{"success", valid},
                     {"exitCode", valid          ? 0
                                  : workspace    ? 3
                                  : native_error ? 6
                                                 : 4},
                     {"diagnostics", diagnostics},
                     {"projectRoot", root_text}},
                    args.json,
                    valid ? "NovelTea validate succeeded." : "NovelTea validate failed.");
    }
    if (!response.value("ok", false)) {
        const auto message = response.value("error", std::string("Native Project read failed."));
        const bool missing =
            (action == "entity-usages") &&
            std::regex_search(message,
                              std::regex("does not exist|cannot read .* source|unknown record",
                                         std::regex::icase));
        return native_failure(args, response,
                              missing ? "authoring.entity.not_found" : "WORKSPACE_SOURCE_READ",
                              missing_path, 4, "Native Project read failed.", root_text);
    }
    Json fields = Json::object();
    if (action == "entity-usages") {
        fields = {{"collection", response.at("collection")},
                  {"id", response.at("id")},
                  {"usages", response.at("usages")}};
    } else if (action == "localization-view") {
        fields = {{"locale", response.at("locale")}, {"messages", response.at("messages")}};
        if (response.contains("statusFilter") && !response.at("statusFilter").is_null() &&
            response.at("statusFilter") != "")
            fields["statusFilter"] = response.at("statusFilter");
        human = "Localization view for " + response.at("locale").get<std::string>() + ": " +
                std::to_string(response.at("messages").size()) + " Message(s).";
    } else {
        fields = response.at("fields");
        human = response.value("humanSuccess", std::string{});
    }
    return native_success(args, fields, human, root_text, project_diagnostics(response));
}

int project_lifecycle(const Arguments& args)
{
    const auto& c = args.command;
    const auto& operation = c[1];
    Json request;
    std::string path;
    if (operation == "create") {
        if (!args.project.empty())
            throw std::invalid_argument(
                "Global option '--project' is not supported by 'project create'.");
        if (c.size() < 3 || c[2].starts_with("--"))
            throw std::invalid_argument("Project directory is required.");
        std::string name;
        for (std::size_t i = 3; i < c.size(); ++i) {
            if (c[i] != "--name")
                throw std::invalid_argument("Unknown command option '" + c[i] + "'.");
            if (++i >= c.size() || c[i].starts_with("--"))
                throw std::invalid_argument("Option '--name' requires a project name.");
            if (!name.empty())
                throw std::invalid_argument("Option '--name' may be supplied only once.");
            name = c[i];
        }
        if (name.empty())
            throw std::invalid_argument("Required option '--name' was not supplied.");
        path = absolute_path(c[2]);
        request = {{"action", "project-create"}, {"projectRoot", path}, {"name", name}};
    } else if (operation == "import") {
        if (!args.project.empty())
            throw std::invalid_argument(
                "Global option '--project' is not supported by 'project import'.");
        if (c.size() != 4)
            throw std::invalid_argument(
                "Usage: noveltea project import <bundle.ntproject> <destination-directory>.");
        if (c[2].starts_with("--"))
            throw std::invalid_argument("Portable Project bundle path is required.");
        if (c[3].starts_with("--"))
            throw std::invalid_argument("Project destination directory is required.");
        path = absolute_path(c[2]);
        request = {{"action", "project-import"},
                   {"bundlePath", path},
                   {"destination", absolute_path(c[3])}};
    } else {
        std::string output;
        for (std::size_t i = 2; i < c.size(); ++i) {
            if (c[i] != "--output")
                throw std::invalid_argument("Unknown command option '" + c[i] + "'.");
            if (++i >= c.size() || c[i].starts_with("--"))
                throw std::invalid_argument("Option '--output' requires a path.");
            if (!output.empty())
                throw std::invalid_argument("Option '--output' may be supplied only once.");
            output = c[i];
        }
        if (output.empty())
            throw std::invalid_argument("Required option '--output' was not supplied.");
        path = absolute_path(output);
        const auto root = project_root(args.project);
        if (root.empty())
            return missing_project(args);
        request = {
            {"action", "project-export"}, {"projectRoot", path_text(root)}, {"outputPath", path}};
    }
    const auto response = native_request(request);
    if (!response.value("ok", false)) {
        const auto kind = response.value("kind", std::string{});
        std::string code;
        int status = 5;
        if (operation == "create") {
            code = kind == "conflict"   ? "PROJECT_CREATE_DESTINATION_CONFLICT"
                   : kind == "internal" ? "PROJECT_CREATE_INTERNAL"
                                        : "PROJECT_CREATE_MUTATION_FAILED";
            if (kind == "internal")
                status = 70;
        } else {
            code = kind == "conflict"          ? "PROJECT_BUNDLE_DESTINATION_CONFLICT"
                   : kind == "invalid-bundle"  ? "PROJECT_BUNDLE_INVALID"
                   : kind == "invalid-project" ? "PROJECT_BUNDLE_PROJECT_INVALID"
                   : kind == "source-changed"  ? "PROJECT_BUNDLE_SOURCE_CHANGED"
                                               : "PROJECT_BUNDLE_MUTATION_FAILED";
            if (kind == "invalid-bundle" || kind == "invalid-project")
                status = 4;
        }
        return native_failure(args, response, code, path, status,
                              "Native Project lifecycle operation failed.");
    }
    if (operation == "create")
        return native_success(args,
                              {{"projectRoot", response.at("projectRoot")},
                               {"projectFilePath", response.at("projectFilePath")},
                               {"projectId", response.at("projectId")}},
                              "Created NovelTea project at " +
                                  response.at("projectRoot").get<std::string>() + ".");
    if (operation == "import")
        return native_success(args,
                              {{"projectRoot", response.at("projectRoot")},
                               {"projectFilePath", response.at("projectFilePath")},
                               {"bundleSchema", response.at("manifest").at("schema")},
                               {"bundleVersion", response.at("manifest").at("version")}},
                              "Imported NovelTea project to " +
                                  response.at("projectRoot").get<std::string>() + ".");
    const auto output = response.at("outputPath").get<std::string>();
    return native_success(args,
                          {{"projectRoot", request.at("projectRoot")},
                           {"outputPath", output},
                           {"bundleSchema", response.at("manifest").at("schema")},
                           {"bundleVersion", response.at("manifest").at("version")},
                           {"fileCount", response.at("manifest").at("files").size()}},
                          "Exported portable NovelTea project to " + output + ".");
}

int project_fmt(const Arguments& args)
{
    const auto& c = args.command;
    const bool check = std::count(c.begin() + 1, c.end(), "--check") == 1;
    const bool strip = std::count(c.begin() + 1, c.end(), "--strip-defaults") == 1;
    std::vector<std::string> paths;
    for (std::size_t i = 1; i < c.size(); ++i)
        if (c[i] != "--check" && c[i] != "--strip-defaults")
            paths.push_back(c[i]);
    if (paths.size() > 1 || std::count(c.begin(), c.end(), "--check") > 1 ||
        std::count(c.begin(), c.end(), "--strip-defaults") > 1 ||
        (!paths.empty() && paths[0].starts_with("--")))
        return usage(args.json,
                     "Usage: noveltea fmt [<tracked-yaml-path>] [--check] [--strip-defaults]");
    const auto root = project_root(args.project);
    if (root.empty())
        return missing_project(args, true);
    const auto root_text = path_text(root);
    Json request{
        {"action", "fmt"}, {"projectRoot", root_text}, {"check", true}, {"stripDefaults", strip}};
    if (!paths.empty())
        request["path"] = paths[0];
    auto response = native_request(request);
    if (response.value("ok", false) && !check && response.value("changed", false)) {
        if (!response.contains("diskPreconditions") ||
            !response.at("diskPreconditions").is_object())
            throw std::runtime_error("Native fmt planning omitted exact disk revisions.");
        request["check"] = false;
        request["diskPreconditions"] = response.at("diskPreconditions");
        response = native_request(request);
    }
    if (!response.value("ok", false)) {
        const auto message = response.value("error", std::string("Native YAML formatter failed."));
        const bool wrong_path =
            message.find("not an existing tracked YAML source") != std::string::npos;
        const bool conflict = message.find("revision") != std::string::npos ||
                              message.find("transaction") != std::string::npos;
        return native_failure(args, response,
                              wrong_path ? "FMT_PATH"
                              : conflict ? "WORKSPACE_TRANSACTION_CONFLICT"
                                         : "FMT_INVALID_YAML",
                              "/" + (paths.empty() ? std::string{} : paths[0]),
                              wrong_path ? 2
                              : conflict ? 5
                                         : 3,
                              message, root_text);
    }
    const auto& files = response.at("files");
    const auto count = files.size();
    const bool needs = check && count != 0;
    Json diagnostics = Json::array();
    for (const auto& file : files)
        diagnostics.push_back(
            {{"code", "FMT_CHANGE"},
             {"severity", "warning"},
             {"path", "/" + file.get<std::string>()},
             {"message", check ? "Source requires formatting." : "Source formatted."}});
    return emit({{"success", !needs},
                 {"exitCode", needs ? 4 : 0},
                 {"diagnostics", diagnostics},
                 {"projectRoot", root_text},
                 {"checked", response.at("checked")},
                 {"changed", count},
                 {"files", files},
                 {"check", check}},
                args.json,
                needs   ? std::to_string(count) + " YAML Project source(s) require formatting."
                : check ? "All YAML Project sources are formatted."
                        : "YAML Project sources formatted.");
}

int project_mutation(const Arguments& args)
{
    const auto& c = args.command;
    const auto family = c[0];
    const auto operation = c[1];
    const bool asset = family == "asset";
    const auto flags =
        asset                   ? parse_flags(c, 2, {"--dry-run"})
        : operation == "create" ? parse_flags(c, 2, {"--dry-run"})
        : operation == "rename"
            ? parse_flags(c, 2, {"--dry-run", "--allow-possible-source-references"})
            : parse_flags(c, 2, {"--dry-run", "--force", "--allow-possible-source-references"});
    const bool dry = flags.flags.contains("--dry-run");
    Json request;
    std::string error_path;
    std::string collection, id;
    if (asset) {
        if (flags.positionals.empty())
            throw std::invalid_argument("Usage: noveltea asset import <path>... [--dry-run]");
        Json sources = Json::array();
        for (const auto& source : flags.positionals)
            sources.push_back(absolute_path(source));
        request = {{"action", "asset-import"}, {"paths", sources}, {"dryRun", dry}};
        error_path = "/assets";
    } else {
        const auto expected = operation == "rename" ? 3u : 2u;
        if (flags.positionals.size() != expected)
            throw std::invalid_argument(
                operation == "rename" ? "Usage: noveltea entity rename <collection> <old-id> "
                                        "<new-id> [--dry-run] [--allow-possible-source-references]"
                : operation == "create"
                    ? "Usage: noveltea entity create <collection> <id> [--dry-run]"
                    : "Usage: noveltea entity delete <collection> <id> [--dry-run] [--force] "
                      "[--allow-possible-source-references]");
        collection = flags.positionals[0];
        id = flags.positionals[1];
        require_collection(collection);
        if (operation == "create" && collection == "assets")
            throw std::invalid_argument(
                "Generic Asset creation is not supported; use 'noveltea asset import <path>'.");
        error_path = "/" + collection + "/" + id;
        request = {{"action", "entity-" + operation},
                   {"collection", collection},
                   {"id", id},
                   {"dryRun", dry}};
        if (operation == "rename")
            request["toId"] = flags.positionals[2];
        if (flags.flags.contains("--force"))
            request["force"] = true;
        if (flags.flags.contains("--allow-possible-source-references"))
            request["allowPossibleSourceReferences"] = true;
    }
    const auto root = project_root(args.project);
    if (root.empty())
        return missing_project(args);
    const auto root_text = path_text(root);
    request["projectRoot"] = root_text;
    Json response;
    if (!asset && operation != "create") {
        Json planned_request = request;
        planned_request["dryRun"] = true;
        const auto planned = native_request(planned_request);
        if (!planned.value("ok", false) || dry)
            response = planned;
        else if (!planned.contains("sourceRevision") || !planned.at("sourceRevision").is_string())
            response = {{"ok", false},
                        {"error", "Native mutation plan lacks an exact source revision."}};
        else {
            request["sourceRevision"] = planned.at("sourceRevision");
            response = native_request(request);
        }
    } else
        response = native_request(request);
    if (!response.value("ok", false)) {
        const auto message =
            response.value("error", std::string("Native Project mutation failed."));
        const bool conflict = std::regex_search(
            message,
            std::regex("revision|source changed|transaction|physical|source authority|conflict",
                       std::regex::icase));
        const std::string code =
            asset ? "ASSET_IMPORT_FAILED"
            : operation == "rename" &&
                    message.find("Possible source reference") != std::string::npos
                ? "authoring.source_reference.possible"
            : operation == "delete" && message.find("does not exist") != std::string::npos
                ? "authoring.entity.not_found"
                : "authoring.entity." + operation;
        return native_failure(args, response, code, error_path, conflict ? 5 : 4,
                              "Native Project mutation failed.", root_text);
    }
    if (asset)
        return native_success(
            args, response.at("fields"),
            response.value("humanSuccess", std::string("Asset import completed.")), root_text,
            project_diagnostics(response));
    if (!response.contains("plan") || !response.at("plan").is_object())
        throw std::runtime_error(
            "Native entity mutation did not supply its authoritative physical plan.");
    Json fields{
        {"collection", collection}, {"id", id}, {"dryRun", dry}, {"plan", response.at("plan")}};
    if (operation == "rename") {
        fields.erase("id");
        fields["fromId"] = id;
        fields["toId"] = request.at("toId");
        fields["commentImpacts"] = response.value("commentImpacts", Json::array());
        fields["commentNotices"] = response.value("commentNotices", Json::array());
        fields["usages"] = response.value("usages", Json::array());
    } else if (operation == "delete") {
        fields["force"] = request.value("force", false);
        fields["commentImpacts"] = response.value("commentImpacts", Json::array());
        fields["usages"] = response.value("usages", Json::array());
    }
    return native_success(args, fields,
                          std::string(dry ? "Planned" : "Completed") + " entity-" + operation +
                              " for " + collection + "/" + id + ".",
                          root_text, project_diagnostics(response));
}

int localization(const Arguments& args)
{
    const auto& c = args.command;
    const auto& op = c[1];
    Json request;
    bool dry = false;
    std::string locale;
    Json message_ids = Json::array();
    if (op == "sync") {
        if (c.size() > 3 || (c.size() == 3 && c[2] != "--dry-run"))
            return usage(args.json, "localization sync does not accept positional arguments.");
        dry = c.size() == 3;
        request = {{"action", "localization-sync"}, {"dryRun", true}};
    } else if (op == "accept" || op == "review") {
        const auto flags = parse_flags(c, 2, {"--dry-run"});
        dry = flags.flags.contains("--dry-run");
        if (flags.positionals.size() < 2)
            throw std::invalid_argument("localization " + op +
                                        " requires a target locale and at least one Message ID.");
        locale = flags.positionals[0];
        for (std::size_t i = 1; i < flags.positionals.size(); ++i)
            message_ids.push_back(flags.positionals[i]);
        request = {{"action", "localization-targets"},
                   {"operation", op},
                   {"locale", locale},
                   {"messageIds", message_ids},
                   {"dryRun", true}};
    } else {
        if (c.size() > 3 || (c.size() == 3 && c[2] != "--apply"))
            return usage(args.json, "localization reconcile does not accept positional arguments.");
        request = {{"action", "localization-reconcile"}, {"dryRun", true}};
    }
    Json input;
    const bool apply = op == "reconcile" && c.size() == 3;
    if (apply) {
        const std::string text(std::istreambuf_iterator<char>{std::cin}, {});
        if (text.find_first_not_of(" \r\n\t") == std::string::npos)
            return usage(args.json, "Command requires one UTF-8 JSON value on stdin.");
        input = Json::parse(text, nullptr, false);
        if (input.is_discarded())
            return usage(args.json, "Unexpected end of JSON input");
    }
    const auto root = project_root(args.project);
    if (root.empty())
        return missing_project(args);
    const auto root_text = path_text(root);
    request["projectRoot"] = root_text;
    const auto planned = native_request(request);
    const std::string path = op == "sync" || op == "reconcile"
                                 ? "/localization"
                                 : "/localization/translations/" + locale;
    if (!planned.value("ok", false)) {
        const auto message =
            planned.value("error", std::string("Native localization operation failed."));
        if (op == "sync")
            return native_failure(args, planned, "localization.sync.native", path, 5, message,
                                  root_text);
        if (op == "reconcile")
            return native_failure(args, planned, "localization.reconcile.native", path, 3, message,
                                  root_text);
        const std::string code = message.find("no target translation") != std::string::npos ||
                                         message.find("missing") != std::string::npos
                                     ? "localization.workflow.missing"
                                 : message.find("Outdated") != std::string::npos ||
                                         message.find("stale source identity") != std::string::npos
                                     ? "localization.review.outdated"
                                     : "localization.workflow.native";
        return native_failure(args, planned, code, path, 4, message, root_text,
                              {{"locale", locale}, {"messageIds", message_ids}});
    }
    if (op == "sync") {
        auto response = planned;
        if (!dry && planned.value("changed", false)) {
            if (!planned.contains("sourceRevision") || !planned.at("sourceRevision").is_string() ||
                !planned.contains("sourceGeneration") ||
                !planned.at("sourceGeneration").is_string())
                throw std::runtime_error("Native localization sync plan omitted source authority.");
            request["dryRun"] = false;
            request["sourceRevision"] = planned.at("sourceRevision");
            request["expectedSourceGeneration"] = planned.at("sourceGeneration");
            response = native_request(request);
        }
        if (!response.value("ok", false))
            return native_failure(args, response, "localization.sync.native", path, 5,
                                  "Native localization sync failed.", root_text);
        Json diagnostics = project_diagnostics(response);
        for (const auto& item : response.at("unresolved")) {
            auto family = item.at("family").get<std::string>();
            std::transform(family.begin(), family.end(), family.begin(),
                           [](unsigned char ch) { return static_cast<char>(std::toupper(ch)); });
            diagnostics.push_back({{"code", "localization.sync.reconciliation-required"},
                                   {"severity", "warning"},
                                   {"path", item.at("sourcePath")},
                                   {"message", "Managed " + family + " Message occurrence " +
                                                   item.at("ordinal").dump() +
                                                   " is ambiguous and was left untracked."}});
        }
        Json fields{{"dryRun", dry},
                    {"changed", response.at("changed")},
                    {"materializedMessageIds", response.at("materializedMessageIds")},
                    {"preservedMessageIds", response.at("preservedMessageIds")},
                    {"unresolved", response.at("unresolved")},
                    {"structuredMessageCount", response.at("structuredMessageCount")},
                    {"writes", response.at("writes")}};
        const bool changed = response.value("changed", false);
        const auto human = changed
                               ? (dry ? "Localization sync found deterministic tracking updates."
                                      : "Localization tracking synchronized.")
                               : "Localization tracking is already synchronized.";
        return native_success(args, fields, human, root_text, diagnostics);
    }
    if (op == "accept" || op == "review") {
        auto response = planned;
        if (!dry) {
            if (!planned.contains("sourceRevision") || !planned.at("sourceRevision").is_string() ||
                !planned.contains("sourceGeneration") ||
                !planned.at("sourceGeneration").is_string())
                throw std::runtime_error(
                    "Native localization workflow plan lacks exact source authority.");
            request["dryRun"] = false;
            request["sourceRevision"] = planned.at("sourceRevision");
            request["expectedSourceGeneration"] = planned.at("sourceGeneration");
            response = native_request(request);
        }
        if (!response.value("ok", false)) {
            const auto message =
                response.value("error", std::string("Native localization workflow failed."));
            const std::string code =
                message.find("no target translation") != std::string::npos ||
                        message.find("missing") != std::string::npos
                    ? "localization.workflow.missing"
                : message.find("Outdated") != std::string::npos ||
                        message.find("stale source identity") != std::string::npos
                    ? "localization.review.outdated"
                    : "localization.workflow.native";
            return native_failure(args, response, code, path, 4, message, root_text,
                                  {{"locale", locale}, {"messageIds", message_ids}});
        }
        return native_success(args,
                              {{"locale", locale},
                               {"messageIds", message_ids},
                               {"dryRun", dry},
                               {"writes", response.at("writes")}},
                              "Localization " + op + " updated " +
                                  std::to_string(message_ids.size()) + " Message(s).",
                              root_text, project_diagnostics(response));
    }
    const auto& plan = planned.at("plan");
    if (!plan.is_object() || !plan.contains("expectedWorkspaceRevision") ||
        !plan.contains("expectedFingerprint") || !plan.contains("groups"))
        throw std::runtime_error("Native reconciliation response omitted its authoritative plan.");
    const auto human = plan.at("groups").empty()
                           ? "Localization reconciliation has no pending work."
                           : "Localization reconciliation found " +
                                 std::to_string(plan.at("groups").size()) + " pending group(s).";
    if (!apply)
        return native_success(args, {{"plan", plan}, {"writes", Json::array()}}, human, root_text,
                              project_diagnostics(planned));
    auto semantic_error = [&](const std::string& code, const std::string& message) {
        Json diagnostics = Json::array({diagnostic(
            code, code == "localization.reconcile.invalid-input" ? "/stdin" : path, message)});
        for (const auto& item : project_diagnostics(planned))
            diagnostics.push_back(item);
        return emit({{"success", false},
                     {"exitCode", 4},
                     {"diagnostics", diagnostics},
                     {"projectRoot", root_text},
                     {"plan", plan}},
                    args.json, message);
    };
    if (!input.is_object() || !input.contains("expectedWorkspaceRevision") ||
        !input.at("expectedWorkspaceRevision").is_string() ||
        !input.contains("expectedFingerprint") || !input.at("expectedFingerprint").is_string() ||
        !input.contains("resolutions") || !input.at("resolutions").is_object())
        return semantic_error(
            "localization.reconcile.invalid-input",
            "localization reconcile --apply requires one JSON object on stdin with "
            "expectedWorkspaceRevision, expectedFingerprint, and resolutions.");
    for (const auto& [key, value] : input.at("resolutions").items()) {
        if (!value.is_string() || value.get<std::string>().empty())
            return semantic_error(
                "localization.reconcile.invalid-input",
                "localization reconcile --apply requires one JSON object on stdin with "
                "expectedWorkspaceRevision, expectedFingerprint, and resolutions.");
    }
    if (input.at("expectedWorkspaceRevision") != plan.at("expectedWorkspaceRevision") ||
        input.at("expectedFingerprint") != plan.at("expectedFingerprint"))
        return semantic_error("localization.reconcile.stale-plan",
                              "The reconciliation plan is stale because the Project workspace "
                              "changed. Recompute the plan before applying it.");
    if (!planned.contains("sourceGeneration") || !planned.contains("diskPreconditions"))
        throw std::runtime_error(
            "Native reconciliation plan omitted exact physical source preconditions.");
    request["dryRun"] = false;
    request["workspaceRevision"] = plan.at("expectedWorkspaceRevision");
    request["expectedWorkspaceRevision"] = input.at("expectedWorkspaceRevision");
    request["expectedFingerprint"] = input.at("expectedFingerprint");
    request["resolutions"] = input.at("resolutions");
    request["expectedSourceGeneration"] = planned.at("sourceGeneration");
    request["diskPreconditions"] = planned.at("diskPreconditions");
    const auto applied = native_request(request);
    if (!applied.value("ok", false)) {
        if (applied.value("status", std::string{}) == "needs-decision" &&
            applied.contains("occurrenceIds") && applied.at("occurrenceIds").is_array()) {
            Json diagnostics = Json::array();
            for (const auto& id : applied.at("occurrenceIds"))
                diagnostics.push_back(diagnostic(
                    "localization.reconcile.decision-required", "/localization",
                    "Reconciliation occurrence '" + id.get<std::string>() +
                        "' contains valuable prior work and requires an explicit resolution."));
            return emit({{"success", false},
                         {"exitCode", 4},
                         {"diagnostics", diagnostics},
                         {"projectRoot", root_text},
                         {"plan", applied.value("plan", plan)},
                         {"occurrenceIds", applied.at("occurrenceIds")}},
                        args.json);
        }
        return native_failure(args, applied, "localization.reconcile.stale-plan", path, 4,
                              "Native reconciliation source authority changed during commit.",
                              root_text);
    }
    const auto& writes = applied.at("writes");
    return native_success(args,
                          {{"relinkedMessageIds", applied.at("relinkedMessageIds")},
                           {"materializedMessageIds", applied.at("materializedMessageIds")},
                           {"orphanedMessageIds", applied.at("orphanedMessageIds")},
                           {"garbageCollectedMessageIds", applied.at("garbageCollectedMessageIds")},
                           {"writes", writes}},
                          writes.empty() ? "Localization reconciliation is already resolved."
                                         : "Localization reconciliation applied.",
                          root_text, project_diagnostics(applied));
}

int run(const std::vector<std::string>& argv)
{
    Arguments args;
    try {
        args = parse(argv);
    } catch (const std::invalid_argument& error) {
        return usage(std::find(argv.begin(), argv.end(), "--json") != argv.end(), error.what());
    }
    if (args.help) {
        if (!args.json) {
            std::cout << help;
            return 0;
        }
        return emit(
            {{"success", true}, {"exitCode", 0}, {"diagnostics", Json::array()}, {"help", help}},
            true);
    }
    if (args.version)
        return emit({{"success", true},
                     {"exitCode", 0},
                     {"diagnostics", Json::array()},
                     {"version", version}},
                    args.json, std::string(version));
    if (args.command.empty())
        return usage(args.json, "A command is required.");
    if (!known_command(args.command)) {
        std::string command;
        for (const auto& word : args.command)
            command += (command.empty() ? "" : " ") + word;
        return usage(args.json, "Unknown command path '" + command + "'.");
    }
    if (args.command.size() >= 2 && args.command[0] == "entity" && args.command[1] == "inspect")
        return inspect(args);
    try {
        const auto& family = args.command[0];
        const auto operation = args.command.size() > 1 ? args.command[1] : "";
        if (family == "validate")
            return project_read(args, "project-validate");
        if (family == "shaders" && operation == "compile")
            return shaders_compile(args);
        if (family == "test")
            return tests_from_native_runtime(args);
        if (family == "package" && operation == "export")
            return package_from_native_runtime(args);
        if (family == "shaderc" || family == "texturec") {
            if (args.json)
                return usage(true, "Raw '" + family + "' does not support NovelTea --json mode.");
            std::vector<const char*> raw_args{family.c_str()};
            for (std::size_t i = 1; i < args.command.size(); ++i)
                raw_args.push_back(args.command[i].c_str());
            return family == "shaderc" ? noveltea_tooling_shaderc(static_cast<int>(raw_args.size()),
                                                                  raw_args.data())
                                       : noveltea_tooling_texturec(
                                             static_cast<int>(raw_args.size()), raw_args.data());
        }
        if (family == "usages")
            return project_read(args, "entity-usages");
        if (family == "asset" && operation == "audit")
            return project_read(args, "asset-audit");
        if (family == "localization" && operation == "view")
            return project_read(args, "localization-view");
        if (family == "project")
            return project_lifecycle(args);
        if (family == "fmt")
            return project_fmt(args);
        if (family == "entity" &&
            (operation == "create" || operation == "rename" || operation == "delete"))
            return project_mutation(args);
        if (family == "asset" && operation == "import")
            return project_mutation(args);
        if (family == "localization" && (operation == "sync" || operation == "reconcile" ||
                                         operation == "accept" || operation == "review"))
            return localization(args);
    } catch (const std::invalid_argument& error) {
        return usage(args.json, error.what());
    }
    return failure(args.json, 70, "CLI_NATIVE_CANDIDATE_UNCLAIMED", "/",
                   "Command is not implemented by the direct C++ CLI candidate.",
                   "Command is not implemented by the direct C++ CLI candidate.");
}
} // namespace
} // namespace noveltea::cli

int main(int argc, char** argv)
{
    const std::vector<std::string> args(argv + 1, argv + argc);
    try {
        return noveltea::cli::run(args);
    } catch (const std::exception& error) {
        return noveltea::cli::failure(std::find(args.begin(), args.end(), "--json") != args.end(),
                                      70, "CLI_INTERNAL", "/", error.what(), error.what());
    }
}
