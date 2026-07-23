#pragma once

#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <functional>
#include <span>
#include <string>
#include <string_view>
#include <vector>

namespace noveltea::core {

inline constexpr std::uint32_t player_config_format_version = 2;
inline constexpr std::uint32_t runtime_package_api_version = 2;

enum class PlayerBootstrapError {
    ConfigDiscovery,
    ConfigParse,
    PackageDiscovery,
    PackageChecksum,
    PackageApi,
    Capability,
    PackageContent,
    WritableRoot,
    Materialization,
};

struct PlayerBootstrapDiagnostic {
    PlayerBootstrapError category = PlayerBootstrapError::ConfigParse;
    std::string path;
    std::string message;
};

struct PlayerDisplayConfig {
    std::uint32_t reference_width = 1920;
    std::uint32_t reference_height = 1080;
    std::string world_raster_policy = "capped";
    std::string bar_color = "#000000";
};

struct PlayerAccessibilityScaleConfig {
    bool enabled = true;
    double minimum = 1.0;
    double maximum = 2.0;
};

struct PlayerAccessibilityConfig {
    PlayerAccessibilityScaleConfig ui_scale;
    PlayerAccessibilityScaleConfig text_scale;
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
    PlayerAccessibilityConfig accessibility;
};

struct PlayerBootstrapResult {
    PlayerBootstrapConfig config;
    std::vector<std::byte> package_bytes;
    std::vector<PlayerBootstrapDiagnostic> diagnostics;
    [[nodiscard]] bool success() const noexcept { return diagnostics.empty(); }
};

using PlayerBootstrapAssetReader =
    std::function<std::vector<std::byte>(std::string_view asset_path)>;

struct PlayerBootstrapMaterializationResult {
    PlayerBootstrapResult bootstrap;
    std::filesystem::path config_path;
    bool copied = false;
    [[nodiscard]] bool success() const noexcept { return bootstrap.success(); }
};

[[nodiscard]] PlayerBootstrapResult parse_player_config(std::string_view json_text);
[[nodiscard]] PlayerBootstrapResult
load_and_verify_player(const std::filesystem::path& config_path,
                       std::span<const std::string> supported_capabilities = {});
[[nodiscard]] PlayerBootstrapResult
verify_player_config_and_package(std::string_view config_text,
                                 std::span<const std::byte> package_bytes,
                                 std::span<const std::string> supported_capabilities = {});
[[nodiscard]] PlayerBootstrapResult
verify_player_config_and_package_view(std::string_view config_text,
                                      std::span<const std::byte> package_bytes,
                                      std::span<const std::string> supported_capabilities = {});
[[nodiscard]] PlayerBootstrapMaterializationResult
materialize_packaged_player(const std::filesystem::path& bootstrap_root,
                            std::string_view asset_prefix, const PlayerBootstrapAssetReader& reader,
                            std::span<const std::string> supported_capabilities = {});
[[nodiscard]] std::string sha256_hex(std::span<const std::byte> bytes);
[[nodiscard]] bool is_safe_player_relative_path(std::string_view path);
[[nodiscard]] const char* player_bootstrap_error_name(PlayerBootstrapError error) noexcept;

} // namespace noveltea::core
