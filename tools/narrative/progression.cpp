#include "catalog_internal.hpp"
#include "generated/contract.hpp"

#include <algorithm>
#include <functional>
#include <optional>
#include <set>
#include <utility>

namespace noveltea::narrative {
namespace {
using Values = std::map<std::string, Json>;
using Graph = std::map<std::string, std::vector<std::string>>;
const Json empty = Json::array();
bool contains(const Json& list, const Json& value)
{
    return std::find(list.begin(), list.end(), value) != list.end();
}
bool partial(const Json& m) { return m.value("completeness", "complete") == "partial"; }
std::string slot(const Json& predicate)
{
    nlohmann::json sorted = predicate;
    sorted.erase("value");
    return sorted.dump();
}
bool reaches(const Graph& graph, const std::string& from, const std::string& target)
{
    std::set<std::string> seen;
    std::vector<std::string> pending{from};
    while (!pending.empty()) {
        auto id = pending.back();
        pending.pop_back();
        if (id == target)
            return true;
        if (!seen.insert(id).second)
            continue;
        const auto next = graph.find(id);
        if (next != graph.end())
            pending.insert(pending.end(), next->second.begin(), next->second.end());
    }
    return false;
}
void validate_state(Catalog& catalog)
{
    for (const auto& record : catalog.records) {
        const auto& m = record.metadata;
        auto check = [&](const Json& predicates, const std::string& path) {
            Values seen;
            for (std::size_t i = 0; i < predicates.size(); ++i) {
                const auto& p = predicates[i];
                const auto key = slot(p);
                const auto location = path + "/" + std::to_string(i);
                if (seen.contains(key) && seen[key] != p["value"])
                    catalog.report(record, "contradictory-state",
                                   "Simultaneous conditions/effects conflict on one slot; split "
                                   "them into ordered steps or alternatives.",
                                   location);
                seen[key] = p["value"];
                if (p["kind"] == "outcome") {
                    const auto* choice = catalog.find(p["choice_point"]);
                    if (choice && choice->metadata["type"] == "choice-point" &&
                        p["value"] != "undecided" &&
                        !contains(choice->metadata["outcomes"], p["value"]))
                        catalog.report(record, "invalid-outcome",
                                       "Use an outcome declared by " +
                                           p["choice_point"].get<std::string>(),
                                       location + "/value");
                }
            }
        };
        if (m["type"] == "character") {
            std::set<std::string> facts;
            for (const auto& k : m.value("initial_knowledge", empty))
                if (!facts.insert(k["fact"].get<std::string>()).second)
                    catalog.report(record, "contradictory-state",
                                   "Declare each initial Character/Fact knowledge slot once.",
                                   "/initial_knowledge");
        }
        if (m["type"] == "event") {
            const auto& routes = m["prerequisites"]["any_of"];
            for (std::size_t i = 0; i < routes.size(); ++i)
                check(routes[i].value("conditions", empty),
                      "/prerequisites/any_of/" + std::to_string(i) + "/conditions");
            for (std::size_t i = 0; i < m["steps"].size(); ++i) {
                const auto& branches = m["steps"][i]["branches"];
                for (std::size_t j = 0; j < branches.size(); ++j)
                    for (const auto* field : {"conditions", "effects"})
                        check(branches[j][field], "/steps/" + std::to_string(i) + "/branches/" +
                                                      std::to_string(j) + "/" + field);
            }
        }
        if (m["type"] == "narrative-position") {
            const auto* event = catalog.find(m["event"]);
            const Json* step = nullptr;
            if (event && event->metadata["type"] == "event")
                for (const auto& s : event->metadata["steps"])
                    if (s["id"] == m.value("step", ""))
                        step = &s;
            bool branch_found = !m.contains("branch");
            if (step)
                for (const auto& b : (*step)["branches"])
                    branch_found = branch_found || b["id"] == m.value("branch", "");
            if ((m["at"] != "step" && (m.contains("step") || m.contains("branch"))) ||
                (m["at"] == "step" && (!step || !branch_found)))
                catalog.report(record, "invalid-position",
                               "Use entry/exit without step/branch, or name an existing Event step "
                               "and optional branch.",
                               "/at");
        }
    }
}
struct Node {
    std::vector<std::string> completed;
    Values values;
    std::set<std::string> unknown;
    std::string active;
    std::size_t step = 0;
    std::vector<std::string> branches;
};
struct Observation {
    std::string event;
    std::string at;
    std::string step;
    std::string branch;
    Node node;
};
struct Search {
    std::vector<Node> histories;
    std::vector<Observation> observations;
    bool truncated = false;
};
struct Baseline {
    Values values;
    Json domain = Json::array();
    std::set<std::string> outcomes;
};
Baseline baseline(const Catalog& catalog)
{
    Baseline result;
    const auto domains = Json::parse(contract_source)["record"]["x-stateDomains"];
    auto add = [&](Json p, const Json& domain) {
        const auto key = slot(p);
        result.values[key] = p["value"];
        if (p["kind"] == "outcome")
            result.outcomes.insert(key);
        for (const auto& value : domain) {
            p["value"] = value;
            result.domain.push_back(p);
        }
    };
    for (const auto& r : catalog.records) {
        const auto& m = r.metadata;
        const auto& id = m["id"];
        if (m["type"] == "fact")
            add({{"kind", "truth"}, {"fact", id}, {"value", m["initial"]}}, {true, false});
        if (m["type"] == "relationship")
            add({{"kind", "relationship"}, {"relationship", id}, {"value", m["initial"]}},
                domains["relationship"]);
        if (m["type"] == "revelation")
            add({{"kind", "revealed"}, {"revelation", id}, {"value", false}}, {true, false});
        if (m["type"] == "choice-point") {
            Json domain = {"undecided"};
            for (const auto& value : m["outcomes"])
                domain.push_back(value);
            add({{"kind", "outcome"}, {"choice_point", id}, {"value", "undecided"}}, domain);
        }
        if (m["type"] == "character")
            for (const auto& fact : catalog.records) {
                if (fact.metadata["type"] != "fact")
                    continue;
                Json value = "unknown";
                for (const auto& k : m.value("initial_knowledge", empty))
                    if (k["fact"] == fact.metadata["id"])
                        value = k["value"];
                add({{"kind", "knowledge"},
                     {"character", id},
                     {"fact", fact.metadata["id"]},
                     {"value", value}},
                    domains["knowledge"]);
            }
    }
    return result;
}
bool constrain(Node& node, const Json& conditions)
{
    for (const auto& p : conditions) {
        const auto key = slot(p);
        if (node.unknown.erase(key))
            node.values[key] = p["value"];
        else if (!node.values.contains(key) || node.values.at(key) != p["value"])
            return false;
    }
    return true;
}
Search explore(const std::vector<const Record*>& events, const Graph& chronology,
               const Baseline& initial, bool allow_unknown, bool allow_incomplete)
{
    constexpr std::size_t limit = 4096;
    Search result;
    std::vector<Node> nodes{Node{{}, initial.values, {}, {}, 0, {}}};
    auto key = [](const Node& n) {
        auto completed = n.completed;
        std::sort(completed.begin(), completed.end());
        return Json::array({completed, n.values, n.unknown, n.active, n.step}).dump();
    };
    std::set<std::string> seen{key(nodes.front())};
    auto enqueue = [&](Node node, std::string event, std::string at, std::string step = "",
                       std::string branch = "") {
        const auto identity = key(node);
        if (!seen.contains(identity)) {
            if (nodes.size() >= limit) {
                result.truncated = true;
                return;
            }
            seen.insert(identity);
            nodes.push_back(node);
        }
        if (!at.empty())
            result.observations.push_back({event, at, step, branch, std::move(node)});
    };
    auto defer = [&](Node& node) {
        const auto previous = node.unknown;
        node.unknown.clear();
        for (const auto& [key, value] : node.values)
            if (!initial.outcomes.contains(key) || previous.contains(key) || value == "undecided")
                node.unknown.insert(key);
    };
    for (std::size_t cursor = 0; cursor < nodes.size(); ++cursor) {
        // Enqueue may reallocate nodes; this copy is the current transition source.
        const auto n = nodes[cursor];
        if (n.active.empty()) {
            result.histories.push_back(n);
            for (const auto* record : events) {
                const auto& e = record->metadata;
                const auto id = e["id"].get<std::string>();
                if (std::find(n.completed.begin(), n.completed.end(), id) != n.completed.end() ||
                    std::any_of(
                        n.completed.begin(), n.completed.end(),
                        [&](const auto& later) { return reaches(chronology, later, id); }) ||
                    std::any_of(e["after"].begin(), e["after"].end(), [&](const Json& earlier) {
                        return reaches(chronology, earlier.get<std::string>(), id);
                    }))
                    continue;
                const auto& alternatives = e["prerequisites"]["any_of"];
                if (allow_incomplete && partial(e) && alternatives.empty()) {
                    auto next = n;
                    next.active = id;
                    next.step = 0;
                    enqueue(std::move(next), id, "entry");
                    continue;
                }
                for (const auto& route : alternatives) {
                    auto completed = [&](const Json& event) {
                        return std::find(n.completed.begin(), n.completed.end(),
                                         event.get<std::string>()) != n.completed.end();
                    };
                    if ((!allow_unknown && route.contains("unverified")) ||
                        !std::all_of(route["completed"].begin(), route["completed"].end(),
                                     completed) ||
                        std::any_of(route["not_completed"].begin(), route["not_completed"].end(),
                                    completed))
                        continue;
                    auto next = n;
                    if (!constrain(next, route.value("conditions", empty)))
                        continue;
                    next.active = id;
                    next.step = 0;
                    enqueue(std::move(next), id, "entry");
                }
            }
            continue;
        }
        const auto found = std::find_if(events.begin(), events.end(), [&](const Record* r) {
            return r->metadata["id"] == n.active;
        });
        const auto& e = (*found)->metadata;
        if (n.step >= e["steps"].size()) {
            auto next = n;
            if (allow_incomplete && partial(e))
                defer(next);
            next.active.clear();
            next.step = 0;
            next.completed.push_back(n.active);
            enqueue(std::move(next), n.active, "exit");
            continue;
        }
        const auto& step = e["steps"][n.step];
        if (allow_incomplete && partial(e) && step["branches"].empty()) {
            auto next = n;
            defer(next);
            ++next.step;
            enqueue(std::move(next), "", "");
            continue;
        }
        for (const auto& branch : step["branches"]) {
            if (!allow_unknown && branch.contains("unverified"))
                continue;
            auto next = n;
            if (!constrain(next, branch["conditions"]))
                continue;
            bool conflict = false;
            for (const auto& p : branch["effects"]) {
                const auto k = slot(p);
                if (p["kind"] == "outcome" && !next.unknown.contains(k) &&
                    next.values[k] != "undecided" && next.values[k] != p["value"])
                    conflict = true;
            }
            if (conflict)
                continue;
            for (const auto& p : branch["effects"]) {
                const auto k = slot(p);
                next.values[k] = p["value"];
                next.unknown.erase(k);
            }
            ++next.step;
            next.branches.push_back(n.active + "#" + step["id"].get<std::string>() + "/" +
                                    branch["id"].get<std::string>());
            enqueue(std::move(next), n.active, "step", step["id"], branch["id"]);
        }
    }
    return result;
}
const Node* witness(const Search& search, const Json& ids)
{
    for (const auto& n : search.histories)
        if (std::all_of(ids.begin(), ids.end(), [&](const Json& id) {
                return std::find(n.completed.begin(), n.completed.end(), id.get<std::string>()) !=
                       n.completed.end();
            }))
            return &n;
    return nullptr;
}
const Observation* observe(const Search& search,
                           const std::function<bool(const Observation&)>& select)
{
    const auto it = std::find_if(search.observations.begin(), search.observations.end(), select);
    return it == search.observations.end() ? nullptr : &*it;
}
} // namespace
Json analyze(Catalog& catalog)
{
    validate_state(catalog);
    const bool invalid = !catalog.diagnostics.empty();
    std::vector<const Record*> events;
    Graph chronology, required;
    for (const auto& r : catalog.records) {
        const auto& e = r.metadata;
        if (e["type"] != "event")
            continue;
        events.push_back(&r);
        const auto id = e["id"].get<std::string>();
        chronology[id] = e["after"].get<std::vector<std::string>>();
        const auto& routes = e["prerequisites"]["any_of"];
        if (!routes.empty())
            for (const auto& predecessor : routes[0]["completed"])
                if (std::all_of(routes.begin(), routes.end(), [&](const Json& route) {
                        return contains(route["completed"], predecessor);
                    }))
                    required[id].push_back(predecessor);
    }
    for (const auto* r : events) {
        const auto id = r->metadata["id"].get<std::string>();
        for (const auto& [graph, field, code] :
             {std::tuple{&chronology, "after", "chronology-cycle"},
              std::tuple{&required, "prerequisites", "required-predecessor-cycle"}})
            for (const auto& predecessor : (*graph)[id])
                if (reaches(*graph, predecessor, id))
                    catalog.report(*r, code,
                                   id + " and " + predecessor +
                                       " form a cycle; revise the cyclic edge.",
                                   "/" + std::string(field));
    }
    const auto initial = baseline(catalog);
    const auto definite = explore(events, chronology, initial, false, false);
    const auto possible = explore(events, chronology, initial, true, false);
    const bool unfinished = std::any_of(events.begin(), events.end(),
                                        [](const Record* r) { return partial(r->metadata); });
    const auto optimistic =
        unfinished ? explore(events, chronology, initial, true, true) : possible;
    const bool truncated = definite.truncated || possible.truncated || optimistic.truncated;
    auto finding = [&](std::string status, const Node* proof = nullptr) {
        Json value = {
            {"status", status},
            {"action", status == "reachable" ? "Review this structural witness against prose "
                                               "intent; engine behavior is not proven."
                       : status == "impossible"
                           ? "Revise contradictory prerequisites, chronology or effects; no "
                             "declared history can fulfill this requirement."
                       : status == "incomplete"
                           ? "Complete the partial Event dependencies before claiming coverage."
                           : "Repair invalid input, resolve unverified conditions, or reduce the "
                             "cluster below the 4096-state budget."}};
        if (proof && !invalid) {
            value["witness"] = proof->completed;
            value["branches"] = proof->branches;
        }
        return value;
    };
    auto assess = [&](const Json& ids) {
        if (invalid)
            return finding("unverified");
        if (const auto* proof = witness(definite, ids)) {
            const bool pending = std::any_of(ids.begin(), ids.end(), [&](const Json& id) {
                const auto* r = catalog.find(id);
                return r && partial(r->metadata);
            });
            return finding(pending ? "incomplete" : "reachable", proof);
        }
        if (witness(possible, ids))
            return finding("unverified");
        if (witness(optimistic, ids))
            return finding("incomplete");
        return finding(truncated ? "unverified" : "impossible");
    };
    Json result = {
        {"level", "event-progression"},
        {"eventProgress", empty},
        {"milestoneRoutes", empty},
        {"branchProgress", empty},
        {"puzzleSolutions", empty},
        {"narrativeState", empty},
        {"unverifiedBranches", empty},
        {"search", {{"limit", 4096}, {"truncated", truncated}}},
        {"unverified",
         {"prose-only-conditions", "narrative-quality", "story-completeness", "engine-behavior"}}};
    auto publish = [&](const Record& r, const std::string& pointer, Json value,
                       const std::string& code) {
        if (value["status"] == "impossible")
            catalog.report(r, code,
                           r.metadata["id"].get<std::string>() + ": " +
                               value["action"].get<std::string>(),
                           pointer);
        return catalog.located(r, pointer, std::move(value));
    };
    for (const auto* r : events) {
        const auto& e = r->metadata;
        auto event = assess(Json::array({e["id"]}));
        event["id"] = e["id"];
        result["eventProgress"].push_back(
            publish(*r, "/prerequisites", event, "impossible-prerequisite"));
        auto unknown = [&](const Json& branch, const std::string& path) {
            if (branch.contains("unverified"))
                result["unverifiedBranches"].push_back(
                    catalog.located(*r, path + "/unverified",
                                    {{"id", e["id"]},
                                     {"condition", branch["unverified"]},
                                     {"action", "Model this condition or obtain narrative review; "
                                                "this branch is not proven."}}));
        };
        for (std::size_t i = 0; i < e["prerequisites"]["any_of"].size(); ++i)
            unknown(e["prerequisites"]["any_of"][i], "/prerequisites/any_of/" + std::to_string(i));
        for (std::size_t i = 0; i < e["steps"].size(); ++i) {
            const auto& s = e["steps"][i];
            for (std::size_t j = 0; j < s["branches"].size(); ++j) {
                const auto& b = s["branches"][j];
                const auto path = "/steps/" + std::to_string(i) + "/branches/" + std::to_string(j);
                unknown(b, path);
                auto select = [&](const Observation& o) {
                    return o.event == e["id"] && o.step == s["id"] && o.branch == b["id"];
                };
                const auto* proof = observe(definite, select);
                const auto status = invalid ? "unverified"
                                    : proof ? partial(e) ? "incomplete" : "reachable"
                                    : observe(possible, select)   ? "unverified"
                                    : observe(optimistic, select) ? "incomplete"
                                    : truncated                   ? "unverified"
                                                                  : "impossible";
                auto branch = finding(status, proof ? &proof->node : nullptr);
                branch["event"] = e["id"];
                branch["step"] = s["id"];
                branch["branch"] = b["id"];
                result["branchProgress"].push_back(publish(*r, path, branch, "impossible-branch"));
            }
        }
    }
    for (const auto& r : catalog.records) {
        const auto& m = r.metadata;
        if (m["type"] == "milestone") {
            Json routes = empty;
            bool resolved = true;
            for (std::size_t i = 0; i < m["fulfillment"]["any_of"].size(); ++i) {
                const auto& ids = m["fulfillment"]["any_of"][i];
                for (const auto& id : ids)
                    resolved =
                        resolved && std::count_if(catalog.records.begin(), catalog.records.end(),
                                                  [&](const Record& item) {
                                                      return item.metadata["id"] == id &&
                                                             item.metadata["type"] == "event";
                                                  }) == 1;
                auto route = assess(ids);
                route["alternative"] = i;
                routes.push_back(publish(r, "/fulfillment/any_of/" + std::to_string(i), route,
                                         "impossible-fulfillment"));
            }
            result["milestoneRoutes"].push_back({{"id", m["id"]},
                                                 {"alternatives", routes.size()},
                                                 {"referencesResolved", resolved},
                                                 {"routes", routes}});
        }
        if (m["type"] == "puzzle") {
            Json solutions = empty;
            std::vector<std::pair<std::string, std::string>> sources;
            bool pending_clues = false;
            for (const auto& clue : m["clues"]) {
                const auto* content = catalog.find(clue);
                if (!content || content->metadata["type"] != "authored-content")
                    continue;
                pending_clues = pending_clues ||
                                (partial(content->metadata) && content->metadata["events"].empty());
                for (const auto& event : content->metadata["events"])
                    sources.emplace_back(clue, event);
            }
            for (std::size_t i = 0; i < m["solutions"].size(); ++i) {
                const auto id = m["solutions"][i].get<std::string>();
                auto solution = assess(Json::array({id}));
                solution["event"] = id;
                solution = publish(r, "/solutions/" + std::to_string(i), solution,
                                   "unobtainable-puzzle-solution");
                auto prior = [&](const Observation& o) {
                    return o.event == id && o.at == "entry" &&
                           std::any_of(sources.begin(), sources.end(), [&](const auto& source) {
                               return std::find(o.node.completed.begin(), o.node.completed.end(),
                                                source.second) != o.node.completed.end();
                           });
                };
                const auto* proof = observe(definite, prior);
                const bool in_solution =
                    std::any_of(sources.begin(), sources.end(),
                                [&](const auto& source) { return source.second == id; });
                const auto status = invalid                                        ? "unverified"
                                    : m["clues"].empty() || m["solutions"].empty() ? "incomplete"
                                    : proof                                        ? "reachable"
                                    : observe(possible, prior) || in_solution      ? "unverified"
                                    : observe(optimistic, prior) || pending_clues  ? "incomplete"
                                    : truncated                                    ? "unverified"
                                                                                   : "impossible";
                auto access = finding(status, proof ? &proof->node : nullptr);
                access["availableClues"] = empty;
                if (proof)
                    for (const auto& [clue, event] : sources)
                        if (std::find(proof->node.completed.begin(), proof->node.completed.end(),
                                      event) != proof->node.completed.end() &&
                            !contains(access["availableClues"], clue))
                            access["availableClues"].push_back(clue);
                if (access["status"] == "impossible")
                    catalog.report(r, "unobtainable-puzzle-clue",
                                   m["id"].get<std::string>() +
                                       ": no declared clue can precede solution " + id +
                                       "; link clue content to an earlier obtainable Event.",
                                   "/clues");
                solution["clueAccess"] = access;
                solutions.push_back(solution);
            }
            result["puzzleSolutions"].push_back({{"id", m["id"]}, {"solutions", solutions}});
        }
        if (m["type"] == "narrative-position") {
            auto selects = [&](const Observation& o) {
                return o.event == m["event"] && o.at == m["at"] &&
                       (m["at"] != "step" || o.step == m.value("step", "")) &&
                       (!m.contains("branch") || o.branch == m["branch"]);
            };
            const auto* target = catalog.find(m["event"]);
            const bool incomplete = partial(m) || (target && partial(target->metadata));
            const auto count = [&](const Search& search) {
                return std::count_if(search.observations.begin(), search.observations.end(),
                                     selects);
            };
            const bool incomplete_path = count(optimistic) > count(possible) ||
                                         observe(optimistic, [&](const Observation& o) {
                                             return selects(o) && !o.node.unknown.empty();
                                         });
            const bool known = observe(definite, selects);
            const auto status = invalid                                     ? "unverified"
                                : incomplete || (!known && incomplete_path) ? "incomplete"
                                : known                                     ? "reachable"
                                : observe(possible, selects) || truncated   ? "unverified"
                                                                            : "impossible";
            Json state = empty;
            for (const auto& predicate : initial.domain) {
                const auto key = slot(predicate);
                auto has = [&](const Search& search, bool match) {
                    return observe(search, [&](const Observation& o) {
                               const auto it = o.node.values.find(key);
                               return selects(o) && ((it != o.node.values.end() &&
                                                      it->second == predicate["value"]) == match);
                           }) != nullptr;
                };
                const bool yes = has(definite, true), no = has(definite, false);
                const auto classification = invalid || incomplete || incomplete_path ? "unverified"
                                            : yes && no                              ? "conditional"
                                            : truncated || !known || has(possible, !yes)
                                                ? "unverified"
                                            : yes ? "guaranteed"
                                                  : "unavailable";
                state.push_back({{"predicate", predicate}, {"status", classification}});
            }
            result["narrativeState"].push_back(
                catalog.located(r, "/at", {{"id", m["id"]}, {"status", status}, {"state", state}}));
        }
    }
    bool minimum = !result["milestoneRoutes"].empty();
    for (const auto& milestone : result["milestoneRoutes"])
        minimum = minimum && std::any_of(milestone["routes"].begin(), milestone["routes"].end(),
                                         [](const Json& r) { return r["status"] == "reachable"; });
    result["minimumProgress"] = minimum ? "declared-milestones-reachable" : "needs-work";
    return result;
}
} // namespace noveltea::narrative
