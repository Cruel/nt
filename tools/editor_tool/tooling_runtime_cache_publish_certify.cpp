#include "tooling_native_c.h"
#include "native_authoring_resources.hpp"
#include "native_compiled_project_save_contract.hpp"
#include <nlohmann/json.hpp>
#include <algorithm>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <set>
#include <stdexcept>
#include <string>
#include <vector>
namespace {
using Json = nlohmann::json;
void require(bool ok, const char* message)
{
    if (!ok)
        throw std::runtime_error(message);
}
void write(const std::filesystem::path& path, std::string_view data)
{
    std::filesystem::create_directories(path.parent_path());
    std::ofstream stream(path, std::ios::binary | std::ios::trunc);
    stream.write(data.data(), static_cast<std::streamsize>(data.size()));
    require(static_cast<bool>(stream), "Could not write fixture file.");
}
std::string read(const std::filesystem::path& path)
{
    std::ifstream stream(path, std::ios::binary);
    return {std::istreambuf_iterator<char>(stream), std::istreambuf_iterator<char>()};
}
Json invoke(std::uint64_t (*operation)(const std::uint8_t*, std::uint64_t, std::uint8_t*,
                                       std::uint64_t),
            const Json& value)
{
    const auto input = value.dump();
    std::vector<std::uint8_t> output(32 * 1024 * 1024);
    const auto count = operation(reinterpret_cast<const std::uint8_t*>(input.data()), input.size(),
                                 output.data(), output.size());
    require(count < output.size(), "Runtime cache C ABI response is too large.");
    return Json::parse(output.begin(), output.begin() + static_cast<std::ptrdiff_t>(count));
}
} // namespace
int main(int argc, char** argv)
{
    try {
        if (argc == 2 && std::string_view(argv[1]) == "--hash-compiled-stdin") {
            const std::string input{std::istreambuf_iterator<char>(std::cin),
                                    std::istreambuf_iterator<char>()};
            const auto project = Json::parse(input);
            std::cout << Json{{"saveContract",
                               noveltea::cli::compiled_project_save_contract(project)}}
                             .dump()
                      << '\n';
            return 0;
        }
        if (argc == 3 && std::string_view(argv[2]) == "--create-small") {
            const auto root = std::filesystem::absolute(argv[1]).string();
            const auto create = invoke(noveltea_tooling_native_project_commands_json,
                                       Json{{"action", "project-create"},
                                            {"projectRoot", root},
                                            {"name", "Small Parity"}});
            require(create.value("ok", false), "Could not create native Project fixture.");
            for (const auto& [collection, id] :
                 {std::pair{"rooms", "starting-room"}, std::pair{"variables", "zeta"},
                  std::pair{"variables", "alpha"}}) {
                const auto added = invoke(noveltea_tooling_native_project_commands_json,
                                          Json{{"action", "entity-create"},
                                               {"projectRoot", root},
                                               {"collection", collection},
                                               {"id", id},
                                               {"dryRun", false}});
                require(added.value("ok", false), "Could not add native Project fixture record.");
            }
            std::cout << Json{{"created", true}}.dump() << '\n';
            return 0;
        }
        if (argc == 3 && std::string_view(argv[2]) == "--emit-parity") {
            const auto fixture = std::filesystem::absolute(argv[1]);
            const auto prepared =
                invoke(noveltea_tooling_native_project_commands_json,
                       Json{{"action", "shader-preparation"}, {"projectRoot", fixture.string()}});
            if (!prepared.value("ok", false)) {
                Json diagnostics = prepared.value("projectDiagnostics", Json::array());
                if (diagnostics.empty())
                    diagnostics.push_back(
                        {{"code", "native.project.admission"},
                         {"severity", "error"},
                         {"path", "/"},
                         {"message", prepared.value("error", "Admission failed")}});
                std::cout << Json{{"ok", false}, {"diagnostics", std::move(diagnostics)}}.dump()
                          << '\n';
                return 0;
            }
            try {
                const auto& project = prepared.at("project");
                const auto resources = noveltea::cli::lower_static_authoring_resources(project);
                Json identity = noveltea::cli::lower_static_authoring_identity(project);
                identity["resources"] = resources;
                // Deliberately distinguish compiler omissions from supported-family
                // agreement: this is not a publishable Compiled Project.
                static const Json unsupported = Json::array(
                    {"definitions", "resources.layouts", "resources.materialInterfaces",
                     "localization", "traits", "archetypes", "inventories", "interactableInstances",
                     "properties.message", "flowPrediction", "saveContract-production"});
                std::cout << Json{{"ok", true},
                                  {"project", project},
                                  {"sourceGeneration", prepared.at("sourceGeneration")},
                                  {"sourceRevisions", prepared.at("sourceRevisions")},
                                  {"referencedAssetIds", prepared.at("referencedAssetIds")},
                                  {"cliDiagnostics",
                                   prepared.value("cliDiagnostics", Json::array())},
                                  {"loweringDiagnostics", Json::array()},
                                  {"native", std::move(identity)},
                                  {"unsupportedFamilies", unsupported}}
                                 .dump()
                          << '\n';
            } catch (const std::exception& error) {
                const bool missing_entrypoint =
                    (!prepared.at("project").contains("entrypoint") ||
                     prepared.at("project").at("entrypoint").is_null()) &&
                    std::string_view(error.what()) == "Native Project entrypoint kind is invalid.";
                std::cout
                    << Json{{"ok", false},
                            {"project", prepared.at("project")},
                            {"diagnostics",
                             Json::array(
                                 {{{"code", missing_entrypoint ? "COMPILER_ENTRYPOINT_REQUIRED"
                                                               : "native.lowering"},
                                   {"severity", "error"},
                                   {"path", missing_entrypoint ? "/entrypoint" : "/compiler"},
                                   {"message", missing_entrypoint
                                                   ? "A Room, Scene, or Dialogue entrypoint is "
                                                     "required for compiled gameplay."
                                                   : error.what()}}})}}
                           .dump()
                    << '\n';
            }
            return 0;
        }
        if (argc == 3 && std::string_view(argv[2]) == "--emit-normalized-project") {
            const auto prepared =
                invoke(noveltea_tooling_native_project_commands_json,
                       Json{{"action", "shader-preparation"},
                            {"projectRoot", std::filesystem::absolute(argv[1]).string()}});
            require(prepared.value("ok", false), "Native Project admission failed.");
            std::cout << prepared.at("project").dump() << '\n';
            return 0;
        }
        if (argc == 3 && std::string_view(argv[2]) == "--certify-resources") {
            const auto fixture = std::filesystem::absolute(argv[1]);
            const auto source =
                invoke(noveltea_tooling_native_project_commands_json,
                       Json{{"action", "shader-preparation"}, {"projectRoot", fixture.string()}});
            require(source.value("ok", false), "Native Project admission failed.");
            const auto partial =
                noveltea::cli::lower_static_authoring_resources(source.at("project"));
            const auto cache = fixture / ".noveltea/cache/runtime";
            const auto generation = read(cache / "current");
            const auto original =
                cache / "generations" / generation.substr(0, generation.find_first_of("\r\n"));
            const auto artifact = Json::parse(read(original / "artifact.json"));
            const auto& expected = artifact.at("compiledProject").at("resources");
            const auto identity =
                noveltea::cli::lower_static_authoring_identity(source.at("project"));
            for (const auto* key : {"project", "bootstrapModule", "entrypoint"})
                require(identity.at(key) == artifact.at("compiledProject").at(key),
                        "Native compiled Project identity differs from Feature Lab.");
            Json actual_globals = Json::array();
            for (const auto& property : artifact.at("compiledProject").at("properties"))
                if (property.value("scope", "") == "global" &&
                    property.value("type", "") != "message")
                    actual_globals.push_back(property);
            require(identity.at("globalProperties") == actual_globals,
                    "Native global Variable projection differs from Feature Lab.");
            require(identity.at("unresolvedMessageVariables") == Json::array({"story-message"}),
                    "Localized Message Variables must remain unlowered until Message ID parity.");
            require(partial.at("scripts") == expected.at("scripts"),
                    "Native Script resources differ from compiled Feature Lab.");
            require(partial.at("animations") == expected.at("animations"),
                    "Native Animation resources differ from compiled Feature Lab.");
            const auto& native_assets = partial.at("assets");
            for (const auto& asset : expected.at("assets")) {
                auto found =
                    std::find_if(native_assets.begin(), native_assets.end(),
                                 [&](const Json& item) { return item.at("id") == asset.at("id"); });
                require(found != native_assets.end(),
                        "Compiled runtime Asset is absent from native lowering.");
                for (const auto* key : {"kind", "path", "aliases"}) {
                    require(found->at(key) == asset.at(key),
                            "Native Asset source identity differs from compiled Feature Lab.");
                }
                if (asset.value("kind", "") == "image") {
                    for (const auto* key : {"sampling", "width", "height"})
                        require(found->at(key) == asset.at(key),
                                "Native image metadata differs from compiled Feature Lab.");
                }
            }
            std::cout << "Native Feature Lab Asset, Animation, Script lowering PASSED\n";
            return 0;
        }
        require(argc == 2, "Usage: runtime-cache-publish-certify <fixture-directory>");
        const auto fixture = std::filesystem::path(argv[1]);
        const auto root =
            std::filesystem::temp_directory_path() /
            ("noveltea-native-cache-publish-" +
             std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
        struct Cleanup {
            std::filesystem::path path;
            ~Cleanup()
            {
                std::error_code ignored;
                std::filesystem::remove_all(path, ignored);
            }
        } cleanup{root};
        write(root / "project.yaml", "schemaVersion: 1\n");
        write(root / "records/scenes/example.yaml", "id: example\n");
        write(root / "records/tests/example.yaml", "id: example\n");
        const auto cache = fixture / ".noveltea/cache/runtime";
        if (!std::filesystem::is_regular_file(cache / "current")) {
            std::cout << "SKIP: no Feature Lab compiled-runtime fixture.\n";
            return 77;
        }
        const auto generation = read(cache / "current");
        const auto name = generation.substr(0, generation.find_first_of("\r\n"));
        const auto original = cache / "generations" / name;
        Json artifact = Json::parse(read(original / "artifact.json"));
        Json catalog = Json::parse(read(original / "tests.json"));
        const auto rebase_path = [&](const std::string& original_path) {
            const auto physical = std::filesystem::path(original_path);
            const auto relative = std::filesystem::relative(physical, fixture);
            require(!relative.empty() && !relative.is_absolute() &&
                        !relative.string().starts_with(".."),
                    "Fixture physical file must belong to fixture Project.");
            const auto destination = root / relative;
            if (std::filesystem::is_regular_file(physical)) {
                std::filesystem::create_directories(destination.parent_path());
                std::filesystem::copy_file(physical, destination,
                                           std::filesystem::copy_options::overwrite_existing);
            }
            return destination.string();
        };
        const auto rebase_entries = [&](Json& entries) {
            for (auto& entry : entries)
                entry["source"] = rebase_path(entry.at("source").get<std::string>());
        };
        rebase_entries(artifact["fileEntries"]);
        auto& package_options = artifact["packageOptions"];
        rebase_entries(package_options["fileEntries"]);
        if (package_options.contains("shaderAssetRoot"))
            package_options["shaderAssetRoot"] =
                rebase_path(package_options["shaderAssetRoot"].get<std::string>());
        for (auto& entry : package_options.value("assetRoots", Json::array()))
            entry["root"] = rebase_path(entry.at("root").get<std::string>());
        std::set<std::string> runtime_path_names{"project.yaml"};
        for (const auto* name : {"records", "scripts", "i18n"}) {
            const auto folder = root / name;
            if (!std::filesystem::is_directory(folder))
                continue;
            for (const auto& file : std::filesystem::recursive_directory_iterator(folder)) {
                if (!file.is_regular_file())
                    continue;
                const auto path = std::filesystem::relative(file.path(), root).generic_string();
                if (path.starts_with("records/tests/"))
                    continue;
                const auto extension = file.path().extension();
                if ((std::string_view(name) == "records" &&
                     (extension == ".yaml" || extension == ".json" || extension == ".lua" ||
                      extension == ".rml" || extension == ".rcss")) ||
                    (std::string_view(name) == "scripts" && extension == ".lua") ||
                    (std::string_view(name) == "i18n" &&
                     (extension == ".yaml" || extension == ".json")))
                    runtime_path_names.insert(path);
            }
        }
        // Runtime packaging may legitimately filter assets after the Save
        // Contract was attached to the original unpartitioned compiler draft.
        // Test the compiler-owned projection against an independently
        // calculated UTF-16/FNV reference rather than recomputing the packaged
        // artifact's retained pre-export Save Contract.
        Json empty_compiled{{"bootstrapModule", {{"kind", "script"}, {"id", "main"}}},
                            {"archetypes", Json::array()},
                            {"definitions",
                             {{"characters", Json::array()},
                              {"dialogues", Json::array()},
                              {"interactables", Json::array()},
                              {"interactions", Json::array()},
                              {"maps", Json::array()},
                              {"rooms", Json::array()},
                              {"scenes", Json::array()},
                              {"verbs", Json::array()}}},
                            {"inventories", Json::array()},
                            {"interactableInstances", Json::array()},
                            {"properties", Json::array()},
                            {"resources",
                             {{"assets", Json::array()},
                              {"animations", Json::array()},
                              {"layouts", Json::array()},
                              {"materialInterfaces", Json::array()},
                              {"scripts", Json::array()}}},
                            {"traits", Json::array()}};
        require(noveltea::cli::compiled_project_save_contract(empty_compiled) ==
                    "sc1:6d78b64fe43492cdb2bbc17fe4782241",
                "Native Save Contract must match independently computed canonical hash.");
        const auto retained =
            noveltea::cli::compiled_project_save_contract(artifact.at("compiledProject"));
        auto changed_presentation = artifact.at("compiledProject");
        changed_presentation["project"]["name"] = "Modified packaging title";
        changed_presentation["localization"] = Json::object();
        require(noveltea::cli::compiled_project_save_contract(changed_presentation) == retained,
                "Nonpersistent presentation metadata must not change Save Contract.");
        Json request{{"projectRoot", root.string()},
                     {"compilerIdentity", "1.0.0:test-native-cache-publisher"},
                     {"artifact", artifact},
                     {"catalog", catalog},
                     {"runtimeInputPaths", runtime_path_names},
                     {"testInputPaths", Json::array({"records/tests/example.yaml"})},
                     {"authoringDiagnostics", Json::array()}};
        const auto publish = [&](const Json& input) {
            return invoke(noveltea_tooling_publish_runtime_cache_json, input);
        };
        const auto probe = [&]() {
            return invoke(noveltea_tooling_probe_runtime_cache_json,
                          Json{{"projectRoot", root.string()},
                               {"compilerIdentity", request.at("compilerIdentity")}});
        };
        require(probe().at("status") == "miss", "Clean fixture must miss cache.");
        auto invalid = request;
        invalid["artifact"]["compiledProject"]["project"] = Json::object();
        require(publish(invalid).at("published") == false, "Mismatched gameplay must fail.");
        invalid = request;
        invalid["runtimeInputPaths"] = Json::array({"project.yaml", "../escape"});
        require(publish(invalid).at("published") == false, "Escaping input must fail.");
        invalid = request;
        invalid["runtimeInputPaths"] = Json::array({"project.yaml"});
        require(publish(invalid).at("published") == false, "Missing discovered source must fail.");
        require(probe().at("status") == "miss", "Failed publication must not install pointer.");
        const auto first_publish = publish(request);
        if (!first_publish.value("published", false))
            std::cerr << "Publisher response: " << first_publish.dump() << '\n';
        require(first_publish.at("published") == true, "Native cache publication must succeed.");
        const auto hit = probe();
        require(hit.at("status") == "hit" && hit.at("testCatalogStatus") == "hit",
                "Native reader must accept native-produced generation.");
        require(hit.at("artifact") == artifact && hit.at("catalog") == catalog,
                "Published data must match compiler-provided content.");
        const auto pointer = root / ".noveltea/cache/runtime/current";
        const auto old_pointer = read(pointer);
        write(root / "records/scenes/another.yaml", "id: another\n");
        require(publish(request).at("published") == false, "New source should block publication.");
        require(read(pointer) == old_pointer, "Failure must preserve existing pointer.");
        require(probe().at("status") == "stale", "New source must invalidate runtime.");
        std::filesystem::remove(root / "records/scenes/another.yaml");
        require(publish(request).at("published") == true, "Fresh generation should publish.");
        require(read(pointer) != old_pointer, "Republish must update generation pointer.");
        std::filesystem::remove(pointer);
        try {
            std::filesystem::create_symlink(root / "project.yaml", pointer);
        } catch (const std::filesystem::filesystem_error&) {
#if !defined(_WIN32)
            throw;
#endif
            // Windows CI may lack permission to create symlinks.
        }
        if (std::filesystem::is_symlink(std::filesystem::symlink_status(pointer))) {
            require(publish(request).at("published") == false, "Symlink pointer must be refused.");
            require(read(root / "project.yaml") == "schemaVersion: 1\n",
                    "Pointer must not overwrite symlink target.");
        }
        std::cout << "Native runtime-cache publication, drift, and rejection PASSED\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "Native runtime-cache publication FAILED: " << error.what() << '\n';
        return 1;
    }
}
