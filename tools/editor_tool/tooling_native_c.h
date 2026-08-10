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
int32_t noveltea_tooling_shaderc(int32_t argc, const char* const* argv);

#ifdef __cplusplus
}
#endif
