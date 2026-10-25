#include "native_cli_contract.hpp"
#include "tooling_native_c.h"
#include "../project_authoring/material_semantics.hpp"

#include <nlohmann/json.hpp>

#include <algorithm>
#include <cctype>
#include <cstdio>
#include <filesystem>
#include <iterator>
#include <iostream>
#include <map>
#include <regex>
#include <set>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>
#if defined(_WIN32)
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

Json native_material_compile(const std::string& root, const Json& programs)
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
            const auto [found, unique] = canonical_programs.emplace(identity, id);
            if (unique)
                combined[id] = program;
            material_program_aliases[material_id] = found->second;
        }
    }
    const auto serialized =
        Json{{"shaderProject",
              {{"schema", "noveltea.shader-source-programs"}, {"programs", combined}}},
             {"options",
              {{"projectRoot", root},
               {"outputRoot", root + "/.noveltea/build"},
               {"cacheRoot", root + "/.noveltea/cache"},
               {"shaderVariants", Json::array({"glsl-330", "essl-300", "metal"})}}}}
            .dump();
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
                        response.at("materialEffectiveInputs").is_object()) {
                        for (const auto& [material_id, effective] :
                             response.at("materialEffectiveInputs").items()) {
                            if (!effective.value("custom", false))
                                continue;
                            Json material_outputs = Json::array();
                            for (const auto& output : compiled.value("outputs", Json::array()))
                                if (output.value("program", std::string{}) == material_id)
                                    material_outputs.push_back(output);
                            const auto reflected =
                                noveltea::authoring::validate_material_shader_compiler_result(
                                    Json{{"ok", true},
                                         {"success", true},
                                         {"diagnostics", Json::array()},
                                         {"outputs", std::move(material_outputs)}}
                                        .dump(),
                                    material_id, effective.dump());
                            for (const auto& finding : reflected.diagnostics) {
                                auto message = finding.message;
                                if (finding.code == "material.shader.orphan") {
                                    const auto name =
                                        finding.path.substr(finding.path.find_last_of('/') + 1);
                                    std::string unescaped;
                                    for (std::size_t i = 0; i < name.size(); ++i) {
                                        if (name[i] == '~' && i + 1 < name.size() &&
                                            (name[i + 1] == '0' || name[i + 1] == '1'))
                                            unescaped += name[++i] == '0' ? '~' : '/';
                                        else
                                            unescaped += name[i];
                                    }
                                    const bool texture =
                                        finding.path.find("/textures/") != std::string::npos;
                                    message = "Material " +
                                              std::string(texture ? "texture" : "parameter") +
                                              " '" + unescaped +
                                              "' is not present in the reflected shader interface "
                                              "and remains orphaned.";
                                }
                                Json mapped =
                                    diagnostic("shader.material_project", finding.path, message);
                                mapped["severity"] = finding.severity;
                                diagnostics.push_back(std::move(mapped));
                            }
                        }
                    }
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
