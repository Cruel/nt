#include "asset_animation_semantics.hpp"
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

void require(bool condition, std::string_view message)
{
    if (!condition)
        throw std::runtime_error(std::string(message));
}

bool has(const std::vector<Diagnostic>& diagnostics, std::string_view path)
{
    for (const auto& diagnostic : diagnostics)
        if (diagnostic.path == path)
            return true;
    return false;
}

std::string bytes(const std::filesystem::path& path)
{
    std::ifstream file(path, std::ios::binary);
    require(static_cast<bool>(file), "Fixture read failed");
    return {std::istreambuf_iterator<char>{file}, std::istreambuf_iterator<char>{}};
}

struct Fixture {
    std::filesystem::path root;
    explicit Fixture(const std::filesystem::path& source)
    {
        root = std::filesystem::temp_directory_path() /
               ("nt-488-" +
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
    std::string error;
    auto asset = RoomSession::open_record(fixture.root, "assets", "pilot-character-neutral", error);
    require(asset != nullptr, error);
    const auto initial = asset->snapshot();
    require(initial.valid, "Valid sparse image Asset normalizes");
    const auto effective = Json::parse(initial.normalized_json);
    require(effective.at("data").at("aliases").is_array() &&
                effective.at("data").at("kind") == "image",
            "Image Asset default aliases and explicit kind are preserved");
    const auto physical = fixture.root / "assets/images/girl_normal.webp";
    const auto physical_before = bytes(physical);
    const auto record_path = fixture.root / "records/assets/pilot-character-neutral.yaml";
    const auto before = bytes(record_path);
    const auto patched =
        asset->patch(initial.working_revision,
                     {{RoomPatch::Operation::Add, "/data/aliases/0", "\"hero.sprite\""}});
    require(patched.accepted && patched.snapshot.valid && patched.snapshot.dirty &&
                bytes(record_path) == before && bytes(physical) == physical_before,
            "Asset edits remain working-only, without changing media bytes");
    const auto saved = asset->save(initial.disk_source_revision);
    require(saved.accepted && saved.snapshot.valid && !saved.snapshot.dirty &&
                bytes(physical) == physical_before,
            "Asset Save commits only the YAML metadata");
    auto reopened =
        RoomSession::open_record(fixture.root, "assets", "pilot-character-neutral", error);
    require(reopened && reopened->snapshot().normalized_json == saved.snapshot.normalized_json,
            "Asset reopen retains identical normalized data");
    require(Json::parse(reopened->snapshot().source_json).at("data").at("aliases").at(0) ==
                "hero.sprite",
            "Saved Asset alias stays in sparse source");
    auto duplicate =
        reopened->patch(0, {{RoomPatch::Operation::Add, "/data/aliases/1", "\"hero.sprite\""}});
    require(duplicate.accepted && !duplicate.snapshot.valid &&
                has(duplicate.snapshot.diagnostics, "/data/aliases/1"),
            "Duplicate Asset alias is diagnosed and blocks Save");

    const auto data = Json::parse(initial.normalized_json).at("data");
    auto invalid_metadata = data;
    invalid_metadata["imageMetadata"] = Json::null();
    const auto structural = validate_record("AssetsRecord", [&] {
        auto record = effective;
        record["data"] = invalid_metadata;
        return record.to_string();
    }());
    require(!structural.accepted && has(structural.diagnostics, "/data/imageMetadata"),
            "Native Asset refinement matches image metadata requirement");
    invalid_metadata = data;
    invalid_metadata["attachments"] =
        Json::parse(R"([{"path":"../private","purpose":"reference"}])");
    const auto unsafe = validate_record("AssetsRecord", [&] {
        auto record = effective;
        record["data"] = invalid_metadata;
        return record.to_string();
    }());
    require(!unsafe.accepted && has(unsafe.diagnostics, "/data/attachments/0/path"),
            "Native attachment path operation rejects traversals");
    auto absent_attachment =
        asset->patch(patched.snapshot.working_revision,
                     {{RoomPatch::Operation::Add, "/data/attachments",
                       R"([{"path":"support/not-here.txt","purpose":"reference"}])"}});
    require(absent_attachment.accepted && !absent_attachment.snapshot.valid &&
                has(absent_attachment.snapshot.diagnostics, "/data/attachments/0/path"),
            "Missing physical attachment is diagnosed on its owning Asset");
    auto missing_media = effective;
    missing_media.at("data").at("source")["path"] = "assets/images/missing.webp";
    const auto missing_source = validate_asset_local(missing_media.to_string(), fixture.root);
    require(!missing_source.accepted && has(missing_source.diagnostics, "/data/source/path"),
            "Missing Asset source has a scoped diagnostic without opening media");

    auto animation =
        RoomSession::open_record(fixture.root, "animations", "guide-expression-loop", error);
    require(animation != nullptr, error);
    const auto animation_initial = animation->snapshot();
    require(animation_initial.valid &&
                Json::parse(animation_initial.normalized_json).at("data").at("kind") == "animation",
            "Sparse Animation source normalizes inferred kind");
    const auto original_animation = bytes(animation->source_path());
    auto changed = animation->patch(
        animation_initial.working_revision,
        {{RoomPatch::Operation::Replace, "/data/motions/0/frames/0/durationMs", "710"}});
    require(changed.accepted && changed.snapshot.valid &&
                bytes(animation->source_path()) == original_animation,
            "Animation frame edit remains working-only");
    const auto animation_saved = animation->save(animation_initial.disk_source_revision);
    require(animation_saved.accepted && animation_saved.snapshot.valid,
            "Animation Save commits valid edited frame");
    auto animation_reopened =
        RoomSession::open_record(fixture.root, "animations", "guide-expression-loop", error);
    require(animation_reopened && animation_reopened->snapshot().normalized_json ==
                                      animation_saved.snapshot.normalized_json,
            "Animation save and reopen preserve effective values");
    auto broken_default = animation_reopened->patch(
        0, {{RoomPatch::Operation::Replace, "/data/defaultMotionId", "\"missing\""}});
    require(broken_default.accepted && !broken_default.snapshot.valid &&
                has(broken_default.snapshot.diagnostics, "/data/defaultMotionId"),
            "Missing default motion is rejected with scoped diagnostic");

    // An ordinary native Project admission and YAML Save cannot read media
    // payloads, even when metadata can be safely inspected.
    std::filesystem::permissions(physical, std::filesystem::perms::none);
    auto project = ProjectSession::open(fixture.root, error);
    require(project != nullptr, error);
    const auto inspected = project->inspect_record("animations/guide-expression-loop");
    require(inspected.accepted && inspected.snapshot.valid,
            "Native Project validates Animation dependencies and localized Asset targets");
    const auto inspected_asset = project->inspect_record("assets/pilot-character-neutral");
    require(inspected_asset.accepted && inspected_asset.snapshot.valid,
            "Native Asset admission observes existing physical bytes without opening them");
    std::filesystem::permissions(physical, std::filesystem::perms::owner_read |
                                               std::filesystem::perms::owner_write);
    const auto alias_collision =
        project->patch(project->snapshot().working_revision,
                       {{RoomPatch::Operation::Add, "/assets/pilot-character-smile/data/aliases/0",
                         "\"hero.sprite\""}});
    require(alias_collision.accepted && !alias_collision.snapshot.valid &&
                has(alias_collision.snapshot.diagnostics,
                    "/assets/pilot-character-smile/data/aliases/0"),
            "Cross-Asset duplicate alias is diagnosed against the second owner");
    const auto missing = validate_animation_dependencies(
        animation_initial.normalized_json,
        [](std::string_view, std::string_view) -> std::optional<std::string> {
            return std::nullopt;
        });
    require(!missing.accepted && has(missing.diagnostics, "/data/motions/0/frames/0/image/$ref"),
            "Missing frame Image Asset produces exact diagnostic");
    auto bad_range = Json::parse(animation_initial.source_json);
    bad_range.at("data").at("motions").at(0) = Json::parse(
        R"({"id":"clip","kind":"video","video":"pilot-voice-audio","sourceRange":{"startMs":100,"endMs":50},"markers":[]})");
    const auto range = validate_animation_source(bad_range.to_string());
    require(!range.accepted && has(range.diagnostics, "/data/motions/0/sourceRange/endMs"),
            "Video range native operation rejects non-forward source ranges");

    const auto locale_path = fixture.root / "i18n/assets/fr.yaml";
    auto locale_source = bytes(locale_path);
    const auto variant_position = locale_source.find("id: locale-pattern");
    require(variant_position != std::string::npos, "Locale fixture variant exists");
    locale_source.replace(variant_position, std::string("id: locale-pattern").size(),
                          "id: pilot-voice-audio");
    {
        std::ofstream output(locale_path, std::ios::binary | std::ios::trunc);
        output << locale_source;
    }
    const AuthoringRecordResolver resource =
        [&](std::string_view family, std::string_view id) -> std::optional<std::string> {
        auto record =
            RoomSession::open_record(fixture.root, std::string(family), std::string(id), error);
        if (!record || !record->snapshot().valid)
            return std::nullopt;
        return record->snapshot().normalized_json;
    };
    const auto locale_invalid = validate_asset_localizations(fixture.root, resource);
    require(!locale_invalid.accepted &&
                has(locale_invalid.diagnostics, "/localization/assets/fr/ui-pattern/asset"),
            "Localized variant must have the same semantic Asset kind as its base");
}
} // namespace

int main(int argc, char** argv)
{
    if (argc != 2)
        return 2;
    try {
        certify(argv[1]);
        std::cout << "Asset/Animation native certification passed\n";
        return 0;
    } catch (const std::exception& e) {
        std::cerr << e.what() << '\n';
        return 1;
    }
}
