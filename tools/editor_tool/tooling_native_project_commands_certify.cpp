#include "tooling_native_c.h"
#include "../project_authoring/localization_semantics.hpp"
#include "../project_authoring/source_authority.hpp"
#include "../project_authoring/yaml_codec.hpp"

#include <nlohmann/json.hpp>

#include <chrono>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <iterator>
#include <stdexcept>
#include <string>
#include <string_view>
#include <tuple>
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

Json disk_validate(const Json& request)
{
    const auto serialized = request.dump();
    std::vector<std::uint8_t> response(8 * 1024 * 1024);
    const auto size = noveltea_tooling_native_disk_project_validation_json(
        reinterpret_cast<const std::uint8_t*>(serialized.data()), serialized.size(),
        response.data(), response.size());
    require(size < response.size(), "Windows disk-validation response buffer too small.");
    return Json::parse(response.begin(), response.begin() + static_cast<std::ptrdiff_t>(size));
}

void certify_owner_session_reuse()
{
    struct CreatedProject {
        std::filesystem::path root;
        ~CreatedProject()
        {
            std::error_code ignored;
            std::filesystem::remove_all(root, ignored);
        }
    } fixture{std::filesystem::temp_directory_path() /
              ("noveltea-native-owner-cert-" +
               std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()))};
    const auto created = command({{"action", "project-create"},
                                  {"projectRoot", fixture.root.string()},
                                  {"name", "Native Cache"}});
    require(created.value("ok", false), "Native owner fixture creation succeeds.");
    const Json inspect{{"action", "entity-inspect"},
                       {"projectRoot", fixture.root.string()},
                       {"collection", "scripts"},
                       {"id", "bootstrap"}};
    const auto first = command(inspect);
    const auto second = command(inspect);
    require(first.value("ok", false) && second.value("ok", false) &&
                !first.value("nativeOwnerReused", true) && second.value("nativeOwnerReused", false),
            "The CLI command owner reuses its native Project session between requests.");
    const auto created_room = command({{"action", "entity-create"},
                                       {"projectRoot", fixture.root.string()},
                                       {"collection", "rooms"},
                                       {"id", "native-cache-room"},
                                       {"dryRun", false}});
    require(created_room.value("ok", false), "Resident native Project creation commits.");
    const auto added = command({{"action", "entity-inspect"},
                                {"projectRoot", fixture.root.string()},
                                {"collection", "rooms"},
                                {"id", "native-cache-room"}});
    require(added.value("ok", false) && added.value("nativeOwnerReused", false),
            "The retained native Project admits a newly committed record without reopening.");

    const auto manifest = fixture.root / "project.yaml";
    auto text = read(manifest);
    const auto offset = text.find("name: \"Native Cache\"");
    require(offset != std::string::npos, "Native owner manifest contains the original name.");
    text.replace(offset, std::string("name: \"Native Cache\"").size(), "name: \"External Name\"");
    {
        std::ofstream output(manifest, std::ios::binary | std::ios::trunc);
        output << text;
    }
    const auto prepared =
        command({{"action", "export-preparation"}, {"projectRoot", fixture.root.string()}});
    require(prepared.value("ok", false) &&
                prepared.at("project").at("project").at("name") == "External Name",
            "A retained native Project observes external disk revisions before export.");
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

void certify_invalid_manifest_boundary(const std::filesystem::path& fixture_source)
{
    Fixture fixture(fixture_source);
    const auto path = fixture.root / "project.yaml";
    const auto original = read(path);
    for (const auto& [replacement, expected] :
         {std::pair<std::string, std::string>{"name: []", "schema.type"},
          {"name: [", "source.project"}}) {
        auto invalid = original;
        const auto offset = invalid.find("name: Feature Lab");
        require(offset != std::string::npos, "Manifest source fixture has expected Project name.");
        invalid.replace(offset, std::string("name: Feature Lab").size(), replacement);
        {
            std::ofstream output(path, std::ios::binary | std::ios::trunc);
            output << invalid;
        }
        const auto result = disk_validate({{"projectRoot", fixture.root.string()}});
        require(result.value("ok", false) && !result.value("valid", true) &&
                    result.contains("diagnostics") && result.at("diagnostics").is_array() &&
                    std::any_of(result.at("diagnostics").begin(), result.at("diagnostics").end(),
                                [&](const auto& diagnostic) {
                                    return diagnostic.value("code", "") == expected &&
                                           diagnostic.value("sourcePath", "") == "project.yaml";
                                }),
                "Native CLI cold manifest diagnostics are structured for " + replacement + ": " +
                    result.dump());
    }
}

void certify_owner_default_stripping(const std::filesystem::path& fixture_source)
{
    Fixture fixture(fixture_source);
    const auto root = fixture.root.string();
    for (const auto& [path, minimum] :
         {std::pair<std::string, int>{"editor.yaml", 3}, {"i18n/project.yaml", 1}}) {
        const auto before = read(fixture.root / path);
        const auto check = command({{"action", "fmt"},
                                    {"projectRoot", root},
                                    {"path", path},
                                    {"check", true},
                                    {"stripDefaults", true}});
        require(check.value("ok", false) && check.at("removedDefaults").get<int>() >= minimum &&
                    read(fixture.root / path) == before,
                "Native fmt recognizes source-declared owner defaults without writing: " + path +
                    " " + check.dump());
    }
    const auto layout_path = "records/layouts/feature-lab-hud/layout.yaml";
    auto source = read(fixture.root / layout_path);
    const auto start = source.find("data:\n");
    require(start != std::string::npos && source.find("  target: default-ui") == std::string::npos,
            "Layout metadata fixture supports default insertion.");
    source.insert(start + std::string("data:\n").size(), "  target: default-ui\n");
    {
        std::ofstream output(fixture.root / layout_path, std::ios::binary | std::ios::trunc);
        output << source;
    }
    const auto check = command({{"action", "fmt"},
                                {"projectRoot", root},
                                {"path", layout_path},
                                {"check", true},
                                {"stripDefaults", true}});
    require(check.value("ok", false) && check.at("removedDefaults").get<int>() >= 1 &&
                read(fixture.root / layout_path) == source,
            "Native fmt supports nested Layout metadata omission without changing disk bytes: " +
                check.dump());
    const auto empty_project =
        fixture.root.parent_path() / (fixture.root.filename().string() + "-fmt-manifest");
    std::error_code ignored;
    std::filesystem::remove_all(empty_project, ignored);
    const auto created = command({{"action", "project-create"},
                                  {"projectRoot", empty_project.string()},
                                  {"name", "Manifest Omission Fixture"}});
    require(created.value("ok", false), "Native Manifest omission fixture must be creatable.");
    {
        std::ofstream manifest(empty_project / "project.yaml", std::ios::binary | std::ios::app);
        manifest << "entrypoint: null\nundefinedInteractionProgram: null\n";
    }
    const auto empty_manifest = read(empty_project / "project.yaml");
    const auto manifest_check = command({{"action", "fmt"},
                                         {"projectRoot", empty_project.string()},
                                         {"path", "project.yaml"},
                                         {"check", true},
                                         {"stripDefaults", true}});
    require(manifest_check.value("ok", false) &&
                manifest_check.at("removedDefaults").get<int>() >= 1 &&
                read(empty_project / "project.yaml") == empty_manifest,
            "Native fmt compacts defaults in a valid Project Manifest without modifying it: " +
                manifest_check.dump());
    std::filesystem::remove_all(empty_project, ignored);
}

