#include "native_cli_narrative_report.hpp"

#include <sstream>

namespace noveltea::cli {
namespace {
using Json = nlohmann::ordered_json;

Json sample(const Json& rows)
{
    Json items = Json::array();
    for (const auto& row : rows) {
        if (items.size() == 8)
            break;
        items.push_back(row);
        if (items.back().is_object())
            items.back().erase("witnesses");
    }
    return {{"total", rows.size()}, {"truncated", items.size() < rows.size()}, {"items", items}};
}

Json coverage_summary(const Json& coverage)
{
    Json counts = Json::object();
    auto count = [&](const char* category, const Json& row) {
        auto& group = counts[category];
        const auto status = row.at("status").get<std::string>();
        group[status] = group.value(status, 0u) + 1;
    };
    for (auto key : {"eventProgress", "branchProgress", "routes", "solutions", "clueAccess",
                     "narrativeState", "predicates"})
        counts[key] = Json::object();
    for (auto key : {"eventProgress", "branchProgress"})
        for (const auto& row : coverage.at(key))
            count(key, row);
    for (const auto& milestone : coverage.at("milestoneRoutes"))
        for (const auto& route : milestone.at("routes"))
            count("routes", route);
    for (const auto& puzzle : coverage.at("puzzleSolutions"))
        for (const auto& solution : puzzle.at("solutions")) {
            count("solutions", solution);
            count("clueAccess", solution.at("clueAccess"));
        }
    for (const auto& position : coverage.at("narrativeState")) {
        count("narrativeState", position);
        for (const auto& state : position.at("state"))
            count("predicates", state);
    }
    return {{"statusCounts", counts},
            {"minimumProgress", coverage.at("minimumProgress")},
            {"search", coverage.at("search")},
            {"unverified", coverage.at("unverified")},
            {"unverifiedBranches", sample(coverage.at("unverifiedBranches"))}};
}

Json readiness_summary(const Json& report)
{
    Json minima = Json::object();
    for (auto view : {"design", "approved"})
        for (const auto& [stage, gate] : report.at(view).at("stages").items())
            minima[view][stage] = gate.at("minimum");
    Json clusters = Json::array();
    for (const auto& cluster : report.at("clusters")) {
        Json row = {{"id", cluster.at("id")}, {"minimum", cluster.at("minimum")}};
        if (cluster.contains("diagnostic"))
            row["diagnostic"] = cluster.at("diagnostic");
        else {
            row["bounded"] = cluster.at("bounded");
            row["blockingGaps"] = sample(cluster.at("findings"));
        }
        clusters.push_back(std::move(row));
    }
    const auto& focus = report.at("focus");
    return {{"stage", report.at("stage")},
            {"view", report.at("view")},
            {"wholeStoryMinima", minima},
            {"wholeStoryFocus",
             {{"minimum", focus.at("minimum")},
              {"blockingGaps", sample(focus.at("blockingGaps"))},
              {"unverified", focus.at("unverified")}}},
            {"clusters", clusters},
            {"outstanding", sample(report.at("outstanding"))},
            {"qualitative", report.at("qualitative")}};
}
} // namespace

void compact_narrative_result(Json& result)
{
    Json summary = {{"fullDetail", "Repeat the same command without --summary for records, "
                                   "witnesses, position state, impact and all findings."}};
    if (result.contains("catalog")) {
        const auto& catalog = result.at("catalog");
        summary["contractRevision"] = catalog.at("contractRevision");
        summary["recordCount"] = catalog.at("records").size();
        summary["authorization"] = catalog.at("authorization");
        summary["coverage"] = coverage_summary(catalog.at("coverage"));
        if (catalog.contains("protection")) {
            const auto& protection = catalog.at("protection");
            auto& compact = summary["protection"];
            for (const auto& [key, value] : protection.items()) {
                if (key != "impact")
                    compact[key] = value;
                else
                    compact[key] = {{"changed", sample(value.at("changed"))},
                                    {"moved", sample(value.at("moved"))},
                                    {"affectedCount", value.at("affected").size()},
                                    {"bounded", value.at("bounded")},
                                    {"unverified", value.at("unverified")}};
            }
        }
        result.erase("catalog");
    }
    if (result.contains("readiness")) {
        const auto& report = result.at("readiness");
        summary["contractRevision"] = report.at("contractRevision");
        if (!summary.contains("authorization"))
            summary["authorization"] = report.at("authorization");
        summary["readiness"] = readiness_summary(report);
        result.erase("readiness");
    }
    result["summary"] = std::move(summary);
}

std::string narrative_result_message(const Json& result)
{
    std::ostringstream out;
    out << "Diagnostics: " << result.at("diagnostics").size();
    if (result.contains("catalog")) {
        const auto& catalog = result.at("catalog");
        out << "; authorization: " << catalog.at("authorization").at("status").get<std::string>();
        if (catalog.contains("protection")) {
            const auto& protection = catalog.at("protection");
            out << "; protection: " << protection.at("status").get<std::string>();
            for (const auto& f : protection.at("findings"))
                out << "\n  " << f.at("decisionId").get<std::string>() << ": "
                    << f.at("category").get<std::string>() << " (approval required)";
        }
    }
    if (result.contains("readiness")) {
        const auto& r = result.at("readiness");
        out << "\nReadiness (" << r.at("view").get<std::string>() << ", "
            << r.at("stage").get<std::string>()
            << ") whole Story: " << r.at("focus").at("minimum").get<std::string>();
        for (const auto& cluster : r.at("clusters"))
            out << "\n  " << cluster.at("id").get<std::string>() << ": "
                << cluster.at("minimum").get<std::string>();
    }
    return out.str();
}
} // namespace noveltea::cli
