#pragma once

#include <string>
#include <string_view>

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
// Optional same-build ledger data; imported entries still reprove physical font bytes.
std::string font_coverage_ledger();
bool restore_font_coverage_ledger(std::string_view snapshot);
// Release the short-lived CLI's native Project resident before process-local
// validation statics begin their C++ teardown.
void release_native_disk_validation_owner() noexcept;
[[nodiscard]] NativeOperationResult inspect_font(std::string_view request_json);
[[nodiscard]] NativeOperationResult invoke_legacy_command(std::string_view command,
                                                          std::string_view request_json);

} // namespace noveltea::tooling
