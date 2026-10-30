#include "tooling_native_project_create.hpp"

#include "../project_authoring/contracts.hpp"
#include "../project_authoring/room_session.hpp"
#include "../project_authoring/yaml_codec.hpp"

#include <atomic>
#include <chrono>
#include <cctype>
#include <filesystem>
#include <fstream>
#include <string>
#include <stdexcept>

#if defined(_WIN32)
#include <Windows.h>
#elif defined(__linux__)
#include <cerrno>
#include <fcntl.h>
#include <linux/fs.h>
#include <sys/syscall.h>
#include <unistd.h>
#elif defined(__APPLE__)
#include <cerrno>
#include <cstdio>
#endif

namespace {
namespace fs = std::filesystem;
using Json = nlohmann::json;

Json failure(std::string error, std::string_view kind = "mutation")
{
    return {{"ok", false}, {"error", std::move(error)}, {"kind", kind}};
}

std::string id_for(std::string_view name)
{
    std::string result;
    for (unsigned char c : name) {
        if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')) {
            result += static_cast<char>(std::tolower(c));
        } else if (!result.empty() && result.back() != '-') {
            result += '-';
        }
    }
    if (!result.empty() && result.back() == '-')
        result.pop_back();
    return result;
}

struct StagedProject {
    fs::path root;
    ~StagedProject()
    {
        if (!root.empty()) {
            std::error_code ignored;
            fs::remove_all(root, ignored);
        }
    }
};

void publish_exclusive(const fs::path& stage, const fs::path& destination)
{
    // A previous exists() check is not a publication precondition: another
    // process can create the destination between the check and rename.
#if defined(_WIN32)
    if (!MoveFileExW(stage.c_str(), destination.c_str(), MOVEFILE_WRITE_THROUGH))
        throw std::runtime_error("Could not publish Project without replacing destination.");
#elif defined(__linux__)
    if (::syscall(SYS_renameat2, AT_FDCWD, stage.c_str(), AT_FDCWD, destination.c_str(),
                  RENAME_NOREPLACE) != 0)
        throw std::runtime_error("Could not publish Project without replacing destination.");
#elif defined(__APPLE__)
    if (::renamex_np(stage.c_str(), destination.c_str(), RENAME_EXCL) != 0)
        throw std::runtime_error("Could not publish Project without replacing destination.");
#else
    static_assert(false, "Project creation needs exclusive directory publication.");
#endif
}
} // namespace

Json native_project_create(const Json& request)
{
    try {
        if (!request.contains("projectRoot") || !request.at("projectRoot").is_string() ||
            !request.contains("name") || !request.at("name").is_string())
            return failure("Native Project creation requires directory and name.");
        auto name = request.at("name").get<std::string>();
        const auto first = name.find_first_not_of(" \r\n\t");
        if (first == std::string::npos)
            return failure("Project name is required.");
        const auto last = name.find_last_not_of(" \r\n\t");
        name = name.substr(first, last - first + 1);
        const auto id = id_for(name);
        if (id.empty())
            return failure("Project name must contain at least one ASCII letter or number.");
        const auto target = request.at("projectRoot").get<std::string>();
        const fs::path requested = fs::path(std::u8string(target.begin(), target.end()));
        if (!requested.is_absolute())
            return failure("Native Project creation requires an absolute destination.");
        const fs::path destination = requested.lexically_normal();
        if (fs::exists(destination) || fs::is_symlink(fs::symlink_status(destination)))
            return failure("Project destination already exists. Choose a new folder.", "conflict");
        const auto parent = destination.parent_path();
        fs::create_directories(parent);
        const auto real_parent = fs::canonical(parent);
        if (!fs::is_directory(real_parent))
            return failure("Project destination parent must be a directory.");

        StagedProject staging;
        static std::atomic<std::uint64_t> sequence{0};
        for (int attempt = 0; attempt < 100; ++attempt) {
            const auto candidate =
                real_parent /
                ("." + destination.filename().string() + ".noveltea-staging-" +
                 std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()) + "-" +
                 std::to_string(++sequence));
            if (fs::create_directory(candidate)) {
                staging.root = candidate;
                break;
            }
        }
        if (staging.root.empty())
            return failure("Cannot allocate an exclusive Project staging directory.");
        const auto templates = Json::parse(noveltea::authoring::project_creation_files_json());
        if (!templates.is_object() || templates.size() < 7)
            throw std::runtime_error("Native Project creation template is incomplete.");
        for (const auto& [relative, source] : templates.items()) {
            if (!source.is_string() || relative.empty() || relative.starts_with('/') ||
                relative.find("..") != std::string::npos)
                throw std::runtime_error("Invalid generated Project template file.");
            std::string bytes = source.get<std::string>();
            if (relative == "project.yaml") {
                const auto changed = noveltea::authoring::edit_yaml_source(
                    bytes, {{.path = "/project/id",
                             .value_json = Json(id).dump(),
                             .omission_default_json = std::nullopt},
                            {.path = "/project/name",
                             .value_json = Json(name).dump(),
                             .omission_default_json = std::nullopt},
                            {.path = "/settings/app/displayName",
                             .value_json = Json(name).dump(),
                             .omission_default_json = std::nullopt},
                            {.path = "/settings/app/applicationId",
                             .value_json = Json("org.noveltea." + id).dump(),
                             .omission_default_json = std::nullopt},
                            {.path = "/settings/app/saveNamespace",
                             .value_json = Json("org.noveltea." + id).dump(),
                             .omission_default_json = std::nullopt}});
                if (!changed.accepted)
                    throw std::runtime_error("Cannot specialize native Project manifest: " +
                                             changed.error);
                bytes = changed.source;
            }
            const auto path = staging.root / relative;
            fs::create_directories(path.parent_path());
            std::ofstream output(path, std::ios::binary | std::ios::trunc);
            output.write(bytes.data(), static_cast<std::streamsize>(bytes.size()));
            if (!output)
                throw std::runtime_error("Cannot write native Project creation template.");
        }
        for (const auto* folder : {"records", "scripts", "assets"})
            fs::create_directories(staging.root / folder);
        for (const auto* folder : {"i18n/locales", "i18n/assets"})
            fs::create_directories(staging.root / folder);
        std::string admission_error;
        auto validated = noveltea::authoring::ProjectSession::open(staging.root, admission_error);
        if (!validated)
            throw std::runtime_error("New Project failed native admission: " + admission_error);
        const auto result = validated->validate_project();
        if (!result.valid)
            throw std::runtime_error("New Project failed native validation: " +
                                     (result.diagnostics.empty()
                                          ? "no diagnostic"
                                          : result.diagnostics.front().code + " " +
                                                result.diagnostics.front().path + " " +
                                                result.diagnostics.front().message));
        if (fs::exists(destination))
            return failure("Project destination was created while preparing the Project.",
                           "conflict");
        publish_exclusive(staging.root, destination);
        staging.root.clear();
        const auto root_utf8 = destination.u8string();
        const auto manifest_utf8 = (destination / "project.yaml").u8string();
        return {{"ok", true},
                {"projectRoot", std::string(root_utf8.begin(), root_utf8.end())},
                {"projectFilePath", std::string(manifest_utf8.begin(), manifest_utf8.end())},
                {"projectId", id}};
    } catch (const std::exception& error) {
        return failure(error.what());
    }
}
