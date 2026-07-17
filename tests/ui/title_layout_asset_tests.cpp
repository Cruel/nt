#include <catch2/catch_test_macros.hpp>

#include <filesystem>
#include <fstream>
#include <iterator>
#include <string>
#include <vector>

namespace {

std::string read_source_file(const std::filesystem::path& path)
{
    std::ifstream stream(path, std::ios::binary);
    return {std::istreambuf_iterator<char>(stream), std::istreambuf_iterator<char>()};
}

} // namespace

TEST_CASE("built-in title layout exposes stable Lua activation calls")
{
    const auto root = std::filesystem::path(NOVELTEA_SOURCE_DIR);
    const auto rml = read_source_file(root / "engine/assets/system/ui/title/default-title.rml");

    REQUIRE_FALSE(rml.empty());
    CHECK(rml.find("system|/ui/title/default-title.rcss") != std::string::npos);
    CHECK(rml.find("id=\"nt-title-project\"") != std::string::npos);
    CHECK(rml.find("id=\"nt-title-diagnostic\"") != std::string::npos);
    CHECK(rml.find("id=\"nt-title-start\" onclick=\"Game.start()\"") != std::string::npos);
    CHECK(rml.find("id=\"nt-title-load\" onclick=\"Game.shell.open_load()\"") != std::string::npos);
    CHECK(rml.find("id=\"nt-title-settings\" onclick=\"Game.shell.open_settings()\"") !=
          std::string::npos);
    CHECK(rml.find("nt-command") == std::string::npos);
}

TEST_CASE("built-in system menu assets use typed shell capabilities")
{
    const auto root = std::filesystem::path(NOVELTEA_SOURCE_DIR);
    const auto menu_root = root / "engine/assets/system/ui/menu";
    const std::vector<std::string> documents{"pause-menu.rml",    "save-menu.rml", "load-menu.rml",
                                             "settings-menu.rml", "text-log.rml",  "modal.rml"};

    for (const auto& document : documents) {
        const auto rml = read_source_file(menu_root / document);
        INFO(document);
        REQUIRE_FALSE(rml.empty());
        CHECK(rml.find("Game.command") == std::string::npos);
        CHECK(rml.find("nt-command") == std::string::npos);
        CHECK(rml.find("Game.shell.") != std::string::npos);
    }

    const auto save = read_source_file(menu_root / "save-menu.rml");
    CHECK(save.find("id=\"nt-checkpoint-summary\"") != std::string::npos);
    CHECK(save.find("id=\"nt-save-slots\"") != std::string::npos);
    const auto text_log = read_source_file(menu_root / "text-log.rml");
    CHECK(text_log.find("<nt-text-log") != std::string::npos);
}
