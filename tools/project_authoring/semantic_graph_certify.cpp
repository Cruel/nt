#include "room_session.hpp"

#include <jsoncons/json.hpp>

#include <chrono>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <iterator>
#include <set>
#include <stdexcept>
#include <string>

namespace {
using Json = jsoncons::ojson;
using noveltea::authoring::ProjectSession;
using noveltea::authoring::RoomPatch;

void require(bool condition, std::string_view why)
{
    if (!condition)
        throw std::runtime_error(std::string(why));
}

struct Fixture {
    std::filesystem::path root;
    explicit Fixture(const std::filesystem::path& source)
    {
        root = std::filesystem::temp_directory_path() /
               ("noveltea-graph-" +
                std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
        std::filesystem::copy(source, root, std::filesystem::copy_options::recursive);
    }
    ~Fixture()
    {
        std::error_code error;
        std::filesystem::remove_all(root, error);
    }
};

Json query(ProjectSession& project, std::uint64_t revision)
{
    return Json::parse(project.semantic_graph(revision));
}
} // namespace

int main(int argc, char** argv)
{
    try {
        require(argc == 2, "Usage: noveltea-semantic-graph-certify <fixture>");
        Fixture fixture(argv[1]);
        // Explicit, reference-independent oracle: the fixture includes a
        // valid Map and a source recognizer witness so all 16 generated record
        // families and all three evidence classes can be exercised without
        // invoking the retired TypeScript Project engine.
        std::filesystem::create_directories(fixture.root / "records/maps");
        std::ofstream(fixture.root / "records/maps/graph-oracle.yaml")
            << "id: graph-oracle\nlabel: Graph oracle\ndata:\n"
               "  locations:\n    - id: origin\n      room: active-text\n"
               "  connections: []\n";
        std::ofstream(fixture.root / "records/scripts/graph-oracle.yaml")
            << "id: graph-oracle\nlabel: Graph source oracle\ndata:\n"
               "  source:\n    kind: project-file\n    path: scripts/graph-oracle.lua\n";
        std::ofstream(fixture.root / "scripts/graph-oracle.lua")
            << "local message = Text.msg(\"lab.greeting\")\n"
            << "-- import(\"notice-board-hooks\") is a comment, never recognized\n"
            << "local import_id = import(\"feature-lab-bootstrap\")\n"
            << "hooks.register(\"room\", \"active-text\", \"enter\", "
               "\"notice-board-hooks\")\n"
            << "local current = noveltea.project.room(\"active-text\")\n"
            << "local missing = import(\"missing-script-oracle\")\n"
            << "local text = 'import(\"notice-board-hooks\")'\n";
        std::string error;
        auto project = ProjectSession::open(fixture.root, error);
        require(project != nullptr, "Cannot open graph fixture: " + error);
        const auto base = query(*project, 0);
        require(base.at("workingRevision") == 0, "Native graph lost working revision.");
        require(base.at("sourceRevisions").contains("project.yaml"),
                "Native graph requires an exact project source proof.");
        require(base.at("nodes").size() > 25, "Native graph must enumerate real Project records.");
        require(base.at("edges").size() > 10, "Native graph must preserve structural references.");
        std::set<std::string> collections;
        bool found_room = false, found_layout = false, found_trait = false, found_nested = false,
             found_message = false;
        for (const auto& node : base.at("nodes").array_range()) {
            const auto& key = node.at("key");
            const auto kind = key.at("kind").as<std::string>();
            if (kind == "record")
                collections.insert(key.at("collection").as<std::string>());
            found_room |= kind == "record" && key.at("collection") == "rooms";
            found_layout |= kind == "record" && key.at("collection") == "layouts";
            found_trait |= kind == "trait-definition";
            found_nested |= kind == "nested";
            found_message |= kind == "localization-message";
        }
        require(found_room && found_layout && found_trait && found_nested && found_message,
                "Native graph omitted record, trait, localized or nested identities.");
        require(collections.size() == 16, "Native graph must enumerate all 16 record collections.");
        bool room_asset = false, room_asset_repair = false, cursor = false;
        for (const auto& edge : base.at("edges").array_range()) {
            room_asset |= edge.at("role") == "room-background" &&
                          edge.at("target").at("kind") == "record" &&
                          edge.at("target").at("collection") == "assets";
            if (edge.at("role") == "room-background" &&
                edge.at("target").at("collection") == "assets") {
                const auto source = edge.at("sourcePath").as<std::string>();
                const auto expected = source.ends_with("/$ref") ? source.substr(0, source.size() - 5)
                                                                : source;
                room_asset_repair |= edge.at("repair").at("kind") == "set-null" &&
                                     edge.at("repair").at("path") == expected;
            }
            cursor |= edge.at("role") == "source-recognized-reference";
        }
        require(room_asset, "Native YAML scalar Asset roles are not indexed.");
        require(room_asset_repair,
                "Native nullable Room background references need exact set-null repair evidence.");
        bool lexical = false, exact = false, recognized_import = false, recognized_hook = false,
             recognized_room = false, false_comment = false, recognized_cursor = false;
        for (const auto& item : base.at("occurrences").array_range()) {
            lexical |= item.at("classification") == "possible-lexical";
            recognized_cursor |=
                item.contains("recognizedBy") &&
                item.at("recognizedBy") == "native.rcss-named-cursor" &&
                item.at("value") == "lab-marked" &&
                item.at("sourceUrl") == "project:/records/layouts/cursor-control-board/layout.rml";
            if (item.at("sourceUrl") == "project:/scripts/graph-oracle.lua" &&
                item.contains("recognizedBy")) {
                const auto by = item.at("recognizedBy").as<std::string>();
                recognized_import |= by == "noveltea.script-module-import" &&
                                     item.at("value") == "feature-lab-bootstrap";
                recognized_hook |=
                    by == "noveltea.room-hook-module" && item.at("value") == "notice-board-hooks";
                recognized_room |=
                    by == "noveltea.gameplay-identity" && item.at("value") == "active-text";
                false_comment |= by == "noveltea.script-module-import" &&
                                 item.at("value") == "notice-board-hooks";
            }
            if (item.at("classification") == "exact-rewriteable" &&
                item.at("sourceUrl") == "project:/scripts/graph-oracle.lua" &&
                item.at("value") == "lab.greeting") {
                require(item.contains("rewriteRange") &&
                            item.at("rewriteRange").at("expectedText") == "\"lab.greeting\"" &&
                            item.at("line") == 1 && item.at("column").as<std::size_t>() > 0,
                        "Native exact source range/position is not safe to rewrite.");
                exact = true;
            }
        }
        require(lexical && exact, "Native source query needs possible and exact rewrite evidence.");
        require(recognized_import && recognized_hook && recognized_room && recognized_cursor &&
                    !false_comment,
                "Native token recognizers: import=" + std::to_string(recognized_import) + " hook=" +
                    std::to_string(recognized_hook) + " room=" + std::to_string(recognized_room) +
                    " cursor=" + std::to_string(recognized_cursor) +
                    " false_comment=" + std::to_string(false_comment));
        bool missing_target = false;
        for (const auto& item : base.at("diagnostics").array_range())
            missing_target |= item.at("code") == "native.graph.missing_target" &&
                              item.at("path") == "/scripts/graph-oracle";
        require(missing_target,
                "Typed missing Script target must remain explicit native graph evidence.");
        require(query(*project, 0).to_string() == base.to_string(),
                "Native graph ordering must be deterministic.");
        const auto edit = project->patch(
            0, {{RoomPatch::Operation::Replace, "/project/name", R"("Graph certification")"}});
        require(edit.accepted, "Could not mutate dirty native Project working revision.");
        bool stale = false;
        try {
            query(*project, 0);
        } catch (const std::exception&) {
            stale = true;
        }
        require(stale, "Native graph accepted stale dirty working revision.");
        const auto dirty = query(*project, 1);
        require(dirty.at("workingRevision") == 1,
                "Dirty native graph did not bind the updated revision.");
        const auto again = project->patch(
            1, {{RoomPatch::Operation::Replace, "/project/name", R"("Graph revision two")"}});
        require(again.accepted, "Second working revision did not advance.");
        bool out_of_order = false;
        try {
            query(*project, 1);
        } catch (const std::exception&) {
            out_of_order = true;
        }
        require(out_of_order, "Out-of-order native graph revision was accepted.");
        const auto manifest = fixture.root / "project.yaml";
        std::ifstream in(manifest, std::ios::binary);
        std::string bytes{std::istreambuf_iterator<char>{in}, std::istreambuf_iterator<char>{}};
        in.close();
        std::ofstream out(manifest, std::ios::binary | std::ios::trunc);
        out << bytes << "# external graph invalidation\n";
        out.close();
        bool external = false;
        try {
            query(*project, 2);
        } catch (const std::exception&) {
            external = true;
        }
        require(external, "Native graph accepted externally stale Project source.");
        // A structurally representable but invalid dirty sibling must not
        // erase unrelated dependency evidence; mutation preflight will reject
        // the incomplete graph instead.
        Fixture invalid_fixture(argv[1]);
        auto invalid = ProjectSession::open(invalid_fixture.root, error);
        require(invalid != nullptr, "Could not open invalid-sibling native fixture.");
        const auto invalid_edit =
            invalid->patch(0, {{RoomPatch::Operation::Replace, "/rooms/active-text/label", "42"}});
        require(invalid_edit.accepted, "Invalid sibling must remain a dirty native working value.");
        const auto invalid_graph = query(*invalid, 1);
        require(!invalid_graph.at("complete").as<bool>() && invalid_graph.at("nodes").size() > 25,
                "Invalid dirty owner must mark incomplete while preserving other graph nodes.");

        // Two Script records can refer to the same physical text. A literal
        // recognized in that shared file has precise source provenance but
        // must be manual, never an automatically rewriteable owner mutation.
        Fixture shared(argv[1]);
        std::ofstream(shared.root / "scripts/graph-shared.lua")
            << "local message = Text.msg(\"lab.greeting\")\n";
        for (const char* id : {"graph-shared-a", "graph-shared-b"}) {
            std::ofstream(shared.root / (std::string("records/scripts/") + id + ".yaml"))
                << "id: " << id << "\nlabel: " << id
                << "\ndata:\n  source:\n"
                   "    kind: project-file\n    path: scripts/graph-shared.lua\n";
        }
        auto shared_project = ProjectSession::open(shared.root, error);
        require(shared_project != nullptr, "Cannot admit shared source fixture: " + error);
        const auto shared_graph = query(*shared_project, 0);
        std::set<std::string> shared_owners;
        for (const auto& occurrence : shared_graph.at("occurrences").array_range())
            if (occurrence.at("sourceUrl") == "project:/scripts/graph-shared.lua" &&
                occurrence.at("classification") == "exact-manual")
                shared_owners.insert(occurrence.at("ownerPath").as<std::string>());
        require(shared_owners.size() == 2,
                "Native graph must retain both owners and disallow shared source auto-rewrite.");
        std::cout << "Native graph record/trait/nested, revision and physical proof certified\n";
        return 0;
    } catch (const std::exception& e) {
        std::cerr << e.what() << '\n';
        return 1;
    }
}
