#include "native_cli_comfyui.hpp"
#include "native_cli_comfyui_http.hpp"
#include "native_comfyui_workflows_generated.hpp"

#include <noveltea/core/player_bootstrap.hpp>

#include <algorithm>
#include <array>
#include <atomic>
#include <charconv>
#include <chrono>
#include <cmath>
#include <csignal>
#include <cstdlib>
#include <ctime>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <map>
#include <optional>
#include <random>
#include <regex>
#include <set>
#include <span>
#include <sstream>
#include <thread>
#if defined(_WIN32)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <Windows.h>
#endif

namespace noveltea::cli {
namespace {
using Json = nlohmann::ordered_json;
namespace fs = std::filesystem;

Json cli_diagnostic(const std::string& code, const std::string& path, const std::string& message,
                    const std::string& severity = "error")
{
    return {{"code", code}, {"severity", severity}, {"path", path}, {"message", message}};
}

Json workflow_diagnostic(const std::string& path, const std::string& message,
                         const std::string& severity = "error")
{
    return {{"severity", severity},
            {"category", "comfyui-workflows"},
            {"path", path},
            {"message", message}};
}

ComfyUiResult result(bool ok, int code, Json fields, Json diagnostics, std::string human)
{
    Json envelope{{"success", ok}, {"exitCode", code}, {"diagnostics", diagnostics}};
    for (const auto& [key, value] : fields.items())
        envelope[key] = value;
    return {std::move(envelope), std::move(human)};
}

ComfyUiResult semantic_failure(const std::string& code, const std::string& path,
                               const std::string& message, Json fields = Json::object())
{
    return result(false, 4, std::move(fields), Json::array({cli_diagnostic(code, path, message)}),
                  message);
}

std::string path_text(const fs::path& value)
{
    const auto text = value.u8string();
    return {text.begin(), text.end()};
}

std::optional<std::string> read_file(const fs::path& path, std::uintmax_t maximum)
{
    std::error_code error;
    if (!fs::is_regular_file(path, error) || fs::file_size(path, error) > maximum || error)
        return std::nullopt;
    std::ifstream input(path, std::ios::binary);
    if (!input)
        return std::nullopt;
    std::string text(static_cast<std::size_t>(fs::file_size(path, error)), '\0');
    if (error || !input.read(text.data(), static_cast<std::streamsize>(text.size())))
        return std::nullopt;
    return text;
}

std::string canonical(const Json& input)
{
    if (input.is_array()) {
        std::string output = "[";
        for (const auto& item : input) {
            if (output.size() > 1)
                output += ',';
            output += canonical(item);
        }
        return output + "]";
    }
    if (!input.is_object())
        return input.dump();
    std::map<std::string, std::string> sorted;
    for (const auto& [key, value] : input.items())
        sorted.emplace(key, canonical(value));
    std::string output = "{";
    for (const auto& [key, value] : sorted) {
        if (output.size() > 1)
            output += ',';
        output += Json(key).dump() + ":" + value;
    }
    return output + "}";
}

std::string package_hash(const Json& manifest, const Json& workflow)
{
    const auto material = canonical(manifest) + "\n" + canonical(workflow);
    return "sha256:" + core::sha256_hex(std::as_bytes(std::span(material.data(), material.size())));
}

fs::path user_root()
{
    if (const char* override = std::getenv("NOVELTEA_USER_CONFIG_ROOT"); override && *override)
        return fs::u8path(override);
#if defined(_WIN32)
    if (const char* home = std::getenv("USERPROFILE"); home && *home)
        return fs::u8path(home) / ".noveltea";
#endif
    if (const char* home = std::getenv("HOME"); home && *home)
        return fs::u8path(home) / ".noveltea";
    return fs::current_path() / ".noveltea";
}

std::string now_iso()
{
    const auto now = std::chrono::system_clock::now();
    const auto micros =
        std::chrono::duration_cast<std::chrono::milliseconds>(now.time_since_epoch());
    const auto ms = micros.count() % 1000;
    const auto clock = std::chrono::system_clock::to_time_t(now);
    std::tm utc{};
#if defined(_WIN32)
    gmtime_s(&utc, &clock);
#else
    gmtime_r(&clock, &utc);
#endif
    std::ostringstream text;
    text << std::put_time(&utc, "%Y-%m-%dT%H:%M:%S") << '.' << std::setfill('0') << std::setw(3)
         << ms << 'Z';
    return text.str();
}

struct Config {
    std::string server = "http://127.0.0.1:8000";
    int timeout = 15000;
    std::map<std::string, std::string> defaults;
};

bool only_keys(const Json& object, std::initializer_list<std::string_view> keys)
{
    if (!object.is_object())
        return false;
    for (const auto& [key, value] : object.items()) {
        (void)value;
        if (std::find(keys.begin(), keys.end(), key) == keys.end())
            return false;
    }
    return true;
}

bool valid_user_export_config(const Json& value)
{
    if (!only_keys(value, {"toolchains", "signingProfiles"}))
        return false;
    if (value.contains("toolchains")) {
        const auto& toolchains = value.at("toolchains");
        if (!only_keys(toolchains, {"androidSdk", "androidNdk", "javaHome", "cmake"}))
            return false;
        for (const auto& entry : toolchains)
            if (!entry.is_string())
                return false;
    }
    if (!value.contains("signingProfiles"))
        return true;
    const auto& profiles = value.at("signingProfiles");
    if (!profiles.is_array())
        return false;
    static const std::regex secret(R"(^env:[A-Za-z_][A-Za-z0-9_]*$)");
    std::set<std::string> ids;
    for (const auto& profile : profiles) {
        if (!profile.is_object() || !profile.contains("target") ||
            !profile.at("target").is_string())
            return false;
        const auto target = profile.at("target").get<std::string>();
        const bool windows = target == "windows", macos = target == "macos";
        if ((!windows && !macos && target != "android") ||
            !only_keys(
                profile,
                windows
                    ? std::initializer_list<std::string_view>{"id", "label", "target", "command",
                                                              "args", "verifyCommand", "verifyArgs"}
                : macos ? std::initializer_list<std::string_view>{"id", "label", "target",
                                                                  "identity", "entitlementsPath",
                                                                  "notarizationCommand",
                                                                  "notarizationArgs"}
                        : std::initializer_list<std::string_view>{
                              "id", "label", "target", "keystorePath", "keyAlias",
                              "storePasswordReference", "keyPasswordReference"}))
            return false;
        for (const auto* field : {"id", "label"})
            if (!profile.contains(field) || !profile.at(field).is_string() ||
                profile.at(field).get<std::string>().find_first_not_of(" \t\r\n") ==
                    std::string::npos)
                return false;
        if (!ids.insert(profile.at("id").get<std::string>()).second)
            return false;
        const auto check_string = [&](const char* field, bool required, bool nonempty) {
            if (!profile.contains(field))
                return !required;
            return profile.at(field).is_string() &&
                   (!nonempty || !profile.at(field).get<std::string>().empty());
        };
        const auto check_array = [&](const char* field, bool required) {
            if (!profile.contains(field))
                return !required;
            if (!profile.at(field).is_array())
                return false;
            return std::all_of(profile.at(field).begin(), profile.at(field).end(),
                               [](const Json& item) { return item.is_string(); });
        };
        if (windows &&
            (!check_string("command", true, true) || !check_string("verifyCommand", true, true) ||
             !check_array("args", true) || !check_array("verifyArgs", true)))
            return false;
        if (macos && (!check_string("identity", true, true) ||
                      !check_string("entitlementsPath", false, false) ||
                      !check_string("notarizationCommand", false, false) ||
                      !check_array("notarizationArgs", false)))
            return false;
        if (!windows && !macos) {
            if (!check_string("keystorePath", true, true) ||
                !check_string("keyAlias", true, true) ||
                !check_string("storePasswordReference", true, true) ||
                !check_string("keyPasswordReference", true, true))
                return false;
            if (!std::regex_match(profile.at("storePasswordReference").get<std::string>(),
                                  secret) ||
                !std::regex_match(profile.at("keyPasswordReference").get<std::string>(), secret))
                return false;
        }
    }
    return true;
}

// The TypeScript reader rejects the *entire* shared user configuration when
// any strict Zod field is invalid. Do not retain a partially valid server URL.
bool valid_user_config(const Json& source)
{
    if (!only_keys(source, {"format", "formatVersion", "preferences", "comfyui", "export"}) ||
        !source.contains("format") || !source.at("format").is_string() ||
        source.at("format") != "noveltea.user-config" || !source.contains("formatVersion") ||
        !source.at("formatVersion").is_number_integer() || source.at("formatVersion") != 1 ||
        (source.contains("preferences") && !source.at("preferences").is_object()) ||
        (source.contains("export") && !valid_user_export_config(source.at("export"))))
        return false;
    if (!source.contains("comfyui"))
        return true;
    const auto& shared = source.at("comfyui");
    if (!only_keys(shared, {"serverUrl", "requestTimeoutMs", "defaultWorkflows"}) ||
        !shared.contains("serverUrl") || !shared.at("serverUrl").is_string() ||
        !shared.contains("requestTimeoutMs") ||
        !shared.at("requestTimeoutMs").is_number_integer() ||
        !shared.contains("defaultWorkflows") || !shared.at("defaultWorkflows").is_object())
        return false;
    const auto timeout = shared.at("requestTimeoutMs").get<std::int64_t>();
    if (timeout < 1 || timeout > 300000 || shared.at("serverUrl").get<std::string>().size() > 2048)
        return false;
    try {
        (void)comfyui_server_identity(shared.at("serverUrl").get<std::string>());
    } catch (...) {
        return false;
    }
    const auto& defaults = shared.at("defaultWorkflows");
    if (defaults.size() > 16)
        return false;
    static const std::regex classification(R"(^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$)");
    for (const auto& [key, value] : defaults.items()) {
        if (!std::regex_match(key, classification) || !value.is_string() ||
            value.get<std::string>().empty() || value.get<std::string>().size() > 256)
            return false;
    }
    return true;
}

Config config(const std::optional<std::string>& server_override)
{
    Config settings;
    if (const auto text = read_file(user_root() / "config.json", 1024 * 1024)) {
        try {
            const auto source = Json::parse(*text, nullptr, false);
            if (!source.is_discarded() && valid_user_config(source) && source.contains("comfyui")) {
                const auto& shared = source.at("comfyui");
                settings.server = shared.at("serverUrl").get<std::string>();
                settings.timeout = shared.at("requestTimeoutMs").get<int>();
                for (const auto& [classification, id] : shared.at("defaultWorkflows").items())
                    settings.defaults.emplace(classification, id.get<std::string>());
            }
        } catch (...) {
            // Invalid shared user config has the same default behavior as the editor reader.
        }
    }
    if (server_override)
        settings.server = *server_override;
    const auto start = settings.server.find_first_not_of(" \t\n\r");
    if (start != std::string::npos)
        settings.server =
            settings.server.substr(start, settings.server.find_last_not_of(" \t\n\r") - start + 1);
    while (!settings.server.empty() && settings.server.back() == '/')
        settings.server.pop_back();
    // Validate before any request, including the projectless/offline paths.
    try {
        (void)comfyui_server_identity(settings.server);
    } catch (...) {
        if (server_override)
            throw std::invalid_argument("ComfyUI server must be a valid HTTP(S) URL.");
        settings.server = Config{}.server;
    }
    return settings;
}

struct Workflow {
    std::string source;
    std::string manifest_file;
    std::string key;
    std::string id;
    std::string label;
    Json manifest;
    Json graph;
    Json diagnostics = Json::array();
    Json verification_diagnostics = Json::array();
    std::string offline = "valid";
    std::string online = "unverified";
    std::string hash;
    bool runnable = false;
    bool active = false;
    bool overridden = false;
    std::string overridden_by;
};

int source_rank(const std::string& source)
{
    return source == "project" ? 3 : source == "user" ? 2 : 1;
}

std::string node_title(const Json& node)
{
    if (!node.is_object() || !node.contains("_meta") || !node.at("_meta").is_object())
        return {};
    const auto& meta = node.at("_meta");
    return meta.contains("title") && meta.at("title").is_string()
               ? meta.at("title").get<std::string>()
               : std::string{};
}

// Resolve current graph IDs first, then the same class/title fallback ordering as the editor.
std::string resolve_binding(const Json& graph, const Json& binding, bool output)
{
    if (!binding.is_object())
        return {};
    const auto original = binding.value("nodeId", std::string{});
    const auto input = output ? "" : binding.value("inputName", std::string{});
    const auto valid = [&](const Json& node) {
        return node.is_object() &&
               (output || (node.contains("inputs") && node.at("inputs").is_object() &&
                           node.at("inputs").contains(input)));
    };
    if (graph.contains(original) && valid(graph.at(original)))
        return original;
    const auto selector = binding.value("selector", Json::object());
    const auto title = selector.is_object()
                           ? selector.value("title", binding.value("nodeTitle", std::string{}))
                           : binding.value("nodeTitle", std::string{});
    const auto cls = selector.is_object()
                         ? selector.value("classType", binding.value("classType", std::string{}))
                         : binding.value("classType", std::string{});
    const auto find = [&](bool by_title, bool by_class) {
        std::string found;
        for (const auto& [id, node] : graph.items()) {
            if (!valid(node) || (by_title && node_title(node) != title) ||
                (by_class && (!node.contains("class_type") || !node.at("class_type").is_string() ||
                              node.at("class_type").get<std::string>() != cls)))
                continue;
            if (!found.empty())
                return std::string{};
            found = id;
        }
        return found;
    };
    if (!title.empty() && !cls.empty())
        if (const auto id = find(true, true); !id.empty())
            return id;
    if (!title.empty())
        if (const auto id = find(true, false); !id.empty())
            return id;
    if (!cls.empty())
        return find(false, true);
    return {};
}

bool safe_name(const std::string& name)
{
    return !name.empty() && name[0] != '.' && name.find_first_of("/\\") == std::string::npos &&
           name != "..";
}

void exact_keys(const Json& value, std::initializer_list<std::string_view> permitted,
                const std::string& field)
{
    if (!value.is_object())
        throw std::runtime_error(field + " must be an object.");
    for (const auto& [key, entry] : value.items()) {
        (void)entry;
        if (std::find(permitted.begin(), permitted.end(), key) == permitted.end())
            throw std::runtime_error(field + "." + key + " is not supported.");
    }
}

std::string required_string(const Json& value, const std::string& name)
{
    if (!value.is_string() ||
        value.get<std::string>().find_first_not_of(" \t\r\n") == std::string::npos)
        throw std::runtime_error(name + " is required.");
    return value.get<std::string>();
}

void public_id(const std::string& id, const std::string& path)
{
    static const std::regex pattern(R"(^[A-Za-z][A-Za-z0-9_-]*$)");
    if (!std::regex_match(id, pattern))
        throw std::runtime_error(path + " '" + id + "' is not a CLI-safe public identifier.");
}

void validate_binding_definition(const Json& binding, bool output)
{
    if (output)
        exact_keys(binding, {"nodeId", "nodeTitle", "classType"}, "output binding");
    else
        exact_keys(binding,
                   {"nodeId", "nodeTitle", "classType", "inputName", "selector", "resolvedNodeId"},
                   "input binding");
    bool locator = false;
    for (const auto* name : {"nodeId", "nodeTitle", "classType"}) {
        if (!binding.contains(name))
            continue;
        (void)required_string(binding.at(name), name);
        locator = true;
    }
    if (!output) {
        if (!binding.contains("inputName"))
            throw std::runtime_error("input binding inputName is required.");
        (void)required_string(binding.at("inputName"), "inputName");
        if (binding.contains("selector")) {
            exact_keys(
                binding.at("selector"),
                {"title", "classType", "inputName", "upstreamClassType", "downstreamClassType"},
                "selector");
            for (const auto& [key, value] : binding.at("selector").items())
                (void)required_string(value, "selector." + key);
            locator = true;
        }
        if (binding.contains("resolvedNodeId"))
            (void)required_string(binding.at("resolvedNodeId"), "resolvedNodeId");
    }
    if (!locator)
        throw std::runtime_error("Workflow binding requires node identity or selector metadata.");
}

void validate_current_manifest(const Json& m)
{
    exact_keys(m,
               {"schemaVersion", "id", "label", "provider", "classification", "description",
                "workflowFile", "contract", "requiredNodeClasses", "bindings", "outputBindings"},
               "manifest");
    if (!m.contains("schemaVersion") || !m.at("schemaVersion").is_number_integer() ||
        m.at("schemaVersion") != 1 || !m.contains("provider") ||
        required_string(m.at("provider"), "provider") != "comfyui")
        throw std::runtime_error("Workflow does not match the current ComfyUI manifest schema.");
    if (!m.contains("id") || !m.contains("label") || !m.contains("workflowFile"))
        throw std::runtime_error("Workflow id, label and workflowFile are required.");
    public_id(required_string(m.at("id"), "id"), "id");
    (void)required_string(m.at("label"), "label");
    if (!safe_name(required_string(m.at("workflowFile"), "workflowFile")))
        throw std::runtime_error("Workflow file must be a safe sibling of its manifest.");
    if (m.contains("description"))
        (void)required_string(m.at("description"), "description");
    if (m.contains("classification")) {
        static const std::regex classification(R"(^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$)");
        if (!std::regex_match(required_string(m.at("classification"), "classification"),
                              classification))
            throw std::runtime_error("Classification must be a dotted identifier.");
    }
    if (m.contains("requiredNodeClasses")) {
        if (!m.at("requiredNodeClasses").is_array())
            throw std::runtime_error("requiredNodeClasses must be an array.");
        for (const auto& name : m.at("requiredNodeClasses"))
            (void)required_string(name, "requiredNodeClasses entry");
    }
    if (!m.contains("contract") || !m.contains("bindings") || !m.contains("outputBindings"))
        throw std::runtime_error("Workflow public contract and bindings are required.");
    const auto& contract = m.at("contract");
    exact_keys(contract, {"inputs", "outputs"}, "contract");
    if (!contract.contains("inputs") || !contract.contains("outputs"))
        throw std::runtime_error("Workflow input and output contracts are required.");
    if (!contract.at("inputs").is_object() || !contract.at("outputs").is_object())
        throw std::runtime_error("Workflow input and output contracts must be objects.");
    // The property names of the two maps are public IDs, not schema field names.
    static const std::set<std::string> valid_types{"string", "integer", "number", "boolean",
                                                   "image"};
    for (const auto& [id, input] : contract.at("inputs").items()) {
        public_id(id, "contract input id");
        exact_keys(input, {"type", "required", "defaultValue", "authoring"}, "contract input");
        if (!input.contains("type") || !input.contains("required") ||
            !valid_types.contains(required_string(input.at("type"), "input.type")) ||
            !input.at("required").is_boolean())
            throw std::runtime_error("Workflow input type or required flag is invalid.");
        const auto type = input.at("type").get<std::string>();
        if (input.contains("defaultValue")) {
            const auto& value = input.at("defaultValue");
            if (((type == "string" || type == "image") && !value.is_string()) ||
                (type == "boolean" && !value.is_boolean()) ||
                (type == "integer" && !value.is_number_integer()) ||
                (type == "number" && !value.is_number()))
                throw std::runtime_error("Workflow input defaultValue has the wrong scalar type.");
        }
        if (input.contains("authoring")) {
            const auto& authoring = input.at("authoring");
            exact_keys(authoring, {"label", "description", "editorField"}, "authoring");
            for (const auto& [key, value] : authoring.items()) {
                const auto text = required_string(value, "authoring." + key);
                if (key == "editorField" &&
                    !std::set<std::string>{"textarea", "text", "integer", "number", "boolean",
                                           "imageAsset"}
                         .contains(text))
                    throw std::runtime_error("Workflow editorField is not supported.");
            }
        }
    }
    if (contract.at("outputs").empty())
        throw std::runtime_error("contract.outputs must declare at least one output.");
    static const std::regex media(R"(^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$)");
    for (const auto& [id, output] : contract.at("outputs").items()) {
        public_id(id, "contract output id");
        exact_keys(output, {"mediaType", "required", "cardinality"}, "contract output");
        if (!output.contains("mediaType") || !output.contains("required") ||
            !output.contains("cardinality") || !output.at("required").is_boolean() ||
            !std::regex_match(required_string(output.at("mediaType"), "mediaType"), media) ||
            (output.at("cardinality") != "one" && output.at("cardinality") != "many"))
            throw std::runtime_error("Workflow output contract is invalid.");
    }
    if (!m.at("bindings").is_object() || !m.at("outputBindings").is_object())
        throw std::runtime_error("Workflow bindings must be objects.");
    for (const auto& [key, bindings] : m.at("bindings").items()) {
        public_id(key, "binding public input id");
        if (!contract.at("inputs").contains(key) || !bindings.is_array() || bindings.empty())
            throw std::runtime_error("Workflow input binding is undeclared or empty.");
        for (const auto& binding : bindings)
            validate_binding_definition(binding, false);
    }
    for (const auto& [key, bindings] : m.at("outputBindings").items()) {
        public_id(key, "output binding public output id");
        if (!contract.at("outputs").contains(key) || !bindings.is_array() || bindings.empty())
            throw std::runtime_error("Workflow output binding is undeclared or empty.");
        for (const auto& binding : bindings)
            validate_binding_definition(binding, true);
    }
    for (const auto& [key, input] : contract.at("inputs").items()) {
        (void)input;
        if (!m.at("bindings").contains(key))
            throw std::runtime_error("Workflow input has no graph binding.");
    }
    for (const auto& [key, output] : contract.at("outputs").items()) {
        (void)output;
        if (!m.at("outputBindings").contains(key))
            throw std::runtime_error("Workflow output has no graph binding.");
    }
}

void validate_workflow(Workflow& entry)
{
    const auto& m = entry.manifest;
    validate_current_manifest(m);
    if (!entry.graph.is_object())
        throw std::runtime_error("Workflow graph must be an object.");
    entry.id = m.value("id", std::string{});
    entry.label = m.value("label", std::string{});
    if (!safe_name(entry.id) || entry.label.empty())
        throw std::runtime_error("Workflow id or label is invalid.");
    const auto& contract = m.at("contract");
    if (!contract.contains("inputs") || !contract.at("inputs").is_object() ||
        !contract.contains("outputs") || !contract.at("outputs").is_object())
        throw std::runtime_error("Workflow public contract is invalid.");
    entry.runnable = true;
    for (const auto& [id, definition] : contract.at("outputs").items()) {
        if (!definition.is_object() || !definition.contains("mediaType") ||
            !m.at("outputBindings").contains(id) || !m.at("outputBindings").at(id).is_array() ||
            m.at("outputBindings").at(id).empty())
            throw std::runtime_error("Workflow output bindings are invalid.");
        if (definition.value("mediaType", "") != "image") {
            entry.runnable = false;
            entry.diagnostics.push_back(workflow_diagnostic(
                "/contract/outputs/" + id + "/mediaType",
                "Output media type '" + definition.value("mediaType", "") +
                    "' is discoverable but not runnable by this NovelTea build.",
                "warning"));
        }
        for (const auto& binding : m.at("outputBindings").at(id))
            if (resolve_binding(entry.graph, binding, true).empty())
                entry.diagnostics.push_back(workflow_diagnostic(
                    "/workflows/" + entry.manifest_file + "/outputBindings/" + id,
                    "Workflow output bindings could not be resolved."));
    }
    for (const auto& [id, definition] : contract.at("inputs").items()) {
        (void)definition;
        if (!m.at("bindings").contains(id) || !m.at("bindings").at(id).is_array() ||
            m.at("bindings").at(id).empty())
            throw std::runtime_error("Workflow input bindings are invalid.");
        std::size_t index = 0;
        for (const auto& binding : m.at("bindings").at(id)) {
            if (resolve_binding(entry.graph, binding, false).empty())
                entry.diagnostics.push_back(
                    workflow_diagnostic("/workflows/" + entry.manifest_file + "/bindings/" + id +
                                            "/" + std::to_string(index),
                                        "Workflow graph binding could not be resolved."));
            ++index;
        }
    }
    entry.offline = "valid";
    for (const auto& diag : entry.diagnostics)
        if (diag.at("severity") == "error")
            entry.offline = "invalid";
        else if (entry.offline != "invalid")
            entry.offline = "warning";
}

Workflow load_workflow(const std::string& source, const std::string& filename,
                       const std::string& manifest_text,
                       const std::optional<std::string>& workflow_text)
{
    Workflow entry;
    entry.source = source;
    entry.manifest_file = filename;
    entry.key = source + ":" + filename;
    try {
        entry.manifest = Json::parse(manifest_text, nullptr, false);
        if (entry.manifest.is_discarded())
            throw std::runtime_error("ComfyUI workflow manifest is not valid JSON.");
        if (!entry.manifest.is_object() || !entry.manifest.contains("workflowFile") ||
            !entry.manifest.at("workflowFile").is_string() ||
            !safe_name(entry.manifest.at("workflowFile").get<std::string>()))
            throw std::runtime_error("Workflow file must be a safe sibling of its manifest.");
        if (!workflow_text)
            throw std::runtime_error(
                "ComfyUI workflow JSON is missing or exceeds the parsing limit.");
        entry.graph = Json::parse(*workflow_text, nullptr, false);
        if (entry.graph.is_discarded())
            throw std::runtime_error("ComfyUI workflow graph is not valid JSON.");
        validate_workflow(entry);
        entry.hash = package_hash(entry.manifest, entry.graph);
    } catch (const std::exception& error) {
        entry.offline = "invalid";
        // Diagnostic rows are still rendered in `workflows --all`. Keep a
        // discarded or scalar manifest out of subsequent object-only access.
        if (!entry.manifest.is_object())
            entry.manifest = Json::object();
        entry.diagnostics.push_back(workflow_diagnostic("/workflows/" + filename, error.what()));
    }
    return entry;
}

std::vector<Workflow> catalog(const fs::path& project, const Config& settings)
{
    std::vector<Workflow> entries;
    const auto server_identity = comfyui_server_identity(settings.server);
    std::map<std::string, std::string> embedded;
    for (const auto& file : embedded_comfyui::files)
        embedded.emplace(file.name, file.text);
    for (const auto& [name, text] : embedded) {
        if (!name.ends_with(".manifest.json"))
            continue;
        std::optional<std::string> workflow;
        try {
            const auto manifest = Json::parse(text, nullptr, false);
            if (manifest.is_object() && manifest.contains("workflowFile") &&
                manifest.at("workflowFile").is_string()) {
                const auto it = embedded.find(manifest.at("workflowFile").get<std::string>());
                if (it != embedded.end())
                    workflow = it->second;
            }
        } catch (...) {
        }
        entries.push_back(load_workflow("built-in", name, text, workflow));
    }
    for (const auto& [source, directory] : std::vector<std::pair<std::string, fs::path>>{
             {"user", user_root() / "comfyui" / "workflows"},
             {"project", project.empty() ? fs::path{} : project / "workflows"}}) {
        if (directory.empty())
            continue;
        std::error_code error;
        if (!fs::is_directory(directory, error))
            continue;
        std::vector<std::string> filenames;
        for (fs::directory_iterator it(directory, error), end; !error && it != end;
             it.increment(error)) {
            if (it->path().filename().extension() == ".json") {
                const auto filename = path_text(it->path().filename());
                if (filename.ends_with(".manifest.json"))
                    filenames.push_back(filename);
            }
        }
        std::sort(filenames.begin(), filenames.end());
        if (filenames.size() > 256)
            filenames.resize(256);
        for (const auto& filename : filenames) {
            const auto manifest = read_file(directory / fs::u8path(filename), 1024 * 1024);
            if (!manifest) {
                entries.push_back(load_workflow(source, filename, "{}", std::nullopt));
                continue;
            }
            std::optional<std::string> workflow;
            try {
                const auto data = Json::parse(*manifest, nullptr, false);
                if (data.is_object() && data.contains("workflowFile") &&
                    data.at("workflowFile").is_string()) {
                    const auto name = data.at("workflowFile").get<std::string>();
                    if (safe_name(name))
                        workflow = read_file(directory / fs::u8path(name), 32 * 1024 * 1024);
                }
            } catch (...) {
            }
            entries.push_back(load_workflow(source, filename, *manifest, workflow));
        }
    }
    std::map<std::string, std::vector<Workflow*>> by_id;
    for (auto& entry : entries)
        if (!entry.id.empty() && entry.offline != "invalid")
            by_id[entry.id].push_back(&entry);
    for (auto& [id, copies] : by_id) {
        std::stable_sort(copies.begin(), copies.end(), [](const auto* left, const auto* right) {
            return source_rank(left->source) > source_rank(right->source);
        });
        copies.front()->active = true;
        for (auto* copy : copies) {
            if (copy != copies.front()) {
                copy->overridden = true;
                copy->overridden_by = copies.front()->key;
            }
        }
    }
    const auto cache =
        read_file(user_root() / "comfyui" / "verification-cache.json", 8 * 1024 * 1024);
    if (cache) {
        try {
            const auto doc = Json::parse(*cache, nullptr, false);
            if (doc.is_object() && doc.contains("schema") &&
                doc.at("schema") == "noveltea.comfyui-workflow-verification-cache" &&
                doc.contains("records") && doc.at("records").is_array()) {
                for (auto& entry : entries) {
                    std::string latest;
                    for (const auto& record : doc.at("records")) {
                        if (!record.is_object() || !record.contains("serverIdentity") ||
                            record.at("serverIdentity") != server_identity ||
                            !record.contains("packageHash") ||
                            record.at("packageHash") != entry.hash ||
                            !record.contains("diagnostics") ||
                            !record.at("diagnostics").is_array() || !record.contains("checkedAt") ||
                            !record.at("checkedAt").is_string() ||
                            record.at("checkedAt").get<std::string>() < latest ||
                            !record.contains("status") ||
                            (record.at("status") != "verified" && record.at("status") != "failed"))
                            continue;
                        latest = record.at("checkedAt").get<std::string>();
                        entry.online =
                            record.at("status") == "verified" ? "previously-verified" : "failed";
                        entry.verification_diagnostics = record.at("diagnostics");
                    }
                }
            }
        } catch (...) {
        }
    }
    return entries;
}

Json active_summary(const Workflow& entry)
{
    return {{"id", entry.id},
            {"label", entry.label},
            {"source", entry.source},
            {"classification", entry.manifest.value("classification", Json(nullptr))},
            {"description", entry.manifest.value("description", Json(nullptr))},
            {"validationStatus", entry.offline},
            {"verificationStatus", entry.online},
            {"runnable", entry.runnable},
            {"packageHash", entry.hash}};
}

Json diagnostic_summary(const Workflow& entry)
{
    return {{"id", entry.id.empty() ? Json(nullptr) : Json(entry.id)},
            {"label", entry.label.empty() ? Json(nullptr) : Json(entry.label)},
            {"source", entry.source},
            {"workflowKey", entry.key},
            {"manifestFile", entry.manifest_file},
            {"classification", entry.manifest.value("classification", Json(nullptr))},
            {"validationStatus", entry.offline},
            {"verificationStatus", entry.online},
            {"runnable", entry.runnable},
            {"active", entry.active},
            {"overridden", entry.overridden},
            {"overriddenBy", entry.overridden ? Json(entry.overridden_by) : Json(nullptr)},
            {"packageHash", entry.hash.empty() ? Json(nullptr) : Json(entry.hash)},
            {"diagnostics", entry.diagnostics},
            {"verificationDiagnostics", entry.verification_diagnostics}};
}

Json inspect_summary(const Workflow& entry)
{
    return {{"id", entry.id},
            {"label", entry.label},
            {"provider", "comfyui"},
            {"source", entry.source},
            {"workflowKey", entry.key},
            {"packageHash", entry.hash},
            {"classification", entry.manifest.value("classification", Json(nullptr))},
            {"description", entry.manifest.value("description", Json(nullptr))},
            {"validationStatus", entry.offline},
            {"runnable", entry.runnable},
            {"verification",
             {{"status", entry.online}, {"diagnostics", entry.verification_diagnostics}}},
            {"inputs", entry.manifest.at("contract").at("inputs")},
            {"outputs", entry.manifest.at("contract").at("outputs")},
            {"requiredNodeClasses", entry.manifest.value("requiredNodeClasses", Json::array())}};
}

struct Parsed {
    std::optional<std::string> id;
    std::optional<std::string> server;
    bool all = false;
};

struct RunArgs {
    std::optional<std::string> id;
    std::optional<std::string> classification;
    std::optional<std::string> server;
    std::map<std::string, std::string> inputs;
    std::vector<std::string> output_routes;
    bool force = false;
};

RunArgs parse_run(const std::vector<std::string>& command)
{
    RunArgs parsed;
    for (std::size_t i = 2; i < command.size(); ++i) {
        const auto& arg = command[i];
        if (arg == "--force") {
            if (parsed.force)
                throw std::invalid_argument("Option '--force' may be supplied only once.");
            parsed.force = true;
        } else if (arg == "--input" || arg == "--output" || arg == "--type" || arg == "--server") {
            if (++i >= command.size() || command[i].starts_with("--"))
                throw std::invalid_argument("Option '" + arg + "' requires a value.");
            const auto value = command[i];
            if (arg == "--input") {
                const auto equals = value.find('=');
                if (equals == 0 || equals == std::string::npos)
                    throw std::invalid_argument("Option '--input' requires <name=value>.");
                if (!parsed.inputs.emplace(value.substr(0, equals), value.substr(equals + 1))
                         .second)
                    throw std::invalid_argument("Input was supplied more than once.");
            } else if (arg == "--output") {
                parsed.output_routes.push_back(value);
            } else if (arg == "--type") {
                if (parsed.classification)
                    throw std::invalid_argument("Option '--type' may be supplied only once.");
                static const std::regex classification(R"(^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$)");
                if (!std::regex_match(value, classification))
                    throw std::invalid_argument(
                        "Option '--type' requires a dotted classification.");
                parsed.classification = value;
            } else {
                if (parsed.server)
                    throw std::invalid_argument("Option '--server' may be supplied only once.");
                parsed.server = value;
            }
        } else if (arg.starts_with("--") || parsed.id) {
            throw std::invalid_argument(
                "Usage: noveltea comfyui run [<workflow-id> | --type <classification>] "
                "[--input <name=value>]... [--output <routing>]... [--server <url>] [--force].");
        } else {
            parsed.id = arg;
        }
    }
    if (parsed.id.has_value() == parsed.classification.has_value())
        throw std::invalid_argument(
            "'comfyui run' requires exactly one workflow id or '--type <classification>'.");
    if (parsed.force && parsed.output_routes.empty())
        throw std::invalid_argument(
            "Option '--force' is valid only with an explicit filesystem '--output'.");
    return parsed;
}

Parsed parse_command(const std::vector<std::string>& command)
{
    Parsed parsed;
    const auto& operation = command.at(1);
    for (std::size_t i = 2; i < command.size(); ++i) {
        const auto& arg = command[i];
        if (operation == "workflows" && arg == "--all") {
            if (parsed.all)
                throw std::invalid_argument("Option '--all' may be supplied only once.");
            parsed.all = true;
        } else if (operation != "workflows" && arg == "--server") {
            if (parsed.server)
                throw std::invalid_argument("Option '--server' may be supplied only once.");
            if (i + 1 >= command.size() || command[i + 1].starts_with("--"))
                throw std::invalid_argument("Option '--server' requires an HTTP(S) URL.");
            parsed.server = command[++i];
        } else if (arg.starts_with("--")) {
            throw std::invalid_argument("Unknown command option '" + arg + "'.");
        } else if (operation == "status" || parsed.id) {
            throw std::invalid_argument(
                operation == "status" ? "Usage: noveltea comfyui status [--server <url>]."
                : operation == "workflows"
                    ? "Usage: noveltea comfyui workflows [<id>] [--all]."
                    : "Usage: noveltea comfyui verify [<id>] [--server <url>].");
        } else {
            parsed.id = arg;
        }
    }
    if (parsed.all && parsed.id)
        throw std::invalid_argument("Option '--all' is only valid when listing workflows.");
    return parsed;
}

Json project_field(const fs::path& root)
{
    return root.empty() ? Json::object() : Json{{"projectRoot", path_text(root)}};
}

std::string find_version(const Json& value)
{
    if (!value.is_object())
        return {};
    for (const auto* key : {"comfyui_version", "comfyuiVersion", "version"})
        if (value.contains(key) && value.at(key).is_string() &&
            !value.at(key).get<std::string>().empty())
            return value.at(key).get<std::string>();
    for (const auto& item : value)
        if (const auto nested = find_version(item); !nested.empty())
            return nested;
    return {};
}

ComfyUiResult status(const Config& settings)
{
    const auto stats = comfyui_get_json(settings.server, "/system_stats", settings.timeout);
    const auto checked = now_iso();
    if (!stats.ok) {
        auto failed = semantic_failure("COMFYUI_SERVER_UNAVAILABLE", "/server",
                                       stats.timed_out ? "ComfyUI connection timed out."
                                                       : "ComfyUI connection check failed.",
                                       {{"serverUrl", settings.server}, {"checkedAt", checked}});
        failed.human += " Server: " + settings.server;
        return failed;
    }
    const auto queue = comfyui_get_json(settings.server, "/queue", settings.timeout);
    Json remaining = nullptr;
    if (queue.ok && queue.body.is_object()) {
        std::size_t count = 0;
        for (const auto* field : {"queue_running", "queue_pending"})
            if (queue.body.contains(field) && queue.body.at(field).is_array())
                count += queue.body.at(field).size();
        remaining = count;
    }
    auto version = find_version(stats.body);
    if (version.empty())
        version = "unknown";
    return result(true, 0,
                  {{"serverUrl", settings.server},
                   {"checkedAt", checked},
                   {"comfyUiVersion", version},
                   {"queueRemaining", remaining}},
                  Json::array(),
                  "ComfyUI ready at " + settings.server + "\nVersion: " + version +
                      "\nQueue: " + (remaining.is_null() ? "unknown" : remaining.dump()));
}

ComfyUiResult workflows(const Parsed& command, const fs::path& project,
                        const std::vector<Workflow>& entries)
{
    auto fields = project_field(project);
    if (command.id) {
        const auto it = std::find_if(entries.begin(), entries.end(), [&](const Workflow& entry) {
            return entry.active && entry.id == *command.id;
        });
        if (it == entries.end()) {
            fields["workflowId"] = *command.id;
            return semantic_failure("COMFYUI_WORKFLOW_NOT_FOUND", "/workflow",
                                    "ComfyUI workflow '" + *command.id +
                                        "' is not available in the effective catalog.",
                                    fields);
        }
        const auto inspected = inspect_summary(*it);
        fields["workflow"] = inspected;
        Json diagnostics = Json::array();
        for (const auto& issue : it->diagnostics)
            diagnostics.push_back(cli_diagnostic(
                issue.value("severity", "error") == "error" ? "COMFYUI_WORKFLOW_INVALID"
                                                            : "COMFYUI_WORKFLOW_DIAGNOSTIC",
                issue.value("path", ""), issue.value("message", ""),
                issue.value("severity", "error")));
        std::ostringstream human;
        human << it->id << " — " << it->label << "\nSource: " << it->source
              << "\nClassification: " << it->manifest.value("classification", "-")
              << "\nValidation: " << it->offline << "\nVerification: " << it->online
              << "\nRunnable: " << (it->runnable ? "yes" : "no");
        if (it->manifest.contains("description"))
            human << "\nDescription: " << it->manifest.at("description").get<std::string>();
        human << "\nInputs:";
        for (const auto& [id, input] : it->manifest.at("contract").at("inputs").items()) {
            human << "\n  " << id << ": " << input.value("type", "unknown") << ' '
                  << (input.value("required", false) ? "required" : "optional");
            if (input.contains("defaultValue"))
                human << " default=" << input.at("defaultValue").dump();
            if (input.contains("authoring") && input.at("authoring").is_object() &&
                input.at("authoring").contains("label"))
                human << " (" << input.at("authoring").at("label").get<std::string>() << ')';
        }
        human << "\nOutputs:";
        for (const auto& [id, output] : it->manifest.at("contract").at("outputs").items())
            human << "\n  " << id << ": " << output.value("mediaType", "") << ' '
                  << output.value("cardinality", "") << ' '
                  << (output.value("required", false) ? "required" : "optional");
        return result(true, 0, fields, diagnostics, human.str());
    }
    Json listing = Json::array(), diagnostics = Json::array();
    std::vector<const Workflow*> visible;
    for (const auto& entry : entries)
        if (command.all ? true : entry.active)
            visible.push_back(&entry);
    std::sort(visible.begin(), visible.end(), [&](const auto* left, const auto* right) {
        const auto a = left->id.empty() ? left->manifest_file : left->id;
        const auto b = right->id.empty() ? right->manifest_file : right->id;
        return a != b ? a < b
               : source_rank(left->source) != source_rank(right->source)
                   ? source_rank(left->source) > source_rank(right->source)
                   : left->manifest_file < right->manifest_file;
    });
    std::ostringstream human;
    for (const auto* entry : visible) {
        listing.push_back(command.all ? diagnostic_summary(*entry) : active_summary(*entry));
        if (human.tellp() > 0)
            human << '\n';
        if (command.all) {
            human << (entry->id.empty() ? entry->manifest_file : entry->id) << '\t' << entry->source
                  << '\t' << entry->offline << '\t'
                  << (entry->active       ? "active"
                      : entry->overridden ? "overridden by " + entry->overridden_by
                                          : "inactive");
            for (const auto& issue : entry->diagnostics)
                diagnostics.push_back(cli_diagnostic(
                    issue.value("severity", "error") == "error" ? "COMFYUI_WORKFLOW_INVALID"
                                                                : "COMFYUI_WORKFLOW_DIAGNOSTIC",
                    issue.value("path", ""), issue.value("message", ""),
                    issue.value("severity", "error")));
        } else {
            human << entry->id << '\t' << entry->source << '\t'
                  << entry->manifest.value("classification", "-") << '\t' << entry->offline << '\t'
                  << entry->label;
        }
    }
    fields["workflows"] = listing;
    const auto message = human.str().empty() ? command.all ? "No ComfyUI workflow packages found."
                                                           : "No ComfyUI workflows found."
                                             : human.str();
    return result(true, 0, fields, diagnostics, message);
}

Json compatibility(const Workflow& entry, const Json& object_info)
{
    Json issues = Json::array();
    if (!object_info.is_object()) {
        issues.push_back(workflow_diagnostic(
            "/object_info",
            "ComfyUI object_info was unavailable; workflow could not be verified."));
        return issues;
    }
    for (const auto& cls : entry.manifest.value("requiredNodeClasses", Json::array())) {
        if (cls.is_string() && !object_info.contains(cls.get<std::string>()))
            issues.push_back(workflow_diagnostic(
                "/object_info", "Current ComfyUI server is missing required node class " +
                                    cls.get<std::string>() + "."));
    }
    for (const auto& [id, bindings] : entry.manifest.at("bindings").items()) {
        std::size_t i = 0;
        for (const auto& binding : bindings) {
            const auto node_id = resolve_binding(entry.graph, binding, false);
            if (!node_id.empty()) {
                const auto& node = entry.graph.at(node_id);
                const auto cls = node.is_object() && node.contains("class_type") &&
                                         node.at("class_type").is_string()
                                     ? node.at("class_type").get<std::string>()
                                     : std::string{};
                if (object_info.contains(cls) && object_info.at(cls).is_object()) {
                    const auto& info = object_info.at(cls);
                    const auto& input = binding.at("inputName").get_ref<const std::string&>();
                    bool found = false;
                    bool has_groups = info.contains("input") && info.at("input").is_object();
                    if (has_groups) {
                        for (const auto* group : {"required", "optional", "hidden"})
                            if (info.at("input").contains(group) &&
                                info.at("input").at(group).is_object() &&
                                info.at("input").at(group).contains(input))
                                found = true;
                    }
                    if (!found)
                        issues.push_back(workflow_diagnostic(
                            "/bindings/" + id + "/" + std::to_string(i),
                            has_groups ? "ComfyUI node class " + cls +
                                             " is missing mapped input '" + input + "'."
                                       : "ComfyUI node class " + cls +
                                             " does not describe mapped input '" + input + "'."));
                }
            }
            ++i;
        }
    }
    return issues;
}

ComfyUiResult verify(const Parsed& command, const fs::path& project, const Config& settings,
                     const std::vector<Workflow>& entries)
{
    const auto checked = now_iso();
    const auto server_identity = comfyui_server_identity(settings.server);
    Json fields = project_field(project);
    fields["serverUrl"] = settings.server;
    fields["checkedAt"] = checked;
    fields["workflowId"] = command.id ? Json(*command.id) : Json(nullptr);
    fields["verified"] = Json::array();
    fields["failed"] = Json::array();
    fields["skipped"] = Json::array();
    if (command.id && std::none_of(entries.begin(), entries.end(), [&](const Workflow& entry) {
            return entry.active && entry.id == *command.id;
        }))
        return semantic_failure("COMFYUI_VERIFICATION_FAILED", "/workflowId",
                                "Active ComfyUI workflow '" + *command.id +
                                    "' was not found in the current catalog.",
                                fields);
    const auto stats = comfyui_get_json(settings.server, "/system_stats", settings.timeout);
    const auto remote = comfyui_get_json(settings.server, "/object_info", settings.timeout);
    const auto version = stats.ok ? find_version(stats.body) : "";
    const auto server_version = version.empty() ? "unknown" : version;
    Json diagnostics = Json::array(), new_records = Json::array();
    if (!remote.ok || !remote.body.is_object())
        diagnostics.push_back(cli_diagnostic(
            "COMFYUI_VERIFICATION_FAILED", "/object_info",
            "ComfyUI object_info was unavailable; workflows could not be verified."));
    for (const auto& entry : entries) {
        if (!entry.active || (command.id && entry.id != *command.id))
            continue;
        if (entry.offline == "invalid" || entry.hash.empty() || !entry.graph.is_object()) {
            fields["skipped"].push_back(entry.key);
            continue;
        }
        const auto problems = compatibility(entry, remote.ok ? remote.body : Json(nullptr));
        const bool passed = problems.empty();
        Json record{{"workflowKey", entry.key},
                    {"id", entry.id},
                    {"serverIdentity", server_identity},
                    {"packageHash", entry.hash},
                    {"comfyUiVersion", server_version},
                    {"status", passed ? "verified" : "failed"},
                    {"checkedAt", checked},
                    {"diagnostics", problems}};
        fields[passed ? "verified" : "failed"].push_back(record);
        if (remote.ok)
            new_records.push_back(record);
        if (!passed)
            for (const auto& problem : problems)
                diagnostics.push_back(cli_diagnostic("COMFYUI_VERIFICATION_FAILED",
                                                     problem.value("path", ""),
                                                     problem.value("message", "")));
    }
    if (remote.ok) {
        const auto destination = user_root() / "comfyui" / "verification-cache.json";
        Json old = Json::array();
        if (const auto text = read_file(destination, 8 * 1024 * 1024)) {
            try {
                const auto parsed = Json::parse(*text, nullptr, false);
                if (parsed.is_object() && parsed.contains("schema") &&
                    parsed.at("schema") == "noveltea.comfyui-workflow-verification-cache" &&
                    parsed.contains("records") && parsed.at("records").is_array())
                    old = parsed.at("records");
            } catch (...) {
            }
        }
        for (const auto& record : new_records) {
            Json merged = Json::array();
            for (const auto& item : old)
                if (!(item.is_object() && item.contains("serverIdentity") &&
                      item.at("serverIdentity") == server_identity &&
                      item.contains("packageHash") &&
                      item.at("packageHash") == record.at("packageHash") &&
                      item.contains("comfyUiVersion") &&
                      item.at("comfyUiVersion") == server_version))
                    merged.push_back(item);
            merged.push_back(record);
            old = std::move(merged);
        }
        std::error_code error;
        fs::create_directories(destination.parent_path(), error);
        if (!error) {
            auto temporary = destination;
            temporary += ".tmp-" + std::to_string(
                                       std::chrono::steady_clock::now().time_since_epoch().count());
            {
                std::ofstream output(temporary, std::ios::binary | std::ios::trunc);
                output << Json{{"schema", "noveltea.comfyui-workflow-verification-cache"},
                               {"records", old}}
                              .dump(2)
                       << '\n';
                output.flush();
                if (!output)
                    error = std::make_error_code(std::errc::io_error);
            }
            if (!error) {
#if defined(_WIN32)
                if (!MoveFileExW(temporary.c_str(), destination.c_str(),
                                 MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH))
                    error =
                        std::error_code(static_cast<int>(GetLastError()), std::system_category());
#else
                fs::rename(temporary, destination, error);
#endif
            }
            if (error)
                fs::remove(temporary);
        }
    }
    const bool success = diagnostics.empty();
    if (!success)
        return result(false, 4, fields, diagnostics,
                      diagnostics.front().at("message").get<std::string>());
    std::ostringstream human;
    human << "ComfyUI verification succeeded at " << settings.server << '.';
    if (!fields.at("verified").empty()) {
        human << "\nVerified: ";
        bool first = true;
        for (const auto& record : fields.at("verified")) {
            if (!first)
                human << ", ";
            human << record.at("id").get<std::string>();
            first = false;
        }
    }
    if (!fields.at("skipped").empty()) {
        human << "\nSkipped: ";
        bool first = true;
        for (const auto& id : fields.at("skipped")) {
            if (!first)
                human << ", ";
            human << id.get<std::string>();
            first = false;
        }
    }
    return result(true, 0, fields, diagnostics, human.str());
}

struct RunError : std::runtime_error {
    std::string code;
    std::string path;
    bool interrupted = false;
    RunError(std::string c, std::string p, std::string m, bool was_interrupted = false)
        : std::runtime_error(m), code(std::move(c)), path(std::move(p)),
          interrupted(was_interrupted)
    {
    }
};

std::string nonce()
{
    std::random_device random;
    std::array<unsigned char, 16> bytes{};
    for (auto& byte : bytes)
        byte = static_cast<unsigned char>(random());
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // UUID v4
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    std::ostringstream output;
    for (std::size_t i = 0; i < bytes.size(); ++i) {
        if (i == 4 || i == 6 || i == 8 || i == 10)
            output << '-';
        output << std::hex << std::setfill('0') << std::setw(2) << static_cast<unsigned>(bytes[i]);
    }
    return output.str();
}

std::string percent_encode(std::string_view value)
{
    static constexpr char hex[] = "0123456789ABCDEF";
    std::string result;
    for (unsigned char ch : value) {
        if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') ||
            ch == '-' || ch == '_' || ch == '.' || ch == '~')
            result.push_back(static_cast<char>(ch));
        else {
            result.push_back('%');
            result.push_back(hex[ch >> 4]);
            result.push_back(hex[ch & 15]);
        }
    }
    return result;
}

Json required_response(const Config& settings, std::string endpoint, std::string method = "GET",
                       std::string body = {})
{
    const auto response =
        comfyui_request(settings.server, endpoint, settings.timeout, method, body);
    if (!response.ok)
        throw RunError(
            response.timed_out ? "COMFYUI_REQUEST_TIMEOUT" : "COMFYUI_SERVER_UNAVAILABLE",
            "/server",
            response.timed_out ? "ComfyUI request timed out." : "ComfyUI request failed.");
    const auto parsed = Json::parse(response.bytes, nullptr, false);
    if (parsed.is_discarded())
        throw RunError("COMFYUI_INVALID_RESPONSE", "/server", "ComfyUI returned invalid JSON.");
    return parsed;
}

Json coerce_input(const std::string& id, const std::string& type, const std::string& supplied)
{
    if (type == "string")
        return supplied;
    if (type == "boolean") {
        if (supplied == "true")
            return true;
        if (supplied == "false")
            return false;
    } else {
        double number = 0;
        const auto [end, error] =
            std::from_chars(supplied.data(), supplied.data() + supplied.size(), number);
        if (error == std::errc{} && end == supplied.data() + supplied.size() &&
            std::isfinite(number)) {
            if (type == "number")
                return number;
            if (type == "integer" && std::trunc(number) == number &&
                number >= -9007199254740991.0 && number <= 9007199254740991.0)
                return static_cast<std::int64_t>(number);
        }
    }
    throw RunError("COMFYUI_INPUT_TYPE", "/inputs/" + id,
                   "Input '" + id + "' must be a " + type + ".");
}

void bind_input(Json& graph, const Json& bindings, const Json& value)
{
    for (const auto& binding : bindings) {
        const auto node_id = resolve_binding(graph, binding, false);
        const auto selector = binding.value("selector", Json::object());
        const auto input_name = selector.is_object()
                                    ? selector.value("inputName", binding.value("inputName", ""))
                                    : binding.value("inputName", "");
        if (node_id.empty() || !graph[node_id].contains("inputs") ||
            !graph[node_id]["inputs"].contains(input_name))
            throw RunError("COMFYUI_BINDING_INVALID", "/workflow",
                           "A workflow input binding no longer resolves.");
        graph[node_id]["inputs"][input_name] = value;
    }
}

std::uint32_t be32(std::string_view bytes, std::size_t at)
{
    return (static_cast<std::uint32_t>(static_cast<unsigned char>(bytes[at])) << 24) |
           (static_cast<std::uint32_t>(static_cast<unsigned char>(bytes[at + 1])) << 16) |
           (static_cast<std::uint32_t>(static_cast<unsigned char>(bytes[at + 2])) << 8) |
           static_cast<unsigned char>(bytes[at + 3]);
}

struct ImageInfo {
    std::string format;
    std::string mime;
    unsigned width = 0;
    unsigned height = 0;
    bool alpha = false;
};

ImageInfo image_info(std::string_view bytes)
{
    const auto b = [&](std::size_t i) { return static_cast<unsigned char>(bytes[i]); };
    if (bytes.size() >= 33 && bytes.substr(0, 8) == "\x89PNG\r\n\x1a\n" && be32(bytes, 8) == 13 &&
        bytes.substr(12, 4) == "IHDR") {
        bool data = false, end = false, transparent = false;
        for (std::size_t pos = 8; pos + 12 <= bytes.size();) {
            const auto count = be32(bytes, pos);
            if (count > bytes.size() - pos - 12)
                break;
            const auto chunk = bytes.substr(pos + 4, 4);
            data |= chunk == "IDAT";
            transparent |= chunk == "tRNS";
            if (chunk == "IEND" && count == 0) {
                end = true;
                break;
            }
            pos += count + 12;
        }
        if (data && end && be32(bytes, 16) && be32(bytes, 20))
            return {"png", "image/png", be32(bytes, 16), be32(bytes, 20),
                    b(25) == 4 || b(25) == 6 || transparent};
    }
    if (bytes.size() >= 10 && (bytes.substr(0, 6) == "GIF89a" || bytes.substr(0, 6) == "GIF87a")) {
        const auto w = b(6) | b(7) << 8, h = b(8) | b(9) << 8;
        bool alpha = false;
        for (std::size_t i = 13; i + 3 < bytes.size(); ++i)
            alpha |= b(i) == 0x21 && b(i + 1) == 0xf9 && b(i + 2) == 4 && (b(i + 3) & 1) != 0;
        if (w && h)
            return {"gif", "image/gif", static_cast<unsigned>(w), static_cast<unsigned>(h), alpha};
    }
    if (bytes.size() >= 30 && bytes.substr(0, 4) == "RIFF" && bytes.substr(8, 4) == "WEBP") {
        const auto chunk = bytes.substr(12, 4);
        if (chunk == "VP8X")
            return {"webp", "image/webp", 1u + b(24) + (b(25) << 8) + (b(26) << 16),
                    1u + b(27) + (b(28) << 8) + (b(29) << 16), (b(20) & 0x10) != 0};
        if (chunk == "VP8L" && b(20) == 0x2f) {
            const auto packed = static_cast<std::uint32_t>(b(21)) |
                                (static_cast<std::uint32_t>(b(22)) << 8) |
                                (static_cast<std::uint32_t>(b(23)) << 16) |
                                (static_cast<std::uint32_t>(b(24)) << 24);
            return {"webp", "image/webp", (packed & 0x3fff) + 1, ((packed >> 14) & 0x3fff) + 1,
                    ((packed >> 28) & 1) != 0};
        }
        if (chunk == "VP8 " && b(23) == 0x9d && b(24) == 1 && b(25) == 0x2a)
            return {"webp", "image/webp", static_cast<unsigned>((b(26) | b(27) << 8) & 0x3fff),
                    static_cast<unsigned>((b(28) | b(29) << 8) & 0x3fff), false};
    }
    if (bytes.size() >= 4 && b(0) == 0xff && b(1) == 0xd8) {
        for (std::size_t pos = 2; pos + 9 < bytes.size();) {
            if (b(pos) != 0xff) {
                ++pos;
                continue;
            }
            const auto marker = b(pos + 1);
            if (marker == 0xd9 || marker == 0xda)
                break;
            const auto len = (b(pos + 2) << 8) | b(pos + 3);
            if (len < 2 || len > bytes.size() - pos - 2)
                break;
            if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) ||
                (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf))
                return {"jpeg", "image/jpeg", static_cast<unsigned>(b(pos + 7) << 8 | b(pos + 8)),
                        static_cast<unsigned>(b(pos + 5) << 8 | b(pos + 6)), false};
            pos += 2 + len;
        }
    }
    throw RunError("COMFYUI_OUTPUT_INVALID", "/outputs",
                   "ComfyUI returned an invalid or unsupported image.");
}

