#include "tooling_project_authority.hpp"

#include <chrono>
#include <filesystem>
#include <fstream>
#include <future>
#include <iostream>
#include <string>
#include <string_view>

namespace {

using namespace std::chrono_literals;
using noveltea::tooling::daemon::ProjectAuthorityManager;
using noveltea::tooling::daemon::ProjectAuthorityRequest;
using noveltea::tooling::daemon::ProjectSourceDiscoveryScope;

struct TempProjectRoot {
    std::filesystem::path path;

    ~TempProjectRoot()
    {
        std::error_code error;
        std::filesystem::remove_all(path, error);
    }
};

bool write_project_file(const std::filesystem::path& path, std::string_view contents)
{
    std::error_code error;
    std::filesystem::create_directories(path.parent_path(), error);
    if (error)
        return false;
    std::ofstream output(path, std::ios::binary | std::ios::trunc);
    if (!output.good())
        return false;
    output.write(contents.data(), static_cast<std::streamsize>(contents.size()));
    return output.good();
}

ProjectAuthorityRequest project_authority_request(const std::filesystem::path& root)
{
    return {
        .project_root = root,
        .authoritative_paths = {"project.json", "editor.json", "traits.json"},
        .discovery_scopes =
            {
                ProjectSourceDiscoveryScope{
                    .root = "records",
                    .extensions = {".json", ".lua", ".rcss", ".rml"},
                },
                ProjectSourceDiscoveryScope{.root = "scripts", .extensions = {".lua"}},
                ProjectSourceDiscoveryScope{.root = "i18n", .extensions = {".json"}},
            },
    };
}

int fail(std::string_view message)
{
    std::cerr << "Windows Project watcher shutdown interleaving failed: " << message << '\n';
    return 1;
}

} // namespace

int main()
{
#if !defined(_WIN32)
    std::cout << "Windows Project watcher shutdown interleaving is Windows-only\n";
    return 0;
#else
    std::error_code error;
    const auto temp = std::filesystem::temp_directory_path(error);
    if (error)
        return fail("could not resolve the temporary directory");

    TempProjectRoot root{
        temp / ("noveltea-project-authority-windows-stop-before-read-" +
                std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()))};
    if (!write_project_file(root.path / "project.json", "{}\n") ||
        !write_project_file(root.path / "editor.json", "{}\n") ||
        !write_project_file(root.path / "traits.json", "{}\n") ||
        !write_project_file(root.path / "records/room.json", "{\"id\":\"room\"}\n") ||
        !write_project_file(root.path / "scripts/main.lua", "return true\n") ||
        !write_project_file(root.path / "i18n/en.json", "{}\n") ||
        !write_project_file(root.path / "records/ignored.txt", "ignored\n"))
        return fail("could not create the Project fixture");

    std::promise<void> before_read_reached;
    auto before_read = before_read_reached.get_future();
    std::promise<void> permit_read;
    auto permit_read_future = permit_read.get_future().share();
    std::promise<void> stop_requested;
    auto stop = stop_requested.get_future();
    bool block_first_read = true;

    ProjectAuthorityManager authority({
        .enable_native_watcher = true,
        .windows_watcher_before_read =
            [&] {
                if (!block_first_read)
                    return;
                block_first_read = false;
                before_read_reached.set_value();
                permit_read_future.wait();
            },
        .windows_watcher_stop_requested = [&] { stop_requested.set_value(); },
    });

    if (authority.observe(project_authority_request(root.path)).manifest.entries.size() != 6)
        return fail("initial Project observation did not contain six authored sources");
    if (before_read.wait_for(2s) != std::future_status::ready)
        return fail("Windows watcher did not reach the pre-read test gate");

    auto released = std::async(std::launch::async, [&] { return authority.release(root.path); });
    if (stop.wait_for(2s) != std::future_status::ready)
        return fail("Windows watcher shutdown did not signal the stop event");
    if (released.wait_for(0ms) != std::future_status::timeout)
        return fail(
            "Project authority release completed before the blocked watcher read was released");

    permit_read.set_value();
    if (released.wait_for(2s) != std::future_status::ready)
        return fail("Project authority release did not finish after permitting the watcher read");
    if (!released.get())
        return fail("Project authority release did not report success");
    if (authority.tracked_project_count() != 0)
        return fail("Project authority remained tracked after watcher shutdown");

    std::cout << "Windows Project watcher shutdown interleaving passed\n";
    return 0;
#endif
}
