#include "native_cli_narrative_coverage.hpp"
#include "native_cli_paths.hpp"

#include "../narrative/catalog.hpp"
#include "../project_authoring/room_session.hpp"
#include "../project_authoring/yaml_codec.hpp"

#include <algorithm>
#include <filesystem>
#include <fstream>
#include <map>
#include <set>
#include <stdexcept>
#include <string>
#include <tuple>
#include <vector>

namespace noveltea::cli {
namespace {
using Json = nlohmann::ordered_json;

std::string source_path(const std::string& owner)
{
    const auto slash = owner.find('/');
    if (slash == std::string::npos)
        return {};
    const auto family = owner.substr(0, slash), id = owner.substr(slash + 1);
    return "records/" + family + "/" + id + (family == "layouts" ? "/layout.yaml" : ".yaml");
}

Json issue(std::string code, std::string path, std::string message)
{
    return {{"code", std::move(code)},
            {"severity", "error"},
            {"path", std::move(path)},
            {"message", std::move(message)}};
}

std::string read_source(const std::filesystem::path& path)
{
    if (std::filesystem::symlink_status(path).type() != std::filesystem::file_type::regular)
        throw std::runtime_error("Expected a regular tracked Project source: " + path.string());
    std::ifstream input(path, std::ios::binary);
    if (!input)
        throw std::runtime_error("Cannot read Project source: " + path.string());
    std::string source{std::istreambuf_iterator<char>(input), {}};
    if (input.bad())
        throw std::runtime_error("Cannot finish reading Project source: " + path.string());
    return source;
}

struct Link {
    std::string target;
    std::string location_key;
    Json source;
};

void collect_links(const Json& value, const std::string& path, const std::string& owner,
                   const std::string& family, const std::string& record_id, const std::string& file,
                   const std::map<std::string, authoring::YamlSourceLocation>& positions,
                   const Json& subrecord, std::vector<Link>& links)
{
    if (!value.is_object())
        return;
    if (value.contains("narrativeRefs")) {
        const auto& refs = value.at("narrativeRefs");
        if (refs.is_array())
            for (std::size_t i = 0; i < refs.size(); ++i) {
                if (!refs[i].is_string())
                    continue; // Native authoring admission reports malformed field shapes.
                const auto pointer = path + "/narrativeRefs/" + std::to_string(i);
                const auto found = positions.find(pointer);
                Json source{{"collection", family},
                            {"recordId", record_id},
                            {"sourcePath", file},
                            {"pointer", pointer},
                            {"subrecord", subrecord}};
                if (found != positions.end()) {
                    source["line"] = found->second.line;
                    source["column"] = found->second.column;
                }
                const auto target = refs[i].get<std::string>();
                links.push_back({target, owner + pointer, std::move(source)});
            }
    }
    if (path.empty()) {
        const auto data = value.find("data");
        if (data == value.end() || !data->is_object())
            return;
        const char* key = family == "scenes"         ? "events"
                          : family == "dialogues"    ? "blocks"
                          : family == "interactions" ? "rules"
                                                     : nullptr;
        if (!key || !data->contains(key) || !data->at(key).is_array())
            return;
        const auto& elements = data->at(key);
        for (std::size_t i = 0; i < elements.size(); ++i) {
            const auto& element = elements[i];
            if (!element.is_object())
                continue;
            const auto pointer = "/data/" + std::string(key) + "/" + std::to_string(i);
            const Json sub = {
                {"kind", family == "scenes"      ? "scene-operation"
                         : family == "dialogues" ? "dialogue-block"
                                                 : "interaction-rule"},
                {"id", element.value("id", std::string{})},
                {"operation", element.value(family == "scenes" ? "type" : "kind", std::string{})}};
            collect_links(element, pointer, owner, family, record_id, file, positions, sub, links);
            if (family == "dialogues" && element.contains("segments") &&
                element.at("segments").is_array()) {
                const auto& segments = element.at("segments");
                for (std::size_t j = 0; j < segments.size(); ++j) {
                    if (!segments[j].is_object())
                        continue;
                    Json child{{"kind", "dialogue-segment"},
                               {"id", segments[j].value("id", std::string{})},
                               {"parentId", element.value("id", std::string{})}};
                    collect_links(segments[j], pointer + "/segments/" + std::to_string(j), owner,
                                  family, record_id, file, positions, child, links);
                }
            }
        }
        if (family == "dialogues" && data->contains("edges") && data->at("edges").is_array()) {
            const auto& edges = data->at("edges");
            for (std::size_t i = 0; i < edges.size(); ++i) {
                if (!edges[i].is_object())
                    continue;
                Json sub{{"kind", "dialogue-edge"},
                         {"id", edges[i].value("id", std::string{})},
                         {"operation", edges[i].value("kind", std::string{})}};
                if (edges[i].value("kind", std::string{}) == "choice") {
                    sub["fromBlockId"] = edges[i].value("fromBlockId", std::string{});
                    sub["toBlockId"] = edges[i].value("toBlockId", std::string{});
                    if (data->contains("completion") && data->at("completion").is_object() &&
                        data->at("completion").value("kind", std::string{}) == "scene")
                        sub["completionSceneId"] =
                            data->at("completion").value("id", std::string{});
                }
                collect_links(edges[i], "/data/edges/" + std::to_string(i), owner, family,
                              record_id, file, positions, sub, links);
            }
        }
    }
}

std::vector<Link> project_links(const std::filesystem::path& root, Json& errors)
{
    std::string error;
    auto project = authoring::ProjectSession::open(root, error);
    if (!project) {
        errors.push_back(
            issue("coverage.project-invalid", "project.yaml", "Cannot admit Project: " + error));
        return {};
    }
    const auto validated = project->validate_project();
    if (!validated.valid)
        errors.push_back(
            issue("coverage.project-invalid", "project.yaml",
                  "Project validation failed; claims cannot certify a valid Project."));
    const auto snapshots = project->validated_disk_record_snapshots();
    std::set<std::string> tracked;
    for (const auto& file : project->file_inventory())
        if (file.kind == authoring::ProjectFileKind::TrackedSource &&
            file.path.starts_with("records/"))
            tracked.insert(file.path);
    std::vector<Link> links;
    for (const auto& [owner, snapshot] : snapshots) {
        const auto slash = owner.find('/');
        if (slash == std::string::npos)
            continue;
        const auto family = owner.substr(0, slash);
        const auto file = source_path(owner);
        if (family == "assets" || !tracked.contains(file))
            continue;
        if (!snapshot.valid || snapshot.source_json.empty()) {
            errors.push_back(issue("coverage.record-invalid", file,
                                   "Cannot admit record for narrative coverage: " + owner));
            continue;
        }
        const auto record_id = owner.substr(slash + 1);
        try {
            const auto decoded = authoring::open_yaml_source(read_source(root / file));
            if (!decoded.accepted ||
                Json::parse(decoded.source_json) != Json::parse(snapshot.source_json)) {
                errors.push_back(issue("coverage.source-changed", file,
                                       "Project source changed or could not be decoded."));
                continue;
            }
            std::map<std::string, authoring::YamlSourceLocation> positions;
            for (const auto& location : decoded.locations)
                positions.emplace(location.path, location);
            const auto record = Json::parse(snapshot.source_json);
            collect_links(record, "", owner, family, record_id, file, positions, nullptr, links);
        } catch (const std::exception& e) {
            errors.push_back(issue("coverage.source-read", file, e.what()));
        }
    }
    const auto observed = project->observe_sources();
    if (!observed.authoritative || observed.full_rescan || !observed.delta.changed.empty() ||
        !observed.delta.added.empty() || !observed.delta.removed.empty())
        errors.push_back(issue("coverage.source-changed", "project.yaml",
                               "Project sources changed while collecting coverage."));
    std::sort(links.begin(), links.end(), [](const Link& a, const Link& b) {
        return std::tie(a.target, a.location_key) < std::tie(b.target, b.location_key);
    });
    return links;
}

// Compare physical Project identity instead of JSON path spelling. Windows
// reporters may emit backslashes, while the native CLI uses generic '/' paths;
// redundant components and absolute aliases are equivalent as well. Missing
// or relative report roots cannot claim evidence for the active Project.
bool same_project_root(const std::string& reported_root, const std::filesystem::path& project_root)
{
    const auto reported = native_path_from_utf8(reported_root);
    if (!reported.is_absolute() || !project_root.is_absolute())
        return false;
    std::error_code error;
    return std::filesystem::equivalent(reported, project_root, error) && !error;
}

// An externally supplied CLI Test result is evidence of what was *reported*.
// It cannot certify that the saved result is authentic, fresh, or exercises
// the narrative obligations that its authoring Test references.
Json reported_tests(const std::vector<std::filesystem::path>& paths, Json& errors)
{
    Json entries = Json::array();
    for (const auto& path : paths) {
        try {
            if (std::filesystem::file_size(path) > 8 * 1024 * 1024)
                throw std::runtime_error("Test report exceeds the 8 MiB input limit.");
            const auto run = Json::parse(read_source(path));
            if (!run.is_object() || !run.contains("native") || !run["native"].is_object() ||
                !run["native"].contains("report") || !run["native"]["report"].is_object() ||
                !run["native"]["report"].contains("entries") ||
                !run["native"]["report"]["entries"].is_array() || !run.contains("projectRoot") ||
                !run["projectRoot"].is_string())
                throw std::runtime_error(
                    "Expected a native 'noveltea test run' suite JSON report.");
            for (const auto& entry : run["native"]["report"]["entries"]) {
                if (!entry.is_object() || !entry.contains("id") || !entry["id"].is_string() ||
                    !entry.contains("status") || !entry["status"].is_string())
                    throw std::runtime_error("Malformed Test suite entry.");
                entries.push_back({{"testId", entry["id"]},
                                   {"status", entry["status"]},
                                   {"reportPath", path.generic_string()},
                                   {"projectRoot", run["projectRoot"]},
                                   {"provenanceVerified", false}});
            }
        } catch (const std::exception& e) {
            errors.push_back(
                issue("coverage.test-report-invalid", path.generic_string(), e.what()));
        }
    }
    return entries;
}
} // namespace

Json narrative_coverage(const std::filesystem::path& story_root,
                        const std::filesystem::path& project_root,
                        const std::vector<std::filesystem::path>& test_reports)
{
    const auto catalog = narrative::validate(story_root);
    Json errors = catalog.at("diagnostics");
    auto claims = project_links(project_root, errors);
    const auto reports = reported_tests(test_reports, errors);
    std::map<std::string, Json> requirements;
    std::map<std::string, unsigned> identities;
    for (const auto& record : catalog.at("records")) {
        const auto& metadata = record.at("metadata");
        const auto id = metadata.at("id").get<std::string>();
        ++identities[id];
        if (!requirements.contains(id))
            requirements.emplace(id, Json{{"id", id},
                                          {"type", metadata.at("type")},
                                          {"status", metadata.at("status")},
                                          {"sourcePath", record.at("path")},
                                          {"association", "unmapped"},
                                          {"claims", Json::array()},
                                          {"tests", Json::array()},
                                          {"behaviorVerified", false},
                                          {"presentationAssessment", "not-assessed"}});
    }
    Json dangling = Json::array(), duplicates = Json::array(), ambiguous = Json::array();
    std::set<std::pair<std::string, std::string>> seen;
    for (const auto& claim : claims) {
        Json association = claim.source;
        association["targetId"] = claim.target;
        if (!seen.insert(
                     {claim.target, claim.location_key.substr(0, claim.location_key.rfind('/'))})
                 .second) {
            duplicates.push_back(association);
            continue;
        }
        const auto target = requirements.find(claim.target);
        if (target == requirements.end()) {
            dangling.push_back(association);
            continue;
        }
        if (identities[claim.target] > 1) {
            ambiguous.push_back(association);
            continue;
        }
        if (association["collection"] == "tests") {
            Json evidence = association;
            evidence["kind"] = "declared-test";
            evidence["execution"] = "not-observed";
            for (const auto& run : reports)
                if (run["testId"] == association["recordId"] &&
                    same_project_root(run["projectRoot"].get<std::string>(), project_root)) {
                    evidence["execution"] = "externally-reported";
                    evidence["reportedStatus"] = run["status"];
                    evidence["reportPath"] = run["reportPath"];
                    evidence["provenanceVerified"] = false;
                }
            target->second["tests"].push_back(std::move(evidence));
        } else {
            association["kind"] = "implementation-claim";
            target->second["claims"].push_back(std::move(association));
        }
    }
    // A candidate requires a Choice Point and Event on one Dialogue choice
    // edge, explicit Dialogue completion to a Scene, and a linked Scene
    // mutation operation. None of these proves that gameplay reaches it.
    Json routes = Json::array();
    bool routes_truncated = false;
    for (const auto& [choice_id, choice] : requirements) {
        if (choice["type"] != "choice-point")
            continue;
        for (const auto& edge : choice["claims"]) {
            const auto& sub = edge["subrecord"];
            if (!sub.is_object() || sub.value("kind", "") != "dialogue-edge" ||
                sub.value("operation", "") != "choice" || !sub.contains("completionSceneId"))
                continue;
            const auto pointer = edge["pointer"].get<std::string>();
            const auto edge_key = pointer.substr(0, pointer.rfind("/narrativeRefs/"));
            for (const auto& [event_id, event] : requirements) {
                if (event["type"] != "event")
                    continue;
                const bool same_edge = std::any_of(
                    event["claims"].begin(), event["claims"].end(), [&](const Json& candidate) {
                        const auto found_pointer = candidate["pointer"].get<std::string>();
                        return candidate["collection"] == "dialogues" &&
                               candidate["recordId"] == edge["recordId"] &&
                               found_pointer.starts_with(edge_key + "/narrativeRefs/");
                    });
                if (!same_edge)
                    continue;
                for (const auto& effect : event["claims"]) {
                    const auto& operation = effect["subrecord"];
                    if (effect["collection"] != "scenes" ||
                        effect["recordId"] != sub["completionSceneId"] || !operation.is_object() ||
                        operation.value("kind", "") != "scene-operation")
                        continue;
                    const auto type = operation.value("operation", std::string{});
                    if (type != "gameplay-effect-batch" && type != "set-variable" &&
                        type != "runtime-world-transaction")
                        continue;
                    if (routes.size() >= 256) {
                        routes_truncated = true;
                        break;
                    }
                    routes.push_back({{"choicePointId", choice_id},
                                      {"eventId", event_id},
                                      {"choiceEdge", edge},
                                      {"sceneEffect", effect},
                                      {"status", "declared-unverified"},
                                      {"reachabilityVerified", false},
                                      {"stateEffectVerified", false}});
                }
            }
        }
    }
    Json records = Json::array();
    for (auto& [id, item] : requirements) {
        if (identities[id] > 1)
            item["association"] = "ambiguous";
        else if (!item["claims"].empty())
            item["association"] =
                item["status"] == "approved" ? "claimed-unverified" : "draft-only";
        records.push_back(std::move(item));
    }
    return {
        {"contractRevision", catalog.at("contractRevision")},
        {"storyRoot", story_root.generic_string()},
        {"projectRoot", project_root.generic_string()},
        {"requirements", std::move(records)},
        {"dangling", std::move(dangling)},
        {"duplicate", std::move(duplicates)},
        {"ambiguous", std::move(ambiguous)},
        {"routeCandidates", std::move(routes)},
        {"routeCandidatesTruncated", routes_truncated},
        {"testReports", reports},
        {"diagnostics", std::move(errors)},
        {"qualitative",
         {{"status", "not-assessed"},
          {"unverified",
           Json::array({"behavioral-implementation", "test-provenance", "state-transition-coverage",
                        "player-perceivable-presentation", "authorial-intent"})}}}};
}
} // namespace noveltea::cli
