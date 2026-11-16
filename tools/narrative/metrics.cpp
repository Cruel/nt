#include "catalog.hpp"
#include "catalog_internal.hpp"
#include "generated/contract.hpp"

#include <noveltea/core/fingerprint.hpp>

#include <algorithm>
#include <cmath>
#include <string>

namespace noveltea::narrative {
namespace {
Json sum_ranges(const Json& a, const Json& b)
{
    if (a.is_null() || b.is_null())
        return nullptr;
    const auto minimum = a["min_minutes"].get<double>() + b["min_minutes"].get<double>();
    const auto maximum = a["max_minutes"].get<double>() + b["max_minutes"].get<double>();
    if (!std::isfinite(minimum) || !std::isfinite(maximum))
        return nullptr;
    return {{"min_minutes", minimum}, {"max_minutes", maximum}};
}
Json optional_range(const Json& source, const char* key)
{
    return source.contains(key) ? source.at(key) : Json(nullptr);
}
Json summed_duration(const Json& narrative, const Json& exploration)
{
    return sum_ranges(narrative, exploration);
}
} // namespace

Json metrics_report(const std::filesystem::path& root)
{
    auto catalog = read_catalog(root);
    const auto evidence = analyze(catalog);
    const auto contract = Json::parse(contract_source);

    Json revisions = Json::array();
    std::string identity;
    for (const auto& record : catalog.records) {
        revisions.push_back({{"path", record.path}, {"sourceRevision", record.source_revision}});
        identity.append(record.path).push_back('\0');
        identity.append(record.source_revision).push_back('\0');
    }
    Json result = {{"metricsVersion", 1},
                   {"contractRevision", contract["revision"]},
                   {"catalogSourceRevision", core::xxh3_128_revision(identity)},
                   {"sourceRevisions", revisions},
                   {"diagnostics", catalog.diagnostics}};
    // Never publish partial sums for a malformed or semantically invalid catalog.
    if (!catalog.diagnostics.empty())
        return result;

    const Record* direction = nullptr;
    for (const auto& record : catalog.records)
        if (record.metadata["type"] == "creative-direction" &&
            record.metadata["status"] != "superseded") {
            direction = &record;
            break;
        }
    const auto& foundation = direction->metadata;
    const auto planning = foundation.value("planning", Json::object());
    const bool approved = foundation["status"] == "approved";
    const Json target = approved ? optional_range(planning, "first_playthrough") : Json(nullptr);
    result["foundation"] = {
        {"id", foundation["id"]},
        {"status", foundation["status"]},
        {"pacing", planning.value("pacing", Json(nullptr))},
        {"approvedFirstPlaythroughMinutes", target},
        {"targetCoverage", !approved          ? "unapproved"
                           : target.is_null() ? "missing"
                                              : "estimated"},
        {"productionBudget", planning.value("production", Json(nullptr))},
        {"illustrationConcepts", planning.value("illustration_concepts", Json::array())}};

    Json milestones = Json::array();
    Json route_narrative = {{"min_minutes", 0.0}, {"max_minutes", 0.0}};
    Json route_exploration = route_narrative;
    unsigned unknown_narrative = 0, unknown_exploration = 0, unresolved_routes = 0;
    for (const auto& record : catalog.records) {
        const auto& metadata = record.metadata;
        if (metadata["type"] != "milestone" || metadata["status"] == "superseded")
            continue;
        const auto& alternatives = metadata["fulfillment"]["any_of"];
        const bool single = alternatives.size() == 1;
        if (!single)
            ++unresolved_routes;
        Json duration = metadata.value("duration_minutes", Json::object());
        std::string estimate_source =
            metadata.contains("duration_minutes") ? "milestone" : "missing";
        if (single)
            for (const auto& estimate : metadata.value("route_estimates", Json::array()))
                if (estimate["events"] == alternatives[0] ||
                    (estimate["events"].size() == alternatives[0].size() && [&] {
                        auto a = estimate["events"].get<std::vector<std::string>>();
                        auto b = alternatives[0].get<std::vector<std::string>>();
                        std::sort(a.begin(), a.end());
                        std::sort(b.begin(), b.end());
                        return a == b;
                    }())) {
                    if (estimate.contains("duration_minutes")) {
                        for (const auto& [key, value] : estimate["duration_minutes"].items())
                            duration[key] = value;
                        estimate_source = "route-override";
                    }
                    break;
                }
        const auto narrative = optional_range(duration, "narrative");
        const auto exploration = optional_range(duration, "exploration");
        if (narrative.is_null())
            ++unknown_narrative;
        if (exploration.is_null())
            ++unknown_exploration;
        route_narrative = sum_ranges(route_narrative, narrative);
        route_exploration = sum_ranges(route_exploration, exploration);
        milestones.push_back({{"id", metadata["id"]},
                              {"path", record.path},
                              {"status", metadata["status"]},
                              {"alternatives", alternatives.size()},
                              {"estimateSource", estimate_source},
                              {"narrativeMinutes", narrative},
                              {"explorationMinutes", exploration},
                              {"totalMinutes", summed_duration(narrative, exploration)}});
    }
    // A Milestone's alternatives are not independent playthroughs; do not
    // combine mutually exclusive alternatives into a falsely precise total.
    const bool simple = !milestones.empty() && unresolved_routes == 0;
    result["milestones"] = milestones;
    result["route"] = {{"status", !simple ? "unresolved" : "provisional-single-alternative"},
                       {"milestoneIds", Json::array()},
                       {"narrativeMinutes", simple ? route_narrative : Json(nullptr)},
                       {"explorationMinutes", simple ? route_exploration : Json(nullptr)},
                       {"totalMinutes", simple ? summed_duration(route_narrative, route_exploration)
                                               : Json(nullptr)},
                       {"unverified", "Milestone time estimates are additive planning assumptions; "
                                      "shared content, route exclusivity, actual dialogue speed, "
                                      "and Puzzle solving time have not been measured."}};
    for (const auto& milestone : milestones)
        result["route"]["milestoneIds"].push_back(milestone["id"]);
    result["coverage"] = {{"milestoneCount", milestones.size()},
                          {"missingNarrative", unknown_narrative},
                          {"missingExploration", unknown_exploration},
                          {"unresolvedAlternatives", unresolved_routes},
                          {"searchTruncated", evidence["search"]["truncated"]},
                          {"approvedTargetAvailable", !target.is_null()},
                          {"routeTotalAvailable", !result["route"]["totalMinutes"].is_null()}};
    return result;
}
} // namespace noveltea::narrative
