#include "native_cli_platform.hpp"
#include "native_cli_platform_stage.hpp"
#include "native_cli_comfyui.hpp"

#include <noveltea/core/player_bootstrap.hpp>

#include <algorithm>
#include <array>
#include <cerrno>
#include <chrono>
#include <cctype>
#include <ctime>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <map>
#include <memory>
#include <optional>
#include <random>
#include <set>
#include <span>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

#if defined(_WIN32)
#include <Windows.h>
#else
#include <fcntl.h>
#include <pwd.h>
#include <sys/wait.h>
#include <sys/types.h>
#include <unistd.h>
#endif

namespace noveltea::cli {
namespace {
namespace fs = std::filesystem;
using Json = nlohmann::ordered_json;

std::string text(const fs::path& path)
{
    const auto value = path.u8string();
    return {value.begin(), value.end()};
}

PlatformCliResult result(bool success, Json fields = Json::object(),
                         Json diagnostics = Json::array(), std::string human = {}, int exit = 4)
{
    Json envelope{{"success", success},
                  {"exitCode", success ? 0 : exit},
                  {"diagnostics", std::move(diagnostics)}};
    envelope.update(fields);
    return {std::move(envelope), std::move(human)};
}

PlatformCliResult fail(std::string code, std::string path, std::string message, int exit = 4)
{
    return result(false, Json::object(),
                  Json::array({{{"code", std::move(code)},
                                {"severity", "error"},
                                {"path", std::move(path)},
                                {"message", message}}}),
                  message, exit);
}

// A usage exception is emitted by the CLI's existing common CLI_USAGE handler.
void require_count(const std::vector<std::string>& command, std::size_t expected,
                   std::string_view help)
{
    if (command.size() != expected)
        throw std::invalid_argument(std::string(help));
}

bool force_only(const std::vector<std::string>& command, std::size_t offset, std::string_view help)
{
    if (command.size() == offset)
        return false;
    if (command.size() != offset + 1 || command[offset] != "--force")
        throw std::invalid_argument(std::string(help));
    return true;
}

bool valid_component(std::string_view value)
{
    if (value.empty() || value == "." || value == "..")
        return false;
    return std::all_of(value.begin(), value.end(), [](unsigned char c) {
        return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') ||
               c == '_' || c == '.' || c == '-';
    });
}

std::pair<std::string, std::string> parse_token(const std::string& token)
{
    const auto split = token.find('@');
    if (split == std::string::npos || token.find('@', split + 1) != std::string::npos ||
        !valid_component(std::string_view(token).substr(0, split)) ||
        !valid_component(std::string_view(token).substr(split + 1)))
        throw std::invalid_argument("Invalid template identity '" + token +
                                    "'; expected <id>@<build>.");
    return {token.substr(0, split), token.substr(split + 1)};
}

fs::path user_home()
{
#if defined(_WIN32)
    const char* home = std::getenv("USERPROFILE");
    if (!home || !*home)
        throw std::runtime_error("User home is unavailable.");
#else
    const char* home = std::getenv("HOME");
    if (!home || !*home) {
        const auto* account = getpwuid(getuid());
        home = account ? account->pw_dir : nullptr;
    }
    if (!home || !*home)
        throw std::runtime_error("User home is unavailable.");
#endif
    return fs::u8path(home);
}

fs::path registry_root()
{
    const char* configured = std::getenv("NOVELTEA_TEMPLATE_REGISTRY_ROOT");
    return fs::absolute(configured && *configured ? fs::u8path(configured)
                                                  : user_home() / ".noveltea/templates")
        .lexically_normal();
}

fs::path template_root(const std::string& token)
{
    const auto [id, build] = parse_token(token);
    const auto registry = registry_root();
    if (fs::is_symlink(fs::symlink_status(registry)) ||
        fs::is_symlink(fs::symlink_status(registry / fs::u8path(id))))
        throw std::runtime_error("Refusing symbolic-link template registry paths.");
    return registry / fs::u8path(id) / fs::u8path(build);
}

std::string read_file(const fs::path& path)
{
    std::ifstream input(path, std::ios::binary);
    if (!input)
        throw std::runtime_error("Cannot read '" + text(path) + "'.");
    return {std::istreambuf_iterator<char>(input), std::istreambuf_iterator<char>()};
}

void write_exclusive_file(const fs::path& path, std::string_view bytes)
{
#if defined(_WIN32)
    const HANDLE handle = CreateFileW(path.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW,
                                      FILE_ATTRIBUTE_NORMAL, nullptr);
    if (handle == INVALID_HANDLE_VALUE)
        throw std::runtime_error("Cannot reserve exclusive output '" + text(path) + "'.");
    DWORD written = 0;
    const auto accepted =
        WriteFile(handle, bytes.data(), static_cast<DWORD>(bytes.size()), &written, nullptr) != 0 &&
        written == bytes.size() && FlushFileBuffers(handle) != 0;
    CloseHandle(handle);
    if (!accepted) {
        std::error_code ignored;
        fs::remove(path, ignored);
        throw std::runtime_error("Cannot finish staged output '" + text(path) + "'.");
    }
#else
    const int handle = open(path.c_str(), O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600);
    if (handle < 0)
        throw std::runtime_error("Cannot reserve exclusive output '" + text(path) + "'.");
    bool accepted = true;
    std::size_t position = 0;
    while (position < bytes.size()) {
        const auto count = write(handle, bytes.data() + position, bytes.size() - position);
        if (count < 0 && errno == EINTR)
            continue;
        if (count <= 0) {
            accepted = false;
            break;
        }
        position += static_cast<std::size_t>(count);
    }
    if (accepted && fsync(handle) != 0)
        accepted = false;
    if (close(handle) != 0)
        accepted = false;
    if (!accepted) {
        std::error_code ignored;
        fs::remove(path, ignored);
        throw std::runtime_error("Cannot finish staged output '" + text(path) + "'.");
    }
#endif
}

std::string hash_bytes(std::string_view bytes)
{
    return core::sha256_hex(std::as_bytes(std::span(bytes.data(), bytes.size())));
}

struct ProcessResult {
    int code = -1;
    std::string output;
};

#if defined(_WIN32)
std::wstring quote(const std::wstring& arg)
{
    std::wstring quoted = L"\"";
    std::size_t slashes = 0;
    for (const wchar_t ch : arg) {
        if (ch == L'\\') {
            ++slashes;
        } else if (ch == L'"') {
            quoted.append(slashes * 2 + 1, L'\\');
            quoted.push_back(ch);
            slashes = 0;
        } else {
            quoted.append(slashes, L'\\');
            quoted.push_back(ch);
            slashes = 0;
        }
    }
    quoted.append(slashes * 2, L'\\');
    return quoted + L'"';
}
#endif

// Invoke only the existing host archive tools. Never interpolate archive names
// into a shell; the input is an arbitrary user-controlled filesystem path.
ProcessResult run_archive_tool(const std::string& program, const std::vector<std::string>& args)
{
#if defined(_WIN32)
    SECURITY_ATTRIBUTES attributes{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
    HANDLE read_pipe = nullptr, write_pipe = nullptr;
    if (!CreatePipe(&read_pipe, &write_pipe, &attributes, 0))
        throw std::runtime_error("Could not create archive-tool output pipe.");
    SetHandleInformation(read_pipe, HANDLE_FLAG_INHERIT, 0);
    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    startup.dwFlags = STARTF_USESTDHANDLES;
    startup.hStdOutput = write_pipe;
    startup.hStdError = write_pipe;
    startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
    const auto program_path = fs::u8path(program);
    std::wstring command = quote(program_path.wstring());
    for (const auto& arg : args)
        command += L" " + quote(fs::u8path(arg).wstring());
    PROCESS_INFORMATION process{};
    const auto launched = CreateProcessW(nullptr, command.data(), nullptr, nullptr, TRUE,
                                         CREATE_NO_WINDOW, nullptr, nullptr, &startup, &process);
    CloseHandle(write_pipe);
    if (!launched) {
        CloseHandle(read_pipe);
        throw std::runtime_error("Could not launch archive tool '" + program + "'.");
    }
    ProcessResult output;
    std::array<char, 8192> buffer{};
    DWORD length = 0;
    while (
        ReadFile(read_pipe, buffer.data(), static_cast<DWORD>(buffer.size()), &length, nullptr) &&
        length) {
        if (output.output.size() < 32 * 1024 * 1024)
            output.output.append(buffer.data(), length);
    }
    CloseHandle(read_pipe);
    WaitForSingleObject(process.hProcess, INFINITE);
    DWORD status = 0;
    GetExitCodeProcess(process.hProcess, &status);
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    output.code = static_cast<int>(status);
    return output;
#else
    int pipe_fd[2];
    if (pipe(pipe_fd) != 0)
        throw std::runtime_error("Could not create archive-tool output pipe.");
    const auto pid = fork();
    if (pid < 0) {
        close(pipe_fd[0]);
        close(pipe_fd[1]);
        throw std::runtime_error("Could not launch archive tool.");
    }
    if (pid == 0) {
        close(pipe_fd[0]);
        dup2(pipe_fd[1], STDOUT_FILENO);
        dup2(pipe_fd[1], STDERR_FILENO);
        close(pipe_fd[1]);
        std::vector<std::string> stored{program};
        stored.insert(stored.end(), args.begin(), args.end());
        std::vector<char*> argv;
        for (auto& arg : stored)
            argv.push_back(arg.data());
        argv.push_back(nullptr);
        execvp(program.c_str(), argv.data());
        _exit(127);
    }
    close(pipe_fd[1]);
    ProcessResult output;
    std::array<char, 8192> buffer{};
    ssize_t length = 0;
    while ((length = read(pipe_fd[0], buffer.data(), buffer.size())) > 0)
        if (output.output.size() < 32 * 1024 * 1024)
            output.output.append(buffer.data(), static_cast<std::size_t>(length));
    close(pipe_fd[0]);
    int status = 0;
    if (waitpid(pid, &status, 0) < 0)
        throw std::runtime_error("Could not reap archive tool.");
    output.code = WIFEXITED(status) ? WEXITSTATUS(status) : -1;
    return output;
#endif
}

std::string checked_archive_tool(const std::string& program, const std::vector<std::string>& args)
{
    const auto output = run_archive_tool(program, args);
    if (output.code != 0)
        throw std::runtime_error("Archive tool '" + program +
                                 "' failed: " + output.output.substr(0, 500));
    if (output.output.size() >= 32 * 1024 * 1024)
        throw std::runtime_error("Archive listing exceeds the output limit.");
    return output.output;
}

std::string configured_tool(const char* variable, std::string fallback)
{
    const char* value = std::getenv(variable);
    return value && *value ? value : fallback;
}

std::vector<std::string> archive_entries(const fs::path& archive, bool zip)
{
#if defined(_WIN32)
    const bool use_zip_tools = false;
#else
    const bool use_zip_tools = zip;
#endif
    const auto tar = configured_tool("NOVELTEA_TAR", "tar");
    const auto unzip = configured_tool("NOVELTEA_UNZIP", "unzip");
    const auto zipinfo = configured_tool("NOVELTEA_ZIPINFO", "zipinfo");
    const auto archive_name = text(archive);
    const auto verbose = use_zip_tools ? checked_archive_tool(zipinfo, {"-l", archive_name})
                                       : checked_archive_tool(tar, {"-tvf", archive_name});
    std::size_t start = 0;
    while (start < verbose.size()) {
        const auto end = verbose.find('\n', start);
        auto line = verbose.substr(start, end == std::string::npos ? end : end - start);
        const auto lead = line.find_first_not_of(" \t\r");
        if (lead != std::string::npos && (line[lead] == 'l' || line[lead] == 'h') &&
            // zipinfo header lines do not encode a Unix entry mode.
            (line.size() >= lead + 10 && line[lead + 1] == 'r'))
            throw std::runtime_error("Template archive contains a symbolic or hard link.");
        if (end == std::string::npos)
            break;
        start = end + 1;
    }
    const auto listing = use_zip_tools ? checked_archive_tool(unzip, {"-Z1", archive_name})
                                       : checked_archive_tool(tar, {"-tf", archive_name});
    std::vector<std::string> entries;
    std::set<std::string> folded;
    start = 0;
    while (start < listing.size()) {
        const auto end = listing.find('\n', start);
        auto name = listing.substr(start, end == std::string::npos ? end : end - start);
        if (!name.empty() && name.back() == '\r')
            name.pop_back();
        if (!name.empty() && name != "." && name != "./") {
            if (name.starts_with("./"))
                name.erase(0, 2);
            if (!name.empty() && name.back() == '/')
                name.pop_back();
            // Check every component before an external extractor sees any entry.
            if (name.empty() || name.starts_with('/') || name.find('\\') != std::string::npos ||
                name.find(':') != std::string::npos || name.find('\r') != std::string::npos ||
                name.find('\n') != std::string::npos)
                throw std::runtime_error("Unsafe template archive path '" + name + "'.");
            std::size_t part_start = 0;
            while (part_start < name.size()) {
                const auto end_part = name.find('/', part_start);
                const auto part = name.substr(
                    part_start, end_part == std::string::npos ? end_part : end_part - part_start);
                if (part.empty() || part == "." || part == "..")
                    throw std::runtime_error("Unsafe template archive path '" + name + "'.");
                if (end_part == std::string::npos)
                    break;
                part_start = end_part + 1;
            }
            auto folded_name = name;
            std::transform(folded_name.begin(), folded_name.end(), folded_name.begin(),
                           [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
            if (!folded.insert(folded_name).second)
                throw std::runtime_error(
                    "Template archive contains a duplicate or case-colliding path.");
            entries.push_back(name);
            if (entries.size() > 20'000)
                throw std::runtime_error("Template archive contains too many entries.");
        }
        if (end == std::string::npos)
            break;
        start = end + 1;
    }
    return entries;
}

void extract_archive(const fs::path& archive, const fs::path& destination, bool zip)
{
#if defined(_WIN32)
    const bool use_zip_tools = false;
#else
    const bool use_zip_tools = zip;
#endif
    if (use_zip_tools)
        checked_archive_tool(configured_tool("NOVELTEA_UNZIP", "unzip"),
                             {"-qq", text(archive), "-d", text(destination)});
    else
        checked_archive_tool(configured_tool("NOVELTEA_TAR", "tar"),
                             {"-xf", text(archive), "-C", text(destination)});
}

std::string utc_now()
{
    const auto now = std::chrono::system_clock::now();
    const auto seconds = std::chrono::system_clock::to_time_t(now);
    std::tm fields{};
#if defined(_WIN32)
    gmtime_s(&fields, &seconds);
#else
    gmtime_r(&seconds, &fields);
#endif
    char result[32]{};
    if (std::strftime(result, sizeof(result), "%Y-%m-%dT%H:%M:%SZ", &fields) == 0)
        throw std::runtime_error("Could not construct template installation timestamp.");
    return result;
}

std::string export_identity_timestamp()
{
    const auto now = std::chrono::system_clock::now();
    const auto milliseconds =
        std::chrono::duration_cast<std::chrono::milliseconds>(now.time_since_epoch()).count() %
        1000;
    auto seconds = utc_now();
    seconds.pop_back();
    return seconds + "." + std::to_string(1000 + milliseconds).substr(1) + "Z";
}

std::string sortable_identity_timestamp(std::string value)
{
    if (value.ends_with('Z') && value.find('.') == std::string::npos)
        value.insert(value.size() - 1, ".000");
    return value;
}

void write_json(const fs::path& path, const Json& value)
{
    std::ofstream stream(path, std::ios::binary | std::ios::trunc);
    if (!stream || !(stream << value.dump(2) << '\n'))
        throw std::runtime_error("Could not stage template registry entry.");
}

Json read_json(const fs::path& path) { return Json::parse(read_file(path)); }

std::string notice_slug(const std::string& name)
{
    std::string slug;
    for (const unsigned char c : name) {
        const bool letter = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
        const bool digit = c >= '0' && c <= '9';
        if (letter || digit) {
            slug.push_back(static_cast<char>(std::tolower(c)));
        } else if (!slug.empty() && slug.back() != '-') {
            slug.push_back('-');
        }
    }
    if (!slug.empty() && slug.back() == '-')
        slug.pop_back();
    return slug;
}

bool valid_notice_text(std::string_view value)
{
    if (value.empty() || value.size() > 1024 * 1024)
        return false;
    if (value.find("No dependency notice file was found") != std::string_view::npos ||
        value.find("Resolved dependency license texts are collected") != std::string_view::npos ||
        value.find("PLACEHOLDER LICENSE") != std::string_view::npos)
        return false;
    bool printable = false;
    for (std::size_t i = 0; i < value.size();) {
        const auto lead = static_cast<unsigned char>(value[i]);
        std::size_t count = 1;
        char32_t cp = lead;
        if (lead >= 0xf0 && lead <= 0xf4) {
            cp = lead & 0x07;
            count = 4;
        } else if (lead >= 0xe0 && lead <= 0xef) {
            cp = lead & 0x0f;
            count = 3;
        } else if (lead >= 0xc2 && lead <= 0xdf) {
            cp = lead & 0x1f;
            count = 2;
        } else if (lead >= 0x80) {
            return false;
        }
        if (i + count > value.size())
            return false;
        for (std::size_t j = 1; j < count; ++j) {
            const auto next = static_cast<unsigned char>(value[i + j]);
            if ((next & 0xc0) != 0x80)
                return false;
            cp = (cp << 6) | (next & 0x3f);
        }
        if ((count == 2 && cp < 0x80) || (count == 3 && cp < 0x800) ||
            (count == 4 && cp < 0x10000) || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) ||
            (cp < 32 && cp != '\n' && cp != '\r' && cp != '\t' && cp != '\f') ||
            (cp >= 127 && cp <= 159))
            return false;
        if (cp > 32)
            printable = true;
        i += count;
    }
    return printable;
}

// Inventory paths must be portable relative paths; never follow directory
// symlinks when inspecting a registry assembled by another process.
fs::path inventory_path(const fs::path& root, const std::string& relative)
{
    if (relative.empty() || relative.starts_with('/') || relative.find('\\') != std::string::npos ||
        relative.find(':') != std::string::npos)
        throw std::runtime_error("Unsafe template inventory path '" + relative + "'.");
    fs::path selected = root;
    std::size_t index = 0;
    while (index < relative.size()) {
        const auto next = relative.find('/', index);
        const auto part = relative.substr(index, next == std::string::npos ? next : next - index);
        if (part.empty() || part == "." || part == "..")
            throw std::runtime_error("Unsafe template inventory path '" + relative + "'.");
        selected /= fs::u8path(part);
        const auto status = fs::symlink_status(selected);
        if (fs::is_symlink(status))
            throw std::runtime_error("Symbolic link in template inventory '" + relative + "'.");
        if (next == std::string::npos)
            break;
        index = next + 1;
    }
    return selected;
}

struct Template {
    Json entry;
    Json descriptor;
    std::string status;
};

std::optional<Template> inspect(const std::string& token)
{
    try {
        const auto root = template_root(token);
        if (!fs::exists(fs::symlink_status(root)))
            return std::nullopt;
        if (!fs::is_directory(fs::symlink_status(root)))
            return std::nullopt;
        const auto entry = read_json(root / ".noveltea-template.json");
        const auto descriptor = read_json(root / "template.json");
        const auto [id, build] = parse_token(token);
        if (entry.value("format", "") != "noveltea.template-registry" ||
            entry.value("templateId", "") != id || entry.value("buildId", "") != build ||
            descriptor.value("format", "") != "noveltea.player-template" ||
            descriptor.value("formatVersion", 0) != 1 || descriptor.value("templateId", "") != id ||
            descriptor.value("buildId", "") != build)
            return std::nullopt;
        std::string status = "corrupted";
        try {
            if (hash_bytes(read_file(root / "template.json")) !=
                entry.at("descriptorSha256").get<std::string>())
                throw std::runtime_error("Descriptor checksum mismatch.");
            std::set<std::string> declared;
            std::map<std::string, Json> inventory;
            for (const auto& item : descriptor.at("files")) {
                const auto name = item.at("path").get<std::string>();
                if (!declared.insert(name).second)
                    throw std::runtime_error("Duplicate inventory path.");
                inventory.emplace(name, item);
                const auto bytes = read_file(inventory_path(root, name));
                if (bytes.size() != item.at("size").get<std::size_t>() ||
                    hash_bytes(bytes) != item.at("sha256").get<std::string>())
                    throw std::runtime_error("Inventory digest mismatch.");
            }
            std::set<std::string> actual;
            for (fs::recursive_directory_iterator cursor(root);
                 cursor != fs::recursive_directory_iterator(); ++cursor) {
                if (fs::is_symlink(cursor->symlink_status()) ||
                    (!cursor->is_regular_file() && !cursor->is_directory()))
                    throw std::runtime_error("Unsafe installed entry.");
                if (cursor->is_regular_file()) {
                    const auto name = cursor->path().lexically_relative(root).generic_string();
                    if (name != ".noveltea-template.json" && name != "template.json")
                        actual.insert(name);
                }
            }
            if (actual != declared)
                throw std::runtime_error("Unexpected installed file.");
            if (!inventory.contains("licenses/index.json"))
                throw std::runtime_error("Missing license index.");
            const auto index = read_json(root / "licenses/index.json");
            if (index.value("format", "") != "noveltea.engine-licenses")
                throw std::runtime_error("License index format mismatch.");
            if (index.at("components").empty())
                throw std::runtime_error("Empty license index.");
            std::set<std::string> notices{"licenses/index.json"};
            std::set<std::string> notice_components;
            std::string previous_component;
            for (const auto& component : index.at("components")) {
                const auto name = component.at("component").get<std::string>();
                const auto version = component.at("version").get<std::string>();
                if (name.empty() || version.empty() ||
                    (!previous_component.empty() && name <= previous_component) ||
                    component.at("files").empty())
                    throw std::runtime_error("Invalid license component ordering.");
                previous_component = name;
                notice_components.insert(name + std::string(1, '\0') + version);
                for (const auto& file : component.at("files")) {
                    const auto name = file.at("path").get<std::string>();
                    if (!name.starts_with("licenses/" + notice_slug(previous_component) + "--") ||
                        !name.ends_with(".txt") || !notices.insert(name).second ||
                        !inventory.contains(name) ||
                        inventory.at(name).at("sha256") != file.at("sha256") ||
                        inventory.at(name).at("size") != file.at("size") ||
                        (inventory.at(name).contains("role") &&
                         inventory.at(name).at("role") != "notice") ||
                        !valid_notice_text(read_file(inventory_path(root, name))))
                        throw std::runtime_error("License index inventory mismatch.");
                }
            }
            if (notices.size() - 1 > 512 ||
                fs::file_size(root / "licenses/index.json") > 1024 * 1024)
                throw std::runtime_error("License index is too large.");
            for (const auto& [name, item] : inventory)
                if (name.starts_with("licenses/") && !notices.contains(name))
                    throw std::runtime_error("Undeclared license file.");
            std::set<std::string> dependencies;
            for (const auto& dependency : descriptor.at("runtimeDependencies"))
                if (dependency.value("kind", "") == "notice")
                    dependencies.insert(dependency.at("path").get<std::string>());
            if (notices != dependencies)
                throw std::runtime_error("License dependency inventory mismatch.");
            const auto sbom =
                read_json(inventory_path(root, descriptor.at("artifacts").at("sbom")));
            if (sbom.value("bomFormat", "") != "CycloneDX")
                throw std::runtime_error("Template SBOM format mismatch.");
            std::set<std::string> sbom_components;
            for (const auto& component : sbom.at("components"))
                sbom_components.insert(component.at("name").get<std::string>() +
                                       std::string(1, '\0') +
                                       component.at("version").get<std::string>());
            if (sbom_components != notice_components)
                throw std::runtime_error("Template SBOM does not match engine licenses.");
            status = entry.value("trust", "") == "official" ? "installed" : "untrusted";
        } catch (const std::exception&) {
            // Keep readable but corrupt registry records inspectable, like
            // the editor registry. They can never satisfy export resolution.
        }
        return Template{entry, descriptor, status};
    } catch (const std::exception&) {
        return std::nullopt;
    }
}

std::vector<Template> templates()
{
    std::vector<Template> found;
    const auto root = registry_root();
    if (!fs::exists(fs::symlink_status(root)))
        return found;
    if (!fs::is_directory(fs::symlink_status(root)))
        throw std::runtime_error("Template registry root is not a directory.");
    for (const auto& parent : fs::directory_iterator(root)) {
        if (!parent.is_directory() || fs::is_symlink(parent.symlink_status()))
            continue;
        const auto id = parent.path().filename().string();
        if (!valid_component(id))
            continue;
        for (const auto& build : fs::directory_iterator(parent.path())) {
            if (!build.is_directory() || fs::is_symlink(build.symlink_status()))
                continue;
            const auto name = build.path().filename().string();
            if (!valid_component(name))
                continue;
            if (auto candidate = inspect(id + "@" + name))
                found.push_back(std::move(*candidate));
        }
    }
    std::sort(found.begin(), found.end(), [](const Template& a, const Template& b) {
        return a.descriptor.at("templateId").get<std::string>() + "@" +
                   a.descriptor.at("buildId").get<std::string>() <
               b.descriptor.at("templateId").get<std::string>() + "@" +
                   b.descriptor.at("buildId").get<std::string>();
    });
    return found;
}

Json fields(const Template& item)
{
    const auto& descriptor = item.descriptor;
    return {{"id", descriptor.at("templateId").get<std::string>() + "@" +
                       descriptor.at("buildId").get<std::string>()},
            {"templateId", descriptor.at("templateId")},
            {"buildId", descriptor.at("buildId")},
            {"target", descriptor.at("platform")},
            {"architecture", descriptor.at("architecture")},
            {"buildFlavor", descriptor.at("buildFlavor")},
            {"trust", item.entry.at("trust")},
            {"status", item.status}};
}

std::string artifact(const Json& profile)
{
    const auto target = profile.value("target", std::string{});
    if (target == "web")
        return profile.at("web").at("artifact").get<std::string>();
    if (target == "android")
        return profile.at("android").at("artifact").get<std::string>();
    return profile.at("desktop").at("artifact").get<std::string>();
}

bool includes(const Json& array, const std::string& value)
{
    return array.is_array() && std::find(array.begin(), array.end(), value) != array.end();
}

// Match the zero-toolchain host projection used for public profile listings.
// These rows are read-only presentation, not authorization for publication.
bool host_compatible(const Json& profile, const std::vector<Template>& installed)
{
#if defined(_WIN32)
    constexpr std::string_view host = "windows";
#elif defined(__APPLE__)
    constexpr std::string_view host = "macos";
#else
    constexpr std::string_view host = "linux";
#endif
    for (const auto& item : installed) {
        const auto& descriptor = item.descriptor;
        const auto target = profile.value("target", std::string{});
        if (item.status == "corrupted" || descriptor.value("platform", "") != target ||
            descriptor.value("architecture", "") != profile.value("architecture", "") ||
            descriptor.value("buildFlavor", "") != profile.value("buildFlavor", ""))
            continue;
        const auto assembly = descriptor.at("host").value("assembly", "");
        if (assembly != "any" && assembly != host)
            continue;
        if (descriptor.at("host").value("requiresToolchain", false) &&
            !descriptor.at("host").at("tools").empty())
            continue;
        if (descriptor.value("compiledProjectFormatVersion", 0) != 1 ||
            descriptor.value("playerRuntimeApiVersion", 0) != 1)
            continue;
        if (!includes(descriptor.at("packageAccessModes"),
                      profile.at("packageAccess").get<std::string>()))
            continue;
        const auto variant = target == "android" || target == "web" ? "essl-300"
                             : target == "macos"                    ? "metal"
                                                                    : "glsl-330";
        if (!includes(descriptor.at("shaderVariants"), variant) ||
            !includes(descriptor.at("capabilities"), "external-url") ||
            (target == "android" && !includes(descriptor.at("capabilities"), "vibration")))
            continue;
        if (target == "web" &&
            !includes(descriptor.at("compiledFeatures"), profile.at("web").value("threaded", false)
                                                             ? "web-threads"
                                                             : "web-single-threaded"))
            continue;
        if (target == "android") {
            if (!descriptor.contains("android") || !descriptor.at("android").is_object())
                continue;
            const auto& android = descriptor.at("android");
            const auto& selected = profile.at("android");
            const auto selected_artifact = selected.at("artifact").get<std::string>();
            if (!includes(android.at("supportedAbis"), selected.at("abi").get<std::string>()) ||
                !includes(android.at("packageAccessModes"),
                          profile.at("packageAccess").get<std::string>()) ||
                !includes(android.at("artifactKinds"),
                          selected_artifact == "both" ? "apk" : selected_artifact) ||
                (selected_artifact == "both" && !includes(android.at("artifactKinds"), "aab")) ||
                selected.at("minSdk").get<int>() <
                    android.at("minimumSdk").at("minimum").get<int>() ||
                selected.at("minSdk").get<int>() >
                    android.at("minimumSdk").at("maximum").get<int>())
                continue;
        }
        return true;
    }
    return false;
}

PlatformCliResult platform_profiles(const fs::path& root,
                                    const std::function<Json(const Json&)>& project_request)
{
    if (root.empty())
        return fail("WORKSPACE_NOT_FOUND", "/project.yaml",
                    "No NovelTea project.yaml was found from the current directory upward.", 3);
    const auto manifest = root / "project.yaml";
    const auto before = hash_bytes(read_file(manifest));
    const auto prepared =
        project_request({{"action", "platform-profiles-preparation"}, {"projectRoot", text(root)}});
    if (!prepared.value("ok", false)) {
        const auto diagnostics = prepared.value("diagnostics", Json::array());
        if (!diagnostics.empty())
            return result(false, {{"projectRoot", text(root)}}, diagnostics, {},
                          prepared.value("exitCode", 3));
        return fail("WORKSPACE_SOURCE_READ", "/project.yaml",
                    prepared.value("error", "Native platform profile preparation failed."), 3);
    }
    if (!prepared.contains("exportSettings"))
        return fail("WORKSPACE_SOURCE_READ", "/export",
                    "Native Project preparation omitted export settings.", 3);
    const auto installed = templates();
    Json rows = Json::array();
    std::string human;
    for (const auto& profile : prepared.at("exportSettings").at("profiles")) {
        const auto row = Json{{"id", profile.at("id")},
                              {"label", profile.at("label")},
                              {"target", profile.at("target")},
                              {"architecture", profile.at("architecture")},
                              {"buildFlavor", profile.at("buildFlavor")},
                              {"artifact", artifact(profile)},
                              {"hostCompatible", host_compatible(profile, installed)}};
        if (!human.empty())
            human += '\n';
        human += row.at("id").get<std::string>() + "  " + row.at("label").get<std::string>() +
                 "  " + row.at("target").get<std::string>() + "/" +
                 row.at("architecture").get<std::string>() + "  " +
                 row.at("artifact").get<std::string>();
        rows.push_back(row);
    }
    if (hash_bytes(read_file(manifest)) != before)
        return fail("WORKSPACE_REVISION_CONFLICT", "/",
                    "Project authority changed during native profile enumeration.", 3);
    if (rows.empty())
        human = "No platform export profiles are configured. Create one in the editor.";
    return result(true, {{"projectRoot", text(root)}, {"profiles", rows}},
                  prepared.value("diagnostics", Json::array()), human);
}

PlatformCliResult config_init(const std::vector<std::string>& command)
{
    if (command.size() < 4 || command.size() > 5)
        throw std::invalid_argument("Usage: noveltea platform config init <path> [--force].");
    const bool force =
        force_only(command, 4, "Usage: noveltea platform config init <path> [--force].");
    const auto destination = fs::absolute(fs::u8path(command[3])).lexically_normal();
    const auto status = fs::symlink_status(destination);
    if (fs::is_symlink(status))
        return fail("CLI_COMMAND", "/", "Refusing to replace a symbolic-link config path.", 4);
    if (fs::exists(status) && !force)
        return fail("CLI_COMMAND", "/",
                    "Config destination '" + text(destination) +
                        "' already exists; use --force to replace it.",
                    4);
    if (fs::exists(status) && !fs::is_regular_file(status))
        return fail("CLI_COMMAND", "/", "Config destination is not a regular file.", 4);
    Json config{{"format", "noveltea.editor-export-local-state"},
                {"templateRoots", Json::array()},
                {"toolchains", Json::object()},
                {"signing", Json::object()}};
    fs::create_directories(destination.parent_path());
    std::random_device random;
    auto staged = destination;
    staged += ".tmp-" + std::to_string(random());
    if (fs::exists(fs::symlink_status(staged)))
        return fail("CLI_COMMAND", "/", "Could not reserve temporary config destination.", 4);
    try {
        write_exclusive_file(staged, config.dump(2) + '\n');
    } catch (const std::exception& error) {
        return fail("CLI_COMMAND", "/", error.what());
    }
    try {
        fs::path backup = destination;
        backup += ".previous-" + std::to_string(random());
        const bool previous = fs::exists(status);
        if (previous)
            fs::rename(destination, backup);
        try {
            fs::rename(staged, destination);
        } catch (...) {
            if (previous)
                fs::rename(backup, destination);
            throw;
        }
        if (previous)
            fs::remove(backup);
    } catch (...) {
        fs::remove(staged);
        throw;
    }
    return result(true, {{"path", text(destination)}, {"config", config}}, Json::array(),
                  "Created " + text(destination) + ".");
}

struct EditorIdentitySnapshot {
    fs::path path;
    fs::path identity_path;
    std::optional<std::string> bytes;
    Json state = Json::object();
};

// Ignored editor state is machine-local and may be concurrently updated for
// recovery, drafts, or UI state. Preserve all fields rather than replacing it
// with a second, CLI-specific state document.
EditorIdentitySnapshot read_export_identity(const fs::path& root)
{
    const auto directory = root / ".noveltea";
    const auto editor = directory / "editor";
    EditorIdentitySnapshot snapshot;
    snapshot.path = editor / "state.json";
    snapshot.identity_path = editor / "platform-export-identity.json";
    for (const auto& path : {directory, editor, snapshot.path, snapshot.identity_path}) {
        const auto status = fs::symlink_status(path);
        if (fs::is_symlink(status))
            throw std::runtime_error("Editor-local state path may not contain a symlink.");
    }
    const auto status = fs::symlink_status(snapshot.path);
    if (!fs::exists(status)) {
        snapshot.state = {{"schema", "noveltea.editor.local-state"},
                          {"recovery", {{"sequence", 0}, {"saveUnitsById", Json::object()}}},
                          {"sourceRecoveryById", Json::object()}};
    } else {
        if (!fs::is_regular_file(status) || fs::file_size(snapshot.path) > 32 * 1024 * 1024)
            throw std::runtime_error("Editor-local state is not a valid regular file.");
        snapshot.bytes = read_file(snapshot.path);
        snapshot.state = Json::parse(*snapshot.bytes);
    }
    if (!snapshot.state.is_object() ||
        snapshot.state.value("schema", "") != "noveltea.editor.local-state")
        throw std::runtime_error("Editor-local state uses an unsupported schema.");
    if (snapshot.state.contains("lastSuccessfulPlatformExportIdentity")) {
        const auto& identity = snapshot.state.at("lastSuccessfulPlatformExportIdentity");
        if (!identity.is_object() || !identity.contains("applicationId") ||
            !identity.at("applicationId").is_string() || !identity.contains("saveNamespace") ||
            !identity.at("saveNamespace").is_string())
            throw std::runtime_error("Editor-local export identity is invalid.");
    }
    const auto sidecar_status = fs::symlink_status(snapshot.identity_path);
    if (fs::exists(sidecar_status)) {
        if (!fs::is_regular_file(sidecar_status) || fs::file_size(snapshot.identity_path) > 4096)
            throw std::runtime_error("Platform export identity record is invalid.");
        const auto saved = Json::parse(read_file(snapshot.identity_path));
        if (!saved.is_object() ||
            saved.value("format", "") != "noveltea.platform-export-identity" ||
            !saved.contains("applicationId") || !saved.at("applicationId").is_string() ||
            !saved.contains("saveNamespace") || !saved.at("saveNamespace").is_string() ||
            !saved.contains("completedAt") || !saved.at("completedAt").is_string())
            throw std::runtime_error("Platform export identity record uses an invalid schema.");
        const auto& previous =
            snapshot.state.value("lastSuccessfulPlatformExportIdentity", Json::object());
        if (sortable_identity_timestamp(saved.at("completedAt").get<std::string>()) >=
            sortable_identity_timestamp(previous.value("completedAt", std::string{}))) {
            snapshot.state["lastSuccessfulPlatformExportIdentity"] = {
                {"applicationId", saved.at("applicationId")},
                {"saveNamespace", saved.at("saveNamespace")},
                {"completedAt", saved.at("completedAt")}};
        }
    }
    return snapshot;
}

bool record_export_identity(const fs::path& root, const EditorIdentitySnapshot& original,
                            const std::string& application_id, const std::string& save_namespace)
{
    const auto now = read_export_identity(root);
    if (now.bytes != original.bytes)
        return false;
    // The editor owns state.json and may rename it at any instant. Never
    // replace that document from a CLI publisher: a read/compare/rename is not
    // an atomic CAS and can discard an editor's newest drafts/recovery state.
    // Export identity is a separate editor-local record, overlaid at editor
    // Open; publication never modifies any byte of the editor-owned file.
    Json updated{{"format", "noveltea.platform-export-identity"},
                 {"applicationId", application_id},
                 {"saveNamespace", save_namespace},
                 {"completedAt", export_identity_timestamp()}};
    fs::create_directories(original.identity_path.parent_path());
    const auto staged =
        fs::u8path(text(original.identity_path) + ".tmp-" + std::to_string(std::random_device{}()));
    write_exclusive_file(staged, updated.dump(2) + '\n');
    try {
        if (read_export_identity(root).bytes != original.bytes) {
            fs::remove(staged);
            return false;
        }
        std::error_code error;
#if defined(_WIN32)
        if (!MoveFileExW(staged.c_str(), original.identity_path.c_str(),
                         MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH))
            error = std::error_code(static_cast<int>(GetLastError()), std::system_category());
#else
        fs::rename(staged, original.identity_path, error);
#endif
        if (error)
            throw std::runtime_error("Cannot atomically publish editor export identity: " +
                                     error.message());
    } catch (...) {
        std::error_code ignored;
        fs::remove(staged, ignored);
        throw;
    }
    return true;
}

PlatformCliResult template_install(const fs::path& archive, bool force)
{
    auto install_failure = [](std::string message) {
        return fail("template-install-failed", "/archive", std::move(message));
    };
    const auto archive_path = fs::absolute(archive).lexically_normal();
    const auto archive_status = fs::symlink_status(archive_path);
    if (!fs::is_regular_file(archive_status) ||
        fs::file_size(archive_path) > 2ULL * 1024 * 1024 * 1024)
        return install_failure("Template archive is missing, invalid, or exceeds the 2 GiB limit.");
    const auto registry = registry_root();
    if (fs::is_symlink(fs::symlink_status(registry)))
        return install_failure("Refusing symbolic-link template registry root.");
    fs::create_directories(registry);
    std::random_device random;
    const auto temporary = registry / (".install-" + std::to_string(random()));
    if (fs::exists(fs::symlink_status(temporary)))
        return install_failure("Could not reserve template staging directory.");
    fs::create_directory(temporary);
    struct Cleanup {
        fs::path path;
        ~Cleanup()
        {
            if (!path.empty()) {
                std::error_code ignored;
                fs::remove_all(path, ignored);
            }
        }
    } cleanup{temporary};
    try {
        const auto zip = archive_path.extension() == ".zip";
        // The original archive is untrusted and can be changed by another
        // process. List, extract and hash exactly one private pinned copy so
        // it cannot turn unsafe between the listing and extraction passes.
        const auto pinned = temporary / (zip ? "archive.zip" : "archive.tar.gz");
        fs::copy_file(archive_path, pinned, fs::copy_options::none);
        if (fs::file_size(pinned) > 2ULL * 1024 * 1024 * 1024)
            throw std::runtime_error("Template archive exceeds the 2 GiB limit.");
        const auto expanded = temporary / "expanded";
        fs::create_directory(expanded);
        const auto listing = archive_entries(pinned, zip);
        extract_archive(pinned, expanded, zip);
        auto staged_root = expanded;
        if (!fs::is_regular_file(fs::symlink_status(staged_root / "template.json"))) {
            std::set<std::string> top;
            for (const auto& name : listing)
                top.insert(name.substr(0, name.find('/')));
            if (top.size() != 1)
                throw std::runtime_error(
                    "Template archive must contain template.json at its root.");
            staged_root /= fs::u8path(*top.begin());
            if (!fs::is_regular_file(fs::symlink_status(staged_root / "template.json")))
                throw std::runtime_error(
                    "Template archive must contain template.json at its root.");
        }
        const auto descriptor_bytes = read_file(staged_root / "template.json");
        const auto descriptor = Json::parse(descriptor_bytes);
        if (descriptor.value("format", "") != "noveltea.player-template" ||
            descriptor.value("formatVersion", 0) != 1)
            throw std::runtime_error("Template descriptor format is not supported.");
        const auto id = descriptor.at("templateId").get<std::string>();
        const auto build = descriptor.at("buildId").get<std::string>();
        if (!valid_component(id) || !valid_component(build))
            throw std::runtime_error("Template descriptor has an unsafe identity.");
        const auto destination = template_root(id + "@" + build);
        std::set<std::string> declared;
        std::uint64_t total = descriptor_bytes.size();
        for (const auto& item : descriptor.at("files")) {
            const auto name = item.at("path").get<std::string>();
            if (!declared.insert(name).second)
                throw std::runtime_error("Template descriptor contains duplicate paths.");
            const auto file = inventory_path(staged_root, name);
            if (!fs::is_regular_file(fs::symlink_status(file)))
                throw std::runtime_error("Template file is not a regular file: '" + name + "'.");
            const auto size = fs::file_size(file);
            total += size;
            if (total > 4ULL * 1024 * 1024 * 1024)
                throw std::runtime_error("Expanded template exceeds the 4 GiB limit.");
            if (size != item.at("size").get<std::uint64_t>() ||
                hash_bytes(read_file(file)) != item.at("sha256").get<std::string>())
                throw std::runtime_error("Archive file '" + name +
                                         "' failed descriptor verification.");
        }
        std::set<std::string> actual;
        for (fs::recursive_directory_iterator current(staged_root);
             current != fs::recursive_directory_iterator(); ++current) {
            if (fs::is_symlink(current->symlink_status()) ||
                (!current->is_directory() && !current->is_regular_file()))
                throw std::runtime_error("Template archive contains unsafe filesystem entries.");
            if (current->is_regular_file()) {
                const auto name = current->path().lexically_relative(staged_root).generic_string();
                if (name != "template.json")
                    actual.insert(name);
            }
        }
        if (declared != actual)
            throw std::runtime_error(
                "Archive contents do not exactly match the descriptor inventory.");
        if (fs::is_symlink(fs::symlink_status(destination)))
            throw std::runtime_error("Template destination is a symbolic link.");
        if (fs::exists(fs::symlink_status(destination)) && !force)
            throw std::runtime_error("Template '" + id + "@" + build +
                                     "' is already installed; use --force to replace it.");
        const auto archive_bytes = read_file(pinned);
        Json entry{{"format", "noveltea.template-registry"},
                   {"templateId", id},
                   {"buildId", build},
                   {"descriptorSha256", hash_bytes(descriptor_bytes)},
                   {"archiveSha256", hash_bytes(archive_bytes)},
                   {"installedAt", utc_now()},
                   {"origin", "noveltea-cli"},
                   {"trust", "local-untrusted"},
                   {"verified", true}};
        write_json(staged_root / ".noveltea-template.json", entry);
        // Verify the staged license and file contracts before making the new
        // template available. Then atomically replace the old directory.
        // inspect() revalidates post-publication as a final readback.
        fs::create_directories(destination.parent_path());
        auto backup = destination;
        backup += ".previous-" + std::to_string(random());
        const bool previous = fs::exists(fs::symlink_status(destination));
        if (previous)
            fs::rename(destination, backup);
        try {
            fs::rename(staged_root, destination);
            const auto accepted = inspect(id + "@" + build);
            if (!accepted || accepted->status == "corrupted")
                throw std::runtime_error(
                    "Installed template failed license or inventory verification.");
        } catch (...) {
            std::error_code ignored;
            fs::remove_all(destination, ignored);
            if (previous)
                fs::rename(backup, destination);
            throw;
        }
        if (previous)
            fs::remove_all(backup);
        return result(true, {{"id", id + "@" + build}, {"entry", entry}}, Json::array(),
                      "Installed " + id + "@" + build + ".");
    } catch (const std::exception& error) {
        return install_failure(error.what());
    }
}

struct ExportOptions {
    std::string output;
    std::string profile;
    std::string template_token;
    std::string config;
    std::string signing_profile;
    bool check = false;
    bool force = false;
    bool sign = false;
    bool allow_untrusted = false;
    bool allow_identity_change = false;
    bool allow_localization_warnings = false;
    bool include_unused_assets = false;
    bool include_shader_sources = false;
};

ExportOptions parse_export_options(const std::vector<std::string>& command)
{
    ExportOptions options;
    std::set<std::string> seen;
    for (std::size_t i = 2; i < command.size(); ++i) {
        const auto& option = command[i];
        if (!seen.insert(option).second)
            throw std::invalid_argument("Duplicate platform export option '" + option + "'.");
        if (option == "--output" || option == "--profile" || option == "--template" ||
            option == "--config" || option == "--signing-profile") {
            if (++i >= command.size() || command[i].starts_with("--") || command[i].empty())
                throw std::invalid_argument(option + " requires a value.");
            auto& target = option == "--output"     ? options.output
                           : option == "--profile"  ? options.profile
                           : option == "--template" ? options.template_token
                           : option == "--config"   ? options.config
                                                    : options.signing_profile;
            target = command[i];
        } else if (option == "--check") {
            options.check = true;
        } else if (option == "--force") {
            options.force = true;
        } else if (option == "--sign") {
            options.sign = true;
        } else if (option == "--allow-untrusted-template") {
            options.allow_untrusted = true;
        } else if (option == "--allow-identity-change") {
            options.allow_identity_change = true;
        } else if (option == "--allow-localization-warnings") {
            options.allow_localization_warnings = true;
        } else if (option == "--include-unused-assets") {
            options.include_unused_assets = true;
        } else if (option == "--include-shader-sources") {
            options.include_shader_sources = true;
        } else {
            throw std::invalid_argument("Unknown command option '" + option + "'.");
        }
    }
    if (options.output.empty())
        throw std::invalid_argument("platform export requires '--output <path>'.");
    if (!options.template_token.empty())
        parse_token(options.template_token);
    if (!options.config.empty() && !options.signing_profile.empty())
        throw std::invalid_argument(
            "--signing-profile cannot be combined with --config; select signing inside the "
            "explicit config instead.");
    return options;
}

// Match the strict editorExportLocalStateSchema boundary. A malformed file
// must never be acknowledged as an operative signing/toolchain configuration.
bool valid_config_object(const Json& value, std::initializer_list<std::string_view> names)
{
    if (!value.is_object())
        return false;
    for (auto it = value.begin(); it != value.end(); ++it)
        if (std::find(names.begin(), names.end(), it.key()) == names.end())
            return false;
    return true;
}

bool valid_string_array(const Json& value)
{
    return value.is_array() && std::all_of(value.begin(), value.end(),
                                           [](const auto& item) { return item.is_string(); });
}

bool valid_export_config(const Json& value)
{
    if (!valid_config_object(
            value, {"format", "lastOutputDirectory", "templateRoots", "toolchains", "signing"}) ||
        value.value("format", "") != "noveltea.editor-export-local-state")
        return false;
    if (value.contains("lastOutputDirectory") && !value.at("lastOutputDirectory").is_string())
        return false;
    if (value.contains("templateRoots") && !valid_string_array(value.at("templateRoots")))
        return false;
    const auto toolchains = value.value("toolchains", Json::object());
    if (!valid_config_object(toolchains, {"androidSdk", "androidNdk", "javaHome", "cmake"}))
        return false;
    for (auto it = toolchains.begin(); it != toolchains.end(); ++it)
        if (!it.value().is_string())
            return false;
    const auto signing = value.value("signing", Json::object());
    if (!valid_config_object(signing, {"windows", "macos", "android"}))
        return false;
    if (signing.contains("windows")) {
        const auto& windows = signing.at("windows");
        if (!valid_config_object(windows, {"command", "args", "verifyCommand", "verifyArgs"}) ||
            windows.size() != 4 || !windows.at("command").is_string() ||
            windows.at("command").get<std::string>().empty() ||
            !windows.at("verifyCommand").is_string() ||
            windows.at("verifyCommand").get<std::string>().empty() ||
            !valid_string_array(windows.at("args")) ||
            !valid_string_array(windows.at("verifyArgs")))
            return false;
    }
    if (signing.contains("macos")) {
        const auto& mac = signing.at("macos");
        if (!valid_config_object(
                mac, {"identity", "entitlementsPath", "notarizationCommand", "notarizationArgs"}) ||
            !mac.contains("identity") || !mac.at("identity").is_string() ||
            mac.at("identity").get<std::string>().empty())
            return false;
        for (const auto* key : {"entitlementsPath", "notarizationCommand"})
            if (mac.contains(key) && !mac.at(key).is_string())
                return false;
        if (mac.contains("notarizationArgs") && !valid_string_array(mac.at("notarizationArgs")))
            return false;
    }
    if (signing.contains("android")) {
        const auto& android = signing.at("android");
        if (!valid_config_object(android, {"keystorePath", "keyAlias", "storePasswordReference",
                                           "keyPasswordReference"}) ||
            android.size() != 4)
            return false;
        for (const auto* key :
             {"keystorePath", "keyAlias", "storePasswordReference", "keyPasswordReference"})
            if (!android.at(key).is_string() || android.at(key).get<std::string>().empty())
                return false;
        for (const auto* key : {"storePasswordReference", "keyPasswordReference"}) {
            const auto& token = android.at(key).get_ref<const std::string&>();
            if (!token.starts_with("env:") || token.size() <= 4 ||
                !(std::isalpha(static_cast<unsigned char>(token[4])) || token[4] == '_') ||
                !std::all_of(token.begin() + 5, token.end(),
                             [](unsigned char c) { return std::isalnum(c) || c == '_'; }))
                return false;
        }
    }
    return true;
}

bool export_compatible(const Json& profile, const Template& item)
{
    if (item.status == "corrupted")
        return false;
    return host_compatible(profile, {item});
}

fs::path checked_project_source(const fs::path& project_root, std::string_view relative)
{
    if (relative.empty())
        throw std::runtime_error("Project icon source path is empty.");
    const auto source = fs::u8path(relative);
    if (source.is_absolute())
        throw std::runtime_error("Project icon source path must be relative.");
    std::error_code error;
    const auto canonical_root = fs::weakly_canonical(project_root, error);
    if (error)
        throw std::runtime_error("Cannot resolve Project root.");
    const auto absolute = fs::weakly_canonical(project_root / source, error);
    if (error)
        throw std::runtime_error("Cannot resolve Project icon.");
    const auto remainder = absolute.lexically_relative(canonical_root);
    if (remainder.empty() || remainder.is_absolute())
        throw std::runtime_error("Project icon must be inside the Project root.");
    for (const auto& component : remainder)
        if (component == "..")
            throw std::runtime_error("Project icon must be inside the Project root.");
    if (!fs::is_regular_file(fs::symlink_status(absolute)))
        throw std::runtime_error("Project icon source is missing or invalid.");
    return absolute;
}

std::vector<fs::path> export_artifacts(const fs::path& output, const Json& profile)
{
    const auto target = profile.at("target").get<std::string>();
    std::vector<fs::path> artifacts{output};
    if (target == "web" || target == "windows")
        artifacts.push_back(fs::u8path(text(output) + ".zip"));
    if (target == "linux") {
        artifacts.push_back(
            fs::u8path(text(output) + (artifact(profile) == "zip" ? ".zip" : ".tar.gz")));
        if (artifact(profile) == "appimage")
            artifacts.push_back(fs::u8path(text(output) + ".AppImage"));
    }
    if (target == "macos") {
        auto base = text(output);
        if (base.size() >= 4 && base.substr(base.size() - 4) == ".app")
            base.resize(base.size() - 4);
        artifacts.push_back(fs::u8path(base + ".zip"));
        artifacts.push_back(fs::u8path(base + ".dmg"));
        artifacts.push_back(fs::u8path(base + "-signing-report.json"));
    }
    if (target == "windows" ||
        (profile.value("includeDebugSymbols", false) && (target == "linux" || target == "macos")))
        artifacts.push_back(
            fs::u8path(text(output) + (target == "linux" ? "-symbols.tar.gz" : "-symbols.zip")));
    return artifacts;
}

PlatformCliResult export_preflight(const std::vector<std::string>& command, const fs::path& root,
                                   const std::function<Json(const Json&)>& project_request,
                                   const PlatformExportTools& export_tools)
{
    const auto options = parse_export_options(command);
    if (export_tools.progress)
        export_tools.progress("validating", "Validating project and export profile");
    if (root.empty())
        return fail("WORKSPACE_NOT_FOUND", "/project.yaml",
                    "No NovelTea project.yaml was found from the current directory upward.", 3);
    const auto admitted =
        project_request({{"action", "platform-export-preparation"}, {"projectRoot", text(root)}});
    if (!admitted.value("ok", false))
        return fail(admitted.value("kind", "") == "conflict" ? "WORKSPACE_REVISION_CONFLICT"
                                                             : "WORKSPACE_SOURCE_READ",
                    "/project.yaml", admitted.value("error", "Native Project admission failed."),
                    admitted.value("kind", "") == "conflict" ? 5 : 3);
    if (!admitted.contains("sourceGeneration") || !admitted.at("sourceGeneration").is_string() ||
        admitted.value("runtimeIntent", "") != "platform-export" || !admitted.contains("project"))
        return fail("CLI_INTERNAL", "/", "Native platform admission omitted required authority.",
                    70);
    const auto& project = admitted.at("project");
    const auto& available_profiles = project.at("export").at("profiles");
    const Json* profile = nullptr;
    if (options.profile.empty()) {
        if (available_profiles.size() == 1)
            profile = &available_profiles.front();
    } else {
        for (const auto& candidate : available_profiles)
            if (candidate.value("id", "") == options.profile) {
                profile = &candidate;
                break;
            }
    }
    if (!profile)
        return fail("platform.profile_missing", "/export/profiles",
                    !options.profile.empty()
                        ? "Platform export profile '" + options.profile + "' does not exist."
                    : available_profiles.empty()
                        ? "No platform export profiles are configured."
                        : "Multiple platform export profiles are configured; pass "
                          "'--profile <id>'.");
    const auto output = fs::absolute(fs::u8path(options.output)).lexically_normal();
    if (output.filename().empty())
        return fail("export.output_invalid", "/output", "Platform export output is invalid.");

    const auto& app = project.at("settings").at("app");
    EditorIdentitySnapshot local_identity;
    try {
        local_identity = read_export_identity(root);
    } catch (const std::exception& error) {
        return fail("platform.local_state_invalid", "/.noveltea/editor/state.json", error.what());
    }
    const auto application_id = app.at("applicationId").get<std::string>();
    const auto save_namespace = app.at("saveNamespace").get<std::string>();
    if (local_identity.state.contains("lastSuccessfulPlatformExportIdentity")) {
        const auto& prior = local_identity.state.at("lastSuccessfulPlatformExportIdentity");
        if ((prior.at("applicationId") != application_id ||
             prior.at("saveNamespace") != save_namespace) &&
            !options.allow_identity_change)
            return fail("platform.identity_change_acknowledgement_required", "/settings/app",
                        "Application identity changed from '" +
                            prior.at("applicationId").get<std::string>() + "'/'" +
                            prior.at("saveNamespace").get<std::string>() + "' to '" +
                            application_id + "'/'" + save_namespace +
                            "'; pass --allow-identity-change to continue.");
    }
    if (!app.contains("icon") || !app.at("icon").is_object() || !app.at("icon").contains("$ref") ||
        !app.at("icon").at("$ref").is_object())
        return fail("icon-missing", "/settings/app/icon",
                    "A valid project icon is required for playable platform export.");
    fs::path icon_source;
    try {
        const auto id = app.at("icon").at("$ref").at("id").get<std::string>();
        const auto& icon = project.at("assets").at(id).at("data");
        icon_source = checked_project_source(root, icon.at("source").at("path").get<std::string>());
    } catch (const std::exception&) {
        return fail("icon-missing", "/settings/app/icon",
                    "A valid, local project icon is required for playable platform export.");
    }

    if (export_tools.progress)
        export_tools.progress("resolving-template", "Resolving and verifying the player template");
    std::optional<Template> resolved;
    const auto installed = templates();
    if (!options.template_token.empty()) {
        resolved = inspect(options.template_token);
        if (!resolved || resolved->status == "corrupted")
            return fail("invalid-installed-template", "/template",
                        "Selected template '" + options.template_token + "' is not verified.");
        if (!export_compatible(*profile, *resolved))
            return fail("template-incompatible", "/template",
                        "Selected template '" + options.template_token +
                            "' is incompatible with the export profile.");
    } else {
        std::vector<Template> compatible;
        for (const auto& item : installed)
            if (export_compatible(*profile, item))
                compatible.push_back(item);
        if (compatible.empty())
            return fail("template-missing", "/template",
                        "No compatible installed player template was found.");
        if (compatible.size() > 1) {
            std::string choices;
            for (const auto& item : compatible) {
                if (!choices.empty())
                    choices += ", ";
                choices += fields(item).at("id").get<std::string>();
            }
            return fail("template-ambiguous", "/template",
                        "Multiple compatible templates: " + choices +
                            "; pass '--template <id>@<build>'.");
        }
        resolved = std::move(compatible.front());
    }
    if (resolved->entry.value("trust", "") != "official" && !options.allow_untrusted)
        return fail("template-untrusted-acknowledgement-required", "/template",
                    "Template '" + fields(*resolved).at("id").get<std::string>() +
                        "' is locally sourced; pass --allow-untrusted-template to use it.");

    // Explicit --config overrides the machine-wide user settings. Otherwise
    // resolve exactly the same signing profile set as the TypeScript CLI.
    // Both paths feed one target-specific signing state; execution belongs
    // to the corresponding platform exporter (#564/#567/#568).
    Json config = Json::object();
    PlatformResolvedExportSettings settings;
    settings.signing_requested = options.sign || !options.signing_profile.empty();
    if (!options.config.empty()) {
        try {
            config = read_json(fs::absolute(fs::u8path(options.config)));
            if (!valid_export_config(config))
                return fail("platform.config_invalid", "/config",
                            "Export config violates the strict local export configuration schema.");
        } catch (const std::exception& error) {
            return fail("platform.config_invalid", "/config", error.what());
        }
        settings.toolchains = config.value("toolchains", Json::object());
        settings.signing = config.value("signing", Json::object());
        // templateRoots and lastOutputDirectory are retained, validated
        // editor-local fields, but do not override the installed template
        // registry in the existing TypeScript headless CLI either.
    } else {
        const Json user = load_native_user_export_config();
        settings.toolchains = user.value("toolchains", Json::object());
        if (settings.signing_requested) {
            const std::string target = profile->at("target").get<std::string>();
            std::vector<Json> matching;
            for (const auto& candidate : user.value("signingProfiles", Json::array()))
                if (candidate.value("target", "") == target)
                    matching.push_back(candidate);
            const Json* selected = nullptr;
            if (!options.signing_profile.empty()) {
                for (const auto& candidate : matching)
                    if (candidate.at("id") == options.signing_profile) {
                        selected = &candidate;
                        break;
                    }
            } else if (matching.size() == 1) {
                selected = &matching.front();
            }
            if (!selected)
                return fail("platform.signing_profile_required", "/signingProfile",
                            !options.signing_profile.empty()
                                ? "Signing profile '" + options.signing_profile +
                                      "' is not configured for " + target + "."
                            : matching.empty()
                                ? "No signing profile is configured for " + target + "."
                                : "Multiple signing profiles are configured for " + target +
                                      "; pass --signing-profile <id>.");
            settings.signing[target] = Json::object();
            for (auto it = selected->begin(); it != selected->end(); ++it)
                if (it.key() != "id" && it.key() != "label" && it.key() != "target")
                    settings.signing[target][it.key()] = it.value();
        }
    }
    // Native Windows needs no external toolchains. Android (#568) will use
    // settings.toolchains, and each signing-capable target (#564/#567/#568)
    // must consume settings.signing and verify signed bytes before publishing.
    // Reject unsupported target signing before creating a lock or touching
    // interrupted publication state. The stage repeats this check for direct
    // callers, while receiving the full settings for future target exporters.
    if (auto unavailable = validate_native_platform_export_settings(settings, *profile))
        return *unavailable;

    // Validate the whole output path BEFORE either acquiring ownership or
    // attempting recovery. The reusable recovery entrypoint enforces this too.
    try {
        validate_platform_publication_path(output);
    } catch (const std::exception& error) {
        return fail("platform-output-symlink-forbidden", "/outputDirectory", error.what());
    }
    std::unique_ptr<PlatformPublicationLock> publication_lock;
    if (!options.check) {
        try {
            publication_lock = std::make_unique<PlatformPublicationLock>(output);
        } catch (const std::exception& error) {
            return fail("WORKSPACE_TRANSACTION_RECOVERY_CONFLICT", "/output", error.what(), 5);
        }
    }
    if (has_native_platform_publication(output)) {
        if (options.check)
            return fail("WORKSPACE_TRANSACTION_RECOVERY_CONFLICT", "/output",
                        "A previous platform publication requires recovery.", 5);
        std::string recovery_error;
        if (!recover_native_platform_publication(output, *publication_lock, recovery_error))
            return fail("WORKSPACE_TRANSACTION_RECOVERY_CONFLICT", "/output",
                        "Failed to recover previous platform publication: " + recovery_error, 5);
    }
    std::vector<std::string> collisions, symlinks;
    for (const auto& path : export_artifacts(output, *profile)) {
        for (auto parent = path.parent_path(); !parent.empty(); parent = parent.parent_path()) {
            const auto parent_status = fs::symlink_status(parent);
            if (fs::is_symlink(parent_status))
                return fail("platform-output-symlink-forbidden", "/outputDirectory",
                            "Export refuses a symbolic-link output parent: " + text(parent) + ".");
            if (fs::exists(parent_status) && !fs::is_directory(parent_status))
                return fail("export.output_invalid", "/outputDirectory",
                            "Platform output parent is not a directory: " + text(parent) + ".");
            if (parent == parent.root_path())
                break;
        }
        const auto status = fs::symlink_status(path);
        if (fs::is_symlink(status))
            symlinks.push_back(text(path));
        if (fs::exists(status) && !fs::is_symlink(status) &&
            (path == output ? !fs::is_directory(status) : !fs::is_regular_file(status)))
            return fail("export.output_invalid", "/outputDirectory",
                        "Platform output has an unexpected filesystem type: " + text(path) + ".");
        if (fs::exists(status))
            collisions.push_back(text(path));
    }
    if (!symlinks.empty())
        return fail("platform-output-symlink-forbidden", "/outputDirectory",
                    "Export refuses symbolic-link artifact paths: " + symlinks.front() + ".");
    if (!collisions.empty() && !options.force)
        return fail("platform-output-exists", "/outputDirectory",
                    "Export would replace existing artifacts; pass --force to continue: " +
                        collisions.front() + ".");
    const auto source_proof = [&]() {
        return project_request({{"action", "source-generation-proof"},
                                {"projectRoot", text(root)},
                                {"expectedSourceGeneration", admitted.at("sourceGeneration")}});
    };
    if (!source_proof().value("ok", false))
        return fail("WORKSPACE_REVISION_CONFLICT", "/output",
                    "Project source generation changed during platform export.", 5);
    if (options.check) {
        if (!export_tools.check_runtime)
            return fail("CLI_INTERNAL", "/", "Native preflight runtime validation unavailable.",
                        70);
        Json native_profile = admitted.at("profile");
        native_profile["shaderVariants"] = Json::array(
            {profile->value("target", "") == "web" || profile->value("target", "") == "android"
                 ? "essl-300"
             : profile->value("target", "") == "macos" ? "metal"
                                                       : "glsl-330"});
        native_profile["localization"] = profile->at("localization");
        native_profile["excludeUnusedAssets"] =
            options.include_unused_assets ? false : profile->value("excludeUnusedAssets", true);
        native_profile["includeShaderSources"] =
            options.include_shader_sources || profile->value("includeShaderSources", false);
        native_profile["stripShaderSources"] =
            !native_profile.at("includeShaderSources").get<bool>();
        const auto checked = export_tools.check_runtime(admitted, native_profile);
        if (!source_proof().value("ok", false))
            return fail("WORKSPACE_REVISION_CONFLICT", "/output",
                        "Project changed during read-only platform preflight.", 5);
        if (!checked.value("ok", false)) {
            const auto diagnostics = checked.value("diagnostics", Json::array());
            if (!diagnostics.empty())
                return result(false, Json::object(), diagnostics,
                              "Native runtime preflight preparation failed.", 6);
            return fail("native.runtime.artifact", "/export/runtime",
                        checked.value("error", "Runtime preflight preparation failed."), 6);
        }
        Json warnings = Json::array();
        for (const auto& diagnostic : checked.value("diagnostics", Json::array()))
            if (diagnostic.value("severity", "") == "warning" &&
                diagnostic.value("code", std::string{}).starts_with("localization.export."))
                warnings.push_back(diagnostic);
        if (!warnings.empty() && !options.allow_localization_warnings)
            return fail("localization.export.warning_override_required",
                        "/export/runtime/localization",
                        "Localization warnings require --allow-localization-warnings.");
        Json diagnostics = admitted.value("diagnostics", Json::array());
        for (const auto& warning : warnings)
            diagnostics.push_back(warning);
        return result(true,
                      {{"projectRoot", text(root)},
                       {"outputDirectory", text(output)},
                       {"templateToken", fields(*resolved).at("id")},
                       {"signingRequested", false},
                       {"signingApplied", false},
                       {"cancelled", false}},
                      diagnostics, "Platform export preflight succeeded.");
    }
    if (!options.check) {
        auto published = stage_native_platform_export(
            admitted, *profile, resolved->descriptor,
            template_root(fields(*resolved).at("id").get<std::string>()), icon_source, output,
            options.force, options.allow_localization_warnings, options.include_unused_assets,
            options.include_shader_sources, settings, *publication_lock, export_tools,
            [&]() { return source_proof().value("ok", false); });
        if (published.envelope.value("success", false)) {
            try {
                if (!record_export_identity(root, local_identity, application_id, save_namespace))
                    published.envelope["diagnostics"].push_back(
                        {{"code", "platform.local_state_changed"},
                         {"severity", "warning"},
                         {"path", "/.noveltea/editor/state.json"},
                         {"message", "Platform export succeeded, but editor-local state changed "
                                     "concurrently; identity metadata was not replaced."}});
            } catch (const std::exception& error) {
                published.envelope["diagnostics"].push_back(
                    {{"code", "platform.local_state_write_failed"},
                     {"severity", "warning"},
                     {"path", "/.noveltea/editor/state.json"},
                     {"message", std::string("Platform export succeeded, but identity metadata "
                                             "could not be persisted: ") +
                                     error.what()}});
            }
        }
        return published;
    }
    return fail("CLI_INTERNAL", "/", "Unreachable platform preflight state.", 70);
}

} // namespace

PlatformCliResult run_native_platform_cli(const std::vector<std::string>& command,
                                          const fs::path& root, bool explicit_project,
                                          const std::function<Json(const Json&)>& project_request,
                                          const PlatformExportTools& export_tools)
{
    if (command.size() < 2)
        throw std::invalid_argument("Unknown platform command.");
    if (command[1] == "profiles") {
        require_count(command, 2, "platform profiles does not accept arguments.");
        return platform_profiles(root, project_request);
    }
    if (command[1] == "export")
        return export_preflight(command, root, project_request, export_tools);
    if (command[1] != "template" && command[1] != "config")
        return fail("CLI_NATIVE_CANDIDATE_UNCLAIMED", "/",
                    "Command is not implemented by the direct C++ CLI candidate.", 70);
    if (explicit_project)
        throw std::invalid_argument("Global option '--project' is not supported by "
                                    "project-independent platform commands.");
    if (command[1] == "config") {
        if (command.size() < 3 || command[2] != "init")
            throw std::invalid_argument("Unknown platform config command '" +
                                        (command.size() < 3 ? "" : command[2]) + "'.");
        return config_init(command);
    }
    if (command.size() < 3)
        throw std::invalid_argument("Unknown platform template command ''.");
    const auto& operation = command[2];
    if (operation == "list") {
        require_count(command, 3, "platform template list does not accept arguments.");
        Json rows = Json::array();
        std::string human;
        for (const auto& item : templates()) {
            auto row = fields(item);
            if (!human.empty())
                human += '\n';
            human += row.at("id").get<std::string>() + "  " + row.at("target").get<std::string>() +
                     "/" + row.at("architecture").get<std::string>() + "  " +
                     row.at("buildFlavor").get<std::string>() + "  " +
                     row.at("status").get<std::string>();
            rows.push_back(std::move(row));
        }
        if (rows.empty())
            human = "No player templates are installed.";
        return result(true, {{"templates", rows}}, Json::array(), human);
    }
    if (operation == "inspect") {
        require_count(command, 4, "Usage: noveltea platform template inspect <id>@<build>.");
        parse_token(command[3]);
        const auto found = inspect(command[3]);
        if (!found)
            return fail("platform.template_missing", "/template",
                        "Template '" + command[3] + "' is not installed.");
        const auto row = fields(*found);
        return result(true, {{"template", row}}, Json::array(),
                      row.at("id").get<std::string>() + "  " + row.at("status").get<std::string>());
    }
    if (operation == "remove") {
        require_count(command, 5, "Usage: noveltea platform template remove <id>@<build> --force.");
        if (command[4] != "--force")
            throw std::invalid_argument(
                "Usage: noveltea platform template remove <id>@<build> --force.");
        fs::path root_path;
        try {
            root_path = template_root(command[3]);
        } catch (const std::runtime_error& error) {
            return fail("platform.template_invalid", "/template", error.what());
        }
        if (!fs::exists(fs::symlink_status(root_path)))
            return fail("platform.template_missing", "/template",
                        "Template '" + command[3] + "' is not installed.");
        if (fs::is_symlink(fs::symlink_status(root_path)))
            return fail("platform.template_invalid", "/template",
                        "Refusing to remove a symbolic-link template installation.");
        fs::remove_all(root_path);
        return result(true, {{"id", command[3]}, {"removed", true}}, Json::array(),
                      "Removed " + command[3] + ".");
    }
    if (operation == "install") {
        if (command.size() < 4 || command.size() > 5)
            throw std::invalid_argument(
                "Usage: noveltea platform template install <archive> [--force].");
        const bool force = force_only(
            command, 4, "Usage: noveltea platform template install <archive> [--force].");
        return template_install(fs::u8path(command[3]), force);
    }
    throw std::invalid_argument("Unknown platform template command '" + operation + "'.");
}
} // namespace noveltea::cli
