#pragma once

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

uint64_t noveltea_tooling_compile_shaders_json(const uint8_t* request, uint64_t request_size,
                                               uint8_t* response, uint64_t response_capacity);
uint64_t noveltea_tooling_run_headless_test_json(const uint8_t* request, uint64_t request_size,
                                                 uint8_t* response, uint64_t response_capacity);
uint64_t noveltea_tooling_run_ui_test_json(const uint8_t* request, uint64_t request_size,
                                           uint8_t* response, uint64_t response_capacity);
uint64_t noveltea_tooling_export_package_json(const uint8_t* request, uint64_t request_size,
                                              uint8_t* response, uint64_t response_capacity);
uint64_t noveltea_tooling_shaderc_json(const uint8_t* request, uint64_t request_size,
                                       uint8_t* response, uint64_t response_capacity);
uint64_t noveltea_tooling_image_inspect_json(const uint8_t* request, uint64_t request_size,
                                             uint8_t* response, uint64_t response_capacity);
uint64_t noveltea_tooling_image_resize_png_json(const uint8_t* request, uint64_t request_size,
                                                uint8_t* response, uint64_t response_capacity);
uint64_t noveltea_tooling_file_mode_json(const uint8_t* request, uint64_t request_size,
                                         uint8_t* response, uint64_t response_capacity);
uint64_t noveltea_tooling_disk_space_json(const uint8_t* request, uint64_t request_size,
                                          uint8_t* response, uint64_t response_capacity);
uint64_t noveltea_tooling_create_archive_json(const uint8_t* request, uint64_t request_size,
                                              uint8_t* response, uint64_t response_capacity);
void noveltea_tooling_scriptc_invoke_to_file(const uint8_t* operation, size_t operation_size,
                                             const uint8_t* request, size_t request_size,
                                             const uint8_t* response_path,
                                             size_t response_path_size);
int32_t noveltea_tooling_shaderc(int32_t argc, const char* const* argv);
int32_t noveltea_tooling_texturec(int32_t argc, const char* const* argv);
uint64_t noveltea_tooling_texturec_json(const uint8_t* request, uint64_t request_size,
                                        uint8_t* response, uint64_t response_capacity);

#ifdef __cplusplus
}
#endif
