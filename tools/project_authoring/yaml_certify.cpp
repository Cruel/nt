#include "yaml_codec.hpp"

#include <jsoncons/json.hpp>

#include <iostream>
#include <iterator>
#include <string>
#include <vector>

using noveltea::authoring::edit_yaml_source;
using noveltea::authoring::open_yaml_source;
using noveltea::authoring::YamlCommentDisposition;
using noveltea::authoring::YamlValueEdit;

namespace {
int failures = 0;
void require(bool ok, const std::string& description)
{
    if (!ok) {
        std::cerr << "FAIL: " << description << '\n';
        ++failures;
    }
}
} // namespace

int main(int argc, char** argv)
{
    // The standalone certification executable exposes the exact same host-only native
    // codec to the TypeScript Project Workspace differential suite.
    if (argc > 1) {
        if (std::string_view(argv[1]) != "--open" && std::string_view(argv[1]) != "--edit")
            return 2;
        const std::string source{std::istreambuf_iterator<char>(std::cin),
                                 std::istreambuf_iterator<char>()};
        noveltea::authoring::YamlSourceResult result;
        if (std::string_view(argv[1]) == "--open" && argc == 2) {
            result = open_yaml_source(source);
        } else if (std::string_view(argv[1]) == "--edit" && argc >= 4 && argc <= 6) {
            YamlValueEdit edit{argv[2], argv[3]};
            if (argc >= 5) {
                if (std::string_view(argv[4]) != "Keep" && std::string_view(argv[4]) != "Remove")
                    return 2;
                edit.comments = std::string_view(argv[4]) == "Remove"
                                    ? YamlCommentDisposition::Remove
                                    : YamlCommentDisposition::Keep;
            }
            if (argc == 6)
                edit.omission_default_json = argv[5];
            result = edit_yaml_source(source, {edit});
        } else {
            return 2;
        }
        jsoncons::ojson output = jsoncons::ojson::object();
        output.insert_or_assign("accepted", result.accepted);
        // Rejected input may contain invalid UTF-8; never serialize those bytes into JSON.
        output.insert_or_assign("source", result.accepted ? result.source : "");
        if (result.accepted) {
            output.insert_or_assign("value", jsoncons::ojson::parse(result.source_json));
            auto locations = jsoncons::ojson::array();
            for (const auto& location : result.locations) {
                auto item = jsoncons::ojson::object();
                item.insert_or_assign("path", location.path);
                item.insert_or_assign("begin", location.begin);
                item.insert_or_assign("end", location.end);
                item.insert_or_assign("line", location.line);
                item.insert_or_assign("column", location.column);
                item.insert_or_assign("hasComment", location.has_comment);
                locations.push_back(std::move(item));
            }
            output.insert_or_assign("locations", std::move(locations));
        } else {
            output.insert_or_assign("error", result.error);
            if (result.error_offset)
                output.insert_or_assign("offset", *result.error_offset);
        }
        std::cout << output.to_string() << '\n';
        return 0;
    }
    const std::string room = "# Room author notes\n"
                             "id: station\n"
                             "label: Station # source label\n"
                             "data:\n"
                             "  description: A small station\n"
                             "  exits:\n"
                             "    - id: door\n"
                             "      destination: corridor # route note\n"
                             "    - id: hatch\n"
                             "      destination: basement\n"
                             "  presentationSpace:\n"
                             "    edgePolicy: contain # explicit default\n"
                             "    views: []\n";
    const auto opened = open_yaml_source(room);
    require(opened.accepted, "nested Room YAML opens");
    require(opened.source == room, "open/validate leaves physical source unchanged");
    require(opened.source_json.find("\"destination\":\"corridor\"") != std::string::npos,
            "nested list entry is decoded");
    bool found = false;
    for (const auto& loc : opened.locations)
        if (loc.path == "/data/exits/0/destination") {
            found = true;
            require(loc.line == 8 && loc.column == 20, "nested source location");
        }
    require(found, "nested source provenance exists");
    for (const auto& loc : opened.locations)
        require(loc.path != "/data/background", "sparse omission not fabricated as null");

    auto keep = edit_yaml_source(room, {{"/data/exits/0/destination", "\"foyer\""}});
    if (!keep.accepted)
        std::cerr << "Keep error: " << keep.error << '\n';
    require(keep.accepted, "native Room field edit reopens");
    require(keep.source.find("destination: foyer # route note") != std::string::npos,
            "Keep preserves inline comment and original plain style");
    require(keep.source.find("# Room author notes") == 0 &&
                keep.source.find("    - id: hatch\n      destination: basement") !=
                    std::string::npos,
            "untouched source bytes and sibling list entry preserved");

    auto remove = edit_yaml_source(
        room, {{"/data/exits/0/destination", "\"foyer\"", YamlCommentDisposition::Remove}});
    if (!remove.accepted)
        std::cerr << "Remove error: " << remove.error << '\n';
    require(remove.accepted, "Remove result reopens");
    require(remove.source.find("destination: foyer # route note") == std::string::npos &&
                remove.source.find("destination: foyer") != std::string::npos,
            "Remove drops affected annotation");
    require(remove.source.find("# Room author notes") == 0 &&
                remove.source.find("contain # explicit default") != std::string::npos,
            "Remove retains unrelated and commented default annotations");

    auto same = edit_yaml_source(room, {{"/data/exits/0/destination", "\"corridor\""}});
    if (!same.accepted)
        std::cerr << "Same error: " << same.error << '\n';
    require(same.accepted && same.source == room, "no-op edit preserves exact source bytes");
    auto failed = edit_yaml_source(room, {{"/data/exits/0/destination", "\"foyer\""},
                                          {"/data/exits/0/destination/no-such-field", "42"}});
    require(!failed.accepted && failed.source == room, "invalid batch fails atomically");

    const auto added = edit_yaml_source(room, {{"/data/optionalNote", "\"yes\""}});
    require(added.accepted && added.source.find("  optionalNote: \"yes\"\n") != std::string::npos,
            "an omitted scalar may be explicitly authored with safe quoting");
    require(added.source.find("# Room author notes") == 0 &&
                added.source.find("destination: corridor # route note") != std::string::npos,
            "new sparse field leaves unrelated source and comments untouched");
    const auto omitted = edit_yaml_source(
        room, {{"/data/description", "\"\"", YamlCommentDisposition::Keep, "\"\""}});
    require(omitted.accepted && omitted.source.find("  description:") == std::string::npos,
            "changing an unannotated value to its declared default omits the key");
    const std::string empty_mappings =
        "chapters:\n  records: {}\n  assignments: {}\ntags:\n  records: {}\n";
    const auto first_empty = edit_yaml_source(
        empty_mappings, {{"/chapters/records", "{}", YamlCommentDisposition::Keep, "{}"}});
    require(first_empty.accepted, "removing one default-valued mapping preserves siblings");
    const auto last_empty =
        first_empty.accepted
            ? edit_yaml_source(first_empty.source, {{"/chapters/assignments", "{}",
                                                     YamlCommentDisposition::Keep, "{}"}})
            : first_empty;
    require(last_empty.accepted && last_empty.source.find("chapters: {}\n") == 0 &&
                last_empty.source.find("assignments:") == std::string::npos &&
                last_empty.source.find("tags:\n  records: {}\n") != std::string::npos,
            "omitting a final default child retains an explicit empty mapping, not YAML null");
    const auto annotated_owner =
        edit_yaml_source("chapters: # annotated owner\n  records: {}\n",
                         {{"/chapters/records", "{}", YamlCommentDisposition::Keep, "{}"}});
    require(!annotated_owner.accepted,
            "compaction fails closed rather than rewriting an annotated mapping owner");
    const auto keptDefault =
        edit_yaml_source(room, {{"/data/presentationSpace/edgePolicy", "\"cover\"",
                                 YamlCommentDisposition::Keep, "\"contain\""}});
    require(keptDefault.accepted &&
                keptDefault.source.find("edgePolicy: cover # explicit default") !=
                    std::string::npos,
            "Keep preserves comments on changed scalar with a declared default");
    const auto droppedDefault =
        edit_yaml_source(keptDefault.source, {{"/data/presentationSpace/edgePolicy", "\"contain\"",
                                               YamlCommentDisposition::Remove, "\"contain\""}});
    require(droppedDefault.accepted &&
                droppedDefault.source.find("edgePolicy:") == std::string::npos,
            "Remove can omit a commented field on return to its sparse default");
    const auto retainedDefault =
        edit_yaml_source(keptDefault.source, {{"/data/presentationSpace/edgePolicy", "\"contain\"",
                                               YamlCommentDisposition::Keep, "\"contain\""}});
    require(retainedDefault.accepted &&
                retainedDefault.source.find("edgePolicy: contain # explicit default") !=
                    std::string::npos,
            "Keep retains an explicit commented default on a semantic change");
    const auto untouchedDefault = edit_yaml_source(
        room, {{"/data/missingDefault", "null", YamlCommentDisposition::Keep, "null"}});
    require(untouchedDefault.accepted && untouchedDefault.source == room,
            "omitted default does not introduce a new key");
    const std::string sequence = "items:\n"
                                 "  - optional: changed\n"
                                 "    required: retained\n"
                                 "  - required: second\n";
    const auto sequenceOmission = edit_yaml_source(
        sequence, {{"/items/0/optional", "\"\"", YamlCommentDisposition::Remove, "\"\""}});
    require(sequenceOmission.accepted &&
                sequenceOmission.source_json ==
                    R"({"items":[{"required":"retained"},{"required":"second"}]})" &&
                sequenceOmission.source.find("  -\n    required: retained") != std::string::npos,
            "omitting a sequence mapping's first key preserves the sequence and sibling values");
    const auto emptyItem =
        edit_yaml_source("items:\n  - optional: changed\n",
                         {{"/items/0/optional", "\"\"", YamlCommentDisposition::Remove, "\"\""}});
    require(emptyItem.accepted && emptyItem.source_json == R"({"items":[{}]})" &&
                emptyItem.source.find("- {}") != std::string::npos,
            "omitting a sequence mapping's only key leaves an empty mapping item");
    const std::string header = "# document header\nid: old\ndata: {}\n";
    const auto headerRemove =
        edit_yaml_source(header, {{"/id", "\"new\"", YamlCommentDisposition::Remove}});
    require(headerRemove.accepted && headerRemove.source.find("# document header\n") == 0 &&
                headerRemove.source.find("id: new\n") != std::string::npos,
            "Remove on first root key preserves the document header");
    const auto headerOmission =
        edit_yaml_source("# document header\noptional: changed\ndata: {}\n",
                         {{"/optional", "\"\"", YamlCommentDisposition::Remove, "\"\""}});
    require(headerOmission.accepted && headerOmission.source == "# document header\ndata: {}\n",
            "default omission of first root key preserves the document header");
    const auto commentOmission =
        edit_yaml_source("data:\n  # field note\n  description: Changed\n  other: retained\n",
                         {{"/data/description", "\"\"", YamlCommentDisposition::Remove, "\"\""}});
    require(commentOmission.accepted && commentOmission.source == "data:\n  other: retained\n" &&
                commentOmission.source_json == R"({"data":{"other":"retained"}})",
            "default omission removes owned preceding field comment instead of reassigning it");
    const auto stringTags = open_yaml_source(
        "number: !!str 123\nboolean: !!str false\nempty: !!str null\n!!str 123: typed key\n");
    require(stringTags.accepted &&
                stringTags.source_json ==
                    R"({"number":"123","boolean":"false","empty":"null","123":"typed key"})",
            "explicit !!str disables implicit scalar typing for values and mapping keys");
    const std::string flow = "data: {a: 1, b: 2} # authored flow\n";
    for (const auto& edit : {
             YamlValueEdit{"/data/c", "3"},
             YamlValueEdit{"/data/a", "0", YamlCommentDisposition::Keep, "0"},
         }) {
        const auto result = edit_yaml_source(flow, {edit});
        require(!result.accepted && result.source == flow,
                "unsafe flow-mapping insertion and omission fail without collateral rewrites");
    }

    const std::vector<std::string> invalid{
        "id: a\nid: b\n",
        "a: yes\n",
        "a: 01\n",
        "a: +12\n",
        "a: .nan\n",
        "a: .inf\n",
        "a: 0x12\n",
        "a: [1, 2\n",
        "a: &anchor name\nb: *anchor\n",
        "a: !local v\n",
        "a: 1\n---\nb: 2\n",
        "a: {b: 1, b: 2}\n",
        "? [one, two]\n: thing\n",
        "a: 1\n%YAML 1.1\n---\nb: 2\n",
    };
    for (const auto& text : invalid)
        require(!open_yaml_source(text).accepted,
                "reject restricted-profile invalid YAML: " + text);
    for (const auto& text : {
             std::string("value: ") + char(0xff) + "\n",
             std::string("value: ") + "\xed\xa0\x80" + "\n",
             std::string("value: ") + "\xf0\x80\x80\x80" + "\n",
             std::string("value: \0after\n", 14),
         })
        require(!open_yaml_source(text).accepted, "reject non-UTF-8 or NUL YAML source");
    for (const auto& text : {"a: true\n", "a: null\n", "a: 2.5e+3\n", "a: \"yes\"\n", "a: '01'\n",
                             "a: [true, null, 4]\n"})
        require(open_yaml_source(text).accepted, "accept canonical scalar: " + std::string(text));

    return failures ? 1 : 0;
}
