#include <catch2/catch_test_macros.hpp>

#include <filesystem>
#include <fstream>
#include <iterator>
#include <string>

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
    CHECK(rml.find("id=\"nt-title-load\" onclick=\"Game.open_load_menu()\"") != std::string::npos);
    CHECK(rml.find("id=\"nt-title-settings\" onclick=\"Game.open_settings_menu()\"") !=
          std::string::npos);
    CHECK(rml.find("nt-command") == std::string::npos);
}
