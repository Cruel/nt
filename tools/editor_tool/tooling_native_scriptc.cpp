#include "tooling_native_c.h"

#include <cstddef>
#include <cstdint>
#include <fstream>
#include <string>
#include <string_view>
#include <vector>

namespace {

using NativeOperation = std::uint64_t (*)(const std::uint8_t*, std::uint64_t, std::uint8_t*,
                                          std::uint64_t);

NativeOperation operation_for(std::string_view operation)
{
    if (operation == "compile-shaders")
        return &noveltea_tooling_compile_shaders_json;
    if (operation == "run-test")
        return &noveltea_tooling_run_headless_test_json;
    if (operation == "run-ui-test")
        return &noveltea_tooling_run_ui_test_json;
    if (operation == "export-package")
        return &noveltea_tooling_export_package_json;
    if (operation == "shaderc")
        return &noveltea_tooling_shaderc_json;
    return nullptr;
}

void write_text(std::string_view path, std::string_view text)
{
    std::ofstream output(std::string(path), std::ios::binary | std::ios::trunc);
    output.write(text.data(), static_cast<std::streamsize>(text.size()));
}

} // namespace

extern "C" void noveltea_tooling_scriptc_invoke_to_file(const std::uint8_t* operation_bytes,
                                                        std::size_t operation_size,
                                                        const std::uint8_t* request_bytes,
                                                        std::size_t request_size,
                                                        const std::uint8_t* response_path_bytes,
                                                        std::size_t response_path_size)
{
    const std::string_view operation(reinterpret_cast<const char*>(operation_bytes),
                                     operation_size);
    const std::string_view response_path(reinterpret_cast<const char*>(response_path_bytes),
                                         response_path_size);
    const auto native_operation = operation_for(operation);
    if (native_operation == nullptr) {
        write_text(response_path, R"({"ok":false,"error":"unknown native operation"})");
        return;
    }

    const auto required =
        native_operation(request_bytes, static_cast<std::uint64_t>(request_size), nullptr, 0);
    std::vector<std::uint8_t> response(static_cast<std::size_t>(required));
    const auto written = native_operation(request_bytes, static_cast<std::uint64_t>(request_size),
                                          response.data(), required);
    if (written > response.size()) {
        write_text(response_path, R"({"ok":false,"error":"native response overflow"})");
        return;
    }
    if (written == 0) {
        write_text(response_path, {});
        return;
    }
    write_text(response_path, std::string_view(reinterpret_cast<const char*>(response.data()),
                                               static_cast<std::size_t>(written)));
}
