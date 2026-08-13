#include "tooling_native_c.h"

#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#if defined(_WIN32)
#include <windows.h>
#endif

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
    if (operation == "image-inspect")
        return &noveltea_tooling_image_inspect_json;
    if (operation == "image-resize-png")
        return &noveltea_tooling_image_resize_png_json;
    if (operation == "file-mode")
        return &noveltea_tooling_file_mode_json;
    if (operation == "disk-space")
        return &noveltea_tooling_disk_space_json;
    return nullptr;
}

std::filesystem::path filesystem_path_from_utf8(std::string_view value)
{
#if defined(_WIN32)
    if (value.empty())
        return {};
    const int required = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
                                             static_cast<int>(value.size()), nullptr, 0);
    if (required <= 0)
        return {};
    std::wstring wide(static_cast<std::size_t>(required), L'\0');
    const int written = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
                                            static_cast<int>(value.size()), wide.data(), required);
    if (written != required)
        return {};
    return std::filesystem::path(std::move(wide));
#else
    return std::filesystem::path(value);
#endif
}

void write_text(std::string_view path, std::string_view text)
{
    std::ofstream output(filesystem_path_from_utf8(path), std::ios::binary | std::ios::trunc);
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
