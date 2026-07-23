#include <catch2/catch_test_macros.hpp>

#include <noveltea/core/player_bootstrap.hpp>
#include <noveltea/core/package_export.hpp>

#include <algorithm>
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
    std::ifstream fixture(std::filesystem::path(NOVELTEA_SOURCE_DIR) /
                          "editor/src/renderer/test/fixtures/compiled-project-golden/minimal.json");
    REQUIRE(fixture.good());
    const auto project = nlohmann::json::parse(fixture, nullptr, false);
    REQUIRE_FALSE(project.is_discarded());
    PackageExportOptions options;
    options.project_name = "Bootstrap Fixture";
    options.project_version = std::move(version);
    options.display = nlohmann::json{{"reference_resolution", {{"width", 1920}, {"height", 1080}}},
                                     {"world_raster_policy", "capped"},
                                     {"bar_color", "#000000"}};
    options.accessibility =
        nlohmann::json{{"ui_scale", {{"enabled", true}, {"minimum", 1.0}, {"maximum", 2.0}}},
                       {"text_scale", {{"enabled", true}, {"minimum", 1.0}, {"maximum", 2.0}}}};
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
               R"({"format":"noveltea.player-config","formatVersion":2,"displayName":"Game","applicationId":"org.example.game","saveNamespace":"org.example.game","versionName":"1","package":{"path":"game.ntpkg","sha256":")") +
           sha256_hex(package) +
           R"(","runtimePackageApi":2},"capabilities":[],"display":{"referenceResolution":{"width":1920,"height":1080},"worldRasterPolicy":"capped","barColor":"#000000"},"accessibility":{"uiScale":{"enabled":true,"minimum":1,"maximum":2},"textScale":{"enabled":true,"minimum":1,"maximum":2}}})";
}

void write_file(const std::filesystem::path& path, std::span<const std::byte> contents)
{
    std::filesystem::create_directories(path.parent_path());
    std::ofstream file(path, std::ios::binary);
    file.write(reinterpret_cast<const char*>(contents.data()),
               static_cast<std::streamsize>(contents.size()));
    REQUIRE(file.good());
}

void write_file(const std::filesystem::path& path, std::string_view contents)
{
    write_file(path, std::as_bytes(std::span(contents.data(), contents.size())));
}

bool has_diagnostic(const PlayerBootstrapResult& result, PlayerBootstrapError category,
                    std::string_view message)
{
    return std::ranges::any_of(result.diagnostics, [&](const auto& diagnostic) {
        return diagnostic.category == category &&
               diagnostic.message.find(message) != std::string::npos;
    });
}
} // namespace

TEST_CASE("player bootstrap parses the shared version two contract")
{
    const auto result = parse_player_config(R"({
      "format":"noveltea.player-config","formatVersion":2,"displayName":"Game",
      "applicationId":"org.example.game","saveNamespace":"org.example.game","versionName":"1.0.0",
      "package":{"path":"game.ntpkg","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","runtimePackageApi":2},
      "capabilities":[],"display":{"referenceResolution":{"width":1920,"height":1080},"worldRasterPolicy":"capped","barColor":"#000000"},
      "accessibility":{"uiScale":{"enabled":true,"minimum":1,"maximum":2},"textScale":{"enabled":true,"minimum":1,"maximum":2}}
    })");
    REQUIRE(result.success());
    CHECK(result.config.display_name == "Game");
    CHECK(result.config.package_path == "game.ntpkg");
}