void check_interruption(const std::string& prompt, const ComfyUiExecutionHooks& hooks);
volatile std::sig_atomic_t interruption_requested = 0;
void signal_interruption(int) { interruption_requested = 1; }

struct InterruptScope {
    using Handler = void (*)(int);
    Handler previous = std::signal(SIGINT, signal_interruption);
    InterruptScope() { interruption_requested = 0; }
    ~InterruptScope() { std::signal(SIGINT, previous); }
};

void check_interruption(const std::string& prompt, const ComfyUiExecutionHooks& hooks)
{
    if (interruption_requested || (hooks.cancelled && hooks.cancelled()))
        throw RunError("COMFYUI_INTERRUPTED", "/prompt",
                       "ComfyUI prompt '" + prompt + "' was interrupted.", true);
}

struct PreparedImage {
    std::string id;
    fs::path path;
    std::string bytes;
    std::string hash;
    ImageInfo info;
};

std::string upload_image(const Config& settings, const PreparedImage& input)
{
    // Uploading local files to arbitrary servers is a disclosure boundary.
    static const std::regex loopback(
        R"(^http://(127(?:\.(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[0-9]{1,2})){3}|\[::1\]|\[0:0:0:0:0:0:0:1\])(?::[0-9]{1,5})?(?:/.*)?$)",
        std::regex::icase);
    if (!std::regex_match(settings.server, loopback))
        throw RunError("COMFYUI_UPLOAD_TARGET_DENIED", "/server",
                       "Local image upload is allowed only to a literal loopback HTTP address.");
    const auto extension = input.info.format == "jpeg" ? ".jpg" : "." + input.info.format;
    const auto boundary = "----noveltea-" + nonce();
    const auto remote = "noveltea-" + nonce() + extension;
    const auto payload = "--" + boundary +
                         "\r\nContent-Disposition: form-data; name=\"image\"; filename=\"" +
                         remote + "\"\r\nContent-Type: " + input.info.mime + "\r\n\r\n" +
                         input.bytes + "\r\n--" + boundary +
                         "\r\nContent-Disposition: form-data; name=\"overwrite\"\r\n\r\n"
                         "false\r\n--" +
                         boundary + "--\r\n";
    const auto response =
        comfyui_request(settings.server, "/upload/image", settings.timeout, "POST", payload,
                        "multipart/form-data; boundary=" + boundary);
    if (!response.ok)
        throw RunError("COMFYUI_UPLOAD_FAILED", "/inputs/" + input.id,
                       "ComfyUI image upload failed.");
    const auto parsed = Json::parse(response.bytes, nullptr, false);
    if (!parsed.is_object() || !parsed.contains("name") || !parsed.at("name").is_string() ||
        parsed.at("name").get<std::string>() != remote)
        throw RunError("COMFYUI_UPLOAD_FAILED", "/inputs/" + input.id,
                       "ComfyUI image upload returned an invalid remote filename.");
    if (parsed.contains("subfolder") && !parsed.at("subfolder").is_string())
        throw RunError("COMFYUI_UPLOAD_FAILED", "/inputs/" + input.id,
                       "ComfyUI image upload returned an invalid subfolder.");
    const auto subfolder = parsed.value("subfolder", std::string{});
    return subfolder.empty() ? remote : subfolder + "/" + remote;
}

