#include "room_session.hpp"

#include <jsoncons/json.hpp>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <map>
#include <optional>
#include <random>
#include <stdexcept>
#include <string>

#ifdef _WIN32
#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#endif

namespace noveltea::authoring {
namespace {
namespace fs = std::filesystem;
using Json = jsoncons::ojson;

// Intentionally NOT the TypeScript authoring-cache semantic identity. Native
// diagnostic semantics must be independently bumped when validation changes.
constexpr std::string_view kContract = "noveltea.native-clean-validation.v1";
constexpr std::string_view kSemanticKey = "workspace-v1/native-project-validation-502.1";
constexpr std::string_view kSemanticFingerprint = NOVELTEA_NATIVE_VALIDATION_FINGERPRINT;
constexpr std::string_view kRelative = ".noveltea/cache/authoring/native-clean-current.json";

bool safe_cache_path(const fs::path& root)
{
    fs::path partial = root;
    for (const auto* segment : {".noveltea", "cache", "authoring", "native-clean-current.json"}) {
        partial /= segment;
        const auto status = fs::symlink_status(partial);
        if (status.type() == fs::file_type::symlink ||
            (status.type() != fs::file_type::not_found &&
             status.type() != fs::file_type::directory &&
             !(partial == root / kRelative && status.type() == fs::file_type::regular)))
            return false;
    }
    return true;
}

bool transactions_settled(const fs::path& root)
{
    const auto transactions = root / ".noveltea/transactions";
    const auto status = fs::symlink_status(transactions);
    if (status.type() == fs::file_type::not_found)
        return true;
    return status.type() == fs::file_type::directory && fs::is_empty(transactions);
}

std::optional<std::map<std::string, std::string>>
exact_proof(const fs::path& root, const std::optional<std::map<std::string, std::string>>& observed)
{
    if (!observed)
        return std::nullopt;
    auto revisions = *observed;
    // SourceAuthority avoids hashing large binary Assets for ordinary watcher
    // polling. Clean result admission is stricter: no size+mtime-only proof.
    for (auto& [relative, revision] : revisions) {
        if (!revision.starts_with("physical:"))
            continue;
        const fs::path path = root / relative;
        const auto contained = fs::weakly_canonical(path).lexically_relative(fs::canonical(root));
        if (!fs::is_regular_file(path) || fs::is_symlink(fs::symlink_status(path)) ||
            contained.empty() || *contained.begin() == "..")
            return std::nullopt;
        std::ifstream input(path, std::ios::binary);
        if (!input)
            return std::nullopt;
        const std::string bytes{std::istreambuf_iterator<char>(input),
                                std::istreambuf_iterator<char>()};
        if (!input.eof() && input.fail())
            return std::nullopt;
        revision = exact_source_revision(bytes);
    }
    return revisions;
}

Json revision_json(const std::map<std::string, std::string>& revisions)
{
    Json value = Json::object();
    for (const auto& [path, revision] : revisions)
        value[path] = revision;
    return value;
}

Json diagnostics_json(const std::vector<Diagnostic>& diagnostics)
{
    Json result = Json::array();
    for (const auto& diagnostic : diagnostics) {
        Json item = Json::object();
        item["path"] = diagnostic.path;
        item["code"] = diagnostic.code;
        item["message"] = diagnostic.message;
        item["severity"] = diagnostic.severity;
        item["sourcePath"] = diagnostic.source_path;
        if (diagnostic.line)
            item["line"] = *diagnostic.line;
        if (diagnostic.column)
            item["column"] = *diagnostic.column;
        result.push_back(std::move(item));
    }
    return result;
}

std::optional<RoomSessionSnapshot>
read_clean_cache(const fs::path& root, const std::map<std::string, std::string>& revisions,
                 const RoomSessionSnapshot& source)
{
    try {
        if (!safe_cache_path(root))
            return std::nullopt;
        const auto path = root / kRelative;
        if (!fs::is_regular_file(path) || fs::file_size(path) > 8 * 1024 * 1024)
            return std::nullopt;
        std::ifstream input(path, std::ios::binary);
        const auto value = Json::parse(input);
        if (!value.is_object() || value.size() != 6 || value.at("contract") != kContract ||
            value.at("semanticKey") != kSemanticKey ||
            value.at("semanticFingerprint") != kSemanticFingerprint ||
            value.at("projectRoot") != fs::canonical(root).generic_string() ||
            value.at("revisions") != revision_json(revisions))
            return std::nullopt;
        const auto& result = value.at("result");
        if (!result.is_object() || result.size() != 2 || !result.at("valid").is_bool() ||
            !result.at("diagnostics").is_array() || result.at("diagnostics").size() > 10000)
            return std::nullopt;
        RoomSessionSnapshot snapshot = source;
        snapshot.valid = result.at("valid").as<bool>();
        snapshot.diagnostics.clear();
        bool errors = false;
        for (const auto& entry : result.at("diagnostics").array_range()) {
            if (!entry.is_object() || entry.size() < 5 || entry.size() > 7 ||
                !entry.at("path").is_string() || !entry.at("code").is_string() ||
                !entry.at("message").is_string() || !entry.at("severity").is_string() ||
                !entry.at("sourcePath").is_string())
                return std::nullopt;
            Diagnostic issue{entry.at("path").as<std::string>(), entry.at("code").as<std::string>(),
                             entry.at("message").as<std::string>(),
                             entry.at("severity").as<std::string>()};
            issue.source_path = entry.at("sourcePath").as<std::string>();
            if (issue.severity != "error" && issue.severity != "warning" &&
                issue.severity != "info")
                return std::nullopt;
            errors |= issue.severity == "error";
            if (entry.contains("line")) {
                if (!entry.at("line").is_integer<int>() || entry.at("line").as<int>() <= 0)
                    return std::nullopt;
                issue.line = entry.at("line").as<int>();
            }
            if (entry.contains("column")) {
                if (!entry.at("column").is_integer<int>() || entry.at("column").as<int>() <= 0)
                    return std::nullopt;
                issue.column = entry.at("column").as<int>();
            }
            snapshot.diagnostics.push_back(std::move(issue));
        }
        if (snapshot.valid == errors)
            return std::nullopt;
        return snapshot;
    } catch (...) {
        return std::nullopt; // Optional acceleration; malformed or old formats always miss.
    }
}

void publish_clean_cache(const fs::path& root, const std::map<std::string, std::string>& revisions,
                         const RoomSessionSnapshot& snapshot)
{
    try {
        if (!safe_cache_path(root))
            return;
        const fs::path path = root / kRelative;
        fs::create_directories(path.parent_path());
        if (!safe_cache_path(root))
            return;
        Json value = Json::object();
        value["contract"] = std::string(kContract);
        value["semanticKey"] = std::string(kSemanticKey);
        value["semanticFingerprint"] = std::string(kSemanticFingerprint);
        value["projectRoot"] = fs::canonical(root).generic_string();
        value["revisions"] = revision_json(revisions);
        value["result"] = Json::object();
        value["result"]["valid"] = snapshot.valid;
        value["result"]["diagnostics"] = diagnostics_json(snapshot.diagnostics);
        static std::atomic<std::uint64_t> sequence{0};
        const auto staged = fs::path(
            path.string() + "." +
            std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()) + "." +
            std::to_string(std::random_device{}()) + "." + std::to_string(++sequence) + ".tmp");
        {
            std::ofstream output(staged, std::ios::binary | std::ios::trunc);
            if (!output)
                return;
            output << value.to_string() << '\n';
            output.flush();
            if (!output) {
                std::error_code ignored;
                output.close();
                fs::remove(staged, ignored);
                return;
            }
        }
        // A concurrent publisher can win; both entries are admitted only by
        // re-proving the entire input manifest, not by trusting the rename.
        try {
#ifdef _WIN32
            if (!MoveFileExW(staged.c_str(), path.c_str(),
                             MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH))
                throw std::runtime_error("Cannot replace native validation cache.");
#else
            fs::rename(staged, path);
#endif
        } catch (...) {
            std::error_code ignored;
            fs::remove(staged, ignored);
            throw;
        }
    } catch (...) {
        // Never make validation fail due to a missing/read-only cache directory.
    }
}
} // namespace

