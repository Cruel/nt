#include <catch2/catch_test_macros.hpp>

#include <noveltea/core/player_bootstrap.hpp>
#include <noveltea/core/package_export.hpp>
#include <noveltea/core/project_document.hpp>
#include <noveltea/core/save_document.hpp>

#include <chrono>
#include <filesystem>
#include <fstream>
#include <map>

using namespace noveltea::core;

namespace {
std::filesystem::path temporary_directory()
{
    auto path = std::filesystem::temp_directory_path() /
                ("noveltea-player-tests-" +
                 std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
    std::filesystem::create_directories(path);
    return path;
}

std::vector<std::byte> package_fixture(std::string version)
{
    auto project = ProjectDocument::new_project();
    PackageExportOptions options;
    options.project_name = "Bootstrap Fixture";
    options.project_version = std::move(version);
    std::vector<std::byte> bytes;
    REQUIRE(ProjectPackageWriter::write_to_memory(project, options, bytes).success);
    return bytes;
}

std::vector<std::byte> bytes(std::string_view value)
{
    const auto span = std::as_bytes(std::span(value.data(), value.size()));
    return {span.begin(), span.end()};
}

std::string player_config_for(std::span<const std::byte> package)
{
    return std::string(
               R"({"format":"noveltea.player-config","formatVersion":1,"displayName":"Game","applicationId":"org.example.game","saveNamespace":"org.example.game","versionName":"1","package":{"path":"game.ntpkg","sha256":")") +
           sha256_hex(package) +
           R"(","runtimePackageApi":1},"capabilities":[],"display":{"aspectRatio":{"width":16,"height":9},"orientation":"landscape","barColor":"#000000"}})";
}
} // namespace

TEST_CASE("player bootstrap parses the shared version one contract")
{
    const auto result = parse_player_config(R"({
      "format":"noveltea.player-config","formatVersion":1,"displayName":"Game",
      "applicationId":"org.example.game","saveNamespace":"org.example.game","versionName":"1.0.0",
      "package":{"path":"game.ntpkg","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","runtimePackageApi":1},
      "capabilities":[],"display":{"aspectRatio":{"width":16,"height":9},"orientation":"landscape","barColor":"#000000"}
    })");
    REQUIRE(result.success());
    CHECK(result.config.display_name == "Game");
    CHECK(result.config.package_path == "game.ntpkg");
}

TEST_CASE("player bootstrap rejects unknown fields and unsafe package paths")
{
    auto unknown = parse_player_config(
        R"({"format":"noveltea.player-config","formatVersion":1,"displayName":"Game","applicationId":"org.example.game","saveNamespace":"org.example.game","versionName":"1","package":{"path":"../game.ntpkg","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","runtimePackageApi":1},"capabilities":[],"display":{"aspectRatio":{"width":16,"height":9},"orientation":"landscape","barColor":"#000000"},"extra":true})");
    CHECK_FALSE(unknown.success());
    CHECK_FALSE(is_safe_player_relative_path("../game.ntpkg"));
    CHECK(is_safe_player_relative_path("packages/game.ntpkg"));
}

TEST_CASE("SHA-256 implementation matches a standard vector")
{
    const std::string value = "abc";
    const auto bytes = std::as_bytes(std::span(value.data(), value.size()));
    CHECK(sha256_hex(bytes) == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
}

TEST_CASE("packaged player materialization is atomic idempotent and update safe")
{
    const auto root = temporary_directory();
    const auto bootstrap_root = root / "bootstrap";
    const auto package_one = package_fixture("1");
    auto config = player_config_for(package_one);
    std::map<std::string, std::vector<std::byte>> assets{
        {"noveltea/bootstrap/player.json", bytes(config)},
        {"noveltea/bootstrap/game.ntpkg", package_one},
    };
    const auto reader = [&assets](std::string_view path) {
        const auto found = assets.find(std::string(path));
        return found == assets.end() ? std::vector<std::byte>{} : found->second;
    };

    auto first = materialize_packaged_player(bootstrap_root, "noveltea/bootstrap", reader);
    REQUIRE(first.success());
    CHECK(first.copied);
    REQUIRE(std::filesystem::is_regular_file(first.config_path));
    const auto first_root = first.config_path.parent_path();
    std::ofstream(root / "saves-marker") << "preserved";

    auto second = materialize_packaged_player(bootstrap_root, "noveltea/bootstrap", reader);
    REQUIRE(second.success());
    CHECK_FALSE(second.copied);
    CHECK(second.config_path == first.config_path);

    std::ofstream(first_root / "game.ntpkg", std::ios::binary | std::ios::trunc) << "interrupted";
    auto rebuilt = materialize_packaged_player(bootstrap_root, "noveltea/bootstrap", reader);
    REQUIRE(rebuilt.success());
    CHECK(rebuilt.copied);
    CHECK(rebuilt.config_path == first.config_path);

    const auto package_two = package_fixture("2");
    config = player_config_for(package_two);
    assets["noveltea/bootstrap/player.json"] = bytes(config);
    assets["noveltea/bootstrap/game.ntpkg"] = package_two;
    auto updated = materialize_packaged_player(bootstrap_root, "noveltea/bootstrap", reader);
    REQUIRE(updated.success());
    CHECK(updated.copied);
    CHECK(updated.config_path.parent_path() != first_root);
    CHECK(std::filesystem::is_regular_file(root / "saves-marker"));
    CHECK_FALSE(std::filesystem::exists(first_root));

    const auto active_root = updated.config_path.parent_path();
    auto corrupt_config = player_config_for(package_one);
    assets["noveltea/bootstrap/player.json"] = bytes(corrupt_config);
    assets["noveltea/bootstrap/game.ntpkg"] = bytes("corrupt update");
    auto failed = materialize_packaged_player(bootstrap_root, "noveltea/bootstrap", reader);
    CHECK_FALSE(failed.success());
    CHECK(std::filesystem::is_regular_file(active_root / "player.json"));
    CHECK(std::filesystem::is_regular_file(active_root / "game.ntpkg"));
    std::filesystem::remove_all(root);
}

TEST_CASE("filesystem save slots round trip and stay below their root")
{
    const auto root = temporary_directory() / "saves";
    FilesystemSaveSlotStore store(root);
    const auto save = SaveDocument::new_save();
    REQUIRE(store.write_slot({3}, save).success);
    CHECK(store.has_slot({3}));
    const auto loaded = store.read_slot({3});
    REQUIRE(loaded.success);
    REQUIRE(loaded.save);
    CHECK(loaded.save->dump() == save.dump());
    CHECK(std::filesystem::exists(root / "slot-3.ntsav"));
    store.delete_slot({3});
    CHECK_FALSE(store.has_slot({3}));
    std::filesystem::remove_all(root.parent_path());
}