struct Generated {
    std::string output_id;
    std::string bytes;
    Json metadata;
};

struct StagedFile {
    fs::path target;
    fs::path temporary;
    fs::path backup;
    bool installed = false;
    bool backed_up = false;
};

struct Publication {
    std::vector<StagedFile> files;
    std::vector<fs::path> extra_staged;
    fs::path staging;
    bool finalized = false;
    ~Publication()
    {
        if (!finalized) {
            for (auto it = files.rbegin(); it != files.rend(); ++it) {
                std::error_code error;
                if (it->installed)
                    fs::remove(it->target, error);
                if (it->backed_up)
                    fs::rename(it->backup, it->target, error);
                fs::remove(it->temporary, error);
            }
        } else {
            for (const auto& file : files) {
                std::error_code error;
                fs::remove(file.backup, error);
            }
        }
        std::error_code error;
        if (!staging.empty())
            fs::remove_all(staging, error);
        for (const auto& path : extra_staged)
            fs::remove(path, error);
    }
    void commit_files(bool force)
    {
        for (auto& item : files) {
            std::error_code error;
            const auto status = fs::symlink_status(item.target, error);
            const bool exists = !error && status.type() != fs::file_type::not_found;
            if (exists && (!force || !fs::is_regular_file(status) || fs::is_symlink(status)))
                throw RunError("COMFYUI_OUTPUT_EXISTS", "/outputs",
                               "Filesystem destination changed before publication.");
            if (exists) {
                fs::rename(item.target, item.backup);
                item.backed_up = true;
            }
            fs::rename(item.temporary, item.target);
            item.installed = true;
        }
    }
};

