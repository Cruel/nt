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
    if (!initial.accepted)
        for (const auto& issue : initial.diagnostics)
            std::cerr << issue.path << " " << issue.message << "\n";
    require(initial.accepted, "Existing split Feature Lab localization is valid");
    {
        Fixture contributors(source);
        const auto locale_path = contributors.root / "i18n/locales/fr.yaml";
        const auto parsed = open_yaml_source(contents(locale_path));
        require(parsed.accepted, "Structured contributor translation fixture decodes");
        auto french = Json::parse(parsed.source_json);
        for (const auto& id :
             {"bb028069-11e3-57f5-9912-4e8b3b12aeb9", "a4530345-3681-5e51-a70d-0357585c53f5"}) {
            Json translation = Json::object();
            translation["text"] = "Localized source title";
            translation["origin"] = "ai";
            translation["review"] = "needs-review";
            translation["sourceFingerprint"] = "fnv1a:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
            french.insert_or_assign(id, std::move(translation));
        }
        std::ofstream(locale_path, std::ios::trunc) << french.to_string();
        std::string error;
        auto project = ProjectSession::open(contributors.root, error);
        require(project && project->snapshot().valid,
                "Translated Character and Interactable baseline opens");
        const auto changed_character =
            project->patch(0, {{RoomPatch::Operation::Replace,
                                "/characters/pilot-guide/data/displayName", R"("Guide {name}")"}});
        require(changed_character.accepted && !changed_character.snapshot.valid &&
                    diagnostic(ValidationResult{changed_character.snapshot.valid,
                                                {},
                                                changed_character.snapshot.diagnostics},
                               "/localization/translations/fr/"
                               "bb028069-11e3-57f5-9912-4e8b3b12aeb9/text"),
                "Dirty Character source revalidates its translation without inspecting Lua");
        const auto restored_character =
            project->patch(changed_character.snapshot.working_revision,
                           {{RoomPatch::Operation::Replace,
                             "/characters/pilot-guide/data/displayName", R"("Pilot Guide")"}});
        require(restored_character.accepted &&
                    std::none_of(restored_character.snapshot.diagnostics.begin(),
                                 restored_character.snapshot.diagnostics.end(),
                                 [](const Diagnostic& issue) {
                                     return issue.path.starts_with(
                                         "/localization/translations/fr/"
                                         "bb028069-11e3-57f5-9912-4e8b3b12aeb9/");
                                 }),
                "Repairing Character source clears its translation diagnostics");
        const auto changed_interactable = project->patch(
            restored_character.snapshot.working_revision,
            {{RoomPatch::Operation::Replace, "/interactables/lab-specimen/data/displayName",
              R"("Specimen {title}")"}});
        require(changed_interactable.accepted && !changed_interactable.snapshot.valid &&
                    diagnostic(ValidationResult{changed_interactable.snapshot.valid,
                                                {},
                                                changed_interactable.snapshot.diagnostics},
                               "/localization/translations/fr/"
                               "a4530345-3681-5e51-a70d-0357585c53f5/text"),
                "Dirty Interactable source revalidates its translation without Lua indexing");
    }
    require(contents(policy) == saved_policy, "Validation does not rewrite YAML");
    const auto model = Json::parse(initial.effective_json);
    require(model.at("sourceLocale") == "en" && model.at("locales").contains("fr-CA"),
            "Native model retains policy and locale definitions");
    {
        const auto tracking_file = open_yaml_source(contents(fixture.root / "i18n/tracking.yaml"));
        const auto french_file = open_yaml_source(contents(fixture.root / "i18n/locales/fr.yaml"));
        require(tracking_file.accepted && french_file.accepted,
                "Physical selector tracking test fixtures decode");
        auto tracking = Json::parse(tracking_file.source_json);
        auto french = Json::parse(french_file.source_json);
        const auto record_tracking = [&](std::string family, std::string owner, std::string path,
                                         std::string id, std::string source_text,
                                         std::string anchor, std::string snapshot) {
            Json item = Json::object();
            item["family"] = family;
            item["ownerKey"] = owner;
            item["sourcePath"] = path;
            item["sourceSnapshotFingerprint"] = snapshot;
            Json occurrence = Json::object();
            occurrence["messageId"] = id;
            occurrence["ordinal"] = 0;
            occurrence["sourceSnapshot"] = source_text;
            occurrence["sourceFingerprint"] = "fnv1a:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
            occurrence["structuralFingerprint"] = "fnv1a:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
            occurrence["anchorFingerprint"] = anchor;
            item["occurrences"] = Json::array();
            item["occurrences"].push_back(std::move(occurrence));
            tracking.insert_or_assign(family + ":" + owner + ":" + path, std::move(item));
            Json translated = Json::object();
            translated["text"] = "Traduit {name}";
            translated["origin"] = "ai";
            translated["review"] = "needs-review";
            translated["sourceFingerprint"] = "fnv1a:cccccccccccccccccccccccccccccccc";
            french.insert_or_assign(id, std::move(translated));
        };
        record_tracking(
            "lua", "record:scripts:notice-board", "/scripts/notice-board/data/source/path",
            "aaaaaaaa-aaaa-5aaa-8aaa-aaaaaaaaaaaa", "Saved {name}",
            "fnv1a:7d03e1d60f05a24285c1cde8c861e1a6", "fnv1a:dddddddddddddddddddddddddddddddd");
        const auto lua_path = std::string("scripts/notice-board.lua");
        const auto lua = std::string("Text.tr('Saved {title}', {title=1})");
        const auto script =
            validate_project_localization(fixture.root,
                                          {{"i18n/tracking.yaml", tracking.to_string()},
                                           {"i18n/locales/fr.yaml", french.to_string()}},
                                          {}, {{lua_path, analyze_project_text(lua_path, lua)}});
        require(!script.accepted && diagnostic(script, "/localization/translations/fr/"
                                                       "aaaaaaaa-aaaa-5aaa-8aaa-aaaaaaaaaaaa/text"),
                "Managed project-file Script Message resolves its selected physical source");
        record_tracking(
            "lua", "record:layouts:flow-counter", "/layouts/flow-counter/data/rml/sourceText",
            "bbbbbbbb-bbbb-5bbb-8bbb-bbbbbbbbbbbb", "Embedded {name}",
            "fnv1a:7d03e1d60f05a24285c1cde8c861e1a6", "fnv1a:ef784254c8287690aeda177eebad32a4");
        const auto asset_path = std::string("assets/ui/counter.rml");
        const auto markup =
            std::string("<rml><body><button onclick=\"Text.tr('Embedded {title}', {title=1})\">"
                        "Click</button></body></rml>");
        const auto asset =
            validate_project_localization(fixture.root,
                                          {{"i18n/tracking.yaml", tracking.to_string()},
                                           {"i18n/locales/fr.yaml", french.to_string()}},
                                          {},
                                          {{asset_path, analyze_project_text(asset_path, markup)},
                                           {lua_path, analyze_project_text(lua_path, lua)}});
        require(!asset.accepted && diagnostic(asset, "/localization/translations/fr/"
                                                     "bbbbbbbb-bbbb-5bbb-8bbb-bbbbbbbbbbbb/text"),
                "Embedded Lua tracking resolves through Asset-backed Layout RML selector");
    }
    {
        const auto rml_path = std::string("records/layouts/language-board/layout.rml");
        const auto saved = contents(fixture.root / rml_path);
        auto changed = saved;
        const auto at = changed.find("Managed reading desk");
        require(at != std::string::npos, "RML tracked local Message fixture exists");
        changed.replace(at, sizeof("Managed reading desk") - 1, "Managed reading desk {newName}");
        const auto dirty = validate_project_localization(
            fixture.root, {}, {}, {{rml_path, analyze_project_text(rml_path, changed)}});
        require(!dirty.accepted && diagnostic(dirty, "/localization/translations/fr/"
                                                     "f0b75a61-85b2-53fd-9d5f-5b43eb6bb8f1/text"),
                "RML local tracking ignores preceding named nodes and binds changed content");
        const auto inserted = std::string("<nt-tr>New {newName}</nt-tr>\n") + saved;
        const auto reordered = validate_project_localization(
            fixture.root, {}, {}, {{rml_path, analyze_project_text(rml_path, inserted)}});
        require(reordered.accepted,
                "Inserting a new local RML node does not transfer the old tracked Message ID");
        auto inserted_and_changed = inserted;
        const auto original = inserted_and_changed.find("Managed reading desk");
        require(original != std::string::npos, "Original RML local remains after insertion");
        inserted_and_changed.replace(original, sizeof("Managed reading desk") - 1,
                                     "Managed reading desk {title}");
        const auto identity = validate_project_localization(
            fixture.root, {}, {},
            {{rml_path, analyze_project_text(rml_path, inserted_and_changed)}});
        require(!identity.accepted &&
                    diagnostic(identity, "/localization/translations/fr/"
                                         "f0b75a61-85b2-53fd-9d5f-5b43eb6bb8f1/text"),
                "RML identity follows the original local Message through insertion and edits");
    }
    {
        // Fingerprints below are computed with the TypeScript tracking oracle:
        // /\s+/gu and .trim() normalize the non-breaking space in the tag.
        // Neither an old anchor nor the unchanged-source ordinal fallback can
        // rescue the identity after the surrounding markup and content change.
        const auto rml_path = std::string("records/layouts/language-board/layout.rml");
        const auto open_tag = std::string("<nt-tr class=\"a") + "\xc2\xa0" + "b\">";
        const auto original = "<rml><body>" + open_tag + "<b>Hello</b></nt-tr></body></rml>";
        const auto dirty = "<rml><head><title>Changed</title></head><body>" + open_tag +
                           "<b>Hello {name}</b></nt-tr></body></rml>";
        const auto tracked_yaml = open_yaml_source(contents(fixture.root / "i18n/tracking.yaml"));
        require(tracked_yaml.accepted, "Unicode whitespace tracking fixture is readable");
        auto tracking = Json::parse(tracked_yaml.source_json);
        auto& entry = tracking.at(
            "rml:record:layouts:language-board:/layouts/language-board/data/rml/sourceText");
        auto& prior = entry["occurrences"][0];
        prior["sourceSnapshot"] = "<b>Hello</b>";
        prior["sourceFingerprint"] = "fnv1a:ec844aacf7d465489a8190fa47ff4c1c";
        prior["structuralFingerprint"] = "fnv1a:f95dad3c3c15b3b0affdacbaca12aa0c";
        prior["anchorFingerprint"] = "fnv1a:bd655112307ca6ce6716bec82a7305c2";
        entry["sourceSnapshotFingerprint"] = "fnv1a:93b1aff796ace1f373be4a95d62a66e7";
        const auto preserved = validate_project_localization(
            fixture.root, {{"i18n/tracking.yaml", tracking.to_string()}}, {},
            {{rml_path, analyze_project_text(rml_path, original)}});
        require(preserved.accepted, "Original RML source matches its tracked baseline");
        const auto changed = validate_project_localization(
            fixture.root, {{"i18n/tracking.yaml", tracking.to_string()}}, {},
            {{rml_path, analyze_project_text(rml_path, dirty)}});
        require(!changed.accepted &&
                    diagnostic(changed, "/localization/translations/fr/"
                                        "f0b75a61-85b2-53fd-9d5f-5b43eb6bb8f1/text"),
                "Unicode-space structural fingerprint preserves a local RML Message identity "
                "when content and surrounding anchors change");
    }
    {
        const auto scene_path = fixture.root / "records/scenes/localized-story.yaml";
        const auto opened = open_yaml_source(contents(scene_path));
        require(opened.accepted, "Lua tracking reorder fixture opens");
        auto scene = Json::parse(opened.source_json);
        auto& source_text = scene["data"]["events"][0]["source"];
        const auto inserted = std::string("local scratch=Text.tr('Preview {title}',"
                                          "{title='A'}); ") +
                              source_text.as<std::string>();
        source_text = inserted;
        const auto source_path =
            std::string("inline/scenes/localized-story/data/events/0/source.lua");
        const auto check = validate_project_localization(
            fixture.root, {}, {{"records/scenes/localized-story.yaml", scene.to_string()}},
            {{source_path, analyze_project_text(source_path, inserted)}});
        require(check.accepted,
                "Inserting a new managed Lua call cannot shift existing tracked Message IDs");
        auto changed_after_insert = inserted;
        const auto original = changed_after_insert.find("Managed letter for {name}");
        require(original != std::string::npos, "Original Lua local remains after insertion");
        changed_after_insert.replace(original, sizeof("Managed letter for {name}") - 1,
                                     "Managed letter for {title}");
        // Keep the call's runtime arguments static and valid, allowing the
        // localization contract (rather than Lua argument validation) to
        // surface the changed source Message.
        const auto argument = changed_after_insert.find("{name='Ada'}", original);
        require(argument != std::string::npos, "Original managed arguments remain intact");
        changed_after_insert.replace(argument, sizeof("{name='Ada'}") - 1, "{title='Ada'}");
        scene["data"]["events"][0]["source"] = changed_after_insert;
        const auto moved = validate_project_localization(
            fixture.root, {}, {{"records/scenes/localized-story.yaml", scene.to_string()}},
            {{source_path, analyze_project_text(source_path, changed_after_insert)}});
        require(!moved.accepted && diagnostic(moved, "/localization/translations/fr/"
                                                     "48d01321-b758-5fcd-8380-42872aef0bd1/text"),
                "Lua tracking retains a Message ID after insertion and source-literal edits");
    }
    require(
        model.at("sourceLocaleLock") == "en" &&
            contents(policy).find("sourceLocaleLock: null") != std::string::npos,
        "Substantive translation work materializes an effective lock without rewriting the source");
    // A dirty gameplay TextContent changes the Message's source contract.
    // The saved French translation must not be validated against disk YAML.
    const auto verb_yaml = open_yaml_source(contents(fixture.root / "records/verbs/deliver.yaml"));
    require(verb_yaml.accepted, "Gameplay Message fixture is readable");
    auto dirty_verb = Json::parse(verb_yaml.source_json);
    dirty_verb["data"]["completedCommandText"]["source"]["text"] = "Deliver {title}";
    const auto dirty_structured = validate_project_localization(
        fixture.root, {}, {{"records/verbs/deliver.yaml", dirty_verb.to_string()}});
    require(
        !dirty_structured.accepted &&
            diagnostic(dirty_structured,
                       "/localization/translations/fr/07203395-f20c-5d69-8d8b-2547b934eaa5/text"),
        "Dirty gameplay structured Message invalidates a saved translation");
    const auto scene_yaml =
        open_yaml_source(contents(fixture.root / "records/scenes/localized-story.yaml"));
    require(scene_yaml.accepted, "Managed Scene localization fixture is readable");
    auto dirty_scene = Json::parse(scene_yaml.source_json);
    auto& scene_lua = dirty_scene["data"]["events"][0]["source"];
    auto lua = scene_lua.as<std::string>();
    const auto old_literal = std::string("Managed letter for {name}', {name='Ada'}");
    const auto old_at = lua.find(old_literal);
    require(old_at != std::string::npos, "Tracked managed literal is present");
    lua.replace(old_at, old_literal.size(), "Managed letter for {title}', {title='Ada'}");
    scene_lua = lua;
    const auto physical = std::string("inline/scenes/localized-story/data/events/0/source.lua");
    const auto dirty_managed = validate_project_localization(
        fixture.root, {}, {{"records/scenes/localized-story.yaml", dirty_scene.to_string()}},
        {{physical, analyze_project_text(physical, lua)}});
    require(
        !dirty_managed.accepted &&
            diagnostic(dirty_managed,
                       "/localization/translations/fr/48d01321-b758-5fcd-8380-42872aef0bd1/text"),
        "Dirty tracked-only Lua Message invalidates a saved translation");
    std::string working_error;
    auto working = ProjectSession::open(fixture.root, working_error);
    require(working != nullptr, "Working localization fixture opens");
    const auto changed_gameplay = working->patch(
        0, {{RoomPatch::Operation::Replace, "/verbs/deliver/data/completedCommandText/source/text",
             R"("Deliver {title}")"}});
    require(changed_gameplay.accepted && !changed_gameplay.snapshot.valid &&
                std::any_of(changed_gameplay.snapshot.diagnostics.begin(),
                            changed_gameplay.snapshot.diagnostics.end(),
                            [](const Diagnostic& entry) {
                                return entry.path == "/localization/translations/fr/"
                                                     "07203395-f20c-5d69-8d8b-2547b934eaa5/text";
                            }),
            "ProjectSession invalidates cached localization after an unsaved gameplay edit");

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
    const auto saved_french = open_yaml_source(contents(fixture.root / "i18n/locales/fr.yaml"));
    require(saved_french.accepted, "French locale fixture can be decoded");
    const auto french = Json::parse(saved_french.source_json);
    auto unknown_uuid = french;
    unknown_uuid.insert_or_assign("ffffffff-ffff-4fff-8fff-ffffffffffff",
                                  french.at("25700000-0000-4000-8000-000000000002"));
    const auto missing_message = validate_project_localization(
        fixture.root, {{"i18n/locales/fr.yaml", unknown_uuid.to_string()}});
    require(!missing_message.accepted &&
                diagnostic(missing_message,
                           "/localization/translations/fr/ffffffff-ffff-4fff-8fff-ffffffffffff"),
            "Structurally valid unknown translation Message UUID is rejected");
    auto missing_placeholder = french;
    missing_placeholder["25700000-0000-4000-8000-000000000001"]["text"] = "Bonjour";
    const auto placeholder_error = validate_project_localization(
        fixture.root, {{"i18n/locales/fr.yaml", missing_placeholder.to_string()}});
    require(
        !placeholder_error.accepted &&
            diagnostic(placeholder_error,
                       "/localization/translations/fr/25700000-0000-4000-8000-000000000001/text"),
        "Target translation cannot drop source Message placeholders");
    auto changed_selector = french;
    changed_selector["25700000-0000-4000-8000-000000000004"]["pattern"]["argument"] = "otherArg";
    const auto selector_error = validate_project_localization(
        fixture.root, {{"i18n/locales/fr.yaml", changed_selector.to_string()}});
    require(!selector_error.accepted &&
                diagnostic(
                    selector_error,
                    "/localization/translations/fr/25700000-0000-4000-8000-000000000004/pattern"),
            "Translated selector signatures must match the source Message contract");
    {
        Fixture cues_fixture(source);
        const auto dialogue_file = cues_fixture.root / "records/dialogues/effects-camera.yaml";
        const auto decoded = open_yaml_source(contents(dialogue_file));
        require(decoded.accepted, "Dialogue Cue source fixture decodes");
        auto dialogue = Json::parse(decoded.source_json);
        Json localized = Json::object();
        localized["kind"] = "localized";
        localized["key"] = "lab.greeting";
        dialogue["data"]["blocks"][0]["segments"][0]["text"]["source"] = localized;
        std::ofstream(dialogue_file) << dialogue.to_string();
        const auto cue_error = validate_project_localization(cues_fixture.root);
        require(!cue_error.accepted &&
                    diagnostic(cue_error, "/localization/translations/fr/"
                                          "25700000-0000-4000-8000-000000000001/dialogueCues"),
                "Target translation must preserve source Dialogue Cue identity");
        auto corrected = french;
        Json cues = Json::array();
        Json cue = Json::object();
        cue["id"] = "shake";
        cue["position"] = Json::parse(R"({"offset":0,"order":0})");
        cues.push_back(cue);
        corrected["25700000-0000-4000-8000-000000000001"]["dialogueCues"] = std::move(cues);
        std::map<std::string, std::string> corrected_locales{
            {"i18n/locales/fr.yaml", corrected.to_string()}};
        for (const auto* locale : {"ar", "ja"}) {
            const auto path = std::string("i18n/locales/") + locale + ".yaml";
            const auto opened = open_yaml_source(contents(cues_fixture.root / path));
            require(opened.accepted, "Cue locale source can be decoded");
            auto target = Json::parse(opened.source_json);
            target["25700000-0000-4000-8000-000000000001"]["dialogueCues"] =
                corrected["25700000-0000-4000-8000-000000000001"]["dialogueCues"];
            corrected_locales.emplace(path, target.to_string());
        }
        const auto repaired = validate_project_localization(cues_fixture.root, corrected_locales);
        if (!repaired.accepted)
            for (const auto& issue : repaired.diagnostics)
                std::cerr << "Repaired Cue diagnostic: " << issue.path << " [" << issue.code << "] "
                          << issue.message << "\n";
        require(repaired.accepted, "Correct Dialogue Cue translation clears native error");
    }

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
    if (!project->snapshot().valid)
        for (const auto& issue : project->snapshot().diagnostics)
            std::cerr << issue.path << " [" << issue.code << "] " << issue.message << "\n";
    require(project->snapshot().valid, "Valid localization is admitted in Project snapshot");
    // Reconciliation replaces the complete physical tracking map, not a
    // single occurrence. Production must route that operation to the native
    // i18n/tracking.yaml owner and keep the disk untouched until Save.
    const auto replaced_tracking =
        project->patch(project->snapshot().working_revision,
                       {{RoomPatch::Operation::Replace, "/localization/sourceMessageTracking",
                         model.at("sourceMessageTracking").to_string()}});
    require(replaced_tracking.accepted && replaced_tracking.snapshot.valid &&
                contents(fixture.root / "i18n/tracking.yaml") == before_tracking,
            "Whole tracking-map reconciliation is admitted natively without early disk writes");
    auto dirty_assets = ProjectSession::open(fixture.root, error);
    require(dirty_assets != nullptr, "Dirty Asset localization fixture opens");
    const auto altered_asset = dirty_assets->patch(
        0, {{RoomPatch::Operation::Replace, "/localization/assets/fr/ui-pattern/asset/$ref/id",
             R"("missing-localized-asset")"}});
    require(altered_asset.accepted && !altered_asset.snapshot.valid &&
                std::any_of(altered_asset.snapshot.diagnostics.begin(),
                            altered_asset.snapshot.diagnostics.end(),
                            [](const Diagnostic& issue) {
                                return issue.path == "/localization/assets/fr/ui-pattern/asset" &&
                                       issue.code == "localization.asset.variant-missing";
                            }) &&
                contents(fixture.root / "i18n/assets/fr.yaml").find("missing-localized-asset") ==
                    std::string::npos,
            "Dirty locale mapping detects missing localized Asset without reading old disk values");
    const auto repaired_asset = dirty_assets->patch(
        altered_asset.snapshot.working_revision,
        {{RoomPatch::Operation::Replace, "/localization/assets/fr/ui-pattern/asset/$ref/id",
          R"("locale-pattern")"}});
    require(repaired_asset.accepted && repaired_asset.snapshot.valid,
            "Restoring dirty localized Asset mapping clears dependent diagnostics");
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
