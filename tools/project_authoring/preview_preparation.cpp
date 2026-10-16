#include "room_session.hpp"

#include <jsoncons/json.hpp>

#include <algorithm>
#include <fstream>
#include <iterator>
#include <stdexcept>

namespace noveltea::authoring {
namespace {
using Json = jsoncons::ojson;

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

ProjectSession::WorkingPreparation ProjectSession::prepare_working(std::uint64_t expected_revision,
                                                                   std::string_view test_id) const
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
        const auto current = snapshot();
        prepared.diagnostics = current.diagnostics;
        if (!current.valid) {
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
} // namespace noveltea::authoring
