# Lower bx's declared glibc support floor to NovelTea's Linux player floor.
#
# NovelTea validates the resulting player binary against glibc 2.28 in the
# compatibility container. Keep this patch narrow: it changes only bx's
# compile-time support guard and does not spoof libc version macros.

set(platform_header "bx/include/bx/platform.h")
if(NOT EXISTS "${platform_header}")
  message(FATAL_ERROR "bx platform header not found: ${platform_header}")
endif()

file(READ "${platform_header}" platform_content)
set(upstream_guard "static_assert(!BX_CRT_GLIBC || BX_CRT_GLIBC >= 23100")
set(noveltea_guard "static_assert(!BX_CRT_GLIBC || BX_CRT_GLIBC >= 22800")
set(upstream_message "Minimum supported GLIBC version is 2.31.0 (February 1, 2020).")
set(noveltea_message "Minimum supported GLIBC version is 2.28.0 (August 1, 2018).")

string(FIND "${platform_content}" "${upstream_guard}" upstream_guard_index)
string(FIND "${platform_content}" "${noveltea_guard}" noveltea_guard_index)
if(NOT upstream_guard_index EQUAL -1)
  string(REPLACE "${upstream_guard}" "${noveltea_guard}" platform_content "${platform_content}")
  string(REPLACE "${upstream_message}" "${noveltea_message}" platform_content "${platform_content}")
  file(WRITE "${platform_header}" "${platform_content}")
elseif(noveltea_guard_index EQUAL -1)
  message(FATAL_ERROR
    "bx glibc support guard changed; refusing to continue without compatibility review")
endif()
