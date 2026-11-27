# The pinned dav1d MSVC compatibility header invokes Clang's __has_include_next
# inside a compound #if. VS 2026's conforming preprocessor validates it even
# when defined(__clang__) is false, aborting MSVC builds before player tests.
# Guard the builtin in its own Clang-only branch. Preserve the existing Clang
# include-next path and the native MSVC atomic implementation unchanged.
set(header "bimg/3rdparty/dav1d/include/compat/msvc/stdatomic.h")
if(NOT EXISTS "${header}")
    message(FATAL_ERROR "Pinned dav1d MSVC atomic header missing: ${header}")
endif()
file(READ "${header}" contents)
set(before "#if defined(__clang__) && __has_include_next(<stdatomic.h>)")
set(after "#if defined(__clang__)\n#  if __has_include_next(<stdatomic.h>)\n#    define NOVELTEA_DAV1D_USE_CLANG_STDATOMIC 1\n#  endif\n#endif\n#if defined(NOVELTEA_DAV1D_USE_CLANG_STDATOMIC)")
string(FIND "${contents}" "${before}" old_index)
string(FIND "${contents}" "${after}" patched_index)
if(NOT old_index EQUAL -1)
    string(REPLACE "${before}" "${after}" contents "${contents}")
    file(WRITE "${header}" "${contents}")
elseif(patched_index EQUAL -1)
    message(FATAL_ERROR "Pinned dav1d header changed; inspect before updating MSVC compatibility")
endif()
