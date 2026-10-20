#include "tooling_native_project_asset.hpp"

#include "../project_authoring/contracts.hpp"
#include "../project_authoring/room_session.hpp"
#include "../project_authoring/source_authority.hpp"
#include "../project_authoring/yaml_codec.hpp"
#include "../project_authoring/yaml_transaction.hpp"
#include "tooling_native_c.h"
#include "tooling_native_asset_media.hpp"
#include "tooling_native_project_sync.hpp"

#include <algorithm>
#include <atomic>
#include <cctype>
#include <filesystem>
#include <fstream>
#include <chrono>
#include <cstdio>
#include <ctime>
#include <iterator>
#include <map>
#include <optional>
#include <regex>
#include <set>
#include <sstream>
#include <string>
#include <stdexcept>
#include <vector>

#if defined(_WIN32)
#include <Windows.h>
#include <process.h>
#else
#include <cerrno>
#include <csignal>
#include <unistd.h>
#endif

namespace {
namespace fs = std::filesystem;
using Json = nlohmann::json;
using namespace noveltea::authoring;

Json failure(std::string code, std::string path, std::string reason)
{
    return {{"ok", false},
            {"diagnostics", Json::array({{{"code", std::move(code)},
                                          {"path", std::move(path)},
                                          {"message", std::move(reason)},
                                          {"severity", "error"}}})}};
}

std::string bytes_at(const fs::path& path)
{
    std::ifstream input(path, std::ios::binary);
    if (!input)
        throw std::runtime_error("Cannot read scoped Asset record.");
    return {std::istreambuf_iterator<char>(input), std::istreambuf_iterator<char>()};
}

bool contained(const fs::path& root, const fs::path& child)
{
    const auto relative = fs::canonical(child).lexically_relative(fs::canonical(root));
    return !relative.empty() && relative != ".." && *relative.begin() != "..";
}

bool ignored(std::string name)
{
    if (name == ".DS_Store" || name == "Thumbs.db" || name.starts_with('.') ||
        name.starts_with('~'))
        return true;
    const auto dot = name.find_last_of('.');
    auto extension = dot == std::string::npos ? std::string{} : name.substr(dot);
    std::transform(extension.begin(), extension.end(), extension.begin(),
                   [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    return extension == ".tmp" || extension == ".part" || extension == ".crdownload" ||
           extension == ".download";
}

std::string kind(const fs::path& path)
{
    auto extension = path.extension().string();
    std::transform(extension.begin(), extension.end(), extension.begin(),
                   [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    for (const auto& [classification, suffixes] :
         {std::pair<std::string, std::set<std::string>>{
              "image", {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".svg"}},
          {"font", {".ttf", ".otf", ".woff", ".woff2"}},
          {"audio", {".mp3", ".ogg", ".wav", ".flac", ".m4a"}},
          {"video", {".mp4", ".webm", ".mkv", ".mov", ".m4v"}},
          {"text", {".txt", ".md", ".rml", ".rcss", ".css"}},
          {"data", {".json", ".toml", ".yaml", ".yml", ".csv"}}})
        if (suffixes.contains(extension))
            return classification;
    return "binary";
}

std::string utf8(const fs::path& path)
{
    const auto text = path.generic_u8string();
    return {text.begin(), text.end()};
}

fs::path from_utf8(std::string_view value)
{
    return fs::path(std::u8string(value.begin(), value.end()));
}

std::string slug(std::string_view filename)
{
    const auto dot = filename.find_last_of('.');
    const auto stem = filename.substr(0, dot);
    std::string result;
    for (const unsigned char c : stem) {
        if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9'))
            result += static_cast<char>(std::tolower(c));
        else if (!result.empty() && result.back() != '-')
            result += '-';
    }
    while (!result.empty() && result.back() == '-')
        result.pop_back();
    if (result.empty() || result.front() < 'a' || result.front() > 'z')
        result = "asset-" + (result.empty() ? "file" : result);
    return result;
}

std::string timestamp()
{
    const auto instant = std::chrono::system_clock::now();
    const auto now = std::chrono::system_clock::to_time_t(instant);
    const auto milliseconds =
        std::chrono::duration_cast<std::chrono::milliseconds>(instant.time_since_epoch()).count() %
        1000;
    std::tm utc{};
#if defined(_WIN32)
    gmtime_s(&utc, &now);
#else
    gmtime_r(&now, &utc);
#endif
    char date[40]{};
    std::strftime(date, sizeof(date), "%Y-%m-%dT%H:%M:%S", &utc);
    char result[48]{};
    std::snprintf(result, sizeof(result), "%s.%03lldZ", date, static_cast<long long>(milliseconds));
    return result;
}

std::string mime(const fs::path& path)
{
    auto ext = path.extension().string();
    std::transform(ext.begin(), ext.end(), ext.begin(),
                   [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    static const std::map<std::string, std::string> types{
        {".png", "image/png"},    {".jpg", "image/jpeg"}, {".jpeg", "image/jpeg"},
        {".webp", "image/webp"},  {".gif", "image/gif"},  {".svg", "image/svg+xml"},
        {".ttf", "font/ttf"},     {".otf", "font/otf"},   {".woff", "font/woff"},
        {".woff2", "font/woff2"}, {".mp3", "audio/mpeg"}, {".ogg", "audio/ogg"},
        {".wav", "audio/wav"},    {".lua", "text/x-lua"}, {".json", "application/json"},
        {".txt", "text/plain"}};
    const auto it = types.find(ext);
    return it == types.end() ? "" : it->second;
}

std::optional<Json> native_image_metadata(const fs::path& source)
{
    const auto request = Json{{"sourcePath", utf8(source)}}.dump();
    std::vector<std::uint8_t> buffer(8192);
    const auto size =
        noveltea_tooling_image_inspect_json(reinterpret_cast<const std::uint8_t*>(request.data()),
                                            request.size(), buffer.data(), buffer.size());
    if (size == 0 || size > buffer.size())
        return std::nullopt;
    auto result = Json::parse(buffer.begin(), buffer.begin() + static_cast<std::ptrdiff_t>(size),
                              nullptr, false);
    if (!result.is_object() || !result.value("ok", false))
        return std::nullopt;
    return Json{{"width", result.at("width")},
                {"height", result.at("height")},
                {"hasAlpha", result.at("hasAlpha")},
                {"orientation", result.at("orientation")}};
}

std::optional<std::string> read_reliable(const fs::path& path)
{
    if (!fs::is_regular_file(path) || fs::file_size(path) > 512 * 1024 * 1024)
        return std::nullopt;
    const auto before = fs::last_write_time(path);
    auto bytes = bytes_at(path);
    if (fs::file_size(path) != bytes.size() || fs::last_write_time(path) != before)
        return std::nullopt;
    return bytes;
}

std::string import_yaml(const std::string& id, const std::string& label,
                        const std::string& classification, const std::string& relative,
                        const std::string& name, const std::string& original,
                        const std::string& data_revision, std::size_t size,
                        const std::optional<Json>& image)
{
    std::ostringstream out;
    out << "id: " << Json(id).dump() << "\nlabel: " << Json(label).dump()
        << "\ndata:\n  kind: " << Json(classification).dump()
        << "\n  source:\n    type: project-file\n    path: " << Json(relative).dump()
        << "\n  attachments: []\n  aliases: []\n";
    if (classification == "image")
        out << "  sampling: linear\n";
    const auto mime_type = mime(from_utf8(name));
    if (!mime_type.empty())
        out << "  mimeType: " << Json(mime_type).dump() << '\n';
    auto extension = from_utf8(name).extension().string();
    std::transform(extension.begin(), extension.end(), extension.begin(),
                   [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    out << "  extension: " << Json(extension).dump() << "\n  byteSize: " << size
        << "\n  contentHash: " << Json(data_revision).dump()
        << "\n  importedAt: " << Json(timestamp()).dump()
        << "\n  originalName: " << Json(name).dump()
        << "\n  originalPath: " << Json(original).dump() << '\n';
    if (image) {
        out << "  imageMetadata:\n";
        for (const auto* key : {"width", "height", "hasAlpha", "orientation"})
            out << "    " << key << ": " << image->at(key).dump() << '\n';
    } else
        out << "  imageMetadata: null\n";
    out << "  preview:\n    thumbnailRevision: " << Json(data_revision).dump() << '\n';
    return out.str();
}

struct PlannedImport {
    fs::path original;
    std::string original_bytes;
    std::string asset_id;
    std::string asset_path;
    std::string record_path;
    std::string source_yaml;
    std::string classification;
    std::optional<Json> image;
    bool external = false;
};

struct ScopedDirectory {
    fs::path path;
    ~ScopedDirectory()
    {
        if (!path.empty()) {
            std::error_code ignored;
            fs::remove_all(path, ignored);
        }
    }
};

int current_process_id()
{
#if defined(_WIN32)
    return _getpid();
#else
    return static_cast<int>(getpid());
#endif
}

bool process_alive(int process_id)
{
    if (process_id <= 0)
        return true;
#if defined(_WIN32)
    HANDLE process = OpenProcess(SYNCHRONIZE, FALSE, static_cast<DWORD>(process_id));
    if (!process)
        return GetLastError() != ERROR_INVALID_PARAMETER;
    const auto state = WaitForSingleObject(process, 0);
    CloseHandle(process);
    return state != WAIT_OBJECT_0;
#else
    return kill(process_id, 0) == 0 || errno != ESRCH;
#endif
}

bool safe_import_relative(const std::string& path)
{
    if (path.empty() || path.front() == '/' || path.find('\\') != path.npos ||
        path.find(':') != path.npos)
        return false;
    const auto value = from_utf8(path);
    if (value.is_absolute() || value.lexically_normal() != value)
        return false;
    for (const auto& part : value)
        if (part == ".." || part == ".")
            return false;
    return true;
}

void make_safe_project_directory(const fs::path& root, std::string_view relative)
{
    if (!safe_import_relative(std::string(relative)))
        throw std::runtime_error("Unsafe Asset import output directory.");
    auto current = fs::canonical(root);
    for (const auto& part : from_utf8(relative)) {
        current /= part;
        const auto status = fs::symlink_status(current);
        if (status.type() == fs::file_type::not_found)
            fs::create_directory(current);
        else if (status.type() != fs::file_type::directory)
            throw std::runtime_error("Asset output directory is not a physical directory.");
        if (!contained(root, current) || fs::is_symlink(fs::symlink_status(current)))
            throw std::runtime_error("Asset output directory escapes the Project root.");
    }
}

// Resolve a dead Asset-import owner without ever guessing whether a published
// binary belongs to some newer writer. A complete YAML transaction wins; an
// absent YAML transaction rolls back only exact, native-installed bytes.
void recover_abandoned_import(const fs::path& root)
{
    const auto meta = root / ".noveltea";
    if (fs::is_symlink(fs::symlink_status(meta)))
        throw std::runtime_error("Native Asset local-state directory cannot be a symlink.");
    if (fs::exists(meta) && (!fs::is_directory(meta) || !contained(root, meta)))
        throw std::runtime_error("Native Asset local-state directory is not contained.");
    const auto mutex = meta / "asset-import.lock";
    if (!fs::exists(mutex)) {
        const auto staging = meta / "asset-import-staging";
        if (fs::exists(staging) && !fs::is_empty(staging))
            throw std::runtime_error("Unowned Asset import staging requires manual recovery.");
        return;
    }
    if (!fs::is_directory(mutex) || fs::is_symlink(fs::symlink_status(mutex)))
        throw std::runtime_error("Asset import lock is not a directory.");
    const auto owner_path = mutex / "owner.json";
    if (!fs::is_regular_file(owner_path) || fs::is_symlink(fs::symlink_status(owner_path)))
        throw std::runtime_error("Asset import lock has no verifiable process owner.");
    const auto owner = Json::parse(bytes_at(owner_path));
    if (!owner.is_object() || !owner.contains("pid") || !owner.at("pid").is_number_integer())
        throw std::runtime_error("Asset import owner metadata is invalid.");
    if (process_alive(owner.at("pid").get<int>()))
        throw std::runtime_error("Another native Asset importer still owns this Project.");
    YamlTransactionService writer(root);
    const auto yaml = writer.recover();
    if (!yaml.accepted)
        throw std::runtime_error("YAML recovery blocked Asset import recovery: " + yaml.error);
    const auto staged = meta / "asset-import-staging";
    if (fs::exists(staged)) {
        if (!fs::is_directory(staged) || fs::is_symlink(fs::symlink_status(staged)))
            throw std::runtime_error("Unsafe native Asset staging root.");
        for (const auto& entry : fs::directory_iterator(staged)) {
            if (!entry.is_directory() || entry.is_symlink() || !contained(staged, entry.path()))
                throw std::runtime_error("Asset import staging entry is not a safe directory.");
            const auto manifest = entry.path() / "manifest.json";
            if (fs::exists(manifest)) {
                if (fs::is_symlink(fs::symlink_status(manifest)))
                    throw std::runtime_error("Asset import recovery intent cannot be a symlink.");
                const auto journal = Json::parse(bytes_at(manifest));
                if (!journal.is_object() ||
                    journal.value("schema", std::string{}) != "noveltea.native-asset-import" ||
                    !journal.contains("items") || !journal.at("items").is_array())
                    throw std::runtime_error("Unknown Asset-import recovery journal.");
                bool committed = true;
                bool absent = true;
                for (const auto& item : journal.at("items")) {
                    const auto record = item.at("recordPath").get<std::string>();
                    if (!record.starts_with("records/assets/") || !safe_import_relative(record))
                        throw std::runtime_error("Unsafe Asset record in recovery journal.");
                    const auto record_path = root / from_utf8(record);
                    const auto current = fs::is_regular_file(record_path)
                                             ? exact_source_revision(bytes_at(record_path))
                                             : "absent";
                    if (current != item.at("recordRevision").get<std::string>())
                        committed = false;
                    if (current != "absent")
                        absent = false;
                }
                if (!committed && !absent)
                    throw std::runtime_error("Asset import has mixed YAML recovery revisions.");
                if (committed) {
                    // A completed YAML journal is not enough to declare the
                    // multi-file import recovered: its referenced Asset bytes
                    // must also still match the exact publication manifest.
                    for (const auto& item : journal.at("items")) {
                        const auto path = item.at("assetPath").get<std::string>();
                        if (!path.starts_with("assets/") || !safe_import_relative(path))
                            throw std::runtime_error("Unsafe committed Asset recovery path.");
                        const auto absolute = root / from_utf8(path);
                        if (!fs::is_regular_file(absolute) ||
                            fs::is_symlink(fs::symlink_status(absolute)) ||
                            !contained(root, absolute) ||
                            exact_source_revision(bytes_at(absolute)) !=
                                item.at("assetRevision").get<std::string>())
                            throw std::runtime_error(
                                "Committed Asset bytes are missing or changed.");
                    }
                }
                if (absent) {
                    // Preflight the *entire* journal before touching any
                    // visible output. A conflict in the last entry must not
                    // cause earlier exact Asset files to disappear.
                    std::size_t index = 0;
                    std::vector<fs::path> safe_removals;
                    for (const auto& item : journal.at("items")) {
                        if (!item.at("external").get<bool>()) {
                            ++index;
                            continue;
                        }
                        const auto path = item.at("assetPath").get<std::string>();
                        if (!path.starts_with("assets/") || !safe_import_relative(path))
                            throw std::runtime_error("Unsafe Asset path in recovery journal.");
                        const auto absolute = root / from_utf8(path);
                        if (!fs::exists(absolute)) {
                            ++index;
                            continue;
                        }
                        if (!fs::is_regular_file(absolute) ||
                            fs::is_symlink(fs::symlink_status(absolute)) ||
                            !contained(root, absolute) ||
                            !fs::equivalent(entry.path() / std::to_string(index), absolute) ||
                            exact_source_revision(bytes_at(absolute)) !=
                                item.at("assetRevision").get<std::string>())
                            throw std::runtime_error("Asset output changed; recovery is unsafe.");
                        safe_removals.push_back(absolute);
                        ++index;
                    }
                    for (const auto& file : safe_removals)
                        fs::remove(file);
                }
            }
            // No manifest means publication never started; an empty directory
            // or incomplete staged blobs have no visible tracked outputs.
            fs::remove_all(entry.path());
        }
    }
    fs::remove_all(mutex);
}
} // namespace

Json native_project_disk_safety(const fs::path& root, bool agent_sync)
{
    try {
        // Scoped callers must not recover transactions or admit unrelated record families.
        for (const auto* relative : {".noveltea", ".noveltea/agent", "AGENTS.md", ".gitignore"}) {
            if (!agent_sync && std::string_view(relative) != ".noveltea")
                continue;
            const auto resolved = fs::weakly_canonical(root / relative);
            const auto within = resolved.lexically_relative(fs::canonical(root));
            if (within.empty() || within == ".." || *within.begin() == ".." || within.is_absolute())
                return failure("WORKSPACE_PATH_INVALID", "/" + std::string(relative),
                               "Workspace path resolves outside the project root.");
        }
        const auto transactions = root / ".noveltea/transactions";
        const auto status = fs::symlink_status(transactions);
        bool unsettled =
            status.type() != fs::file_type::not_found && status.type() != fs::file_type::directory;
        if (!unsettled && status.type() == fs::file_type::directory) {
            for (const auto& entry : fs::directory_iterator(transactions))
                if (entry.path().filename() != ".writer-lock") {
                    unsettled = true;
                    break;
                }
        }
        const auto import_lock = root / ".noveltea/asset-import.lock";
        const auto import_staging = root / ".noveltea/asset-import-staging";
        unsettled = unsettled || fs::exists(import_lock) ||
                    (fs::exists(import_staging) &&
                     (!fs::is_directory(import_staging) || !fs::is_empty(import_staging)));
        if (unsettled) {
            auto result =
                failure("WORKSPACE_TRANSACTION_RECOVERY_CONFLICT", "/.noveltea/transactions",
                        "The workspace has a pending transaction that requires recovery "
                        "before a read-only dry run.");
            result["exitCode"] = 5;
            return result;
        }
        return {{"ok", true}};
    } catch (const std::exception& error) {
        return failure("WORKSPACE_PATH_INVALID", "/.noveltea", error.what());
    }
}

Json native_project_workspace_preflight(const fs::path& root, bool agent_sync, bool include_export)
{
    const auto safety = native_project_disk_safety(root, agent_sync);
    if (!safety.value("ok", false))
        return safety;
    try {
        if (!contained(root, root / "project.yaml"))
            return failure("WORKSPACE_PATH_INVALID", "/project.yaml",
                           "Project manifest resolves outside the Project root.");
        const auto manifest_source =
            noveltea::authoring::open_yaml_source(bytes_at(root / "project.yaml"));
        if (!manifest_source.accepted)
            return failure("WORKSPACE_SOURCE_READ", "/project.yaml", manifest_source.error);
        const auto manifest = Json::parse(manifest_source.source_json);
        if (!manifest.is_object())
            return failure("WORKSPACE_MANIFEST_INVALID", "/project.yaml",
                           "project.yaml must be an object.");
        // The schema discriminator and version are enforced before the scoped
        // shape or Asset domain, as in prepareCliProject(). Do not validate
        // unrelated gameplay record families here.
        if (manifest.value("schema", Json()) != "noveltea.project.workspace")
            return failure("WORKSPACE_MANIFEST_INVALID", "/schema",
                           "project.yaml must use schema 'noveltea.project.workspace'.");
        if (manifest.value("schemaVersion", Json()) != 1) {
            auto result = failure("WORKSPACE_VERSION_UNSUPPORTED", "/schemaVersion",
                                  "Workspace version is unsupported; expected 1.");
            result["exitCode"] = 3;
            return result;
        }
        static const std::set<std::string> manifest_keys{"schema",
                                                         "schemaVersion",
                                                         "project",
                                                         "settings",
                                                         "export",
                                                         "bootstrapModule",
                                                         "undefinedInteractionProgram",
                                                         "entrypoint",
                                                         "inventories",
                                                         "interactableInstances"};
        for (const auto& [key, value] : manifest.items())
            if (!manifest_keys.contains(key))
                return failure("WORKSPACE_MANIFEST_INVALID", "/project.yaml",
                               "project.yaml has an unsupported workspace-v1 shape.");
        for (const auto* key : {"schema", "schemaVersion", "project", "settings", "export",
                                "bootstrapModule", "inventories", "interactableInstances"})
            if (!manifest.contains(key))
                return failure("WORKSPACE_MANIFEST_INVALID", "/project.yaml",
                               "project.yaml has an unsupported workspace-v1 shape.");
        const auto admitted = validate_workspace_project_identity(manifest.at("project").dump());
        if (!admitted.accepted) {
            Json diagnostics = Json::array();
            for (const auto& diagnostic : admitted.diagnostics)
                diagnostics.push_back({{"code", "WORKSPACE_SOURCE_READ"},
                                       {"path", diagnostic.path},
                                       {"message", diagnostic.message},
                                       {"severity", "error"}});
            return {{"ok", false}, {"exitCode", 3}, {"diagnostics", std::move(diagnostics)}};
        }
        Json result{{"ok", true},
                    {"projectIdentity", Json::parse(admitted.effective_json)},
                    {"diagnostics", Json::array()}};
        if (include_export) {
            const auto settings = validate_workspace_export_settings(manifest.at("export").dump());
            if (!settings.accepted) {
                result["ok"] = false;
                result["exitCode"] = 3;
            } else {
                result["exportSettings"] = Json::parse(settings.effective_json);
            }
            for (const auto& diagnostic : settings.diagnostics)
                result["diagnostics"].push_back(
                    {{"code", settings.accepted ? diagnostic.code : "WORKSPACE_SOURCE_READ"},
                     {"path", diagnostic.path},
                     {"message", diagnostic.message},
                     {"severity", diagnostic.severity}});
        }
        return result;
    } catch (const std::exception& error) {
        return failure("WORKSPACE_MANIFEST_READ", "/project.yaml", error.what());
    }
}

Json native_project_asset_audit(const fs::path& root)
{
    try {
        const auto preflight = native_project_workspace_preflight(root);
        if (!preflight.value("ok", false))
            return preflight;
        const auto records = root / "records/assets";
        std::set<std::string> tracked;
        if (fs::exists(records)) {
            if (!fs::is_directory(records) || !contained(root, records))
                return failure("WORKSPACE_SOURCE_READ", "/records/assets",
                               "Invalid Asset collection.");
            for (const auto& entry : fs::directory_iterator(records)) {
                const auto file = entry.path();
                const auto name = file.filename().string();
                if (!entry.is_regular_file() || file.extension() != ".yaml" ||
                    !contained(records, file) ||
                    !std::regex_match(file.stem().string(),
                                      std::regex(R"(^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$)")))
                    return failure("WORKSPACE_SOURCE_READ", "/records/assets/" + name,
                                   "Asset record path is invalid.");
                const auto decoded = noveltea::authoring::open_yaml_source(bytes_at(file));
                if (!decoded.accepted)
                    return failure("WORKSPACE_SOURCE_READ", "/records/assets/" + name,
                                   decoded.error);
                const auto record = Json::parse(decoded.source_json);
                if (!record.is_object() || !record.contains("id") ||
                    record.at("id") != file.stem().string() ||
                    !noveltea::authoring::validate_asset_source(decoded.source_json).accepted)
                    return failure("WORKSPACE_SCHEMA_INVALID", "/assets/" + file.stem().string(),
                                   "Invalid Asset record source.");
                const auto& source = record.at("data").at("source");
                if (source.is_object() && source.value("type", std::string{}) == "project-file" &&
                    source.contains("path") && source.at("path").is_string()) {
                    const auto relative = source.at("path").get<std::string>();
                    const auto resolved = fs::weakly_canonical(root / fs::u8path(relative));
                    const auto within = resolved.lexically_relative(fs::canonical(root));
                    if (within.empty() || within == ".." || *within.begin() == ".." ||
                        within.is_absolute())
                        return failure("asset.audit.path_escape", relative,
                                       "Asset source path resolves outside the project root.");
                    tracked.insert(relative);
                }
            }
        }
        const auto assets = root / "assets";
        Json untracked = Json::array();
        if (fs::exists(assets)) {
            if (!fs::is_directory(assets))
                return failure("asset.audit.invalid_assets_directory", "/assets",
                               "Project assets path is not a directory.");
            if (!contained(root, assets))
                return failure("asset.audit.path_escape", "assets",
                               "Asset directory resolves outside the project root.");
            for (fs::recursive_directory_iterator
                     it(assets, fs::directory_options::follow_directory_symlink),
                 end;
                 it != end; ++it) {
                const auto file = it->path();
                if (ignored(file.filename().string())) {
                    it.disable_recursion_pending();
                    continue;
                }
                if (!contained(assets, file))
                    return failure("asset.audit.path_escape",
                                   file.lexically_relative(root).generic_string(),
                                   "Asset path escapes the Project Asset directory.");
                if (it->is_directory()) {
                    const auto resolved = fs::canonical(file);
                    for (auto parent = file.parent_path();; parent = parent.parent_path()) {
                        if (fs::canonical(parent) == resolved)
                            return failure("asset.audit.path_cycle",
                                           file.lexically_relative(root).generic_string(),
                                           "Asset directory resolves to an ancestor directory.");
                        if (parent == assets)
                            break;
                    }
                }
                if (!it->is_regular_file())
                    continue;
                const auto relative = file.lexically_relative(root).generic_string();
                if (!tracked.contains(relative))
                    untracked.push_back({{"projectRelativePath", relative}, {"kind", kind(file)}});
            }
        }
        std::sort(untracked.begin(), untracked.end(), [](const auto& a, const auto& b) {
            return a.at("projectRelativePath") < b.at("projectRelativePath");
        });
        const auto count = untracked.size();
        return {{"ok", true},
                {"diagnostics", Json::array()},
                {"fields", {{"untrackedFiles", std::move(untracked)}}},
                {"humanSuccess", count ? "Found " + std::to_string(count) +
                                             " untracked Asset file" + (count == 1 ? "." : "s.")
                                       : "No untracked Asset files."}};
    } catch (const std::exception& error) {
        return failure("WORKSPACE_SOURCE_READ", "/assets", error.what());
    }
}

std::optional<std::string> native_project_asset_recover(const fs::path& root)
{
    try {
        recover_abandoned_import(root);
        return std::nullopt;
    } catch (const std::exception& error) {
        return error.what();
    }
}

Json native_project_asset_import(const Json& request, ProjectSession& session, const fs::path& root)
{
    const auto fail = [](std::string message) {
        return failure("asset.import.failed", "/assets", std::move(message));
    };
    const bool generated = request.value("action", std::string{}) == "comfyui-assets";
    const auto& sources = generated ? request.value("generated", Json())
                                    : request.value("paths", Json());
    if (!sources.is_array() || sources.empty() || sources.size() > 128 ||
        (request.contains("dryRun") && !request.at("dryRun").is_boolean()))
        return fail("Native Asset import requires 1-128 physical source paths and a dryRun flag.");
    if (generated && (!request.contains("workflow") || !request["workflow"].is_object() ||
                      !request["workflow"].contains("id") ||
                      !request["workflow"]["id"].is_string() ||
                      !request["workflow"].contains("label") ||
                      !request["workflow"]["label"].is_string() ||
                      !request.contains("promptId") || !request["promptId"].is_string()))
        return fail("Generated Asset publication requires a workflow identity and prompt ID.");
    const bool dry_run = request.value("dryRun", true);
    try {
        if (!dry_run)
            recover_abandoned_import(root);
        else if (fs::exists(root / ".noveltea/asset-import.lock"))
            return fail("Asset import has an unsettled physical transaction.");
    } catch (const std::exception& error) {
        return fail(error.what());
    }
    if (!session.validate_project().valid)
        return fail("Asset import cannot mutate an invalid Project.");
    if (generated && request.contains("expectedSourceGeneration") &&
        (!request["expectedSourceGeneration"].is_string() ||
         native_project_source_generation(session, root) !=
             request["expectedSourceGeneration"].get<std::string>()))
        return fail("Project source generation changed before ComfyUI Asset publication.");

    try {
        std::set<std::string> occupied_ids;
        std::map<std::string, Json> existing_by_path;
        for (const auto& file : session.file_inventory()) {
            if (!file.path.starts_with("records/assets/") || !file.path.ends_with(".yaml") ||
                file.path.substr(sizeof("records/assets/") - 1).find('/') != std::string::npos)
                continue;
            const auto filename = file.path.substr(sizeof("records/assets/") - 1);
            occupied_ids.insert(filename.substr(0, filename.size() - 5));
            const auto source = open_yaml_source(bytes_at(root / file.path));
            if (!source.accepted)
                return fail("Invalid existing Asset record: " + file.path);
            const auto record = Json::parse(source.source_json);
            if (record.contains("data") && record.at("data").is_object() &&
                record.at("data").contains("source") &&
                record.at("data").at("source").is_object() &&
                record.at("data").at("source").contains("path") &&
                record.at("data").at("source").at("path").is_string())
                existing_by_path.emplace(
                    record.at("data").at("source").at("path").get<std::string>(), record);
        }
        std::vector<PlannedImport> planned;
        Json outputs = Json::array();
        std::set<fs::path> seen_sources;
        std::set<std::string> planned_destinations;
        const auto real_root = fs::canonical(root);
        const auto assets_root = real_root / "assets";
        const bool has_assets = fs::is_directory(assets_root) && contained(real_root, assets_root);
        for (const auto& item : sources) {
            if ((generated && (!item.is_object() || !item.contains("stagedPath") ||
                               !item["stagedPath"].is_string() ||
                               !item.contains("outputId") || !item["outputId"].is_string() ||
                               !item.contains("output") || !item["output"].is_object())) ||
                (!generated && !item.is_string()))
                return fail("Asset import source paths must be UTF-8 strings.");
            const auto& metadata = generated ? item["output"] : Json::object();
            if (generated && (!metadata.contains("format") || !metadata["format"].is_string() ||
                              !metadata.contains("byteSize") ||
                              !metadata["byteSize"].is_number_unsigned() ||
                              !metadata.contains("contentHash") ||
                              !metadata["contentHash"].is_string() ||
                              !metadata.contains("mimeType") || !metadata["mimeType"].is_string() ||
                              !metadata.contains("width") || metadata["width"].is_number() == false ||
                              !metadata.contains("height") || metadata["height"].is_number() == false ||
                              !metadata.contains("hasAlpha") || !metadata["hasAlpha"].is_boolean()))
                return fail("Generated Asset metadata is malformed.");
            auto source = from_utf8(generated ? item["stagedPath"].get<std::string>()
                                              : item.get<std::string>());
            if (!source.is_absolute())
                return fail("Native Asset import requires absolute source paths.");
            if (!fs::is_regular_file(source))
                return fail("Asset import source is not a regular file: " + utf8(source));
            source = fs::canonical(source);
            if (!seen_sources.insert(source).second)
                continue;
            const auto generated_format = generated ? metadata.value("format", std::string{}) : "";
            const std::map<std::string, std::string> generated_extensions{
                {"png", ".png"}, {"jpeg", ".jpg"}, {"webp", ".webp"}, {"gif", ".gif"}};
            if (generated && !generated_extensions.contains(generated_format))
                return fail("Unsupported generated image format.");
            const auto filename = generated ? slug(request["workflow"]["id"].get<std::string>() +
                                                   "-" + timestamp()) +
                                                  generated_extensions.at(generated_format)
                                            : utf8(source.filename());
            const auto classification = generated ? "image" : kind(source);
            const bool internal = !generated && has_assets && contained(assets_root, source);
            auto asset_path =
                internal ? source.lexically_relative(real_root).generic_string() : std::string{};
            if (internal && existing_by_path.contains(asset_path)) {
                const auto& record = existing_by_path.at(asset_path);
                const auto& data = record.at("data");
                Json entry{{"assetId", record.at("id")},
                           {"projectRelativePath", asset_path},
                           {"kind", data.at("kind")},
                           {"alreadyImported", true}};
                if (data.contains("contentHash"))
                    entry["contentHash"] = data.at("contentHash");
                if (data.at("kind") == "image" && data.contains("imageMetadata") &&
                    data.at("imageMetadata").is_object()) {
                    for (const auto* key : {"width", "height", "hasAlpha", "orientation"})
                        entry[key] = data.at("imageMetadata").at(key);
                }
                outputs.push_back(std::move(entry));
                continue;
            }
            if ((classification == "audio" || classification == "video") &&
                !native_probe_asset_media(source, classification))
                return fail("FFmpeg could not decode the first media sample or frame: " + filename);
            std::optional<Json> image;
            if (classification == "image") {
                image = native_image_metadata(source);
                if (!image)
                    return fail("Native image decoding failed: " + filename);
            }
            if (classification == "font") {
                const auto font_request = Json{{"path", utf8(source)}}.dump();
                std::vector<std::uint8_t> buffer(8192);
                const auto size = noveltea_tooling_inspect_font_json(
                    reinterpret_cast<const std::uint8_t*>(font_request.data()), font_request.size(),
                    buffer.data(), buffer.size());
                if (!size || size > buffer.size())
                    return fail("Native font inspection failed: " + filename);
                const auto inspected =
                    Json::parse(buffer.begin(), buffer.begin() + static_cast<std::ptrdiff_t>(size),
                                nullptr, false);
                if (!inspected.is_object() || !inspected.value("ok", false))
                    return fail("Font is not a usable Unicode face: " + filename);
            }
            const auto bytes = read_reliable(source);
            if (!bytes)
                return fail("Asset source changed during physical inspection: " + filename);
            if (bytes->empty())
                return fail("Asset import source cannot be empty: " + filename);
            const auto revision = exact_source_revision(*bytes);
            if (generated && (metadata["byteSize"].get<std::size_t>() != bytes->size() ||
                              metadata["contentHash"].get<std::string>() != revision ||
                              metadata["mimeType"].get<std::string>() != mime(from_utf8(filename)) ||
                              !image || metadata["width"] != (*image)["width"] ||
                              metadata["height"] != (*image)["height"]))
                return fail("Generated Asset bytes or image metadata changed before publication.");
            // ComfyUI's image contract reports the presence of an alpha channel,
            // including fully opaque RGBA PNGs. Native image inspection instead
            // reports whether any decoded pixel is translucent. Keep the verified
            // ComfyUI channel semantics for persisted generated Asset metadata;
            // native decoding still proves the image and its dimensions.
            if (generated)
                (*image)["hasAlpha"] = metadata["hasAlpha"];
            auto id = slug(filename);
            const auto base = id;
            for (unsigned suffix = 2; occupied_ids.contains(id); ++suffix)
                id = base + "-" + std::to_string(suffix);
            occupied_ids.insert(id);
            if (!internal) {
                auto extension = source.extension().string();
                std::transform(extension.begin(), extension.end(), extension.begin(),
                               [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
                const std::map<std::string, std::string> directories{
                    {"image", "images"}, {"font", "fonts"}, {"audio", "audio"},  {"video", "video"},
                    {"text", "text"},    {"data", "data"},  {"binary", "binary"}};
                const auto folder = generated ? "assets/generated/"
                                              : "assets/" + directories.at(classification) + "/";
                for (unsigned suffix = 1;; ++suffix) {
                    const auto candidate = folder + base +
                                           (suffix == 1 ? "" : "-" + std::to_string(suffix)) +
                                           extension;
                    if (!fs::exists(real_root / candidate) &&
                        !fs::is_symlink(fs::symlink_status(real_root / candidate)) &&
                        !planned_destinations.contains(candidate)) {
                        asset_path = candidate;
                        planned_destinations.insert(candidate);
                        break;
                    }
                }
            }
            const auto record_path = "records/assets/" + id + ".yaml";
            const auto stem = filename.substr(0, filename.find_last_of('.'));
            const auto label = generated ? request["workflow"]["label"].get<std::string>() + " " +
                                               item["outputId"].get<std::string>()
                                         : stem;
            const auto original = generated ? "comfyui:" +
                                                  request["workflow"]["id"].get<std::string>() +
                                                  ":" + request["promptId"].get<std::string>()
                                            : utf8(source);
            auto yaml = import_yaml(id, label, classification, asset_path, filename, original,
                                    revision, bytes->size(), image);
            const auto opened = open_yaml_source(yaml);
            if (!opened.accepted || !validate_asset_source(opened.source_json).accepted)
                return fail("Native Asset source schema rejected generated metadata: " + filename);
            Json entry{{"assetId", id},
                       {"projectRelativePath", asset_path},
                       {"kind", classification},
                       {"contentHash", revision},
                       {"alreadyImported", false}};
            if (generated)
                entry["outputId"] = item["outputId"];
            if (image) {
                for (const auto* key : {"width", "height", "hasAlpha", "orientation"})
                    entry[key] = image->at(key);
            }
            outputs.push_back(std::move(entry));
            planned.push_back({source, std::move(*bytes), id, asset_path, record_path,
                               std::move(yaml), classification, image, !internal});
        }
        Json success{{"ok", true},
                     {"diagnostics", Json::array()},
                     {"fields", {{"dryRun", dry_run}, {"assets", outputs}}}};
        if (dry_run || planned.empty())
            return success;

        const auto meta = real_root / ".noveltea";
        make_safe_project_directory(real_root, ".noveltea");
        ScopedDirectory lock;
        const auto mutex = meta / "asset-import.lock";
        if (!fs::create_directory(mutex))
            return fail("Another native Asset import is already committing this Project.");
        lock.path = mutex;
        {
            std::ofstream owner(mutex / "owner.json", std::ios::binary | std::ios::trunc);
            owner << Json{{"pid", current_process_id()}}.dump() << '\n';
            if (!owner)
                return fail("Cannot persist Asset import process ownership.");
        }
        if (!session.validate_project().valid)
            return fail("Project changed before native Asset import publication.");
        if (generated && request.contains("expectedSourceGeneration") &&
            native_project_source_generation(session, root) !=
                request["expectedSourceGeneration"].get<std::string>())
            return fail("Project source generation changed before native Asset publication.");
        ScopedDirectory staging;
        // Native Asset binary staging is *not* a YAML transaction journal.
        // YamlTransactionService owns .noveltea/transactions exclusively and
        // must never attempt to recover our staged byte buffers as YAML.
        const auto dir = meta / "asset-import-staging";
        make_safe_project_directory(real_root, ".noveltea/asset-import-staging");
        make_safe_project_directory(real_root, "records/assets");
        static std::atomic<std::uint64_t> sequence{0};
        const auto unique =
            std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()) + "-" +
            std::to_string(++sequence);
        const auto stage_path = dir / ("native-asset-import-" + unique);
        if (!fs::create_directory(stage_path))
            return fail("Cannot allocate exclusive native Asset staging directory.");
        staging.path = stage_path;
        std::vector<YamlTransactionTarget> targets;
        for (std::size_t i = 0; i < planned.size(); ++i) {
            const auto& item = planned[i];
            if (read_reliable(item.original) != item.original_bytes)
                return fail("Asset input changed after planning: " + utf8(item.original));
            targets.push_back({.path = item.record_path,
                               .expected_revision = "absent",
                               .baseline_source = {},
                               .edits = {},
                               .create_source = item.source_yaml,
                               .erase = false});
            if (!item.external)
                continue;
            std::ofstream output(staging.path / std::to_string(i),
                                 std::ios::binary | std::ios::trunc);
            output.write(item.original_bytes.data(),
                         static_cast<std::streamsize>(item.original_bytes.size()));
            if (!output)
                return fail("Cannot stage exact Asset bytes.");
        }
        // Write the immutable recovery intent *before* exposing a binary
        // target. If the process dies, recover_abandoned_import can decide
        // from exact committed YAML revisions whether to keep or undo bytes.
        Json journal{{"schema", "noveltea.native-asset-import"}, {"items", Json::array()}};
        for (const auto& item : planned)
            journal["items"].push_back(
                {{"recordPath", item.record_path},
                 {"recordRevision", exact_source_revision(item.source_yaml)},
                 {"assetPath", item.asset_path},
                 {"assetRevision", exact_source_revision(item.original_bytes)},
                 {"external", item.external}});
        {
            std::ofstream output(staging.path / "manifest.json",
                                 std::ios::binary | std::ios::trunc);
            output << journal.dump() << '\n';
            if (!output)
                return fail("Cannot persist Asset import recovery intent.");
        }
        YamlTransactionService writer(real_root);
        const auto prepared = writer.prepare(targets, TransactionDecision::KeepComments);
        if (!prepared.accepted)
            return fail(prepared.error);
        std::vector<fs::path> installed;
        bool recovery_uncertain = false;
        try {
            for (std::size_t i = 0; i < planned.size(); ++i) {
                if (!planned[i].external)
                    continue;
                const auto destination = real_root / planned[i].asset_path;
                const auto folder = destination.parent_path().lexically_relative(real_root);
                make_safe_project_directory(real_root, utf8(folder));
                if (fs::exists(destination) || fs::is_symlink(fs::symlink_status(destination)))
                    throw std::runtime_error("Asset target exists or escapes Project root.");
                // A hard-link from the same-filesystem staged copy installs
                // bytes atomically and fails if another actor won the path.
                fs::create_hard_link(staging.path / std::to_string(i), destination);
                installed.push_back(destination);
            }
            for (std::size_t i = 0; i < planned.size(); ++i) {
                if (!planned[i].external)
                    continue;
                const auto destination = real_root / planned[i].asset_path;
                if (exact_source_revision(bytes_at(destination)) !=
                    exact_source_revision(planned[i].original_bytes))
                    throw std::runtime_error("Asset output changed before YAML publication.");
            }
            // The remote job's admitted Project must still be authoritative at the
            // point of YAML acceptance, not merely when the owner began staging.
            // A concurrent edit to an unrelated source must not attach a new Asset
            // to an obsolete pinned Project generation.
            if (generated && request.contains("expectedSourceGeneration") &&
                native_project_source_generation(session, root) !=
                    request["expectedSourceGeneration"].get<std::string>())
                throw std::runtime_error(
                    "Project source generation changed during native Asset publication.");
            const auto committed = writer.commit(prepared, TransactionDecision::KeepComments);
            if (!committed.accepted) {
                const auto recovered = writer.recover();
                recovery_uncertain = !recovered.accepted;
                for (const auto& item : planned)
                    if (fs::exists(real_root / item.record_path))
                        recovery_uncertain = true;
                if (recovery_uncertain)
                    throw std::runtime_error(
                        "Native import YAML recovery could not prove rollback: " + committed.error);
                throw std::runtime_error(committed.error);
            }
            return success;
        } catch (const std::exception& error) {
            for (std::size_t i = 0; i < planned.size(); ++i) {
                if (!planned[i].external)
                    continue;
                const auto destination = real_root / planned[i].asset_path;
                if (!fs::exists(destination))
                    continue;
                if (!fs::is_regular_file(destination) ||
                    fs::is_symlink(fs::symlink_status(destination)) ||
                    !fs::equivalent(staging.path / std::to_string(i), destination) ||
                    exact_source_revision(bytes_at(destination)) !=
                        exact_source_revision(planned[i].original_bytes)) {
                    recovery_uncertain = true;
                    break;
                }
            }
            if (recovery_uncertain) {
                // Leave the exact binary copies and journal intact for
                // conservative recovery. Deleting them could orphan an Asset
                // record that a failed YAML journal had already installed.
                staging.path.clear();
                lock.path.clear();
                return fail(error.what());
            }
            for (const auto& destination : installed) {
                std::error_code ignored;
                fs::remove(destination, ignored);
            }
            return fail(error.what());
        }
    } catch (const std::exception& error) {
        return fail(error.what());
    }
}
