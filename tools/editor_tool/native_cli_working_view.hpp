#pragma once

#include "../project_authoring/source_authority.hpp"
#include "../project_authoring/yaml_codec.hpp"

#include <noveltea/core/player_bootstrap.hpp>
#include <nlohmann/json.hpp>

#include <filesystem>
#include <fstream>
#include <map>
#include <optional>
#include <random>
#include <regex>
#include <set>
#include <span>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>

namespace noveltea::cli {
namespace fs = std::filesystem;

struct WorkingViewError : std::runtime_error {
    std::string code;
    std::string owner;
    int exit_code;
    WorkingViewError(std::string category, std::string source, std::string reason, int exit = 4)
        : std::runtime_error(std::move(reason)), code(std::move(category)),
          owner(std::move(source)), exit_code(exit)
    {
    }
};

// The CLI never adopts working files as native checkpoint state. Instead it creates a
// disposable, private physical view so the *same* native admission, semantic and
// source-location pipeline sees the selected exact YAML/text bytes. The original
// Project (including its cache and native checkpoint) is never opened for writing.
struct WorkingValidationView {
    fs::path original_root;
    fs::path view_root;
    std::set<std::string> overlays;
    std::set<std::string> deletions;
    // Hashes cover the entire physical view and every ledger artifact. An
    // intervening writer must not be mistaken for a validated generation.
    std::map<std::string, std::optional<std::string>> proofs;

    WorkingValidationView() = default;
    WorkingValidationView(const WorkingValidationView&) = delete;
    WorkingValidationView& operator=(const WorkingValidationView&) = delete;
    WorkingValidationView(WorkingValidationView&& other) noexcept
        : original_root(std::move(other.original_root)),
          view_root(std::exchange(other.view_root, {})), overlays(std::move(other.overlays)),
          deletions(std::move(other.deletions)), proofs(std::move(other.proofs))
    {
    }
    ~WorkingValidationView()
    {
        if (!view_root.empty()) {
            std::error_code ignored;
            fs::remove_all(view_root, ignored);
        }
    }

    static std::string sha(std::string_view bytes)
    {
        return "sha256:" + core::sha256_hex(std::as_bytes(std::span(bytes.data(), bytes.size())));
    }

    static std::string utf8_path(const fs::path& path)
    {
        const auto bytes = path.u8string();
        return {bytes.begin(), bytes.end()};
    }

    static bool owner_path(const std::string& value)
    {
        if (value.empty() || value.front() == '/' || value.find('\\') != std::string::npos ||
            value.find('\0') != std::string::npos)
            return false;
        const auto path = fs::path(value);
        for (const auto& part : path)
            if (part == "." || part == ".." || part.empty())
                return false;
        if (value == "project.yaml" || value == "editor.yaml" || value == "traits.yaml")
            return true;
        static const std::regex record(
            R"(^records/(animations|archetypes|assets|characters|dialogues|interactables|interactions|maps|materials|rooms|scenes|scripts|tests|variables|verbs)/[^/]+\.yaml$)");
        static const std::regex layout(R"(^records/layouts/[^/]+/layout\.(yaml|rml|rcss|lua)$)");
        static const std::regex locale(R"(^i18n/(locales|assets)/[^/]+\.yaml$)");
        static const std::regex script(R"(^scripts/.+\.lua$)");
        static const std::regex shader(R"(^shaders/.+[^/]$)");
        return std::regex_match(value, record) || std::regex_match(value, layout) ||
               std::regex_match(value, locale) || std::regex_match(value, script) ||
               std::regex_match(value, shader) || value == "i18n/project.yaml" ||
               value == "i18n/messages.yaml" || value == "i18n/usage-notes.yaml" ||
               value == "i18n/tracking.yaml" || value == "i18n/orphans.yaml";
    }

