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
[[nodiscard]] NativeOperationResult run_ui_test(std::string_view request_json);
[[nodiscard]] NativeOperationResult export_package(std::string_view request_json);
[[nodiscard]] NativeOperationResult invoke_legacy_command(std::string_view command,
                                                          std::string_view request_json);

} // namespace noveltea::tooling
