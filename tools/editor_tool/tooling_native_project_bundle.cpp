#include "tooling_native_project_bundle.hpp"

#include "tooling_native_c.h"
#include "../project_authoring/room_session.hpp"
#include "../project_authoring/source_authority.hpp"

#include <miniz/miniz.h>

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <fstream>
#include <iterator>
#include <limits>
#include <map>
#include <set>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace {
using Json = nlohmann::json;
using Ordered = nlohmann::ordered_json;
using namespace noveltea::authoring;

Json failure(std::string message) { return {{"ok", false}, {"error", std::move(message)}}; }

std::filesystem::path utf8_path(std::string_view value)
{
    return std::filesystem::path(std::u8string(value.begin(), value.end()));
}

std::string utf8_string(const std::filesystem::path& value)
{
    const auto text = value.generic_u8string();
    return {reinterpret_cast<const char*>(text.data()), text.size()};
}

std::string bytes_at(const std::filesystem::path& path)
{
    std::ifstream input(path, std::ios::binary);
    if (!input)
        throw std::runtime_error("Portable Project source cannot be read: " + path.string());
    const std::string bytes{std::istreambuf_iterator<char>(input),
                            std::istreambuf_iterator<char>()};
    if (input.bad())
        throw std::runtime_error("Portable Project source read failed: " + path.string());
    return bytes;
}

void write_bytes(const std::filesystem::path& path, std::string_view value)
{
    std::filesystem::create_directories(path.parent_path());
    std::ofstream output(path, std::ios::binary | std::ios::trunc);
    if (!output.write(value.data(), static_cast<std::streamsize>(value.size())))
        throw std::runtime_error("Portable Project staged source write failed.");
}

bool safe_path(std::string_view name)
{
    if (name.empty() || name.front() == '/' || name.find('\\') != std::string_view::npos ||
        name.find('\0') != std::string_view::npos || (name.size() >= 2 && name[1] == ':'))
        return false;
    for (std::size_t start = 0; start <= name.size();) {
        const auto end = name.find('/', start);
        const auto segment =
            name.substr(start, (end == std::string_view::npos ? name.size() : end) - start);
        if (segment.empty() || segment == "." || segment == "..")
            return false;
        if (end == std::string_view::npos)
            break;
        start = end + 1;
    }
    return true;
}

bool excluded(std::string_view relative)
{
    if (!safe_path(relative))
        return true;
    std::string lower(relative);
    std::transform(lower.begin(), lower.end(), lower.begin(),
                   [](unsigned char c) { return c >= 'A' && c <= 'Z' ? c - 'A' + 'a' : c; });
    const auto first = lower.substr(0, lower.find('/'));
    if (first == "dist" || first == ".gitignore" || first == ".gitattributes" ||
        first == ".gitmodules")
        return true;
    for (std::size_t at = 0; at < lower.size();) {
        const auto end = lower.find('/', at);
        const auto segment = lower.substr(at, (end == std::string::npos ? lower.size() : end) - at);
        if (segment == ".git" || segment == ".hg" || segment == ".svn" || segment == ".noveltea")
            return true;
        if (end == std::string::npos)
            break;
        at = end + 1;
    }
    return false;
}

bool ntproject_extension(const std::filesystem::path& file)
{
    auto name = utf8_string(file.filename());
    std::transform(name.begin(), name.end(), name.begin(),
                   [](unsigned char c) { return c >= 'A' && c <= 'Z' ? c - 'A' + 'a' : c; });
    return name.ends_with(".ntproject");
}

std::filesystem::path checked_source(const std::filesystem::path& root, std::string_view relative)
{
    if (excluded(relative) || relative == "ntproject.json")
        throw std::runtime_error("Project source is not portable: " + std::string(relative));
    const auto path = root / utf8_path(relative);
    if (!std::filesystem::is_regular_file(path))
        throw std::runtime_error("Portable Project source is missing: " + std::string(relative));
    const auto resolved = std::filesystem::canonical(path);
    const auto within = resolved.lexically_relative(std::filesystem::canonical(root));
    if (within.empty() || within == ".." || *within.begin() == "..")
        throw std::runtime_error("Portable Project source escapes the Project root.");
    return path;
}