void certify_asset_import(const std::filesystem::path& fixture_source)
{
    Fixture fixture(fixture_source);
    const auto root = fixture.root.string();
    for (const auto& [original, name, classification] :
         {std::tuple<std::string, std::string, std::string>{"assets/images/bedroom.webp",
                                                            "native-import-image.webp", "image"},
          {"assets/fonts/DejaVuSans.ttf", "native-import-font.ttf", "font"},
          {"assets/audio/notification.mp3", "native-import-audio.mp3", "audio"},
          {"assets/video/opaque-colors.mp4", "native-import-video.mp4", "video"}}) {
        const auto input = fixture.root / name;
        std::filesystem::copy_file(fixture.root / original, input);
        const auto checked = command({{"action", "asset-import"},
                                      {"projectRoot", root},
                                      {"paths", Json::array({input.string()})},
                                      {"dryRun", true}});
        require(checked.value("ok", false) &&
                    checked.at("fields").at("assets").at(0).at("kind") == classification &&
                    !std::filesystem::exists(fixture.root / ("records/assets/native-import-" +
                                                             classification + ".yaml")),
                "Native import validates real Image/Font/Audio/Video bytes without writes: " +
                    name + " " + checked.dump().substr(0, 500));
        std::filesystem::remove(input);
    }
    const auto source = fixture.root / "native-asset-import-note.txt";
    {
        std::ofstream output(source, std::ios::binary);
        output << "Asset import has to commit the exact bytes.\n";
    }
    const auto destination = fixture.root / "assets/text/native-asset-import-note.txt";
    const auto record = fixture.root / "records/assets/native-asset-import-note.yaml";
    const auto dry = command({{"action", "asset-import"},
                              {"projectRoot", root},
                              {"paths", Json::array({source.string()})},
                              {"dryRun", true}});
    require(dry.value("ok", false) && dry.at("fields").at("dryRun") == true &&
                dry.at("fields").at("assets").size() == 1 &&
                !std::filesystem::exists(destination) && !std::filesystem::exists(record),
            "Native dry-run Asset import has no physical side effects: " + dry.dump());
    const auto rejected =
        command({{"action", "asset-import"},
                 {"projectRoot", root},
                 {"paths", Json::array({source.string(), (fixture.root / "missing.txt").string()})},
                 {"dryRun", false}});
    require(!rejected.value("ok", false) && !std::filesystem::exists(destination) &&
                !std::filesystem::exists(record),
            "Native Asset import validates all inputs before creating targets.");
    const auto committed = command({{"action", "asset-import"},
                                    {"projectRoot", root},
                                    {"paths", Json::array({source.string()})},
                                    {"dryRun", false}});
    require(committed.value("ok", false) && committed.at("fields").at("dryRun") == false &&
                std::filesystem::is_regular_file(destination) &&
                std::filesystem::is_regular_file(record) && read(destination) == read(source),
            "Native Asset import publishes one source and its record together: " +
                committed.dump());
    require(command({{"action", "entity-inspect"},
                     {"projectRoot", root},
                     {"collection", "assets"},
                     {"id", "native-asset-import-note"}})
                .value("ok", false),
            "Native imported Asset is admitted by the Project semantic validator.");
    const auto resolved = command({{"action", "asset-import"},
                                   {"projectRoot", root},
                                   {"paths", Json::array({destination.string()})},
                                   {"dryRun", false}});
    require(resolved.value("ok", false) &&
                resolved.at("fields").at("assets").at(0).at("alreadyImported") == true,
            "Re-importing an existing physical Asset reports its existing record.");

    // Recreate a process crash between byte publication and YAML publication.
    // The next mutating native command must not mistake stale staging for a
    // YAML journal and must delete only bytes proven to belong to the old
    // uncommitted import.
    const auto lock = fixture.root / ".noveltea/asset-import.lock";
    const auto stage = fixture.root / ".noveltea/asset-import-staging/abandoned";
    const auto orphan = fixture.root / "assets/text/abandoned-import.txt";
    const auto create_interruption = [&](std::string actual) {
        std::filesystem::create_directories(lock);
        std::filesystem::create_directories(stage);
        {
            std::ofstream output(lock / "owner.json", std::ios::binary);
            output << Json{{"pid", 2'000'000'000}}.dump() << '\n';
        }
        {
            std::ofstream output(stage / "0", std::ios::binary);
            output << actual;
        }
        std::filesystem::create_hard_link(stage / "0", orphan);
        {
            std::ofstream output(stage / "manifest.json", std::ios::binary);
            output << Json{{"schema", "noveltea.native-asset-import"},
                           {"items",
                            Json::array({{{"recordPath", "records/assets/abandoned-import.yaml"},
                                          {"recordRevision",
                                           noveltea::authoring::exact_source_revision("unused")},
                                          {"assetPath", "assets/text/abandoned-import.txt"},
                                          {"assetRevision",
                                           noveltea::authoring::exact_source_revision("unchanged")},
                                          {"external", true}}})}}
                          .dump()
                   << '\n';
        }
    };
    create_interruption("unchanged");
    const auto recovered = command({{"action", "asset-import"},
                                    {"projectRoot", root},
                                    {"paths", Json::array({destination.string()})},
                                    {"dryRun", false}});
    require(recovered.value("ok", false) && !std::filesystem::exists(lock) &&
                !std::filesystem::exists(stage) && !std::filesystem::exists(orphan) &&
                read(destination) == read(source),
            "Dead import recovery deletes only exact unpublished binaries and preserves prior "
            "Assets: " +
                recovered.dump());
    create_interruption("user-modified-content");
    const auto ambiguous = command({{"action", "asset-import"},
                                    {"projectRoot", root},
                                    {"paths", Json::array({destination.string()})},
                                    {"dryRun", false}});
    require(
        !ambiguous.value("ok", false) && std::filesystem::exists(stage) &&
            read(orphan) == "user-modified-content" && read(destination) == read(source),
        "Recovery refuses to destroy binaries that no longer match the committed source proof.");
    std::filesystem::remove_all(lock);
    std::filesystem::remove_all(stage);
    std::filesystem::remove(orphan);
    create_interruption("unchanged");
    const auto later = fixture.root / "assets/text/abandoned-import-later.txt";
    {
        std::ofstream output(stage / "1", std::ios::binary);
        output << "user-modified-content";
    }
    std::filesystem::create_hard_link(stage / "1", later);
    auto journal = Json::parse(read(stage / "manifest.json"));
    journal.at("items").push_back(
        {{"recordPath", "records/assets/abandoned-import-later.yaml"},
         {"recordRevision", noveltea::authoring::exact_source_revision("unused-later")},
         {"assetPath", "assets/text/abandoned-import-later.txt"},
         {"assetRevision", noveltea::authoring::exact_source_revision("expected-unmodified")},
         {"external", true}});
    {
        std::ofstream output(stage / "manifest.json", std::ios::binary | std::ios::trunc);
        output << journal.dump() << '\n';
    }
    const auto late_conflict = command({{"action", "asset-import"},
                                        {"projectRoot", root},
                                        {"paths", Json::array({destination.string()})},
                                        {"dryRun", false}});
    require(!late_conflict.value("ok", false) && std::filesystem::exists(orphan) &&
                read(orphan) == "unchanged" && read(later) == "user-modified-content",
            "A later recovery conflict must not partially delete an earlier verified Asset.");
    std::filesystem::remove_all(lock);
    std::filesystem::remove_all(stage);
    std::filesystem::remove(orphan);
    std::filesystem::remove(later);
}

void certify(const std::filesystem::path& source)
{
    Fixture fixture(source);
    const auto root = fixture.root.string();
    {
        const auto new_project =
            fixture.root.parent_path() / (fixture.root.filename().string() + "-created");
        std::error_code ignored;
        std::filesystem::remove_all(new_project, ignored);
        const auto created = command({{"action", "project-create"},
                                      {"projectRoot", new_project.string()},
                                      {"name", "Native Workspace"}});
        require(created.value("ok", false) &&
                    created.value("projectId", "") == "native-workspace" &&
                    std::filesystem::is_regular_file(new_project / "project.yaml") &&
                    read(new_project / "project.yaml")
                            .find("applicationId: org.noveltea.native-workspace") !=
                        std::string::npos &&
                    read(new_project / "project.yaml")
                            .find("saveNamespace: org.noveltea.native-workspace") !=
                        std::string::npos &&
                    read(new_project / "AGENTS.md")
                            .find("<!-- noveltea:managed-agent-bootstrap:start -->") !=
                        std::string::npos &&
                    read(new_project / ".gitignore").find("/dist/") != std::string::npos,
                "Native Project create publishes the canonical blank Workspace atomically: " +
                    created.dump());
        const auto opened = command({{"action", "entity-inspect"},
                                     {"projectRoot", new_project.string()},
                                     {"collection", "scripts"},
                                     {"id", "bootstrap"}});
        require(opened.value("ok", false),
                "Native created Project admits its canonical bootstrap Script source.");
        require(!command({{"action", "project-create"},
                          {"projectRoot", new_project.string()},
                          {"name", "Another Project"}})
                     .value("ok", false),
                "Native Project creation refuses existing destinations without overwriting.");
        std::filesystem::remove_all(new_project, ignored);
    }
#ifdef _WIN32
    // Both disk validation and the CLI adapter receive UTF-8 JSON roots.
    // Their independent path adapters must resolve the same native wide path
    // even when the Windows process ACP cannot represent the directory name.
    const auto unicode_root = fixture.root / std::filesystem::path(u8"日本語-项目");
    std::filesystem::copy(source, unicode_root, std::filesystem::copy_options::recursive);
    const auto unicode_path = unicode_root.u8string();
    const auto unicode_utf8 = std::string(unicode_path.begin(), unicode_path.end());
    const auto disk_result = disk_validate({{"projectRoot", unicode_utf8}});
    require(disk_result.value("ok", false) && disk_result.value("valid", false),
            "Windows disk validation accepts a UTF-8 Project root.");
    const auto command_result = command({{"action", "entity-inspect"},
                                         {"projectRoot", unicode_utf8},
                                         {"collection", "rooms"},
                                         {"id", "room-lifecycle-roundtrip"}});
    require(command_result.value("ok", false),
            "Windows native command and disk validation agree on UTF-8 paths.");
#endif
    const auto path = fixture.root / "project.yaml";
    const auto baseline = read(path);
    const auto baseline_revision = noveltea::authoring::exact_source_revision(baseline);
    const auto inspect = command({{"action", "entity-inspect"},
                                  {"projectRoot", root},
                                  {"collection", "rooms"},
                                  {"id", "room-lifecycle-roundtrip"},
                                  {"provenance", true}});
    require(inspect.value("ok", false), "Native CLI record inspection failed.");
    {
        const auto untracked = fixture.root / "assets/text/native-audit-untracked.txt";
        std::filesystem::create_directories(untracked.parent_path());
        {
            std::ofstream output(untracked, std::ios::binary);
            output << "Untracked audit fixture.";
        }
        const auto unmodified_audit = command({{"action", "asset-audit"}, {"projectRoot", root}});
        require(unmodified_audit.value("ok", false) &&
                    std::any_of(unmodified_audit.at("fields").at("untrackedFiles").begin(),
                                unmodified_audit.at("fields").at("untrackedFiles").end(),
                                [](const Json& entry) {
                                    return entry.at("projectRelativePath") ==
                                               "assets/text/native-audit-untracked.txt" &&
                                           entry.at("kind") == "text";
                                }),
                "Native scoped Asset audit reports untracked Assets and their type.");
        const auto room = fixture.root / "records/rooms/active-text-finish.yaml";
        const auto saved_room = read(room);
        {
            std::ofstream output(room, std::ios::binary | std::ios::trunc);
            output << "broken: [\n";
        }
        const auto scoped_audit = command({{"action", "asset-audit"}, {"projectRoot", root}});
        require(scoped_audit.value("ok", false) &&
                    scoped_audit.at("fields").at("untrackedFiles") ==
                        unmodified_audit.at("fields").at("untrackedFiles"),
                "Asset audit remains available when an unrelated Room is malformed.");
        {
            std::ofstream output(room, std::ios::binary | std::ios::trunc);
            output << saved_room;
        }
        std::filesystem::remove(untracked);
    }
    const auto& fields = inspect.at("fields");
    require(fields.at("record").at("id") == "room-lifecycle-roundtrip" &&
                fields.at("provenance").at("id") == "explicit",
            "CLI inspect returns effective fields and sparse-source provenance.");
    const auto usages = command({{"action", "entity-usages"},
                                 {"projectRoot", root},
                                 {"collection", "rooms"},
                                 {"id", "room-lifecycle-roundtrip"}});
    require(usages.value("ok", false) && usages.at("usages").size() == 5 &&
                std::all_of(
                    usages.at("usages").begin(), usages.at("usages").end(),
                    [](const Json& item) {
                        return item.at("role") == "room-exit-target" &&
                               item.at("sourcePath").get<std::string>().ends_with("/target/$ref");
                    }),
            "Native read-only usages enumerates five exact Room exit edges.");
    require(!command({{"action", "entity-usages"},
                      {"projectRoot", root},
                      {"collection", "rooms"},
                      {"id", "absent-room"}})
                 .value("ok", false),
            "Native usages does not return a misleading empty graph for missing records.");
    const auto material_usages = command({{"action", "entity-usages"},
                                          {"projectRoot", root},
                                          {"collection", "materials"},
                                          {"id", "engine2d-draw-contract"}});
    require(material_usages.value("ok", false) && material_usages.at("usages").size() == 18,
            "Native uses match structured Material dependencies and lexical Lua candidates.");
    const auto variable_usages = command({{"action", "entity-usages"},
                                          {"projectRoot", root},
                                          {"collection", "variables"},
                                          {"id", "world-composition-enabled"}});
    require(variable_usages.value("ok", false) && variable_usages.at("usages").size() == 6 &&
                std::count_if(variable_usages.at("usages").begin(),
                              variable_usages.at("usages").end(),
                              [](const Json& usage) {
                                  return usage.at("role") == "condition-variable";
                              }) == 3,
            "Native usages matches Condition references and external script lexical evidence.");
    const auto asset_usages = command({{"action", "entity-usages"},
                                       {"projectRoot", root},
                                       {"collection", "assets"},
                                       {"id", "pilot-room-backdrop"}});
    require(asset_usages.value("ok", false) && asset_usages.at("usages").size() == 53 &&
                std::count_if(asset_usages.at("usages").begin(), asset_usages.at("usages").end(),
                              [](const Json& usage) {
                                  return usage.at("role") == "hotspot-source-image";
                              }) == 4,
            "Native usages preserves nested hotspot background-Asset edges.");
    const auto animation_usages = command({{"action", "entity-usages"},
                                           {"projectRoot", root},
                                           {"collection", "animations"},
                                           {"id", "custom-board-loop"}});
    require(animation_usages.value("ok", false) && animation_usages.at("usages").size() == 7 &&
                std::count_if(animation_usages.at("usages").begin(),
                              animation_usages.at("usages").end(),
                              [](const Json& usage) {
                                  return usage.at("role") == "hotspot-source-image";
                              }) == 6,
            "Native usages preserves Interactable visual and nested hotspot Animation edges.");
    const auto unknown = command({{"action", "entity-inspect"},
                                  {"projectRoot", root},
                                  {"collection", "rooms"},
                                  {"id", "missing"}});
    require(unknown.at("ok") == false, "Unknown native records must be rejected.");
    require(!command({{"action", "entity-delete"},
                      {"projectRoot", root},
                      {"collection", "../../outside"},
                      {"id", "project"},
                      {"dryRun", false},
                      {"sourceRevision", baseline_revision}})
                    .value("ok", false) &&
                read(path) == baseline,
            "Native entity mutations reject physical path injection via collection names.");

    const auto runtime_preparation =
        command({{"action", "runtime-package-preparation"}, {"projectRoot", root}});
    require(runtime_preparation.value("ok", false) &&
                runtime_preparation.at("runtimeIntent") == "runtime-package-export" &&
                runtime_preparation.at("profile") ==
                    runtime_preparation.at("project").at("export").at("runtime") &&
                runtime_preparation.at("profile").at("kind") == "runtime" &&
                runtime_preparation.at("projectIdentity") ==
                    runtime_preparation.at("project").at("project") &&
                runtime_preparation.at("sourcePaths").size() ==
                    runtime_preparation.at("sourceRevisions").size(),
            "Native Runtime Package preparation uses the admitted complete Project, the "
            "selected runtime profile, and revision-pinned file inventory.");
    require(!command({{"action", "runtime-package-preparation"},
                      {"projectRoot", root},
                      {"profileId", "unselected-profile"}})
                 .value("ok", false),
            "Native runtime preparation must reject unselected export profiles.");

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
    const auto whole_strip = command({{"action", "fmt"},
                                      {"projectRoot", root},
                                      {"path", "records/rooms/room-lifecycle-roundtrip.yaml"},
                                      {"check", true},
                                      {"stripDefaults", true}});
    require(whole_strip.value("ok", false) && whole_strip.at("changed") == true &&
                whole_strip.at("removedDefaults").get<std::size_t>() > 0 &&
                read(room_path) == room_source,
            "Whole-source native fmt includes semantic default stripping in check mode: " +
                whole_strip.dump().substr(0, 600));
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

    const auto variable_path = fixture.root / "records/variables/background-deliveries.yaml";
    const auto original_variable = read(variable_path);
    {
        std::ofstream output(variable_path, std::ios::app);
        output << "  nullable: false\n  scope: global\n";
    }
    const auto explicit_variable = read(variable_path);
    const auto variable_fmt = command({{"action", "fmt"},
                                       {"projectRoot", root},
                                       {"path", "records/variables/background-deliveries.yaml"},
                                       {"check", true},
                                       {"stripDefaults", true}});
    require(variable_fmt.value("ok", false) && variable_fmt.value("changed", false) &&
                variable_fmt.at("removedDefaults").get<std::size_t>() == 2 &&
                read(variable_path) == explicit_variable,
            "Native fmt --strip-defaults detects explicit Variable nullable/scope defaults: " +
                variable_fmt.dump());
    const auto variable_commit =
        command({{"action", "fmt"},
                 {"projectRoot", root},
                 {"path", "records/variables/background-deliveries.yaml"},
                 {"check", false},
                 {"stripDefaults", true},
                 {"diskPreconditions",
                  {{"records/variables/background-deliveries.yaml",
                    noveltea::authoring::exact_source_revision(explicit_variable)}}}});
    require(variable_commit.value("ok", false) &&
                read(variable_path).find("nullable:") == std::string::npos &&
                read(variable_path).find("scope:") == std::string::npos,
            "Variable compaction commits via the same revision-checked semantic writer: " +
                variable_commit.dump());

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
    const Json managed_ids = Json::array(
        {"9a53c6c6-c7ce-5c62-907d-7d6c124e7456", "b97bfd6f-e54d-5a4b-9c0f-5b157f56b1bf"});
    const auto managed = command({{"action", "localization-targets"},
                                  {"projectRoot", root},
                                  {"operation", "inspect"},
                                  {"locale", "fr"},
                                  {"messageIds", managed_ids}});
    require(managed.value("ok", false) &&
                managed.at("fingerprints").at("9a53c6c6-c7ce-5c62-907d-7d6c124e7456") ==
                    "fnv1a:37806bfd126ea9297f3c6657a962f44d" &&
                managed.at("fingerprints").at("b97bfd6f-e54d-5a4b-9c0f-5b157f56b1bf") ==
                    "fnv1a:0c1d0b3250f54a2e90d523bc96000de2",
            "Managed Lua and RML localization fingerprints match the installed CLI views: " +
                managed.dump().substr(0, 500));
    const auto structured =
        command({{"action", "localization-targets"},
                 {"projectRoot", root},
                 {"operation", "inspect"},
                 {"locale", "fr"},
                 {"messageIds", Json::array({"07203395-f20c-5d69-8d8b-2547b934eaa5"})}});
    require(structured.value("ok", false) &&
                structured.at("fingerprints").at("07203395-f20c-5d69-8d8b-2547b934eaa5") ==
                    "fnv1a:536441f154618d856ff8cf4743485301",
            "Native translation acceptance includes structured semantic Messages: " +
                structured.dump().substr(0, 480));

    const auto locale_before = read(locale_file);
    const auto review =
        command({{"action", "localization-targets"},
                 {"projectRoot", root},
                 {"operation", "review"},
                 {"locale", "ja"},
                 {"messageIds", Json::array({message_id})},
                 {"dryRun", false},
                 {"expectedSourceGeneration", inspect_target.at("sourceGeneration")},
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

    const std::string active_text_message = "25700000-0000-4000-8000-000000000099";
    {
        const auto named_path = fixture.root / "i18n/messages.yaml";
        auto named = read(named_path);
        const auto marker = named.find("structuredMessageIds:");
        require(marker != std::string::npos, "Named Message fixture has its final tracking root.");
        named.insert(marker, "  " + active_text_message +
                                 ":\n"
                                 "    key: lab.active-text-fingerprint\n"
                                 "    kind: named\n"
                                 "    source: 'Visit [[Bridge|a b]] and [o=door]!'\n");
        std::ofstream out(named_path, std::ios::binary | std::ios::trunc);
        out << named;
    }
    const auto active_text = command({{"action", "localization-targets"},
                                      {"projectRoot", root},
                                      {"operation", "inspect"},
                                      {"locale", "ja"},
                                      {"messageIds", Json::array({active_text_message})}});
    require(active_text.value("ok", false) &&
                active_text.at("fingerprints").at(active_text_message) ==
                    "fnv1a:46aa084a16e962163b654bc0d4a6297a",
            "Native named-Message fingerprint retains ActiveText object identity, shorthands "
            "and cue order: " +
                active_text.dump().substr(0, 430));

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
    const auto stale_generation_sync = command(
        {{"action", "localization-sync"},
         {"projectRoot", root},
         {"dryRun", false},
         {"expectedSourceGeneration", clean_sync.at("sourceGeneration")},
         {"sourceRevision", noveltea::authoring::exact_source_revision(original_tracking)}});
    require(!stale_generation_sync.value("ok", false) && read(tracking) == original_tracking,
            "Native sync rejects an unchanged YAML target when the managed Lua source generation "
            "has changed since planning.");
    const auto updated_sync = command(
        {{"action", "localization-sync"},
         {"projectRoot", root},
         {"dryRun", false},
         {"expectedSourceGeneration", dry_sync.at("sourceGeneration")},
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

    // New deterministic Message identities must be applied through native
    // transactional source editing, not just reported in a dry-run plan.
    auto removed_scene = read(scene);
    const auto call_at = removed_scene.find(needle);
    require(call_at != std::string::npos, "Fixture contains the Lua anchor.");
    removed_scene.insert(call_at + needle.size(),
                         "; noveltea.notify(Text.tr('Native reconcile newly added marker'))");
    {
        std::ofstream stream(scene, std::ios::binary | std::ios::trunc);
        stream << removed_scene;
    }
    const std::string workspace_revision = "sha256:certification-native-reconciliation";
    const auto plan_response = command({{"action", "localization-reconcile"},
                                        {"projectRoot", root},
                                        {"workspaceRevision", workspace_revision}});
    require(plan_response.value("ok", false) &&
                plan_response.at("plan").at("deterministicChanged") == true &&
                plan_response.at("plan").at("groups").empty(),
            "Native reconciliation identifies a deterministic new managed Message: " +
                plan_response.dump().substr(0, 600));
    const auto plan = plan_response.at("plan");
    Json preconditions = Json::object();
    for (const auto* target : {"i18n/tracking.yaml", "i18n/orphans.yaml", "i18n/locales/fr.yaml",
                               "i18n/locales/ja.yaml", "i18n/locales/en-GB.yaml"}) {
        if (std::filesystem::is_regular_file(fixture.root / target))
            preconditions[target] =
                noveltea::authoring::exact_source_revision(read(fixture.root / target));
    }
    const auto apply_input =
        Json{{"action", "localization-reconcile"},
             {"projectRoot", root},
             {"dryRun", false},
             {"workspaceRevision", workspace_revision},
             {"expectedWorkspaceRevision", workspace_revision},
             {"expectedSourceGeneration", plan_response.at("sourceGeneration")},
             {"expectedFingerprint", plan.at("expectedFingerprint")},
             {"resolutions", Json::object()},
             {"diskPreconditions", preconditions}};
    auto stale_input = apply_input;
    stale_input["diskPreconditions"]["i18n/tracking.yaml"] = "sha256:stale";
    const auto pre_apply_tracking = read(tracking);
    require(!command(stale_input).value("ok", false) && read(tracking) == pre_apply_tracking,
            "Reconciliation cannot commit with an outdated physical tracking revision.");
    auto stale_generation_apply = apply_input;
    stale_generation_apply["expectedSourceGeneration"] = clean_sync.at("sourceGeneration");
    require(!command(stale_generation_apply).value("ok", false) &&
                read(tracking) == pre_apply_tracking,
            "Reconciliation rejects caller-supplied workspace revisions without a matching "
            "native physical authoring generation.");
    const auto applied = command(apply_input);
    require(applied.value("ok", false) &&
                applied.at("writes") == Json::array({"i18n/tracking.yaml"}) &&
                read(scene) == removed_scene,
            "Native reconciliation persists deterministic Message tracking: " +
                applied.dump().substr(0, 700));
    const auto repeated_plan = command({{"action", "localization-reconcile"},
                                        {"projectRoot", root},
                                        {"workspaceRevision", workspace_revision}});
    require(repeated_plan.value("ok", false) &&
                repeated_plan.at("plan").at("deterministicChanged") == false,
            "Repeated reconciliation leaves unchanged local Message identity stable.");
    for (const auto& family : {"variables", "rooms", "materials", "layouts"}) {
        const auto id = std::string("native-cli-created-") + family;
        const auto path = fixture.root / "records" / family /
                          (family == std::string("layouts") ? id + "/layout.yaml" : id + ".yaml");
        const Json request{
            {"action", "entity-create"}, {"projectRoot", root}, {"collection", family}, {"id", id}};
        const auto dry = command(request);
        require(dry.value("ok", false) && !std::filesystem::exists(path),
                "Native entity create dry-run does not materialize the new source.");
        auto committing = request;
        committing["dryRun"] = false;
        const auto created = command(committing);
        require(created.value("ok", false) && std::filesystem::is_regular_file(path) &&
                    created.at("writes").size() == (family == std::string("layouts") ? 4u : 1u),
                "Native entity create commits its generated source transaction: " + created.dump());
        require(!command(committing).value("ok", false),
                "Native entity create rejects duplicate physical owner paths.");
        const auto inspected = command({{"action", "entity-inspect"},
                                        {"projectRoot", root},
                                        {"collection", family},
                                        {"id", id}});
        require(inspected.value("ok", false) && inspected.at("fields").at("record").at("id") == id,
                "New record must reopen under the native schema validator: " +
                    inspected.dump().substr(0, 350));
        const auto renamed_id = id + "-renamed";
        const auto renamed_path =
            fixture.root / "records" / family /
            (family == std::string("layouts") ? renamed_id + "/layout.yaml" : renamed_id + ".yaml");
        Json renaming{{"action", "entity-rename"},
                      {"projectRoot", root},
                      {"collection", family},
                      {"id", id},
                      {"toId", renamed_id},
                      {"dryRun", false},
                      {"sourceRevision", noveltea::authoring::exact_source_revision(read(path))}};
        const auto renamed = command(renaming);
        require(renamed.value("ok", false) && !std::filesystem::exists(path) &&
                    std::filesystem::is_regular_file(renamed_path),
                "Native reference-free identity rename is an atomic transaction: " +
                    renamed.dump().substr(0, 500));
        Json deleting{{"action", "entity-delete"}, {"projectRoot", root},
                      {"collection", family},      {"id", renamed_id},
                      {"dryRun", false},           {"sourceRevision", "sha256:stale"}};
        require(!command(deleting).value("ok", false) &&
                    std::filesystem::is_regular_file(renamed_path),
                "Native structural deletion rejects a stale source revision.");
        deleting["sourceRevision"] = noveltea::authoring::exact_source_revision(read(renamed_path));
        require(command(deleting).value("ok", false) && !std::filesystem::exists(renamed_path),
                "Native reference-free deletion commits atomically.");
    }
    const auto lexical_id = std::string("native-possible-probe");
    const auto lexical_path = fixture.root / "records/variables/native-possible-probe.yaml";
    require(command({{"action", "entity-create"},
                     {"projectRoot", root},
                     {"collection", "variables"},
                     {"id", lexical_id},
                     {"dryRun", false}})
                .value("ok", false),
            "Create lexical reference probe without external dependents.");
    auto room_with_note = read(room_path);
    const auto label_at = room_with_note.find("label: Lifecycle Round Trip\n");
    require(label_at != std::string::npos, "Canonical Room label exists in the fixture.");
    room_with_note.replace(label_at, std::string("label: Lifecycle Round Trip\n").size(),
                           "label: Lifecycle native-possible-probe Round Trip\n");
    room_with_note += "# Keep this unrelated source comment\n";
    {
        std::ofstream out(room_path, std::ios::binary | std::ios::trunc);
        out << room_with_note;
    }
    const Json lexical_delete{
        {"action", "entity-delete"},
        {"projectRoot", root},
        {"collection", "variables"},
        {"id", lexical_id},
        {"dryRun", false},
        {"sourceRevision", noveltea::authoring::exact_source_revision(read(lexical_path))}};
    const auto blocked_lexical = command(lexical_delete);
    require(!blocked_lexical.value("ok", false) && std::filesystem::is_regular_file(lexical_path),
            "Unacknowledged possible source references prevent structural deletion.");
    auto acknowledged_lexical = lexical_delete;
    acknowledged_lexical["allowPossibleSourceReferences"] = true;
    const auto acknowledged = command(acknowledged_lexical);
    require(acknowledged.value("ok", false) &&
                acknowledged.at("possibleSourceReferences").is_array() &&
                !acknowledged.at("possibleSourceReferences").empty() &&
                !std::filesystem::exists(lexical_path) && read(room_path) == room_with_note,
            "Explicit lexical acknowledgement permits a non-destructive, revision-checked "
            "deletion while preserving unrelated source comments: " +
                acknowledged.dump().substr(0, 650));

    const std::string exit_room_id = "native-room-reference";
    require(command({{"action", "entity-create"},
                     {"projectRoot", root},
                     {"collection", "rooms"},
                     {"id", exit_room_id},
                     {"dryRun", false}})
                .value("ok", false),
            "Create Room to certify native semantic reference rewriting.");
    const auto child_path = fixture.root / "records/rooms/room-lifecycle-child.yaml";
    const auto child_original = read(child_path);
    const auto child_at = child_original.find("target: room-lifecycle-roundtrip");
    require(child_at != std::string::npos, "Existing Room exit has a canonical scalar reference.");
    auto child_modified = child_original;
    child_modified.replace(child_at, std::string("target: room-lifecycle-roundtrip").size(),
                           "target: " + exit_room_id);
    {
        std::ofstream out(child_path, std::ios::binary | std::ios::trunc);
        out << child_modified;
    }
    const auto exit_room_path = fixture.root / "records/rooms/native-room-reference.yaml";
    const Json referenced_delete{
        {"action", "entity-delete"},
        {"projectRoot", root},
        {"collection", "rooms"},
        {"id", exit_room_id},
        {"dryRun", true},
        {"force", true},
        {"allowPossibleSourceReferences", true},
        {"sourceRevision", noveltea::authoring::exact_source_revision(read(exit_room_path))}};
    require(command(referenced_delete).value("ok", false) && read(child_path) == child_modified &&
                std::filesystem::exists(exit_room_path),
            "Native forced deletion dry-run preserves the explicit CLI opt-out of graph repairs.");
    auto safe_delete = referenced_delete;
    safe_delete["force"] = false;
    require(!command(safe_delete).value("ok", false) && std::filesystem::exists(exit_room_path),
            "Unforced deletion must still reject a dangling required Room reference.");
    const auto renamed_reference = command(
        {{"action", "entity-rename"},
         {"projectRoot", root},
         {"collection", "rooms"},
         {"id", exit_room_id},
         {"toId", "native-room-renamed"},
         {"dryRun", false},
         {"sourceRevision", noveltea::authoring::exact_source_revision(read(exit_room_path))}});
    require(renamed_reference.value("ok", false) &&
                renamed_reference.at("rewrittenSources") ==
                    Json::array({"records/rooms/room-lifecycle-child.yaml"}) &&
                std::find(renamed_reference.at("writes").begin(),
                          renamed_reference.at("writes").end(),
                          "i18n/messages.yaml") != renamed_reference.at("writes").end() &&
                read(child_path).find("target: native-room-renamed") != std::string::npos &&
                !std::filesystem::exists(exit_room_path) &&
                std::filesystem::is_regular_file(fixture.root /
                                                 "records/rooms/native-room-renamed.yaml"),
            "Native rename atomically rewrites a canonical Room exit target and its owner: " +
                renamed_reference.dump().substr(0, 620));
    const auto identities_opened =
        noveltea::authoring::open_yaml_source(read(fixture.root / "i18n/messages.yaml"));
    require(identities_opened.accepted, "Renamed structured Message source remains valid YAML.");
    const auto identities_document = Json::parse(identities_opened.source_json);
    const auto& identity_map = identities_document.at("structuredMessageIds");
    for (const auto* leaf : {"displayName", "description"}) {
        const auto old_path = "/rooms/" + exit_room_id + "/data/" + leaf;
        const auto new_path = "/rooms/native-room-renamed/data/" + std::string(leaf);
        require(identity_map.contains(new_path) &&
                    identity_map.at(new_path) ==
                        noveltea::authoring::native_localization_structured_message_id(old_path) &&
                    !identity_map.contains(old_path),
                "Structured Message UUIDs are preserved across a semantic Room owner rename.");
    }

    const std::string material_id = "native-material-reference";
    require(command({{"action", "entity-create"},
                     {"projectRoot", root},
                     {"collection", "materials"},
                     {"id", material_id},
                     {"dryRun", false}})
                .value("ok", false),
            "Create Material for a Room material-application dependency.");
    const auto composition_path = fixture.root / "records/rooms/world-composition.yaml";
    const auto original_composition = read(composition_path);
    const auto original_material = original_composition.find("material: engine2d-draw-contract");
    require(original_material != std::string::npos, "Fixture has a Material application.");
    auto material_reference = original_composition;
    material_reference.replace(original_material,
                               std::string("material: engine2d-draw-contract").size(),
                               "material: " + material_id);
    {
        std::ofstream out(composition_path, std::ios::binary | std::ios::trunc);
        out << material_reference;
    }
    const auto material_path = fixture.root / "records/materials/native-material-reference.yaml";
    const auto rewritten_material = command(
        {{"action", "entity-rename"},
         {"projectRoot", root},
         {"collection", "materials"},
         {"id", material_id},
         {"toId", "native-material-renamed"},
         {"dryRun", false},
         {"sourceRevision", noveltea::authoring::exact_source_revision(read(material_path))}});
    require(rewritten_material.value("ok", false) &&
                rewritten_material.at("rewrittenSources") ==
                    Json::array({"records/rooms/world-composition.yaml"}) &&
                read(composition_path).find("material: native-material-renamed") !=
                    std::string::npos &&
                !std::filesystem::exists(material_path),
            "Native rename recognizes sparse Room Material application references: " +
                rewritten_material.dump().substr(0, 620));

    const auto unannotated = noveltea::authoring::edit_yaml_source(
        "data:\n  cast:\n    - id: first\n      character: a\n"
        "    - id: second\n      character: b\n  label: keep\n",
        {{"/data/cast/0", "", noveltea::authoring::YamlCommentDisposition::Keep, std::nullopt,
          noveltea::authoring::YamlEditOperation::Remove}});
    require(unannotated.accepted &&
                unannotated.source.find("    - id: first") == std::string::npos &&
                unannotated.source.find("    - id: second") != std::string::npos &&
                unannotated.source.find("  label: keep") != std::string::npos,
            "Native YAML sequence deletion removes one entire block item, preserving siblings.");
    const auto annotated = noveltea::authoring::edit_yaml_source(
        "data:\n  cast:\n    - id: protected # human context\n      character: a\n"
        "    - id: other\n      character: b\n",
        {{"/data/cast/0", "", noveltea::authoring::YamlCommentDisposition::Keep, std::nullopt,
          noveltea::authoring::YamlEditOperation::Remove}});
    require(!annotated.accepted,
            "Native YAML sequence deletion refuses to silently discard item annotations.");

    const auto original_character = read(fixture.root / "records/characters/pilot-guide.yaml");
    auto cloned_character = original_character;
    const auto original_id = cloned_character.find("id: pilot-guide\n");
    require(original_id == 0, "Character Fixture source starts with its canonical ID.");
    cloned_character.replace(0, std::string("id: pilot-guide").size(), "id: native-cast-target");
    const auto cloned_path = fixture.root / "records/characters/native-cast-target.yaml";
    {
        std::ofstream out(cloned_path, std::ios::binary | std::ios::trunc);
        out << cloned_character;
    }
    const auto cast_room_path = fixture.root / "records/rooms/runtime-workshop.yaml";
    auto cast_room = read(cast_room_path);
    const auto cast_at = cast_room.find("character: pilot-guide");
    require(cast_at != std::string::npos, "Room Fixture contains a canonical cast reference.");
    cast_room.replace(cast_at, std::string("character: pilot-guide").size(),
                      "character: native-cast-target");
    {
        std::ofstream out(cast_room_path, std::ios::binary | std::ios::trunc);
        out << cast_room;
    }
    const auto deleted_cast = command(
        {{"action", "entity-delete"},
         {"projectRoot", root},
         {"collection", "characters"},
         {"id", "native-cast-target"},
         {"dryRun", false},
         {"sourceRevision", noveltea::authoring::exact_source_revision(read(cloned_path))}});
    require(deleted_cast.value("ok", false) &&
                deleted_cast.at("plan").at("writes") ==
                    Json::array({"records/rooms/runtime-workshop.yaml"}) &&
                deleted_cast.at("plan").at("deletes") ==
                    Json::array({"records/characters/native-cast-target.yaml"}) &&
                read(cast_room_path).find("cast: []") != std::string::npos &&
                !std::filesystem::exists(cloned_path),
            "Native Character deletion atomically removes its cast item and source: " +
                deleted_cast.dump().substr(0, 600));
    require(command({{"action", "export-preparation"}, {"projectRoot", root}}).value("ok", false),
            "Native Character repair transaction leaves the complete Project valid.");
}
} // namespace

int main(int argc, char** argv)
{
    try {
        if (argc == 2 && std::string_view(argv[1]) == "--owner-session-smoke") {
            certify_owner_session_reuse();
            std::cout << "Native CLI owner session certification passed.\n";
            return 0;
        }
        if (argc == 3 && std::string_view(argv[1]) == "--invalid-manifest-cli") {
            certify_invalid_manifest_boundary(argv[2]);
            return 0;
        }
        if (argc == 3 && std::string_view(argv[1]) == "--owner-defaults") {
            certify_owner_default_stripping(argv[2]);
            return 0;
        }
        if (argc == 3 && std::string_view(argv[1]) == "--asset-import") {
            certify_asset_import(argv[2]);
            return 0;
        }
        // Test-only direct adapter seam for real two-root mutation comparison.
        // This is not linked into the installed production CLI command parser.
        if (argc == 3 && std::string_view(argv[1]) == "--request-file") {
            const auto result = command(Json::parse(read(argv[2])));
            std::cout << result.dump() << '\n';
            return result.value("ok", false) ? 0 : 1;
        }
        if (argc == 4 && std::string_view(argv[2]) == "--dump-localization-view") {
            const auto result = command(
                {{"action", "localization-view"}, {"projectRoot", argv[1]}, {"locale", argv[3]}});
            std::cout << result.dump() << '\n';
            return result.value("ok", false) ? 0 : 1;
        }
        require(argc == 2, "Expected one Project fixture root.");
        certify(argv[1]);
        std::cout << "Native CLI Project certification passed.\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
