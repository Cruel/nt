#pragma once

#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <span>
#include <string>
#include <string_view>
#include <vector>

namespace noveltea::core {

inline constexpr std::uint32_t player_config_format_version = 1;
inline constexpr std::uint32_t runtime_package_api_version = 1;

enum class PlayerBootstrapError {
    ConfigDiscovery,
    ConfigParse,
    PackageDiscovery,
    PackageChecksum,
    PackageApi,
    Capability,
    PackageContent,
    WritableRoot,
};

struct PlayerBootstrapDiagnostic {
    PlayerBootstrapError category = PlayerBootstrapError::ConfigParse;
    std::string path;
    std::string message;
};

struct PlayerDisplayConfig {
    std::uint32_t aspect_width = 16;
    std::uint32_t aspect_height = 9;
    std::string orientation = "landscape";
    std::string bar_color = "#000000";
};

struct PlayerBootstrapConfig {
    std::string display_name;
    std::string application_id;
    std::string save_namespace;
    std::string version_name;
    std::string default_locale;
    std::filesystem::path package_path;
    std::string package_sha256;
    std::uint32_t runtime_package_api = 0;
    std::vector<std::string> capabilities;
    PlayerDisplayConfig display;
};

struct PlayerBootstrapResult {
    PlayerBootstrapConfig config;
    std::vector<std::byte> package_bytes;
    std::vector<PlayerBootstrapDiagnostic> diagnostics;
    [[nodiscard]] bool success() const noexcept { return diagnostics.empty(); }
};

[[nodiscard]] PlayerBootstrapResult parse_player_config(std::string_view json_text);
[[nodiscard]] PlayerBootstrapResult
load_and_verify_player(const std::filesystem::path& config_path,
                       std::span<const std::string> supported_capabilities = {});
[[nodiscard]] std::string sha256_hex(std::span<const std::byte> bytes);
[[nodiscard]] bool is_safe_player_relative_path(std::string_view path);
[[nodiscard]] const char* player_bootstrap_error_name(PlayerBootstrapError error) noexcept;

} // namespace noveltea::core