void project_paths(const Json& effective, const ProjectSession& session,
                   const std::filesystem::path& root, std::set<std::string>& files)
{
    for (const auto& source : session.file_inventory()) {
        if (source.kind == ProjectFileKind::TrackedSource ||
            (source.kind == ProjectFileKind::ProjectSource && source.path.starts_with("scripts/")))
            files.insert(source.path);
    }
    const auto& settings = effective.at("settings");
    if (settings.contains("distributionNotices"))
        for (const auto& notice : settings.at("distributionNotices"))
            files.insert(notice.at("path").get<std::string>());
    const auto& assets = effective.at("assets");
    for (const auto& [_, record] : assets.items()) {
        const auto& data = record.at("data");
        files.insert(data.at("source").at("path").get<std::string>());
        if (data.contains("attachments"))
            for (const auto& attachment : data.at("attachments"))
                files.insert(attachment.at("path").get<std::string>());
    }
    for (const auto& [_, record] : effective.at("layouts").items())
        if (record.at("data").contains("dependencies"))
            for (const auto& script : record.at("data").at("dependencies").at("scripts"))
                files.insert(script.get<std::string>());
    for (const auto& [_, record] : effective.at("materials").items()) {
        const auto& data = record.at("data");
        if (!data.contains("shader") || !data.at("shader").is_object())
            continue;
        for (const auto* stage : {"vertex", "fragment", "varying"}) {
            if (!data.at("shader").contains(stage))
                continue;
            const auto& source = data.at("shader").at(stage);
            if (source.is_object() && source.value("kind", std::string{}) == "project")
                files.insert(source.at("path").get<std::string>());
        }
    }
    const auto workflows = root / "workflows";
    if (std::filesystem::exists(workflows)) {
        if (!std::filesystem::is_directory(workflows))
            throw std::runtime_error("Portable Project workflows root is not a directory.");
        for (auto cursor = std::filesystem::recursive_directory_iterator(workflows);
             cursor != std::filesystem::recursive_directory_iterator{}; ++cursor) {
            const auto& entry = *cursor;
            const auto relative = entry.path().lexically_relative(root).generic_string();
            if (excluded(relative)) {
                if (entry.is_directory())
                    cursor.disable_recursion_pending();
                continue;
            }
            if (entry.is_regular_file())
                files.insert(relative);
            else if (!entry.is_directory())
                throw std::runtime_error("Portable Project workflow contains an unsafe entry.");
        }
    }
    for (const auto& relative : files)
        (void)checked_source(root, relative);
}

Json complete_project(ProjectSession& session)
{
    const auto validated = session.validate_project();
    if (!validated.valid)
        throw std::runtime_error("Cannot prepare an invalid native Project.");
    const auto prepared = session.prepare_working(session.snapshot().working_revision);
    if (!prepared.accepted)
        throw std::runtime_error(prepared.error);
    Json effective = Json::parse(prepared.project_json);
    for (const auto& [owner, snapshot] : session.validated_disk_record_snapshots()) {
        if (!snapshot.valid || snapshot.normalized_json.empty())
            throw std::runtime_error("A validated Project contains an invalid native owner.");
        if (owner == "traits" || owner == "editor") {
            effective[owner] = Json::parse(snapshot.normalized_json);
            continue;
        }
        const auto slash = owner.find('/');
        if (slash == std::string::npos || owner.starts_with("i18n/"))
            continue;
        const auto family = owner.substr(0, slash);
        const auto id = owner.substr(slash + 1);
        if (!effective.contains(family))
            effective[family] = Json::object();
        effective[family][id] = Json::parse(snapshot.normalized_json);
    }
    return effective;
}

struct TempDirectory {
    std::filesystem::path root;
    explicit TempDirectory(const std::filesystem::path& destination, std::string_view operation)
    {
        const auto parent = destination.parent_path();
        std::filesystem::create_directories(parent);
        for (std::uint64_t count = 0; count < 1000; ++count) {
            root = parent /
                   (".noveltea-" + std::string(operation) + "-" +
                    std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()) +
                    "-" + std::to_string(count));
            std::error_code error;
            if (std::filesystem::create_directory(root, error))
                return;
            if (error && error != std::errc::file_exists)
                throw std::runtime_error("Cannot stage portable Project transaction.");
        }
        throw std::runtime_error("Cannot allocate portable Project staging directory.");
    }
    ~TempDirectory()
    {
        std::error_code ignored;
        std::filesystem::remove_all(root, ignored);
    }
};