TEST_CASE("player bootstrap rejects unknown fields and unsafe package paths")
{
    auto unknown = parse_player_config(
        R"({"format":"noveltea.player-config","formatVersion":2,"displayName":"Game","applicationId":"org.example.game","saveNamespace":"org.example.game","versionName":"1","package":{"path":"../game.ntpkg","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","runtimePackageApi":2},"capabilities":[],"display":{"referenceResolution":{"width":1920,"height":1080},"worldRasterPolicy":"capped","barColor":"#000000"},"accessibility":{"uiScale":{"enabled":true,"minimum":1,"maximum":2},"textScale":{"enabled":true,"minimum":1,"maximum":2}},"extra":true})");
    CHECK_FALSE(unknown.success());
    CHECK_FALSE(is_safe_player_relative_path("../game.ntpkg"));
    CHECK(is_safe_player_relative_path("packages/game.ntpkg"));
}

TEST_CASE("player bootstrap rejects reference dimensions above the runtime display limit")
{
    const auto result = parse_player_config(
        R"({"format":"noveltea.player-config","formatVersion":2,"displayName":"Game","applicationId":"org.example.game","saveNamespace":"org.example.game","versionName":"1","package":{"path":"game.ntpkg","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","runtimePackageApi":2},"capabilities":[],"display":{"referenceResolution":{"width":10001,"height":1080},"worldRasterPolicy":"capped","barColor":"#000000"},"accessibility":{"uiScale":{"enabled":true,"minimum":1,"maximum":2},"textScale":{"enabled":true,"minimum":1,"maximum":2}}})");
    REQUIRE_FALSE(result.success());
    CHECK(std::ranges::any_of(
        result.diagnostics, [](const auto& diagnostic) { return diagnostic.path == "/display"; }));
}

TEST_CASE("packaged player bootstrap failures have specific actionable diagnostics")
{
    const auto root = temporary_directory();
    const auto config_path = root / "player.json";
    const auto package_path = root / "game.ntpkg";
    const auto package = package_fixture("1");
    const auto valid_config = player_config_for(package);

    SECTION("missing player config")
    {
        const auto result = load_and_verify_player(config_path);
        CHECK(has_diagnostic(result, PlayerBootstrapError::ConfigDiscovery,
                             "player config was not found"));
    }

    SECTION("malformed player config")
    {
        write_file(config_path, "{");
        const auto result = load_and_verify_player(config_path);
        CHECK(has_diagnostic(result, PlayerBootstrapError::ConfigParse, "expected object"));
    }

    SECTION("unsupported player config API")
    {
        auto config = nlohmann::json::parse(valid_config);
        config["formatVersion"] = 1;
        write_file(config_path, config.dump());
        const auto result = load_and_verify_player(config_path);
        CHECK(has_diagnostic(result, PlayerBootstrapError::ConfigParse,
                             "unsupported player config format"));
    }

    SECTION("missing game package")
    {
        write_file(config_path, valid_config);
        const auto result = load_and_verify_player(config_path);
        CHECK(has_diagnostic(result, PlayerBootstrapError::PackageDiscovery,
                             "game package was not found or is empty"));
    }

    SECTION("game package checksum mismatch")
    {
        write_file(config_path, valid_config);
        write_file(package_path, "not the exported package");
        const auto result = load_and_verify_player(config_path);
        CHECK(has_diagnostic(result, PlayerBootstrapError::PackageChecksum,
                             "checksum does not match"));
    }

    SECTION("unsupported runtime package API")
    {
        auto config = nlohmann::json::parse(valid_config);
        config["package"]["runtimePackageApi"] = 3;
        write_file(config_path, config.dump());
        write_file(package_path, package);
        const auto result = load_and_verify_player(config_path);
        CHECK(has_diagnostic(result, PlayerBootstrapError::PackageApi,
                             "unsupported runtime package API"));
    }

    SECTION("missing required capability support")
    {
        auto config = nlohmann::json::parse(valid_config);
        config["capabilities"] = nlohmann::json::array({"gamepad"});
        write_file(config_path, config.dump());
        write_file(package_path, package);
        const auto result = load_and_verify_player(config_path);
        CHECK(has_diagnostic(result, PlayerBootstrapError::Capability,
                             "player template does not support: gamepad"));
    }

    std::filesystem::remove_all(root);
}

TEST_CASE("SHA-256 implementation matches a standard vector")
{
    const std::string value = "abc";
    const auto bytes = std::as_bytes(std::span(value.data(), value.size()));
    CHECK(sha256_hex(bytes) == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
}

TEST_CASE("borrowed player package verification retains no completed package copy")
{
    const auto package = package_fixture("borrowed");
    const auto config = player_config_for(package);
    const auto result = verify_player_config_and_package_view(config, package);
    REQUIRE(result.success());
    CHECK(result.package_bytes.empty());
    CHECK(result.config.package_sha256 == sha256_hex(package));

    auto corrupted = package;
    REQUIRE_FALSE(corrupted.empty());
    corrupted.front() ^= std::byte{0x01};
    const auto failed = verify_player_config_and_package_view(config, corrupted);
    CHECK_FALSE(failed.success());
    CHECK(failed.package_bytes.empty());
    CHECK(has_diagnostic(failed, PlayerBootstrapError::PackageChecksum, "checksum does not match"));
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