std::string extension(const Json& metadata)
{
    const auto format = metadata.at("format").get<std::string>();
    return format == "jpeg" ? ".jpg" : "." + format;
}

std::map<std::string, fs::path> resolve_routes(const RunArgs& args, const Workflow& workflow)
{
    const auto& outputs = workflow.manifest.at("contract").at("outputs");
    std::map<std::string, fs::path> routes;
    for (const auto& option : args.output_routes) {
        const auto equals = option.find('=');
        std::string id;
        std::string path;
        if (equals != std::string::npos && outputs.contains(option.substr(0, equals))) {
            id = option.substr(0, equals);
            path = option.substr(equals + 1);
        } else {
            if (outputs.size() != 1)
                throw std::invalid_argument(
                    "Bare --output <path> requires exactly one declared output.");
            id = outputs.begin().key();
            path = option;
        }
        if (path.empty() || !outputs.contains(id))
            throw std::invalid_argument("Unknown or empty ComfyUI filesystem output route.");
        if (!routes.emplace(id, fs::absolute(fs::u8path(path)).lexically_normal()).second)
            throw std::invalid_argument("ComfyUI output was routed more than once.");
    }
    return routes;
}

void stage_file(Publication& transaction, const fs::path& destination, const std::string& bytes,
                bool force, const ComfyUiExecutionHooks& hooks)
{
    auto parent = destination.parent_path();
    if (destination.empty() || !fs::is_directory(parent) || fs::is_symlink(parent))
        throw RunError("COMFYUI_OUTPUT_DESTINATION_INVALID", "/outputs",
                       "Filesystem output parent must be an existing directory.");
    std::error_code error;
    const auto status = fs::symlink_status(destination, error);
    const bool exists = !error && status.type() != fs::file_type::not_found;
    if (exists && (!force || !fs::is_regular_file(status) || fs::is_symlink(status)))
        throw RunError("COMFYUI_OUTPUT_EXISTS", "/outputs",
                       "Filesystem output already exists or is not a regular file.");
    for (const auto& file : transaction.files)
        if (file.target == destination)
            throw RunError("COMFYUI_OUTPUT_DESTINATION_CONFLICT", "/outputs",
                           "Two outputs share the same filesystem destination.");
    auto temporary =
        parent / ("." + path_text(destination.filename()) + "." + nonce() + ".noveltea-stage");
    auto backup =
        parent / ("." + path_text(destination.filename()) + "." + nonce() + ".noveltea-backup");
    if (hooks.register_staged_output)
        hooks.register_staged_output(temporary);
    transaction.files.push_back({destination, temporary, backup});
    {
        std::ofstream out(temporary, std::ios::binary | std::ios::trunc);
        if (!out || !out.write(bytes.data(), static_cast<std::streamsize>(bytes.size())))
            throw RunError("COMFYUI_PUBLICATION_FAILED", "/outputs",
                           "Could not stage generated filesystem output.");
    }
}