Json create_archive(const Json& request)
{
    const auto text = request.dump();
    std::vector<std::uint8_t> response(16 * 1024);
    const auto size =
        noveltea_tooling_create_archive_json(reinterpret_cast<const std::uint8_t*>(text.data()),
                                             text.size(), response.data(), response.size());
    if (size > response.size())
        return failure("Native portable archive result exceeds the response limit.");
    return Json::parse(response.begin(), response.begin() + static_cast<std::ptrdiff_t>(size));
}

Json export_bundle(const Json& request, ProjectSession& session, const std::filesystem::path& root)
{
    if (!request.contains("outputPath") || !request.at("outputPath").is_string())
        return failure("Portable Project export requires an outputPath.");
    const auto output = utf8_path(request.at("outputPath").get<std::string>());
    if (!output.is_absolute() || !ntproject_extension(output))
        return failure("Portable Project export requires an absolute .ntproject destination.");
    if (std::filesystem::exists(output) || std::filesystem::is_symlink(output))
        return failure("Portable Project bundle destination already exists.");
    const auto effective = complete_project(session);
    std::set<std::string> paths;
    project_paths(effective, session, root, paths);
    Ordered manifest{
        {"schema", "noveltea.project.bundle"},
        {"version", 1},
        {"workspace", Ordered{{"schema", "noveltea.project.workspace"}, {"version", 1}}},
        {"project", Ordered{{"id", effective.at("project").at("id")},
                            {"name", effective.at("project").at("name")}}},
        {"files", Ordered::array()}};
    std::map<std::string, std::string> revisions;
    for (const auto& relative : paths) {
        const auto source = checked_source(root, relative);
        const auto bytes = bytes_at(source);
        const auto revision = exact_source_revision(bytes);
        manifest["files"].push_back(
            Ordered{{"path", relative}, {"size", bytes.size()}, {"sha256", revision}});
        revisions.emplace(relative, revision);
    }
    TempDirectory stage(output, "bundle");
    const auto manifest_path = stage.root / "ntproject.json";
    write_bytes(manifest_path, manifest.dump(2) + "\n");
    Json entries = Json::array();
    entries.push_back({{"sourcePath", utf8_string(manifest_path)},
                       {"archivePath", "ntproject.json"},
                       {"size", std::filesystem::file_size(manifest_path)},
                       {"mode", 0644}});
    for (const auto& relative : paths)
        entries.push_back({{"sourcePath", utf8_string(checked_source(root, relative))},
                           {"archivePath", relative},
                           {"size", std::filesystem::file_size(root / relative)},
                           {"mode", 0644}});
    const auto staged = stage.root / "bundle.ntproject";
    const auto archive = create_archive({{"outputPath", utf8_string(staged)},
                                         {"format", "zip"},
                                         {"compression", "store"},
                                         {"entries", entries}});
    if (!archive.value("ok", false))
        return failure(archive.value("error", "Native ZIP export failed."));
    for (const auto& [relative, expected] : revisions)
        if (exact_source_revision(bytes_at(checked_source(root, relative))) != expected)
            return failure("Portable Project source changed during export: " + relative);
    if (std::filesystem::exists(output) || std::filesystem::is_symlink(output))
        return failure("Portable Project destination changed during export.");
    std::filesystem::rename(staged, output);
    return {{"ok", true}, {"outputPath", utf8_string(output)}, {"manifest", Json(manifest)}};
}

std::uint16_t u16(std::string_view bytes, std::size_t index)
{
    if (index > bytes.size() || bytes.size() - index < 2)
        throw std::runtime_error("Portable ZIP is truncated.");
    return static_cast<unsigned char>(bytes[index]) |
           (static_cast<std::uint16_t>(static_cast<unsigned char>(bytes[index + 1])) << 8);
}

std::uint32_t u32(std::string_view bytes, std::size_t index)
{
    return static_cast<std::uint32_t>(u16(bytes, index)) |
           (static_cast<std::uint32_t>(u16(bytes, index + 2)) << 16);
}

