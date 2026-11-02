#pragma once

#include <string>
#include <string_view>
#include <map>
#include <cstdint>

namespace noveltea::tooling {

struct NativeOperationResult {
    int exit_code = 1;
    std::string response_json;
};

[[nodiscard]] NativeOperationResult compile_shaders(std::string_view request_json);
[[nodiscard]] NativeOperationResult run_headless_test(std::string_view request_json);
[[nodiscard]] NativeOperationResult run_test_suite(std::string_view request_json);
[[nodiscard]] NativeOperationResult run_ui_test(std::string_view request_json);
[[nodiscard]] NativeOperationResult export_package(std::string_view request_json);
[[nodiscard]] NativeOperationResult validate_font_coverage(std::string_view request_json);
// Resident-only proof from the native Project watcher. Not exposed to the JSON
// boundary or persisted: an offline edit must never borrow a prior watch epoch.
struct FontCoverageSourceProofs {
    struct Source {
        std::string observed_revision;
        std::string exact_content_revision;
    };
    std::map<std::string, Source> project_fonts;
    std::uint64_t watch_epoch = 0;
};
[[nodiscard]] NativeOperationResult validate_font_coverage(
    std::string_view request_json,
    const std::map<std::string, std::string>* observed_project_revisions,
    FontCoverageSourceProofs& proofs);
// Optional same-build ledger data; imported entries must establish fresh physical authority.
std::string font_coverage_ledger();
bool restore_font_coverage_ledger(std::string_view snapshot);
// Fast fail-closed fence for already-certified system font bytes; Linux's
// inode+parent watches must still match current file metadata.
bool retained_font_system_sources_current();
// Release the short-lived CLI's native Project resident before process-local
// validation statics begin their C++ teardown.
void release_native_disk_validation_owner() noexcept;
[[nodiscard]] NativeOperationResult inspect_font(std::string_view request_json);
[[nodiscard]] NativeOperationResult invoke_legacy_command(std::string_view command,
                                                          std::string_view request_json);

} // namespace noveltea::tooling
