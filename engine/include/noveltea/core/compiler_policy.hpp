#pragma once
#if defined(__cpp_exceptions) || defined(__EXCEPTIONS) || defined(_CPPUNWIND)
#error "NovelTea shipped C++ targets must be compiled without exception support"
#endif
#if defined(__GXX_RTTI) || defined(_CPPRTTI)
#error "NovelTea shipped C++ targets must be compiled without compiler RTTI"
#endif