void verify_utf8(std::string_view text)
{
    for (std::size_t index = 0; index < text.size();) {
        const auto lead = static_cast<unsigned char>(text[index]);
        const auto width = lead < 0x80                    ? 1u
                           : lead >= 0xc2 && lead <= 0xdf ? 2u
                           : lead >= 0xe0 && lead <= 0xef ? 3u
                           : lead >= 0xf0 && lead <= 0xf4 ? 4u
                                                          : 0u;
        if (!width || index + width > text.size())
            throw std::runtime_error("Portable ZIP path is not canonical UTF-8.");
        if (width > 1) {
            const auto second = static_cast<unsigned char>(text[index + 1]);
            if ((second & 0xc0) != 0x80 || (lead == 0xe0 && second < 0xa0) ||
                (lead == 0xed && second >= 0xa0) || (lead == 0xf0 && second < 0x90) ||
                (lead == 0xf4 && second >= 0x90))
                throw std::runtime_error("Portable ZIP path is not canonical UTF-8.");
            for (unsigned int i = 2; i < width; ++i)
                if ((static_cast<unsigned char>(text[index + i]) & 0xc0) != 0x80)
                    throw std::runtime_error("Portable ZIP path is not canonical UTF-8.");
        }
        index += width;
    }
}

struct ArchiveFile {
    std::string path;
    std::string data;
};

std::vector<ArchiveFile> parse_zip(std::string_view bytes)
{
    if (bytes.size() < 22)
        throw std::runtime_error("Portable ZIP is truncated.");
    const auto floor = bytes.size() > 65557 ? bytes.size() - 65557 : 0;
    auto end = bytes.size();
    for (std::size_t index = bytes.size() - 22;; --index) {
        if (u32(bytes, index) == 0x06054b50u) {
            end = index;
            break;
        }
        if (index == floor)
            break;
    }
    if (end == bytes.size() || u16(bytes, end + 4) != 0 || u16(bytes, end + 6) != 0 ||
        u16(bytes, end + 8) != u16(bytes, end + 10) || u16(bytes, end + 20) != 0 ||
        end + 22 != bytes.size())
        throw std::runtime_error("Portable ZIP has an unsupported central directory.");
    const auto count = u16(bytes, end + 10);
    const auto central_start = static_cast<std::size_t>(u32(bytes, end + 16));
    const auto central_size = static_cast<std::size_t>(u32(bytes, end + 12));
    if (central_start > end || central_size != end - central_start)
        throw std::runtime_error("Portable ZIP central directory bounds are invalid.");
    std::vector<ArchiveFile> files;
    std::set<std::string> seen;
    auto cursor = central_start;
    for (std::size_t i = 0; i < count; ++i) {
        if (u32(bytes, cursor) != 0x02014b50u || u16(bytes, cursor + 8) != 0x0808u ||
            u16(bytes, cursor + 10) != 0 || u32(bytes, cursor + 20) != u32(bytes, cursor + 24) ||
            u16(bytes, cursor + 30) != 0 || u16(bytes, cursor + 32) != 0 ||
            u16(bytes, cursor + 34) != 0 ||
            ((u32(bytes, cursor + 38) >> 16) & 0170000u) != 0100000u)
            throw std::runtime_error("Portable ZIP contains unsupported entry headers.");
        const auto size = static_cast<std::size_t>(u32(bytes, cursor + 24));
        const auto name_size = static_cast<std::size_t>(u16(bytes, cursor + 28));
        const auto name_start = cursor + 46;
        if (name_start > end || name_size > end - name_start)
            throw std::runtime_error("Portable ZIP directory entry is truncated.");
        const std::string path(bytes.substr(name_start, name_size));
        verify_utf8(path);
        if (!safe_path(path) || !seen.insert(path).second)
            throw std::runtime_error("Portable ZIP has unsafe or duplicate paths.");
        const auto local = static_cast<std::size_t>(u32(bytes, cursor + 42));
        if (u32(bytes, local) != 0x04034b50u || u16(bytes, local + 6) != 0x0808u ||
            u16(bytes, local + 8) != 0 || u16(bytes, local + 26) != name_size ||
            u16(bytes, local + 28) != 0)
            throw std::runtime_error("Portable ZIP local headers disagree.");
        const auto local_name = local + 30;
        if (local_name > central_start || name_size > central_start - local_name ||
            bytes.substr(local_name, name_size) != path)
            throw std::runtime_error("Portable ZIP local entry path mismatch.");
        const auto data_start = local_name + name_size;
        if (data_start > central_start || size > central_start - data_start ||
            central_start - (data_start + size) < 16)
            throw std::runtime_error("Portable ZIP data descriptor is truncated.");
        const auto data_end = data_start + size;
        if (u32(bytes, data_end) != 0x08074b50u ||
            u32(bytes, data_end + 4) != u32(bytes, cursor + 16) ||
            u32(bytes, data_end + 8) != size || u32(bytes, data_end + 12) != size)
            throw std::runtime_error("Portable ZIP data descriptor disagrees.");
        const auto data = bytes.substr(data_start, size);
        const auto crc = mz_crc32(MZ_CRC32_INIT,
                                  reinterpret_cast<const unsigned char*>(data.data()), data.size());
        if (crc != u32(bytes, cursor + 16))
            throw std::runtime_error("Portable ZIP entry CRC does not match.");
        files.push_back({path, std::string(data)});
        cursor = name_start + name_size;
    }
    if (cursor != end)
        throw std::runtime_error("Portable ZIP central directory has trailing data.");
    return files;
}