ComfyUiResult run_workflow(const RunArgs& arguments, const Config& settings,
                           const fs::path& project, const std::vector<Workflow>& entries,
                           const std::function<Json(const Json&)>& project_request, bool json_mode,
                           const ComfyUiExecutionHooks& hooks)
{
    Json fields = project_field(project);
    fields["serverUrl"] = settings.server;
    auto id = arguments.id.value_or(std::string{});
    if (arguments.classification) {
        const auto selected = settings.defaults.find(*arguments.classification);
        if (selected == settings.defaults.end())
            return semantic_failure("COMFYUI_DEFAULT_WORKFLOW_MISSING", "/classification",
                                    "No default workflow is configured for classification '" +
                                        *arguments.classification + "'.",
                                    fields);
        id = selected->second;
    }
    const auto found = std::find_if(entries.begin(), entries.end(), [&](const Workflow& entry) {
        return entry.active && entry.id == id;
    });
    if (found == entries.end())
        return semantic_failure("COMFYUI_WORKFLOW_NOT_FOUND", "/workflow",
                                "ComfyUI workflow '" + id + "' is not available.", fields);
    const auto& entry = *found;
    fields["workflow"] = {{"id", entry.id},
                          {"source", entry.source},
                          {"workflowKey", entry.key},
                          {"packageHash", entry.hash}};
    if (!entry.runnable || entry.offline != "valid")
        return semantic_failure("COMFYUI_WORKFLOW_NOT_RUNNABLE", "/workflow",
                                "ComfyUI workflow '" + id + "' is not runnable.", fields);
    if (arguments.classification &&
        entry.manifest.value("classification", "") != *arguments.classification)
        return semantic_failure("COMFYUI_WORKFLOW_CLASSIFICATION_MISMATCH", "/classification",
                                "Configured workflow has a different classification.", fields);

    try {
        if ((hooks.commit_staged_project_assets || hooks.publish_staged_files) &&
            !hooks.register_staged_output)
            throw RunError("COMFYUI_PUBLICATION_FAILED", "/outputs",
                           "Broker publication requires staged-output registration.");
        InterruptScope interruption;
        const auto& inputs = entry.manifest.at("contract").at("inputs");
        const auto& outputs = entry.manifest.at("contract").at("outputs");
        const auto routes = resolve_routes(arguments, entry);
        for (const auto& [id, supplied] : arguments.inputs)
            if (!inputs.contains(id))
                throw RunError("COMFYUI_INPUT_UNKNOWN", "/inputs/" + id,
                               "Unknown workflow input '" + id + "'.");
        for (const auto& [id, contract] : outputs.items()) {
            if (contract.value("mediaType", "") != "image")
                throw RunError("COMFYUI_OUTPUT_UNSUPPORTED", "/outputs/" + id,
                               "Only image outputs are supported by the native CLI.");
            if (project.empty() && !routes.contains(id))
                throw RunError("COMFYUI_OUTPUT_ROUTE_REQUIRED", "/outputs/" + id,
                               "A Projectless run requires an explicit filesystem route.");
            if (routes.contains(id)) {
                const auto& target = routes.at(id);
                const auto parent =
                    contract.value("cardinality", "") == "one" ? target.parent_path() : target;
                if (!fs::is_directory(parent))
                    throw RunError("COMFYUI_OUTPUT_DESTINATION_INVALID", "/outputs/" + id,
                                   "Filesystem output parent does not exist.");
                if (contract.value("cardinality", "") == "one") {
                    const auto ext = target.extension().string();
                    if (ext != ".png" && ext != ".jpg" && ext != ".jpeg" && ext != ".webp" &&
                        ext != ".gif")
                        throw RunError(
                            "COMFYUI_OUTPUT_EXTENSION", "/outputs/" + id,
                            "Filesystem image destination has an unsupported extension.");
                    if (fs::exists(target) && !arguments.force)
                        throw RunError("COMFYUI_OUTPUT_EXISTS", "/outputs/" + id,
                                       "Filesystem destination already exists.");
                }
            }
        }
        auto workflow = entry.graph;
        std::vector<PreparedImage> image_inputs;
        for (const auto& [id, input] : inputs.items()) {
            const auto supplied = arguments.inputs.find(id);
            if (supplied == arguments.inputs.end() && !input.contains("defaultValue")) {
                if (input.value("required", false))
                    throw RunError("COMFYUI_INPUT_REQUIRED", "/inputs/" + id,
                                   "Required workflow input '" + id + "' was not supplied.");
                continue;
            }
            const auto type = input.at("type").get<std::string>();
            const auto value = supplied != arguments.inputs.end()
                                   ? (type == "image" ? Json(supplied->second)
                                                      : coerce_input(id, type, supplied->second))
                                   : input.at("defaultValue");
            if (type == "image") {
                const auto source = fs::absolute(fs::u8path(value.get<std::string>()));
                const auto bytes = read_file(source, 32 * 1024 * 1024);
                if (!bytes || bytes->empty())
                    throw RunError("COMFYUI_INPUT_IMAGE_INVALID", "/inputs/" + id,
                                   "Image input is not a readable image file.");
                const auto info = image_info(*bytes);
                const auto hash = "sha256:" + core::sha256_hex(std::as_bytes(std::span(*bytes)));
                image_inputs.push_back({id, source, *bytes, hash, info});
            } else {
                for (const auto& binding : entry.manifest.at("bindings").at(id))
                    bind_input(workflow, Json::array({binding}), value);
            }
        }
        std::string generation;
        if (!project.empty()) {
            const auto admission = project_request(
                {{"action", "project-validate"}, {"projectRoot", path_text(project)}});
            if (!admission.value("ok", false) || !admission.value("valid", false) ||
                !admission.contains("sourceGeneration") ||
                !admission.at("sourceGeneration").is_string())
                throw RunError("COMFYUI_ASSET_PUBLICATION_PROJECT_INVALID", "/project",
                               "Native Project validation or revision admission failed.");
            generation = admission.at("sourceGeneration").get<std::string>();
        }
        const auto proof = [&]() {
            if (!project.empty() && !project_request({{"action", "source-generation-proof"},
                                                      {"projectRoot", path_text(project)},
                                                      {"expectedSourceGeneration", generation}})
                                         .value("ok", false))
                throw RunError("COMFYUI_ASSET_PUBLICATION_CONFLICT", "/project",
                               "Project source revision changed during ComfyUI execution.");
            for (const auto& input : image_inputs) {
                const auto actual = read_file(input.path, 32 * 1024 * 1024);
                if (!actual ||
                    "sha256:" + core::sha256_hex(std::as_bytes(std::span(*actual))) != input.hash)
                    throw RunError("COMFYUI_INPUT_SOURCE_CHANGED", "/inputs/" + input.id,
                                   "Image input changed during ComfyUI execution.");
            }
        };
        proof();
        const auto remote = comfyui_get_json(settings.server, "/object_info", settings.timeout);
        const auto problems = compatibility(entry, remote.ok ? remote.body : Json(nullptr));
        if (!problems.empty())
            throw RunError("COMFYUI_VERIFICATION_FAILED", "/workflow",
                           problems.front().value("message", "ComfyUI workflow is incompatible."));
        for (const auto& input : image_inputs)
            bind_input(workflow, entry.manifest.at("bindings").at(input.id),
                       upload_image(settings, input));
        proof();
        check_interruption("unsubmitted", hooks);

        const auto client_id = nonce(), requested_prompt = nonce();
        Json submitted;
        try {
            submitted = required_response(settings, "/prompt", "POST",
                                          Json{{"prompt", workflow},
                                               {"prompt_id", requested_prompt},
                                               {"client_id", client_id}}
                                              .dump());
        } catch (const RunError&) {
            if (interruption_requested || (hooks.cancelled && hooks.cancelled())) {
                (void)comfyui_request(settings.server, "/queue", settings.timeout, "POST",
                                      Json{{"delete", Json::array({requested_prompt})}}.dump());
                check_interruption(requested_prompt, hooks);
            }
            throw;
        }
        if (!submitted.is_object() || !submitted.contains("prompt_id") ||
            !submitted.at("prompt_id").is_string() ||
            submitted.at("prompt_id").get<std::string>().empty())
            throw RunError("COMFYUI_PROMPT_REJECTED", "/prompt",
                           "ComfyUI did not return a prompt id.");
        const auto prompt = submitted.at("prompt_id").get<std::string>();
        fields["promptId"] = prompt;
        fields["clientId"] = client_id;
        if (hooks.progress)
            hooks.progress("queued", prompt);
        if (!json_mode)
            std::cerr << "Queued ComfyUI prompt " << prompt << ".\n";
        try {
            Json history;
            for (;;) {
                check_interruption(prompt, hooks);
                history = required_response(settings, "/history/" + percent_encode(prompt));
                if (history.is_object() && history.contains(prompt) &&
                    history.at(prompt).is_object()) {
                    const auto& record = history.at(prompt);
                    const auto status = record.value("status", Json::object());
                    if (status.is_object() && status.contains("status_str") &&
                        status.at("status_str").is_string() && status.at("status_str") == "error")
                        throw RunError("COMFYUI_EXECUTION_FAILED", "/prompt",
                                       "ComfyUI workflow execution failed.");
                    if (status.is_object() && status.contains("completed") &&
                        status.at("completed").is_boolean() && status.at("completed") == true)
                        break;
                }
                std::this_thread::sleep_for(std::chrono::milliseconds(250));
            }
            if (!json_mode)
                std::cerr << "ComfyUI prompt " << prompt << " completed; downloading outputs.\n";
            if (hooks.progress)
                hooks.progress("downloading", prompt);
            std::map<std::string, std::vector<Generated>> generated;
            for (const auto& [output_id, contract] : outputs.items()) {
                std::vector<Generated> items;
                const auto& results = history.at(prompt).value("outputs", Json::object());
                for (const auto& binding : entry.manifest.at("outputBindings").at(output_id)) {
                    const auto node = resolve_binding(workflow, binding, true);
                    if (node.empty() || !results.is_object() || !results.contains(node) ||
                        !results.at(node).is_object())
                        continue;
                    const auto& descriptors = results.at(node).value("images", Json::array());
                    if (!descriptors.is_array())
                        continue;
                    for (const auto& descriptor : descriptors) {
                        if (!descriptor.is_object() || !descriptor.contains("filename") ||
                            !descriptor.at("filename").is_string() ||
                            (descriptor.contains("subfolder") &&
                             !descriptor.at("subfolder").is_string()) ||
                            (descriptor.contains("type") && !descriptor.at("type").is_string()))
                            throw RunError("COMFYUI_OUTPUT_INVALID", "/outputs/" + output_id,
                                           "ComfyUI returned an invalid image descriptor.");
                        const auto filename = descriptor.at("filename").get<std::string>();
                        const auto folder = descriptor.value("subfolder", std::string{});
                        const auto type = descriptor.value("type", std::string("output"));
                        const auto endpoint = "/view?filename=" + percent_encode(filename) +
                                              "&subfolder=" + percent_encode(folder) +
                                              "&type=" + percent_encode(type);
                        check_interruption(prompt, hooks);
                        const auto download =
                            comfyui_request(settings.server, endpoint, settings.timeout, "GET", {},
                                            "application/json", 32 * 1024 * 1024);
                        if (!download.ok)
                            throw RunError("COMFYUI_OUTPUT_DOWNLOAD_FAILED",
                                           "/outputs/" + output_id,
                                           "ComfyUI image download failed.");
                        const auto info = image_info(download.bytes);
                        const auto hash =
                            "sha256:" + core::sha256_hex(std::as_bytes(std::span(download.bytes)));
                        items.push_back({output_id,
                                         download.bytes,
                                         {{"outputId", output_id},
                                          {"format", info.format},
                                          {"mimeType", info.mime},
                                          {"width", info.width},
                                          {"height", info.height},
                                          {"hasAlpha", info.alpha},
                                          {"byteSize", download.bytes.size()},
                                          {"contentHash", hash}}});
                    }
                }
                const bool required = contract.value("required", false);
                const bool single = contract.value("cardinality", "") == "one";
                if ((single && items.size() > 1) ||
                    (required && (items.empty() || (single && items.size() != 1))))
                    throw RunError(
                        items.empty() ? "COMFYUI_OUTPUT_MISSING" : "COMFYUI_OUTPUT_CARDINALITY",
                        "/outputs/" + output_id, "ComfyUI returned the wrong number of images.");
                generated.emplace(output_id, std::move(items));
            }
            proof();
            // Project workflow packages are not YAML sources. Recheck their
            // exact manifest+graph identity in addition to native source proof.
            const auto current = catalog(project, settings);
            if (std::none_of(current.begin(), current.end(), [&](const Workflow& candidate) {
                    return candidate.active && candidate.id == entry.id &&
                           candidate.key == entry.key && candidate.hash == entry.hash;
                }))
                throw RunError("COMFYUI_WORKFLOW_CHANGED", "/workflow",
                               "Workflow package changed during execution.");

            Publication publication;
            if (!hooks.register_staged_output) {
                publication.staging = fs::temp_directory_path() / ("noveltea-comfyui-" + nonce());
                if (!fs::create_directory(publication.staging))
                    throw RunError("COMFYUI_PUBLICATION_FAILED", "/outputs",
                                   "Could not allocate private output staging.");
            }
            Json assets = Json::array(), published = Json::object();
            for (const auto& [output_id, items] : generated) {
                Json list = Json::array();
                const auto& contract = outputs.at(output_id);
                for (std::size_t i = 0; i < items.size(); ++i) {
                    const auto& item = items[i];
                    auto metadata = item.metadata;
                    if (routes.contains(output_id)) {
                        fs::path target = routes.at(output_id);
                        if (contract.value("cardinality", "") == "many") {
                            const auto filename =
                                output_id + "-" + (i + 1 < 10 ? "0" : "") + std::to_string(i + 1) +
                                "-" + metadata.at("contentHash").get<std::string>().substr(7, 8) +
                                extension(metadata);
                            target /= filename;
                        }
                        const auto ext = target.extension().string();
                        const auto expected = extension(metadata);
                        if (ext != expected && !(expected == ".jpg" && ext == ".jpeg"))
                            throw RunError(
                                "COMFYUI_OUTPUT_EXTENSION", "/outputs/" + output_id,
                                "Returned image format does not match output extension.");
                        stage_file(publication, target, item.bytes, arguments.force, hooks);
                        metadata["target"] = "filesystem";
                        metadata["path"] = path_text(target);
                    } else {
                        const auto path =
                            hooks.register_staged_output
                                ? fs::temp_directory_path() /
                                      ("noveltea-comfyui-" + nonce() + extension(metadata))
                                : publication.staging /
                                      (output_id + "-" + std::to_string(i) + extension(metadata));
                        if (hooks.register_staged_output) {
                            hooks.register_staged_output(path);
                            publication.extra_staged.push_back(path);
                        }
                        std::ofstream stream(path, std::ios::binary | std::ios::trunc);
                        if (!stream ||
                            !stream.write(item.bytes.data(),
                                          static_cast<std::streamsize>(item.bytes.size())))
                            throw RunError("COMFYUI_PUBLICATION_FAILED", "/outputs",
                                           "Could not stage generated Asset bytes.");
                        assets.push_back({{"outputId", output_id},
                                          {"stagedPath", path_text(path)},
                                          {"output", item.metadata}});
                        metadata["target"] = "asset";
                    }
                    list.push_back(std::move(metadata));
                }
                published[output_id] = contract.value("cardinality", "") == "one"
                                           ? (list.empty() ? Json(nullptr) : list.front())
                                           : list;
            }
            proof();
            check_interruption(prompt, hooks);
            if (hooks.progress)
                hooks.progress("publishing", prompt);
            // For mixed filesystem + Project Asset outputs, the native Project
            // owner installs both under its existing Asset/YAML recovery
            // journal. Installing files here first would expose a gap after
            // a hard worker exit with Assets already committed.
            if (assets.empty()) {
                if (hooks.register_staged_output && !hooks.publish_staged_files)
                    throw RunError("COMFYUI_PUBLICATION_FAILED", "/outputs",
                                   "Disposable filesystem publication requires the broker "
                                   "transaction callback.");
                if (hooks.publish_staged_files) {
                    std::vector<ComfyUiStagedFilesystemOutput> staged;
                    for (const auto& file : publication.files)
                        staged.push_back(
                            {file.temporary, file.target, file.backup, arguments.force});
                    hooks.publish_staged_files(staged);
                } else {
                    publication.commit_files(arguments.force);
                }
            }
            if (!assets.empty()) {
                Json request{{"action", "comfyui-assets"},
                             {"projectRoot", path_text(project)},
                             {"workflow", {{"id", entry.id}, {"label", entry.label}}},
                             {"promptId", prompt},
                             {"expectedSourceGeneration", generation},
                             {"dryRun", false},
                             {"generated", assets}};
                if (!publication.files.empty()) {
                    request["filesystemOutputs"] = Json::array();
                    for (const auto& file : publication.files) {
                        const auto contents = read_file(file.temporary, 32 * 1024 * 1024);
                        if (!contents)
                            throw RunError("COMFYUI_PUBLICATION_FAILED", "/outputs",
                                           "Staged filesystem output is no longer readable.");
                        request["filesystemOutputs"].push_back(
                            {{"stagedPath", path_text(file.temporary)},
                             {"finalPath", path_text(file.target)},
                             {"contentHash",
                              "sha256:" + core::sha256_hex(std::as_bytes(std::span(*contents)))},
                             {"force", arguments.force}});
                    }
                }
                const auto committed = hooks.commit_staged_project_assets
                                           ? hooks.commit_staged_project_assets(request)
                                           : project_request(request);
                if (!committed.value("ok", false) || !committed.contains("fields") ||
                    !committed.at("fields").contains("assets") ||
                    !committed.at("fields").at("assets").is_array() ||
                    committed.at("fields").at("assets").size() != assets.size())
                    throw RunError("COMFYUI_ASSET_PUBLICATION_FAILED", "/outputs",
                                   committed.value("error", "Native Asset publication failed."));
                const auto& entries = committed.at("fields").at("assets");
                for (std::size_t i = 0; i < assets.size(); ++i) {
                    const auto& expected = assets.at(i);
                    const auto& actual = entries.at(i);
                    if (!actual.is_object() ||
                        actual.value("outputId", "") != expected.value("outputId", "") ||
                        actual.value("contentHash", "") !=
                            expected.at("output").value("contentHash", ""))
                        throw RunError(
                            "COMFYUI_ASSET_PUBLICATION_FAILED", "/outputs",
                            "Native Project owner returned inconsistent Asset metadata.");
                    auto& target = published.at(expected.at("outputId").get<std::string>());
                    Json& item = target.is_array()
                                     ? target.at(static_cast<std::size_t>(std::count_if(
                                           assets.begin(), assets.begin() + i,
                                           [&](const Json& a) {
                                               return a.at("outputId") == expected.at("outputId");
                                           })))
                                     : target;
                    item["assetId"] = actual.at("assetId");
                    item["projectRelativePath"] = actual.at("projectRelativePath");
                }
            }
            publication.finalized = true;
            fields["outputs"] = std::move(published);
            return result(true, 0, fields, Json::array(),
                          "ComfyUI workflow '" + entry.id + "' completed.");
        } catch (const RunError& error) {
            if (error.interrupted)
                (void)comfyui_request(settings.server, "/queue", settings.timeout, "POST",
                                      Json{{"delete", Json::array({prompt})}}.dump());
            throw;
        }
    } catch (const RunError& error) {
        return result(false, error.interrupted ? 130 : 4, std::move(fields),
                      Json::array({cli_diagnostic(error.code, error.path, error.what())}),
                      error.what());
    } catch (const std::exception& error) {
        return semantic_failure("COMFYUI_RUN_FAILED", "/", error.what(), std::move(fields));
    }
}
} // namespace

