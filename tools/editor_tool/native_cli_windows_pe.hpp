#pragma once

#include <filesystem>
#include <string>

namespace noveltea::cli {

// Portable Windows player resource customization. This operates on PE bytes,
// not Windows APIs, so the host may be Linux, macOS, or Windows.
struct WindowsPeIdentity {
    std::string executable_name;
    std::string display_name;
    std::string version_name;
    std::string application_id;
};

void customize_windows_player(const std::filesystem::path& input_executable,
                              const std::filesystem::path& output_executable,
                              const std::filesystem::path& icon_file,
                              const WindowsPeIdentity& identity);

} // namespace noveltea::cli
