#include "catalog.hpp"
#include "catalog_internal.hpp"
#include "generated/contract.hpp"

#include <algorithm>
#include <array>
#include <map>
#include <set>
#include <string>
#include <vector>

namespace noveltea::narrative {
namespace {
constexpr std::array<const char*, 5> stage_names{"foundation", "architecture", "interactive",
                                                 "composition", "review"};
constexpr std::size_t cluster_limit = 128;
constexpr int cluster_depth = 6;
bool partial(const Record& r) { return r.metadata.value("completeness", "complete") == "partial"; }
std::string id(const Record& r) { return r.metadata["id"].get<std::string>(); }
std::string type(const Record& r) { return r.metadata["type"].get<std::string>(); }
bool has(const Json& arr, const Json& value)
{
    return std::find(arr.begin(), arr.end(), value) != arr.end();
}
bool has_id(const Json& arr, const std::string& value) { return has(arr, value); }
const Json* coverage_item(const Json& items, const std::string& key, const std::string& value)
{
    for (const auto& item : items)
        if (item.at(key) == value)
            return &item;
    return nullptr;
}
std::string state_status(const Json& finding)
{
    const auto status = finding.value("status", "unverified");
    if (status == "reachable")
        return "satisfied";
    if (status == "incomplete")
        return "missing";
    if (status == "impossible")
        return "blocked";
    return "unverified";
}
std::string route_status(const Json& routes)
{
    bool unknown = false, incomplete = false;
    for (const auto& route : routes) {
        const auto status = state_status(route);
        if (status == "satisfied")
            return status;
        unknown = unknown || status == "unverified";
        incomplete = incomplete || status == "missing";
    }
    return unknown ? "unverified" : incomplete || routes.empty() ? "missing" : "blocked";
}
std::string message_for(std::string_view status)
{
    if (status == "satisfied")
        return "Declared structural evidence is reachable; presentation and gameplay remain "
               "unverified.";
    if (status == "missing")
        return "Complete the declared narrative requirements before handoff.";
    if (status == "blocked")
        return "No declared reachable route satisfies this requirement; revise its dependencies.";
    return "Insufficient structural proof; investigate unknown conditions, invalid inputs or "
           "search limits.";
}
std::string due_by(const Record& r)
{
    const auto t = type(r);
    if (t == "creative-direction")
        return "foundation";
    if (t == "milestone" || t == "event" || t == "puzzle" || t == "choice-point" ||
        t == "revelation" || t == "narrative-position")
        return "interactive";
    if (t == "authored-content")
        return "composition";
    return "architecture";
}
std::string pointer_field(std::string field)
{
    std::replace(field.begin(), field.end(), '.', '/');
    return "/" + field;
}
Json outstanding(const Catalog& catalog)
{
    Json items = Json::array();
    for (const auto& r : catalog.records) {
        if (!partial(r))
            continue;
        const auto& m = r.metadata;
        auto add = [&](const std::string& field, const std::string& code,
                       const std::string& required_by, const std::string& message) {
            items.push_back(catalog.located(r, pointer_field(field),
                                            {{"id", id(r)},
                                             {"type", type(r)},
                                             {"field", field},
                                             {"code", code},
                                             {"requiredBy", required_by},
                                             {"message", message}}));
        };
        if (type(r) == "milestone" && m["fulfillment"]["any_of"].empty())
            add("fulfillment.any_of", "supply-relationship", "interactive",
                "Bind a nonempty Event fulfillment alternative.");
        if (type(r) == "event") {
            if (m["consequences"].empty())
                add("consequences", "supply-content", "interactive",
                    "Describe a consequence of this Event.");
            if (m["prerequisites"]["any_of"].empty())
                add("prerequisites.any_of", "supply-alternatives", "interactive",
                    "Declare an enabling alternative; an empty list is unfinished.");
            for (std::size_t i = 0; i < m["steps"].size(); ++i)
                if (m["steps"][i]["branches"].empty())
                    add("steps." + std::to_string(i) + ".branches", "supply-alternatives",
                        "interactive", "Define an executable branch or remove the step.");
        }
        if (type(r) == "choice-point" && m["outcomes"].size() < 2)
            add("outcomes", "supply-alternatives", "interactive",
                "Declare at least two distinct meaningful outcomes.");
        if (type(r) == "puzzle") {
            if (m["clues"].empty())
                add("clues", "supply-relationship", "interactive", "Link authored clue content.");
            if (m["solutions"].empty())
                add("solutions", "supply-relationship", "interactive", "Link a resolution Event.");
        }
        if (type(r) == "authored-content" && m["events"].empty())
            add("events", "supply-relationship", "composition",
                "Bind this Authored Content to an Event.");
        bool owed = false;
        for (const auto& item : items)
            if (item["id"] == id(r))
                owed = true;
        if (!owed)
            add("completeness", "confirm-completion", due_by(r),
                "Review the partial record and explicitly mark it complete.");
    }
    return items;
}

struct Gate {
    Catalog source;
    Json evidence;
    Json obligations;
    Json stages = Json::object();
    std::map<std::string, Json> findings;
};
Json finding(const Catalog& catalog, const Record* record, const std::string& stage,
             const std::string& code, const std::string& status, const std::string& message,
             const std::string& pointer = "", Json witnesses = Json::array(),
             const std::string& subject = "")
{
    const auto subject_id = subject.empty() ? (record ? id(*record) : "catalog") : subject;
    Json result = {{"requirementId", stage + "/" + code + "/" + subject_id + pointer},
                   {"code", code},
                   {"status", status},
                   {"requiredBy", stage},
                   {"subjectId", subject_id},
                   {"message", message},
                   {"witnesses", witnesses}};
    if (record)
        return catalog.located(*record, pointer, std::move(result));
    return catalog.located(Record{".", {}, {}, {}, {{"", {1, 1}}}}, "", std::move(result));
}
Json witness(const std::string& source, const std::string& target, const std::string& pointer)
{
    return {{"sourceId", source}, {"targetId", target}, {"pointer", pointer}};
}
Json evidence_witness(const Json& item)
{
    Json witnesses = Json::array();
    if (item.contains("witness"))
        for (const auto& predecessor : item["witness"])
            witnesses.push_back({{"sourceId", predecessor}, {"code", "completed-event"}});
    if (item.contains("branches"))
        for (const auto& branch : item["branches"])
            witnesses.push_back({{"sourceId", branch}, {"code", "event-branch"}});
    return witnesses;
}
Gate assess(const Catalog& source, bool approved)
{
    Gate out;
    for (const auto& r : source.records)
        if ((!approved && r.metadata["status"] != "superseded") ||
            (approved && r.metadata["status"] == "approved"))
            out.source.records.push_back(r);
    std::set<std::string> paths, ids;
    for (const auto& r : out.source.records) {
        paths.insert(r.path);
        ids.insert(id(r));
    }
    std::set<std::string> admitted_paths;
    for (const auto& r : source.records)
        admitted_paths.insert(r.path);
    // Rejected records have no trustworthy status; only admitted out-of-scope
    // records can safely have their diagnostics excluded from readiness.
    const std::set<std::string> computed{"chronology-cycle",        "required-predecessor-cycle",
                                         "impossible-prerequisite", "impossible-fulfillment",
                                         "impossible-branch",       "unobtainable-puzzle-solution",
                                         "unobtainable-puzzle-clue"};
    for (const auto& d : source.diagnostics)
        if (!computed.contains(d.at("code").get<std::string>()) &&
            (paths.contains(d["path"].get<std::string>()) ||
             (d["path"] != "." && !admitted_paths.contains(d["path"].get<std::string>())) ||
             (d["path"] == "." && d["code"] == "io")))
            out.source.diagnostics.push_back(d);
    for (const auto& ref : source.references)
        if (ids.contains(ref["source"].get<std::string>())) {
            out.source.references.push_back(ref);
            if (!ids.contains(ref["target"].get<std::string>())) {
                Json d = ref;
                d["code"] = "scope-reference-missing";
                d["severity"] = "error";
                d["message"] = "Typed dependency " + ref["target"].get<std::string>() +
                               " is unavailable in this status scope.";
                out.source.diagnostics.push_back(std::move(d));
            }
        }
    out.evidence = analyze(out.source);
    out.obligations = outstanding(out.source);
    std::map<std::string, const Record*> by_id;
    for (const auto& r : out.source.records)
        by_id[id(r)] = &r;
    auto get = [&](const std::string& name) -> const Record* {
        const auto it = by_id.find(name);
        return it == by_id.end() ? nullptr : it->second;
    };
    auto add = [&](const std::string& stage, const std::string& code, const std::string& status,
                   const std::string& message, const Record* r = nullptr,
                   const std::string& pointer = "", Json witnesses = Json::array(),
                   const std::string& subject = "") {
        auto& items = out.findings[stage];
        if (items.is_null())
            items = Json::array();
        items.push_back(finding(out.source, r, stage, code, status, message, pointer,
                                std::move(witnesses), subject));
    };
    const auto records_of_type = [&](const std::string& t) {
        std::vector<const Record*> found;
        for (const auto& r : out.source.records)
            if (type(r) == t)
                found.push_back(&r);
        return found;
    };
    const auto directions = records_of_type("creative-direction");
    if (directions.size() != 1)
        add("foundation", "creative-direction-required", "missing",
            "Establish exactly one current Creative Direction.");
    else
        add("foundation", "creative-direction-present",
            partial(*directions.front()) ? "missing" : "satisfied",
            partial(*directions.front()) ? "Complete the Creative Direction."
                                         : "One current Creative Direction is declared.",
            directions.front(), "/id");
    for (const auto& obligation : out.obligations) {
        const auto stage = obligation["requiredBy"].get<std::string>();
        const auto* r = get(obligation["id"].get<std::string>());
        add(stage, obligation["code"], "missing", obligation["message"], r, obligation["pointer"],
            Json::array());
    }
    const auto arcs = records_of_type("arc");
    const auto milestones = records_of_type("milestone");
    if (arcs.empty())
        add("architecture", "arc-required", "missing", "Declare a Story Arc.");
    if (milestones.empty())
        add("architecture", "milestone-required", "missing", "Declare a Milestone.");
    for (const auto* arc : arcs) {
        Json edges = Json::array();
        for (const auto* milestone : milestones)
            if (has_id(milestone->metadata["arcs"], id(*arc)))
                edges.push_back(witness(id(*milestone), id(*arc), "/arcs"));
        add("architecture", "arc-milestone-binding", edges.empty() ? "missing" : "satisfied",
            edges.empty() ? "Bind an affecting Milestone to this Arc."
                          : "A declared Milestone affects this Arc.",
            arc, "/id", edges);
    }
    for (const auto* milestone : milestones) {
        const auto* coverage = coverage_item(out.evidence["milestoneRoutes"], "id", id(*milestone));
        const auto fulfillment_status =
            coverage ? route_status((*coverage)["routes"]) : "unverified";
        const bool realized = fulfillment_status == "satisfied";
        const auto status = partial(*milestone) ? std::string("satisfied") : fulfillment_status;
        add("architecture", "milestone-route", status,
            realized ? "A declared fulfillment alternative is reachable."
            : partial(*milestone)
                ? "Partial Milestone binding may be deferred to interactive design."
                : "Complete Milestone lacks a proven fulfillment alternative.",
            milestone, "/fulfillment", coverage ? (*coverage)["routes"] : Json::array());
        add("interactive", "milestone-fulfillment", fulfillment_status,
            realized ? "A fulfillment alternative is structurally reachable."
                     : "Complete a reachable fulfillment alternative.",
            milestone, "/fulfillment", coverage ? (*coverage)["routes"] : Json::array());
        if (coverage)
            for (const auto& route : (*coverage)["routes"])
                add("interactive", "milestone-alternative", state_status(route),
                    message_for(state_status(route)), milestone,
                    route.value("pointer", "/fulfillment"), evidence_witness(route),
                    id(*milestone) + "#" + std::to_string(route["alternative"].get<int>()));
    }
    for (const auto& event : out.evidence["eventProgress"]) {
        const auto* r = get(event["id"].get<std::string>());
        add("interactive", "event-access", state_status(event), message_for(state_status(event)), r,
            event.value("pointer", "/prerequisites"), evidence_witness(event));
    }
    for (const auto& branch : out.evidence["branchProgress"]) {
        const auto* r = get(branch["event"].get<std::string>());
        add("interactive", "event-branch", state_status(branch), message_for(state_status(branch)),
            r, branch.value("pointer", "/steps"), evidence_witness(branch),
            branch["event"].get<std::string>() + "#" + branch["step"].get<std::string>() + "/" +
                branch["branch"].get<std::string>());
    }
    for (const auto& puzzle : out.evidence["puzzleSolutions"]) {
        const auto* r = get(puzzle["id"].get<std::string>());
        for (const auto& solution : puzzle["solutions"]) {
            const auto target = solution["event"].get<std::string>();
            add("interactive", "puzzle-solution", state_status(solution),
                message_for(state_status(solution)), r, solution.value("pointer", "/solutions"),
                Json::array({witness(id(*r), target, "/solutions")}), id(*r) + "#" + target);
            const auto& access = solution["clueAccess"];
            Json refs = Json::array();
            for (const auto& clue : access["availableClues"])
                refs.push_back(witness(id(*r), clue.get<std::string>(), "/clues"));
            add("interactive", "puzzle-clue-access", state_status(access),
                message_for(state_status(access)), r, "/clues", refs, id(*r) + "#" + target);
        }
    }
    for (const auto* choice : records_of_type("choice-point")) {
        for (const auto& outcome : choice->metadata["outcomes"]) {
            bool found = false;
            Json witnesses = Json::array();
            for (const auto* event : records_of_type("event"))
                for (const auto& step : event->metadata["steps"])
                    for (const auto& branch : step["branches"])
                        for (const auto& effect : branch["effects"])
                            if (effect["kind"] == "outcome" &&
                                effect["choice_point"] == id(*choice) &&
                                effect["value"] == outcome) {
                                for (const auto& evidence : out.evidence["branchProgress"])
                                    if (evidence["event"] == id(*event) &&
                                        evidence["step"] == step["id"] &&
                                        evidence["branch"] == branch["id"] &&
                                        evidence["status"] == "reachable") {
                                        found = true;
                                        witnesses.push_back(
                                            witness(id(*event), id(*choice), "/steps"));
                                    }
                            }
            add("interactive", "choice-outcome",
                found                            ? "satisfied"
                : out.source.diagnostics.empty() ? "missing"
                                                 : "unverified",
                found ? "A reachable Event branch assigns this outcome."
                      : "Realize this Choice Point outcome in a reachable Event branch.",
                choice, "/outcomes", witnesses, id(*choice) + "#" + outcome.get<std::string>());
        }
    }
    for (const auto& position : out.evidence["narrativeState"]) {
        const auto* r = get(position["id"].get<std::string>());
        bool unknown = position["status"] != "reachable";
        for (const auto& state : position["state"])
            unknown = unknown || state["status"] == "unverified";
        add("interactive", "position-continuity", unknown ? "unverified" : "satisfied",
            unknown ? "Narrative Position includes unverified state or reachability."
                    : "Declared Narrative Position predicates are structurally classified.",
            r, "/at");
    }
    for (const auto* event : records_of_type("event")) {
        Json witnesses = Json::array();
        for (const auto* content : records_of_type("authored-content"))
            if (!partial(*content) && has_id(content->metadata["events"], id(*event)))
                witnesses.push_back(witness(id(*content), id(*event), "/events"));
        add("composition", "event-authored-content", witnesses.empty() ? "missing" : "satisfied",
            witnesses.empty() ? "Supply completed linked Authored Content for this Event."
                              : "The Event has completed linked Authored Content.",
            event, "/id", witnesses);
    }
    // Scope diagnostics cannot certify any graph-dependent stage; foundation
    // remains independently evaluable when a later Event fails validation.
    for (const auto& d : out.source.diagnostics) {
        const bool foundational =
            d["code"] != "scope-reference-missing" &&
            (d["path"] == "." || !admitted_paths.contains(d["path"].get<std::string>()) ||
             std::any_of(directions.begin(), directions.end(),
                         [&](const Record* r) { return r->path == d["path"].get<std::string>(); }));
        const std::string due = foundational ? "foundation" : "architecture";
        auto issue = finding(out.source, nullptr, due, d["code"], "blocked", d["message"],
                             d.value("pointer", ""), Json::array(),
                             d.value("path", "") + ":" + std::to_string(d.value("line", 1)));
        issue["path"] = d["path"];
        issue["line"] = d.value("line", 1);
        issue["column"] = d.value("column", 1);
        auto& issues = out.findings[due];
        if (issues.is_null())
            issues = Json::array();
        issues.push_back(std::move(issue));
    }
    if (out.evidence["search"]["truncated"])
        add("interactive", "search-limit", "unverified",
            "State exploration exceeded its bound; no readiness guarantee is possible.");
    const std::map<std::string, Json> qualitative{
        {"foundation", Json::array({"foundation-coherence"})},
        {"architecture", Json::array({"creative-direction-alignment", "arc-payoff-and-pacing"})},
        {"interactive", Json::array({"puzzle-fairness", "player-agency", "prose-only-intent"})},
        {"composition", Json::array({"prose-continuity-and-voice", "revelation-wording",
                                     "vn-presentation-feasibility"})},
        {"review", Json::array({"independent-editorial-review", "agreed-story-scope-completeness",
                                "engine-behavior"})}};
    const std::map<std::string, std::string> requirements{
        {"foundation", "One complete, valid Creative Direction."},
        {"architecture", "At least one Arc and Milestone; every Arc is covered and complete "
                         "Milestones have reachable routes."},
        {"interactive", "Every declared Event, Milestone alternative, branch, Choice outcome, "
                        "Puzzle clue/solution and Position is structurally assessed."},
        {"composition", "Every declared Event has completed linked Authored Content."},
        {"review", "Independent editorial and VN production feasibility review remains required."}};
    Json cumulative = Json::array();
    for (const auto* stage : stage_names) {
        Json own = out.findings.contains(stage) ? out.findings.at(stage) : Json::array();
        for (const auto& item : own)
            if (item["status"] != "satisfied")
                cumulative.push_back(item);
        const std::string minimum = !cumulative.empty()              ? "needs-work"
                                    : std::string(stage) == "review" ? "unverified"
                                                                     : "passed";
        out.stages[stage] = {{"minimum", minimum},
                             {"requirements", Json::array({requirements.at(stage)})},
                             {"findings", own},
                             {"blockingGaps", cumulative},
                             {"unverified", qualitative.at(stage)}};
    }
    return out;
}

struct Cluster {
    std::set<std::string> ids;
    bool truncated = false;
};
Cluster cluster(const Catalog& source, const std::string& milestone)
{
    Cluster result;
    std::map<std::string, const Record*> records;
    for (const auto& record : source.records)
        records[id(record)] = &record;
    const auto slot = [](Json predicate) {
        predicate.erase("value");
        return nlohmann::json(predicate).dump();
    };
    std::map<std::string, std::set<std::string>> producers;
    for (const auto& record : source.records)
        if (type(record) == "event")
            for (const auto& step : record.metadata["steps"])
                for (const auto& branch : step["branches"])
                    for (const auto& effect : branch["effects"])
                        producers[slot(effect)].insert(id(record));
    std::vector<std::pair<std::string, int>> queue;
    auto enqueue = [&](const std::string& key, int depth) {
        if (result.ids.contains(key))
            return;
        if (!records.contains(key) || result.ids.size() >= cluster_limit || depth > cluster_depth) {
            result.truncated = true;
            return;
        }
        result.ids.insert(key);
        queue.emplace_back(key, depth);
    };
    enqueue(milestone, 0);
    for (const auto& r : source.records)
        if (type(r) == "creative-direction" && r.metadata["status"] != "superseded")
            enqueue(id(r), 0);
    for (std::size_t i = 0; i < queue.size(); ++i) {
        const auto [current, depth] = queue[i];
        const auto* record = records.at(current);
        if (type(*record) == "event") {
            // Typed state requirements depend on writers, not just on the Fact
            // or Relationship record that declares the initial state.
            const auto include_producers = [&](const Json& conditions) {
                for (const auto& condition : conditions)
                    for (const auto& producer : producers[slot(condition)])
                        enqueue(producer, depth + 1);
            };
            for (const auto& route : record->metadata["prerequisites"]["any_of"])
                include_producers(route.value("conditions", Json::array()));
            for (const auto& step : record->metadata["steps"])
                for (const auto& branch : step["branches"])
                    include_producers(branch["conditions"]);
        }
        for (const auto& ref : source.references)
            if (ref["source"] == current)
                enqueue(ref["target"].get<std::string>(), depth + 1);
        // Content and Puzzle are reverse links, but other reverse edges (e.g.
        // all Events sharing an Arc) would pull unrelated future Story branches.
        if (type(*record) == "event")
            for (const auto& ref : source.references)
                if (ref["target"] == current &&
                    (records.contains(ref["source"].get<std::string>()) &&
                     (type(*records.at(ref["source"].get<std::string>())) == "authored-content" ||
                      type(*records.at(ref["source"].get<std::string>())) == "puzzle")))
                    enqueue(ref["source"].get<std::string>(), depth + 1);
    }
    return result;
}
} // namespace

Json readiness_report(const std::filesystem::path& root, const std::string& stage,
                      const std::string& view, const std::vector<std::string>& milestones)
{
    auto source = read_catalog(root);
    // Validation has to happen once against the full canonical Story; scoped
    // progression is then computed independently per authority/status view.
    static_cast<void>(analyze(source));
    const auto contract = Json::parse(contract_source);
    auto design = assess(source, false);
    auto approved = assess(source, true);
    Json results = Json::array();
    std::set<std::string> selected;
    for (const auto& target : milestones) {
        const auto* record = source.find(target);
        if (!record || type(*record) != "milestone" ||
            std::count_if(source.records.begin(), source.records.end(),
                          [&](const Record& r) { return id(r) == target; }) != 1 ||
            !selected.insert(target).second) {
            results.push_back({{"id", target},
                               {"minimum", "unverified"},
                               {"diagnostic", "invalid-milestone-id"}});
            continue;
        }
        auto bounds = cluster(source, target);
        Catalog scoped;
        for (const auto& r : source.records)
            if (bounds.ids.contains(id(r)))
                scoped.records.push_back(r);
        for (const auto& ref : source.references)
            if (bounds.ids.contains(ref["source"].get<std::string>()))
                scoped.references.push_back(ref);
        for (const auto& d : source.diagnostics)
            if (d["path"] == "." ||
                std::none_of(
                    source.records.begin(), source.records.end(),
                    [&](const Record& r) { return r.path == d["path"].get<std::string>(); }) ||
                std::any_of(scoped.records.begin(), scoped.records.end(), [&](const Record& r) {
                    return r.path == d["path"].get<std::string>();
                }))
                scoped.diagnostics.push_back(d);
        auto candidate = assess(scoped, view == "approved");
        const auto minimum =
            bounds.truncated ? "unverified" : candidate.stages[stage]["minimum"].get<std::string>();
        Json ids = Json::array();
        for (const auto& value : bounds.ids)
            ids.push_back(value);
        results.push_back({{"id", target},
                           {"minimum", minimum},
                           {"recordIds", ids},
                           {"bounded",
                            {{"maxDepth", cluster_depth},
                             {"maxRecords", cluster_limit},
                             {"truncated", bounds.truncated}}},
                           {"findings", candidate.stages[stage]["blockingGaps"]},
                           {"stages", candidate.stages}});
    }
    return {{"contractRevision", contract["revision"]},
            {"stage", stage},
            {"view", view},
            {"enrichmentAllowed", true},
            {"design", {{"stages", design.stages}}},
            {"approved", {{"stages", approved.stages}}},
            {"focus", (view == "approved" ? approved.stages : design.stages)[stage]},
            {"clusters", results},
            {"outstanding", outstanding(source)},
            {"diagnostics", source.diagnostics},
            {"qualitative",
             {{"status", "not-assessed"},
              {"unverified", Json::array({"editorial-quality", "vn-presentation-feasibility",
                                          "asset-availability", "engine-playability"})}}},
            {"authorization", {{"status", "not-assessed"}}}};
}
} // namespace noveltea::narrative
