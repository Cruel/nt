#include "catalog.hpp"
#include "catalog_internal.hpp"
#include "generated/contract.hpp"

#include <algorithm>
#include <map>
#include <set>
#include <string>
#include <string_view>
#include <vector>

namespace noveltea::narrative {
namespace {
bool begins(std::string_view text, std::string_view prefix) { return text.starts_with(prefix); }

bool has_unverified(const Json& value)
{
    if (value.is_object()) {
        if (value.contains("unverified"))
            return true;
        for (const auto& child : value)
            if (has_unverified(child))
                return true;
    } else if (value.is_array()) {
        for (const auto& child : value)
            if (has_unverified(child))
                return true;
    }
    return false;
}

std::string inclusion_code(const std::string& source_type, const std::string& pointer, bool reverse)
{
    if (reverse) {
        if (source_type == "authored-content")
            return "content-at-event";
        if (source_type == "puzzle")
            return begins(pointer, "/clues/") ? "puzzle-clue" : "puzzle-solution";
        if (source_type == "milestone")
            return "milestone-realization";
        if (source_type == "relationship")
            return "character-relationship";
        return "incoming-reference";
    }
    if (begins(pointer, "/after/"))
        return "chronological-predecessor";
    if (begins(pointer, "/prerequisites/"))
        return "declared-prerequisite";
    if (begins(pointer, "/steps/"))
        return "event-state-reference";
    if (begins(pointer, "/participants/"))
        return "event-participant";
    if (begins(pointer, "/arcs/"))
        return "arc-membership";
    if (begins(pointer, "/fulfillment/"))
        return "milestone-realization";
    if (begins(pointer, "/initial_knowledge/"))
        return "initial-knowledge";
    if (begins(pointer, "/events/"))
        return "content-event";
    if (begins(pointer, "/revelations/"))
        return "content-revelation";
    if (begins(pointer, "/characters/"))
        return "character-relationship";
    if (begins(pointer, "/clues/"))
        return "puzzle-clue";
    if (begins(pointer, "/solutions/"))
        return "puzzle-solution";
    if (pointer == "/event")
        return "position-event";
    return "declared-reference";
}

bool eligible_reverse(const Record& source, const std::string& pointer, const std::string& kind)
{
    const auto type = source.metadata["type"].get<std::string>();
    if (type == "authored-content")
        return begins(pointer, "/events/") || begins(pointer, "/revelations/");
    if (type == "puzzle")
        return begins(pointer, "/solutions/") || begins(pointer, "/clues/");
    if (type == "milestone")
        return begins(pointer, "/fulfillment/");
    if (type == "relationship")
        return kind == "dialogue" || kind == "character" || kind == "review";
    return false;
}

struct Inclusion {
    const Record* record = nullptr;
    int priority = 2;
    Json reasons = Json::array();
    std::set<std::string> seen;
};
} // namespace

Json context_manifest(const std::filesystem::path& root, const std::string& kind,
                      const std::vector<std::string>& ids, const std::string& position,
                      const std::string& scope)
{
    auto catalog = read_catalog(root);
    const auto coverage = analyze(catalog);
    const auto contract = Json::parse(contract_source);
    std::map<std::string, const Record*> records;
    std::set<std::string> ambiguous;
    for (const auto& record : catalog.records) {
        const auto id = record.metadata["id"].get<std::string>();
        if (!records.emplace(id, &record).second)
            ambiguous.insert(id);
    }
    std::map<std::string, Inclusion> selected;
    Json unresolved = Json::array();
    std::set<std::string> unresolved_keys;
    const auto flag = [&](const std::string& code, const std::string& id,
                          const std::string& source = "", const std::string& pointer = "") {
        const auto key = code + "|" + id + "|" + source + "|" + pointer;
        if (unresolved_keys.insert(key).second)
            unresolved.push_back(
                {{"code", code}, {"id", id}, {"sourceId", source}, {"pointer", pointer}});
    };
    const auto include = [&](const std::string& id, int priority, Json reason) {
        const auto found = records.find(id);
        if (found == records.end() || ambiguous.contains(id)) {
            flag("unresolved-reference", id, reason.value("sourceId", ""),
                 reason.value("pointer", ""));
            return false;
        }
        auto& entry = selected[id];
        entry.record = found->second;
        entry.priority = std::min(entry.priority, priority);
        const auto key = reason.dump();
        if (entry.seen.insert(key).second)
            entry.reasons.push_back(std::move(reason));
        return true;
    };
    for (const auto& id : ids) {
        if (!records.contains(id) || ambiguous.contains(id)) {
            flag("invalid-target-id", id);
            continue;
        }
        include(id, 0, {{"code", "requested-id"}, {"sourceId", id}, {"targetId", id}});
    }
    if (!position.empty()) {
        const auto found = records.find(position);
        if (found == records.end() || ambiguous.contains(position) ||
            found->second->metadata["type"] != "narrative-position") {
            flag("invalid-position-id", position);
        } else {
            include(
                position, 0,
                {{"code", "requested-position"}, {"sourceId", position}, {"targetId", position}});
            const auto event = found->second->metadata["event"].get<std::string>();
            include(event, 0,
                    {{"code", "position-event"},
                     {"sourceId", position},
                     {"targetId", event},
                     {"pointer", "/event"}});
        }
    }
    // A task has a one-hop evidence neighborhood. The optional related scope adds
    // only one additional hop from directly selected, non-Arc records; no closure.
    std::set<std::string> first;
    for (const auto& [id, entry] : selected)
        first.insert(id);
    const auto expand = [&](const std::set<std::string>& frontier, bool second) {
        for (const auto& ref : catalog.references) {
            const auto from = ref["source"].get<std::string>();
            const auto to = ref["target"].get<std::string>();
            const auto pointer = ref["pointer"].get<std::string>();
            const auto found = records.find(from);
            if (found == records.end())
                continue;
            const auto type = found->second->metadata["type"].get<std::string>();
            const bool forward = frontier.contains(from);
            const bool reverse =
                frontier.contains(to) && eligible_reverse(*found->second, pointer, kind);
            if (!forward && !reverse)
                continue;
            if (second && (type == "arc" || type == "creative-direction" ||
                           type == "narrative-position" || begins(pointer, "/arcs/") ||
                           begins(pointer, "/after/") || begins(pointer, "/participants/")))
                continue;
            // Do not expand reverse links from a general Character or Arc to all
            // matching Events. Such fan-out is especially misleading for dialogue.
            const std::string selected_id = forward ? to : from;
            const auto code = inclusion_code(type, pointer, !forward);
            const int priority = (type == "arc" || type == "creative-direction") ? 2 : 1;
            include(selected_id, priority,
                    {{"code", code}, {"sourceId", from}, {"targetId", to}, {"pointer", pointer}});
        }
    };
    expand(first, false);
    if (scope == "related") {
        std::set<std::string> second;
        for (const auto& [id, entry] : selected)
            if (!first.contains(id) && entry.record->metadata["type"] != "arc" &&
                entry.record->metadata["type"] != "creative-direction")
                second.insert(id);
        expand(second, true);
        for (const auto& [id, record] : records)
            if (record->metadata["type"] == "creative-direction" &&
                record->metadata["status"] != "superseded")
                include(id, 2, {{"code", "story-direction"}, {"sourceId", id}, {"targetId", id}});
    }
    constexpr std::size_t limit = 128;
    std::vector<std::pair<std::string, Inclusion>> items(selected.begin(), selected.end());
    std::sort(items.begin(), items.end(), [](const auto& a, const auto& b) {
        if (a.second.priority != b.second.priority)
            return a.second.priority < b.second.priority;
        return a.second.record->path < b.second.record->path;
    });
    const bool truncated = items.size() > limit;
    if (truncated)
        items.resize(limit);
    Json files = Json::array();
    for (auto& [id, item] : items) {
        const auto& record = *item.record;
        const auto& metadata = record.metadata;
        auto& reasons = item.reasons;
        std::sort(reasons.begin(), reasons.end(),
                  [](const Json& a, const Json& b) { return a.dump() < b.dump(); });
        std::string dependency = "resolved";
        if (metadata.value("completeness", "complete") == "partial") {
            dependency = "incomplete";
            flag("partial-artifact", id);
        } else if (has_unverified(metadata)) {
            dependency = "indeterminate";
            flag("unverified-condition", id);
        }
        for (const auto& ref : catalog.references)
            if (ref["source"] == id) {
                const auto to = ref["target"].get<std::string>();
                if (!records.contains(to) || ambiguous.contains(to)) {
                    dependency = "indeterminate";
                    flag("unresolved-reference", to, id, ref["pointer"]);
                }
            }
        files.push_back({{"path", record.path},
                         {"id", id},
                         {"sourceRevision", record.source_revision},
                         {"status", metadata["status"]},
                         {"completeness", metadata.value("completeness", "complete")},
                         {"dependency", dependency},
                         {"priority", item.priority == 0   ? "direct"
                                      : item.priority == 1 ? "conditional"
                                                           : "supplementary"},
                         {"inclusions", reasons}});
    }
    std::sort(unresolved.begin(), unresolved.end(),
              [](const Json& a, const Json& b) { return a.dump() < b.dump(); });
    return {
        {"contractRevision", contract["revision"]},
        {"taskKind", kind},
        {"scope", scope},
        {"position", position.empty() ? Json(nullptr) : Json(position)},
        {"files", files},
        {"unresolved", unresolved},
        {"bounded",
         {{"maxDepth", scope == "related" ? 2 : 1}, {"maxFiles", limit}, {"truncated", truncated}}},
        {"catalogDiagnostics", catalog.diagnostics},
        {"coverageStatus", coverage["search"]["truncated"] ? "unverified"
                           : catalog.diagnostics.empty()   ? "structurally-assessed"
                                                           : "indeterminate"}};
}
} // namespace noveltea::narrative
