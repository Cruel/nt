#pragma once

#include "contracts.hpp"
#include "source_analysis.hpp"

#include <cstddef>
#include <filesystem>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace noveltea::authoring {
struct NativeLocalizationRetainedState;
// Reusable, source-local Message contributions. An observed revision is usable
// only inside a current, physically verified SourceAuthority observation;
// otherwise the collector reopens and hashes the YAML itself.
struct NativeStructuredSourcesCache {
    struct Entry {
        std::string source_identity;
        std::map<std::string, std::string> messages;
    };
    std::map<std::string, Entry> records;
    std::size_t reused = 0;
    std::size_t rechecked = 0;
    // Per-validation work (not cumulative). Separate physical YAML I/O from
    // contributor reuse: a hash of freshly reread bytes is not an I/O saving.
    std::size_t physical_yaml_opens = 0;
    std::size_t physical_yaml_reads = 0;
    std::size_t physical_yaml_parses = 0;
    std::size_t exact_disk_hashes = 0;
    std::size_t observed_reuses = 0;
    std::size_t projections = 0;
    std::size_t localization_model_passes = 0;
    std::size_t dialogue_cue_passes = 0;
    std::size_t incremental_message_validations = 0;
    std::size_t incremental_model_passes = 0;
    std::string incremental_fallback_reason;
    std::size_t incremental_translation_checks = 0;
    std::size_t full_contract_validations = 0;
    std::size_t structured_projection_micros = 0;
    std::size_t fragment_validation_micros = 0;
    std::size_t merged_model_micros = 0;
    std::size_t contract_serialization_micros = 0;
    std::size_t contract_validation_micros = 0;
    std::size_t dependent_validation_micros = 0;
    std::size_t cue_validation_micros = 0;
    // Retained only after complete successful admission of an exact observed
    // source generation. Not a second source authority.
    std::shared_ptr<NativeLocalizationRetainedState> retained;
};

// Rebind an already validated working localization model to the exact disk
// generation installed by a single, acknowledged Room Save. Only the saved
// file's revision may differ; all other verified source identities and the
// Room's working semantic value must remain unchanged. Otherwise the next
// localization validation must take its ordinary full-validation path.
bool rebase_localization_after_verified_room_save(
    NativeStructuredSourcesCache& cache, std::string_view record_path,
    std::string_view working_record_json,
    const std::map<std::string, std::string>& verified_revisions) noexcept;

struct NativeLocalizationTrackingOccurrence {
    std::size_t ordinal = 0;
    std::string structural_fingerprint;
    std::string anchor_fingerprint;
    std::string source_fingerprint;
    std::string source_snapshot;
    std::optional<std::string> context_snapshot;
    std::optional<std::string> translator_note_snapshot;
    std::string kind;
    std::map<std::string, std::string> cases;
};

struct NativeLocalizationTrackingSource {
    std::string family;
    std::string owner_key;
    std::string source_path;
    std::string source_snapshot_fingerprint;
    std::vector<NativeLocalizationTrackingOccurrence> occurrences;
};

// The tracked structural and anchor fingerprints used by native runtime
// validation are also exposed to the CLI synchronizer; two implementations of
// Message identity must never diverge.
NativeLocalizationTrackingSource native_localization_tracking_source(const SourceAnalysis& analysis,
                                                                     std::string family,
                                                                     std::string owner_key,
                                                                     std::string source_path);
std::string native_localization_tracking_fingerprint(std::string_view text);
std::size_t native_localization_structured_message_count(const std::filesystem::path& root);
// Disk-owned semantic Text paths used to preserve structured Message identity
// across native structural record renames and deletions.
std::map<std::string, std::string>
native_localization_record_structured_sources(const std::filesystem::path& root,
                                              std::string_view family, std::string_view id);
std::map<std::string, std::string>
native_localization_effective_structured_sources(std::string_view family, std::string_view id,
                                                 std::string_view normalized_record_json);
std::string native_localization_structured_message_id(std::string_view semantic_path);

// Assemble and validate the tracked split i18n sources as one effective Project
// localization model. Overlays are JSON source values from dirty native owners;
// they are never persisted by reading or validating this model.
ValidationResult
validate_project_localization(const std::filesystem::path& project_root,
                              const std::map<std::string, std::string>& source_overlays = {},
                              const std::map<std::string, std::string>& record_overlays = {},
                              const std::map<std::string, SourceAnalysis>& working_sources = {},
                              NativeStructuredSourcesCache* structured_cache = nullptr);
} // namespace noveltea::authoring
