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

std::string read(const std::filesystem::path& path)
{
    std::ifstream input(path, std::ios::binary);
    require(static_cast<bool>(input), "Cannot read Layout fixture.");
    return {std::istreambuf_iterator<char>{input}, std::istreambuf_iterator<char>{}};
}

void write(const std::filesystem::path& path, const std::string& bytes)
{
    std::ofstream output(path, std::ios::binary | std::ios::trunc);
    require(static_cast<bool>(output), "Cannot write Layout fixture.");
    output << bytes;
    require(static_cast<bool>(output), "Cannot finish Layout fixture write.");
}

struct Fixture {
    std::filesystem::path root;
    explicit Fixture(const std::filesystem::path& source)
    {
        root = std::filesystem::temp_directory_path() /
               ("nt-490-" +
                std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
        std::filesystem::copy(source, root, std::filesystem::copy_options::recursive);
    }
    ~Fixture()
    {
        std::error_code ignored;
        std::filesystem::remove_all(root, ignored);
    }
};

void certify(const std::filesystem::path& source)
{
    Fixture fixture(source);
    std::string error;
    const auto metadata = fixture.root / "records/layouts/notice-board/layout.yaml";
    const auto markup = fixture.root / "records/layouts/notice-board/layout.rml";
    auto original = read(metadata);
    const auto comment_anchor = original.find("  contract:");
    require(comment_anchor != std::string::npos, "Expected contract metadata anchor");
    original.insert(comment_anchor, "  # keep Layout contract context\n");
    write(metadata, original);
    auto layout = RoomSession::open_record(fixture.root, "layouts", "notice-board", error);
    require(layout != nullptr, error);
    auto snapshot = layout->snapshot();
    if (!snapshot.valid)
        for (const auto& issue : snapshot.diagnostics)
            std::cerr << issue.path << ": " << issue.code << ": " << issue.message << '\n';
    require(snapshot.valid, "Sparse Layout YAML and file-backed companions must normalize");
    require(layout->snapshot().normalized_json == snapshot.normalized_json,
            "Unchanged Layout companion sources reuse normalized data");
    const auto initial_markup = read(markup);
    std::filesystem::remove(markup);
    require(!layout->snapshot().valid &&
                has(layout->snapshot().diagnostics, "/data/rml/sourceMode"),
            "Removing a Layout companion invalidates the same resident snapshot");
    write(markup, initial_markup);
    require(layout->snapshot().valid &&
                layout->snapshot().normalized_json == snapshot.normalized_json,
            "Restoring the Layout companion returns the original normalized record");
    const auto normalized = Json::parse(snapshot.normalized_json);
    const auto optional_layout = fixture.root / "records/layouts/counter-fragment/layout.yaml";
    auto optional_record =
        RoomSession::open_record(fixture.root, "layouts", "counter-fragment", error);
    require(optional_record && optional_record->snapshot().valid,
            "Layout with explicit sparse dependencies is valid");
    auto optional_data = Json::parse(optional_record->snapshot().normalized_json).at("data");
    require(optional_data.at("dependencies").contains("data") &&
                !optional_data.at("dependencies").contains("templates"),
            "Explicit Layout dependencies do not gain an omitted optional templates field");
    auto optional_bytes = read(optional_layout);
    const auto dependency_start = optional_bytes.find("  dependencies:\n");
    const auto dependency_end = optional_bytes.find("  layoutKind:", dependency_start);
    require(dependency_start != std::string::npos && dependency_end != std::string::npos,
            "Expected sparse Layout dependency block");
    optional_bytes.erase(dependency_start, dependency_end - dependency_start);
    write(optional_layout, optional_bytes);
    optional_record = RoomSession::open_record(fixture.root, "layouts", "counter-fragment", error);
    require(optional_record && optional_record->snapshot().valid,
            "Layout with omitted dependency container is valid");
    optional_data = Json::parse(optional_record->snapshot().normalized_json).at("data");
    require(optional_data.at("dependencies").contains("templates") &&
                optional_data.at("dependencies").at("templates").empty(),
            "Omitted Layout dependency container retains its full schema default");
    require(normalized.at("data").at("rml").at("sourceMode") == "inline" &&
                normalized.at("data").at("rml").at("sourceText") == read(markup) &&
                normalized.at("data").at("layoutKind") == "document" &&
                normalized.at("data").at("dependencies").at("data").at(0).at("$ref").at("id") ==
                    "notice-board-data",
            "Layout normalization materializes companions, defaults, and compact references");
    auto project = ProjectSession::open(fixture.root, error);
    require(project != nullptr, error);
    auto inspected = project->inspect_record("layouts/notice-board");
    require(inspected.accepted && inspected.snapshot.valid,
            "Native Project inspection admits a Layout owner");

    const auto nested = project->patch(
        project->snapshot().working_revision,
        {{RoomPatch::Operation::Add, "/layouts/notice-board/data/contract/inputs/score",
          R"({"type":"integer","defaultValue":3})"}});
    require(nested.accepted && nested.snapshot.valid && nested.snapshot.dirty,
            "Nested Layout contract fields can be edited in the native working Project");
    const auto saved =
        project->save_owners(nested.snapshot.working_revision, {"layouts/notice-board"}, false,
                             TransactionDecision::UseEditDecisions);
    require(saved.accepted && saved.snapshot.valid && !saved.snapshot.dirty &&
                read(markup) == normalized.at("data").at("rml").at("sourceText").as<std::string>(),
            "Scoped Layout YAML Save cannot rewrite companion RML");
    layout = RoomSession::open_record(fixture.root, "layouts", "notice-board", error);
    require(layout && layout->snapshot().valid &&
                Json::parse(layout->snapshot().normalized_json)
                        .at("data")
                        .at("contract")
                        .at("inputs")
                        .at("score")
                        .at("defaultValue") == 3,
            "Nested Layout contract edits survive source-aware Save and reopen");
    const auto after = read(metadata);
    require(after != original &&
                after.find("# keep Layout contract context") != std::string::npos &&
                after.find("notice_board_ui") != std::string::npos &&
                after.find("score") != std::string::npos,
            "Nested edits preserve physical YAML comments and unrelated metadata");
    auto no_op = project->save_owners(saved.snapshot.working_revision, {"layouts/notice-board"},
                                      false, TransactionDecision::UseEditDecisions);
    require(no_op.accepted && read(metadata) == after, "No-op Layout Save preserves exact bytes");

    // File-backed source diagnostics retain the physical companion, not the
    // YAML metadata location, while their logical pointer remains editable.
    write(markup, "<div>fragment body</div>\n");
    layout = RoomSession::open_record(fixture.root, "layouts", "notice-board", error);
    require(layout && layout->snapshot().valid &&
                has(layout->snapshot().diagnostics, "/data/rml/sourceText"),
            "Document Layout missing document tags emits a nonblocking source warning");
    bool physical = false;
    for (const auto& issue : layout->snapshot().diagnostics)
        if (issue.path == "/data/rml/sourceText" &&
            issue.source_path == "records/layouts/notice-board/layout.rml")
            physical = true;
    require(physical, "Invalid RML points at the owning companion source");
    write(markup, normalized.at("data").at("rml").at("sourceText").as<std::string>());

    // Nested refinements are generated schema operations, not merely JSON types.
    auto invalid = layout->patch(0, {{RoomPatch::Operation::Add, "/data/contract/inputs/broken",
                                      R"({"type":"boolean","defaultValue":4})"}});
    require(invalid.accepted && !invalid.snapshot.valid &&
                has(invalid.snapshot.diagnostics, "/data/contract/inputs/broken/defaultValue"),
            "Invalid nested input default has a precise YAML field path");
    auto state = layout->patch(
        invalid.snapshot.working_revision,
        {{RoomPatch::Operation::Add, "/data/contract/state",
          R"({"type":"object","fields":{"required_item":{"required":true,"shape":{"type":"string"}}},"defaultValue":{}})"}});
    require(state.accepted && !state.snapshot.valid &&
                has(state.snapshot.diagnostics, "/data/contract/state/defaultValue"),
            "Recursive State Shape rejects omitted required default fields");

    auto malformed = Json::parse(layout->snapshot().source_json);
    malformed.at("data").at("lua")["sourceMode"] = "asset";
    auto rejected = validate_layout_source(
        malformed.to_string(),
        {{"rml", read(markup)},
         {"rcss", read(fixture.root / "records/layouts/notice-board/layout.rcss")},
         {"lua", read(fixture.root / "records/layouts/notice-board/layout.lua")}});
    require(!rejected.accepted && has(rejected.diagnostics, "/data/lua"),
            "Obsolete Lua Asset selectors are not admitted");
    malformed.at("data").at("lua")["sourceMode"] = "none";
    rejected = validate_layout_source(
        malformed.to_string(),
        {{"rml", read(markup)},
         {"rcss", read(fixture.root / "records/layouts/notice-board/layout.rcss")},
         {"lua", read(fixture.root / "records/layouts/notice-board/layout.lua")}});
    require(!rejected.accepted && has(rejected.diagnostics, "/data/lua/sourceMode"),
            "An orphan Lua companion is rejected at the owning source selector");
    malformed = Json::parse(layout->snapshot().source_json);
    malformed.at("data")["kind"] = "room";
    rejected = validate_layout_source(
        malformed.to_string(),
        {{"rml", read(markup)},
         {"rcss", read(fixture.root / "records/layouts/notice-board/layout.rcss")},
         {"lua", read(fixture.root / "records/layouts/notice-board/layout.lua")}});
    require(!rejected.accepted && has(rejected.diagnostics, "/data/kind"),
            "An explicitly authored Layout kind cannot be overwritten by projection");

    auto fragment =
        RoomSession::open_record(fixture.root, "layouts", "inline-event-fragment", error);
    require(fragment && fragment->snapshot().valid &&
                Json::parse(fragment->snapshot().normalized_json)
                        .at("data")
                        .at("lua")
                        .at("sourceText") == "",
            "Fragment Layout admits asset-backed RCSS and none Lua source selectors");

    for (const auto& entry :
         std::filesystem::directory_iterator(fixture.root / "records/layouts")) {
        if (!entry.is_directory())
            continue;
        auto other = RoomSession::open_record(fixture.root, "layouts",
                                              entry.path().filename().string(), error);
        require(other && other->snapshot().valid,
                "Every canonical Feature Lab Layout must pass native structural admission");
    }

    // Physical watcher invalidity stays attributable to this Layout YAML, not
    // to unrelated Project or Asset sources.
    write(metadata, "data: [not a mapping\n");
    const auto invalid_source = project->observe_sources();
    bool attributed = false;
    for (const auto& source : invalid_source.invalid_sources)
        if (source.path == "records/layouts/notice-board/layout.yaml")
            attributed = true;
    require(attributed && !invalid_source.authoritative,
            "Changed malformed Layout metadata invalidates its physical owner");
    write(metadata, after);
    const auto repaired = project->observe_sources();
    require(repaired.authoritative && repaired.invalid_sources.empty(),
            "Repaired Layout YAML restores native source authority");
}
} // namespace

int main(int argc, char** argv)
{
    try {
        require(argc == 2, "Expected Feature Lab Project path");
        certify(argv[1]);
        std::cout << "Native Layout authoring certification passed.\n";
    } catch (const std::exception& error) {
        std::cerr << "Native Layout authoring certification failed: " << error.what() << '\n';
        return 1;
    }
}
