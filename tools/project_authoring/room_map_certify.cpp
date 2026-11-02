#include "contracts.hpp"
#include "room_session.hpp"
#include "room_map_semantics_internal.hpp"
#include "yaml_codec.hpp"

#include <jsoncons/json.hpp>

#include <algorithm>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <iterator>
#include <map>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace {
using Json = jsoncons::ojson;
using noveltea::authoring::RoomPatch;
using noveltea::authoring::RoomSession;
using noveltea::authoring::ValidationResult;

std::string input()
{
    return {std::istreambuf_iterator<char>(std::cin), std::istreambuf_iterator<char>()};
}

void require(bool value, std::string_view message)
{
    if (!value)
        throw std::runtime_error(std::string(message));
}

Json output(const ValidationResult& result)
{
    Json value = Json::object();
    value["valid"] = result.accepted;
    if (!result.effective_json.empty())
        value["nativeNormalized"] = Json::parse(result.effective_json);
    value["diagnostics"] = Json::array();
    for (const auto& diagnostic : result.diagnostics) {
        Json entry = Json::object();
        entry["path"] = diagnostic.path;
        entry["code"] = diagnostic.code;
        entry["severity"] = diagnostic.severity;
        entry["message"] = diagnostic.message;
        value["diagnostics"].push_back(std::move(entry));
    }
    return value;
}

struct TemporaryMap {
    std::filesystem::path root;
    explicit TemporaryMap(std::string_view yaml)
    {
        root = std::filesystem::temp_directory_path() /
               ("noveltea-native-map-" +
                std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
        std::filesystem::create_directories(root / "records" / "maps");
        std::ofstream file(path(), std::ios::binary);
        file << yaml;
        require(static_cast<bool>(file), "cannot create Map YAML fixture");
    }
    ~TemporaryMap()
    {
        std::error_code ignored;
        std::filesystem::remove_all(root, ignored);
    }
    std::filesystem::path path() const { return root / "records" / "maps" / "world.yaml"; }
    std::string read() const
    {
        std::ifstream file(path(), std::ios::binary);
        return {std::istreambuf_iterator<char>(file), std::istreambuf_iterator<char>()};
    }
};
} // namespace

