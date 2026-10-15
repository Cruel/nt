#include "room_session.hpp"

#include <jsoncons/json.hpp>

#include <chrono>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <iterator>
#include <iterator>
#include <stdexcept>
#include <string>

namespace {
using noveltea::authoring::RoomPatch;
using noveltea::authoring::RoomSession;
using noveltea::authoring::YamlCommentDisposition;
using Json = jsoncons::ojson;

int failures = 0;
void require(bool okay, std::string_view message)
{
    if (!okay) {
        std::cerr << "FAIL: " << message << '\n';
        ++failures;
    }
}

std::string read(const std::filesystem::path& path)
{
    std::ifstream file(path, std::ios::binary);
    return {std::istreambuf_iterator<char>(file), std::istreambuf_iterator<char>()};
}

void write(const std::filesystem::path& path, std::string_view bytes)
{
    std::ofstream file(path, std::ios::binary | std::ios::trunc);
    file.write(bytes.data(), static_cast<std::streamsize>(bytes.size()));
    if (!file)
        throw std::runtime_error("Cannot write test Room.");
}

struct TempRoom {
    std::filesystem::path root;
    explicit TempRoom(const std::filesystem::path& fixture)
    {
        root = std::filesystem::temp_directory_path() /
               ("noveltea-room-session-" +
                std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
        std::filesystem::create_directories(root / "records" / "rooms");
        std::filesystem::copy_file(fixture, path());
    }
    ~TempRoom()
    {
        std::error_code ignored;
        std::filesystem::remove_all(root, ignored);
    }
    std::filesystem::path path() const
    {
        return root / "records" / "rooms" / "room-lifecycle-roundtrip.yaml";
    }
};
} // namespace

int main(int argc, char** argv)
{
    if (argc != 2 && !(argc == 3 && std::string_view(argv[1]) == "--roundtrip"))
        return 2;
    try {
        if (argc == 2 && std::string_view(argv[1]) == "--validate") {
            const std::string source{std::istreambuf_iterator<char>{std::cin},
                                     std::istreambuf_iterator<char>{}};
            const auto opened = noveltea::authoring::open_yaml_source(source);
            auto result = opened.accepted
                              ? noveltea::authoring::validate_room_source(opened.source_json)
                              : noveltea::authoring::ValidationResult{};
            Json output = Json::object();
            output.insert_or_assign("valid", result.accepted);
            if (result.accepted)
                output.insert_or_assign("nativeNormalized", Json::parse(result.effective_json));
            Json diagnostics = Json::array();
            for (const auto& diagnostic : result.diagnostics) {
                Json item = Json::object();
                item.insert_or_assign("path", diagnostic.path);
                item.insert_or_assign("code", diagnostic.code);
                diagnostics.push_back(std::move(item));
            }
            if (!opened.accepted) {
                Json item = Json::object();
                item.insert_or_assign("path", "");
                item.insert_or_assign("code", "source.yaml");
                diagnostics.push_back(std::move(item));
            }
            output.insert_or_assign("diagnostics", std::move(diagnostics));
            std::cout << output.to_string() << '\n';
            return 0;
        }
        if (argc == 3) {
            // Differential seam: TypeScript/Zod can compare normalized Room values
            // without granting the incomplete native semantic registry authority.
            TempRoom room(argv[2]);
            std::string error;
            auto session = RoomSession::open(room.root, "room-lifecycle-roundtrip", error);
            if (!session)
                throw std::runtime_error(error);
            auto before = read(room.path());
            auto before_revision = session->snapshot().disk_source_revision;
            auto changed = session->patch(
                0, {{RoomPatch::Operation::Replace, "/label", "\"Native Room session\""},
                    {RoomPatch::Operation::Add, "/data/presentationSpace/edgePolicy",
                     "\"overscan\""}});
            auto saved = session->save(changed.snapshot.disk_source_revision);
            if (!changed.accepted || !saved.accepted)
                throw std::runtime_error("Native Room round trip failed: " + saved.error);
            Json result = Json::object();
            result.insert_or_assign("beforeSource", before);
            result.insert_or_assign("beforeRevision", before_revision);
            result.insert_or_assign("savedSource", read(room.path()));
            result.insert_or_assign("savedRevision", saved.snapshot.disk_source_revision);
            result.insert_or_assign("workingValue", Json::parse(saved.snapshot.source_json));
            result.insert_or_assign("revision", saved.snapshot.working_revision);
            Json affected = Json::array();
            for (const auto& record : changed.affected_records)
                affected.push_back(record);
            result.insert_or_assign("affectedRecords", std::move(affected));
            result.insert_or_assign("nativeValid", saved.snapshot.valid);
            if (!saved.snapshot.normalized_json.empty())
                result.insert_or_assign("nativeNormalized",
                                        Json::parse(saved.snapshot.normalized_json));
            std::cout << result.to_string() << '\n';
            return 0;
        }
        const auto fixture =
            std::filesystem::path(argv[1]) / "records" / "rooms" / "room-lifecycle-roundtrip.yaml";
        TempRoom temp(fixture);
        // Preserve a real Room fixture's nested data while adding physical notes.
        auto original = read(temp.path());
        original = "# Owner notes\n" + original;
        const std::string label_line = "label: Lifecycle Round Trip\n";
        const auto label_at = original.find(label_line);
        if (label_at == std::string::npos)
            throw std::runtime_error("Room fixture label not found.");
        original.replace(label_at, label_line.size(),
                         "label: Lifecycle Round Trip # annotate label\n");
        write(temp.path(), original);
        std::string error;
        auto session = RoomSession::open(temp.root, "room-lifecycle-roundtrip", error);
        require(session != nullptr, "open a real canonical Room from disk");
        if (!session)
            throw std::runtime_error(error);
        const auto initial = session->snapshot();
        require(initial.working_revision == 0 && !initial.dirty && !initial.source_json.empty(),
                "separate clean working generation and explicit source value");
        require(!initial.disk_source_revision.empty(), "disk baseline has revision identity");
        require(read(temp.path()) == original, "open and validate never modify source bytes");
        require(initial.valid && initial.diagnostics.empty() && !initial.normalized_json.empty() &&
                    Json::parse(initial.normalized_json).at("data").at("kind") == "room",
                "valid Room source expands into a native effective Room");

        const auto invalid_batch =
            session->patch(0, {{RoomPatch::Operation::Replace, "/label", "\"Broken\""},
                               {RoomPatch::Operation::Remove, "/data/doesNotExist", ""}});
        require(!invalid_batch.accepted && session->snapshot().working_revision == 0 &&
                    session->snapshot().source_json == initial.source_json,
                "invalid second operation rolls back the complete JSON Patch batch");
        require(!session->patch(0, {{RoomPatch::Operation::Add, "/data/~9bad", "1"}}).accepted,
                "malformed JSON Pointer rejected without a revision");
        require(!session->patch(0, {{RoomPatch::Operation::Replace, "/label", "{"}}).accepted,
                "malformed JSON literal rejected without a revision");

        auto edit = session->patch(
            0, {{RoomPatch::Operation::Replace, "/label", "\"Native Room session\""},
                {RoomPatch::Operation::Add, "/data/presentationSpace/edgePolicy", "\"overscan\""}});
        require(edit.accepted && edit.snapshot.working_revision == 1 && edit.snapshot.dirty &&
                    edit.affected_records.size() == 1 &&
                    edit.affected_records[0] == "rooms/room-lifecycle-roundtrip",
                "atomic revisioned multi-field delta affects only the edited Room");
        require(read(temp.path()) == original, "dirty working values do not touch disk");
        require(
            !session->patch(0, {{RoomPatch::Operation::Replace, "/label", "\"stale\""}}).accepted,
            "stale working revision rejected");

        const auto bad_policy =
            session->patch(1, {{RoomPatch::Operation::Replace, "/data/presentationSpace/edgePolicy",
                                "\"unsupported\""}});
        bool reported_policy = false;
        for (const auto& diagnostic : bad_policy.diagnostics_added)
            reported_policy |= diagnostic.path == "/data/presentationSpace/edgePolicy";
        require(bad_policy.accepted && !bad_policy.snapshot.valid && reported_policy &&
                    read(temp.path()) == original,
                "invalid Room presentation policy produces a field-level dirty diagnostic");
        const auto fixed_policy =
            session->patch(2, {{RoomPatch::Operation::Replace, "/data/presentationSpace/edgePolicy",
                                "\"overscan\""}});
        require(fixed_policy.accepted && fixed_policy.snapshot.valid &&
                    !fixed_policy.diagnostics_removed.empty(),
                "repair removes policy diagnostics and restores native normalized values");

        const auto invalid_semantic =
            session->patch(3, {{RoomPatch::Operation::Replace, "/id", "\"different-room\""}});
        bool has_mismatch = false;
        for (const auto& diagnostic : invalid_semantic.diagnostics_added)
            has_mismatch |= diagnostic.path == "/id" && diagnostic.code == "room.id_mismatch";
        require(invalid_semantic.accepted && has_mismatch && read(temp.path()) == original,
                "representable semantic error yields a dirty diagnostic without forced Save");
        const auto blocked_save = session->save(initial.disk_source_revision);
        require(!blocked_save.accepted && blocked_save.snapshot.dirty &&
                    read(temp.path()) == original &&
                    blocked_save.snapshot.disk_source_revision == initial.disk_source_revision,
                "filename/Room ID mismatch blocks Save while preserving dirty working state");
        auto repaired = session->patch(
            4, {{RoomPatch::Operation::Replace, "/id", "\"room-lifecycle-roundtrip\""}});
        require(repaired.accepted && repaired.diagnostics_removed.size() == 1 &&
                    repaired.diagnostics_removed[0].code == "room.id_mismatch",
                "invalid working Room can be repaired and emits a diagnostic removal delta");

        const auto save = session->save(initial.disk_source_revision);
        require(save.accepted && save.snapshot.valid && !save.snapshot.dirty &&
                    save.snapshot.working_revision == 5 &&
                    save.snapshot.disk_source_revision != initial.disk_source_revision,
                "explicit scoped Save updates disk baseline, not working revision");
        const auto after_save = read(temp.path());
        require(after_save.find("Native Room session") != std::string::npos &&
                    after_save.find("# annotate label") != std::string::npos &&
                    after_save.find("edgePolicy:") != std::string::npos &&
                    after_save.starts_with("# Owner notes\n"),
                "source-aware save writes both Room modifications");
        require(after_save.find("    - id: guide") != std::string::npos &&
                    after_save.find("    - id: child-flow") != std::string::npos,
                "unrelated nested source structure is retained");
        auto reopened = RoomSession::open(temp.root, "room-lifecycle-roundtrip", error);
        require(reopened && reopened->snapshot().valid &&
                    Json::parse(reopened->snapshot().source_json) ==
                        Json::parse(save.snapshot.source_json) &&
                    Json::parse(reopened->snapshot().normalized_json) ==
                        Json::parse(save.snapshot.normalized_json),
                "reopening saved YAML yields identical source and normalized Room values");

        const auto remove = session->patch(
            5, {{RoomPatch::Operation::Remove, "/data/presentationSpace/edgePolicy", ""}});
        require(remove.accepted && remove.snapshot.dirty, "generic JSON Pointer remove works");
        const auto removed = session->save(save.snapshot.disk_source_revision);
        require(removed.accepted && read(temp.path()).find("edgePolicy:") == std::string::npos,
                "physical YAML mapping removal round trips");

        auto undid = RoomSession::open(temp.root, "room-lifecycle-roundtrip", error);
        const auto adding = undid->patch(
            0, {{RoomPatch::Operation::Add, "/data/presentationSpace/edgePolicy", "\"overscan\""}});
        const auto undo = undid->patch(
            1, {{RoomPatch::Operation::Remove, "/data/presentationSpace/edgePolicy", ""}});
        require(adding.accepted && undo.accepted && !undo.snapshot.dirty &&
                    undo.snapshot.working_revision == 2 &&
                    read(temp.path()).find("edgePolicy:") == std::string::npos,
                "undoing all dirty changes restores a clean working Project without Save");

        const auto race =
            session->patch(6, {{RoomPatch::Operation::Replace, "/label", "\"Unsaved local\""}});
        write(temp.path(), read(temp.path()) + "# changed externally\n");
        const auto external = read(temp.path());
        const auto conflict = session->save(race.snapshot.disk_source_revision);
        require(!conflict.accepted && read(temp.path()) == external && conflict.snapshot.dirty,
                "external source revision mismatch never overwrites disk or dirty work");
        require(!session->save("stale-revision").accepted,
                "caller-supplied stale baseline is rejected before saving");

        auto dangerous = RoomSession::open(temp.root, "../room-lifecycle-roundtrip", error);
        require(!dangerous, "Room path traversal cannot escape Project Workspace");
        std::cout << "Native Room session: " << (failures ? "FAILED" : "PASS") << '\n';
    } catch (const std::exception& e) {
        std::cerr << "Room session certification exception: " << e.what() << '\n';
        return 1;
    }
    return failures ? 1 : 0;
}
