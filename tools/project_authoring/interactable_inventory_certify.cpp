#include "room_session.hpp"

#include <jsoncons/json.hpp>

#include <chrono>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <iterator>
#include <stdexcept>

namespace {
using namespace noveltea::authoring;
using Json = jsoncons::ojson;

void require(bool ok, std::string_view message)
{
    if (!ok)
        throw std::runtime_error(std::string(message));
}

std::string read(const std::filesystem::path& path)
{
    std::ifstream file(path, std::ios::binary);
    require(static_cast<bool>(file), "Could not read fixture source");
    return {std::istreambuf_iterator<char>{file}, std::istreambuf_iterator<char>{}};
}

void write(const std::filesystem::path& path, const std::string& bytes)
{
    std::ofstream file(path, std::ios::binary | std::ios::trunc);
    file << bytes;
    require(static_cast<bool>(file), "Could not write fixture source");
}

struct Fixture {
    std::filesystem::path root;
    explicit Fixture(const std::filesystem::path& from)
    {
        root = std::filesystem::temp_directory_path() /
               ("nt-482-" +
                std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
        std::filesystem::copy(from, root, std::filesystem::copy_options::recursive);
    }
    ~Fixture()
    {
        std::error_code ignored;
        std::filesystem::remove_all(root, ignored);
    }
};

bool has(const std::vector<Diagnostic>& diagnostics, std::string_view path, std::string_view code)
{
    for (const auto& item : diagnostics)
        if (item.path == path && item.code == code)
            return true;
    return false;
}

void certify(const std::filesystem::path& source)
{
    Fixture fixture(source);
    std::string error;
    auto project = ProjectSession::open(fixture.root, error);
    require(project != nullptr, error);
    require(project->inspect_record("interactables/lab-parcel").accepted &&
                project->inspect_record("interactables/lab-supply").accepted &&
                project->snapshot().valid,
            "Real Feature Lab Interactable Definitions and Instances admit natively");

    const auto replacement = [&](std::string_view path, const std::string& value) {
        const auto result =
            project->patch(project->snapshot().working_revision,
                           {{RoomPatch::Operation::Replace, std::string(path), value}});
        require(result.accepted, "Generic Project edit was rejected: " + result.error);
        return result;
    };
    const auto require_diagnostic = [&](const RoomSessionResult& result, std::string_view path,
                                        std::string_view code) {
        if (!has(result.snapshot.diagnostics, path, code))
            for (const auto& issue : result.snapshot.diagnostics)
                std::cerr << issue.path << " " << issue.code << " " << issue.message << '\n';
        require(!result.snapshot.valid && has(result.snapshot.diagnostics, path, code),
                "Missing dependent native Project diagnostic");
    };

    auto changed = replacement("/interactableInstances/builder-self-parcel/quantity", "2");
    require_diagnostic(changed, "/interactableInstances/builder-self-parcel/quantity",
                       "authoring.interactable.invalid_quantity");
    require(!project
                 ->save_owners(changed.snapshot.working_revision, {"project"}, false,
                               TransactionDecision::UseEditDecisions)
                 .accepted,
            "Non-stackable quantity cannot be saved");
    changed = replacement("/interactableInstances/builder-self-parcel/quantity", "1");
    require(changed.snapshot.valid, "Restoring quantity repairs Instance state");

    changed = replacement("/interactableInstances/builder-self-parcel/definition/$ref/id",
                          "\"missing-definition\"");
    require_diagnostic(changed, "/interactableInstances/builder-self-parcel/definition/$ref",
                       "authoring.interactable.definition-missing");
    changed = replacement("/interactableInstances/builder-self-parcel/definition/$ref/id",
                          "\"lab-parcel\"");
    require(changed.snapshot.valid, "Repaired Definition reference restores validity");

    changed = replacement("/interactableInstances/builder-self-parcel/location/room/$ref/id",
                          "\"missing-room\"");
    require_diagnostic(changed, "/interactableInstances/builder-self-parcel/location/room/$ref",
                       "authoring.interactable.room-missing");
    changed = replacement("/interactableInstances/builder-self-parcel/location/room/$ref/id",
                          "\"verbs-and-offers\"");
    require(changed.snapshot.valid, "Repaired Room reference restores validity");

    changed = replacement(
        "/interactableInstances/builder-inventory-parcel/location/inventory/inventoryId",
        "\"missing-inventory\"");
    require_diagnostic(
        changed, "/interactableInstances/builder-inventory-parcel/location/inventory/inventoryId",
        "authoring.inventory.missing");
    changed = replacement(
        "/interactableInstances/builder-inventory-parcel/location/inventory/inventoryId",
        "\"inventory\"");
    require(changed.snapshot.valid, "Repaired Project Inventory membership is valid");

    changed = replacement(
        "/interactableInstances/state-specimen-instance/location",
        R"({"kind":"inventory","inventory":{"owner":{"kind":"interactable","interactable":{"$ref":{"registry":"interactableInstances","id":"state-specimen-instance"}}},"inventoryId":"pocket"}})");
    require_diagnostic(changed, "/interactableInstances/state-specimen-instance/location/inventory",
                       "authoring.inventory.containment-cycle");
    // The original Room may vary with the fixture; restore from saved manifest.
    const auto disk = Json::parse(project->snapshot().baseline_json);
    const auto original_location =
        disk.at("interactableInstances").at("state-specimen-instance").at("location").to_string();
    changed =
        replacement("/interactableInstances/state-specimen-instance/location", original_location);
    require(changed.snapshot.valid, "Containment cycle is repairable without resetting Project");

    const auto original_member_location =
        disk.at("interactableInstances").at("builder-inventory-parcel").at("location").to_string();
    changed = replacement(
        "/interactableInstances/builder-inventory-parcel/location",
        R"({"kind":"inventory","inventory":{"owner":{"kind":"interactable","interactable":{"$ref":{"registry":"interactableInstances","id":"state-specimen-instance"}}},"inventoryId":"pocket"}})");
    require(changed.snapshot.valid, "Instance may belong to another Instance-owned Inventory");
    changed =
        replacement("/interactables/lab-specimen/data/inventories/0/id", "\"renamed-pocket\"");
    require_diagnostic(
        changed, "/interactableInstances/builder-inventory-parcel/location/inventory/inventoryId",
        "authoring.inventory.missing");
    require(!project
                 ->save_owners(changed.snapshot.working_revision, {"interactables/lab-specimen"},
                               false, TransactionDecision::UseEditDecisions)
                 .accepted,
            "An owning Definition cannot save while its member Inventory reference is invalid");
    changed = replacement("/interactables/lab-specimen/data/inventories/0/id", "\"pocket\"");
    require(changed.snapshot.valid, "Inventory ID repair restores dependent membership");
    changed = replacement("/interactableInstances/builder-inventory-parcel/location",
                          original_member_location);
    require(changed.snapshot.valid, "Original Project Inventory membership is restored");

    changed = replacement("/interactables/lab-parcel/data/stackable", "true");
    require_diagnostic(changed, "/interactables/lab-parcel/data",
                       "authoring.interactable.stackable_identity_children");
    changed = replacement("/interactables/lab-parcel/data/stackable", "false");
    require(changed.snapshot.valid, "Definition Feature ownership prevents stackability");
    changed = replacement("/interactables/lab-parcel/data/presentation/hotspots/hotspot/target",
                          R"({"kind":"owner-feature","featureId":"missing-feature"})");
    require_diagnostic(
        changed, "/interactables/lab-parcel/data/presentation/hotspots/hotspot/target/featureId",
        "hotspot.authoring.target.feature-missing");
    changed = replacement("/interactables/lab-parcel/data/presentation/hotspots/hotspot/target",
                          R"({"kind":"owner"})");
    require(changed.snapshot.valid, "Feature presentation target is repairable");

    auto duplicate = project->patch(
        project->snapshot().working_revision,
        {{RoomPatch::Operation::Add, "/interactables/lab-specimen/data/inventories/1",
          R"({"id":"pocket","label":"Duplicate"})"}});
    require(duplicate.accepted, duplicate.error);
    require_diagnostic(duplicate, "/interactables/lab-specimen/data/inventories/1/id",
                       "authoring.inventory.duplicate-id");
    auto repair = project->patch(
        duplicate.snapshot.working_revision,
        {{RoomPatch::Operation::Remove, "/interactables/lab-specimen/data/inventories/1", ""}});
    require(repair.accepted && repair.snapshot.valid, "Duplicate Inventory ID can be repaired");

    const auto def_path = fixture.root / "records/interactables/lab-supply.yaml";
    const auto source_before = read(def_path);
    const auto anchor = source_before.find("  stackLimit: 5");
    require(anchor != std::string::npos, "Expected sparse Lab Supply metadata");
    auto annotated = source_before;
    annotated.insert(anchor, "  # quantity cap is author-owned\n");
    write(def_path, annotated);
    auto inspected = project->reconcile_owner("interactables/lab-supply");
    require(inspected.accepted && inspected.snapshot.valid, "External comments reconcile cleanly");
    changed = replacement("/interactables/lab-supply/data/stackLimit", "1");
    require_diagnostic(changed, "/interactableInstances/supply-aggregate-a/quantity",
                       "authoring.interactable.invalid_quantity");
    require(!project
                 ->save_owners(changed.snapshot.working_revision, {"interactables/lab-supply"},
                               false, TransactionDecision::UseEditDecisions)
                 .accepted,
            "Definition edits cannot publish invalid dependent quantities");
    changed = replacement("/interactables/lab-supply/data/stackLimit", "7");
    require(changed.snapshot.valid, "Wider Stack limit admits existing Instances");
    const auto saved =
        project->save_owners(changed.snapshot.working_revision, {"interactables/lab-supply"}, false,
                             TransactionDecision::UseEditDecisions);
    require(saved.accepted && saved.snapshot.valid &&
                read(def_path).find("# quantity cap is author-owned") != std::string::npos,
            "Generic Definition Save preserves source comments");
    auto reopened = RoomSession::open_record(fixture.root, "interactables", "lab-supply", error);
    require(reopened && reopened->snapshot().valid &&
                Json::parse(reopened->snapshot().normalized_json).at("data").at("stackLimit") == 7,
            "Reopened Definition retains normalized Stack limit");
    const auto saved_bytes = read(def_path);
    const auto no_op =
        project->save_owners(saved.snapshot.working_revision, {"interactables/lab-supply"}, false,
                             TransactionDecision::UseEditDecisions);
    require(no_op.accepted && read(def_path) == saved_bytes,
            "No-op Definition Save cannot rewrite source bytes");

    // A concrete stack quantity is manifest-owned, even though its limit is
    // defined in the independent YAML record that was just saved.
    const auto project_path = fixture.root / "project.yaml";
    const auto manifest_before = read(project_path);
    changed = replacement("/interactableInstances/supply-aggregate-a/quantity", "6");
    require(changed.snapshot.valid, "Edited stack quantity respects widened Definition limit");
    const auto saved_instance = project->save_owners(changed.snapshot.working_revision, {"project"},
                                                     false, TransactionDecision::UseEditDecisions);
    require(saved_instance.accepted && read(project_path) != manifest_before &&
                read(def_path) == saved_bytes,
            "Saving an Instance changes only its manifest-owned source");
    auto reopened_project = ProjectSession::open(fixture.root, error);
    require(reopened_project && Json::parse(reopened_project->snapshot().normalized_json)
                                        .at("interactableInstances")
                                        .at("supply-aggregate-a")
                                        .at("quantity") == 6,
            "Reopened Project retains the exact authored Instance quantity");
}
} // namespace

int main(int argc, char** argv)
{
    try {
        if (argc == 4 && std::string_view(argv[1]) == "--normalized-definition") {
            std::string error;
            const auto record = RoomSession::open_record(argv[2], "interactables", argv[3], error);
            require(record != nullptr, error);
            const auto snapshot = record->snapshot();
            require(snapshot.valid,
                    "Native Interactable normalization failed for " + std::string(argv[3]));
            std::cout << snapshot.normalized_json << '\n';
            return 0;
        }
        require(argc == 2, "Expected Feature Lab project root");
        certify(argv[1]);
        std::cout << "Native Interactable/Inventory certification passed.\n";
    } catch (const std::exception& error) {
        std::cerr << "Native Interactable/Inventory certification failed: " << error.what() << '\n';
        return 1;
    }
}