    // Every component is lstat'd; following a working-tree symlink would give
    // an external file authority it never had in the publication ledger.
    static std::optional<std::string> read_safe(const fs::path& root, const std::string& relative,
                                                std::size_t limit = 4 * 1024 * 1024)
    {
        fs::path current = root;
        const auto pieces = fs::path(relative);
        for (const auto& part : pieces) {
            if (part == ".." || part == "." || part.empty() || part.is_absolute())
                throw WorkingViewError("WORKING_SOURCE_UNSAFE", relative,
                                       "Working source contains an unsafe path.");
            current /= part;
            std::error_code error;
            const auto status = fs::symlink_status(current, error);
            if (error == std::errc::no_such_file_or_directory ||
                status.type() == fs::file_type::not_found)
                return std::nullopt;
            if (error || fs::is_symlink(status))
                throw WorkingViewError("WORKING_SOURCE_UNSAFE", relative,
                                       "Working source has a symlink or unreadable path.");
        }
        if (!fs::is_regular_file(current))
            throw WorkingViewError("WORKING_SOURCE_UNSAFE", relative,
                                   "Working source is not a regular file.");
        const auto size = fs::file_size(current);
        if (size > limit)
            throw WorkingViewError("WORKING_SOURCE_UNSAFE", relative,
                                   "Working source exceeds the read limit.");
        std::ifstream file(current, std::ios::binary);
        if (!file)
            throw WorkingViewError("WORKING_SOURCE_UNSAFE", relative,
                                   "Working source cannot be read.");
        std::string bytes(size, '\0');
        if (!file.read(bytes.data(), static_cast<std::streamsize>(bytes.size())) ||
            fs::file_size(current) != size)
            throw WorkingViewError("WORKING_SOURCE_CHANGED", relative,
                                   "Working source changed while it was being read.", 5);
        return bytes;
    }

    static std::string required_string(const nlohmann::json& value, const char* key,
                                       const std::string& owner)
    {
        if (!value.is_object() || !value.contains(key) || !value.at(key).is_string())
            throw WorkingViewError("WORKING_SOURCE_INVALID", owner,
                                   std::string("Working manifest has invalid ") + key + ".");
        return value.at(key).get<std::string>();
    }

    static bool digest(const std::string& text)
    {
        static const std::regex pattern(R"(^sha256:[a-f0-9]{64}$)");
        return std::regex_match(text, pattern);
    }

    static nlohmann::json checkpoint_body(std::string_view bytes, const fs::path& root,
                                          std::string_view project_id)
    {
        try {
            const auto saved = nlohmann::json::parse(bytes);
            if (!saved.is_object() || saved.size() != 4 || saved.value("version", 0) != 1 ||
                saved.value("projectRoot", std::string{}) != utf8_path(root) ||
                saved.value("projectId", std::string{}) != project_id ||
                !saved.contains("checkpoint") || !saved["checkpoint"].is_object())
                throw std::runtime_error("checkpoint identity");
            const auto& data = saved["checkpoint"];
            if (!data.contains("batches") || !data["batches"].is_array() ||
                !data.contains("textSources") || !data["textSources"].is_object() ||
                !data.contains("pendingFields") || !data["pendingFields"].is_object() ||
                !data.contains("conflicts") || !data["conflicts"].is_object() ||
                (data.contains("ownerEvidence") && !data["ownerEvidence"].is_object()))
                throw std::runtime_error("checkpoint shape");
            return data;
        } catch (...) {
            throw WorkingViewError("WORKING_SOURCE_UNTRUSTED", "manifest.json",
                                   "Native recovery checkpoint is incompatible or corrupt.");
        }
    }

    static bool checkpoint_dirty(const nlohmann::json& data)
    {
        return !data.at("batches").empty() || !data.at("textSources").empty() ||
               !data.at("pendingFields").empty() || !data.at("conflicts").empty() ||
               (data.contains("ownerEvidence") && !data["ownerEvidence"].empty());
    }

