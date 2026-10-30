#include "tooling_native.hpp"

#include <catch2/catch_test_macros.hpp>
#include <nlohmann/json.hpp>

#include <chrono>
#include <filesystem>
#include <fstream>
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

TEST_CASE("cached source shader preserves validated sampler reflection")
{
    const TempDirectory temp("sampler-evidence-cache");
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
          {"shaderVariants", nlohmann::json::array({"glsl-330"})}}},
    };
    const auto compile = [&] {
        const auto result = noveltea::tooling::compile_shaders(request.dump());
        REQUIRE(result.exit_code == 0);
        const auto response = nlohmann::json::parse(result.response_json);
        REQUIRE(response.value("ok", false));
        REQUIRE(response.value("success", false));
        REQUIRE(response.at("outputs").size() == 2);
        return response;
    };

    const auto initial = compile();
    for (const auto& output : initial.at("outputs"))
        REQUIRE_FALSE(output.at("cacheHit").get<bool>());

    const auto manifest_path = temp.path() / "cache/shader-cache/manifest.json";
    nlohmann::json manifest;
    {
        std::ifstream in(manifest_path);
        REQUIRE(in.good());
        in >> manifest;
    }
    REQUIRE(manifest.size() == 2);
    for (const auto& [_, entry] : manifest.items()) {
        REQUIRE(entry.at("samplerStageSchema") == "preprocessed-v1");
        REQUIRE(entry.at("samplerStages").is_array());
        REQUIRE(entry.at("samplerStageProof").is_string());
    }

    const auto cached = compile();
    for (std::size_t i = 0; i < cached.at("outputs").size(); ++i) {
        REQUIRE(cached.at("outputs").at(i).at("cacheHit") == true);
        REQUIRE(cached.at("outputs").at(i).at("reflectedInputs") ==
                initial.at("outputs").at(i).at("reflectedInputs"));
        REQUIRE(cached.at("outputs").at(i).at("byteHash") ==
                initial.at("outputs").at(i).at("byteHash"));
    }

    // A malformed or old manifest must regenerate sampler evidence rather
    // than silently dropping sampler bindings from the reflected interface.
    for (auto& [_, entry] : manifest.items())
        entry["samplerStageProof"] = "corrupted";
    {
        std::ofstream out(manifest_path, std::ios::trunc);
        REQUIRE(out.good());
        out << manifest.dump(2);
    }
    const auto repaired = compile();
    for (std::size_t i = 0; i < repaired.at("outputs").size(); ++i) {
        REQUIRE(repaired.at("outputs").at(i).at("reflectedInputs") ==
                initial.at("outputs").at(i).at("reflectedInputs"));
    }
}