ProjectSession::CleanValidation ProjectSession::validate_clean_project()
{
    const auto clean = [&]() {
        if (source_->snapshot().dirty || !shader_overlays_.empty() ||
            !text_source_overlays_.empty())
            return false;
        for (const auto& [owner, record] : records_) {
            (void)owner;
            if (record->snapshot().dirty)
                return false;
        }
        return true;
    };
    const auto proof = [&]() -> std::optional<std::map<std::string, std::string>> {
        if (!transactions_settled(root_))
            return std::nullopt;
        const auto observation = observe_sources();
        if (observation.full_rescan) {
            // The common native observer revoked resident proof. This request
            // may only return after a fresh full semantic validation.
            return std::nullopt;
        }
        if (!observation.authoritative)
            return std::nullopt;
        auto exact = exact_proof(root_, source_authority_->verified_revisions());
        return transactions_settled(root_) ? exact : std::nullopt;
    };
    if (validation_pending_uncertain_) {
        // The watcher may have completed its recovery scan *before* this call.
        // In that case the full-rescan flag is no longer emitted by proof(),
        // but the former resident and imported semantic evidence is still
        // revoked until a fresh validation rebuilds the contributors.
        validation_snapshot_.reset();
        validation_source_revisions_.clear();
        validation_contributions_.clear();
        validation_room_map_cache_.reset();
        imported_clean_validation_.reset();
        imported_clean_sources_.clear();
        imported_clean_revisions_.clear();
    }

    // A clean exact result contains no persisted contributor objects. For
    // strictly presentation-only Room/Map edits, prove that no semantic input
    // other than the owning display fields changed. This preserves all prior
    // source-aware diagnostics without cold-rechecking unrelated records.
    // Any non-presentation edit uses the normal full dependency validation.
    if (clean() && !validation_snapshot_ && imported_clean_validation_ &&
        !validation_pending_uncertain_) {
        if (const auto revisions = proof()) {
            std::vector<std::string> changed;
            for (const auto& [path, revision] : *revisions)
                if (!imported_clean_revisions_.contains(path) ||
                    imported_clean_revisions_.at(path) != revision)
                    changed.push_back(path);
            for (const auto& [path, revision] : imported_clean_revisions_)
                if (!revisions->contains(path))
                    changed.push_back(path);
            if (changed.size() == 1 && imported_clean_sources_.contains(changed.front())) {
                const auto& path = changed.front();
                const auto family = path.starts_with("records/rooms/") ? "rooms" : "maps";
                const auto prefix = std::string("records/") + family + "/";
                const auto id = path.substr(prefix.size(), path.size() - prefix.size() - 5);
                const auto owner = std::string(family) + "/" + id;
                bool owned_diagnostic = std::any_of(
                    imported_clean_validation_->diagnostics.begin(),
                    imported_clean_validation_->diagnostics.end(), [&](const Diagnostic& issue) {
                        return issue.source_path == path || issue.path == "/" + owner ||
                               issue.path.starts_with("/" + owner + "/");
                    });
                try {
                    const auto old_source = open_yaml_source(imported_clean_sources_.at(path));
                    std::ifstream stream(root_ / path, std::ios::binary);
                    const std::string current{std::istreambuf_iterator<char>(stream),
                                              std::istreambuf_iterator<char>()};
                    const auto new_source = open_yaml_source(current);
                    if (!owned_diagnostic && old_source.accepted && new_source.accepted &&
                        exact_source_revision(current) == revisions->at(path)) {
                        auto old_value = Json::parse(old_source.source_json);
                        auto new_value = Json::parse(new_source.source_json);
                        if (old_value.is_object() && new_value.is_object()) {
                            for (auto* key : {"label", "description"}) {
                                old_value.erase(key);
                                new_value.erase(key);
                            }
                            if (old_value == new_value) {
                                std::string error;
                                auto updated = RoomSession::open_record(root_, family, id, error);
                                if (updated && updated->snapshot().valid &&
                                    updated->snapshot().diagnostics.empty() &&
                                    proof() == revisions) {
                                    imported_clean_sources_[path] = current;
                                    imported_clean_revisions_ = *revisions;
                                    validation_pending_source_revisions_.clear();
                                    validation_work_ = {};
                                    validation_work_.rechecked_records = 1;
                                    validation_work_.rechecked_contributions = 1;
                                    validation_work_.retained_records =
                                        imported_clean_sources_.size() - 1;
                                    validation_work_.retained_contributions =
                                        imported_clean_sources_.size() - 1;
                                    publish_clean_cache(root_, *revisions,
                                                        *imported_clean_validation_);
                                    return {*imported_clean_validation_, false};
                                }
                            }
                        }
                    }
                } catch (...) {
                    // No partial reuse without a complete semantic proof.
                }
            }
        }
    }
    if (clean() && !validation_pending_uncertain_ && !validation_snapshot_ &&
        validation_pending_source_revisions_.empty()) {
        if (const auto revisions = proof()) {
            if (auto cached = read_clean_cache(root_, *revisions, source_->snapshot())) {
                std::map<std::string, std::string> presentation_sources;
                for (const auto& [path, revision] : *revisions) {
                    if (!(path.starts_with("records/rooms/") ||
                          path.starts_with("records/maps/")) ||
                        !path.ends_with(".yaml"))
                        continue;
                    std::ifstream stream(root_ / path, std::ios::binary);
                    const std::string bytes{std::istreambuf_iterator<char>(stream),
                                            std::istreambuf_iterator<char>()};
                    if (exact_source_revision(bytes) != revision) {
                        presentation_sources.clear();
                        break;
                    }
                    presentation_sources.emplace(path, bytes);
                }
                if (proof() == revisions) {
                    imported_clean_validation_ = *cached;
                    imported_clean_revisions_ = *revisions;
                    imported_clean_sources_ = std::move(presentation_sources);
                    validation_work_ = {};
                    return {std::move(*cached), true};
                }
            }
        }
    }
    imported_clean_validation_.reset();
    imported_clean_sources_.clear();
    imported_clean_revisions_.clear();
    auto snapshot = validate_project();
    if (clean() && !validation_pending_uncertain_) {
        if (const auto revisions = proof()) {
            if (proof() == revisions)
                publish_clean_cache(root_, *revisions, snapshot);
        }
    }
    return {std::move(snapshot), false};
}
} // namespace noveltea::authoring