    static std::string native_owner(const std::string& path)
    {
        if (path == "project.yaml")
            return "project";
        if (path == "editor.yaml")
            return "editor";
        if (path == "traits.yaml")
            return "traits";
        static const std::regex record(R"(^records/([^/]+)/([^/]+)\.yaml$)");
        static const std::regex layout(R"(^records/layouts/([^/]+)/layout\.yaml$)");
        std::smatch match;
        if (std::regex_match(path, match, layout))
            return "layouts/" + match[1].str();
        if (std::regex_match(path, match, record))
            return match[1].str() + "/" + match[2].str();
        return path;
    }

    static std::string physical_owner(const std::string& owner)
    {
        if (owner == "project" || owner == "editor" || owner == "traits")
            return owner + ".yaml";
        if (owner.starts_with("i18n/") || owner.starts_with("scripts/") ||
            owner.starts_with("shaders/") || owner.starts_with("records/"))
            return owner;
        const auto split = owner.find('/');
        if (split == std::string::npos)
            return {};
        if (owner.starts_with("layouts/"))
            return "records/" + owner + "/layout.yaml";
        return "records/" + owner + ".yaml";
    }

    static void verify_checkpoint_coverage(const nlohmann::json& checkpoint,
                                           const nlohmann::json& entries)
    {
        if (!checkpoint["pendingFields"].empty())
            throw WorkingViewError(
                "WORKING_SOURCE_PENDING", "manifest.json",
                "Native recovery has pending editor input that cannot be certified.");
        if (!checkpoint["conflicts"].empty())
            throw WorkingViewError("WORKING_SOURCE_UNTRUSTED", "manifest.json",
                                   "Native recovery has unresolved conflicts.");
        const auto require_covered = [&](const std::string& owner) {
            const auto path = physical_owner(owner);
            if (path.empty() || !entries.contains(path))
                throw WorkingViewError(
                    "WORKING_SOURCE_UNTRUSTED", "manifest.json",
                    "Native checkpoint has dirty owner missing from working publication: " + owner);
        };
        for (auto it = checkpoint["textSources"].begin(); it != checkpoint["textSources"].end();
             ++it)
            require_covered(it.key());
        if (checkpoint.contains("ownerEvidence"))
            for (auto it = checkpoint["ownerEvidence"].begin();
                 it != checkpoint["ownerEvidence"].end(); ++it)
                require_covered(it.key());
        for (const auto& batch : checkpoint["batches"]) {
            if (!batch.is_object() || !batch.contains("diskPreconditions") ||
                !batch["diskPreconditions"].is_object())
                throw WorkingViewError("WORKING_SOURCE_UNTRUSTED", "manifest.json",
                                       "Native checkpoint has an invalid retained batch.");
            for (auto it = batch["diskPreconditions"].begin();
                 it != batch["diskPreconditions"].end(); ++it)
                require_covered(it.key());
        }
    }

    static bool checkpoint_has_owner(const nlohmann::json& checkpoint, const std::string& owner,
                                     const std::string& representation,
                                     const std::string& disk_revision)
    {
        if (representation == "pending-only") {
            return !checkpoint.at("pendingFields").empty();
        }
        const auto native = native_owner(owner);
        if (checkpoint.at("textSources").contains(native)) {
            const auto& entry = checkpoint["textSources"][native];
            if (entry.is_object() && entry.value("diskRevision", std::string{}) == disk_revision)
                return true;
        }
        if (checkpoint.contains("ownerEvidence") && checkpoint["ownerEvidence"].contains(native)) {
            const auto& entry = checkpoint["ownerEvidence"][native];
            if (entry.is_object() && entry.value("diskRevision", std::string{}) == disk_revision)
                return true;
        }
        const auto prefix = native == "project" ? "/" : "/" + native + "/";
        for (const auto& batch : checkpoint.at("batches")) {
            if (!batch.is_object() || !batch.contains("patches") || !batch["patches"].is_array() ||
                !batch.contains("diskPreconditions") || !batch["diskPreconditions"].is_object())
                continue;
            if (!batch["diskPreconditions"].contains(native) ||
                batch["diskPreconditions"][native] != disk_revision)
                continue;
            for (const auto& patch : batch["patches"]) {
                if (!patch.is_object() || !patch.contains("path") || !patch["path"].is_string())
                    continue;
                const auto path = patch["path"].get<std::string>();
                if (native == "project" ? path.starts_with("/")
                                        : path == "/" + native || path.starts_with(prefix))
                    return true;
            }
        }
        return false;
    }

