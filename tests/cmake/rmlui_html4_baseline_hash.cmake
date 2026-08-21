if(NOT DEFINED NOVELTEA_SOURCE_DIR)
    message(FATAL_ERROR "NOVELTEA_SOURCE_DIR is required")
endif()

set(baseline "${NOVELTEA_SOURCE_DIR}/engine/assets/system/ui/baseline/rmlui-html4.rcss")
set(expected_sha256 "6d29abc4a959f14dac3041ecce498c0aac98cbd9e141951c5749e12a02542d05")

if(NOT EXISTS "${baseline}")
    message(FATAL_ERROR "Missing frozen RmlUi HTML4 baseline: ${baseline}")
endif()

file(SHA256 "${baseline}" actual_sha256)
if(NOT actual_sha256 STREQUAL expected_sha256)
    message(FATAL_ERROR
        "Frozen RmlUi HTML4 baseline changed. Keep NovelTea overrides in noveltea.rcss, or intentionally refresh the upstream copy and its documented provenance/hash. Expected ${expected_sha256}, got ${actual_sha256}.")
endif()
