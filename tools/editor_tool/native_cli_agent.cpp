#include "native_cli_agent.hpp"
#include "native_agent_kit_generated.hpp"
#include "../project_authoring/yaml_codec.hpp"

#include <noveltea/core/player_bootstrap.hpp>
#include <miniz.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <array>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <cstdlib>
#include <optional>
#include <random>
#include <span>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>
#if defined(_WIN32)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <Windows.h>
#endif

namespace noveltea::cli {
namespace {
using Json = nlohmann::json;
namespace fs = std::filesystem;

constexpr std::string_view marker_start = "<!-- noveltea:managed-agent-bootstrap:start -->";
constexpr std::string_view marker_end = "<!-- noveltea:managed-agent-bootstrap:end -->";
constexpr std::string_view managed_block = R"(<!-- noveltea:managed-agent-bootstrap:start -->
<!-- DO NOT EDIT THIS BLOCK. -->
Before editing NovelTea project content:

1. Run `noveltea agent sync`.
2. Read `.noveltea/agent/GUIDE.md` and follow its routing to the focused generated docs for the task.

`.noveltea/agent/GUIDE.md` is the authoritative entrypoint for NovelTea authoring guidance.
`.noveltea/` is generated, ignored local state. Do not edit it as project source.
<!-- noveltea:managed-agent-bootstrap:end -->)";

std::string read_file(const fs::path& path)
{
    std::ifstream stream(path, std::ios::binary);
    if (!stream)
        throw std::runtime_error("Cannot read " + path.string());
    return {std::istreambuf_iterator<char>(stream), std::istreambuf_iterator<char>()};
}

void write_file(const fs::path& path, const std::string& contents)
{
    fs::create_directories(path.parent_path());
    std::ofstream stream(path, std::ios::binary | std::ios::trunc);
    if (!stream || !stream.write(contents.data(), static_cast<std::streamsize>(contents.size())) ||
        !stream.flush())
        throw std::runtime_error("Cannot write " + path.string());
    stream.close();
    if (!stream)
        throw std::runtime_error("Cannot close " + path.string());
}

void write_file_atomic(const fs::path& path, const std::string& contents)
{
    fs::create_directories(path.parent_path());
    std::random_device random;
    fs::path staged;
    for (int attempt = 0; attempt < 16; ++attempt) {
        const auto candidate = fs::path(path.string() + "." + std::to_string(random()) + "-" +
                                        std::to_string(random()) + ".tmp");
        std::error_code error;
        if (!fs::exists(candidate, error) && !error) {
            staged = candidate;
            break;
        }
    }
    if (staged.empty())
        throw std::runtime_error("Cannot reserve staged Agent Kit bootstrap file.");
    try {
        write_file(staged, contents);
#if defined(_WIN32)
        if (!MoveFileExW(staged.c_str(), path.c_str(),
                         MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH))
            throw std::runtime_error("Cannot atomically replace Agent Kit bootstrap file.");
#else
        fs::rename(staged, path);
#endif
    } catch (...) {
        std::error_code ignored;
        fs::remove(staged, ignored);
        throw;
    }
}

fs::file_status safe_status(const fs::path& path)
{
    std::error_code error;
    const auto status = fs::symlink_status(path, error);
    if (error == std::errc::no_such_file_or_directory)
        return fs::file_status(fs::file_type::not_found);
    if (error)
        throw fs::filesystem_error("Cannot inspect Agent Kit path", path, error);
    return status;
}

bool is_file(const fs::path& path) { return fs::is_regular_file(safe_status(path)); }

void require_regular_or_missing(const fs::path& path)
{
    const auto type = safe_status(path).type();
    if (type != fs::file_type::not_found && type != fs::file_type::regular)
        throw std::runtime_error(path.filename().string() + " must be a regular file.");
}

bool matches_source_record(const fs::path& file)
{
    if (!is_file(file) || file.extension() != ".yaml")
        return false;
    const auto decoded = authoring::open_yaml_source(read_file(file));
    if (!decoded.accepted)
        return false;
    const auto value = Json::parse(decoded.source_json, nullptr, false);
    if (!value.is_object() || value.value("id", Json()) != file.stem().string() ||
        !value.value("label", Json()).is_string() || !value.value("data", Json()).is_object())
        return false;
    const auto id = file.stem().string();
    if (id.empty() || !std::all_of(id.begin(), id.end(), [](unsigned char ch) {
            return (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch == '-';
        }))
        return false;
    // Generic id/label/data alone also occur in unrelated YAML catalogs.
    // Require a collection-specific authoring shape before counting evidence.
    const auto& data = value.at("data");
    const auto family = file.parent_path().filename().string();
    const std::array<std::pair<std::string_view, std::string_view>, 15> signatures{{
        {"animations", "motions"},
        {"archetypes", "instanceKind"},
        {"assets", "source"},
        {"characters", "profiles"},
        {"dialogues", "blocks"},
        {"interactables", "presentation"},
        {"interactions", "rules"},
        {"layouts", "source"},
        {"materials", "base"},
        {"rooms", "presentationSpace"},
        {"scenes", "events"},
        {"scripts", "source"},
        {"tests", "steps"},
        {"variables", "type"},
        {"verbs", "slots"},
    }};
    for (const auto& [collection, signature] : signatures)
        if (collection == family)
            return data.contains(std::string(signature));
    return false;
}

bool matches_context_source(const fs::path& file, std::string_view kind)
{
    if (!is_file(file))
        return false;
    const auto decoded = authoring::open_yaml_source(read_file(file));
    if (!decoded.accepted)
        return false;
    const auto value = Json::parse(decoded.source_json, nullptr, false);
    if (!value.is_object())
        return false;
    if (kind == "i18n")
        return value.value("sourceLocale", Json()).is_string() &&
               value.value("defaultLocale", Json()).is_string() &&
               value.value("locales", Json()).is_object();
    if (kind == "editor")
        return value.value("chapters", Json()).is_object() &&
               value.value("tags", Json()).is_object() &&
               value.value("recordMetadata", Json()).is_object();
    if (kind == "traits") {
        if (value.empty())
            return false;
        for (const auto& [id, trait] : value.items())
            if (trait.is_object() && trait.value("id", Json()) == id &&
                trait.value("ownerKinds", Json()).is_array() &&
                trait.value("properties", Json()).is_array())
                return true;
    }
    return false;
}

bool recognizable_manifest(const std::string& content, bool& newer)
{
    const auto parsed = authoring::open_yaml_source(content);
    if (parsed.accepted) {
        const auto value = Json::parse(parsed.source_json, nullptr, false);
        if (!value.is_object() || value.value("schema", Json()) != "noveltea.project.workspace")
            return false;
        if (value.contains("schemaVersion") && value["schemaVersion"].is_number_integer())
            newer = value["schemaVersion"].get<std::int64_t>() > 1;
        return true;
    }
    // A damaged document may still have an unambiguous top-level discriminator.
    // Do not interpret the rest of the manifest or default any schema version.
    std::istringstream lines(content.starts_with("\xef\xbb\xbf") ? content.substr(3) : content);
    std::string line;
    bool recognized = false;
    std::size_t schema_keys = 0;
    while (std::getline(lines, line)) {
        if (!line.empty() && line.back() == '\r')
            line.pop_back();
        const auto comment = line.find(" #");
        if (comment != std::string::npos)
            line.erase(comment);
        const auto end = line.find_last_not_of(" \t");
        if (end != std::string::npos)
            line.erase(end + 1);
        if (line.starts_with("schema:"))
            ++schema_keys;
        if (line == "schema: noveltea.project.workspace" ||
            line == "schema: 'noveltea.project.workspace'" ||
            line == "schema: \"noveltea.project.workspace\"")
            recognized = true;
        if (line.starts_with("schemaVersion: ")) {
            const auto version = line.substr(std::string_view("schemaVersion: ").size());
            if (!version.empty() &&
                std::all_of(version.begin(), version.end(),
                            [](unsigned char c) { return c >= '0' && c <= '9'; })) {
                try {
                    newer = std::stoll(version) > 1;
                } catch (const std::out_of_range&) {
                    newer = true;
                }
            }
        }
    }
    return recognized && schema_keys == 1;
}

std::string normal_lf(std::string text)
{
    for (std::size_t i = 0; (i = text.find("\r\n", i)) != std::string::npos;)
        text.replace(i, 2, "\n");
    return text;
}

std::string line_ending(const std::string& text)
{
    return text.find("\r\n") == std::string::npos ? "\n" : "\r\n";
}

std::string use_ending(std::string text, std::string_view ending)
{
    if (ending == "\n")
        return text;
    for (std::size_t i = 0; (i = text.find('\n', i)) != std::string::npos; i += 2)
        text.replace(i, 1, "\r\n");
    return text;
}

std::size_t occurrences(std::string_view text, std::string_view pattern)
{
    std::size_t count = 0;
    for (std::size_t pos = 0; (pos = text.find(pattern, pos)) != std::string_view::npos;
         pos += pattern.size())
        ++count;
    return count;
}

std::string inspect_bootstrap(const std::string* text)
{
    if (!text || (occurrences(*text, marker_start) == 0 && occurrences(*text, marker_end) == 0))
        return "missing";
    if (occurrences(*text, marker_start) != 1 || occurrences(*text, marker_end) != 1 ||
        text->find(marker_start) >= text->find(marker_end))
        return "malformed";
    const auto start = text->find(marker_start);
    const auto end = text->find(marker_end) + marker_end.size();
    return normal_lf(text->substr(start, end - start)) == managed_block ? "current" : "outdated";
}

std::string repair_bootstrap(const std::string* text, std::string_view status)
{
    if (status == "current")
        return *text;
    if (status == "malformed")
        throw std::runtime_error("NovelTea managed AGENTS.md markers require manual repair.");
    if (status == "outdated") {
        const auto start = text->find(marker_start);
        const auto end = text->find(marker_end) + marker_end.size();
        return text->substr(0, start) + use_ending(std::string(managed_block), line_ending(*text)) +
               text->substr(end);
    }
    const std::string contents = text ? *text : "";
    const auto bom = contents.starts_with("\xef\xbb\xbf") ? contents.substr(0, 3) : "";
    const auto body = contents.substr(bom.size());
    const auto ending = line_ending(body);
    const auto block = use_ending(std::string(managed_block), ending);
    if (body.find_first_not_of(" \t\r\n") == std::string::npos)
        return bom + "# NovelTea Project\n\n" + std::string(managed_block) + "\n";
    // Respect an existing top-level heading and preserve the rest verbatim.
    std::size_t offset = 0;
    while (offset < body.size() && (body[offset] == '\r' || body[offset] == '\n' ||
                                    body[offset] == ' ' || body[offset] == '\t'))
        offset = body.find_first_not_of(" \t\r\n", offset);
    if (offset != std::string::npos && body.compare(offset, 2, "# ") == 0) {
        const auto heading_end = body.find('\n', offset);
        if (heading_end == std::string::npos)
            return bom + body + ending + ending + block + ending;
        return bom + body.substr(0, heading_end + 1) + ending + block + ending +
               body.substr(heading_end + 1);
    }
    return bom + block + ending + ending + body;
}

Json embedded_payload()
{
    std::string buffer(native_agent_kit_uncompressed_size, '\0');
    mz_ulong size = static_cast<mz_ulong>(buffer.size());
    const auto result = mz_uncompress(reinterpret_cast<unsigned char*>(buffer.data()), &size,
                                      native_agent_kit_deflated.data(),
                                      static_cast<mz_ulong>(native_agent_kit_deflated.size()));
    if (result != MZ_OK || size != buffer.size())
        throw std::runtime_error("Embedded Agent Kit payload cannot be decompressed.");
    const auto payload = Json::parse(buffer);
    const auto& files = payload.at("files");
    const auto manifest = Json::parse(payload.at("manifestText").get<std::string>());
    const auto& hashes = manifest.at("files");
    if (!files.is_object() || !hashes.is_object() || files.size() != hashes.size())
        throw std::runtime_error("Embedded Agent Kit manifest has mismatched files.");
    for (const auto& [path, value] : files.items()) {
        const fs::path relative(path);
        if (relative.empty() || relative.is_absolute() || path.find('\\') != std::string::npos ||
            path.find(':') != std::string::npos ||
            std::any_of(relative.begin(), relative.end(),
                        [](const fs::path& part) { return part == ".." || part == "."; }) ||
            !value.is_string() || !hashes.contains(path))
            throw std::runtime_error("Embedded Agent Kit contains an invalid document path.");
        const auto& text = value.get_ref<const std::string&>();
        const auto hash = core::sha256_hex(std::as_bytes(std::span(text.data(), text.size())));
        if (hashes.at(path) != "sha256:" + hash)
            throw std::runtime_error("Embedded Agent Kit failed its hash validation.");
    }
    return payload;
}

bool kit_matches(const fs::path& root, const Json& payload)
{
    if (!fs::is_directory(safe_status(root)) || !is_file(root / "manifest.json") ||
        read_file(root / "manifest.json") != payload.at("manifestText").get<std::string>())
        return false;
    const auto& files = payload.at("files");
    std::size_t seen = 0;
    for (fs::recursive_directory_iterator it(root), end; it != end; ++it) {
        const auto relative = it->path().lexically_relative(root).generic_string();
        if (fs::is_symlink(it->symlink_status()))
            return false;
        if (it->is_directory())
            continue;
        if (!it->is_regular_file() || (relative != "manifest.json" && !files.contains(relative)))
            return false;
        ++seen;
    }
    if (seen != files.size() + 1)
        return false;
    for (const auto& [relative, value] : files.items())
        if (!is_file(root / relative) || read_file(root / relative) != value.get<std::string>())
            return false;
    return true;
}

void replace_kit(const fs::path& local, const Json& payload)
{
    const auto live = local / "agent";
    std::random_device random;
    fs::path stage, backup;
    for (int attempt = 0; attempt < 16; ++attempt) {
        const auto suffix = std::to_string(random()) + "-" + std::to_string(random());
        stage = local / (".agent-staging-" + suffix);
        backup = local / (".agent-backup-" + suffix);
        if (!fs::exists(safe_status(stage)) && !fs::exists(safe_status(backup)) &&
            fs::create_directory(stage))
            break;
        stage.clear();
    }
    if (stage.empty())
        throw std::runtime_error("Cannot reserve Agent Kit staging directory.");
    bool backed_up = false, activated = false;
    try {
        for (const auto& [relative, value] : payload.at("files").items())
            write_file(stage / relative, value.get<std::string>());
        write_file(stage / "manifest.json", payload.at("manifestText").get<std::string>());
        if (!kit_matches(stage, payload))
            throw std::runtime_error(
                "Generated NovelTea agent kit failed its embedded hash validation.");
        if (safe_status(live).type() != fs::file_type::not_found) {
            fs::rename(live, backup);
            backed_up = true;
        }
        if (const char* certify = std::getenv("NOVELTEA_CLI_CERTIFICATION");
            certify && std::string_view(certify) == "1") {
            if (const char* fail = std::getenv("NOVELTEA_AGENT_CERTIFY_SWAP_FAILURE");
                fail && std::string_view(fail) == "1")
                throw std::runtime_error("Injected Agent Kit swap failure.");
        }
        fs::rename(stage, live);
        activated = true;
        if (!kit_matches(live, payload))
            throw std::runtime_error("Activated NovelTea agent kit failed validation.");
        if (backed_up)
            fs::remove_all(backup);
    } catch (...) {
        if (activated)
            fs::remove_all(live);
        if (backed_up)
            fs::rename(backup, live);
        fs::remove_all(stage);
        throw;
    }
}
} // namespace

RepairCandidateEvidence inspect_repair_candidate(const fs::path& root)
{
    RepairCandidateEvidence evidence;
    const auto manifest = root / "project.yaml";
    const bool has_manifest = is_file(manifest);
    if (has_manifest &&
        recognizable_manifest(read_file(manifest), evidence.newer_workspace_version))
        evidence.sources.push_back("project.yaml");

    const auto agents = root / "AGENTS.md";
    if (is_file(agents)) {
        const auto content = read_file(agents);
        const auto status = inspect_bootstrap(&content);
        const auto start = content.find(marker_start);
        const auto end = content.find(marker_end);
        const auto managed = start == std::string::npos || end == std::string::npos
                                 ? std::string{}
                                 : content.substr(start, end - start);
        if ((status == "current" || status == "outdated") &&
            (managed.find("noveltea agent sync") != std::string::npos ||
             managed.find(".noveltea/agent/GUIDE.md") != std::string::npos))
            evidence.sources.push_back("AGENTS.md");
    }
    if (!evidence.sources.empty()) {
        evidence.recognition = "strong";
        return evidence;
    }

    // Source recognition requires parsed, canonical content, not the presence
    // of a directory, filename, or an unrelated Project's symlink target.
    for (const auto& [relative, kind] :
         std::array<std::pair<const char*, const char*>, 3>{{{"i18n/project.yaml", "i18n"},
                                                             {"editor.yaml", "editor"},
                                                             {"traits.yaml", "traits"}}}) {
        if (std::string_view(kind) == "i18n" && !fs::is_directory(safe_status(root / "i18n")))
            continue;
        if (matches_context_source(root / relative, kind))
            evidence.sources.emplace_back(relative);
    }
    if (evidence.sources.size() >= 2) {
        evidence.recognition = "strong";
        return evidence;
    }
    const auto records = root / "records";
    if (fs::is_directory(safe_status(records))) {
        for (const auto* collection :
             {"animations", "archetypes", "assets", "characters", "dialogues", "interactables",
              "interactions", "layouts", "materials", "rooms", "scenes", "scripts", "tests",
              "variables", "verbs"}) {
            const auto folder = records / collection;
            if (!fs::is_directory(safe_status(folder)))
                continue;
            std::vector<fs::path> candidates;
            for (const auto& entry : fs::directory_iterator(folder))
                if (entry.path().extension() == ".yaml" && is_file(entry.path()))
                    candidates.push_back(entry.path());
            std::sort(candidates.begin(), candidates.end());
            for (const auto& path : candidates) {
                if (matches_source_record(path))
                    evidence.sources.push_back(path.lexically_relative(root).generic_string());
                if (evidence.sources.size() >= 2)
                    break;
            }
            if (evidence.sources.size() >= 2)
                break;
        }
    }
    evidence.recognition = evidence.sources.size() >= 2 ? "strong" : has_manifest ? "weak" : "none";
    return evidence;
}

AgentSyncResult sync_native_agent_kit(const fs::path& root, bool fix)
{
    AgentSyncResult result;
    const auto agents_path = root / "AGENTS.md";
    const auto local = root / ".noveltea";
    const auto live = local / "agent";
    const auto ignore = root / ".gitignore";
    // Inspect every owned target before the first write. Other Project source
    // symlinks are irrelevant to Agent Kit preparation and are not traversed.
    require_regular_or_missing(agents_path);
    require_regular_or_missing(ignore);
    if (fs::is_symlink(safe_status(local)) ||
        (fs::exists(safe_status(local)) && !fs::is_directory(safe_status(local))))
        throw std::runtime_error(".noveltea must be a real directory.");
    const auto live_type = safe_status(live).type();
    if (live_type != fs::file_type::not_found && live_type != fs::file_type::directory)
        throw std::runtime_error(".noveltea/agent must be a real directory.");
    const auto agents =
        is_file(agents_path) ? std::optional(read_file(agents_path)) : std::optional<std::string>{};
    result.bootstrap_status = inspect_bootstrap(agents ? &*agents : nullptr);
    if (fix && result.bootstrap_status == "malformed")
        throw std::runtime_error(
            "NovelTea managed AGENTS.md markers are malformed and require manual repair.");
    const auto revised =
        fix ? repair_bootstrap(agents ? &*agents : nullptr, result.bootstrap_status)
            : std::string{};
    const auto payload = embedded_payload();
    fs::create_directories(local);
    result.changed = !kit_matches(live, payload);
    if (result.changed)
        replace_kit(local, payload);
    if (fix && (!agents || *agents != revised)) {
        write_file_atomic(agents_path, revised);
        result.bootstrap_changed = true;
    }
    result.guide = live / "GUIDE.md";
    result.manifest = live / "manifest.json";
    if (!is_file(ignore)) {
        write_file_atomic(ignore, "/.noveltea/\n/dist/\n");
        result.gitignore_status = "created";
    } else {
        const auto text = read_file(ignore);
        result.gitignore_status =
            text.find(".noveltea") != std::string::npos && text.find("dist") != std::string::npos
                ? "present"
                : "missing-rule";
    }
    return result;
}
} // namespace noveltea::cli
