#include "room_session.hpp"
#include "verb_interaction_semantics.hpp"

#include <jsoncons/json.hpp>

#include <chrono>
#include <filesystem>
#include <iostream>
#include <stdexcept>
#include <string>

namespace {
using namespace noveltea::authoring;
using Json = jsoncons::ojson;

void require(bool condition, std::string_view message)
{
    if (!condition)
        throw std::runtime_error(std::string(message));
}

bool has(const std::vector<Diagnostic>& diagnostics, std::string_view path,
         std::string_view code = {})
{
    for (const auto& diagnostic : diagnostics)
        if (diagnostic.path == path && (code.empty() || diagnostic.code == code))
            return true;
    return false;
}

struct Fixture {
    std::filesystem::path path;
    explicit Fixture(const std::filesystem::path& original)
    {
        path = std::filesystem::temp_directory_path() /
               ("noveltea-verb-interaction-" +
                std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
        std::filesystem::copy(original, path, std::filesystem::copy_options::recursive);
    }
    ~Fixture()
    {
        std::error_code ignored;
        std::filesystem::remove_all(path, ignored);
    }
};

void certify(const std::filesystem::path& original)
{
    Fixture fixture(original);
    std::string error;
    auto verb = RoomSession::open_record(fixture.path, "verbs", "deliver", error);
    if (!verb || !verb->snapshot().valid) {
        std::cerr << "Verb opening: " << error << '\n';
        if (verb)
            for (const auto& d : verb->snapshot().diagnostics)
                std::cerr << d.path << " " << d.code << ": " << d.message << '\n';
    }
    require(verb && verb->snapshot().valid, "Feature Lab Deliver Verb must normalize");
    const auto original_source = verb->snapshot().source_json;
    const auto duplicate =
        verb->patch(verb->snapshot().working_revision,
                    {{RoomPatch::Operation::Replace, "/data/bindingOrder/1", "\"recipient\""}});
    require(duplicate.accepted && !duplicate.snapshot.valid &&
                has(duplicate.snapshot.diagnostics, "/data/bindingOrder", "semantic.verb.validate"),
            "Duplicate binding order must fail the registered native Verb refinement");
    require(verb->snapshot().source_json != original_source, "Edit must remain in working source");
    const auto restored =
        verb->patch(verb->snapshot().working_revision,
                    {{RoomPatch::Operation::Replace, "/data/bindingOrder/1", "\"parcel\""}});
    require(restored.accepted && restored.snapshot.valid, "Verb repair must normalize");

    const auto malformed_template =
        verb->patch(verb->snapshot().working_revision,
                    {{RoomPatch::Operation::Replace, "/data/completedCommandText/source/text",
                      "\"Deliver {unknown}\""}});
    require(malformed_template.accepted && !malformed_template.snapshot.valid &&
                has(malformed_template.snapshot.diagnostics,
                    "/data/completedCommandText/source/text", "semantic.verb.validate"),
            "Unknown placeholders must carry precise source-relative paths");
    const auto repaired =
        verb->patch(verb->snapshot().working_revision,
                    {{RoomPatch::Operation::Replace, "/data/completedCommandText/source/text",
                      "\"Deliver {parcel} to {recipient}\""}});
    require(repaired.accepted && repaired.snapshot.valid, "Template repair must normalize");

    const auto malformed_pattern = verb->patch(
        verb->snapshot().working_revision,
        {{RoomPatch::Operation::Replace, "/data/slots/0/selectors/0",
          R"({"kind":"qualified-pattern","family":"character","pattern":"bad*mid*"})"}});
    require(malformed_pattern.accepted && !malformed_pattern.snapshot.valid &&
                has(malformed_pattern.snapshot.diagnostics, "/data/slots/0/selectors/0/pattern",
                    "semantic.verb.qualified-pattern"),
            "Qualified pattern refinement must require exactly one terminal wildcard");

    auto interaction =
        RoomSession::open_record(fixture.path, "interactions", "use-gate-lever", error);
    require(interaction && interaction->snapshot().valid, "Feature Lab Interaction must normalize");
    auto local = Json::parse(interaction->snapshot().normalized_json);
    auto& rules = local.at("data").at("rules");
    rules.at(0).at("program").at("outcome") = "unhandled";
    auto validation = validate_verb_interaction_local("interactions", local.to_string());
    require(!validation.accepted && has(validation.diagnostics, "/data/rules/0/program",
                                        "authoring.interaction.unhandled-program"),
            "Unhandled program must be empty");
    rules.at(0).at("program").at("outcome") = "handled";
    rules.at(0).at("program").at("instructions").at(1).at("id") = "unlock";
    validation = validate_verb_interaction_local("interactions", local.to_string());
    require(!validation.accepted &&
                has(validation.diagnostics, "/data/rules/0/program/instructions/1/id"),
            "Nested program IDs must be unique within the program");

    const auto conflict = validate_interaction_resolver({
        {"first",
         R"({"data":{"rules":[{"id":"one","verb":{"$ref":{"id":"use"}},"slots":[{"slotId":"target","selectors":[{"kind":"any-subject"}]}],"guard":{"kind":"always"},"priority":1}]}})"},
        {"second",
         R"({"data":{"rules":[{"id":"two","verb":{"$ref":{"id":"use"}},"slots":[{"slotId":"target","selectors":[{"kind":"any-subject"}]}],"guard":{"kind":"always"},"priority":1}]}})"},
    });
    require(!conflict.accepted && has(conflict.diagnostics, "/interactions/second/data/rules/0",
                                      "authoring.interaction.resolver-conflict"),
            "Unconditional cross-record ambiguity must be an owner-qualified error");
    const auto unreachable = validate_interaction_resolver({
        {"first",
         R"({"data":{"rules":[{"id":"one","verb":{"$ref":{"id":"use"}},"slots":[{"slotId":"target","selectors":[{"kind":"any-subject"}]}],"guard":{"kind":"always"},"priority":1}]}})"},
        {"second",
         R"({"data":{"rules":[{"id":"two","verb":{"$ref":{"id":"use"}},"slots":[{"slotId":"target","selectors":[{"kind":"any-subject"}]}],"guard":{"kind":"always"},"priority":2}]}})"},
    });
    require(!unreachable.accepted &&
                has(unreachable.diagnostics, "/interactions/first/data/rules/0",
                    "authoring.interaction.unreachable"),
            "Higher unconditional priority must mark equivalent rule unreachable");

    auto project = ProjectSession::open(fixture.path, error);
    require(project != nullptr, error);
    auto ui = RoomSession::open_record(fixture.path, "interactions", "ui-control-board", error);
    require(ui && ui->snapshot().valid, "Feature Lab UI Interaction must normalize");
    auto broken_feature = Json::parse(ui->snapshot().normalized_json);
    broken_feature.at("data")
        .at("rules")
        .at(3)
        .at("slots")
        .at(0)
        .at("selectors")
        .at(0)
        .at("subject")
        .at("feature")
        .at("featureId") = "missing-feature";
    const AuthoringRecordResolver resolve = [&](std::string_view family,
                                                std::string_view id) -> std::optional<std::string> {
        std::string reason;
        auto record =
            RoomSession::open_record(fixture.path, std::string(family), std::string(id), reason);
        return record && record->snapshot().valid
                   ? std::optional<std::string>(record->snapshot().normalized_json)
                   : std::nullopt;
    };
    const auto exists = [&](std::string_view family, std::string_view id) {
        return std::filesystem::is_regular_file(fixture.path / "records" / std::string(family) /
                                                (std::string(id) + ".yaml"));
    };
    const auto feature_errors = validate_verb_interaction_dependencies(
        "interactions", broken_feature.to_string(), project->snapshot().normalized_json, "{}",
        resolve, exists);
    require(!feature_errors.accepted &&
                has(feature_errors.diagnostics,
                    "/data/rules/3/slots/0/selectors/0/subject/feature/featureId",
                    "authoring.interaction.feature-missing"),
            "Interaction Feature references must validate their actual definition ownership");
    auto broken_inventory = Json::parse(ui->snapshot().normalized_json);
    broken_inventory.at("data").at("rules").at(0).at("guard") = Json::parse(
        R"({"kind":"location-comparison","subject":{"kind":"interactable","interactable":{"$ref":{"id":"custom-board"}}},"location":{"kind":"inventory","inventory":{"kind":"inventory","inventory":{"owner":{"kind":"project"},"inventoryId":"missing-inventory"}}}})");
    const auto inventory_errors = validate_verb_interaction_dependencies(
        "interactions", broken_inventory.to_string(), project->snapshot().normalized_json, "{}",
        resolve, exists);
    require(!inventory_errors.accepted && has(inventory_errors.diagnostics,
                                              "/data/rules/0/guard/location/inventory/inventoryId",
                                              "authoring.inventory.missing"),
            "An Inventory operand must validate its owner and named Inventory");
    require(project->inspect_record("interactions/use-gate-lever").accepted,
            "Interaction must be inspectable");
    const auto changed = project->patch(
        project->snapshot().working_revision,
        {{RoomPatch::Operation::Replace, "/interactions/use-gate-lever/data/rules/0/verb/$ref/id",
          "\"missing-verb\""}});
    require(changed.accepted && !changed.snapshot.valid &&
                has(changed.snapshot.diagnostics,
                    "/interactions/use-gate-lever/data/rules/0/verb/$ref",
                    "authoring.interaction.verb-missing"),
            "Dirty rule references must report their Interaction owner path");
    require(!project
                 ->save_owners(changed.snapshot.working_revision, {"interactions/use-gate-lever"},
                               false, TransactionDecision::UseEditDecisions)
                 .accepted,
            "Invalid Interaction must not save");
    const auto repair =
        project->patch(changed.snapshot.working_revision,
                       {{RoomPatch::Operation::Replace,
                         "/interactions/use-gate-lever/data/rules/0/verb/$ref/id", "\"use\""}});
    require(repair.accepted && repair.snapshot.valid,
            "Repairing a missing Verb restores Project validation");
    const auto edited =
        project->patch(repair.snapshot.working_revision,
                       {{RoomPatch::Operation::Replace,
                         "/interactions/use-gate-lever/data/rules/0/priority", "11"}});
    require(edited.accepted && edited.snapshot.valid,
            "A valid Interaction priority edit must remain savable");
    const auto saved =
        project->save_owners(edited.snapshot.working_revision, {"interactions/use-gate-lever"},
                             false, TransactionDecision::UseEditDecisions);
    require(saved.accepted, "A valid Interaction edit must save atomically: " + saved.error);
    auto reopened = ProjectSession::open(fixture.path, error);
    require(reopened && reopened->inspect_record("interactions/use-gate-lever").accepted,
            "Saved Interaction must reopen");
    const auto snapshot = reopened->record_snapshots().at("interactions/use-gate-lever");
    require(snapshot.valid &&
                Json::parse(snapshot.normalized_json).at("data").at("rules").at(0).at("priority") ==
                    11,
            "Saved Interaction priority must survive native source normalization");

    const auto bad_fallback = reopened->patch(
        reopened->snapshot().working_revision,
        {{RoomPatch::Operation::Add, "/undefinedInteractionProgram/instructions/0",
          R"({"id":"bad-fallback","kind":"notify","message":{"source":{"kind":"inline","text":"ignored"},"markup":"plain"}})"}});
    require(bad_fallback.accepted && !bad_fallback.snapshot.valid &&
                has(bad_fallback.snapshot.diagnostics, "/undefinedInteractionProgram",
                    "authoring.interaction.unhandled-program"),
            "Manifest-owned unhandled fallback cannot execute commands before returning");
    require(!reopened
                 ->save_owners(bad_fallback.snapshot.working_revision, {"project"}, false,
                               TransactionDecision::UseEditDecisions)
                 .accepted,
            "An invalid fallback must prevent Manifest Save");
    const auto restored_fallback = reopened->patch(
        bad_fallback.snapshot.working_revision,
        {{RoomPatch::Operation::Remove, "/undefinedInteractionProgram/instructions/0", ""}});
    require(restored_fallback.accepted && restored_fallback.snapshot.valid,
            "Removing an invalid fallback command must restore validity");

    // A changed Verb must invalidate an uninspected Interaction and block the
    // originating Verb Save, not merely report the error on the dependent owner.
    auto dependent_project = ProjectSession::open(fixture.path, error);
    require(dependent_project && dependent_project->inspect_record("verbs/use").accepted,
            "Verb must be inspectable as an independent Project owner");
    const auto edited_verb = dependent_project->patch(
        dependent_project->snapshot().working_revision,
        {{RoomPatch::Operation::Replace, "/verbs/use/data/slots/0/selectors/0",
          R"({"kind":"family","family":"character"})"}});
    require(edited_verb.accepted && !edited_verb.snapshot.valid &&
                has(edited_verb.snapshot.diagnostics,
                    "/interactions/use-gate-lever/data/rules/0/slots/0/selectors",
                    "authoring.interaction.selector-disjoint"),
            "A dirty Verb must invalidate an uninspected dependent Interaction");
    const auto blocked_verb_save =
        dependent_project->save_owners(edited_verb.snapshot.working_revision, {"verbs/use"}, false,
                                       TransactionDecision::UseEditDecisions);
    require(!blocked_verb_save.accepted,
            "An invalid dependent Interaction must block saving its edited Verb");
    const auto repaired_verb = dependent_project->patch(
        edited_verb.snapshot.working_revision,
        {{RoomPatch::Operation::Replace, "/verbs/use/data/slots/0/selectors/0",
          R"({"kind":"interactable-definition","interactableDefinition":{"$ref":{"collection":"interactables","id":"gate-lever"}}})"}});
    require(repaired_verb.accepted &&
                !has(repaired_verb.snapshot.diagnostics,
                     "/interactions/use-gate-lever/data/rules/0/slots/0/selectors",
                     "authoring.interaction.selector-disjoint"),
            "Restoring Verb selectors must clear the dependent Interaction error");
}
} // namespace

int main(int argc, char** argv)
{
    try {
        if (argc == 5 && std::string_view(argv[1]) == "--normalized-record") {
            std::string error;
            const auto record = RoomSession::open_record(argv[2], argv[3], argv[4], error);
            require(record && record->snapshot().valid,
                    "Cannot normalize authored record: " + error);
            std::cout << record->snapshot().normalized_json << '\n';
            return 0;
        }
        require(argc == 2, "Pass the Feature Lab path");
        certify(argv[1]);
        std::cout << "Verb and Interaction certification passed\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
