#include "native_cli_comfyui.hpp"
#include "native_cli_comfyui_http.hpp"
#include "native_comfyui_workflows_generated.hpp"

#include <noveltea/core/player_bootstrap.hpp>

#include <algorithm>
#include <chrono>
#include <cstdlib>
#include <ctime>
#include <fstream>
#include <iomanip>
#include <map>
#include <optional>
#include <regex>
#include <set>
#include <span>
#include <sstream>
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
};

Config config(const std::optional<std::string>& server_override)
{
    Config settings;
    if (const auto text = read_file(user_root() / "config.json", 1024 * 1024)) {
        try {
            const auto source = Json::parse(*text);
            if (source.is_object() && source.value("format", "") == "noveltea.user-config" &&
                source.value("formatVersion", 0) == 1 && source.contains("comfyui") &&
                source.at("comfyui").is_object()) {
                const auto& shared = source.at("comfyui");
                if (shared.contains("serverUrl") && shared.at("serverUrl").is_string() &&
                    shared.contains("requestTimeoutMs") &&
                    shared.at("requestTimeoutMs").is_number_integer()) {
                    const auto configured_timeout = shared.at("requestTimeoutMs").get<int>();
                    if (configured_timeout > 0 && configured_timeout <= 300000) {
                        settings.server = shared.at("serverUrl").get<std::string>();
                        settings.timeout = configured_timeout;
                    }
                }
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
    static const std::regex url(R"(^https?://[^\s/#?]+(?:/[a-zA-Z0-9._~!$&'()*+,;=:@%/-]*)?$)",
                                std::regex::icase);
    if (!std::regex_match(settings.server, url)) {
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
    return node.at("_meta").value("title", "");
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
                (by_class && node.value("class_type", std::string{}) != cls))
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
        entry.manifest = Json::parse(manifest_text);
        if (!entry.manifest.is_object() || !entry.manifest.contains("workflowFile") ||
            !entry.manifest.at("workflowFile").is_string() ||
            !safe_name(entry.manifest.at("workflowFile").get<std::string>()))
            throw std::runtime_error("Workflow file must be a safe sibling of its manifest.");
        if (!workflow_text)
            throw std::runtime_error(
                "ComfyUI workflow JSON is missing or exceeds the parsing limit.");
        entry.graph = Json::parse(*workflow_text);
        validate_workflow(entry);
        entry.hash = package_hash(entry.manifest, entry.graph);
    } catch (const std::exception& error) {
        entry.offline = "invalid";
        entry.diagnostics.push_back(workflow_diagnostic("/workflows/" + filename, error.what()));
    }
    return entry;
}

std::vector<Workflow> catalog(const fs::path& project, const Config& settings)
{
    std::vector<Workflow> entries;
    std::map<std::string, std::string> embedded;
    for (const auto& file : embedded_comfyui::files)
        embedded.emplace(file.name, file.text);
    for (const auto& [name, text] : embedded) {
        if (!name.ends_with(".manifest.json"))
            continue;
        std::optional<std::string> workflow;
        try {
            const auto manifest = Json::parse(text);
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
                const auto data = Json::parse(*manifest);
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
            const auto doc = Json::parse(*cache);
            if (doc.is_object() &&
                doc.value("schema", "") == "noveltea.comfyui-workflow-verification-cache" &&
                doc.contains("records") && doc.at("records").is_array()) {
                for (auto& entry : entries) {
                    std::string latest;
                    for (const auto& record : doc.at("records")) {
                        if (!record.is_object() ||
                            record.value("serverIdentity", "") != settings.server ||
                            record.value("packageHash", "") != entry.hash ||
                            !record.contains("diagnostics") ||
                            !record.at("diagnostics").is_array() ||
                            record.value("checkedAt", "") < latest)
                            continue;
                        latest = record.value("checkedAt", "");
                        entry.online = record.value("status", "") == "verified"
                                           ? "previously-verified"
                                           : "failed";
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
                const auto cls = entry.graph.at(node_id).value("class_type", std::string{});
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
                    {"serverIdentity", settings.server},
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
                const auto parsed = Json::parse(*text);
                if (parsed.value("schema", "") == "noveltea.comfyui-workflow-verification-cache" &&
                    parsed.contains("records") && parsed.at("records").is_array())
                    old = parsed.at("records");
            } catch (...) {
            }
        }
        for (const auto& record : new_records) {
            Json merged = Json::array();
            for (const auto& item : old)
                if (!(item.is_object() && item.value("serverIdentity", "") == settings.server &&
                      item.value("packageHash", "") == record.at("packageHash") &&
                      item.value("comfyUiVersion", "") == server_version))
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
} // namespace

ComfyUiResult run_native_comfyui_catalog(const std::vector<std::string>& command,
                                         const fs::path& project)
{
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
