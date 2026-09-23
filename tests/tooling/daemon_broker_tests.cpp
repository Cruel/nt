#include "tooling_daemon_broker.hpp"
#include "tooling_native_c.h"
#include "tooling_project_authority.hpp"

#include <catch2/catch_test_macros.hpp>
#include <nlohmann/json.hpp>

#include <chrono>
#include <csignal>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <functional>
#include <future>
#include <optional>
#include <string>
#include <thread>
#include <vector>

#if !defined(_WIN32)
#include <fcntl.h>
#include <sys/file.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>
#endif

namespace {

using Json = nlohmann::json;

Json invoke_daemon(const Json& request)
{
    const auto text = request.dump();
    std::vector<std::uint8_t> response(128 * 1024);
    const auto required =
        noveltea_tooling_daemon_json(reinterpret_cast<const std::uint8_t*>(text.data()),
                                     text.size(), response.data(), response.size());
    REQUIRE(required <= response.size());
    return Json::parse(std::string(reinterpret_cast<const char*>(response.data()),
                                   static_cast<std::size_t>(required)));
}

Json invoke_scriptc_adapter(std::string_view operation, std::string_view request_text)
{
    const auto response_path =
        std::filesystem::temp_directory_path() /
        ("noveltea-daemon-scriptc-" +
         std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()) + ".json");
    const auto response_path_text = response_path.generic_string();
    noveltea_tooling_scriptc_invoke_to_file(
        reinterpret_cast<const std::uint8_t*>(operation.data()), operation.size(),
        reinterpret_cast<const std::uint8_t*>(request_text.data()), request_text.size(),
        reinterpret_cast<const std::uint8_t*>(response_path_text.data()),
        response_path_text.size());
    std::ifstream input(response_path, std::ios::binary);
    const std::string response((std::istreambuf_iterator<char>(input)),
                               std::istreambuf_iterator<char>());
    std::error_code error;
    std::filesystem::remove(response_path, error);
    return Json::parse(response);
}

Json invoke_daemon_via_scriptc_adapter(const Json& request)
{
    return invoke_scriptc_adapter("daemon", request.dump());
}

std::string unique_build(std::string_view suffix)
{
    return "daemon-test-" + std::string(suffix) + "-" +
           std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());
}

Json context(std::string build)
{
    return {{"build", std::move(build)},
            {"protocol", noveltea::tooling::daemon::protocol_version},
            {"daemonIdleMs", 5000},
            {"projectSessionIdleMs", 2500},
            {"disableDisposableWorkerProcessesForTests", true}};
}

Json scheduler_context(std::string build)
{
    auto result = context(std::move(build));
    result["disableDisposableWorkerProcessesForTests"] = false;
    result["simulateWorkerProcessesForTests"] = true;
    result["disposableExtraIdleMs"] = 80;
    result["projectSessionIdleMs"] = 10'000;
    return result;
}

Json daemon_status(Json request)
{
    request["action"] = "status";
    return invoke_daemon(request);
}

bool wait_until(std::function<bool()> predicate,
                std::chrono::milliseconds timeout = std::chrono::seconds(2))
{
    const auto deadline = std::chrono::steady_clock::now() + timeout;
    while (std::chrono::steady_clock::now() < deadline) {
        if (predicate())
            return true;
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    return predicate();
}

std::optional<std::uint64_t> owner_worker_for_root(const Json& status,
                                                   const std::filesystem::path& root)
{
    std::error_code error;
    const auto canonical = std::filesystem::canonical(root, error).string();
    if (error || !status.contains("engineeringOwners"))
        return std::nullopt;
    for (const auto& owner : status["engineeringOwners"]) {
        if (owner.value("canonicalRoot", std::string{}) == canonical)
            return owner.value("workerId", std::uint64_t{0});
    }
    return std::nullopt;
}

std::vector<std::uint64_t> disposable_worker_ids(const Json& status)
{
    std::vector<std::uint64_t> result;
    for (const auto& worker : status.value("engineeringDisposableWorkers", Json::array()))
        result.push_back(worker.value("workerId", std::uint64_t{0}));
    return result;
}

Json owner_request(Json base, std::string request_id, const std::filesystem::path& root,
                   std::string execution_class = "owner-short")
{
    base["action"] = "request";
    base["requestId"] = std::move(request_id);
    base["method"] = "invoke";
    base["payload"] = Json{{"argv", Json::array({"validate"})},
                           {"executionClass", std::move(execution_class)},
                           {"ownerProjectRoot", root.string()},
                           {"ownerProjectRootExplicit", true},
                           {"environment", Json::object()}};
    return base;
}

Json disposable_request(Json base, std::string request_id)
{
    base["action"] = "request";
    base["requestId"] = std::move(request_id);
    base["method"] = "invoke";
    base["payload"] = Json{{"argv", Json::array({"project", "create", "unused"})},
                           {"executionClass", "disposable-heavy"},
                           {"ownerProjectRoot", nullptr},
                           {"environment", Json::object()}};
    return base;
}

struct TempRuntimeRoot {
    std::filesystem::path path;
    ~TempRuntimeRoot()
    {
        std::error_code error;
        std::filesystem::remove_all(path, error);
    }
};

TempRuntimeRoot temp_runtime_root(std::string_view suffix)
{
    TempRuntimeRoot root{
        std::filesystem::temp_directory_path() /
        ("noveltea-daemon-test-" + std::string(suffix) + "-" +
         std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()))};
    return root;
}

struct TempProjectRoot {
    std::filesystem::path path;
    ~TempProjectRoot()
    {
        std::error_code error;
        std::filesystem::remove_all(path, error);
    }
};

void write_project_file(const std::filesystem::path& path, std::string_view contents)
{
    std::filesystem::create_directories(path.parent_path());
    std::ofstream output(path, std::ios::binary | std::ios::trunc);
    REQUIRE(output.good());
    output.write(contents.data(), static_cast<std::streamsize>(contents.size()));
    REQUIRE(output.good());
}

TempProjectRoot temp_project_root(std::string_view suffix)
{
    TempProjectRoot root{
        std::filesystem::temp_directory_path() /
        ("noveltea-project-authority-" + std::string(suffix) + "-" +
         std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()))};
    std::filesystem::create_directories(root.path);
    write_project_file(root.path / "project.json", "{}\n");
    write_project_file(root.path / "editor.json", "{}\n");
    write_project_file(root.path / "traits.json", "{}\n");
    write_project_file(root.path / "records/room.json", "{\"id\":\"room\"}\n");
    write_project_file(root.path / "scripts/main.lua", "return true\n");
    write_project_file(root.path / "i18n/en.json", "{}\n");
    write_project_file(root.path / "records/ignored.txt", "ignored\n");
    return root;
}

noveltea::tooling::daemon::ProjectAuthorityRequest
project_authority_request(const std::filesystem::path& root)
{
    using noveltea::tooling::daemon::ProjectSourceDiscoveryScope;
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

std::vector<std::string>
manifest_paths(const noveltea::tooling::daemon::ProjectSourceManifest& manifest)
{
    std::vector<std::string> paths;
    paths.reserve(manifest.entries.size());
    for (const auto& entry : manifest.entries)
        paths.push_back(entry.path);
    return paths;
}

noveltea::tooling::daemon::ProjectAuthorityCheckpoint
snapshot_authority_checkpoint(std::string_view canonical_root)
{
    using noveltea::tooling::daemon::ProjectAuthorityCheckpoint;
    return ProjectAuthorityCheckpoint{
        .canonical_root = std::filesystem::path(canonical_root),
        .manifest = {.canonical_root = std::string(canonical_root)},
    };
}

} // namespace

TEST_CASE("Project authority batches unchanged and add-change-remove observation")
{
    using namespace noveltea::tooling::daemon;
    auto root = temp_project_root("delta");
    ProjectAuthorityManager authority({.enable_native_watcher = false});

    const auto first = authority.observe(project_authority_request(root.path));
    CHECK(first.previous_state == ProjectAuthorityState::untracked);
    CHECK_FALSE(first.unchanged);
    CHECK(first.full_rescan);
    CHECK(first.delta.added == manifest_paths(first.manifest));
    CHECK(first.delta.changed.empty());
    CHECK(first.delta.removed.empty());
    CHECK(manifest_paths(first.manifest) ==
          std::vector<std::string>{"editor.json", "i18n/en.json", "project.json",
                                   "records/room.json", "scripts/main.lua", "traits.json"});
    for (const auto& entry : first.manifest.entries) {
        CHECK_FALSE(entry.source_identity.empty());
        CHECK(entry.byte_size > 0);
        CHECK(entry.mtime_nanoseconds.has_value());
        CHECK_FALSE(entry.content_hash.has_value());
    }

    const auto unchanged = authority.observe(project_authority_request(root.path));
    CHECK(unchanged.previous_state == ProjectAuthorityState::proven);
    CHECK(unchanged.unchanged);
    CHECK_FALSE(unchanged.full_rescan);
    CHECK(unchanged.delta.added.empty());
    CHECK(unchanged.delta.changed.empty());
    CHECK(unchanged.delta.removed.empty());

    write_project_file(root.path / "records/room.json", "{\"id\":\"room-2\"}\n");
    write_project_file(root.path / "records/new.json", "{}\n");
    std::filesystem::remove(root.path / "scripts/main.lua");
    write_project_file(root.path / "records/ignored.txt", "unrelated change\n");

    const auto changed = authority.observe(project_authority_request(root.path));
    CHECK_FALSE(changed.unchanged);
    CHECK(changed.delta.added == std::vector<std::string>{"records/new.json"});
    CHECK(changed.delta.changed == std::vector<std::string>{"records/room.json"});
    CHECK(changed.delta.removed == std::vector<std::string>{"scripts/main.lua"});
    const auto changed_paths = manifest_paths(changed.manifest);
    CHECK(std::find(changed_paths.begin(), changed_paths.end(), "records/ignored.txt") ==
          changed_paths.end());

    const auto alias = root.path / "records/..";
    const auto aliased = authority.observe(project_authority_request(alias));
    CHECK(aliased.unchanged);
    CHECK(aliased.manifest.canonical_root == first.manifest.canonical_root);
    CHECK(authority.tracked_project_count() == 1);
}

TEST_CASE("Project authority wildcard discovery tracks arbitrary Asset files and additions")
{
    using namespace noveltea::tooling::daemon;
    auto root = temp_project_root("asset-wildcard");
    write_project_file(root.path / "assets/portrait.custom", "first\n");
    auto request = project_authority_request(root.path);
    request.discovery_scopes.push_back(
        ProjectSourceDiscoveryScope{.root = "assets", .extensions = {"*"}});
    ProjectAuthorityManager authority({.enable_native_watcher = false});

    const auto first = authority.observe(request);
    const auto first_paths = manifest_paths(first.manifest);
    CHECK(std::find(first_paths.begin(), first_paths.end(), "assets/portrait.custom") !=
          first_paths.end());

    write_project_file(root.path / "assets/new.extension-without-registry", "second\n");
    const auto changed = authority.observe(request);
    CHECK(changed.delta.added ==
          std::vector<std::string>{"assets/new.extension-without-registry"});
}

