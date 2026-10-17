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
    const auto probing_bundle = fixture.root / "probed.ntproject";
    const auto probe_request = Json{
        {"action", "project-export"},
        {"projectRoot", root},
        {"outputPath",
         probing_bundle.string()}}.dump();
    const auto probe_length = noveltea_tooling_native_project_commands_json(
        reinterpret_cast<const std::uint8_t*>(probe_request.data()), probe_request.size(), nullptr,
        0);
    std::vector<std::uint8_t> probe_output(static_cast<std::size_t>(probe_length));
    const auto rejected_length = noveltea_tooling_native_project_commands_json(
        reinterpret_cast<const std::uint8_t*>(probe_request.data()), probe_request.size(),
        probe_output.data(), probe_output.size());
    require(rejected_length == probe_length &&
                !Json::parse(probe_output.begin(), probe_output.end()).value("ok", false) &&
                !std::filesystem::exists(probing_bundle),
            "A two-pass native C API size probe must not export a Project.");
    require(command({{"action", 99}, {"projectRoot", root}}).at("ok") == false,
            "Malformed native CLI action must reject without terminating the process.");
    require(command({{"action", "localization-targets"},
                     {"projectRoot", root},
                     {"locale", "ja"},
                     {"messageIds", Json::array()},
                     {"operation", "inspect"},
                     {"dryRun", 7}})
                    .at("ok") == false,
            "Malformed native localization options fail without terminating the process.");
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

    const auto room_path = fixture.root / "records/rooms/room-lifecycle-roundtrip.yaml";
    auto room_source = read(room_path);
    const auto insert = room_source.find("data:\n");
    require(insert != std::string::npos, "Fixture has expected Room data source.");
    room_source.insert(insert + std::string("data:\n").size(),
                       "  anchors: []\n  fallbackInteractablePlacementId: null # keep my note\n");
    {
        std::ofstream out(room_path, std::ios::binary | std::ios::trunc);
        out << room_source;
    }
    const auto physical = std::string("records/rooms/room-lifecycle-roundtrip.yaml");
    const auto before_fmt = command({{"action", "entity-inspect"},
                                     {"projectRoot", root},
                                     {"collection", "rooms"},
                                     {"id", "room-lifecycle-roundtrip"}});
    require(before_fmt.value("ok", false), "Defaulted fixture record is valid.");
    const auto check = command({{"action", "fmt-strip-defaults"},
                                {"projectRoot", root},
                                {"path", physical},
                                {"check", true}});
    require(
        check.value("ok", false) && check.value("changed", false) && read(room_path) == room_source,
        "Native sparse format check detects removable defaults without writing: " + check.dump());
    const auto before_revision = noveltea::authoring::exact_source_revision(room_source);
    const auto stale_fmt = command({{"action", "fmt-strip-defaults"},
                                    {"projectRoot", root},
                                    {"path", physical},
                                    {"check", false},
                                    {"sourceRevision", "sha256:stale"}});
    require(stale_fmt.at("ok") == false && read(room_path) == room_source,
            "Native format refuses stale revision preconditions.");
    const auto formatted = command({{"action", "fmt-strip-defaults"},
                                    {"projectRoot", root},
                                    {"path", physical},
                                    {"check", false},
                                    {"sourceRevision", before_revision}});
    require(formatted.value("ok", false) && formatted.at("writes") == Json::array({physical}) &&
                read(room_path).find("  anchors: []") == std::string::npos &&
                read(room_path).find("fallbackInteractablePlacementId: null # keep my note") !=
                    std::string::npos,
            "Sparse compaction atomically omits only unannotated default values.");
    const auto after_fmt = command({{"action", "entity-inspect"},
                                    {"projectRoot", root},
                                    {"collection", "rooms"},
                                    {"id", "room-lifecycle-roundtrip"}});
    require(after_fmt.value("ok", false) &&
                after_fmt.at("fields").at("record") == before_fmt.at("fields").at("record"),
            "Native formatter retains exact effective Project record semantics.");

    const auto locale_file = fixture.root / "i18n/locales/ja.yaml";
    const std::string message_id = "25700000-0000-4000-8000-000000000002";
    const auto inspect_target = command({{"action", "localization-targets"},
                                         {"projectRoot", root},
                                         {"operation", "inspect"},
                                         {"locale", "ja"},
                                         {"messageIds", Json::array({message_id})}});
    require(inspect_target.value("ok", false) && inspect_target.at("fingerprints").at(message_id) ==
                                                     "fnv1a:65a40d0410f846f876a25a3adf231834",
            "Native named Message semantic fingerprints match TypeScript tracking identity: " +
                inspect_target.dump());

    const auto locale_before = read(locale_file);
    const auto review =
        command({{"action", "localization-targets"},
                 {"projectRoot", root},
                 {"operation", "review"},
                 {"locale", "ja"},
                 {"messageIds", Json::array({message_id})},
                 {"dryRun", false},
                 {"sourceRevision", noveltea::authoring::exact_source_revision(locale_before)}});
    require(review.value("ok", false) && read(locale_file) != locale_before &&
                review.at("writes") == Json::array({"i18n/locales/ja.yaml"}),
            "Native translation review persists through scoped YAML transaction: " + review.dump());
    const auto stale_accept = command({{"action", "localization-targets"},
                                       {"projectRoot", root},
                                       {"operation", "accept"},
                                       {"locale", "ja"},
                                       {"messageIds", Json::array({message_id})},
                                       {"dryRun", false},
                                       {"sourceRevision", "sha256:stale"}});
    const auto after_review = read(locale_file);
    require(stale_accept.at("ok") == false && read(locale_file) == after_review,
            "Localization review/accept transaction rejects stale source revisions.");

    std::filesystem::create_directories(fixture.root / "workflows/.git");
    std::filesystem::create_directories(fixture.root / "workflows/.noveltea");
    {
        std::ofstream(fixture.root / "workflows/keep.lua") << "return true\n";
        std::ofstream(fixture.root / "workflows/.git/private.txt") << "not portable\n";
        std::ofstream(fixture.root / "workflows/.noveltea/private.txt") << "not portable\n";
    }
    const auto bundle = fixture.root / "bundle.ntproject";
    const auto exported = command(
        {{"action", "project-export"}, {"projectRoot", root}, {"outputPath", bundle.string()}});
    require(exported.value("ok", false) && std::filesystem::is_regular_file(bundle) &&
                exported.at("manifest").at("schema") == "noveltea.project.bundle",
            "Native editable Project export must produce the current portable contract: " +
                exported.dump().substr(0, 600));
    const auto& files = exported.at("manifest").at("files");
    require(
        std::any_of(files.begin(), files.end(),
                    [](const Json& entry) { return entry.at("path") == "workflows/keep.lua"; }) &&
            std::none_of(files.begin(), files.end(),
                         [](const Json& entry) {
                             return entry.at("path").get<std::string>().find("private.txt") !=
                                    std::string::npos;
                         }),
        "Portable Project export includes workflows but excludes nested VCS and local state.");
    const auto destination = fixture.root / ".imports" / "copy";
    const auto imported = command({{"action", "project-import"},
                                   {"bundlePath", bundle.string()},
                                   {"destination", destination.string()}});
    require(imported.value("ok", false) &&
                read(destination / "project.yaml") == read(fixture.root / "project.yaml") &&
                read(destination / "i18n/locales/ja.yaml") == read(locale_file),
            "Native imported Project must preserve authored sources byte-for-byte: " +
                imported.dump().substr(0, 600));
    const auto collision = command({{"action", "project-import"},
                                    {"bundlePath", bundle.string()},
                                    {"destination", destination.string()}});
    require(collision.at("ok") == false, "Portable import must refuse existing destination.");
    const auto invalid_bundle = fixture.root / "corrupt.ntproject";
    auto zip = read(bundle);
    require(zip.size() > 128, "ZIP fixture must have a payload.");
    zip[100] ^= 1;
    {
        std::ofstream out(invalid_bundle, std::ios::binary | std::ios::trunc);
        out.write(zip.data(), static_cast<std::streamsize>(zip.size()));
    }
    const auto corrupt =
        command({{"action", "project-import"},
                 {"bundlePath", invalid_bundle.string()},
                 {"destination", (fixture.root / ".imports" / "rejected").string()}});
    require(corrupt.at("ok") == false &&
                !std::filesystem::exists(fixture.root / ".imports" / "rejected"),
            "Corrupt archive cannot materialize a partial imported Project.");

    const auto clean_sync =
        command({{"action", "localization-sync"}, {"projectRoot", root}, {"dryRun", true}});
    require(clean_sync.value("ok", false) && !clean_sync.at("changed").get<bool>() &&
                clean_sync.at("structuredMessageCount") == 941 &&
                clean_sync.at("preservedMessageIds").size() == 9,
            "Unchanged Feature Lab localization sync must retain every tracked ID and all 941 "
            "structured Messages.");

    const auto scene = fixture.root / "records/scenes/localized-story.yaml";
    const auto original_scene = read(scene);
    const std::string needle =
        "assert(noveltea.layouts.mount('language-board', 'language-board', {owner='session'}))";
    const auto location = original_scene.find(needle);
    require(location != std::string::npos, "Fixture contains the managed Lua source anchor.");
    auto changed_scene = original_scene;
    changed_scene.insert(location + needle.size(),
                         "; noveltea.notify(Text.tr('Native sync newly added marker'))");
    {
        std::ofstream stream(scene, std::ios::binary | std::ios::trunc);
        stream << changed_scene;
    }
    const auto tracking = fixture.root / "i18n/tracking.yaml";
    const auto original_tracking = read(tracking);
    const auto dry_sync =
        command({{"action", "localization-sync"}, {"projectRoot", root}, {"dryRun", true}});
    require(dry_sync.value("ok", false) && dry_sync.at("changed") == true &&
                dry_sync.at("materializedMessageIds") ==
                    Json::array({"f1c2e35b-6b69-51b7-8186-39115dd0e7cb"}) &&
                dry_sync.at("preservedMessageIds").size() == 9 &&
                read(tracking) == original_tracking,
            "New inline Lua Message gets the exact TypeScript deterministic identity without "
            "writing during dry-run.");
    const auto stale_sync = command({{"action", "localization-sync"},
                                     {"projectRoot", root},
                                     {"dryRun", false},
                                     {"sourceRevision", "sha256:stale"}});
    require(!stale_sync.value("ok", false) && read(tracking) == original_tracking,
            "Native sync write requires an exact tracking source revision.");
    const auto updated_sync = command(
        {{"action", "localization-sync"},
         {"projectRoot", root},
         {"dryRun", false},
         {"sourceRevision", noveltea::authoring::exact_source_revision(original_tracking)}});
    require(updated_sync.value("ok", false) &&
                updated_sync.at("writes") == Json::array({"i18n/tracking.yaml"}) &&
                read(tracking).find("f1c2e35b-6b69-51b7-8186-39115dd0e7cb") != std::string::npos &&
                read(scene) == changed_scene,
            "Native localization sync atomically saves the tracked source only and preserves "
            "the original managed Lua text: " +
                updated_sync.dump().substr(0, 400));
    const auto repeated_sync =
        command({{"action", "localization-sync"}, {"projectRoot", root}, {"dryRun", true}});
    require(repeated_sync.value("ok", false) && repeated_sync.at("changed") == false &&
                repeated_sync.at("preservedMessageIds").size() == 10,
            "Reopened tracked source is valid and repeated sync remains stable.");
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
