#include <catch2/catch_test_macros.hpp>

#include <noveltea/core/player_bootstrap.hpp>
#include <noveltea/core/save_document.hpp>

#include <chrono>
#include <filesystem>
#include <fstream>

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
