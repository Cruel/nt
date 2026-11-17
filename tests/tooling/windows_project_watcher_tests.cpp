#include "tooling_project_authority.hpp"

#include <chrono>
#include <filesystem>
#include <fstream>
#include <future>
#include <iostream>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

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
        .authoritative_paths = {"project.yaml", "editor.yaml", "traits.yaml"},
        .discovery_scopes =
            {
                ProjectSourceDiscoveryScope{
                    .root = "records",
                    .extensions = {".yaml", ".lua", ".rcss", ".rml"},
                },
                ProjectSourceDiscoveryScope{.root = "scripts", .extensions = {".lua"}},
                ProjectSourceDiscoveryScope{.root = "i18n", .extensions = {".yaml"}},
            },
    };
}

int fail(std::string_view message)
{
    std::cerr << "Windows Project watcher lifecycle regression failed: " << message << '\n';
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
    if (!write_project_file(root.path / "project.yaml",
                            "schema: noveltea.project.workspace\nschemaVersion: 1\n") ||
        !write_project_file(root.path / "editor.yaml", "{}\n") ||
        !write_project_file(root.path / "traits.yaml", "{}\n") ||
        !write_project_file(root.path / "records/room.yaml", "id: room\n") ||
        !write_project_file(root.path / "scripts/main.lua", "return true\n") ||
        !write_project_file(root.path / "i18n/locales/en.yaml", "{}\n") ||
        !write_project_file(root.path / "records/ignored.txt", "ignored\n"))
        return fail("could not create the Project fixture");

    // The initial observe must not return before Windows has armed its first
    // overlapped directory read. Otherwise the first post-recovery edit may be
    // missed permanently, even if the test polls status for several seconds.
    {
        std::promise<void> first_read_reached;
        auto reached = first_read_reached.get_future();
        std::promise<void> allow_first_read;
        auto permitted = allow_first_read.get_future().share();
        std::promise<void> recovery_read_reached;
        auto recovery_reached = recovery_read_reached.get_future();
        std::promise<void> allow_recovery_read;
        auto recovery_permitted = allow_recovery_read.get_future().share();
        bool first_read = true;
        bool block_recovery_read = false;
        bool recovery_read_seen = false;
        ProjectAuthorityManager startup({
            .enable_native_watcher = true,
            .windows_watcher_before_read =
                [&] {
                    if (first_read) {
                        first_read = false;
                        first_read_reached.set_value();
                        permitted.wait();
                    } else if (block_recovery_read && !recovery_read_seen) {
                        recovery_read_seen = true;
                        recovery_read_reached.set_value();
                        recovery_permitted.wait();
                    }
                },
        });
        auto observing = std::async(std::launch::async, [&] {
            return startup.observe(project_authority_request(root.path));
        });
        if (reached.wait_for(2s) != std::future_status::ready) {
            allow_first_read.set_value();
            return fail("initial watcher did not reach the pre-read gate");
        }
        const bool observe_waited_for_arming =
            observing.wait_for(200ms) == std::future_status::timeout;
        allow_first_read.set_value();
        if (observing.wait_for(2s) != std::future_status::ready)
            return fail("initial observation did not complete after arming its watcher");
        if (observing.get().manifest.entries.size() != 6)
            return fail("initial watcher admission did not prove all six sources");
        if (!observe_waited_for_arming)
            return fail("observation returned before the first directory read was armed");

        if (!write_project_file(root.path / "records/room.yaml", "id: post-admission\n"))
            return fail("could not modify the Project after watcher admission");
        bool observed_change = false;
        for (int attempt = 0; attempt < 200; ++attempt) {
            const auto status = startup.status(root.path);
            if (status &&
                status->state == noveltea::tooling::daemon::ProjectAuthorityState::dirty) {
                observed_change =
                    status->pending_paths == std::vector<std::string>{"records/room.yaml"};
                break;
            }
            std::this_thread::sleep_for(10ms);
        }
        if (!observed_change)
            return fail("first post-admission write was not reported by native watching");

        // Reproduce the failing CI sequence with a deterministic gate on the
        // replacement watcher. The new directory is created while coverage is
        // unknown; after the rescan, a second write must be observable.
        startup.notify_watcher_unknown(root.path);
        if (!write_project_file(root.path / "records/recovered/new.yaml", "{}\n"))
            return fail("could not create the unwatched recovered source");
        block_recovery_read = true;
        auto recovering = std::async(std::launch::async, [&] {
            return startup.observe(project_authority_request(root.path));
        });
        if (recovery_reached.wait_for(2s) != std::future_status::ready) {
            allow_recovery_read.set_value();
            return fail("replacement watcher did not reach the pre-read gate");
        }
        const bool recovery_waited_for_arming =
            recovering.wait_for(200ms) == std::future_status::timeout;
        allow_recovery_read.set_value();
        if (recovering.wait_for(2s) != std::future_status::ready)
            return fail("recovery did not complete after arming the replacement watcher");
        const auto recovered = recovering.get();
        if (!recovery_waited_for_arming)
            return fail("recovery returned before replacement coverage was armed");
        if (!recovered.full_rescan ||
            recovered.delta.added != std::vector<std::string>{"records/recovered/new.yaml"})
            return fail("recovery did not discover the newly created nested source");

        if (!write_project_file(root.path / "records/recovered/new.yaml", "changed: true\n"))
            return fail("could not modify the recovered source");
        bool observed_recovered_change = false;
        for (int attempt = 0; attempt < 200; ++attempt) {
            const auto status = startup.status(root.path);
            if (status &&
                status->state == noveltea::tooling::daemon::ProjectAuthorityState::dirty) {
                observed_recovered_change =
                    status->pending_paths == std::vector<std::string>{"records/recovered/new.yaml"};
                break;
            }
            std::this_thread::sleep_for(10ms);
        }
        if (!observed_recovered_change)
            return fail("replacement watcher missed the first recovered-source write");
    }
    std::filesystem::remove(root.path / "records/recovered/new.yaml", error);
    if (error)
        return fail("could not clean up the recovered source before shutdown test");

    std::promise<void> before_read_reached;
    auto before_read = before_read_reached.get_future();
    std::promise<void> permit_read;
    auto permit_read_future = permit_read.get_future().share();
    std::promise<void> stop_requested;
    auto stop = stop_requested.get_future();
    int read_attempts = 0;

    ProjectAuthorityManager authority({
        .enable_native_watcher = true,
        .windows_watcher_before_read =
            [&] {
                // Block the re-arm after an already active read has handled an
                // event. Startup itself must now wait for the first read.
                if (++read_attempts != 2)
                    return;
                before_read_reached.set_value();
                permit_read_future.wait();
            },
        .windows_watcher_stop_requested = [&] { stop_requested.set_value(); },
    });

    if (authority.observe(project_authority_request(root.path)).manifest.entries.size() != 6)
        return fail("initial Project observation did not contain six authored sources");
    if (!write_project_file(root.path / "records/room.yaml", "id: trigger-rearm\n"))
        return fail("could not trigger the native watcher re-arm");
    if (before_read.wait_for(2s) != std::future_status::ready) {
        permit_read.set_value();
        return fail("Windows watcher did not reach the re-arm test gate");
    }

    auto released = std::async(std::launch::async, [&] { return authority.release(root.path); });
    if (stop.wait_for(2s) != std::future_status::ready) {
        permit_read.set_value();
        return fail("Windows watcher shutdown did not signal the stop event");
    }
    if (released.wait_for(0ms) != std::future_status::timeout) {
        permit_read.set_value();
        return fail(
            "Project authority release completed before the blocked watcher read was released");
    }

    permit_read.set_value();
    if (released.wait_for(2s) != std::future_status::ready)
        return fail("Project authority release did not finish after permitting the watcher read");
    if (!released.get())
        return fail("Project authority release did not report success");
    if (authority.tracked_project_count() != 0)
        return fail("Project authority remained tracked after watcher shutdown");

    std::cout << "Windows Project watcher startup, recovery and shutdown passed\n";
    return 0;
#endif
}
