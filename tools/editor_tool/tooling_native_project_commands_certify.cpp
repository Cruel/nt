#include "tooling_native_c.h"
#include "../project_authoring/source_authority.hpp"

#include <nlohmann/json.hpp>

#include <chrono>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <iterator>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace {
using Json = nlohmann::json;

void require(bool condition, std::string_view message)
{
    if (!condition)
        throw std::runtime_error(std::string(message));
}

std::string read(const std::filesystem::path& file)
{
    std::ifstream input(file, std::ios::binary);
    require(static_cast<bool>(input), "Certification file cannot be read.");
    return {std::istreambuf_iterator<char>(input), std::istreambuf_iterator<char>()};
}

Json command(const Json& request)
{
    const auto serialized = request.dump();
    // One call only: a sized-probe retry could execute a transaction twice.
    std::vector<std::uint8_t> response(8 * 1024 * 1024);
    const auto size = noveltea_tooling_native_project_commands_json(
        reinterpret_cast<const std::uint8_t*>(serialized.data()), serialized.size(),
        response.data(), response.size());
    require(size < response.size(), "Certification response buffer too small.");
    return Json::parse(response.begin(), response.begin() + static_cast<std::ptrdiff_t>(size));
}

struct Fixture {
    std::filesystem::path root;
    explicit Fixture(const std::filesystem::path& source)
        : root(std::filesystem::temp_directory_path() /
               ("noveltea-cli-native-" +
                std::to_string(std::chrono::steady_clock::now().time_since_epoch().count())))
    {
        std::filesystem::copy(source, root, std::filesystem::copy_options::recursive);
    }
    ~Fixture()
    {
        std::error_code ignored;
        std::filesystem::remove_all(root, ignored);
    }
};

void certify(const std::filesystem::path& source)
{
    Fixture fixture(source);
    const auto root = fixture.root.string();
    const auto path = fixture.root / "project.yaml";
    const auto baseline = read(path);
    const auto baseline_revision = noveltea::authoring::exact_source_revision(baseline);
    const auto inspect = command({{"action", "entity-inspect"},
                                  {"projectRoot", root},
                                  {"collection", "rooms"},
                                  {"id", "room-lifecycle-roundtrip"},
                                  {"provenance", true}});
    require(inspect.value("ok", false), "Native CLI record inspection failed.");
    const auto& fields = inspect.at("fields");
    require(fields.at("record").at("id") == "room-lifecycle-roundtrip" &&
                fields.at("provenance").at("id") == "explicit",
            "CLI inspect returns effective fields and sparse-source provenance.");
    const auto unknown = command({{"action", "entity-inspect"},
                                  {"projectRoot", root},
                                  {"collection", "rooms"},
                                  {"id", "missing"}});
    require(unknown.at("ok") == false, "Unknown native records must be rejected.");

    const Json replacement =
        Json::array({{{"op", "replace"}, {"path", "/project/name"}, {"value", "CLI Native"}}});
    const auto dry = command({{"action", "scoped-edit"},
                              {"projectRoot", root},
                              {"patches", replacement},
                              {"dryRun", true}});
    require(dry.value("ok", false) && dry.at("affectedOwners") == Json::array({"project"}) &&
                read(path) == baseline,
            "CLI dry-run reports affected owners without writing.");
    const auto stale = command({{"action", "scoped-edit"},
                                {"projectRoot", root},
                                {"patches", replacement},
                                {"dryRun", false},
                                {"expectedWorkingRevision", 0},
                                {"diskPreconditions", {{"project", "sha256:stale"}}}});
    require(stale.at("ok") == false && read(path) == baseline,
            "Stale disk preconditions fail closed before any writes.");
    const auto invalid =
        command({{"action", "scoped-edit"},
                 {"projectRoot", root},
                 {"patches",
                  Json::array({{{"op", "replace"}, {"path", "/project/name"}, {"value", "Invalid"}},
                               {{"op", "replace"},
                                {"path", "/rooms/room-lifecycle-roundtrip/id"},
                                {"value", "wrong-id"}}})},
                 {"dryRun", false}});
    require(invalid.at("ok") == false && read(path) == baseline,
            "Cross-owner invalid edits cannot persist a partial Project transaction.");
    const auto no_preconditions = command({{"action", "scoped-edit"},
                                           {"projectRoot", root},
                                           {"patches", replacement},
                                           {"expectedWorkingRevision", 0},
                                           {"dryRun", false}});
    require(no_preconditions.at("ok") == false && read(path) == baseline,
            "A CLI commit without exact per-owner disk preconditions must fail closed.");
    const auto committed = command({{"action", "scoped-edit"},
                                    {"projectRoot", root},
                                    {"patches", replacement},
                                    {"dryRun", false},
                                    {"expectedWorkingRevision", 0},
                                    {"diskPreconditions", {{"project", baseline_revision}}}});
    require(committed.value("ok", false) &&
                committed.at("savedOwners") == Json::array({"project"}) && read(path) != baseline &&
                read(path).find("CLI Native") != std::string::npos,
            "A native CLI scoped edit commits the selected source transaction.");
    const auto prepared = command({{"action", "export-preparation"}, {"projectRoot", root}});
    require(prepared.value("ok", false) &&
                prepared.at("project").at("project").at("name") == "CLI Native" &&
                std::find(prepared.at("sourcePaths").begin(), prepared.at("sourcePaths").end(),
                          "project.yaml") != prepared.at("sourcePaths").end(),
            "Export preparation returns verified effective Project and owned source inventory.");
    require(command({{"action", "bogus"}, {"projectRoot", root}}).at("ok") == false,
            "Unknown CLI operations are rejected.");
}
} // namespace

int main(int argc, char** argv)
{
    try {
        require(argc == 2, "Expected one Project fixture root.");
        certify(argv[1]);
        std::cout << "Native CLI Project certification passed.\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
