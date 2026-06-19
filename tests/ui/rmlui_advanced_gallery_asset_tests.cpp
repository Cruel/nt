#include <catch2/catch_test_macros.hpp>

#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>

namespace {

std::string read_text(const std::filesystem::path& path)
{
    std::ifstream file(path);
    REQUIRE(file.good());
    std::ostringstream stream;
    stream << file.rdbuf();
    return stream.str();
}

} // namespace

TEST_CASE("RmlUi advanced gallery covers renderer acceptance features")
{
    const std::filesystem::path root = NOVELTEA_SOURCE_DIR;
    const std::filesystem::path gallery = root / "apps/sandbox/assets/rmlui/advanced_gallery.rml";
    const std::filesystem::path stylesheet =
        root / "apps/sandbox/assets/rmlui/advanced_gallery.rcss";

    const std::string rml = read_text(gallery);
    const std::string rcss = read_text(stylesheet);

    CHECK(rml.find("id=\"orientation\"") != std::string::npos);
    CHECK(rml.find("id=\"clip_mask\"") != std::string::npos);
    CHECK(rml.find("id=\"saved_mask\"") != std::string::npos);
    CHECK(rml.find("id=\"filters\"") != std::string::npos);
    CHECK(rml.find("id=\"gradients\"") != std::string::npos);

    CHECK(rcss.find("overflow: hidden") != std::string::npos);
    CHECK(rcss.find("mask-image: radial-gradient") != std::string::npos);
    CHECK(rcss.find("filter: sepia") != std::string::npos);
    CHECK(rcss.find("filter: blur") != std::string::npos);
    CHECK(rcss.find("filter: drop-shadow") != std::string::npos);
    CHECK(rcss.find("linear-gradient") != std::string::npos);
    CHECK(rcss.find("radial-gradient") != std::string::npos);
    CHECK(rcss.find("conic-gradient") != std::string::npos);
    CHECK(rcss.find("repeating-linear-gradient") != std::string::npos);
    CHECK(rcss.find("repeating-radial-gradient") != std::string::npos);
    CHECK(rcss.find("repeating-conic-gradient") != std::string::npos);
}
