#include "room_session.hpp"

#include <jsoncons/json.hpp>

#include <algorithm>
#include <fstream>
#include <iterator>
#include <stdexcept>

namespace noveltea::authoring {
struct ProjectSession::CompleteProjectCache {
    struct Contributor {
        std::string normalized_json;
        std::string source_json;
    };
    std::string base_project_json;
    std::string override_json;
    bool only_test_errors = false;
    jsoncons::ojson complete;
    std::map<std::string, Contributor> contributors;
    std::size_t reused = 0;
    std::size_t projected = 0;
};

std::pair<std::size_t, std::size_t> ProjectSession::complete_project_assembly_work() const
{
    return complete_project_cache_
               ? std::make_pair(complete_project_cache_->reused, complete_project_cache_->projected)
               : std::make_pair(std::size_t{0}, std::size_t{0});
}

namespace {
using Json = jsoncons::ojson;

// Mirror the runtime Asset-reference projection used by the native CLI
// preparation. Do not admit Test/editor or localization/platform-only edges
// into Runtime Package pruning.
void collect_runtime_asset_references(const Json& value, const std::string& path,
                                      std::set<std::string>& ids)
{
    if (value.is_array()) {
        std::size_t index = 0;
        for (const auto& item : value.array_range())
            collect_runtime_asset_references(item, path + "/" + std::to_string(index++), ids);
        return;
    }
    if (!value.is_object())
        return;
    if (value.contains("$ref") && value.at("$ref").is_object()) {
        const auto& reference = value.at("$ref");
        if (reference.contains("collection") && reference.at("collection") == "assets" &&
            reference.contains("id") && reference.at("id").is_string())
            ids.insert(reference.at("id").as<std::string>());
    }
    if (value.contains("kind") && value.at("kind") == "record" && value.contains("collection") &&
        value.at("collection") == "assets" && value.contains("id") && value.at("id").is_string())
        ids.insert(value.at("id").as<std::string>());
    for (const auto& child : value.object_range()) {
        const auto& key = child.key();
        const auto child_path = path + "/" + key;
        if ((path.empty() && (key == "tests" || key == "editor")) ||
            child_path.starts_with("/tests/") || child_path.starts_with("/editor/") ||
            child_path == "/settings/app/icon" || child_path == "/settings/app/launchImage" ||
            child_path.starts_with("/localization/assets/") ||
            (child_path.starts_with("/localization/locales/") &&
             child_path.find("/fontStack") != std::string::npos))
            continue;
        collect_runtime_asset_references(child.value(), child_path, ids);
    }
}

std::string bytes_at(const std::filesystem::path& path)
{
    std::ifstream input(path, std::ios::binary);
    if (!input)
        throw std::runtime_error("Cannot read preview source: " + path.string());
    const std::string bytes{std::istreambuf_iterator<char>{input},
                            std::istreambuf_iterator<char>{}};
    if (input.bad())
        throw std::runtime_error("Cannot finish preview source: " + path.string());
    return bytes;
}

} // namespace

ProjectSession::WorkingPreparation
ProjectSession::prepare_working(std::uint64_t expected_revision, std::string_view test_id,
                                bool allow_invalid_test_semantics,
                                bool reuse_validated_snapshot) const
{
    WorkingPreparation prepared;
    prepared.working_revision = working_revision_;
    if (expected_revision != working_revision_) {
        prepared.error = "Stale working Project preparation revision.";
        return prepared;
    }
    if (source_authority_->uncertain()) {
        prepared.error = "Project source authority is uncertain.";
        return prepared;
    }
    try {
        // Do not run a second complete (and expensive) Project reconstruction
        // for every preview. The editor adapter already owns an independently
        // verified saved-workspace generation; only native dirty owners and
        // sources replace those values. No writer or CLI daemon is involved.
        const auto current = reuse_validated_snapshot && validation_snapshot_ &&
                                     localization_cache_ && localization_cache_->accepted &&
                                     validation_snapshot_->working_revision == expected_revision &&
                                     !validation_pending_uncertain_ &&
                                     validation_pending_source_revisions_.empty()
                                 ? *validation_snapshot_
                                 : snapshot();
        prepared.diagnostics = current.diagnostics;
        if (!current.valid && !allow_invalid_test_semantics) {
            prepared.error = "Active working Project has validation errors.";
            return prepared;
        }
        Json project = Json::parse(current.normalized_json);
        project.erase("schemaVersion"); // workspace-only marker, not an authored Project field
        project.insert_or_assign("schema", "noveltea.authoring.project");
        if (!localization_cache_ || !localization_cache_->accepted) {
            prepared.error = "Effective working localization is not valid.";
            return prepared;
        }
        project.insert_or_assign("localization", Json::parse(localization_cache_->effective_json));
        Json changed = Json::object();
        for (const auto& [owner, session] : deleted_records_) {
            const auto separator = owner.find('/');
            const auto family = owner.substr(0, separator);
            const auto id = owner.substr(separator + 1);
            if (!changed.contains(family))
                changed.insert_or_assign(family, Json::object());
            changed[family].insert_or_assign(id, Json::null());
            const auto relative = family == "layouts" ? "records/layouts/" + id + "/layout.yaml"
                                                      : "records/" + family + "/" + id + ".yaml";
            prepared.source_revisions.emplace(relative, session->snapshot().disk_source_revision);
        }
        for (const auto& [owner, session] : records_) {
            const auto state = session->snapshot();
            const auto separator = owner.find('/');
            const auto family = owner.substr(0, separator);
            const auto id =
                separator == std::string::npos ? std::string{} : owner.substr(separator + 1);
            bool source_dirty = false;
            if (family == "layouts") {
                const auto prefix = "records/layouts/" + id + "/layout.";
                for (const auto* channel : {"rml", "rcss", "lua"})
                    source_dirty |= text_source_overlays_.contains(prefix + channel);
            }
            if (!state.dirty && !source_dirty)
                continue;
            if (!state.valid || state.normalized_json.empty()) {
                prepared.error = "Cannot prepare invalid working record " + owner;
                return prepared;
            }
            if (owner == "editor" || owner == "traits" || owner.starts_with("i18n/"))
                continue;
            if (separator == std::string::npos)
                continue;
            auto record = Json::parse(state.normalized_json);
            // Layout normalization reads disk companions. Replace only the
            // effective sourceText in this preparation, never in Layout YAML.
            if (family == "layouts") {
                for (const auto* channel : {"rml", "rcss", "lua"}) {
                    const auto path = "records/layouts/" + id + "/layout." + channel;
                    if (const auto found = text_source_overlays_.find(path);
                        found != text_source_overlays_.end()) {
                        auto& selector = record["data"][channel];
                        if (selector.at("sourceMode") == "inline")
                            selector.insert_or_assign("sourceText", found->second);
                    }
                }
            }
            if (!changed.contains(family))
                changed.insert_or_assign(family, Json::object());
            changed[family].insert_or_assign(id, std::move(record));
            const auto relative = family == "layouts" ? "records/layouts/" + id + "/layout.yaml"
                                                      : "records/" + family + "/" + id + ".yaml";
            prepared.source_revisions.emplace(relative, state.disk_source_revision);
        }
        // An opened but untouched Layout may have a dirty file-mode companion.
        // Resolve only that Layout rather than traversing unrelated records.
        for (const auto& [path, _] : text_source_overlays_) {
            if (!path.starts_with("records/layouts/"))
                continue;
            const auto rest = path.substr(sizeof("records/layouts/") - 1);
            const auto split = rest.find('/');
            if (split == std::string::npos)
                continue;
            const auto id = rest.substr(0, split);
            if (changed.contains("layouts") && changed.at("layouts").contains(id))
                continue;
            std::string error;
            auto session = RoomSession::open_record(root_, "layouts", id, error);
            if (!session)
                throw std::runtime_error("Cannot prepare dirty Layout companion: " + error);
            const auto state = session->snapshot();
            if (!state.valid) {
                prepared.error = "Cannot prepare Layout " + id;
                return prepared;
            }
            auto record = Json::parse(state.normalized_json);
            for (const auto* channel : {"rml", "rcss", "lua"}) {
                const auto source_path = "records/layouts/" + id + "/layout." + channel;
                if (const auto found = text_source_overlays_.find(source_path);
                    found != text_source_overlays_.end() &&
                    record["data"][channel].at("sourceMode") == "inline")
                    record["data"][channel].insert_or_assign("sourceText", found->second);
            }
            if (!changed.contains("layouts"))
                changed.insert_or_assign("layouts", Json::object());
            changed["layouts"].insert_or_assign(id, std::move(record));
            prepared.source_revisions.emplace("records/layouts/" + id + "/layout.yaml",
                                              state.disk_source_revision);
        }
        if (records_.contains("traits") && records_.at("traits")->snapshot().dirty) {
            project.insert_or_assign(
                "traits", Json::parse(records_.at("traits")->snapshot().normalized_json));
            prepared.source_revisions.emplace(
                "traits.yaml", records_.at("traits")->snapshot().disk_source_revision);
        }
        if (records_.contains("editor") && records_.at("editor")->snapshot().dirty) {
            project.insert_or_assign(
                "editor", Json::parse(records_.at("editor")->snapshot().normalized_json));
            prepared.source_revisions.emplace(
                "editor.yaml", records_.at("editor")->snapshot().disk_source_revision);
        }
        if (!test_id.empty() && (test_id.front() < 'a' || test_id.front() > 'z' ||
                                 !std::all_of(test_id.begin(), test_id.end(), [](const char c) {
                                     return (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
                                            c == '-';
                                 }))) {
            prepared.error = "Invalid authored Test ID.";
            return prepared;
        }
        if (!test_id.empty() &&
            !(records_.contains("tests/" + std::string(test_id)) ||
              std::filesystem::is_regular_file(root_ / "records" / "tests" /
                                               (std::string(test_id) + ".yaml")))) {
            prepared.error = "Requested authored Test does not exist in the working Project.";
            return prepared;
        }
        for (const auto& [path, baseline] : text_disk_revisions_) {
            const auto actual = exact_source_revision(bytes_at(root_ / path));
            if (actual != baseline) {
                prepared.error = "External source revision changed during preparation: " + path;
                return prepared;
            }
            prepared.source_revisions.emplace(path, baseline);
        }
        // Saved shader sources (including shared .sh includes) are runtime
        // compiler inputs even when there is no dirty Material or shader
        // overlay. Hash their current physical bytes on every preparation so
        // an external shader edit cannot reuse a stale compiled artifact.
        const auto shader_root = root_ / "shaders";
        if (std::filesystem::is_directory(shader_root)) {
            for (const auto& file : std::filesystem::recursive_directory_iterator(shader_root)) {
                if (!file.is_regular_file())
                    continue;
                const auto path = file.path().lexically_relative(root_).generic_string();
                prepared.source_revisions.insert_or_assign(
                    path, exact_source_revision(bytes_at(file.path())));
            }
        }
        prepared.source_revisions.emplace("project.yaml", source_->snapshot().disk_source_revision);
        prepared.text_overlays = text_source_overlays_;
        prepared.shader_overlays = shader_overlays_;
        prepared.project_json = project.to_string();
        prepared.record_overrides_json = changed.to_string();
        prepared.accepted = true;
    } catch (const std::exception& error) {
        prepared.error = error.what();
    }
    return prepared;
}

ProjectSession::WorkingPreparation
ProjectSession::prepare_complete_working(std::uint64_t expected_revision, std::string_view test_id,
                                         bool reuse_clean_validation)
{
    WorkingPreparation prepared;
    prepared.working_revision = working_revision_;
    if (expected_revision != working_revision_) {
        prepared.error = "Stale working Project preparation revision.";
        return prepared;
    }
    // Full validation supplies native normalized disk contributors for every
    // tracked record. It does not make uninspected owners editable or writable.
    RoomSessionSnapshot validated;
    if (reuse_clean_validation && test_id.empty() && validation_snapshot_ &&
        validation_snapshot_->working_revision == expected_revision &&
        validation_snapshot_->valid && !validation_pending_uncertain_ &&
        validation_pending_source_revisions_.empty()) {
        // A fresh post-assembly observation below rejects intervening edits.
        // Do not rescan before assembling the same validated contributor set.
        validated = *validation_snapshot_;
    } else {
        validated = validate_project();
    }
    if (expected_revision != working_revision_) {
        prepared.working_revision = working_revision_;
        prepared.error = "Project source generation advanced during complete preparation.";
        return prepared;
    }
    // Authored Test readiness is separate from runtime Project admission. A
    // structurally normalized Test with semantic errors remains a blocked
    // catalog entry; it must not prevent another Test or a stdin spec from
    // compiling the gameplay generation. Non-Test errors still block admission.
    const bool only_test_errors =
        !validated.valid &&
        std::any_of(validated.diagnostics.begin(), validated.diagnostics.end(),
                    [](const auto& d) { return d.severity == "error"; }) &&
        std::all_of(validated.diagnostics.begin(), validated.diagnostics.end(), [](const auto& d) {
            return d.severity != "error" || d.path.starts_with("/tests/");
        });
    if (!validated.valid && !only_test_errors) {
        prepared.diagnostics = validated.diagnostics;
        prepared.error = "Full native working Project validation failed.";
        return prepared;
    }
    prepared = prepare_working(expected_revision, test_id, only_test_errors,
                               reuse_clean_validation && test_id.empty());
    if (!prepared.accepted)
        return prepared;
    try {
        const bool reuse_assembly =
            complete_project_cache_ &&
            complete_project_cache_->base_project_json == prepared.project_json &&
            complete_project_cache_->override_json == prepared.record_overrides_json &&
            complete_project_cache_->only_test_errors == only_test_errors;
        auto cache =
            reuse_assembly ? complete_project_cache_ : std::make_shared<CompleteProjectCache>();
        cache->reused = 0;
        cache->projected = 0;
        if (!reuse_assembly || cache->projected != 0) {
            cache->base_project_json = prepared.project_json;
            cache->override_json = prepared.record_overrides_json;
            cache->only_test_errors = only_test_errors;
            cache->complete = Json::parse(prepared.project_json);
        }
        Json& complete = cache->complete;
        // The workspace manifest deliberately does not persist prefetch hints yet. The complete
        // runtime Project nevertheless has the canonical empty registry (as in the generated
        // AuthoringProject contract), so downstream validation never needs to default it again.
        if (!complete.contains("prefetchHints"))
            complete.insert_or_assign("prefetchHints", Json::object());
        const auto contributors = only_test_errors ? reconciliation_disk_record_snapshots()
                                                   : validated_disk_record_snapshots();
        // The validated collection is the complete owner inventory. Remove
        // stale contributors on a structural deletion/replacement, even when
        // their record bytes were identical before the removal.
        for (auto it = cache->contributors.begin(); it != cache->contributors.end();) {
            if (contributors.contains(it->first)) {
                ++it;
                continue;
            }
            const auto separator = it->first.find('/');
            if (separator != std::string::npos && !it->first.starts_with("i18n/")) {
                const auto family = it->first.substr(0, separator);
                if (complete.contains(family))
                    complete[family].erase(it->first.substr(separator + 1));
            }
            it = cache->contributors.erase(it);
        }
        for (const auto& [owner, record] : contributors) {
            if ((!record.valid && !(only_test_errors && owner.starts_with("tests/"))) ||
                record.normalized_json.empty())
                throw std::runtime_error("Invalid native full-Project contributor: " + owner);
            const auto retained = cache->contributors.find(owner);
            if (retained != cache->contributors.end() &&
                retained->second.normalized_json == record.normalized_json &&
                retained->second.source_json == record.source_json) {
                ++cache->reused;
                continue;
            }
            ++cache->projected;
            if (owner == "traits" || owner == "editor") {
                complete.insert_or_assign(owner, Json::parse(record.normalized_json));
            } else if (!owner.starts_with("i18n/")) {
                const auto separator = owner.find('/');
                if (separator == std::string::npos)
                    throw std::runtime_error("Unexpected native full-Project owner: " + owner);
                const auto family = owner.substr(0, separator);
                const auto id = owner.substr(separator + 1);
                if (!complete.contains(family))
                    complete.insert_or_assign(family, Json::object());
                auto effective = Json::parse(record.normalized_json);
                // The optional Layout template dependency is not defaulted
                // when an explicit dependency object omits that field. The
                // native source projection currently fills an empty array;
                // keep the saved workspace's exact Zod output shape here.
                if (family == "layouts") {
                    const auto source = Json::parse(record.source_json);
                    if (source.contains("data") && source.at("data").contains("dependencies") &&
                        !source.at("data").at("dependencies").contains("templates") &&
                        effective.at("data").at("dependencies").contains("templates") &&
                        effective.at("data").at("dependencies").at("templates") == Json::array())
                        effective["data"]["dependencies"].erase("templates");
                }
                complete[family].insert_or_assign(id, std::move(effective));
            }
            cache->contributors.insert_or_assign(
                owner,
                CompleteProjectCache::Contributor{record.normalized_json, record.source_json});
        }
        // Overlay only validated native dirty values (including Layout companion
        // source text). They have precedence over saved validation contributors.
        if (!reuse_assembly) {
            const auto overrides = Json::parse(prepared.record_overrides_json);
            for (const auto& family : overrides.object_range()) {
                if (!complete.contains(family.key()))
                    complete.insert_or_assign(family.key(), Json::object());
                for (const auto& record : family.value().object_range())
                    if (record.value().is_null())
                        complete[family.key()].erase(record.key());
                    else
                        complete[family.key()].insert_or_assign(record.key(), record.value());
            }
        }
        for (const auto& [owner, record] : contributors) {
            std::string relative;
            if (owner == "editor")
                relative = "editor.yaml";
            else if (owner == "traits")
                relative = "traits.yaml";
            else if (owner.starts_with("i18n/"))
                relative = owner;
            else {
                const auto separator = owner.find('/');
                const auto family = owner.substr(0, separator);
                const auto id = owner.substr(separator + 1);
                relative = family == "layouts" ? "records/layouts/" + id + "/layout.yaml"
                                               : "records/" + family + "/" + id + ".yaml";
            }
            prepared.source_revisions.insert_or_assign(relative, record.disk_source_revision);
        }
        // No later external modification may turn validation's record evidence
        // into a stale, apparently complete working Project.
        const auto observed = observe_sources();
        if (observed.full_rescan || (!observed.authoritative && !observed.scoped_authority) ||
            !observed.delta.changed.empty() || !observed.delta.added.empty() ||
            !observed.delta.removed.empty())
            throw std::runtime_error(
                "Project source revision changed during complete preparation.");
        const auto physical = source_authority_->verified_revisions();
        if (!physical)
            throw std::runtime_error("Cannot prove the complete native Project source manifest.");
        // Include referenced binary Assets and other exact source dependencies,
        // allowing runtime consumers to verify without a TypeScript baseline.
        for (const auto& [relative, revision] : *physical)
            prepared.source_revisions.insert_or_assign(relative, revision);
        std::set<std::string> runtime_assets;
        collect_runtime_asset_references(complete, "", runtime_assets);
        prepared.referenced_asset_ids = std::move(runtime_assets);
        prepared.complete_project_json = complete.to_string();
        complete_project_cache_ = std::move(cache);
    } catch (const std::exception& error) {
        complete_project_cache_.reset();
        prepared.accepted = false;
        prepared.error = error.what();
    }
    return prepared;
}
} // namespace noveltea::authoring
