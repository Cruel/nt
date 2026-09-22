#include "tooling_native.hpp"

#include <catch2/catch_test_macros.hpp>
#include <nlohmann/json.hpp>

#include <chrono>
#include <filesystem>
#include <string>
#include <system_error>

namespace {

class TempDirectory {
public:
    explicit TempDirectory(std::string_view name)
        : m_path(std::filesystem::temp_directory_path() /
                 ("noveltea-native-shader-compile-" + std::string(name) + "-" +
                  std::to_string(std::chrono::steady_clock::now().time_since_epoch().count())))
    {
        std::filesystem::create_directories(m_path);
    }

    ~TempDirectory()
    {
        std::error_code error;
        std::filesystem::remove_all(m_path, error);
    }

    [[nodiscard]] const std::filesystem::path& path() const noexcept { return m_path; }

private:
    std::filesystem::path m_path;
};

} // namespace

TEST_CASE("native shader compile rejects an unsupported requested variant")
{
    const TempDirectory temp("invalid-variant");
    const nlohmann::json request = {
        {"shaderProject",
         {{"schema", "noveltea.shader-source-programs"},
          {"programs",
           {{"sample_effect",
             {{"vertexSource", "engine:/vs_quad.sc"},
              {"fragmentSource", "engine:/fs_quad.sc"},
              {"varyingDefinition", "engine:/varying.def.sc"},
              {"interfaceContract", "test:sample-effect:1"},
              {"interfaceFingerprint",
               "sha256:0000000000000000000000000000000000000000000000000000000000000001"}}}}}}},
        {"options",
         {{"projectRoot", (temp.path() / "project").generic_string()},
          {"outputRoot", (temp.path() / "generated").generic_string()},
          {"cacheRoot", (temp.path() / "cache").generic_string()},
          {"shaderVariants", nlohmann::json::array({"glsl-330", "unsupported"})}}},
    };

    const auto result = noveltea::tooling::compile_shaders(request.dump());
    REQUIRE(result.exit_code == 0);
    const auto response = nlohmann::json::parse(result.response_json, nullptr, false);
    REQUIRE_FALSE(response.is_discarded());
    REQUIRE(response.value("ok", false));
    CHECK(response.value("success", true) == false);
    REQUIRE(response["outputs"].size() == 2);
    CHECK(response["outputs"][0]["variant"] == "glsl-330");
    CHECK(response["outputs"][1]["variant"] == "glsl-330");
    CHECK(response["outputs"][0]["stage"] != response["outputs"][1]["stage"]);
    REQUIRE(response["diagnostics"].size() == 1);
    CHECK(response["diagnostics"][0]["severity"] == "error");
    CHECK(response["diagnostics"][0]["code"] == "invalid_variant");
    CHECK(response["diagnostics"][0]["variant"] == "unsupported");
}