Json import_bundle(const Json& request)
{
    if (!request.contains("bundlePath") || !request.at("bundlePath").is_string() ||
        !request.contains("destination") || !request.at("destination").is_string())
        return failure("Native Project import requires bundlePath and destination.");
    const auto input = utf8_path(request.at("bundlePath").get<std::string>());
    const auto destination = utf8_path(request.at("destination").get<std::string>());
    if (!input.is_absolute() || !destination.is_absolute() || !ntproject_extension(input) ||
        !std::filesystem::is_regular_file(input))
        return failure("Native Project import requires an existing absolute .ntproject source.");
    if (std::filesystem::exists(destination) || std::filesystem::is_symlink(destination))
        return failure("Portable Project import destination already exists.");
    const auto files = parse_zip(bytes_at(input));
    const auto found = std::find_if(files.begin(), files.end(),
                                    [](const auto& file) { return file.path == "ntproject.json"; });
    if (found == files.end())
        return failure("Portable Project archive is missing its manifest.");
    const auto manifest = Json::parse(found->data, nullptr, false);
    const auto string_field = [](const Json& data, std::string_view key) {
        return data.is_object() && data.contains(key) && data.at(key).is_string();
    };
    const auto version_one = [](const Json& data) {
        return data.is_object() && data.contains("version") &&
               data.at("version").is_number_integer() && data.at("version") == 1;
    };
    if (!manifest.is_object() || manifest.size() != 5 || !string_field(manifest, "schema") ||
        manifest.at("schema") != "noveltea.project.bundle" || !version_one(manifest) ||
        !manifest.contains("workspace") || !manifest.at("workspace").is_object() ||
        manifest.at("workspace").size() != 2 || !string_field(manifest.at("workspace"), "schema") ||
        manifest.at("workspace").at("schema") != "noveltea.project.workspace" ||
        !version_one(manifest.at("workspace")) || !manifest.contains("project") ||
        !manifest.at("project").is_object() || manifest.at("project").size() != 2 ||
        !manifest.at("project").contains("id") || !manifest.at("project").at("id").is_string() ||
        manifest.at("project").at("id").get<std::string>().empty() ||
        !manifest.at("project").contains("name") ||
        !manifest.at("project").at("name").is_string() ||
        manifest.at("project").at("name").get<std::string>().empty() ||
        !manifest.contains("files") || !manifest.at("files").is_array() ||
        manifest.at("files").size() + 1 != files.size())
        return failure("Portable Project bundle identity or shape is unsupported.");
    const auto& declared = manifest.at("files");
    std::map<std::string, std::string> data;
    for (const auto& entry : files)
        if (entry.path != "ntproject.json")
            data.emplace(entry.path, entry.data);
    std::string previous;
    for (const auto& entry : declared) {
        if (!entry.is_object() || entry.size() != 3 || !entry.contains("path") ||
            !entry.at("path").is_string() || !entry.contains("size") ||
            !entry.at("size").is_number_unsigned() || !entry.contains("sha256") ||
            !entry.at("sha256").is_string())
            return failure("Portable Project bundle has malformed manifest file entries.");
        const auto relative = entry.at("path").get<std::string>();
        if (excluded(relative) || relative == "ntproject.json" ||
            (!previous.empty() && previous >= relative) || !data.contains(relative) ||
            entry.at("size").get<std::size_t>() != data.at(relative).size() ||
            entry.at("sha256").get<std::string>() != exact_source_revision(data.at(relative)))
            return failure("Portable Project bundle manifest inventory is corrupt or unsafe.");
        previous = relative;
    }
    TempDirectory stage(destination, "import");
    for (const auto& [relative, value] : data)
        write_bytes(stage.root / utf8_path(relative), value);
    for (const auto* directory : {"records", "scripts", "assets"})
        std::filesystem::create_directories(stage.root / directory);
    std::string error;
    auto session = ProjectSession::open(stage.root, error);
    if (!session)
        return failure("Contained Project Workspace cannot be admitted: " + error);
    const auto project = complete_project(*session);
    if (project.at("project").at("id") != manifest.at("project").at("id") ||
        project.at("project").at("name") != manifest.at("project").at("name"))
        return failure("Portable Project bundle identity differs from its Project sources.");
    std::set<std::string> expected;
    project_paths(project, *session, stage.root, expected);
    if (expected.size() != data.size() ||
        !std::equal(expected.begin(), expected.end(), data.begin(),
                    [](const std::string& left, const auto& right) { return left == right.first; }))
        return failure("Portable bundle contains files outside the current authoring contract.");
    if (std::filesystem::exists(destination) || std::filesystem::is_symlink(destination))
        return failure("Portable Project import destination changed during validation.");
    std::filesystem::rename(stage.root, destination);
    return {{"ok", true},
            {"projectRoot", utf8_string(destination)},
            {"projectFilePath", utf8_string(destination / "project.yaml")},
            {"manifest", manifest}};
}

} // namespace

