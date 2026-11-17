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

        // A replacement of a normalized nested collection must never turn
        // implicit YAML defaults into authored fields on its other members.
        {
            const auto inventory_path =
                temp.root / "records" / "rooms" / "inventory-workbench.yaml";
            auto bytes =
                read(std::filesystem::path(argv[1]) / "records/rooms/inventory-workbench.yaml");
            const auto first = bytes.find("    - id: identity-control\n");
            require(first != std::string::npos, "Sparse Interactable fixture has a first item");
            if (first != std::string::npos)
                bytes.insert(first + std::string_view("    - id: identity-control\n").size(),
                             "      visible: true # deliberately explicit\n");
            write(inventory_path, bytes);
            auto inventory = RoomSession::open(temp.root, "inventory-workbench", error);
            require(inventory && inventory->snapshot().valid,
                    "Sparse Interactable Room admits with one explicit default");
            if (!inventory)
                throw std::runtime_error(error);
            const auto opened = inventory->snapshot();
            const auto effective = Json::parse(opened.normalized_json);
            const auto original_items = effective.at("data").at("interactables");
            const auto baseline = Json::parse(opened.source_json);
            require(!baseline.at("data").at("interactables").at(1).contains("visible") &&
                        baseline.at("data").at("interactables").at(0).contains("visible"),
                    "Test Room distinguishes omitted and explicitly authored defaults");
            const auto no_op =
                inventory->patch(0, {{RoomPatch::Operation::Replace, "/data/interactables",
                                      original_items.to_string()}});
            require(no_op.accepted && no_op.snapshot.working_revision == 0 &&
                        !no_op.snapshot.dirty && no_op.snapshot.source_json == opened.source_json &&
                        read(inventory_path) == bytes,
                    "Replacing a normalized collection without changes is a true no-op");
            auto edited_items = original_items;
            edited_items[0]["order"] = 222;
            const auto changed = inventory->patch(
                0,
                {{RoomPatch::Operation::Replace, "/data/interactables", edited_items.to_string()}});
            const auto changed_source = Json::parse(changed.snapshot.source_json);
            require(
                changed.accepted && changed.snapshot.dirty &&
                    changed.snapshot.dirty_patches.size() == 1 &&
                    changed.snapshot.dirty_patches.front().path == "/data/interactables" &&
                    changed_source.at("data").at("interactables").at(0).at("order") == 222 &&
                    changed_source.at("data").at("interactables").at(0).contains("visible") &&
                    !changed_source.at("data").at("interactables").at(0).contains("condition") &&
                    !changed_source.at("data").at("interactables").at(1).contains("visible") &&
                    !changed_source.at("data").at("interactables").at(1).contains("condition") &&
                    read(inventory_path) == bytes,
                "Nested effective array edit changes only the authored value");
            const auto undo =
                inventory->patch(changed.snapshot.working_revision,
                                 {{RoomPatch::Operation::Replace, "/data/interactables",
                                   original_items.to_string()}});
            require(undo.accepted && !undo.snapshot.dirty &&
                        Json::parse(undo.snapshot.source_json) == baseline,
                    "Undo restores sparse source presence and the clean native working state");
            auto reordered_items = original_items;
            const auto first_item = reordered_items[0];
            reordered_items[0] = reordered_items[1];
            reordered_items[1] = first_item;
            const auto reordered =
                inventory->patch(undo.snapshot.working_revision,
                                 {{RoomPatch::Operation::Replace, "/data/interactables",
                                   reordered_items.to_string()}});
            const auto reordered_source =
                Json::parse(reordered.snapshot.source_json).at("data").at("interactables");
            require(reordered.accepted && reordered_source.at(0).at("id") == "inventory-control" &&
                        reordered_source.at(1).at("id") == "identity-control" &&
                        reordered_source.at(1).contains("visible") &&
                        !reordered_source.at(0).contains("visible"),
                    "Reordering ID-keyed array members retains their source-field presence");
            const auto reorder_undo =
                inventory->patch(reordered.snapshot.working_revision,
                                 {{RoomPatch::Operation::Replace, "/data/interactables",
                                   original_items.to_string()}});
            require(reorder_undo.accepted && !reorder_undo.snapshot.dirty &&
                        Json::parse(reorder_undo.snapshot.source_json) == baseline,
                    "Undoing a collection reorder restores clean authored source");
            Json removed_items = Json::array();
            for (std::size_t i = 0; i < original_items.size(); ++i)
                if (i != 1)
                    removed_items.push_back(original_items.at(i));
            const auto removed =
                inventory->patch(reorder_undo.snapshot.working_revision,
                                 {{RoomPatch::Operation::Replace, "/data/interactables",
                                   removed_items.to_string()}});
            require(removed.accepted && removed.snapshot.dirty &&
                        Json::parse(removed.snapshot.source_json)
                                .at("data")
                                .at("interactables")
                                .size() == original_items.size() - 1 &&
                        !Json::parse(removed.snapshot.source_json)
                             .at("data")
                             .at("interactables")
                             .at(1)
                             .contains("visible"),
                    "Removing an array member does not expand remaining members");
            const auto removal_undo =
                inventory->patch(removed.snapshot.working_revision,
                                 {{RoomPatch::Operation::Replace, "/data/interactables",
                                   original_items.to_string()}});
            require(removal_undo.accepted && !removal_undo.snapshot.dirty &&
                        Json::parse(removal_undo.snapshot.source_json) == baseline,
                    "Undoing array removal restores the removed item's original sparse source");
            const auto view = effective.at("data").at("presentationSpace").at("defaultView");
            const auto view_no_op =
                inventory->patch(removal_undo.snapshot.working_revision,
                                 {{RoomPatch::Operation::Replace,
                                   "/data/presentationSpace/defaultView", view.to_string()}});
            require(view_no_op.accepted && !view_no_op.snapshot.dirty,
                    "Replacing a normalized nested object is also a no-op");
            auto zoomed = view;
            zoomed["zoom"] = 1.5;
            const auto zoom_change =
                inventory->patch(view_no_op.snapshot.working_revision,
                                 {{RoomPatch::Operation::Replace,
                                   "/data/presentationSpace/defaultView", zoomed.to_string()}});
            const auto zoom_source = Json::parse(zoom_change.snapshot.source_json);
            require(
                zoom_change.accepted && zoom_change.snapshot.dirty &&
                    zoom_source.at("data").at("presentationSpace").at("defaultView").at("zoom") ==
                        1.5 &&
                    !zoom_source.at("data").at("interactables").at(1).contains("visible"),
                "Nested object edits preserve unrelated sparse array fields");
            const auto zoom_undo =
                inventory->patch(zoom_change.snapshot.working_revision,
                                 {{RoomPatch::Operation::Replace,
                                   "/data/presentationSpace/defaultView", view.to_string()}});
            require(zoom_undo.accepted && !zoom_undo.snapshot.dirty &&
                        Json::parse(zoom_undo.snapshot.source_json) == baseline,
                    "Undo restores omitted nested object defaults");
            auto whole_data = effective.at("data");
            whole_data["displayName"] = "Focused projection";
            const auto whole_data_changed = inventory->patch(
                zoom_undo.snapshot.working_revision,
                {{RoomPatch::Operation::Replace, "/data", whole_data.to_string()}});
            require(whole_data_changed.accepted && whole_data_changed.snapshot.dirty &&
                        Json::parse(whole_data_changed.snapshot.source_json)
                                .at("data")
                                .at("displayName") == "Focused projection" &&
                        !Json::parse(whole_data_changed.snapshot.source_json)
                             .at("data")
                             .at("interactables")
                             .at(1)
                             .contains("visible"),
                    "Existing whole-data replacement also preserves nested sparse defaults");
            const auto whole_data_undo = inventory->patch(
                whole_data_changed.snapshot.working_revision,
                {{RoomPatch::Operation::Replace, "/data", effective.at("data").to_string()}});
            require(whole_data_undo.accepted && !whole_data_undo.snapshot.dirty &&
                        Json::parse(whole_data_undo.snapshot.source_json) == baseline,
                    "Whole-data Undo restores the clean original authored source");
            const auto explicitly_added = inventory->patch(
                whole_data_undo.snapshot.working_revision,
                {{RoomPatch::Operation::Replace, "/data/interactables/1/visible", "true"}});
            require(explicitly_added.accepted && explicitly_added.snapshot.dirty &&
                        Json::parse(explicitly_added.snapshot.source_json)
                                .at("data")
                                .at("interactables")
                                .at(1)
                                .at("visible") == true,
                    "Explicit scalar default edit still authors its field");
            const auto explicitly_removed = inventory->patch(
                explicitly_added.snapshot.working_revision,
                {{RoomPatch::Operation::Remove, "/data/interactables/1/visible", ""}});
            require(explicitly_removed.accepted && !explicitly_removed.snapshot.dirty,
                    "Removing an explicitly authored default restores clean sparse source");
            const auto commit = inventory->patch(
                explicitly_removed.snapshot.working_revision,
                {{RoomPatch::Operation::Replace, "/data/interactables", edited_items.to_string()}});
            const auto saved = inventory->save(commit.snapshot.disk_source_revision);
            require(commit.accepted && saved.accepted && !saved.snapshot.dirty &&
                        read(inventory_path).find("visible: true # deliberately explicit") !=
                            std::string::npos &&
                        read(inventory_path).find("order: 222") != std::string::npos &&
                        read(inventory_path).find("condition:") == std::string::npos,
                    "Native Save retains explicitly authored default comments and sparse peers");
            auto cold = RoomSession::open(temp.root, "inventory-workbench", error);
            require(cold && cold->snapshot().valid && !cold->snapshot().dirty &&
                        Json::parse(cold->snapshot().normalized_json)
                                .at("data")
                                .at("interactables")
                                .at(0)
                                .at("order") == 222,
                    "Native Save and reopen preserve sparse nested authoring");
        }

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
        const auto adopted = session->save(race.snapshot.disk_source_revision);
        require(adopted.accepted && !adopted.snapshot.dirty &&
                    read(temp.path()).find("# changed externally\n") != std::string::npos &&
                    read(temp.path()).find("Unsaved local") != std::string::npos,
                "External comment-only source edit rebases without discarding an independent Save");
        auto overlap = RoomSession::open(temp.root, "room-lifecycle-roundtrip", error);
        const auto before_overlap = read(temp.path());
        auto overlapping_patch =
            overlap->patch(0, {{RoomPatch::Operation::Replace, "/label", "\"Local collision\""}});
        const auto physical_overlap = read(temp.path());
        const auto label = physical_overlap.find("Unsaved local");
        require(label != std::string::npos, "Concurrent overlapping Room label fixture exists");
        auto concurrent_source = physical_overlap;
        concurrent_source.replace(label, std::string_view("Unsaved local").size(),
                                  "External collision");
        write(temp.path(), concurrent_source);
        const auto conflict = overlap->save(overlapping_patch.snapshot.disk_source_revision);
        require(!conflict.accepted && read(temp.path()) == concurrent_source &&
                    conflict.snapshot.dirty && read(temp.path()) != before_overlap,
                "Overlapping external Room edit fails closed without discarding dirty work");
        auto independent = RoomSession::open(temp.root, "room-lifecycle-roundtrip", error);
        require(independent != nullptr, "Independent Room rebase fixture admits");
        const auto local_disjoint = independent->patch(
            0, {{RoomPatch::Operation::Replace, "/label", "\"Local independent\""}});
        auto remote_disjoint = read(temp.path());
        const auto display_name = remote_disjoint.find("Lifecycle Round Trip Destination");
        require(display_name != std::string::npos,
                "Room fixture supplies an independently editable display name");
        remote_disjoint.replace(display_name,
                                std::string_view("Lifecycle Round Trip Destination").size(),
                                "External Room Destination");
        write(temp.path(), remote_disjoint);
        const auto merged = independent->save(local_disjoint.snapshot.disk_source_revision);
        require(merged.accepted && merged.snapshot.working_revision == 2 &&
                    !merged.snapshot.dirty &&
                    read(temp.path()).find("External Room Destination") != std::string::npos &&
                    read(temp.path()).find("Local independent") != std::string::npos &&
                    Json::parse(merged.snapshot.source_json).at("data").at("displayName") ==
                        "External Room Destination",
                "Disjoint same-Room semantic edit rebases and advances working revision once");
        auto scoped_block = RoomSession::open(temp.root, "room-lifecycle-roundtrip", error);
        require(scoped_block != nullptr, "Scoped dependency-block fixture admits");
        const auto blocked_patch = scoped_block->patch(
            0, {{RoomPatch::Operation::Replace, "/label", "\"Blocked owner\""}});
        const auto previous_bytes = read(temp.path());
        const auto blocked_by_owner =
            scoped_block->save(blocked_patch.snapshot.disk_source_revision,
                               {"records/rooms/room-lifecycle-roundtrip.yaml"});
        require(blocked_patch.accepted && !blocked_by_owner.accepted &&
                    blocked_by_owner.snapshot.dirty && read(temp.path()) == previous_bytes,
                "An attributable invalid source blocks its own Save through the session writer");
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
