#include "localization_semantics.hpp"
#include "room_session.hpp"
#include "yaml_codec.hpp"

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

void require(bool condition, std::string_view why)
{
    if (!condition)
        throw std::runtime_error(std::string(why));
}

bool diagnostic(const ValidationResult& result, std::string_view path)
{
    for (const auto& entry : result.diagnostics)
        if (entry.path == path && !entry.source_path.empty())
            return true;
    std::cerr << "Expected " << path << ", received:";
    for (const auto& entry : result.diagnostics)
        std::cerr << "\n  " << entry.path << " (" << entry.code << ") " << entry.message << " ["
                  << entry.source_path << "]";
    std::cerr << '\n';
    return false;
}

std::string contents(const std::filesystem::path& path)
{
    std::ifstream file(path, std::ios::binary);
    require(static_cast<bool>(file), "Source read failed");
    return {std::istreambuf_iterator<char>{file}, std::istreambuf_iterator<char>{}};
}

struct Fixture {
    std::filesystem::path root;
    explicit Fixture(const std::filesystem::path& source)
    {
        root = std::filesystem::temp_directory_path() /
               ("nt-491-" +
                std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
        std::filesystem::copy(source, root, std::filesystem::copy_options::recursive);
    }
    ~Fixture()
    {
        std::error_code ec;
        std::filesystem::remove_all(root, ec);
    }
};

void certify(const std::filesystem::path& source)
{
    Fixture fixture(source);
    const auto policy = fixture.root / "i18n/project.yaml";
    const auto saved_policy = contents(policy);
    auto initial = validate_project_localization(fixture.root);
    require(initial.accepted, "Existing split Feature Lab localization is valid");
    require(contents(policy) == saved_policy, "Validation does not rewrite YAML");
    const auto model = Json::parse(initial.effective_json);
    require(model.at("sourceLocale") == "en" && model.at("locales").contains("fr-CA"),
            "Native model retains policy and locale definitions");
    require(
        model.at("sourceLocaleLock") == "en" &&
            contents(policy).find("sourceLocaleLock: null") != std::string::npos,
        "Substantive translation work materializes an effective lock without rewriting the source");

    auto invalid_placeholder = model;
    invalid_placeholder["messages"]["25700000-0000-4000-8000-000000000001"]["arguments"] =
        Json::object();
    const auto placeholders =
        validate_record("WorkspaceLocalization", invalid_placeholder.to_string());
    require(!placeholders.accepted && !placeholders.diagnostics.empty() &&
                placeholders.diagnostics.front().path.starts_with(
                    "/messages/25700000-0000-4000-8000-000000000001/"),
            "Source Message placeholders require declared arguments");

    auto duplicate_named = model;
    duplicate_named["messages"]["25700000-0000-4000-8000-000000000002"]["key"] = "lab.greeting";
    const auto duplicates = validate_record("WorkspaceLocalization", duplicate_named.to_string());
    require(!duplicates.accepted, "Named Message keys cannot be reused");

    auto invalid_plural = model;
    invalid_plural["messages"]["25700000-0000-4000-8000-000000000004"]["pattern"]["cases"]["other"]
                  ["cases"]
                      .erase("other");
    const auto plural = validate_record("WorkspaceLocalization", invalid_plural.to_string());
    require(!plural.accepted, "Nested plural patterns require an other fallback");

    const auto source_tracking = open_yaml_source(contents(fixture.root / "i18n/tracking.yaml"));
    require(source_tracking.accepted, "Existing tracking YAML is readable");
    Json tracking = Json::parse(source_tracking.source_json);
    const auto original_tracking = std::string(tracking.object_range().begin()->key());
    auto tracking_record = tracking.at(original_tracking);
    tracking.erase(original_tracking);
    tracking.insert_or_assign("lua:wrong:owner", std::move(tracking_record));
    auto mismatched_tracking =
        validate_project_localization(fixture.root, {{"i18n/tracking.yaml", tracking.to_string()}});
    require(
        !mismatched_tracking.accepted &&
            diagnostic(mismatched_tracking, "/localization/sourceMessageTracking/lua:wrong:owner"),
        "Managed tracking key must match its semantic owner and source path");

    const auto source_lock = validate_project_localization(
        fixture.root,
        {{"i18n/project.yaml",
          R"({"sourceLocale":"fr","sourceLocaleLock":"en","defaultLocale":"en","locales":{"en":{"supported":true,"parentLocale":null,"fontStack":null},"fr":{"supported":true,"parentLocale":null,"fontStack":null}}})"}});
    require(!source_lock.accepted && diagnostic(source_lock, "/localization/sourceLocale"),
            "Changing a substantively locked source locale has an owner diagnostic");

    const auto invalid_target = validate_project_localization(
        fixture.root,
        {{"i18n/locales/fr.yaml",
          R"({"not-a-message": {"text":"Bonjour","origin":"human","review":"reviewed","sourceFingerprint":"fnv1a:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}})"}});
    require(!invalid_target.accepted &&
                diagnostic(invalid_target, "/localization/translations/fr/not-a-message"),
            "Invalid translation identity points at its physical owner");

    const auto changed_policy = validate_project_localization(
        fixture.root,
        {{"i18n/project.yaml",
          R"({"sourceLocale":"en","defaultLocale":"de","locales":{"en":{"supported":true,"parentLocale":null,"fontStack":null}}})"}});
    require(!changed_policy.accepted && diagnostic(changed_policy, "/localization/locales/de"),
            "Missing declared Default locale is diagnosed at the policy owner");

    const auto bad_fragment =
        validate_project_localization(fixture.root, {{"i18n/tracking.yaml", R"({"bad": {}})"}});
    require(!bad_fragment.accepted &&
                diagnostic(bad_fragment, "/localization/sourceMessageTracking/bad/family"),
            "Invalid managed tracking uses logical path and physical source");

    const auto chunk = fixture.root / "i18n/locales/zz.yaml";
    std::ofstream(chunk) << "{}\n";
    const auto empty = validate_project_localization(fixture.root);
    require(!empty.accepted && diagnostic(empty, "/localization/translations/zz"),
            "Empty locale chunks are invalid sparse tracked sources");
    std::filesystem::remove(chunk);

    std::string sparse_error;
    auto sparse_project = ProjectSession::open(fixture.root, sparse_error);
    require(sparse_project != nullptr, sparse_error);
    const auto sparse_change = sparse_project->patch(
        sparse_project->snapshot().working_revision,
        {{RoomPatch::Operation::Replace, "/localization/sourceLocale", "\"fr\""}});
    require(sparse_change.accepted && !sparse_change.snapshot.valid &&
                contents(policy) == saved_policy,
            "An effective sparse Source lock also protects unsaved working source edits");

    // Explicitly persist the effective lock before testing subsequent source
    // changes: the sparse initial fixture deliberately leaves it omitted/null.
    auto locked_policy = saved_policy;
    const auto lock_position = locked_policy.find("sourceLocaleLock: null");
    require(lock_position != std::string::npos, "Fixture has a sparse Source locale lock");
    locked_policy.replace(lock_position, std::string("sourceLocaleLock: null").size(),
                          "sourceLocaleLock: en");
    {
        std::ofstream output(policy, std::ios::binary | std::ios::trunc);
        output << locked_policy;
    }
    const auto messages_path = fixture.root / "i18n/messages.yaml";
    const auto message_source = contents(messages_path);
    const auto before_translation = contents(fixture.root / "i18n/locales/fr.yaml");
    const auto before_tracking = contents(fixture.root / "i18n/tracking.yaml");
    const auto before_usage = contents(fixture.root / "i18n/usage-notes.yaml");
    {
        std::ofstream output(messages_path, std::ios::binary | std::ios::trunc);
        output << "# Keep translator context on an unrelated Message\n" << message_source;
    }
    const auto before_messages = contents(messages_path);
    std::string error;
    auto project = ProjectSession::open(fixture.root, error);
    require(project != nullptr, error);
    require(project->snapshot().valid, "Valid localization is admitted in Project snapshot");
    require(contents(policy) == locked_policy, "Project open does not normalize source on disk");

    const auto inspected = project->inspect_record("i18n/messages.yaml");
    require(inspected.accepted && inspected.snapshot.valid,
            "Existing Message fragment has a native working owner");
    const auto edited =
        project->patch(project->snapshot().working_revision,
                       {{RoomPatch::Operation::Replace,
                         "/localization/messages/25700000-0000-4000-8000-000000000002/source",
                         "\"Read this letter\""}});
    require(edited.accepted && edited.snapshot.valid && contents(messages_path) == before_messages,
            "Working Message edits do not write source until Save");
    const auto saved =
        project->save_owners(project->snapshot().working_revision, {"i18n/messages.yaml"}, false,
                             TransactionDecision::KeepComments);
    require(saved.accepted && saved.snapshot.valid && contents(messages_path) != before_messages &&
                contents(messages_path).starts_with("# Keep translator context"),
            "Native Message fragment Save commits the changed source");
    auto reopened = validate_project_localization(fixture.root);
    require(reopened.accepted && Json::parse(reopened.effective_json)
                                         .at("messages")
                                         .at("25700000-0000-4000-8000-000000000002")
                                         .at("source") == "Read this letter",
            "Saved sparse Message source reopens with the same effective value");
    require(Json::parse(reopened.effective_json).at("translations").at("fr") ==
                    model.at("translations").at("fr") &&
                contents(fixture.root / "i18n/locales/fr.yaml") == before_translation &&
                contents(fixture.root / "i18n/tracking.yaml") == before_tracking &&
                contents(fixture.root / "i18n/usage-notes.yaml") == before_usage,
            "Message Save preserves target provenance, managed tracking and usage guidance");

    const auto blocked =
        project->patch(project->snapshot().working_revision,
                       {{RoomPatch::Operation::Replace, "/localization/sourceLocale", "\"fr\""}});
    require(blocked.accepted && !blocked.snapshot.valid && contents(policy) == locked_policy,
            "Invalid structural Source locale edit remains working-only");
    const auto rejected =
        project->save_owners(project->snapshot().working_revision, {"i18n/project.yaml"}, false,
                             TransactionDecision::KeepComments);
    require(!rejected.accepted && contents(policy) == locked_policy,
            "Source-lock violation blocks native Save without touching policy YAML");
    const auto restored =
        project->use_disk(project->snapshot().working_revision, "i18n/project.yaml");
    require(restored.accepted && restored.snapshot.valid,
            "Discarding invalid Source edit restores the valid working Project");

    const auto locale_path = fixture.root / "i18n/locales/fr.yaml";
    const auto before_locale = contents(locale_path);
    {
        std::ofstream output(locale_path, std::ios::binary | std::ios::trunc);
        output << "not-a-message: {}\n";
    }
    project->source_watch_hint("i18n/locales/fr.yaml");
    const auto changed = project->observe_sources();
    require(changed.authoritative && !project->snapshot().valid &&
                diagnostic(validate_project_localization(fixture.root),
                           "/localization/translations/fr/not-a-message"),
            "Observed external localization changes invalidate the native cache");
    {
        std::ofstream output(locale_path, std::ios::binary | std::ios::trunc);
        output << before_locale;
    }
    project->source_watch_hint("i18n/locales/fr.yaml");
    const auto repaired = project->observe_sources();
    require(repaired.authoritative && project->snapshot().valid,
            "Repaired external locale source becomes valid without reopening the Project");
}
} // namespace

int main(int argc, char** argv)
{
    try {
        require(argc == 2, "Expected Feature Lab Project path");
        certify(argv[1]);
        std::cout << "Native localization certification passed\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
