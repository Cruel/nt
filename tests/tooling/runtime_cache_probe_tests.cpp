#include "tooling_native_c.h"

#include <noveltea/core/player_bootstrap.hpp>

#include <catch2/catch_test_macros.hpp>
#include <nlohmann/json.hpp>

#include <chrono>
#include <cctype>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <vector>

#if !defined(_WIN32)
#include <sys/stat.h>
#endif

namespace {

using Json = nlohmann::json;

struct TempRoot {
    std::filesystem::path path;
    ~TempRoot()
    {
        std::error_code error;
        std::filesystem::remove_all(path, error);
    }
};

TempRoot temp_root()
{
    const auto nonce = std::chrono::steady_clock::now().time_since_epoch().count();
    TempRoot root{std::filesystem::temp_directory_path() /
                  ("noveltea-cache-probe-" + std::to_string(nonce))};
    std::filesystem::create_directories(root.path);
    return root;
}

void write_text(const std::filesystem::path& path, std::string_view text)
{
    std::filesystem::create_directories(path.parent_path());
    std::ofstream output(path, std::ios::binary | std::ios::trunc);
    REQUIRE(output.good());
    output.write(text.data(), static_cast<std::streamsize>(text.size()));
    REQUIRE(output.good());
}

std::optional<std::string> read_text(const std::filesystem::path& path)
{
    std::ifstream input(path, std::ios::binary);
    if (!input)
        return std::nullopt;
    return std::string(std::istreambuf_iterator<char>(input), std::istreambuf_iterator<char>());
}

std::string sha256_prefixed(std::string_view text)
{
    return "sha256:" +
           noveltea::core::sha256_hex(std::as_bytes(std::span(text.data(), text.size())));
}

Json invoke(const auto& function, const Json& request)
{
    const auto text = request.dump();
    std::vector<std::uint8_t> response(64 * 1024);
    const auto required = function(reinterpret_cast<const std::uint8_t*>(text.data()), text.size(),
                                   response.data(), response.size());
    REQUIRE(required <= response.size());
    return Json::parse(std::string(reinterpret_cast<const char*>(response.data()),
                                   static_cast<std::size_t>(required)));
}

Json metadata(const std::filesystem::path& path)
{
    auto result =
        invoke(noveltea_tooling_path_metadata_json, Json{{"path", path.generic_string()}});
    REQUIRE(result["ok"] == true);
    REQUIRE(result["kind"] == "file");
    return result;
}

Json input_entry(const std::filesystem::path& root, std::string_view relative)
{
    const auto info = metadata(root / std::filesystem::path(relative));
    return {{"path", relative},
            {"byteSize", info["byteSize"]},
            {"mtimeNanoseconds", info["mtimeNanoseconds"]}};
}

Json canonical_scopes()
{
    return Json::array({{{"root", "records"},
                         {"extensions", Json::array({".json", ".lua", ".rcss", ".rml"})},
                         {"excludedPrefixes", Json::array({"records/tests/"})}},
                        {{"root", "scripts"},
                         {"extensions", Json::array({".lua"})},
                         {"excludedPrefixes", Json::array()}},
                        {{"root", "i18n"},
                         {"extensions", Json::array({".json"})},
                         {"excludedPrefixes", Json::array()}}});
}

void create_cache(const std::filesystem::path& root)
{
    const std::string project = R"({"schema":"noveltea.project.workspace","schemaVersion":1})";
    const std::string test = R"({"id":"smoke"})";
    write_text(root / "project.json", project);
    write_text(root / "records/tests/smoke.json", test);

    const std::string artifact =
        R"({"schema":"noveltea.prepared-runtime-artifact","compiledProject":{"schema":"noveltea.compiled.project"}})";
    const std::string catalog =
        R"({"schema":"noveltea.runtime-test-catalog","entries":[{"id":"smoke","status":"runnable","runner":"runtime","spec":{}}]})";
    const std::string generation = "11111111-1111-4111-8111-111111111111";
    const auto directory = root / ".noveltea/cache/runtime/generations" / generation;
    write_text(directory / "artifact.json", artifact);
    write_text(directory / "tests.json", catalog);

    const Json manifest = {
        {"schema", "noveltea.runtime-build-cache"},
        {"variant", "canonical-runtime"},
        {"compilerIdentity", "test-compiler"},
        {"projectWorkspace", {{"schema", "noveltea.project.workspace"}, {"formatVersion", 1}}},
        {"compiledProject", {{"schema", "noveltea.compiled.project"}, {"formatVersion", 1}}},
        {"preparedArtifactSchema", "noveltea.prepared-runtime-artifact"},
        {"discoveryScopes", canonical_scopes()},
        {"inputs", Json::array({input_entry(root, "project.json")})},
        {"artifactFile", "artifact.json"},
        {"artifactSha256", sha256_prefixed(artifact)},
        {"testCatalog",
         {{"inputs", Json::array({input_entry(root, "records/tests/smoke.json")})},
          {"catalogFile", "tests.json"},
          {"catalogSha256", sha256_prefixed(catalog)}}},
    };
    write_text(directory / "manifest.json", manifest.dump());
    write_text(root / ".noveltea/cache/runtime/current", generation + "\n");
}

} // namespace

