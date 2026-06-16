file(GLOB_RECURSE _headers
    "${ROOT}/engine/src/**/*.bin.h"
    "${ROOT}/engine/include/**/*.bin.h")
if(_headers)
    list(JOIN _headers "\n  " _message)
    message(FATAL_ERROR "Committed/generated shader headers are not allowed:\n  ${_message}")
endif()
