#pragma once

// Instrumented native CLI processes must never share a gcov output tree.
// A Python CTest may launch multiple foreground CLIs while broker/owner
// processes remain alive, so isolating daemon modes alone is insufficient.
#if defined(__linux__)
#include <cstdlib>
#include <filesystem>
#include <stdexcept>
#include <string>
#include <unistd.h>

namespace noveltea::cli {

inline void isolate_native_cli_gcov_process()
{
    const char* root = std::getenv("NOVELTEA_NATIVE_CLI_GCOV_ROOT");
    if (!root || !*root)
        return;
    const auto isolated = std::string(root) + ".process-" + std::to_string(::getpid());
    std::filesystem::create_directories(isolated);
    if (::setenv("GCOV_PREFIX", isolated.c_str(), 1) != 0)
        throw std::runtime_error("Cannot isolate gcov counters for native CLI process.");
}

} // namespace noveltea::cli
#endif
