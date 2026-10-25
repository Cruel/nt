#include "native_cli_contract.hpp"
#include "tooling_native_c.h"

#include <nlohmann/json.hpp>

#include <algorithm>
#include <filesystem>
#include <iostream>
#include <regex>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

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