TEST_CASE("Project authority detects same-path same-metadata physical source replacement")
{
    using namespace noveltea::tooling::daemon;
    auto root = temp_project_root("source-identity");
    ProjectAuthorityManager authority({.enable_native_watcher = false});
    const auto first = authority.observe(project_authority_request(root.path));
    const auto before =
        std::find_if(first.manifest.entries.begin(), first.manifest.entries.end(),
                     [](const auto& entry) { return entry.path == "records/room.json"; });
    REQUIRE(before != first.manifest.entries.end());
    REQUIRE(before->mtime_nanoseconds.has_value());

    const auto source_path = root.path / "records/room.json";
    const auto replacement_path = root.path / "records/room-replacement.tmp";
    const auto original_write_time = std::filesystem::last_write_time(source_path);
    write_project_file(replacement_path, "{\"id\":\"ROOM\"}\n");
    REQUIRE(std::filesystem::file_size(replacement_path) == before->byte_size);
    std::filesystem::last_write_time(replacement_path, original_write_time);
    std::filesystem::remove(source_path);
    std::filesystem::rename(replacement_path, source_path);

    const auto replaced = authority.observe(project_authority_request(root.path));
    const auto after =
        std::find_if(replaced.manifest.entries.begin(), replaced.manifest.entries.end(),
                     [](const auto& entry) { return entry.path == "records/room.json"; });
    REQUIRE(after != replaced.manifest.entries.end());
    CHECK(after->byte_size == before->byte_size);
    CHECK(after->mtime_nanoseconds == before->mtime_nanoseconds);
    CHECK(after->source_identity != before->source_identity);
    CHECK(replaced.delta.changed == std::vector<std::string>{"records/room.json"});
}

TEST_CASE("Project authority reports exact authoritative source deletion and restoration")
{
    using namespace noveltea::tooling::daemon;
    auto root = temp_project_root("authoritative-deletion");
    ProjectAuthorityManager authority({.enable_native_watcher = false});
    REQUIRE(authority.observe(project_authority_request(root.path)).manifest.entries.size() == 6);

    std::filesystem::remove(root.path / "traits.json");
    const auto removed = authority.observe(project_authority_request(root.path));
    CHECK(removed.delta.added.empty());
    CHECK(removed.delta.changed.empty());
    CHECK(removed.delta.removed == std::vector<std::string>{"traits.json"});
    CHECK(manifest_paths(removed.manifest) ==
          std::vector<std::string>{"editor.json", "i18n/en.json", "project.json",
                                   "records/room.json", "scripts/main.lua"});

    write_project_file(root.path / "traits.json", "{}\n");
    const auto restored = authority.observe(project_authority_request(root.path));
    CHECK(restored.delta.added == std::vector<std::string>{"traits.json"});
    CHECK(restored.delta.changed.empty());
    CHECK(restored.delta.removed.empty());
}

TEST_CASE("Project authority watcher dirtiness coalesces and unknown state forces a full rescan")
{
    using namespace noveltea::tooling::daemon;
    auto root = temp_project_root("watcher-state");
    ProjectAuthorityManager authority({.enable_native_watcher = false});
    const auto initial = authority.observe(project_authority_request(root.path));
    REQUIRE(initial.manifest.entries.size() == 6);

    authority.notify_path_changed(root.path, "records/room.json", false);
    authority.notify_path_changed(root.path, "records/room.json", false);
    authority.notify_path_changed(root.path, "scripts/main.lua", false);
    authority.notify_path_changed(root.path, "records/ignored.txt", false);
    const auto dirty = authority.status(root.path);
    REQUIRE(dirty);
    CHECK(dirty->state == ProjectAuthorityState::dirty);
    CHECK(dirty->has_manifest);
    CHECK(dirty->pending_paths ==
          std::vector<std::string>{"records/room.json", "scripts/main.lua"});

    const auto coalesced = authority.observe(project_authority_request(root.path));
    CHECK(coalesced.previous_state == ProjectAuthorityState::dirty);
    CHECK(coalesced.unchanged);
    CHECK(coalesced.watcher_paths ==
          std::vector<std::string>{"records/room.json", "scripts/main.lua"});
    CHECK_FALSE(coalesced.full_rescan);

    authority.notify_watcher_unknown(root.path);
    const auto unknown = authority.status(root.path);
    REQUIRE(unknown);
    CHECK(unknown->state == ProjectAuthorityState::unknown);
    CHECK(unknown->has_manifest);

    const auto recovered = authority.observe(project_authority_request(root.path));
    CHECK(recovered.previous_state == ProjectAuthorityState::unknown);
    CHECK(recovered.full_rescan);
    CHECK(recovered.unchanged);
    REQUIRE(authority.status(root.path));
    CHECK(authority.status(root.path)->state == ProjectAuthorityState::proven);
}