    static std::optional<WorkingValidationView> prepare(const fs::path& selected)
    {
        const fs::path root = fs::canonical(selected);
        constexpr auto ledger = ".noveltea/editor/working/manifest.json";
        const auto raw = read_safe(root, ledger);
        if (!raw) {
            // A checkpoint can be durable before its working projection is
            // published. Disk-only validation must not certify that as clean.
            const auto checkpoint =
                read_safe(root, ".noveltea/editor/native-dirty-state.json", 24 * 1024 * 1024);
            if (checkpoint) {
                const auto saved = nlohmann::json::parse(*checkpoint, nullptr, false);
                if (!saved.is_object() || !saved.contains("checkpoint") ||
                    !saved["checkpoint"].is_object())
                    throw WorkingViewError(
                        "WORKING_SOURCE_UNTRUSTED", "manifest.json",
                        "Working manifest is absent with unreadable recovery state.");
                const auto data = checkpoint_body(*checkpoint, root, saved.value("projectId", ""));
                if (checkpoint_dirty(data))
                    throw WorkingViewError(
                        "WORKING_SOURCE_UNTRUSTED", "manifest.json",
                        "Dirty native checkpoint has no published working manifest.");
            }
            // An orphan publication is not a clean Project: its last manifest
            // might have been lost in the middle of an agent/editor race.
            for (const char* dir : {"files", "deletions", "pending"}) {
                const auto artifact = root / ".noveltea/editor/working" / dir;
                std::error_code error;
                if (fs::exists(artifact, error) &&
                    (fs::is_symlink(fs::symlink_status(artifact)) ||
                     (fs::is_directory(artifact) &&
                      fs::directory_iterator(artifact) != fs::directory_iterator{})))
                    throw WorkingViewError("WORKING_SOURCE_UNTRUSTED", "manifest.json",
                                           "Working artifacts exist without their manifest.");
            }
            return std::nullopt;
        }
        nlohmann::json manifest;
        try {
            manifest = nlohmann::json::parse(*raw);
        } catch (...) {
            throw WorkingViewError("WORKING_SOURCE_INVALID", "manifest.json",
                                   "Working-source manifest is malformed JSON.");
        }
        if (!manifest.is_object() || manifest.size() != 5 ||
            required_string(manifest, "schema", "manifest.json") !=
                "noveltea.editor.working-sources" ||
            required_string(manifest, "projectRoot", "manifest.json") != utf8_path(root) ||
            !manifest.contains("publication") || !manifest["publication"].is_number_unsigned() ||
            !manifest.contains("entries") || !manifest["entries"].is_object())
            throw WorkingViewError("WORKING_SOURCE_UNTRUSTED", "manifest.json",
                                   "Working-source publication identity or shape is incompatible.");
        const auto project_id = required_string(manifest, "projectId", "manifest.json");
        if (project_id.empty())
            throw WorkingViewError("WORKING_SOURCE_UNTRUSTED", "manifest.json",
                                   "Working-source Project ID is empty.");

        const auto project_yaml = read_safe(root, "project.yaml");
        if (!project_yaml)
            throw WorkingViewError(
                "WORKING_SOURCE_UNTRUSTED", "manifest.json",
                "Saved Project manifest is absent; identity cannot be verified.");
        const auto decoded = authoring::open_yaml_source(*project_yaml);
        if (!decoded.accepted)
            throw WorkingViewError("WORKING_SOURCE_UNTRUSTED", "manifest.json",
                                   "Saved Project identity cannot be decoded safely.");
        try {
            const auto parsed = nlohmann::json::parse(decoded.source_json);
            if (parsed.at("project").at("id") != project_id)
                throw WorkingViewError("WORKING_SOURCE_UNTRUSTED", "manifest.json",
                                       "Working files belong to a different Project ID.");
        } catch (const WorkingViewError&) {
            throw;
        } catch (...) {
            throw WorkingViewError("WORKING_SOURCE_UNTRUSTED", "manifest.json",
                                   "Saved Project has no verifiable Project ID.");
        }
        const auto checkpoint =
            read_safe(root, ".noveltea/editor/native-dirty-state.json", 24 * 1024 * 1024);
        if (!checkpoint && !manifest["entries"].empty())
            throw WorkingViewError("WORKING_SOURCE_UNTRUSTED", "manifest.json",
                                   "Working files have no native recovery checkpoint.");
        const auto evidence =
            checkpoint ? checkpoint_body(*checkpoint, root, project_id) : nlohmann::json::object();
        if (!manifest["entries"].empty() && !checkpoint_dirty(evidence))
            throw WorkingViewError("WORKING_SOURCE_UNTRUSTED", "manifest.json",
                                   "Working manifest has no corresponding native dirty evidence.");
        if (checkpoint)
            verify_checkpoint_coverage(evidence, manifest["entries"]);
        WorkingValidationView view;
        view.original_root = root;
        view.proofs.emplace(ledger, sha(*raw));
        view.proofs.emplace("project.yaml", sha(*project_yaml));
        view.proofs.emplace(".noveltea/editor/native-dirty-state.json",
                            checkpoint ? std::optional(sha(*checkpoint)) : std::nullopt);
        std::map<std::string, std::optional<std::string>> replacements;
        std::set<std::string> expected_artifacts;
        for (auto it = manifest["entries"].begin(); it != manifest["entries"].end(); ++it) {
            const auto owner = it.key();
            if (!owner_path(owner))
                throw WorkingViewError("WORKING_SOURCE_INVALID", owner,
                                       "Working manifest contains an unsupported source owner.");
            const auto& entry = it.value();
            if (!entry.is_object() || entry.size() != 6)
                throw WorkingViewError("WORKING_SOURCE_INVALID", owner,
                                       "Working manifest has an incompatible owner entry.");
            const auto representation = required_string(entry, "representation", owner);
            const auto disk = required_string(entry, "diskRevision", owner);
            if (!checkpoint_has_owner(evidence, owner, representation, disk))
                throw WorkingViewError("WORKING_SOURCE_UNTRUSTED", owner,
                                       "Native checkpoint has no matching working owner revision.");
            const auto checkpoint_revision = required_string(entry, "checkpointRevision", owner);
            if (!digest(checkpoint_revision) ||
                (disk != "absent" &&
                 !std::regex_match(disk, std::regex(R"(^xxh3-128:[a-f0-9]{32}$)"))) ||
                !entry.contains("localStateRevision") ||
                (!entry["localStateRevision"].is_null() &&
                 (!entry["localStateRevision"].is_string() ||
                  !digest(entry["localStateRevision"].get<std::string>()))))
                throw WorkingViewError("WORKING_SOURCE_INVALID", owner,
                                       "Working source has incompatible revision evidence.");
            if (!entry["localStateRevision"].is_null())
                throw WorkingViewError("WORKING_SOURCE_UNTRUSTED", owner,
                                       "Renderer-local draft evidence is unavailable offline.");
            const auto saved = read_safe(root, owner);
            view.proofs[owner] = saved ? std::optional(sha(*saved)) : std::nullopt;
            if ((saved ? authoring::exact_source_revision(*saved) : "absent") != disk)
                throw WorkingViewError("WORKING_SOURCE_STALE", owner,
                                       "Saved source changed since working-file publication.", 5);
            const auto base = ".noveltea/editor/working/";
            const auto file = std::string(base) + "files/" + owner;
            const auto removal = std::string(base) + "deletions/" + owner + ".delete.json";
            const auto pending = std::string(base) + "pending/" + owner + ".json";
            if (!entry.contains("publishedRevision") ||
                (!entry["publishedRevision"].is_null() &&
                 !entry["publishedRevision"].is_string()) ||
                !entry.contains("pendingRevision") ||
                (!entry["pendingRevision"].is_null() && !entry["pendingRevision"].is_string()))
                throw WorkingViewError("WORKING_SOURCE_INVALID", owner,
                                       "Working source revision fields must be hashes or null.");
            const auto published =
                entry.contains("publishedRevision") && entry["publishedRevision"].is_string()
                    ? entry["publishedRevision"].get<std::string>()
                    : "";
            const auto pending_revision =
                entry.contains("pendingRevision") && entry["pendingRevision"].is_string()
                    ? entry["pendingRevision"].get<std::string>()
                    : "";
            if ((!published.empty() && !digest(published)) ||
                (!pending_revision.empty() && !digest(pending_revision)) ||
                (representation == "pending-only" ? !published.empty() || pending_revision.empty()
                                                  : published.empty()) ||
                (representation != "file" && representation != "deleted" &&
                 representation != "pending-only"))
                throw WorkingViewError("WORKING_SOURCE_INVALID", owner,
                                       "Working source has invalid representation revisions.");
            const auto artifact = representation == "deleted" ? removal : file;
            const auto other = representation == "deleted" ? file : removal;
            if (read_safe(root, other))
                throw WorkingViewError("WORKING_SOURCE_UNTRUSTED", owner,
                                       "Both source and deletion marker exist.");
            if (representation == "pending-only" || !pending_revision.empty())
                throw WorkingViewError(
                    "WORKING_SOURCE_PENDING", owner,
                    "Pending editor field text cannot be certified as valid YAML.");
            expected_artifacts.insert(artifact);
            const auto bytes = read_safe(root, artifact);
            if (!bytes)
                throw WorkingViewError("WORKING_SOURCE_UNTRUSTED", owner,
                                       "Manifested working source is missing.");
            view.proofs[artifact] = sha(*bytes);
            const auto baseline = std::string(base) + "baselines/" + published.substr(7) + ".blob";
            const auto evidence = read_safe(root, baseline);
            if (!evidence || sha(*evidence) != published)
                throw WorkingViewError("WORKING_SOURCE_UNTRUSTED", owner,
                                       "Immutable working-source baseline is missing or damaged.");
            view.proofs[baseline] = sha(*evidence);
            if (representation == "deleted") {
                if (*bytes != "{\"deleted\":true}\n")
                    throw WorkingViewError(
                        "WORKING_SOURCE_INVALID", owner,
                        "Deletion marker must be exact canonical tombstone text.");
                view.deletions.insert(owner);
                replacements[owner] = std::nullopt;
            } else {
                view.overlays.insert(owner);
                replacements[owner] = *bytes;
            }
        }
        // Extra agent-created files and interrupted publications must not be
        // silently ignored because the manifest does not name them.
        for (const char* family : {"files", "deletions", "pending"}) {
            const auto directory = root / ".noveltea/editor/working" / family;
            std::error_code error;
            const auto status = fs::symlink_status(directory, error);
            if (error == std::errc::no_such_file_or_directory ||
                status.type() == fs::file_type::not_found)
                continue;
            if (error || !fs::is_directory(status) || fs::is_symlink(status))
                throw WorkingViewError("WORKING_SOURCE_UNSAFE", family,
                                       "Working artifact directory is unsafe.");
            for (fs::recursive_directory_iterator iter(directory), end; iter != end; ++iter) {
                const auto relative = iter->path().lexically_relative(root).generic_string();
                const auto current = iter->symlink_status();
                if (fs::is_symlink(current) ||
                    (!fs::is_regular_file(current) && !fs::is_directory(current)))
                    throw WorkingViewError("WORKING_SOURCE_UNSAFE", relative,
                                           "Working artifact is not a safe regular file.");
                if (fs::is_regular_file(current) && !expected_artifacts.contains(relative))
                    throw WorkingViewError(
                        "WORKING_SOURCE_UNTRUSTED", relative,
                        "Working artifact is absent from the committed manifest.");
            }
        }
        // Copy into a private, disposable validation directory. No symlinks,
        // hardlinks, daemon source authority, or mutable cache state are shared.
        const auto temp = fs::temp_directory_path();
        std::mt19937_64 random(std::random_device{}());
        for (int attempt = 0; attempt < 10; ++attempt) {
            const auto candidate = temp / ("noveltea-working-" + std::to_string(random()));
            std::error_code error;
            if (fs::create_directory(candidate, error)) {
                view.view_root = candidate;
                fs::permissions(candidate, fs::perms::owner_all, fs::perm_options::replace);
                break;
            }
        }
        if (view.view_root.empty())
            throw WorkingViewError("WORKING_SOURCE_UNAVAILABLE", "manifest.json",
                                   "Cannot allocate a private validation view.", 70);
        std::uintmax_t copied = 0;
        for (fs::recursive_directory_iterator iter(root), end; iter != end; ++iter) {
            const auto relative = iter->path().lexically_relative(root).generic_string();
            if (relative == ".noveltea" || relative == ".git" || relative == "node_modules") {
                iter.disable_recursion_pending();
                continue;
            }
            const auto status = iter->symlink_status();
            if (fs::is_symlink(status))
                throw WorkingViewError(
                    "WORKING_SOURCE_UNSAFE", relative,
                    "Project source symlink cannot be admitted into working validation.");
            const auto dest = view.view_root / relative;
            if (fs::is_directory(status)) {
                fs::create_directories(dest);
            } else if (fs::is_regular_file(status)) {
                const auto size = iter->file_size();
                if (size > 512ull * 1024 * 1024 || copied + size > 1024ull * 1024 * 1024)
                    throw WorkingViewError("WORKING_SOURCE_UNAVAILABLE", relative,
                                           "Project exceeds the bounded read-only view limit.", 70);
                copied += size;
                fs::create_directories(dest.parent_path());
                fs::copy_file(iter->path(), dest);
                const auto physical = read_safe(root, relative, 512ull * 1024 * 1024);
                const auto mirrored = read_safe(view.view_root, relative, 512ull * 1024 * 1024);
                if (!physical || !mirrored || *physical != *mirrored)
                    throw WorkingViewError("WORKING_SOURCE_CHANGED", relative,
                                           "Project changed while creating the read-only view.", 5);
                view.proofs[relative] = sha(*physical);
            }
        }
        for (const auto& [relative, value] : replacements) {
            const auto target = view.view_root / relative;
            if (!value) {
                std::error_code ignored;
                fs::remove(target, ignored);
                continue;
            }
            fs::create_directories(target.parent_path());
            std::ofstream output(target, std::ios::binary | std::ios::trunc);
            output.write(value->data(), static_cast<std::streamsize>(value->size()));
            if (!output)
                throw WorkingViewError("WORKING_SOURCE_UNAVAILABLE", relative,
                                       "Cannot materialize read-only working view.", 70);
        }
        if (const auto stale = view.stale_reason())
            throw WorkingViewError("WORKING_SOURCE_CHANGED", "manifest.json", *stale, 5);
        return view;
    }

    std::optional<std::string> stale_reason() const
    {
        try {
            for (const auto& [relative, expected] : proofs) {
                const auto bytes = read_safe(original_root, relative, 512ull * 1024 * 1024);
                const auto now = bytes ? std::optional(sha(*bytes)) : std::nullopt;
                if (now != expected)
                    return "Project or working-source bytes changed during read-only validation: " +
                           relative;
            }
        } catch (const std::exception& error) {
            return error.what();
        }
        return std::nullopt;
    }
};
} // namespace noveltea::cli
