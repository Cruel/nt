#include "native_cli_agent.hpp"
#include "native_agent_kit_generated.hpp"

#include <noveltea/core/player_bootstrap.hpp>
#include <miniz.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <optional>
#include <random>
#include <span>
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

AgentSyncResult sync_native_agent_kit(const fs::path& root, bool fix)
{
    AgentSyncResult result;
    const auto agents_path = root / "AGENTS.md";
    if (fs::is_directory(safe_status(agents_path)) || fs::is_symlink(safe_status(agents_path)))
        throw std::runtime_error("AGENTS.md must be a regular file.");
    const auto agents =
        is_file(agents_path) ? std::optional(read_file(agents_path)) : std::optional<std::string>{};
    result.bootstrap_status = inspect_bootstrap(agents ? &*agents : nullptr);
    if (fix && result.bootstrap_status == "malformed")
        throw std::runtime_error(
            "NovelTea managed AGENTS.md markers are malformed and require manual repair.");
    if (fix) {
        const auto revised = repair_bootstrap(agents ? &*agents : nullptr, result.bootstrap_status);
        if (!agents || *agents != revised) {
            write_file_atomic(agents_path, revised);
            result.bootstrap_changed = true;
        }
    }
    const auto payload = embedded_payload();
    const auto local = root / ".noveltea";
    if (fs::is_symlink(safe_status(local)) ||
        (fs::exists(safe_status(local)) && !fs::is_directory(safe_status(local))))
        throw std::runtime_error(".noveltea must be a real directory.");
    fs::create_directories(local);
    const auto live = local / "agent";
    result.changed = !kit_matches(live, payload);
    if (result.changed)
        replace_kit(local, payload);
    result.guide = live / "GUIDE.md";
    result.manifest = live / "manifest.json";
    const auto ignore = root / ".gitignore";
    if (fs::is_symlink(safe_status(ignore)) || fs::is_directory(safe_status(ignore)))
        throw std::runtime_error(".gitignore must be a regular file.");
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
