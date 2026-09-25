cmake_minimum_required(VERSION 3.25)

if(NOT CMAKE_HOST_SYSTEM_NAME STREQUAL "Linux")
  message(FATAL_ERROR "Linux compatibility audit must run on Linux")
endif()
if(NOT DEFINED NOVELTEA_MAX_GLIBC_VERSION)
  message(FATAL_ERROR "NOVELTEA_MAX_GLIBC_VERSION is required")
endif()

set(candidates)
if(DEFINED NOVELTEA_BINARY)
  if(NOT EXISTS "${NOVELTEA_BINARY}")
    message(FATAL_ERROR "NOVELTEA_BINARY does not exist: ${NOVELTEA_BINARY}")
  endif()
  list(APPEND candidates "${NOVELTEA_BINARY}")
endif()
if(DEFINED NOVELTEA_TREE)
  if(NOT IS_DIRECTORY "${NOVELTEA_TREE}")
    message(FATAL_ERROR "NOVELTEA_TREE is not a directory: ${NOVELTEA_TREE}")
  endif()
  file(GLOB_RECURSE tree_candidates LIST_DIRECTORIES false "${NOVELTEA_TREE}/*")
  list(APPEND candidates ${tree_candidates})
endif()
if(NOT candidates)
  message(FATAL_ERROR "Set NOVELTEA_BINARY or NOVELTEA_TREE")
endif()

find_program(OBJDUMP objdump REQUIRED)
set(audited 0)
foreach(candidate IN LISTS candidates)
  if(IS_DIRECTORY "${candidate}")
    continue()
  endif()
  file(READ "${candidate}" magic HEX LIMIT 4)
  string(TOLOWER "${magic}" magic)
  if(NOT magic STREQUAL "7f454c46")
    continue()
  endif()

  math(EXPR audited "${audited} + 1")
  execute_process(
    COMMAND "${OBJDUMP}" -T "${candidate}"
    OUTPUT_VARIABLE symbols
    ERROR_VARIABLE objdump_error
    RESULT_VARIABLE objdump_result)
  if(NOT objdump_result EQUAL 0)
    message(FATAL_ERROR "objdump failed for ${candidate}: ${objdump_error}")
  endif()

  string(REGEX MATCHALL "GLIBC_[0-9]+\\.[0-9]+(\\.[0-9]+)?" glibc_versions "${symbols}")
  foreach(glibc IN LISTS glibc_versions)
    string(REPLACE "GLIBC_" "" version "${glibc}")
    if(version VERSION_GREATER NOVELTEA_MAX_GLIBC_VERSION)
      message(FATAL_ERROR
        "${candidate} requires ${glibc}, newer than supported baseline GLIBC_${NOVELTEA_MAX_GLIBC_VERSION}")
    endif()
  endforeach()

  if(DEFINED NOVELTEA_MAX_GLIBCXX_VERSION)
    string(REGEX MATCHALL "GLIBCXX_[0-9]+\\.[0-9]+(\\.[0-9]+)?" glibcxx_versions "${symbols}")
    foreach(glibcxx IN LISTS glibcxx_versions)
      string(REPLACE "GLIBCXX_" "" version "${glibcxx}")
      if(version VERSION_GREATER NOVELTEA_MAX_GLIBCXX_VERSION)
        message(FATAL_ERROR
          "${candidate} requires ${glibcxx}, newer than supported baseline GLIBCXX_${NOVELTEA_MAX_GLIBCXX_VERSION}")
      endif()
    endforeach()
  endif()

  if(NOVELTEA_REQUIRE_STATIC_GNU_CXX_RUNTIME)
    execute_process(
      COMMAND ldd "${candidate}"
      OUTPUT_VARIABLE closure
      ERROR_VARIABLE ldd_error
      RESULT_VARIABLE ldd_result)
    if(NOT ldd_result EQUAL 0)
      message(FATAL_ERROR "ldd failed for ${candidate}: ${ldd_error}")
    endif()
    if(closure MATCHES "libstdc\\+\\+\\.so" OR closure MATCHES "libgcc_s\\.so")
      message(FATAL_ERROR
        "${candidate} dynamically imports the GNU C++ runtime despite the static-runtime player policy:\n${closure}")
    endif()
  endif()
endforeach()

if(audited EQUAL 0)
  message(FATAL_ERROR "Linux compatibility audit found no ELF binaries")
endif()
set(summary "Audited ${audited} ELF file(s): GLIBC <= ${NOVELTEA_MAX_GLIBC_VERSION}")
if(DEFINED NOVELTEA_MAX_GLIBCXX_VERSION)
  string(APPEND summary ", GLIBCXX <= ${NOVELTEA_MAX_GLIBCXX_VERSION}")
endif()
message(STATUS "${summary}")