Json native_project_bundle(const Json& request, ProjectSession* session,
                           const std::filesystem::path& root)
{
    const auto action = request.value("action", std::string{});
    if (action == "project-import")
        return import_bundle(request);
    if (action == "export-preparation" || action == "runtime-package-preparation") {
        if (!session)
            return failure("Native export preparation requires an admitted disk Project.");
        const auto effective = complete_project(*session);
        if (action == "runtime-package-preparation" &&
            (!effective.contains("export") || !effective.at("export").is_object() ||
             !effective.at("export").contains("runtime") ||
             !effective.at("export").at("runtime").is_object() ||
             effective.at("export").at("runtime").value("kind", std::string{}) != "runtime"))
            return failure(
                "Cannot prepare Runtime Package without a valid native runtime profile.");
        std::set<std::string> paths;
        project_paths(effective, *session, root, paths);
        Json records = Json::array();
        Json revisions = Json::object();
        for (const auto& source : paths) {
            records.push_back(source);
            revisions[source] = exact_source_revision(bytes_at(checked_source(root, source)));
        }
        Json result{{"ok", true},
                    {"project", effective},
                    {"sourcePaths", std::move(records)},
                    {"sourceRevisions", std::move(revisions)}};
        if (action == "runtime-package-preparation") {
            const auto profile = effective.at("export").at("runtime");
            if (request.contains("profileId") && (!request.at("profileId").is_string() ||
                                                  request.at("profileId") != profile.at("id")))
                return failure(
                    "Runtime Package profile is not the selected Project runtime profile.");
            result["profile"] = profile;
            result["projectIdentity"] = effective.at("project");
            result["runtimeIntent"] = "runtime-package-export";
            // The compiled artifact/shader lowering remain owned by the
            // established native export-tooling pipeline; do not reimplement
            // or opportunistically publish a partial runtime package here.
        }
        return result;
    }
    if (action == "project-export") {
        if (!session)
            return failure("Native Project export requires a disk-authoritative session.");
        return export_bundle(request, *session, root);
    }
    return failure("Unknown native portable Project operation.");
}
