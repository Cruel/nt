#include "tooling_native_project_sync.hpp"

#include "../project_authoring/localization_semantics.hpp"
#include "../project_authoring/room_session.hpp"
#include "../project_authoring/source_authority.hpp"

#include <algorithm>
#include <fstream>
#include <iterator>
#include <map>
#include <optional>
#include <set>
#include <string>
#include <string_view>
#include <vector>

namespace {
using Json = nlohmann::json;
using namespace noveltea::authoring;

struct Current {
    std::string key;
    NativeLocalizationTrackingSource source;
    NativeLocalizationTrackingOccurrence occurrence;
    std::string identity() const { return key + "#" + std::to_string(occurrence.ordinal); }
};

struct Previous {
    std::string key;
    Json entry;
    Json occurrence;
    bool valuable = false;
    std::string identity() const
    {
        return key + "#" + occurrence.at("messageId").get<std::string>();
    }
};

Json failure(std::string message) { return {{"ok", false}, {"error", std::move(message)}}; }

std::string bytes_at(const std::filesystem::path& path)
{
    std::ifstream input(path, std::ios::binary);
    if (!input)
        throw std::runtime_error("Cannot read tracked localization source.");
    const std::string bytes{std::istreambuf_iterator<char>(input),
                            std::istreambuf_iterator<char>()};
    if (input.bad())
        throw std::runtime_error("Cannot finish localization source read.");
    return bytes;
}

std::string escape_pointer(std::string_view value)
{
    std::string result;
    for (const auto ch : value)
        result += ch == '~' ? "~0" : ch == '/' ? "~1" : std::string(1, ch);
    return result;
}

std::string source_key(const NativeLocalizationTrackingSource& source)
{
    return source.family + ":" + source.owner_key + ":" + source.source_path;
}

Json occurrence_json(const Current& current, std::string_view message_id)
{
    const auto& occurrence = current.occurrence;
    Json value{{"messageId", message_id},
               {"ordinal", occurrence.ordinal},
               {"structuralFingerprint", occurrence.structural_fingerprint},
               {"anchorFingerprint", occurrence.anchor_fingerprint},
               {"sourceFingerprint", occurrence.source_fingerprint},
               {"sourceSnapshot", occurrence.source_snapshot}};
    if (occurrence.context_snapshot)
        value["contextSnapshot"] = *occurrence.context_snapshot;
    if (occurrence.translator_note_snapshot)
        value["translatorNoteSnapshot"] = *occurrence.translator_note_snapshot;
    return value;
}

Json entry_json(const NativeLocalizationTrackingSource& source)
{
    return {{"family", source.family},
            {"ownerKey", source.owner_key},
            {"sourcePath", source.source_path},
            {"sourceSnapshotFingerprint", source.source_snapshot_fingerprint},
            {"occurrences", Json::array()}};
}

std::vector<NativeLocalizationTrackingSource> current_sources(ProjectSession& session)
{
    const auto validated = session.validate_project();
    if (!validated.valid)
        throw std::runtime_error("Localization sync requires a valid disk Project.");
    std::vector<NativeLocalizationTrackingSource> current;
    std::set<std::string> found;
    for (const auto& [physical, analysis] : session.source_analyses()) {
        if (!physical.starts_with("inline/") || !physical.ends_with(".lua"))
            continue; // External source files are not managed Lua inline-text contracts.
        const auto relative = physical.substr(sizeof("inline/") - 1);
        const auto family_end = relative.find('/');
        const auto id_end = family_end == std::string::npos ? std::string::npos
                                                            : relative.find('/', family_end + 1);
        if (id_end == std::string::npos)
            continue;
        const auto family = relative.substr(0, family_end);
        const auto id = relative.substr(family_end + 1, id_end - family_end - 1);
        if (family.empty() || id.empty())
            continue;
        std::string source_path{"/"};
        source_path.append(relative.data(), relative.size() - 4);
        auto source = native_localization_tracking_source(
            analysis, "lua", "record:" + family + ":" + id, source_path);
        const auto key = source_key(source);
        if (found.insert(key).second)
            current.push_back(std::move(source));
    }
    for (const auto& [owner, snapshot] : session.validated_disk_record_snapshots()) {
        if (!owner.starts_with("layouts/") || !snapshot.valid || snapshot.normalized_json.empty())
            continue;
        const auto data = Json::parse(snapshot.normalized_json).at("data");
        const auto id = owner.substr(sizeof("layouts/") - 1);
        if (data.contains("lua") && data.at("lua").is_object()) {
            const auto& lua = data.at("lua");
            if (lua.value("sourceMode", std::string{}) == "inline" && lua.contains("sourceText") &&
                lua.at("sourceText").is_string()) {
                const auto path = "/layouts/" + id + "/data/lua/sourceText";
                const auto analysis = analyze_project_text("inline/" + path.substr(1) + ".lua",
                                                           lua.at("sourceText").get<std::string>());
                auto source = native_localization_tracking_source(analysis, "lua",
                                                                  "record:layouts:" + id, path);
                const auto key = source_key(source);
                if (found.insert(key).second)
                    current.push_back(std::move(source));
            }
        }
        if (!data.contains("rml") || !data.at("rml").is_object())
            continue;
        const auto& rml = data.at("rml");
        if (rml.value("sourceMode", std::string{}) != "inline" || !rml.contains("sourceText") ||
            !rml.at("sourceText").is_string())
            continue;
        const auto path = "/layouts/" + id + "/data/rml/sourceText";
        const auto analysis = analyze_project_text("inline/" + path.substr(1) + ".rml",
                                                   rml.at("sourceText").get<std::string>());
        auto source =
            native_localization_tracking_source(analysis, "rml", "record:layouts:" + id, path);
        const auto key = source_key(source);
        if (found.insert(key).second)
            current.push_back(std::move(source));
    }
    std::sort(current.begin(), current.end(),
              [](const auto& a, const auto& b) { return source_key(a) < source_key(b); });
    return current;
}

std::string uuid_from_seed(std::string_view seed)
{
    const auto raw = native_localization_tracking_fingerprint(seed).substr(6);
    const auto high = static_cast<unsigned char>(std::stoi(raw.substr(16, 2), nullptr, 16));
    const auto alphabet = "0123456789abcdef";
    const auto variant = std::string{alphabet[((high & 0x3fu) | 0x80u) >> 4],
                                     alphabet[((high & 0x3fu) | 0x80u) & 0xfu]};
    return raw.substr(0, 8) + "-" + raw.substr(8, 4) + "-5" + raw.substr(13, 3) + "-" + variant +
           raw.substr(18, 2) + "-" + raw.substr(20, 12);
}

std::string new_message_id(const Current& current)
{
    const auto& source = current.source;
    const auto& occurrence = current.occurrence;
    return uuid_from_seed("source-message|" + source.family + "|" + source.owner_key + "|" +
                          source.source_path + "|" + occurrence.structural_fingerprint + "|" +
                          occurrence.anchor_fingerprint + "|" + occurrence.source_fingerprint +
                          "|" + std::to_string(occurrence.ordinal));
}

bool relevant(const Current& current, const Previous& prior)
{
    if (current.source.family != prior.entry.at("family"))
        return false;
    return current.key == prior.key || current.source.owner_key == prior.entry.at("ownerKey") ||
           current.occurrence.structural_fingerprint ==
               prior.occurrence.at("structuralFingerprint") ||
           current.occurrence.anchor_fingerprint == prior.occurrence.at("anchorFingerprint");
}

bool match_phase(const Current& current, const Previous& prior, int phase)
{
    const bool source = current.key == prior.key;
    const bool structure =
        current.occurrence.structural_fingerprint == prior.occurrence.at("structuralFingerprint");
    const bool anchor =
        current.occurrence.anchor_fingerprint == prior.occurrence.at("anchorFingerprint");
    const bool family = current.source.family == prior.entry.at("family");
    const bool owner = current.source.owner_key == prior.entry.at("ownerKey");
    switch (phase) {
    case 0:
        return source && structure && anchor;
    case 1:
        return source && structure;
    case 2:
        return source && anchor;
    case 3:
        return source && !prior.valuable;
    case 4:
        return family && owner && structure;
    case 5:
        return family && structure;
    default:
        return false;
    }
}

struct Synchronization {
    Json tracking;
    Json materialized = Json::array();
    Json preserved = Json::array();
    Json unresolved = Json::array();
    bool changed = false;
};

Synchronization synchronize(const Json& localization,
                            const std::vector<NativeLocalizationTrackingSource>& sources)
{
    const auto& prior_tracking = localization.at("sourceMessageTracking");
    std::vector<Current> currents;
    for (const auto& source : sources)
        for (const auto& occurrence : source.occurrences)
            currents.push_back({source_key(source), source, occurrence});
    std::vector<Previous> previous;
    for (const auto& [key, entry] : prior_tracking.items())
        for (const auto& occurrence : entry.at("occurrences")) {
            const auto id = occurrence.at("messageId").get<std::string>();
            bool valuable = (occurrence.contains("contextSnapshot") &&
                             !occurrence.at("contextSnapshot").get<std::string>().empty()) ||
                            (occurrence.contains("translatorNoteSnapshot") &&
                             !occurrence.at("translatorNoteSnapshot").get<std::string>().empty());
            for (const auto& [_, translations] : localization.at("translations").items())
                valuable |= translations.contains(id);
            previous.push_back({key, entry, occurrence, valuable});
        }
    std::set<std::size_t> current_matched;
    std::set<std::size_t> prior_matched;
    std::map<std::size_t, std::size_t> matches;
    for (int phase = 0; phase < 6; ++phase) {
        bool progress = true;
        while (progress) {
            progress = false;
            for (std::size_t index = 0; index < currents.size(); ++index) {
                if (current_matched.contains(index))
                    continue;
                std::vector<std::size_t> candidates;
                for (std::size_t prior = 0; prior < previous.size(); ++prior)
                    if (!prior_matched.contains(prior) &&
                        match_phase(currents[index], previous[prior], phase))
                        candidates.push_back(prior);
                if (candidates.size() != 1)
                    continue;
                const auto candidate = candidates.front();
                std::size_t reverse = 0;
                for (std::size_t other = 0; other < currents.size(); ++other)
                    if (!current_matched.contains(other) &&
                        match_phase(currents[other], previous[candidate], phase))
                        ++reverse;
                if (reverse != 1)
                    continue;
                current_matched.insert(index);
                prior_matched.insert(candidate);
                matches[index] = candidate;
                progress = true;
            }
        }
    }
    Synchronization result;
    result.tracking = Json::object();
    for (const auto& [key, entry] : prior_tracking.items()) {
        Json retained = Json::array();
        for (std::size_t index = 0; index < previous.size(); ++index) {
            const auto& prior = previous[index];
            if (prior.key != key || prior_matched.contains(index))
                continue;
            const bool related =
                std::any_of(currents.begin(), currents.end(),
                            [&](const auto& current) { return relevant(current, prior); });
            if (prior.valuable || !related)
                retained.push_back(prior.occurrence);
        }
        if (!retained.empty()) {
            auto value = entry;
            value["occurrences"] = std::move(retained);
            result.tracking[key] = std::move(value);
        }
    }
    for (std::size_t index = 0; index < currents.size(); ++index) {
        const auto& current = currents[index];
        std::string id;
        if (const auto found = matches.find(index); found != matches.end()) {
            id = previous[found->second].occurrence.at("messageId").get<std::string>();
            result.preserved.push_back(id);
        } else {
            const bool plausible =
                std::any_of(previous.begin(), previous.end(), [&](const auto& prior) {
                    const auto pointer = &prior - previous.data();
                    return !prior_matched.contains(static_cast<std::size_t>(pointer)) &&
                           prior.valuable && relevant(current, prior);
                });
            if (plausible) {
                result.unresolved.push_back({{"family", current.source.family},
                                             {"ownerKey", current.source.owner_key},
                                             {"sourcePath", current.source.source_path},
                                             {"ordinal", current.occurrence.ordinal}});
                continue;
            }
            id = new_message_id(current);
            result.materialized.push_back(id);
        }
        auto entry = result.tracking.contains(current.key) ? result.tracking.at(current.key)
                                                           : entry_json(current.source);
        entry["family"] = current.source.family;
        entry["ownerKey"] = current.source.owner_key;
        entry["sourcePath"] = current.source.source_path;
        entry["sourceSnapshotFingerprint"] = current.source.source_snapshot_fingerprint;
        auto& entries = entry["occurrences"];
        Json next = Json::array();
        for (const auto& occurrence : entries)
            if (occurrence.at("messageId") != id)
                next.push_back(occurrence);
        next.push_back(occurrence_json(current, id));
        std::sort(next.begin(), next.end(), [](const auto& a, const auto& b) {
            return a.at("ordinal") < b.at("ordinal") ||
                   (a.at("ordinal") == b.at("ordinal") && a.at("messageId") < b.at("messageId"));
        });
        entry["occurrences"] = std::move(next);
        result.tracking[current.key] = std::move(entry);
    }
    const auto sort_by_string = [](Json& values) {
        std::sort(values.begin(), values.end(), [](const auto& a, const auto& b) { return a < b; });
    };
    sort_by_string(result.materialized);
    sort_by_string(result.preserved);
    result.changed = result.tracking != prior_tracking;
    return result;
}

} // namespace

