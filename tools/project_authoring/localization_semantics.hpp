#pragma once

#include "contracts.hpp"
#include "source_analysis.hpp"

#include <filesystem>
#include <map>
#include <optional>
#include <string>
#include <vector>

namespace noveltea::authoring {
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
                              const std::map<std::string, SourceAnalysis>& working_sources = {});
} // namespace noveltea::authoring