TEST_CASE("native runtime cache probe admits a fresh canonical generation")
{
    auto root = temp_root();
    create_cache(root.path);
    const auto result = invoke(
        noveltea_tooling_probe_runtime_cache_json,
        {{"projectRoot", root.path.generic_string()}, {"compilerIdentity", "test-compiler"}});
    REQUIRE(result["ok"] == true);
    CHECK(result["status"] == "hit");
    CHECK(result["reason"] == "current-generation-valid");
    CHECK(result["catalog"]["entries"][0]["id"] == "smoke");
    CHECK(result["artifact"]["compiledProject"]["schema"] == "noveltea.compiled.project");
}

TEST_CASE(
    "native runtime cache admission uses exact metadata without hashing authored source bytes")
{
    auto root = temp_root();
    create_cache(root.path);
    const auto project_path = root.path / "project.json";
    const auto timestamp = std::filesystem::last_write_time(project_path);
    write_text(project_path, R"({"schema":"noveltea.project.workspace","schemaVersion":2})");
    std::filesystem::last_write_time(project_path, timestamp);

    const auto result = invoke(
        noveltea_tooling_probe_runtime_cache_json,
        {{"projectRoot", root.path.generic_string()}, {"compilerIdentity", "test-compiler"}});
    REQUIRE(result["ok"] == true);
    CHECK(result["status"] == "hit");
}

TEST_CASE(
    "native runtime cache probe rejects stale test content without parsing authored Test data")
{
    auto root = temp_root();
    create_cache(root.path);
    write_text(root.path / "records/tests/smoke.json", R"({"id":"smoke","changed":true})");
    const auto result = invoke(
        noveltea_tooling_probe_runtime_cache_json,
        {{"projectRoot", root.path.generic_string()}, {"compilerIdentity", "test-compiler"}});
    REQUIRE(result["ok"] == true);
    CHECK(result["status"] == "stale");
    CHECK(result["reason"] == "test-input-metadata-changed");
}

TEST_CASE("native runtime cache probe treats malformed typed manifest fields as unusable")
{
    auto root = temp_root();
    create_cache(root.path);
    const auto generation =
        read_text(root.path / ".noveltea/cache/runtime/current").value_or(std::string{});
    auto trimmed = generation;
    while (!trimmed.empty() && std::isspace(static_cast<unsigned char>(trimmed.back())))
        trimmed.pop_back();
    const auto manifest_path =
        root.path / ".noveltea/cache/runtime/generations" / trimmed / "manifest.json";
    auto manifest = Json::parse(read_text(manifest_path).value_or("{}"));
    manifest["schema"] = 17;
    write_text(manifest_path, manifest.dump());

    const auto result = invoke(
        noveltea_tooling_probe_runtime_cache_json,
        {{"projectRoot", root.path.generic_string()}, {"compilerIdentity", "test-compiler"}});
    REQUIRE(result["ok"] == true);
    CHECK(result["status"] == "unusable");
    CHECK(result["reason"] == "manifest-invalid");
}

#if !defined(_WIN32)
TEST_CASE("native runtime cache probe rejects a non-regular plausible source candidate")
{
    auto root = temp_root();
    create_cache(root.path);
    const auto fifo = root.path / "scripts/new.lua";
    std::filesystem::create_directories(fifo.parent_path());
    REQUIRE(::mkfifo(fifo.c_str(), 0600) == 0);

    const auto result = invoke(
        noveltea_tooling_probe_runtime_cache_json,
        {{"projectRoot", root.path.generic_string()}, {"compilerIdentity", "test-compiler"}});
    REQUIRE(result["ok"] == true);
    CHECK(result["status"] == "stale");
    CHECK(result["reason"] == "discovery-inputs-changed");
}
#endif