#if defined(__linux__) || defined(_WIN32)
TEST_CASE("Project authority native watcher revokes relevant proofs and ignores unrelated files")
{
    using namespace noveltea::tooling::daemon;
    auto root = temp_project_root("native-watcher");
    ProjectAuthorityManager authority;
    REQUIRE(authority.observe(project_authority_request(root.path)).manifest.entries.size() == 6);

    write_project_file(root.path / "records/room.json", "{\"id\":\"room-a\"}\n");
    write_project_file(root.path / "records/room.json", "{\"id\":\"room-b\"}\n");
    for (int attempt = 0; attempt < 100; ++attempt) {
        const auto status = authority.status(root.path);
        if (status && status->state == ProjectAuthorityState::dirty)
            break;
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    const auto dirty = authority.status(root.path);
    REQUIRE(dirty);
    CHECK(dirty->state == ProjectAuthorityState::dirty);
    CHECK(dirty->has_manifest);
    CHECK(dirty->pending_paths == std::vector<std::string>{"records/room.json"});

    const auto reconciled = authority.observe(project_authority_request(root.path));
    CHECK(reconciled.previous_state == ProjectAuthorityState::dirty);
    CHECK(reconciled.delta.changed == std::vector<std::string>{"records/room.json"});

    write_project_file(root.path / "records/ignored.txt", "watcher should ignore this\n");
    std::this_thread::sleep_for(std::chrono::milliseconds(120));
    const auto ignored = authority.status(root.path);
    REQUIRE(ignored);
    CHECK(ignored->state == ProjectAuthorityState::proven);
    CHECK(ignored->pending_paths.empty());
}

TEST_CASE("Project authority unknown recovery rebuilds recursive native watcher coverage")
{
    using namespace noveltea::tooling::daemon;
    auto root = temp_project_root("watcher-recovery");
    ProjectAuthorityManager authority;
    REQUIRE(authority.observe(project_authority_request(root.path)).manifest.entries.size() == 6);

    // The deterministic unknown seam drops the native watcher, emulating coverage lost after an
    // overflow or watcher restart. Create a source subtree while no watcher can observe it.
    authority.notify_watcher_unknown(root.path);
    const auto unknown = authority.status(root.path);
    REQUIRE(unknown);
    CHECK(unknown->state == ProjectAuthorityState::unknown);
    write_project_file(root.path / "records/recovered/new.json", "{}\n");

    const auto recovered = authority.observe(project_authority_request(root.path));
    CHECK(recovered.previous_state == ProjectAuthorityState::unknown);
    CHECK(recovered.full_rescan);
    CHECK(recovered.delta.added == std::vector<std::string>{"records/recovered/new.json"});
    REQUIRE(authority.status(root.path));
    CHECK(authority.status(root.path)->state == ProjectAuthorityState::proven);

    // Recovery is only complete if the newly discovered directory is watched afterward.
    write_project_file(root.path / "records/recovered/new.json", "{\"changed\":true}\n");
    for (int attempt = 0; attempt < 100; ++attempt) {
        const auto status = authority.status(root.path);
        if (status && status->state == ProjectAuthorityState::dirty)
            break;
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    const auto dirty = authority.status(root.path);
    REQUIRE(dirty);
    CHECK(dirty->state == ProjectAuthorityState::dirty);
    CHECK(dirty->pending_paths == std::vector<std::string>{"records/recovered/new.json"});
}

TEST_CASE("Project authority release stops native watcher before dropping Project ownership")
{
    using namespace noveltea::tooling::daemon;
    auto root = temp_project_root("watcher-release");
    ProjectAuthorityManager authority;
    REQUIRE(authority.observe(project_authority_request(root.path)).manifest.entries.size() == 6);

    // Queue a burst so release overlaps native callback activity. Release must synchronously
    // stop/join the watcher while it still owns the Entry, rather than allowing callback-held
    // ownership to destroy the watcher on its own thread.
    for (int index = 0; index < 64; ++index)
        write_project_file(root.path / "records/room.json",
                           "{\"id\":" + std::to_string(index) + "}\n");

    CHECK(authority.release(root.path));
    CHECK(authority.tracked_project_count() == 0);
    CHECK_FALSE(authority.status(root.path).has_value());
}

TEST_CASE("Project authority suspension retains its manifest but forces proof on resume")
{
    using namespace noveltea::tooling::daemon;
    auto root = temp_project_root("watcher-suspend");
    ProjectAuthorityManager authority;
    REQUIRE(authority.observe(project_authority_request(root.path)).manifest.entries.size() == 6);

    REQUIRE(authority.suspend(root.path));
    const auto dormant = authority.status(root.path);
    REQUIRE(dormant);
    CHECK(dormant->state == ProjectAuthorityState::unknown);
    CHECK(dormant->has_manifest);

    write_project_file(root.path / "records/room.json", "{\"id\":\"dormant-change\"}\n");
    const auto resumed = authority.observe(project_authority_request(root.path));
    CHECK(resumed.previous_state == ProjectAuthorityState::unknown);
    CHECK(resumed.full_rescan);
    CHECK(resumed.delta.changed == std::vector<std::string>{"records/room.json"});
    REQUIRE(authority.status(root.path));
    CHECK(authority.status(root.path)->state == ProjectAuthorityState::proven);
}

TEST_CASE("Project authority checkpoint restores deltas consumed after a retained snapshot")
{
    using namespace noveltea::tooling::daemon;
    auto root = temp_project_root("checkpoint-restore");
    ProjectAuthorityManager authority({.enable_native_watcher = false});
    REQUIRE(authority.observe(project_authority_request(root.path)).manifest.entries.size() == 6);

    const auto retained = authority.checkpoint(root.path);
    REQUIRE(retained);

    write_project_file(root.path / "records/room.json", "{\"id\":\"after-snapshot\"}\n");
    const auto consumed = authority.observe(project_authority_request(root.path));
    CHECK(consumed.delta.changed == std::vector<std::string>{"records/room.json"});
    CHECK(authority.observe(project_authority_request(root.path)).unchanged);

    REQUIRE(authority.restore_checkpoint_for_rehydration(*retained));
    const auto recovered = authority.observe(project_authority_request(root.path));
    CHECK(recovered.previous_state == ProjectAuthorityState::unknown);
    CHECK(recovered.full_rescan);
    CHECK(recovered.delta.changed == std::vector<std::string>{"records/room.json"});
}

#if defined(_WIN32)
TEST_CASE("Project authority Windows watcher stops when shutdown wins before overlapped read")
{
    using namespace noveltea::tooling::daemon;
    using namespace std::chrono_literals;

    auto root = temp_project_root("windows-stop-before-read");
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
    REQUIRE(authority.observe(project_authority_request(root.path)).manifest.entries.size() == 6);
    REQUIRE(before_read.wait_for(2s) == std::future_status::ready);

    auto released = std::async(std::launch::async, [&] { return authority.release(root.path); });
    // Prove shutdown has signalled the explicit stop event while the watcher is still paused in
    // the exact pre-read interleaving that used to race CancelSynchronousIo.
    REQUIRE(stop.wait_for(2s) == std::future_status::ready);
    CHECK(released.wait_for(0ms) == std::future_status::timeout);

    permit_read.set_value();
    REQUIRE(released.wait_for(2s) == std::future_status::ready);
    CHECK(released.get());
    CHECK(authority.tracked_project_count() == 0);
}
#endif
#endif

TEST_CASE(
    "Project authority falls back to content identity when nanosecond metadata is unavailable")
{
    using namespace noveltea::tooling::daemon;
    auto root = temp_project_root("metadata-fallback");
    ProjectAuthorityManager authority({
        .enable_native_watcher = false,
        .mtime_reader = [](const std::filesystem::path&) -> std::optional<std::uint64_t> {
            return std::nullopt;
        },
    });

    const auto first = authority.observe(project_authority_request(root.path));
    REQUIRE_FALSE(first.manifest.entries.empty());
    for (const auto& entry : first.manifest.entries) {
        CHECK_FALSE(entry.source_identity.empty());
        CHECK_FALSE(entry.mtime_nanoseconds.has_value());
        CHECK(entry.content_hash.has_value());
    }
    CHECK(authority.observe(project_authority_request(root.path)).unchanged);

    write_project_file(root.path / "records/room.json", "{\"id\":\"ROom\"}\n");
    const auto changed = authority.observe(project_authority_request(root.path));
    CHECK(changed.delta.changed == std::vector<std::string>{"records/room.json"});
}

TEST_CASE("daemon broker exposes one batched Project authority observation action")
{
    auto root = temp_project_root("broker-observe");
    auto request = context(unique_build("project-observe"));
    request["action"] = "serve-start";
    REQUIRE(invoke_daemon(request)["ok"] == true);

    request["action"] = "serve-project-observe";
    request["projectRoot"] = root.path.generic_string();
    request["authoritativePaths"] = Json::array({"project.json", "editor.json", "traits.json"});
    request["discoveryScopes"] =
        Json::array({{{"root", "records"},
                      {"extensions", Json::array({".json", ".lua", ".rcss", ".rml"})},
                      {"excludedPrefixes", Json::array()}},
                     {{"root", "scripts"},
                      {"extensions", Json::array({".lua"})},
                      {"excludedPrefixes", Json::array()}},
                     {{"root", "i18n"},
                      {"extensions", Json::array({".json"})},
                      {"excludedPrefixes", Json::array()}}});
    const auto first = invoke_daemon_via_scriptc_adapter(request);
    REQUIRE(first["ok"] == true);
    CHECK(first["authority"] == "proven");
    CHECK(first["previousAuthority"] == "untracked");
    CHECK(first["fullRescan"] == true);
    REQUIRE(first["manifest"]["entries"].is_array());
    CHECK(first["manifest"]["entries"].size() == 6);
    for (const auto& entry : first["manifest"]["entries"]) {
        REQUIRE(entry["sourceIdentity"].is_string());
        CHECK_FALSE(entry["sourceIdentity"].get<std::string>().empty());
    }

    const auto unchanged = invoke_daemon_via_scriptc_adapter(request);
    REQUIRE(unchanged["ok"] == true);
    CHECK(unchanged["unchanged"] == true);
    CHECK(unchanged["previousAuthority"] == "proven");
    CHECK(unchanged["delta"] ==
          Json{{"added", Json::array()}, {"changed", Json::array()}, {"removed", Json::array()}});

#if !defined(_WIN32)
    // ENAMETOOLONG is a deterministic metadata-inspection failure even when tests run as root.
    // It must not be treated as an absent discovery root or replace the retained manifest.
    const auto valid_discovery_scopes = request["discoveryScopes"];
    request["discoveryScopes"].push_back(
        {{"root", std::string(300, 'x')}, {"extensions", Json::array({".json"})}});
    const auto discovery_error = invoke_daemon_via_scriptc_adapter(request);
    CHECK(discovery_error["ok"] == false);
    CHECK(discovery_error["error"].get<std::string>().find(
              "Cannot inspect Project discovery directory") != std::string::npos);

    request["discoveryScopes"] = valid_discovery_scopes;
    const auto recovered_after_discovery_error = invoke_daemon_via_scriptc_adapter(request);
    REQUIRE(recovered_after_discovery_error["ok"] == true);
    CHECK(recovered_after_discovery_error["fullRescan"] == true);
    CHECK(recovered_after_discovery_error["unchanged"] == true);
#endif

    std::filesystem::remove(root.path / "records/room.json");
    std::filesystem::create_directory(root.path / "records/room.json");
    const auto reclassified = invoke_daemon_via_scriptc_adapter(request);
    CHECK(reclassified["ok"] == false);
    CHECK(reclassified["error"].get<std::string>().find("not a regular file") != std::string::npos);

    request["action"] = "serve-project-release";
    request.erase("authoritativePaths");
    request.erase("discoveryScopes");
    const auto released = invoke_daemon_via_scriptc_adapter(request);
    REQUIRE(released["ok"] == true);
    CHECK(released["released"] == true);

    request.erase("projectRoot");
    request["action"] = "stop";
    REQUIRE(invoke_daemon(request)["ok"] == true);
    request["action"] = "serve-wait";
    REQUIRE(invoke_daemon(request)["ok"] == true);
}

TEST_CASE("daemon frames are length-prefixed, fragment-safe, and bounded")
{
    using namespace noveltea::tooling::daemon;
    const auto frame = encode_frame(R"({"type":"request","requestId":"abc"})");
    REQUIRE(frame.size() > 8);

    FrameDecoder decoder;
    CHECK(decoder.feed(std::span(frame).first(2)));
    CHECK(decoder.frames().empty());
    CHECK(decoder.feed(std::span(frame).subspan(2, 3)));
    CHECK(decoder.frames().empty());
    CHECK(decoder.feed(std::span(frame).subspan(5)));
    REQUIRE(decoder.frames().size() == 1);
    CHECK(decoder.frames().front() == R"({"type":"request","requestId":"abc"})");

    std::vector<std::uint8_t> oversized = {0x00, 0x10, 0x00, 0x01};
    FrameDecoder rejected;
    CHECK_FALSE(rejected.feed(oversized));
    CHECK(rejected.error() == "daemon frame exceeds maximum size");
}

TEST_CASE("daemon endpoint identity separates build and protocol")
{
    using noveltea::tooling::daemon::endpoint_identity;
    const auto first = endpoint_identity("build-a", 1);
    CHECK(first == endpoint_identity("build-a", 1));
    CHECK(first != endpoint_identity("build-b", 1));
    CHECK(first != endpoint_identity("build-a", 2));
}

TEST_CASE("portable Project snapshots retain current and pinned historical generations")
{
    using namespace noveltea::tooling::daemon;
    ProjectSnapshotStore snapshots;
    const ProjectGenerationIdentity first{.session_epoch = 7, .generation = 1};
    const ProjectGenerationIdentity second{.session_epoch = 7, .generation = 2};

    REQUIRE(snapshots.declare_current("/project", first, 9));
    REQUIRE(snapshots.publish("/project", first, {"{\"first\":", "true}"}, "owner-1",
                              snapshot_authority_checkpoint("/project"), 10));
    REQUIRE(snapshots.pin_current("/project", first, 11));
    REQUIRE(snapshots.declare_current("/project", second, 12));
    REQUIRE(snapshots.publish("/project", second, {"{\"second\":true}"}, "owner-2",
                              snapshot_authority_checkpoint("/project"), 12));
    CHECK_FALSE(snapshots.publish("/project", first, {"stale"}, "owner-stale",
                                  snapshot_authority_checkpoint("/project"), 12));

    REQUIRE(snapshots.latest("/project", 13));
    CHECK(snapshots.latest("/project", 13)->identity == second);
    CHECK_FALSE(snapshots.pin_current("/project", first, 14));
    REQUIRE(snapshots.find("/project", first, 15));
    CHECK(snapshots.find("/project", first, 15)->pin_count == 1);
    REQUIRE(snapshots.authority_checkpoint("/project", first, 15));
    CHECK(snapshots.authority_checkpoint("/project", first, 15)->manifest.canonical_root ==
          "/project");
    CHECK(snapshots.snapshot_count() == 2);

    REQUIRE(snapshots.unpin("/project", first, 16));
    CHECK_FALSE(snapshots.find("/project", first, 17));
    CHECK(snapshots.snapshot_count() == 1);
}

TEST_CASE("portable Project snapshots retain the latest serialized fallback while preparation lags")
{
    using namespace noveltea::tooling::daemon;
    ProjectSnapshotStore snapshots;
    const ProjectGenerationIdentity first{.session_epoch = 11, .generation = 1};
    const ProjectGenerationIdentity second{.session_epoch = 11, .generation = 2};

    REQUIRE(snapshots.declare_current("/project", first, 1));
    REQUIRE(snapshots.publish("/project", first, {"first"}, "owner-1",
                              snapshot_authority_checkpoint("/project"), 2));
    REQUIRE(snapshots.declare_current("/project", second, 3));
    REQUIRE(snapshots.latest("/project", 4));
    CHECK(snapshots.latest("/project", 4)->identity == first);
    CHECK(snapshots.snapshot_count() == 1);

    REQUIRE(snapshots.publish("/project", second, {"second"}, "owner-2",
                              snapshot_authority_checkpoint("/project"), 5));
    REQUIRE(snapshots.latest("/project", 6));
    CHECK(snapshots.latest("/project", 6)->identity == second);
    CHECK_FALSE(snapshots.find("/project", first, 6));
    CHECK(snapshots.snapshot_count() == 1);
}

TEST_CASE("portable Project snapshot pressure discards dormant unpinned state only")
{
    using namespace noveltea::tooling::daemon;
    ProjectSnapshotStore snapshots;
    const ProjectGenerationIdentity identity{.session_epoch = 1, .generation = 1};
    REQUIRE(snapshots.declare_current("/active", identity, 9));
    REQUIRE(snapshots.publish("/active", identity, {"active"}, "owner",
                              snapshot_authority_checkpoint("/active"), 10));
    REQUIRE(snapshots.declare_current("/dormant", identity, 4));
    REQUIRE(snapshots.publish("/dormant", identity, {"dormant"}, "owner",
                              snapshot_authority_checkpoint("/dormant"), 5));
    const auto active_bytes = snapshots.latest("/active", 11)->byte_size;
    CHECK(active_bytes > std::string_view("active").size() + std::string_view("owner").size());

    snapshots.trim_dormant_to_budget({"/active"}, active_bytes);
    CHECK(snapshots.latest("/active", 12));
    CHECK_FALSE(snapshots.latest("/dormant", 12));
    CHECK(snapshots.retained_bytes() == active_bytes);

    REQUIRE(snapshots.declare_current("/pinned", identity, 1));
    REQUIRE(snapshots.publish("/pinned", identity, {"pinned"}, "owner",
                              snapshot_authority_checkpoint("/pinned"), 1));
    REQUIRE(snapshots.pin_current("/pinned", identity, 2));
    snapshots.trim_dormant_to_budget({}, 0);
    CHECK(snapshots.find("/pinned", identity, 3));
    REQUIRE(snapshots.unpin("/pinned", identity, 4));
    snapshots.trim_dormant_to_budget({}, 0);
    CHECK_FALSE(snapshots.find("/pinned", identity, 5));
}

TEST_CASE("exact validation pressure evicts dormant least-recently-used Projects only")
{
    using noveltea::tooling::daemon::ExactValidationStore;
    using noveltea::tooling::daemon::RetainedExactValidationResult;

    ExactValidationStore results;
    results.retain(
        RetainedExactValidationResult{
            .canonical_root = "/active",
            .semantic_key = "semantic",
            .authority = snapshot_authority_checkpoint("/active"),
            .semantic_result_json = std::string(256, 'a'),
            .revision = 1,
        },
        10);
    results.retain(
        RetainedExactValidationResult{
            .canonical_root = "/older",
            .semantic_key = "semantic",
            .authority = snapshot_authority_checkpoint("/older"),
            .semantic_result_json = std::string(256, 'b'),
            .revision = 2,
        },
        20);
    results.retain(
        RetainedExactValidationResult{
            .canonical_root = "/newer",
            .semantic_key = "semantic",
            .authority = snapshot_authority_checkpoint("/newer"),
            .semantic_result_json = std::string(256, 'c'),
            .revision = 3,
        },
        30);

    const auto active = results.find("/active", "semantic", 40);
    REQUIRE(active);
    const auto one_result_budget = active->byte_size;
    const auto evicted = results.trim_dormant_to_budget({"/active"}, one_result_budget);

    CHECK(evicted == std::vector<std::string>{"/older", "/newer"});
    CHECK(results.find("/active", "semantic", 50));
    CHECK_FALSE(results.find("/older", "semantic", 50));
    CHECK_FALSE(results.find("/newer", "semantic", 50));
    CHECK(results.result_count() == 1);
    CHECK(results.retained_bytes() == one_result_budget);
}

TEST_CASE("exact validation proof detects disk changes without watcher delivery")
{
    using noveltea::tooling::daemon::ExactValidationStore;
    using noveltea::tooling::daemon::ProjectAuthorityManager;
    using noveltea::tooling::daemon::ProjectAuthorityOptions;
    using noveltea::tooling::daemon::prove_exact_validation_result;
    using noveltea::tooling::daemon::RetainedExactValidationResult;

    auto root = temp_project_root("exact-validation-no-watcher");
    ProjectAuthorityOptions options;
    options.enable_native_watcher = false;
    ProjectAuthorityManager authority(std::move(options));
    const auto request = project_authority_request(root.path);
    const auto initial = authority.observe(request);
    REQUIRE_FALSE(initial.manifest.entries.empty());
    const auto checkpoint = authority.checkpoint(root.path);
    REQUIRE(checkpoint.has_value());

    ExactValidationStore store;
    store.retain(
        RetainedExactValidationResult{
            .canonical_root = initial.manifest.canonical_root,
            .semantic_key = "validation-v1",
            .authority = *checkpoint,
            .semantic_result_json =
                R"({"success":true,"exitCode":0,"diagnostics":[],"editorDiagnostics":[]})",
            .revision = 1,
        },
        10);

    const auto unchanged = prove_exact_validation_result(
        authority, store, initial.manifest.canonical_root, "validation-v1", 20);
    REQUIRE(unchanged.observation.has_value());
    REQUIRE(unchanged.result.has_value());

    write_project_file(root.path / "records/room.json", "{\"id\":\"room-changed\"}\n");
    const auto stale = prove_exact_validation_result(
        authority, store, initial.manifest.canonical_root, "validation-v1", 30);
    REQUIRE(stale.observation.has_value());
    CHECK_FALSE(stale.result.has_value());
    CHECK_FALSE(store.find(initial.manifest.canonical_root, "validation-v1", 40).has_value());

    const auto owner_observation = authority.observe(request);
    CHECK(owner_observation.full_rescan);
    CHECK(owner_observation.delta.changed == std::vector<std::string>{"records/room.json"});
}

TEST_CASE("authoring cache directory is created safely for a fresh Project")
{
    using noveltea::tooling::daemon::ensure_authoring_cache_directory;

    auto root = temp_project_root("authoring-cache-directory");
    const auto cache_root = root.path / ".noveltea";
    std::error_code error;
    std::filesystem::remove_all(cache_root, error);
    REQUIRE_FALSE(error);

    const auto directory = ensure_authoring_cache_directory(root.path);
    REQUIRE(directory.has_value());
    CHECK(*directory == root.path / ".noveltea" / "cache" / "authoring");
    CHECK(std::filesystem::is_directory(*directory));

#if !defined(_WIN32)
    std::filesystem::remove_all(cache_root, error);
    REQUIRE_FALSE(error);
    const auto outside = temp_runtime_root("authoring-cache-directory-outside");
    std::filesystem::create_directory(cache_root);
    std::filesystem::create_directory_symlink(outside.path, cache_root / "cache");
    CHECK_FALSE(ensure_authoring_cache_directory(root.path).has_value());
#endif
}

TEST_CASE("portable Project snapshot invalidation removes crash-stale current bytes but keeps pins")
{
    using namespace noveltea::tooling::daemon;
    ProjectSnapshotStore snapshots;
    const ProjectGenerationIdentity first{.session_epoch = 3, .generation = 1};
    const ProjectGenerationIdentity second{.session_epoch = 3, .generation = 2};
    REQUIRE(snapshots.declare_current("/project", first, 1));
    REQUIRE(snapshots.publish("/project", first, {"first"}, "owner",
                              snapshot_authority_checkpoint("/project"), 2));
    REQUIRE(snapshots.pin_current("/project", first, 3));
    REQUIRE(snapshots.declare_current("/project", second, 4));
    REQUIRE(snapshots.publish("/project", second, {"second"}, "owner",
                              snapshot_authority_checkpoint("/project"), 5));

    snapshots.invalidate_current("/project");
    CHECK_FALSE(snapshots.latest("/project", 6));
    CHECK_FALSE(snapshots.find("/project", second, 6));
    CHECK(snapshots.find("/project", first, 6));
    REQUIRE(snapshots.unpin("/project", first, 7));
    CHECK(snapshots.snapshot_count() == 0);
}

TEST_CASE("daemon Project-owner nomination preserves explicit roots and discovers implicit roots")
{
    using noveltea::tooling::daemon::canonical_project_owner_root;
    auto root = temp_project_root("owner-root");
    const auto nested = root.path / "nested" / "deeper";
    std::filesystem::create_directories(nested);

    const auto canonical_root = std::filesystem::canonical(root.path).lexically_normal();
    CHECK(std::filesystem::path(canonical_project_owner_root(nested.string(), true)) ==
          canonical_root);
    CHECK(canonical_project_owner_root(nested.string(), false).empty());
    CHECK(std::filesystem::path(canonical_project_owner_root(root.path.string(), false)) ==
          canonical_root);

    auto non_project = temp_runtime_root("owner-root-none");
    std::filesystem::create_directories(non_project.path / "nested");
    CHECK(canonical_project_owner_root((non_project.path / "nested").string(), true).empty());

#if !defined(_WIN32)
    const auto alias = root.path / "owner-alias";
    std::filesystem::create_directory_symlink(root.path, alias);
    CHECK(std::filesystem::path(canonical_project_owner_root(alias.string(), false)) ==
          canonical_root);
#endif
}

TEST_CASE("ScriptC daemon adapter executes stateful broker actions once")
{
    auto request = context(unique_build("scriptc-adapter"));
    request["action"] = "serve-start";
    const auto started = invoke_daemon_via_scriptc_adapter(request);
    REQUIRE(started["ok"] == true);
    CHECK(started["state"] == "starting");

    request["action"] = "stop";
    REQUIRE(invoke_daemon(request)["ok"] == true);
    request["action"] = "serve-wait";
    REQUIRE(invoke_daemon(request)["ok"] == true);
}

TEST_CASE("ScriptC native adapter reports terminal dimensions when available")
{
    const auto terminal = invoke_scriptc_adapter("terminal-size", "");
    REQUIRE(terminal.contains("columns"));
    REQUIRE(terminal.contains("rows"));
    if (!terminal["columns"].is_null())
        CHECK(terminal["columns"].get<std::uint64_t>() > 0);
    if (!terminal["rows"].is_null())
        CHECK(terminal["rows"].get<std::uint64_t>() > 0);
}

TEST_CASE("daemon protocol event shapes preserve request identity")
{
    using namespace noveltea::tooling::daemon;
    const auto result = Json::parse(result_event_json("req-1", true, R"({"value":4})"));
    CHECK(result == Json{{"type", "result"},
                         {"requestId", "req-1"},
                         {"ok", true},
                         {"final", true},
                         {"result", Json{{"value", 4}}}});

    const auto stdout_event = Json::parse(text_event_json("stdout", "req-2", "hello"));
    CHECK(stdout_event == Json{{"type", "stdout"}, {"requestId", "req-2"}, {"text", "hello"}});
    const auto stderr_event = Json::parse(text_event_json("stderr", "req-2", "warning"));
    CHECK(stderr_event["type"] == "stderr");

    const auto progress = Json::parse(progress_event_json("req-3", "loading", 2, 5));
    CHECK(progress == Json{{"type", "progress"},
                           {"requestId", "req-3"},
                           {"message", "loading"},
                           {"completed", 2},
                           {"total", 5}});

    const auto cancellation = Json::parse(cancellation_event_json("req-4"));
    CHECK(cancellation == Json{{"type", "cancel"}, {"requestId", "req-4"}});
}

TEST_CASE("daemon broker exposes starting, queues work until ready, and drains on stop")
{
    auto request = context(unique_build("lifecycle"));
    request["action"] = "serve-start";
    const auto started = invoke_daemon(request);
    REQUIRE(started["ok"] == true);
    REQUIRE(started["running"] == true);
    CHECK(started["state"] == "starting");

    auto status_request = request;
    status_request["action"] = "status";
    const auto starting = invoke_daemon(status_request);
    REQUIRE(starting["running"] == true);
    CHECK(starting["state"] == "starting");
    CHECK(starting["build"] == request["build"]);
    CHECK(starting["protocol"] == noveltea::tooling::daemon::protocol_version);
    CHECK(starting["pid"].is_number_integer());

    auto work_request = request;
    work_request["action"] = "request";
    work_request["requestId"] = "queued-1";
    work_request["method"] = "future-worker-command";
    auto pending =
        std::async(std::launch::async, [work_request]() { return invoke_daemon(work_request); });
    CHECK(pending.wait_for(std::chrono::milliseconds(50)) == std::future_status::timeout);

    auto ready_request = request;
    ready_request["action"] = "serve-ready";
    const auto ready = invoke_daemon(ready_request);
    REQUIRE(ready["ok"] == true);
    CHECK(ready["state"] == "ready");

    auto next_request = request;
    next_request["action"] = "serve-next";
    const auto next = invoke_daemon(next_request);
    REQUIRE(next["ok"] == true);
    REQUIRE(next["stopped"] == false);
    CHECK(next["requestId"] == "queued-1");
    CHECK(next["method"] == "future-worker-command");
    REQUIRE(next["token"].is_number_unsigned());

    auto complete_request = request;
    complete_request["action"] = "serve-complete";
    complete_request["token"] = next["token"];
    complete_request["requestOk"] = true;
    complete_request["result"] = Json{{"value", 7}};
    REQUIRE(invoke_daemon(complete_request)["ok"] == true);

    REQUIRE(pending.wait_for(std::chrono::seconds(2)) == std::future_status::ready);
    const auto completed = pending.get();
    CHECK(completed["ok"] == true);
    CHECK(completed["requestId"] == "queued-1");
    CHECK(completed["result"] == Json{{"value", 7}});

    const auto ready_status = invoke_daemon(status_request);
    CHECK(ready_status["state"] == "ready");
    CHECK(ready_status["projectSessionIdleMs"] == 2500);
    CHECK(ready_status["daemonIdleMs"] == 5000);

    auto stop_request = request;
    stop_request["action"] = "stop";
    const auto stopped = invoke_daemon(stop_request);
    REQUIRE(stopped["ok"] == true);
    CHECK(stopped["running"] == false);
    CHECK(stopped["state"] == "stopped");

    auto wait_request = request;
    wait_request["action"] = "serve-wait";
    const auto waited = invoke_daemon(wait_request);
    CHECK(waited["ok"] == true);
    CHECK(waited["state"] == "stopped");

    const auto final_status = invoke_daemon(status_request);
    CHECK(final_status["running"] == false);
    CHECK(final_status["state"] == "stopped");
}

TEST_CASE("daemon shutdown does not wait for optional exact-validation persistence")
{
    auto project = temp_project_root("validation-publication-shutdown");
    auto gate_root = temp_runtime_root("validation-publication-gate");
    std::filesystem::create_directories(gate_root.path);
    const auto gate = gate_root.path / "publication";
    auto started_path = gate;
    started_path += ".started";
    auto release_path = gate;
    release_path += ".release";
    auto finished_path = gate;
    finished_path += ".finished";

    auto request = scheduler_context(unique_build("validation-publication-shutdown"));
    request["validationPublicationTestGate"] = gate.string();
    request["action"] = "serve-start";
    REQUIRE(invoke_daemon(request)["ok"] == true);
    request["action"] = "serve-ready";
    REQUIRE(invoke_daemon(request)["ok"] == true);

    auto work = owner_request(request, "validation-publication", project.path);
    work["payload"]["authoringValidationSemanticKey"] = "test-semantic-key";
    auto foreground = std::async(std::launch::async, [work] { return invoke_daemon(work); });
    REQUIRE(wait_until(
        [&] { return owner_worker_for_root(daemon_status(request), project.path).has_value(); }));
    const auto owner = owner_worker_for_root(daemon_status(request), project.path);
    REQUIRE(owner);

    auto next = request;
    next["action"] = "owner-next";
    next["ownerWorkerId"] = *owner;
    const auto owner_work = invoke_daemon(next);
    REQUIRE(owner_work["ok"] == true);

    auto observe = request;
    observe["action"] = "owner-project-observe";
    observe["ownerWorkerId"] = *owner;
    observe["projectRoot"] = project.path.string();
    observe["authoritativePaths"] = Json::array({"project.json", "editor.json", "traits.json"});
    observe["discoveryScopes"] =
        Json::array({Json{{"root", "records"}, {"extensions", Json::array({".json"})}},
                     Json{{"root", "scripts"}, {"extensions", Json::array({".lua"})}},
                     Json{{"root", "i18n"}, {"extensions", Json::array({".json"})}}});
    REQUIRE(invoke_daemon(observe)["ok"] == true);

    auto retain = request;
    retain["action"] = "owner-validation-result";
    retain["ownerWorkerId"] = *owner;
    retain["token"] = owner_work["token"];
    retain["semanticKey"] = "test-semantic-key";
    retain["validationResult"] = Json{{"success", true},
                                       {"exitCode", 0},
                                       {"diagnostics", Json::array()},
                                       {"editorDiagnostics", Json::array()}};
    REQUIRE(invoke_daemon(retain)["ok"] == true);

    auto complete = request;
    complete["action"] = "owner-complete";
    complete["ownerWorkerId"] = *owner;
    complete["token"] = owner_work["token"];
    complete["requestOk"] = true;
    complete["result"] = Json{{"done", true}};
    REQUIRE(invoke_daemon(complete)["ok"] == true);
    REQUIRE(foreground.wait_for(std::chrono::seconds(2)) == std::future_status::ready);
    REQUIRE(foreground.get()["ok"] == true);
    REQUIRE(wait_until([&] { return std::filesystem::exists(started_path); }));
    CHECK_FALSE(std::filesystem::exists(finished_path));

    auto stop = request;
    stop["action"] = "stop";
    REQUIRE(invoke_daemon(stop)["ok"] == true);
    auto wait = request;
    wait["action"] = "serve-wait";
    auto shutdown = std::async(std::launch::async, [wait] { return invoke_daemon(wait); });
    REQUIRE(shutdown.wait_for(std::chrono::seconds(2)) == std::future_status::ready);
    CHECK(shutdown.get()["state"] == "stopped");
    CHECK_FALSE(std::filesystem::exists(finished_path));

    write_project_file(release_path, "release\n");
    REQUIRE(wait_until([&] { return std::filesystem::exists(finished_path); }));
}

TEST_CASE("queued daemon request can be cancelled before worker readiness")
{
    auto request = context(unique_build("cancel"));
    request["action"] = "serve-start";
    REQUIRE(invoke_daemon(request)["ok"] == true);

    auto work_request = request;
    work_request["action"] = "request";
    work_request["requestId"] = "cancel-me";
    work_request["method"] = "future-worker-command";
    work_request["cancelAfterMs"] = 20;
    const auto cancelled = invoke_daemon(work_request);
    CHECK(cancelled["ok"] == false);
    CHECK(cancelled["requestId"] == "cancel-me");
    CHECK(cancelled["cancelled"] == true);

    auto stop_request = request;
    stop_request["action"] = "stop";
    REQUIRE(invoke_daemon(stop_request)["ok"] == true);
    request["action"] = "serve-wait";
    REQUIRE(invoke_daemon(request)["ok"] == true);
}

TEST_CASE("daemon rejects the superseded direct execution class")
{
    auto request = context(unique_build("direct-cutover"));
    request["action"] = "serve-start";
    REQUIRE(invoke_daemon(request)["ok"] == true);
    request["action"] = "serve-ready";
    REQUIRE(invoke_daemon(request)["ok"] == true);

    auto work_request = request;
    work_request["action"] = "request";
    work_request["requestId"] = "direct-cutover";
    work_request["method"] = "invoke";
    work_request["payload"] = Json{{"argv", Json::array({"project", "create", "new"})},
                                   {"executionClass", "direct"},
                                   {"ownerProjectRoot", nullptr}};
    const auto rejected = invoke_daemon(work_request);
    CHECK(rejected["ok"] == false);
    CHECK(rejected["error"] == "daemon execution class is unsupported");

    work_request["requestId"] = "direct-owner-cutover";
    work_request["payload"]["ownerProjectRoot"] = "/tmp/retired-direct-owner";
    const auto owner_rejected = invoke_daemon(work_request);
    CHECK(owner_rejected["ok"] == false);
    CHECK(owner_rejected["error"] == "daemon execution class is unsupported");

    work_request["requestId"] = "missing-class-cutover";
    work_request["payload"].erase("executionClass");
    const auto missing_class = invoke_daemon(work_request);
    CHECK(missing_class["ok"] == false);
    CHECK(missing_class["error"] == "daemon execution class is malformed");

    request["action"] = "stop";
    REQUIRE(invoke_daemon(request)["ok"] == true);
    request["action"] = "serve-wait";
    REQUIRE(invoke_daemon(request)["ok"] == true);
}

TEST_CASE("daemon scheduler bounds owners and prioritizes queued Project admission over heavy work")
{
    auto request = scheduler_context(unique_build("global-worker-cap"));
    request["action"] = "serve-start";
    REQUIRE(invoke_daemon(request)["ok"] == true);
    request["action"] = "serve-ready";
    REQUIRE(invoke_daemon(request)["ok"] == true);
    REQUIRE(wait_until([&] { return daemon_status(request)["disposableStandbyWorkers"] == 1; }));

    auto projects = temp_runtime_root("scheduler-cap-projects");
    std::vector<std::filesystem::path> roots;
    std::vector<std::future<Json>> owner_results;
    for (int index = 0; index < 8; ++index) {
        const auto root = projects.path / ("project-" + std::to_string(index));
        write_project_file(root / "project.json", "{}\n");
        roots.push_back(root);
        const auto work = owner_request(request, "owner-" + std::to_string(index), root);
        owner_results.push_back(
            std::async(std::launch::async, [work] { return invoke_daemon(work); }));
        REQUIRE(wait_until(
            [&] { return owner_worker_for_root(daemon_status(request), root).has_value(); }));
    }

    const auto saturated = daemon_status(request);
    CHECK(saturated["projectOwnerWorkers"] == 8);
    CHECK(saturated["disposableWorkers"] == 0);
    CHECK(saturated["engineeringWorkerProcesses"] == 8);

    auto heavy_request = disposable_request(request, "queued-heavy");
    auto heavy =
        std::async(std::launch::async, [heavy_request] { return invoke_daemon(heavy_request); });
    CHECK(heavy.wait_for(std::chrono::milliseconds(50)) == std::future_status::timeout);

    const auto ninth_root = projects.path / "project-8";
    write_project_file(ninth_root / "project.json", "{}\n");
    const auto ninth_request = owner_request(request, "owner-8", ninth_root);
    auto ninth =
        std::async(std::launch::async, [ninth_request] { return invoke_daemon(ninth_request); });
    REQUIRE(wait_until([&] {
        return daemon_status(request).value("engineeringQueuedProjectAdmissions", 0) == 1;
    }));
    CHECK_FALSE(owner_worker_for_root(daemon_status(request), ninth_root).has_value());

    const auto first_owner = owner_worker_for_root(daemon_status(request), roots.front());
    REQUIRE(first_owner);
    auto next = request;
    next["action"] = "owner-next";
    next["ownerWorkerId"] = *first_owner;
    const auto first_work = invoke_daemon(next);
    REQUIRE(first_work["ok"] == true);
    REQUIRE(first_work["requestId"] == "owner-0");
    auto complete = request;
    complete["action"] = "owner-complete";
    complete["ownerWorkerId"] = *first_owner;
    complete["token"] = first_work["token"];
    complete["requestOk"] = true;
    complete["result"] = Json{{"done", true}};
    REQUIRE(invoke_daemon(complete)["ok"] == true);
    REQUIRE(owner_results.front().wait_for(std::chrono::seconds(2)) == std::future_status::ready);
    CHECK(owner_results.front().get()["ok"] == true);

    REQUIRE(wait_until(
        [&] { return owner_worker_for_root(daemon_status(request), ninth_root).has_value(); }));
    const auto admitted = daemon_status(request);
    CHECK(admitted["engineeringWorkerProcesses"] == 8);
    CHECK(admitted["disposableWorkers"] == 0);
    CHECK(admitted["disposableQueuedJobs"] == 1);
    CHECK(heavy.wait_for(std::chrono::milliseconds(50)) == std::future_status::timeout);

    for (std::size_t index = 1; index < roots.size(); ++index) {
        const auto owner = owner_worker_for_root(daemon_status(request), roots[index]);
        REQUIRE(owner);
        next = request;
        next["action"] = "owner-next";
        next["ownerWorkerId"] = *owner;
        const auto owner_work = invoke_daemon(next);
        REQUIRE(owner_work["ok"] == true);
        complete = request;
        complete["action"] = "owner-complete";
        complete["ownerWorkerId"] = *owner;
        complete["token"] = owner_work["token"];
        complete["requestOk"] = true;
        complete["result"] = Json{{"done", true}};
        REQUIRE(invoke_daemon(complete)["ok"] == true);
        REQUIRE(owner_results[index].wait_for(std::chrono::seconds(2)) ==
                std::future_status::ready);
        CHECK(owner_results[index].get()["ok"] == true);
    }

    const auto ninth_owner = owner_worker_for_root(daemon_status(request), ninth_root);
    REQUIRE(ninth_owner);
    next = request;
    next["action"] = "owner-next";
    next["ownerWorkerId"] = *ninth_owner;
    const auto ninth_work = invoke_daemon(next);
    REQUIRE(ninth_work["ok"] == true);
    complete = request;
    complete["action"] = "owner-complete";
    complete["ownerWorkerId"] = *ninth_owner;
    complete["token"] = ninth_work["token"];
    complete["requestOk"] = true;
    complete["result"] = Json{{"done", true}};
    REQUIRE(invoke_daemon(complete)["ok"] == true);
    REQUIRE(ninth.wait_for(std::chrono::seconds(2)) == std::future_status::ready);
    CHECK(ninth.get()["ok"] == true);

    REQUIRE(wait_until([&] { return daemon_status(request)["disposableWorkers"] >= 1; }));
    auto status = daemon_status(request);
    auto disposable_ids = disposable_worker_ids(status);
    REQUIRE_FALSE(disposable_ids.empty());
    auto ready = request;
    ready["action"] = "disposable-ready";
    ready["disposableWorkerId"] = disposable_ids.front();
    REQUIRE(invoke_daemon(ready)["ok"] == true);
    REQUIRE(wait_until([&] { return daemon_status(request)["disposableBusyWorkers"] == 1; }));

    auto disposable_next = request;
    disposable_next["action"] = "disposable-next";
    disposable_next["disposableWorkerId"] = disposable_ids.front();
    const auto heavy_work = invoke_daemon(disposable_next);
    REQUIRE(heavy_work["ok"] == true);
    REQUIRE(heavy_work["requestId"] == "queued-heavy");
    auto disposable_complete = request;
    disposable_complete["action"] = "disposable-complete";
    disposable_complete["disposableWorkerId"] = disposable_ids.front();
    disposable_complete["token"] = heavy_work["token"];
    disposable_complete["requestOk"] = true;
    disposable_complete["result"] = Json{{"done", true}};
    REQUIRE(invoke_daemon(disposable_complete)["ok"] == true);
    REQUIRE(heavy.wait_for(std::chrono::seconds(2)) == std::future_status::ready);
    CHECK(heavy.get()["ok"] == true);

    REQUIRE(wait_until([&] {
        const auto current = daemon_status(request);
        return current["disposableStandbyWorkers"] == 1 &&
               current["engineeringWorkerProcesses"].get<std::size_t>() <= 8;
    }));

    request["action"] = "serve-abort";
    REQUIRE(invoke_daemon(request)["ok"] == true);
}

TEST_CASE(
    "daemon scheduler replenishes standbys and cleans up cancelled or crashed disposable workers")
{
    auto request = scheduler_context(unique_build("disposable-lifecycle"));
    request["action"] = "serve-start";
    REQUIRE(invoke_daemon(request)["ok"] == true);
    request["action"] = "serve-ready";
    REQUIRE(invoke_daemon(request)["ok"] == true);
    REQUIRE(wait_until([&] { return daemon_status(request)["disposableStandbyWorkers"] == 1; }));

    auto status = daemon_status(request);
    auto ids = disposable_worker_ids(status);
    REQUIRE(ids.size() == 1);
    auto ready = request;
    ready["action"] = "disposable-ready";
    ready["disposableWorkerId"] = ids.front();
    REQUIRE(invoke_daemon(ready)["ok"] == true);

    auto extra = request;
    extra["action"] = "serve-start-extra-disposable-for-tests";
    const auto extra_started = invoke_daemon(extra);
    REQUIRE(extra_started["ok"] == true);
    ready["disposableWorkerId"] = extra_started["workerId"];
    REQUIRE(invoke_daemon(ready)["ok"] == true);
    REQUIRE(wait_until([&] { return daemon_status(request)["disposableStandbyWorkers"] == 2; }));
    REQUIRE(wait_until([&] { return daemon_status(request)["disposableWorkers"] == 1; },
                       std::chrono::seconds(2)));

    status = daemon_status(request);
    ids = disposable_worker_ids(status);
    REQUIRE(ids.size() == 1);
    const auto cancelled_worker = ids.front();
    auto cancelled_request = disposable_request(request, "cancelled-heavy");
    cancelled_request["cancelAfterMs"] = 250;
    auto cancelled = std::async(std::launch::async,
                                [cancelled_request] { return invoke_daemon(cancelled_request); });
    REQUIRE(wait_until([&] { return daemon_status(request)["disposableBusyWorkers"] == 1; }));
    auto next = request;
    next["action"] = "disposable-next";
    next["disposableWorkerId"] = cancelled_worker;
    const auto cancelled_work = invoke_daemon(next);
    REQUIRE(cancelled_work["ok"] == true);
    REQUIRE(cancelled_work["requestId"] == "cancelled-heavy");
    REQUIRE(cancelled.wait_for(std::chrono::seconds(2)) == std::future_status::ready);
    const auto cancelled_result = cancelled.get();
    CHECK(cancelled_result["ok"] == false);
    CHECK(cancelled_result["cancelled"] == true);
    CHECK(cancelled_result["error"] == "request cancelled");
    REQUIRE(wait_until([&] {
        const auto current = daemon_status(request);
        const auto current_ids = disposable_worker_ids(current);
        return std::find(current_ids.begin(), current_ids.end(), cancelled_worker) ==
                   current_ids.end() &&
               current["disposableStandbyWorkers"] >= 1;
    }));

    status = daemon_status(request);
    for (const auto& worker : status["engineeringDisposableWorkers"]) {
        if (worker["state"] == "starting") {
            ready = request;
            ready["action"] = "disposable-ready";
            ready["disposableWorkerId"] = worker["workerId"];
            REQUIRE(invoke_daemon(ready)["ok"] == true);
        }
    }

    auto crashed_request = disposable_request(request, "crashed-heavy");
    auto crashed = std::async(std::launch::async,
                              [crashed_request] { return invoke_daemon(crashed_request); });
    REQUIRE(wait_until([&] { return daemon_status(request)["disposableBusyWorkers"] == 1; }));
    status = daemon_status(request);
    std::uint64_t crashed_worker = 0;
    for (const auto& worker : status["engineeringDisposableWorkers"]) {
        if (worker["state"] == "busy") {
            crashed_worker = worker["workerId"].get<std::uint64_t>();
            break;
        }
    }
    REQUIRE(crashed_worker != 0);
    next = request;
    next["action"] = "disposable-next";
    next["disposableWorkerId"] = crashed_worker;
    const auto crashed_work = invoke_daemon(next);
    REQUIRE(crashed_work["ok"] == true);
    REQUIRE(crashed_work["requestId"] == "crashed-heavy");

    auto crash = request;
    crash["action"] = "serve-simulate-worker-exit-for-tests";
    crash["workerKind"] = "disposable";
    crash["workerId"] = crashed_worker;
    REQUIRE(invoke_daemon(crash)["ok"] == true);
    REQUIRE(crashed.wait_for(std::chrono::seconds(2)) == std::future_status::ready);
    const auto crashed_result = crashed.get();
    CHECK(crashed_result["ok"] == false);
    CHECK(crashed_result["error"] == "daemon disposable worker exited unexpectedly");
    REQUIRE(wait_until([&] {
        const auto current = daemon_status(request);
        const auto current_ids = disposable_worker_ids(current);
        return std::find(current_ids.begin(), current_ids.end(), crashed_worker) ==
                   current_ids.end() &&
               current["disposableStandbyWorkers"] >= 1;
    }));

    auto projects = temp_runtime_root("owner-handoff-project");
    const auto root = projects.path / "project";
    write_project_file(root / "project.json", "{}\n");
    auto owner_work_request = owner_request(request, "owner-before-crash", root);
    auto owner_result = std::async(
        std::launch::async, [owner_work_request] { return invoke_daemon(owner_work_request); });
    REQUIRE(wait_until(
        [&] { return owner_worker_for_root(daemon_status(request), root).has_value(); }));
    const auto first_owner = owner_worker_for_root(daemon_status(request), root);
    REQUIRE(first_owner);
    auto owner_next = request;
    owner_next["action"] = "owner-next";
    owner_next["ownerWorkerId"] = *first_owner;
    const auto first_owner_work = invoke_daemon(owner_next);
    REQUIRE(first_owner_work["ok"] == true);
    auto owner_complete = request;
    owner_complete["action"] = "owner-complete";
    owner_complete["ownerWorkerId"] = *first_owner;
    owner_complete["token"] = first_owner_work["token"];
    owner_complete["requestOk"] = true;
    owner_complete["result"] = Json{{"done", true}};
    REQUIRE(invoke_daemon(owner_complete)["ok"] == true);
    REQUIRE(owner_result.wait_for(std::chrono::seconds(2)) == std::future_status::ready);
    CHECK(owner_result.get()["ok"] == true);

    crash = request;
    crash["action"] = "serve-simulate-worker-exit-for-tests";
    crash["workerKind"] = "owner";
    crash["workerId"] = *first_owner;
    REQUIRE(invoke_daemon(crash)["ok"] == true);
    owner_work_request = owner_request(request, "owner-after-crash", root);
    auto replacement_result = std::async(
        std::launch::async, [owner_work_request] { return invoke_daemon(owner_work_request); });
    REQUIRE(wait_until([&] {
        const auto replacement = owner_worker_for_root(daemon_status(request), root);
        return replacement.has_value() && *replacement != *first_owner;
    }));
    status = daemon_status(request);
    std::size_t same_root_owners = 0;
    const auto canonical_root = std::filesystem::canonical(root).string();
    for (const auto& owner : status["engineeringOwners"])
        if (owner["canonicalRoot"] == canonical_root)
            ++same_root_owners;
    CHECK(same_root_owners == 1);

    const auto replacement_owner = owner_worker_for_root(status, root);
    REQUIRE(replacement_owner);
    owner_next = request;
    owner_next["action"] = "owner-next";
    owner_next["ownerWorkerId"] = *replacement_owner;
    const auto replacement_work = invoke_daemon(owner_next);
    REQUIRE(replacement_work["ok"] == true);
    owner_complete = request;
    owner_complete["action"] = "owner-complete";
    owner_complete["ownerWorkerId"] = *replacement_owner;
    owner_complete["token"] = replacement_work["token"];
    owner_complete["requestOk"] = true;
    owner_complete["result"] = Json{{"done", true}};
    REQUIRE(invoke_daemon(owner_complete)["ok"] == true);
    REQUIRE(replacement_result.wait_for(std::chrono::seconds(2)) == std::future_status::ready);
    CHECK(replacement_result.get()["ok"] == true);

    request["action"] = "serve-abort";
    REQUIRE(invoke_daemon(request)["ok"] == true);
}

TEST_CASE("daemon disposable crash recovers registered output publication transactions")
{
    auto request = scheduler_context(unique_build("publication-recovery"));
    request["action"] = "serve-start";
    REQUIRE(invoke_daemon(request)["ok"] == true);
    request["action"] = "serve-ready";
    REQUIRE(invoke_daemon(request)["ok"] == true);
    REQUIRE(wait_until([&] { return daemon_status(request)["disposableStandbyWorkers"] == 1; }));

    auto root = temp_runtime_root("publication-recovery-files");
    const auto output = root.path / "artifact.bin";
    const auto staged = root.path / "artifact.stage";
    const auto backup = root.path / "artifact.backup";
    const auto unrelated_staged = root.path / "artifact.ntpkg";
    const auto transaction = root.path / "artifact.noveltea-publication-transaction.json";
    const auto read_text = [](const std::filesystem::path& value) {
        std::ifstream input(value, std::ios::binary);
        return std::string(std::istreambuf_iterator<char>(input),
                           std::istreambuf_iterator<char>());
    };

    const auto run_phase = [&](std::string_view phase, bool accepted) {
        write_project_file(output, "previous");
        write_project_file(staged, "replacement");
        std::error_code error;
        std::filesystem::remove(backup, error);
        std::filesystem::remove(transaction, error);

        auto status = daemon_status(request);
        auto ids = disposable_worker_ids(status);
        REQUIRE(!ids.empty());
        auto ready = request;
        ready["action"] = "disposable-ready";
        ready["disposableWorkerId"] = ids.front();
        REQUIRE(invoke_daemon(ready)["ok"] == true);

        auto work_request =
            disposable_request(request, std::string("publication-") + std::string(phase));
        auto result = std::async(std::launch::async,
                                 [work_request] { return invoke_daemon(work_request); });
        REQUIRE(wait_until([&] { return daemon_status(request)["disposableBusyWorkers"] == 1; }));
        status = daemon_status(request);
        std::uint64_t worker_id = 0;
        for (const auto& worker : status["engineeringDisposableWorkers"])
            if (worker["state"] == "busy") {
                worker_id = worker["workerId"].get<std::uint64_t>();
                break;
            }
        REQUIRE(worker_id != 0);
        auto next = request;
        next["action"] = "disposable-next";
        next["disposableWorkerId"] = worker_id;
        const auto work = invoke_daemon(next);
        REQUIRE(work["ok"] == true);

        auto register_output = request;
        register_output["action"] = "disposable-register-staged-output";
        register_output["disposableWorkerId"] = worker_id;
        register_output["token"] = work["token"];
        register_output["stagedOutputPath"] = unrelated_staged.string();
        REQUIRE(invoke_daemon(register_output)["ok"] == true);
        write_project_file(unrelated_staged, "not-json-package-bytes");
        register_output["stagedOutputPath"] = transaction.string();
        REQUIRE(invoke_daemon(register_output)["ok"] == true);

        Json journal = {
            {"format", "noveltea.output-publication-transaction"},
            {"version", 1},
            {"state", accepted ? "accepted" : "prepared"},
            {"entries",
             Json::array({{{"finalPath", output.string()},
                           {"stagedPath", staged.string()},
                           {"backupPath", backup.string()},
                           {"hadPrevious", true}}})},
        };
        write_project_file(transaction, journal.dump());
        std::filesystem::rename(output, backup);
        if (phase == "activated" || accepted)
            std::filesystem::rename(staged, output);

        auto crash = request;
        crash["action"] = "serve-simulate-worker-exit-for-tests";
        crash["workerKind"] = "disposable";
        crash["workerId"] = worker_id;
        REQUIRE(invoke_daemon(crash)["ok"] == true);
        REQUIRE(result.wait_for(std::chrono::seconds(2)) == std::future_status::ready);
        CHECK(result.get()["ok"] == false);
        REQUIRE(wait_until([&] { return !std::filesystem::exists(transaction); }));
        CHECK(std::filesystem::exists(output));
        CHECK(read_text(output) == (accepted ? "replacement" : "previous"));
        CHECK_FALSE(std::filesystem::exists(backup));
        CHECK_FALSE(std::filesystem::exists(staged));
        CHECK_FALSE(std::filesystem::exists(unrelated_staged));
        REQUIRE(wait_until([&] { return daemon_status(request)["disposableStandbyWorkers"] >= 1; }));
    };

    run_phase("backed-up", false);
    run_phase("activated", false);
    run_phase("accepted", true);

    request["action"] = "serve-abort";
    REQUIRE(invoke_daemon(request)["ok"] == true);
}

TEST_CASE("daemon Project owner crash rolls back an activated mixed publication")
{
    auto request = scheduler_context(unique_build("mixed-owner-crash"));
    request["action"] = "serve-start";
    REQUIRE(invoke_daemon(request)["ok"] == true);
    request["action"] = "serve-ready";
    REQUIRE(invoke_daemon(request)["ok"] == true);

    auto files = temp_runtime_root("mixed-owner-crash-files");
    const auto root = files.path / "project";
    write_project_file(root / "project.json", "{}\n");
    const auto output = files.path / "mixed.png";
    const auto staged = files.path / "mixed.stage";
    const auto backup = files.path / "mixed.backup";
    const auto transaction =
        files.path / "mixed.noveltea-publication-transaction.json";
    write_project_file(output, "previous");
    write_project_file(staged, "replacement");
    write_project_file(
        transaction,
        Json{{"format", "noveltea.output-publication-transaction"},
             {"version", 1},
             {"state", "prepared"},
             {"entries",
              Json::array({{{"finalPath", output.string()},
                            {"stagedPath", staged.string()},
                            {"backupPath", backup.string()},
                            {"hadPrevious", true}}})}}
            .dump());
    std::filesystem::rename(output, backup);
    std::filesystem::rename(staged, output);

    auto mutation_request = owner_request(request, "mixed-owner-mutation", root, "owner-mutation");
    mutation_request["payload"]["argv"] =
        Json::array({"comfyui", "__owner-asset-publication"});
    mutation_request["payload"]["internalOperation"] = "comfyui-asset-publication";
    mutation_request["payload"]["internalRequestText"] = "{}";
    mutation_request["payload"]["publicationTransactionPath"] = transaction.string();
    auto mutation = std::async(std::launch::async,
                               [mutation_request] { return invoke_daemon(mutation_request); });
    REQUIRE(wait_until(
        [&] { return owner_worker_for_root(daemon_status(request), root).has_value(); }));
    const auto owner_id = owner_worker_for_root(daemon_status(request), root);
    REQUIRE(owner_id);
    auto next = request;
    next["action"] = "owner-next";
    next["ownerWorkerId"] = *owner_id;
    const auto work = invoke_daemon(next);
    REQUIRE(work["ok"] == true);
    REQUIRE(work["payload"]["internalOperation"] == "comfyui-asset-publication");

    auto crash = request;
    crash["action"] = "serve-simulate-worker-exit-for-tests";
    crash["workerKind"] = "owner";
    crash["workerId"] = *owner_id;
    REQUIRE(invoke_daemon(crash)["ok"] == true);
    REQUIRE(mutation.wait_for(std::chrono::seconds(2)) == std::future_status::ready);
    CHECK(mutation.get()["ok"] == false);
    REQUIRE(wait_until([&] { return !std::filesystem::exists(transaction); }));
    REQUIRE(std::filesystem::exists(output));
    std::ifstream input(output, std::ios::binary);
    const std::string contents((std::istreambuf_iterator<char>(input)),
                               std::istreambuf_iterator<char>());
    CHECK(contents == "previous");
    CHECK_FALSE(std::filesystem::exists(backup));
    CHECK_FALSE(std::filesystem::exists(staged));

    request["action"] = "serve-abort";
    REQUIRE(invoke_daemon(request)["ok"] == true);
}

TEST_CASE("queued daemon request IDs are scoped to each client connection")
{
    auto request = context(unique_build("request-id-scope"));
    request["action"] = "serve-start";
    REQUIRE(invoke_daemon(request)["ok"] == true);

    auto work_request = request;
    work_request["action"] = "request";
    work_request["requestId"] = "shared-id";
    work_request["method"] = "future-worker-command";
    auto first =
        std::async(std::launch::async, [work_request]() { return invoke_daemon(work_request); });
    auto second =
        std::async(std::launch::async, [work_request]() { return invoke_daemon(work_request); });
    CHECK(first.wait_for(std::chrono::milliseconds(50)) == std::future_status::timeout);
    CHECK(second.wait_for(std::chrono::milliseconds(50)) == std::future_status::timeout);

    request["action"] = "serve-ready";
    REQUIRE(invoke_daemon(request)["ok"] == true);
    for (int index = 0; index < 2; ++index) {
        request["action"] = "serve-next";
        const auto next = invoke_daemon(request);
        REQUIRE(next["ok"] == true);
        CHECK(next["requestId"] == "shared-id");
        request["action"] = "serve-complete";
        request["token"] = next["token"];
        request["requestOk"] = true;
        request["result"] = Json{{"index", index}};
        REQUIRE(invoke_daemon(request)["ok"] == true);
    }
    REQUIRE(first.wait_for(std::chrono::seconds(2)) == std::future_status::ready);
    REQUIRE(second.wait_for(std::chrono::seconds(2)) == std::future_status::ready);
    for (const auto result : {first.get(), second.get()}) {
        CHECK(result["ok"] == true);
        CHECK(result["requestId"] == "shared-id");
    }

    request.erase("token");
    request.erase("requestOk");
    request.erase("result");
    request["action"] = "stop";
    REQUIRE(invoke_daemon(request)["ok"] == true);
    request["action"] = "serve-wait";
    REQUIRE(invoke_daemon(request)["ok"] == true);
}

TEST_CASE("active daemon request observes client cancellation")
{
    auto request = context(unique_build("active-cancel"));
    request["action"] = "serve-start";
    REQUIRE(invoke_daemon(request)["ok"] == true);
    request["action"] = "serve-ready";
    REQUIRE(invoke_daemon(request)["ok"] == true);

    auto work_request = request;
    work_request["action"] = "request";
    work_request["requestId"] = "active-cancel";
    work_request["method"] = "work";
    work_request["payload"] = Json{{"argv", Json::array({"validate"})}};
    work_request["cancelAfterMs"] = 20;
    auto pending =
        std::async(std::launch::async, [work_request]() { return invoke_daemon(work_request); });

    request["action"] = "serve-next";
    const auto next = invoke_daemon(request);
    REQUIRE(next["ok"] == true);
    REQUIRE(next["stopped"] == false);
    CHECK(next["payload"] == work_request["payload"]);

    std::this_thread::sleep_for(std::chrono::milliseconds(40));
    request["action"] = "serve-cancelled";
    request["token"] = next["token"];
    const auto cancelled = invoke_daemon(request);
    REQUIRE(cancelled["ok"] == true);
    CHECK(cancelled["active"] == true);
    CHECK(cancelled["cancelled"] == true);

    request["action"] = "serve-complete";
    request["requestOk"] = false;
    request["result"] = nullptr;
    request["error"] = "request cancelled";
    REQUIRE(invoke_daemon(request)["ok"] == true);
    REQUIRE(pending.wait_for(std::chrono::seconds(2)) == std::future_status::ready);
    const auto result = pending.get();
    CHECK(result["ok"] == false);
    CHECK(result["error"] == "request cancelled");

    request.erase("token");
    request.erase("requestOk");
    request.erase("result");
    request.erase("error");
    request["action"] = "stop";
    REQUIRE(invoke_daemon(request)["ok"] == true);
    request["action"] = "serve-wait";
    REQUIRE(invoke_daemon(request)["ok"] == true);
}

TEST_CASE("local ScriptC fallback observes process cancellation")
{
    auto request = context(unique_build("local-cancel"));
    request["action"] = "local-cancel-start";
    const auto started = invoke_daemon(request);
    REQUIRE(started["ok"] == true);
    CHECK(started["cancelled"] == false);

    std::raise(SIGINT);
    request["action"] = "local-cancelled";
    const auto cancelled = invoke_daemon(request);
    REQUIRE(cancelled["ok"] == true);
    CHECK(cancelled["active"] == true);
    CHECK(cancelled["cancelled"] == true);

    request["action"] = "local-cancel-stop";
    const auto stopped = invoke_daemon(request);
    REQUIRE(stopped["ok"] == true);
    CHECK(stopped["cancelled"] == true);

    request["action"] = "local-cancelled";
    const auto inactive = invoke_daemon(request);
    REQUIRE(inactive["ok"] == true);
    CHECK(inactive["active"] == false);
    CHECK(inactive["cancelled"] == false);
}

TEST_CASE("daemon client accepts streamed events before the final result")
{
    auto request = context(unique_build("stream-events"));
    request["action"] = "serve-start";
    REQUIRE(invoke_daemon(request)["ok"] == true);
    request["action"] = "serve-ready";
    REQUIRE(invoke_daemon(request)["ok"] == true);

    auto work_request = request;
    work_request["action"] = "request";
    work_request["requestId"] = "stream-events";
    work_request["method"] = "work";
    auto pending =
        std::async(std::launch::async, [work_request]() { return invoke_daemon(work_request); });

    request["action"] = "serve-next";
    const auto next = invoke_daemon(request);
    REQUIRE(next["ok"] == true);
    REQUIRE(next["stopped"] == false);

    request["action"] = "serve-event";
    request["token"] = next["token"];
    request["event"] = Json{{"type", "stdout"}, {"text", "streamed-event\n"}};
    const auto streamed = invoke_daemon(request);
    REQUIRE(streamed["ok"] == true);
    CHECK(streamed["delivered"] == true);
    CHECK(pending.wait_for(std::chrono::milliseconds(50)) == std::future_status::timeout);

    request.erase("event");
    request["action"] = "serve-complete";
    request["requestOk"] = true;
    request["result"] = Json{{"value", 9}};
    REQUIRE(invoke_daemon(request)["ok"] == true);
    REQUIRE(pending.wait_for(std::chrono::seconds(2)) == std::future_status::ready);
    const auto result = pending.get();
    CHECK(result["ok"] == true);
    CHECK(result["result"] == Json{{"value", 9}});

    request.erase("token");
    request.erase("requestOk");
    request.erase("result");
    request["action"] = "stop";
    REQUIRE(invoke_daemon(request)["ok"] == true);
    request["action"] = "serve-wait";
    REQUIRE(invoke_daemon(request)["ok"] == true);
}

TEST_CASE("daemon graceful stop waits for active requests to settle")
{
    auto request = context(unique_build("active-drain"));
    request["action"] = "serve-start";
    REQUIRE(invoke_daemon(request)["ok"] == true);
    request["action"] = "serve-ready";
    REQUIRE(invoke_daemon(request)["ok"] == true);

    auto work_request = request;
    work_request["action"] = "request";
    work_request["requestId"] = "active-drain";
    work_request["method"] = "work";
    work_request["payload"] = Json{{"argv", Json::array({"validate"})}};
    auto pending =
        std::async(std::launch::async, [work_request]() { return invoke_daemon(work_request); });

    request["action"] = "serve-next";
    const auto next = invoke_daemon(request);
    REQUIRE(next["ok"] == true);
    REQUIRE(next["stopped"] == false);

    auto stop_request = request;
    stop_request.erase("token");
    stop_request["action"] = "stop";
    auto stopping =
        std::async(std::launch::async, [stop_request]() { return invoke_daemon(stop_request); });
    CHECK(stopping.wait_for(std::chrono::milliseconds(80)) == std::future_status::timeout);

    request["action"] = "serve-complete";
    request["token"] = next["token"];
    request["requestOk"] = false;
    request["result"] = nullptr;
    request["error"] = "request cancelled";
    REQUIRE(invoke_daemon(request)["ok"] == true);

    REQUIRE(stopping.wait_for(std::chrono::seconds(2)) == std::future_status::ready);
    const auto stopped = stopping.get();
    REQUIRE(stopped["ok"] == true);
    CHECK(stopped["running"] == false);
    REQUIRE(pending.wait_for(std::chrono::seconds(2)) == std::future_status::ready);
    (void)pending.get();

    request.erase("token");
    request.erase("requestOk");
    request.erase("result");
    request.erase("error");
    request["action"] = "serve-wait";
    REQUIRE(invoke_daemon(request)["ok"] == true);
}

TEST_CASE("daemon idle timeout ignores active and queued work")
{
    auto request = context(unique_build("active-idle"));
    request["daemonIdleMs"] = 60;
    request["action"] = "serve-start";
    REQUIRE(invoke_daemon(request)["ok"] == true);
    request["action"] = "serve-ready";
    REQUIRE(invoke_daemon(request)["ok"] == true);

    auto work_request = request;
    work_request["action"] = "request";
    work_request["requestId"] = "active-idle";
    work_request["method"] = "work";
    auto pending =
        std::async(std::launch::async, [work_request]() { return invoke_daemon(work_request); });

    request["action"] = "serve-next";
    const auto next = invoke_daemon(request);
    REQUIRE(next["ok"] == true);
    REQUIRE(next["stopped"] == false);
    std::this_thread::sleep_for(std::chrono::milliseconds(140));

    auto status_request = request;
    status_request.erase("token");
    status_request["action"] = "status";
    const auto active_status = invoke_daemon(status_request);
    CHECK(active_status["running"] == true);
    CHECK(active_status["state"] == "ready");

    request["action"] = "serve-complete";
    request["token"] = next["token"];
    request["requestOk"] = true;
    request["result"] = Json{{"done", true}};
    REQUIRE(invoke_daemon(request)["ok"] == true);
    REQUIRE(pending.wait_for(std::chrono::seconds(2)) == std::future_status::ready);
    (void)pending.get();

    request.erase("token");
    request.erase("requestOk");
    request.erase("result");
    request["action"] = "serve-wait";
    auto waiting = std::async(std::launch::async, [request]() { return invoke_daemon(request); });
    REQUIRE(waiting.wait_for(std::chrono::seconds(2)) == std::future_status::ready);
    CHECK(waiting.get()["state"] == "stopped");
}

TEST_CASE("daemon graceful stop waits for transaction critical sections")
{
    auto request = context(unique_build("critical"));
    request["action"] = "serve-start";
    REQUIRE(invoke_daemon(request)["ok"] == true);
    request["action"] = "serve-ready";
    REQUIRE(invoke_daemon(request)["ok"] == true);
    request["action"] = "serve-enter-critical";
    const auto entered = invoke_daemon(request);
    REQUIRE(entered["ok"] == true);
    CHECK(entered["criticalSections"] == 1);

    auto stop_request = request;
    stop_request["action"] = "stop";
    auto stopping =
        std::async(std::launch::async, [stop_request]() { return invoke_daemon(stop_request); });
    CHECK(stopping.wait_for(std::chrono::milliseconds(50)) == std::future_status::timeout);

    request["action"] = "serve-leave-critical";
    const auto left = invoke_daemon(request);
    REQUIRE(left["ok"] == true);
    CHECK(left["criticalSections"] == 0);

    REQUIRE(stopping.wait_for(std::chrono::seconds(2)) == std::future_status::ready);
    const auto stopped = stopping.get();
    REQUIRE(stopped["ok"] == true);
    CHECK(stopped["running"] == false);

    request["action"] = "serve-wait";
    REQUIRE(invoke_daemon(request)["ok"] == true);
}

TEST_CASE("daemon broker expires after internal idle timeout")
{
    auto request = context(unique_build("idle"));
    request["daemonIdleMs"] = 60;
    request["action"] = "serve-start";
    REQUIRE(invoke_daemon(request)["ok"] == true);

    const auto started_at = std::chrono::steady_clock::now();
    request["action"] = "serve-wait";
    const auto waited = invoke_daemon(request);
    const auto elapsed = std::chrono::steady_clock::now() - started_at;
    REQUIRE(waited["ok"] == true);
    CHECK(waited["state"] == "stopped");
    CHECK(elapsed < std::chrono::seconds(2));
}

TEST_CASE("daemon idle drain preserves transaction critical sections")
{
    auto request = context(unique_build("idle-critical"));
    request["daemonIdleMs"] = 60;
    request["action"] = "serve-start";
    REQUIRE(invoke_daemon(request)["ok"] == true);
    request["action"] = "serve-enter-critical";
    REQUIRE(invoke_daemon(request)["ok"] == true);

    request["action"] = "serve-wait";
    auto waiting = std::async(std::launch::async, [request]() { return invoke_daemon(request); });
    CHECK(waiting.wait_for(std::chrono::milliseconds(120)) == std::future_status::timeout);

    request["action"] = "serve-leave-critical";
    REQUIRE(invoke_daemon(request)["ok"] == true);
    REQUIRE(waiting.wait_for(std::chrono::seconds(2)) == std::future_status::ready);
    const auto stopped = waiting.get();
    CHECK(stopped["state"] == "stopped");
}

#if !defined(_WIN32)
TEST_CASE("daemon ensure bounds hung status I/O by the startup deadline")
{
    auto runtime = temp_runtime_root("hung-status");
    std::filesystem::create_directories(runtime.path);
    auto request = context(unique_build("hung-status"));
    request["runtimeRoot"] = runtime.path.generic_string();
    request["action"] = "ensure";
    request["executablePath"] = "/bin/false";
    request["startupTimeoutMs"] = 80;

    const auto identity = noveltea::tooling::daemon::endpoint_identity(
        request["build"].get<std::string>(), request["protocol"].get<std::uint32_t>());
    const auto socket_path = runtime.path / ("daemon-" + identity + ".sock");
    const auto lifetime_path = runtime.path / ("daemon-" + identity + ".live.lock");
    const auto listener = ::socket(AF_UNIX, SOCK_STREAM, 0);
    REQUIRE(listener >= 0);
    sockaddr_un address{};
    address.sun_family = AF_UNIX;
    const auto socket_text = socket_path.string();
    REQUIRE(socket_text.size() < sizeof(address.sun_path));
    std::memcpy(address.sun_path, socket_text.c_str(), socket_text.size() + 1);
    REQUIRE(::bind(listener, reinterpret_cast<const sockaddr*>(&address), sizeof(address)) == 0);
    REQUIRE(::listen(listener, 1) == 0);

    const auto lifetime = ::open(lifetime_path.c_str(), O_CREAT | O_RDWR | O_CLOEXEC, 0600);
    REQUIRE(lifetime >= 0);
    REQUIRE(::flock(lifetime, LOCK_EX | LOCK_NB) == 0);

    std::thread hung([listener] {
        const auto connection = ::accept(listener, nullptr, nullptr);
        if (connection >= 0) {
            std::this_thread::sleep_for(std::chrono::milliseconds(350));
            ::close(connection);
        }
    });
    const auto started = std::chrono::steady_clock::now();
    const auto rejected = invoke_daemon(request);
    const auto elapsed = std::chrono::steady_clock::now() - started;
    CHECK(rejected["ok"] == false);
    CHECK(elapsed < std::chrono::milliseconds(250));

    ::shutdown(listener, SHUT_RDWR);
    ::close(listener);
    hung.join();
    ::flock(lifetime, LOCK_UN);
    ::close(lifetime);
}

TEST_CASE("daemon startup refuses to unlink an endpoint with live ownership")
{
    auto runtime = temp_runtime_root("live-endpoint");
    std::filesystem::create_directories(runtime.path);
    auto request = context(unique_build("live-endpoint"));
    request["runtimeRoot"] = runtime.path.generic_string();
    const auto identity = noveltea::tooling::daemon::endpoint_identity(
        request["build"].get<std::string>(), request["protocol"].get<std::uint32_t>());
    const auto socket_path = runtime.path / ("daemon-" + identity + ".sock");
    const auto lifetime_path = runtime.path / ("daemon-" + identity + ".live.lock");

    const auto socket_handle = ::socket(AF_UNIX, SOCK_STREAM, 0);
    REQUIRE(socket_handle >= 0);
    sockaddr_un address{};
    address.sun_family = AF_UNIX;
    const auto socket_text = socket_path.string();
    REQUIRE(socket_text.size() < sizeof(address.sun_path));
    std::memcpy(address.sun_path, socket_text.c_str(), socket_text.size() + 1);
    REQUIRE(::bind(socket_handle, reinterpret_cast<const sockaddr*>(&address), sizeof(address)) ==
            0);
    ::close(socket_handle);

    const auto lifetime_handle = ::open(lifetime_path.c_str(), O_CREAT | O_RDWR | O_CLOEXEC, 0600);
    REQUIRE(lifetime_handle >= 0);
    REQUIRE(::flock(lifetime_handle, LOCK_EX | LOCK_NB) == 0);

    request["action"] = "ensure";
    request["executablePath"] = "/bin/false";
    request["startupTimeoutMs"] = 50;
    const auto rejected = invoke_daemon(request);
    CHECK(rejected["ok"] == false);
    CHECK(rejected["error"] == "refusing unsafe daemon endpoint takeover");
    CHECK(std::filesystem::is_socket(socket_path));

    ::flock(lifetime_handle, LOCK_UN);
    ::close(lifetime_handle);
}

TEST_CASE("daemon Unix runtime root rejects symlink takeover")
{
    auto runtime = temp_runtime_root("symlink");
    std::filesystem::create_directories(runtime.path);
    const auto target = runtime.path / "target";
    const auto link = runtime.path / "runtime-link";
    std::filesystem::create_directory(target);
    std::filesystem::create_directory_symlink(target, link);

    auto request = context(unique_build("symlink"));
    request["runtimeRoot"] = link.generic_string();
    request["action"] = "serve-start";
    const auto rejected = invoke_daemon(request);
    CHECK(rejected["ok"] == false);
    CHECK(rejected["error"] == "daemon runtime directory is not owned by the current user");
}

TEST_CASE("daemon Unix endpoint is private to the current user")
{
    auto runtime = temp_runtime_root("permissions");
    auto request = context(unique_build("permissions"));
    request["runtimeRoot"] = runtime.path.generic_string();
    request["action"] = "serve-start";
    REQUIRE(invoke_daemon(request)["ok"] == true);

    struct stat directory_info {};
    REQUIRE(::lstat(runtime.path.c_str(), &directory_info) == 0);
    CHECK(directory_info.st_uid == geteuid());
    CHECK((directory_info.st_mode & 0077) == 0);

    const auto identity = noveltea::tooling::daemon::endpoint_identity(
        request["build"].get<std::string>(), request["protocol"].get<std::uint32_t>());
    const auto socket_path = runtime.path / ("daemon-" + identity + ".sock");
    struct stat socket_info {};
    REQUIRE(::lstat(socket_path.c_str(), &socket_info) == 0);
    CHECK(S_ISSOCK(socket_info.st_mode));
    CHECK(socket_info.st_uid == geteuid());
    CHECK((socket_info.st_mode & 0077) == 0);

    request["action"] = "stop";
    REQUIRE(invoke_daemon(request)["ok"] == true);
    request["action"] = "serve-wait";
    REQUIRE(invoke_daemon(request)["ok"] == true);
}
#endif