Json native_project_localization_sync(const Json& request, ProjectSession& session,
                                      const std::filesystem::path& root)
{
    if ((request.contains("dryRun") && !request.at("dryRun").is_boolean()) ||
        (request.contains("sourceRevision") && !request.at("sourceRevision").is_string()))
        return failure("Native localization sync options are malformed.");
    const bool dry_run = request.value("dryRun", true);
    const auto sources = current_sources(session);
    const auto preparation = session.prepare_working(session.snapshot().working_revision);
    if (!preparation.accepted)
        return failure(preparation.error);
    const auto localization = Json::parse(preparation.project_json).at("localization");
    const auto synchronized = synchronize(localization, sources);
    Json result{{"ok", true},
                {"dryRun", dry_run},
                {"changed", synchronized.changed},
                {"materializedMessageIds", synchronized.materialized},
                {"preservedMessageIds", synchronized.preserved},
                {"unresolved", synchronized.unresolved},
                {"structuredMessageCount", native_localization_structured_message_count(root)},
                {"writes", Json::array()}};
    if (dry_run || !synchronized.changed)
        return result;
    const auto path = "i18n/tracking.yaml";
    const auto physical_revision = exact_source_revision(bytes_at(root / path));
    if (!request.contains("sourceRevision") || request.at("sourceRevision") != physical_revision)
        return failure(
            "Native localization sync requires an exact current tracking source revision.");
    std::vector<RoomPatch> edits;
    const auto& before = localization.at("sourceMessageTracking");
    for (const auto& [key, entry] : before.items())
        if (!synchronized.tracking.contains(key))
            edits.push_back({RoomPatch::Operation::Remove,
                             "/localization/sourceMessageTracking/" + escape_pointer(key), ""});
    for (const auto& [key, entry] : synchronized.tracking.items()) {
        const bool prior = before.contains(key);
        if (!prior || before.at(key) != entry)
            edits.push_back({prior ? RoomPatch::Operation::Replace : RoomPatch::Operation::Add,
                             "/localization/sourceMessageTracking/" + escape_pointer(key),
                             entry.dump()});
    }
    const auto patched =
        session.patch(session.snapshot().working_revision, edits, {{path, physical_revision}});
    if (!patched.accepted)
        return failure(patched.error);
    const auto saved = session.save_owners(patched.snapshot.working_revision, {path}, false,
                                           TransactionDecision::KeepComments);
    if (!saved.accepted)
        return failure(saved.error);
    if (!saved.affected_records.empty())
        result["writes"] = Json::array({path});
    return result;
}
