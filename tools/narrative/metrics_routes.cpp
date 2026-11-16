#include "metrics_routes.hpp"

#include <noveltea/core/fingerprint.hpp>

#include <algorithm>
#include <cmath>
#include <map>
#include <set>
#include <string>
#include <vector>

namespace noveltea::narrative {
namespace {
Json range_sum(const Json& left, const Json& right)
{
    if (left.is_null() || right.is_null())
        return nullptr;
    const double minimum = left["min_minutes"].get<double>() + right["min_minutes"].get<double>();
    const double maximum = left["max_minutes"].get<double>() + right["max_minutes"].get<double>();
    if (!std::isfinite(minimum) || !std::isfinite(maximum))
        return nullptr;
    return {{"min_minutes", minimum}, {"max_minutes", maximum}};
}

std::string route_key(const Json& events)
{
    auto sorted = events.get<std::vector<std::string>>();
    std::sort(sorted.begin(), sorted.end());
    return Json(sorted).dump();
}

bool includes_all(const std::set<std::string>& completed, const Json& ids)
{
    return std::all_of(ids.begin(), ids.end(),
                       [&](const Json& id) { return completed.contains(id.get<std::string>()); });
}

Json duration_for(const Json& milestone, std::size_t alternative)
{
    Json result = milestone.value("duration_minutes", Json::object());
    const auto selected = route_key(milestone["fulfillment"]["any_of"][alternative]);
    for (const auto& route : milestone.value("route_estimates", Json::array())) {
        if (route_key(route["events"]) != selected)
            continue;
        if (route.contains("duration_minutes"))
            for (const auto& [key, duration] : route["duration_minutes"].items())
                result[key] = duration;
        break;
    }
    return result;
}

Json minutes(const Json& source, const char* category)
{
    return source.contains(category) ? source.at(category) : Json(nullptr);
}

std::set<std::string> ids(const Json& values) { return values.get<std::set<std::string>>(); }
} // namespace

Json route_metrics(const Catalog& catalog, const Json& coverage)
{
    const auto traced = trace_story_routes(catalog);
    const Record* direction = nullptr;
    std::vector<const Record*> milestones;
    std::vector<const Record*> content;
    std::map<std::string, std::vector<std::string>> character_tiers;
    for (const auto& tier : {"main", "supporting", "extra", "none", "unclassified"})
        character_tiers[tier] = {};
    for (const auto& record : catalog.records) {
        const auto& metadata = record.metadata;
        const auto type = metadata["type"].get<std::string>();
        if (metadata["status"] == "superseded")
            continue;
        if (type == "creative-direction")
            direction = &record;
        else if (type == "milestone")
            milestones.push_back(&record);
        else if (type == "authored-content")
            content.push_back(&record);
        else if (type == "character") {
            const auto tier = metadata.value("artwork_tier", "unclassified");
            character_tiers[tier].push_back(metadata["id"].get<std::string>());
        }
    }

    const auto foundation = direction->metadata;
    const auto planning = foundation.value("planning", Json::object());
    const bool approved = foundation["status"] == "approved";
    const auto target = approved ? minutes(planning, "first_playthrough") : Json(nullptr);
    Json routes = Json::array();
    std::set<std::string> signatures;
    std::size_t ambiguous_histories = 0;
    for (const auto& history : traced["histories"]) {
        const auto completed = ids(history["events"]);
        Json selections = Json::array();
        Json narrative = {{"min_minutes", 0.0}, {"max_minutes", 0.0}};
        Json exploration = narrative;
        std::set<std::string> accounted_events;
        std::map<std::string, Json> accounted_selectors;
        bool supported = true;
        for (const auto* record : milestones) {
            const auto& milestone = record->metadata;
            const auto& alternatives = milestone["fulfillment"]["any_of"];
            std::vector<std::size_t> matched;
            for (std::size_t i = 0; i < alternatives.size(); ++i)
                if (includes_all(completed, alternatives[i]))
                    matched.push_back(i);
            if (matched.size() != 1) {
                supported = false;
                break;
            }
            const auto duration = duration_for(milestone, matched.front());
            const auto& selected_events = alternatives[matched.front()];
            const auto selector = route_key(selected_events);
            const bool overlaps =
                std::any_of(selected_events.begin(), selected_events.end(), [&](const Json& id) {
                    return accounted_events.contains(id.get<std::string>());
                });
            const bool shared = overlaps && accounted_selectors.contains(selector) &&
                                accounted_selectors.at(selector) == duration;
            const auto accounting = shared     ? "shared-deduplicated"
                                    : overlaps ? "unverified-overlap"
                                               : "counted";
            if (!shared && overlaps) {
                // Distinct Milestones can describe the same Event's time. A
                // partial overlap cannot be apportioned from Milestone ranges.
                narrative = nullptr;
                exploration = nullptr;
            } else if (!shared) {
                narrative = range_sum(narrative, minutes(duration, "narrative"));
                exploration = range_sum(exploration, minutes(duration, "exploration"));
            }
            for (const auto& id : selected_events)
                accounted_events.insert(id.get<std::string>());
            accounted_selectors.try_emplace(selector, duration);
            selections.push_back({{"milestoneId", milestone["id"]},
                                  {"alternative", matched.front()},
                                  {"events", selected_events},
                                  {"accounting", accounting},
                                  {"narrativeMinutes", minutes(duration, "narrative")},
                                  {"explorationMinutes", minutes(duration, "exploration")},
                                  {"difference", [&]() -> Json {
                                       const auto key = route_key(alternatives[matched.front()]);
                                       for (const auto& estimate :
                                            milestone.value("route_estimates", Json::array()))
                                           if (route_key(estimate["events"]) == key)
                                               return estimate.value("difference", Json(nullptr));
                                       return nullptr;
                                   }()}});
        }
        if (!supported) {
            ++ambiguous_histories;
            continue;
        }
        // Histories from different Event execution orders can still represent
        // the same route; identity includes branches and typed state, not order.
        Json selected_alternatives = Json::array();
        for (const auto& selection : selections)
            selected_alternatives.push_back({selection["milestoneId"], selection["alternative"]});
        // Duration estimates and editorial difference prose can change at a
        // new source revision without changing which causal route was chosen.
        const auto signature = Json::array({history["events"], history["branches"],
                                            history["state"], selected_alternatives})
                                   .dump();
        if (!signatures.insert(signature).second)
            continue;
        Json content_ids = Json::array();
        for (const auto* record : content) {
            const auto& linked = record->metadata["events"];
            if (std::any_of(linked.begin(), linked.end(), [&](const Json& id) {
                    return completed.contains(id.get<std::string>());
                }))
                content_ids.push_back(record->metadata["id"]);
        }
        routes.push_back({{"id", core::xxh3_128_revision(signature)},
                          {"status", "structurally-reachable"},
                          {"completedEvents", history["events"]},
                          {"chosenBranches", history["branches"]},
                          {"state", history["state"]},
                          {"milestones", selections},
                          {"authoredContentIds", content_ids},
                          {"narrativeMinutes", narrative},
                          {"explorationMinutes", exploration},
                          {"totalMinutes", range_sum(narrative, exploration)}});
    }
    std::sort(routes.begin(), routes.end(), [](const Json& a, const Json& b) {
        return a["id"].get<std::string>() < b["id"].get<std::string>();
    });

    bool incomplete = traced["truncated"].get<bool>() ||
                      coverage["search"]["truncated"].get<bool>() ||
                      !coverage["unverifiedBranches"].empty() || ambiguous_histories != 0;
    for (const auto& record : catalog.records)
        if (record.metadata["status"] != "superseded" &&
            record.metadata.value("completeness", "complete") == "partial")
            incomplete = true;
    for (const auto& finding : coverage["milestoneRoutes"])
        for (const auto& route : finding["routes"])
            if (route["status"] != "reachable")
                incomplete = true;
    // A route is never a gameplay-certified or editorially complete path;
    // bounded structural exhaustiveness refers only to the declared model.
    const bool complete_search = !incomplete && !routes.empty();

    Json observed_bounds = nullptr;
    bool all_measured = !routes.empty();
    for (const auto& route : routes) {
        const auto& duration = route["totalMinutes"];
        if (duration.is_null()) {
            all_measured = false;
            continue;
        }
        if (observed_bounds.is_null()) {
            observed_bounds = duration;
        } else {
            observed_bounds["min_minutes"] = std::min(observed_bounds["min_minutes"].get<double>(),
                                                      duration["min_minutes"].get<double>());
            observed_bounds["max_minutes"] = std::max(observed_bounds["max_minutes"].get<double>(),
                                                      duration["max_minutes"].get<double>());
        }
    }

    Json content_records = Json::array();
    Json shared = Json::array(), exclusive = Json::array(), unassigned = Json::array();
    for (const auto* record : content) {
        const auto id = record->metadata["id"].get<std::string>();
        std::size_t present = 0;
        for (const auto& route : routes)
            if (std::find(route["authoredContentIds"].begin(), route["authoredContentIds"].end(),
                          id) != route["authoredContentIds"].end())
                ++present;
        const auto classification = !complete_search           ? "unverified"
                                    : present == routes.size() ? "shared"
                                    : present == 0             ? "unassigned"
                                                               : "route-exclusive";
        content_records.push_back({{"id", id},
                                   {"path", record->path},
                                   {"events", record->metadata["events"]},
                                   {"witnessedRoutes", present},
                                   {"classification", classification}});
        if (complete_search) {
            if (present == routes.size())
                shared.push_back(id);
            else if (present == 0)
                unassigned.push_back(id);
            else
                exclusive.push_back(id);
        }
    }

    const auto concepts = planning.value("illustration_concepts", Json(nullptr));
    Json illustrations = Json::array();
    std::size_t variants = 0;
    if (concepts.is_array())
        for (const auto& illustration : concepts) {
            Json variant_ids = Json::array();
            for (const auto& variant : illustration.value("variants", Json::array())) {
                variant_ids.push_back(illustration["id"].get<std::string>() + "/" +
                                      variant["id"].get<std::string>());
                ++variants;
            }
            illustrations.push_back({{"id", illustration["id"]},
                                     {"variants", variant_ids},
                                     {"source", direction->path}});
        }

    Json tier_summary = Json::object();
    for (const auto& [tier, members] : character_tiers)
        tier_summary[tier] = {{"count", members.size()}, {"characterIds", members}};

    Json findings = Json::array();
    const auto report_budget = [&](const std::string& dimension, const Json& budget, Json observed,
                                   bool uncertain, const std::string& pointer) {
        if (budget.is_null())
            return;
        const bool hard = budget["firmness"] == "hard";
        const bool exceeded =
            !observed.is_null() &&
            observed.get<std::uint64_t>() > budget["count"]["max"].get<std::uint64_t>();
        const auto status = !approved   ? "unapproved"
                            : exceeded  ? hard ? "hard-violation" : "soft-overage"
                            : uncertain ? "unverified"
                                        : "within-budget";
        const auto severity = exceeded && approved     ? hard ? "error" : "warning"
                              : uncertain || !approved ? "unverified"
                                                       : "info";
        findings.push_back(catalog.located(
            *direction, pointer,
            {{"dimension", dimension},
             {"code", status == "hard-violation" ? "budget-hard-violation"
                      : status == "soft-overage" ? "budget-soft-overage"
                      : status == "unverified"   ? "budget-unverified"
                      : status == "unapproved"   ? "budget-unapproved"
                                                 : "budget-within-target"},
             {"status", status},
             {"severity", severity},
             {"firmness", budget["firmness"]},
             {"count", observed},
             {"limit", budget["count"]["max"]},
             {"evidence", uncertain ? "incomplete-declaration" : "declared-metadata"}}));
    };
    const auto production = planning.value("production", Json::object());
    if (production.contains("illustrated_backgrounds"))
        report_budget("illustrated-backgrounds", production["illustrated_backgrounds"],
                      concepts.is_array() ? Json(concepts.size()) : Json(nullptr),
                      !concepts.is_array(), "/planning/production/illustrated_backgrounds");
    if (production.contains("background_variants"))
        report_budget("background-variants", production["background_variants"],
                      concepts.is_array() ? Json(variants) : Json(nullptr), !concepts.is_array(),
                      "/planning/production/background_variants");
    if (production.contains("character_artwork"))
        for (const auto& tier : {"main", "supporting", "extra"})
            if (production["character_artwork"].contains(tier))
                report_budget("character-artwork-" + std::string(tier),
                              production["character_artwork"][tier], character_tiers[tier].size(),
                              !character_tiers["unclassified"].empty(),
                              "/planning/production/character_artwork/" + std::string(tier));
    if (!target.is_null()) {
        for (const auto& route : routes) {
            const auto& duration = route["totalMinutes"];
            std::string status = "within-target";
            if (duration.is_null() || !complete_search)
                status = "unverified";
            else if (duration["min_minutes"].get<double>() > target["max_minutes"].get<double>())
                status = "target-overrun";
            else if (duration["max_minutes"].get<double>() < target["min_minutes"].get<double>())
                status = "target-underrun";
            else if (duration["min_minutes"].get<double>() < target["min_minutes"].get<double>() ||
                     duration["max_minutes"].get<double>() > target["max_minutes"].get<double>())
                status = "target-risk";
            findings.push_back(
                catalog.located(*direction, "/planning/first_playthrough",
                                {{"dimension", "first-playthrough"},
                                 {"code", "duration-" + status},
                                 {"routeId", route["id"]},
                                 {"status", status},
                                 {"severity", status == "unverified"      ? "unverified"
                                              : status == "within-target" ? "info"
                                                                          : "warning"},
                                 {"targetMinutes", target},
                                 {"estimatedMinutes", duration}}));
        }
    }

    // Contradictory post-branch Facts/Relationships must survive reconvergence;
    // compare source-grounded typed state, never infer distinct Scenes from Choices.
    std::map<std::string, std::set<std::string>> state_values;
    for (const auto& route : routes)
        for (const auto& value : route["state"])
            state_values[value["predicate"].dump()].insert(value["value"].dump());
    Json divergences = Json::array();
    for (const auto& [predicate, values] : state_values)
        if (values.size() > 1) {
            Json variants = Json::array();
            for (const auto& value : values)
                variants.push_back(Json::parse(value));
            divergences.push_back({{"predicate", Json::parse(predicate)}, {"values", variants}});
        }

    return {
        {"routes", routes},
        {"routeBounds",
         {{"status", !complete_search || !all_measured ? "unverified" : "declared-exhaustive"},
          {"observedMinutes", observed_bounds},
          {"guaranteedMinutes",
           complete_search && all_measured ? observed_bounds : Json(nullptr)}}},
        {"routeCoverage",
         {{"status", complete_search ? "bounded-complete" : "unverified"},
          {"stateLimit", traced["stateLimit"]},
          {"outputLimit", traced["outputLimit"]},
          {"truncated", traced["truncated"]},
          {"unsupportedHistories", ambiguous_histories},
          {"supportedRoutes", routes.size()},
          {"unverified", "Undeclared endings, optional Events, prose "
                         "conditions and actual player routes are not measured."}}},
        {"contentFootprint",
         {{"distinctAuthoredContentCount", content.size()},
          {"authoredContent", content_records},
          {"sharedContentIds", shared},
          {"routeExclusiveContentIds", exclusive},
          {"unassignedContentIds", unassigned},
          {"illustrationConceptCount", concepts.is_array() ? Json(concepts.size()) : Json(nullptr)},
          {"illustrationVariantCount", concepts.is_array() ? Json(variants) : Json(nullptr)},
          {"illustrationConcepts", illustrations},
          {"characterArtworkTiers", tier_summary},
          {"routeIllustrationAssignment", "unverified"},
          {"classificationCoverage", complete_search ? "declared-exhaustive" : "unverified"}}},
        {"stateDivergences", divergences},
        {"budgetFindings", findings}};
}
} // namespace noveltea::narrative