int main(int argc, char** argv)
{
    if (argc != 2)
        return 2;
    try {
        const std::string mode = argv[1];
        if (mode == "--project") {
            std::cout << output(noveltea::authoring::validate_room_map_project(input())).to_string()
                      << '\n';
            return 0;
        }
        if (mode == "--room" || mode == "--map") {
            const auto opened = noveltea::authoring::open_yaml_source(input());
            if (!opened.accepted)
                throw std::runtime_error(opened.error);
            const auto result = mode == "--room"
                                    ? noveltea::authoring::validate_room_source(opened.source_json)
                                    : noveltea::authoring::validate_map_source(opened.source_json);
            std::cout << output(result).to_string() << '\n';
            return 0;
        }
        if (mode == "--map-roundtrip" || mode == "--self-test") {
            if (mode == "--self-test") {
                Json project = Json::parse(
                    R"({"rooms":{"entry":{"data":{"presentationSpace":{"size":{"width":800,"height":600}},"exits":[{"id":"east","direction":"east","target":{"$ref":{"id":"destination"}}}]}},"destination":{"data":{"presentationSpace":{"size":{"width":800,"height":600}},"exits":[{"id":"west","direction":"west","target":{"$ref":{"id":"entry"}}}]} }},"maps":{"world":{"data":{"locations":[{"id":"entry","room":{"$ref":{"id":"entry"}}},{"id":"destination","room":{"$ref":{"id":"destination"}}}],"connections":[{"id":"link","exits":[{"room":"entry","exit":"east"},{"room":"destination","exit":"west"}]}]}}}})");
                std::map<std::string, std::string> records;
                for (const auto& family : {"rooms", "maps"})
                    for (const auto& entry : project.at(family).object_range())
                        records.emplace(std::string(family) + "/" + std::string(entry.key()),
                                        entry.value().to_string());
                const auto lookup = [&](std::string_view owner) -> std::string_view {
                    const auto found = records.find(std::string(owner));
                    return found == records.end() ? std::string_view{} : found->second;
                };
                const auto all = noveltea::authoring::validate_normalized_room_map_project(project);
                std::vector<noveltea::authoring::Diagnostic> owners;
                for (const auto& family : {"rooms", "maps"})
                    for (const auto& entry : project.at(family).object_range()) {
                        const auto owner = std::string(family) + "/" + std::string(entry.key());
                        const auto result = noveltea::authoring::validate_normalized_room_map_owner(
                            owner, records.at(owner), Json::object(), lookup);
                        owners.insert(owners.end(), result.diagnostics.begin(),
                                      result.diagnostics.end());
                    }
                require(owners.size() == all.diagnostics.size(),
                        "spatial owner diagnostic count mismatch");
                for (std::size_t i = 0; i < owners.size(); ++i)
                    require(owners[i].path == all.diagnostics[i].path &&
                                owners[i].code == all.diagnostics[i].code &&
                                owners[i].message == all.diagnostics[i].message &&
                                owners[i].severity == all.diagnostics[i].severity,
                            "spatial per-owner diagnostic differs from full Project");
                records.erase("rooms/destination");
                const auto missing = noveltea::authoring::validate_normalized_room_map_owner(
                    "rooms/entry", records.at("rooms/entry"), Json::object(), lookup);
                require(std::any_of(missing.diagnostics.begin(), missing.diagnostics.end(),
                                    [](const auto& diagnostic) {
                                        return diagnostic.code == "reference.missing";
                                    }),
                        "deleted Room must revalidate dependent Exit");
                const auto map_missing = noveltea::authoring::validate_normalized_room_map_owner(
                    "maps/world", records.at("maps/world"), Json::object(), lookup);
                require(std::any_of(map_missing.diagnostics.begin(), map_missing.diagnostics.end(),
                                    [](const auto& diagnostic) {
                                        return diagnostic.code == "map.connection.room-missing";
                                    }),
                        "deleted Room must revalidate dependent Map Connection");
            }
            const auto source = mode == "--self-test"
                                    ? std::string("# map owner\nid: world\nlabel: World\n"
                                                  "data:\n  locations:\n    - id: foyer\n"
                                                  "      room: foyer\n    - id: hall\n"
                                                  "      room: hall\n  connections: []\n")
                                    : input();
            TemporaryMap temp(source);
            std::string error;
            auto session = RoomSession::open_map(temp.root, "world", error);
            require(session != nullptr, error);
            const auto initial = session->snapshot();
            require(initial.valid, "Map initial source not valid");
            const auto invalid = session->patch(
                0, {{RoomPatch::Operation::Replace, "/data/locations/@foyer/room", "\"hall\""}});
            require(invalid.accepted && !invalid.snapshot.valid &&
                        !invalid.diagnostics_added.empty() &&
                        invalid.diagnostics_added.front().path == "/data/locations/1/room/$ref",
                    "Map duplicate location must report exact nested diagnostic");
            const auto blocked = session->save(initial.disk_source_revision);
            require(!blocked.accepted && temp.read() == source,
                    "Invalid working Map must not be persisted");
            const auto repaired = session->patch(
                1, {{RoomPatch::Operation::Replace, "/data/locations/@foyer/room", "\"foyer\""}});
            require(repaired.accepted && repaired.snapshot.valid &&
                        !repaired.diagnostics_removed.empty(),
                    "Map repair must clear semantic diagnostics");
            const auto missing = session->patch(
                2, {{RoomPatch::Operation::Replace, "/data/locations/@missing/room", "\"foyer\""}});
            require(!missing.accepted && session->snapshot().working_revision == 2,
                    "Missing ID-keyed target must reject atomic patch");
            auto edit = session->patch(
                2, {{RoomPatch::Operation::Add, "/data/locations/@foyer/pickOrder", "7"},
                    {RoomPatch::Operation::Replace, "/label", "\"New Map\""}});
            require(edit.accepted && edit.snapshot.valid, "ID-keyed Map patch rejected");
            require(edit.affected_records.size() == 1 && edit.affected_records[0] == "maps/world",
                    "Map delta must attribute its Map owner");
            require(temp.read() == source, "Patch must not write disk");
            auto saved = session->save(initial.disk_source_revision);
            require(saved.accepted && saved.snapshot.valid && !saved.snapshot.dirty,
                    "Map save failed: " + saved.error);
            auto reopened = RoomSession::open_map(temp.root, "world", error);
            require(reopened && reopened->snapshot().valid &&
                        Json::parse(reopened->snapshot().normalized_json) ==
                            Json::parse(saved.snapshot.normalized_json),
                    "Map must reopen with exact normalized values");
            if (source.starts_with('#'))
                require(temp.read().starts_with(source.substr(0, source.find('\n') + 1)),
                        "Map roundtrip must preserve owner comments");
            Json response = Json::object();
            response["savedSource"] = temp.read();
            response["nativeNormalized"] = Json::parse(saved.snapshot.normalized_json);
            response["workingValue"] = Json::parse(saved.snapshot.source_json);
            response["affectedRecords"] = Json::array();
            for (const auto& affected : edit.affected_records)
                response["affectedRecords"].push_back(affected);
            std::cout << response.to_string() << '\n';
            return 0;
        }
        return 2;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