Json load_native_user_export_config()
{
    Json defaults{{"toolchains", Json::object()}, {"signingProfiles", Json::array()}};
    const auto source = read_file(user_root() / "config.json", 1024 * 1024);
    if (!source)
        return defaults;
    try {
        const auto parsed = Json::parse(*source, nullptr, false);
        if (!parsed.is_discarded() && valid_user_config(parsed) && parsed.contains("export")) {
            defaults.update(parsed.at("export"));
        }
    } catch (...) {
        // The editor treats invalid shared user configuration as defaults,
        // rather than trusting a partially parsed set of signing credentials.
    }
    return defaults;
}

ComfyUiResult run_native_comfyui_catalog(const std::vector<std::string>& command,
                                         const fs::path& project,
                                         const std::function<Json(const Json&)>& project_request,
                                         bool json_mode, const ComfyUiExecutionHooks& hooks)
{
    if (command.at(1) == "run") {
        const auto run = parse_run(command);
        const auto settings = config(run.server);
        return run_workflow(run, settings, project, catalog(project, settings), project_request,
                            json_mode, hooks);
    }
    const auto parsed = parse_command(command);
    const auto& operation = command.at(1);
    if (operation == "status")
        return status(config(parsed.server));
    const auto settings = config(operation == "verify" ? parsed.server : std::nullopt);
    const auto entries = catalog(project, settings);
    if (operation == "workflows")
        return workflows(parsed, project, entries);
    return verify(parsed, project, settings, entries);
}
} // namespace noveltea::cli
