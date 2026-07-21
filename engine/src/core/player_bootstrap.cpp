#include <noveltea/core/player_bootstrap.hpp>
#include <noveltea/core/compiled_project.hpp>
#include <noveltea/core/json_access.hpp>

#include <algorithm>
#include <array>
#include <fstream>
#include <iterator>
#include <chrono>
#include <cmath>
#include <set>

#include <nlohmann/json.hpp>

#define MINIZ_NO_ZLIB_APIS
#if __has_include(<miniz/miniz.h>)
#include <miniz/miniz.h>
#else
#include <miniz.h>
#endif

namespace noveltea::core {
namespace {

using json = nlohmann::json;
constexpr std::array<std::string_view, 10> known_capabilities = {
    "network.client", "external-url", "clipboard.read", "clipboard.write",   "gamepad",
    "vibration",      "microphone",   "notifications",  "custom-url-scheme", "billing"};

void fail(PlayerBootstrapResult& result, PlayerBootstrapError category, std::string path,
          std::string message)
{
    result.diagnostics.push_back({category, std::move(path), std::move(message)});
}

bool exact_keys(const json& value, std::initializer_list<std::string_view> required,
                std::initializer_list<std::string_view> optional, PlayerBootstrapResult& result,
                std::string_view path)
{
    if (!value.is_object()) {
        fail(result, PlayerBootstrapError::ConfigParse, std::string(path), "expected object");
        return false;
    }
    std::set<std::string> allowed;
    for (auto key : required)
        allowed.emplace(key);
    for (auto key : optional)
        allowed.emplace(key);
    bool ok = true;
    for (auto key : required) {
        if (!value.contains(std::string(key))) {
            fail(result, PlayerBootstrapError::ConfigParse,
                 std::string(path) + "/" + std::string(key), "missing required field");
            ok = false;
        }
    }
    for (const auto& [key, unused] : value.items()) {
        if (!allowed.contains(key)) {
            fail(result, PlayerBootstrapError::ConfigParse, std::string(path) + "/" + key,
                 "unknown field");
            ok = false;
        }
    }
    return ok;
}

std::vector<std::byte> read_file(const std::filesystem::path& path)
{
    std::ifstream file(path, std::ios::binary);
    if (!file)
        return {};
    std::vector<std::byte> result;
    for (char value; file.get(value);)
        result.push_back(static_cast<std::byte>(static_cast<unsigned char>(value)));
    return result;
}

constexpr std::array<std::uint32_t, 64> sha_k = {
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2};
std::uint32_t rotr(std::uint32_t v, unsigned n) { return (v >> n) | (v << (32 - n)); }

bool verify_manifest(std::span<const std::byte> bytes, PlayerBootstrapResult& result)
{
    mz_zip_archive archive{};
    if (!mz_zip_reader_init_mem(&archive, bytes.data(), bytes.size(), 0)) {
        fail(result, PlayerBootstrapError::PackageContent, "/package",
             "package is not a valid ZIP archive");
        return false;
    }
    const int index = mz_zip_reader_locate_file(&archive, "manifest.json", nullptr, 0);
    if (index < 0) {
        mz_zip_reader_end(&archive);
        fail(result, PlayerBootstrapError::PackageContent, "/package/manifest.json",
             "package manifest is missing");
        return false;
    }
    size_t size = 0;
    void* data = mz_zip_reader_extract_to_heap(&archive, static_cast<mz_uint>(index), &size, 0);
    mz_zip_reader_end(&archive);
    if (!data) {
        fail(result, PlayerBootstrapError::PackageContent, "/package/manifest.json",
             "package manifest cannot be read");
        return false;
    }
    json manifest = json::parse(static_cast<const char*>(data),
                                static_cast<const char*>(data) + size, nullptr, false);
    mz_free(data);
    if (!manifest.is_object() ||
        json_access::value_or(manifest, "format", std::string()) != "noveltea.runtime-package" ||
        json_access::value_or(manifest, "format_version", 0) != 2) {
        fail(result, PlayerBootstrapError::PackageContent, "/package/manifest.json",
             "unsupported runtime package manifest");
        return false;
    }
    return true;
}

} // namespace

bool is_safe_player_relative_path(std::string_view path)
{
    if (path.empty() || path.front() == '/' || path.find('\\') != path.npos ||
        path.find(':') != path.npos)
        return false;
    std::size_t begin = 0;
    while (begin <= path.size()) {
        const auto end = path.find('/', begin);
        const auto part = path.substr(begin, end == path.npos ? path.size() - begin : end - begin);
        if (part.empty() || part == "." || part == "..")
            return false;
        if (end == path.npos)
            break;
        begin = end + 1;
    }
    return true;
}

std::string sha256_hex(std::span<const std::byte> input)
{
    std::vector<std::uint8_t> data;
    data.reserve(input.size() + 72);
    for (auto byte : input)
        data.push_back(std::to_integer<std::uint8_t>(byte));
    const std::uint64_t bit_size = static_cast<std::uint64_t>(data.size()) * 8;
    data.push_back(0x80);
    while (data.size() % 64 != 56)
        data.push_back(0);
    for (int shift = 56; shift >= 0; shift -= 8)
        data.push_back(static_cast<std::uint8_t>(bit_size >> shift));
    std::array<std::uint32_t, 8> h = {0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
                                      0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19};
    for (std::size_t offset = 0; offset < data.size(); offset += 64) {
        std::array<std::uint32_t, 64> w{};
        for (int i = 0; i < 16; ++i) {
            const auto p = offset + static_cast<std::size_t>(i) * 4;
            w[i] = (std::uint32_t(data[p]) << 24) | (std::uint32_t(data[p + 1]) << 16) |
                   (std::uint32_t(data[p + 2]) << 8) | data[p + 3];
        }
        for (int i = 16; i < 64; ++i) {
            const auto s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >> 3);
            const auto s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16] + s0 + w[i - 7] + s1;
        }
        auto [a, b, c, d, e, f, g, hh] = h;
        for (int i = 0; i < 64; ++i) {
            const auto s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
            const auto ch = (e & f) ^ (~e & g);
            const auto t1 = hh + s1 + ch + sha_k[i] + w[i];
            const auto s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
            const auto maj = (a & b) ^ (a & c) ^ (b & c);
            const auto t2 = s0 + maj;
            hh = g;
            g = f;
            f = e;
            e = d + t1;
            d = c;
            c = b;
            b = a;
            a = t1 + t2;
        }
        h[0] += a;
        h[1] += b;
        h[2] += c;
        h[3] += d;
        h[4] += e;
        h[5] += f;
        h[6] += g;
        h[7] += hh;
    }
    constexpr char hex[] = "0123456789abcdef";
    std::string out;
    out.reserve(64);
    for (auto word : h)
        for (int shift = 28; shift >= 0; shift -= 4)
            out.push_back(hex[(word >> shift) & 15]);
    return out;
}

PlayerBootstrapResult parse_player_config(std::string_view text)
{
    PlayerBootstrapResult result;
    auto root = json::parse(text.begin(), text.end(), nullptr, false);
    if (!exact_keys(root,
                    {"format", "formatVersion", "displayName", "applicationId", "saveNamespace",
                     "versionName", "package", "capabilities", "display", "accessibility"},
                    {"defaultLocale"}, result, ""))
        return result;
    const auto format = root.find("format");
    const auto format_version = root.find("formatVersion");
    const auto display_name = root.find("displayName");
    const auto application_id = root.find("applicationId");
    const auto save_namespace = root.find("saveNamespace");
    const auto version_name = root.find("versionName");
    const auto package_it = root.find("package");
    const auto display_it = root.find("display");
    const auto accessibility_it = root.find("accessibility");
    const auto capabilities = root.find("capabilities");
    if (format == root.end() || !format->is_string() || format_version == root.end() ||
        !format_version->is_number_integer() || display_name == root.end() ||
        !display_name->is_string() || application_id == root.end() ||
        !application_id->is_string() || save_namespace == root.end() ||
        !save_namespace->is_string() || version_name == root.end() || !version_name->is_string() ||
        package_it == root.end() || !package_it->is_object() || display_it == root.end() ||
        !display_it->is_object() || accessibility_it == root.end() ||
        !accessibility_it->is_object() || capabilities == root.end() || !capabilities->is_array()) {
        fail(result, PlayerBootstrapError::ConfigParse, "",
             "player config fields have invalid types");
        return result;
    }
    if (*format != "noveltea.player-config" ||
        format_version->get<std::int64_t>() != player_config_format_version) {
        fail(result, PlayerBootstrapError::ConfigParse, "/formatVersion",
             "unsupported player config format");
        return result;
    }
    auto& config = result.config;
    config.display_name = display_name->get<std::string>();
    config.application_id = application_id->get<std::string>();
    config.save_namespace = save_namespace->get<std::string>();
    config.version_name = version_name->get<std::string>();
    if (const auto locale = root.find("defaultLocale"); locale != root.end()) {
        if (!locale->is_string()) {
            fail(result, PlayerBootstrapError::ConfigParse, "/defaultLocale", "expected string");
            return result;
        }
        config.default_locale = locale->get<std::string>();
    }
    const auto& package = *package_it;
    if (!exact_keys(package, {"path", "sha256", "runtimePackageApi"}, {}, result, "/package"))
        return result;
    const auto package_path = package.find("path");
    const auto package_sha = package.find("sha256");
    const auto package_api = package.find("runtimePackageApi");
    if (!package_path->is_string() || !package_sha->is_string() ||
        !package_api->is_number_unsigned()) {
        fail(result, PlayerBootstrapError::ConfigParse, "/package",
             "package fields have invalid types");
        return result;
    }
    config.package_path = package_path->get<std::string>();
    config.package_sha256 = package_sha->get<std::string>();
    config.runtime_package_api = package_api->get<std::uint32_t>();
    const auto& display = *display_it;
    if (!exact_keys(display, {"referenceResolution", "worldRasterPolicy", "barColor"}, {}, result,
                    "/display"))
        return result;
    const auto resolution = display.find("referenceResolution");
    const auto raster_policy = display.find("worldRasterPolicy");
    const auto bar_color = display.find("barColor");
    if (resolution == display.end() || !resolution->is_object() || raster_policy == display.end() ||
        !raster_policy->is_string() || bar_color == display.end() || !bar_color->is_string() ||
        !exact_keys(*resolution, {"width", "height"}, {}, result, "/display/referenceResolution"))
        return result;
    const auto width = resolution->find("width");
    const auto height = resolution->find("height");
    if (!width->is_number_unsigned() || !height->is_number_unsigned()) {
        fail(result, PlayerBootstrapError::ConfigParse, "/display/referenceResolution",
             "expected unsigned dimensions");
        return result;
    }
    config.display.reference_width = width->get<std::uint32_t>();
    config.display.reference_height = height->get<std::uint32_t>();
    config.display.world_raster_policy = raster_policy->get<std::string>();
    config.display.bar_color = bar_color->get<std::string>();
    const auto& accessibility = *accessibility_it;
    if (!exact_keys(accessibility, {"uiScale", "textScale"}, {}, result, "/accessibility"))
        return result;
    const auto parse_scale_policy = [&](std::string_view name,
                                        PlayerAccessibilityScaleConfig& policy) -> bool {
        const auto policy_it = accessibility.find(name);
        const std::string path = "/accessibility/" + std::string(name);
        if (policy_it == accessibility.end() || !policy_it->is_object() ||
            !exact_keys(*policy_it, {"enabled", "minimum", "maximum"}, {}, result, path))
            return false;
        const auto enabled = policy_it->find("enabled");
        const auto minimum = policy_it->find("minimum");
        const auto maximum = policy_it->find("maximum");
        if (!enabled->is_boolean() || !minimum->is_number() || !maximum->is_number()) {
            fail(result, PlayerBootstrapError::ConfigParse, path,
                 "accessibility policy fields have invalid types");
            return false;
        }
        policy.enabled = enabled->get<bool>();
        policy.minimum = minimum->get<double>();
        policy.maximum = maximum->get<double>();
        if (!std::isfinite(policy.minimum) || !std::isfinite(policy.maximum) ||
            policy.minimum <= 0.0 || policy.maximum <= 0.0 || policy.minimum > policy.maximum ||
            (policy.enabled && (policy.minimum > 1.0 || policy.maximum < 1.0))) {
            fail(result, PlayerBootstrapError::ConfigParse, path,
                 "invalid accessibility scale range");
            return false;
        }
        return true;
    };
    if (!parse_scale_policy("uiScale", config.accessibility.ui_scale) ||
        !parse_scale_policy("textScale", config.accessibility.text_scale))
        return result;
    for (const auto& capability : *capabilities) {
        if (!capability.is_string()) {
            fail(result, PlayerBootstrapError::ConfigParse, "/capabilities",
                 "expected string entries");
            return result;
        }
        config.capabilities.push_back(json_access::get_or<std::string>(capability, {}));
    }
    if (config.display_name.empty() || config.application_id.empty() ||
        config.save_namespace.empty() || config.version_name.empty())
        fail(result, PlayerBootstrapError::ConfigParse, "", "identity strings must not be empty");
    if (!is_safe_player_relative_path(config.package_path.generic_string()))
        fail(result, PlayerBootstrapError::ConfigParse, "/package/path",
             "package path must be normalized and relative");
    if (config.package_sha256.size() != 64 ||
        !std::all_of(config.package_sha256.begin(), config.package_sha256.end(),
                     [](char c) { return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'); }))
        fail(result, PlayerBootstrapError::ConfigParse, "/package/sha256",
             "SHA-256 must be 64 lowercase hexadecimal characters");
    if (config.display.reference_width == 0 || config.display.reference_height == 0 ||
        config.display.reference_width > compiled::max_reference_resolution_dimension ||
        config.display.reference_height > compiled::max_reference_resolution_dimension ||
        (config.display.world_raster_policy != "capped" &&
         config.display.world_raster_policy != "native"))
        fail(result, PlayerBootstrapError::ConfigParse, "/display", "invalid display metadata");
    std::set<std::string> unique;
    for (const auto& capability : config.capabilities) {
        if (std::find(known_capabilities.begin(), known_capabilities.end(), capability) ==
            known_capabilities.end())
            fail(result, PlayerBootstrapError::Capability, "/capabilities",
                 "unknown capability: " + capability);
        if (!unique.insert(capability).second)
            fail(result, PlayerBootstrapError::Capability, "/capabilities",
                 "duplicate capability: " + capability);
    }
    return result;
}

PlayerBootstrapResult load_and_verify_player(const std::filesystem::path& config_path,
                                             std::span<const std::string> supported)
{
    std::ifstream config_file(config_path, std::ios::binary);
    if (!config_file) {
        PlayerBootstrapResult result;
        fail(result, PlayerBootstrapError::ConfigDiscovery, config_path.string(),
             "player config was not found");
        return result;
    }
    std::string text{std::istreambuf_iterator<char>(config_file), std::istreambuf_iterator<char>()};
    auto parsed = parse_player_config(text);
    if (!parsed.success())
        return parsed;
    const auto package_path = config_path.parent_path() / parsed.config.package_path;
    const auto package_bytes = read_file(package_path);
    auto result = verify_player_config_and_package(text, package_bytes, supported);
    if (package_bytes.empty() && result.diagnostics.empty())
        fail(result, PlayerBootstrapError::PackageDiscovery, package_path.string(),
             "game package was not found or is empty");
    for (auto& diagnostic : result.diagnostics)
        if (diagnostic.path == "/package")
            diagnostic.path = package_path.string();
    return result;
}

PlayerBootstrapResult verify_player_config_and_package(std::string_view text,
                                                       std::span<const std::byte> package_bytes,
                                                       std::span<const std::string> supported)
{
    auto result = parse_player_config(text);
    if (!result.success())
        return result;
    if (result.config.runtime_package_api != runtime_package_api_version)
        fail(result, PlayerBootstrapError::PackageApi, "/package/runtimePackageApi",
             "unsupported runtime package API");
    for (const auto& capability : result.config.capabilities) {
        if (std::find(supported.begin(), supported.end(), capability) == supported.end())
            fail(result, PlayerBootstrapError::Capability, "/capabilities",
                 "player template does not support: " + capability);
    }
    if (!result.success())
        return result;
    result.package_bytes.assign(package_bytes.begin(), package_bytes.end());
    if (result.package_bytes.empty()) {
        fail(result, PlayerBootstrapError::PackageDiscovery, "/package",
             "game package was not found or is empty");
        return result;
    }
    if (sha256_hex(result.package_bytes) != result.config.package_sha256) {
        fail(result, PlayerBootstrapError::PackageChecksum, "/package",
             "game package checksum does not match player config");
        return result;
    }
    verify_manifest(result.package_bytes, result);
    return result;
}

PlayerBootstrapMaterializationResult
materialize_packaged_player(const std::filesystem::path& bootstrap_root,
                            std::string_view asset_prefix, const PlayerBootstrapAssetReader& reader,
                            std::span<const std::string> supported)
{
    PlayerBootstrapMaterializationResult output;
    auto prefix = std::string(asset_prefix);
    if (!prefix.empty() && prefix.back() != '/')
        prefix.push_back('/');
    const auto config_bytes = reader(prefix + "player.json");
    if (config_bytes.empty()) {
        fail(output.bootstrap, PlayerBootstrapError::ConfigDiscovery, prefix + "player.json",
             "packaged player config was not found or is empty");
        return output;
    }
    const std::string config_text(reinterpret_cast<const char*>(config_bytes.data()),
                                  config_bytes.size());
    auto parsed = parse_player_config(config_text);
    if (!parsed.success()) {
        output.bootstrap = std::move(parsed);
        return output;
    }
    const auto package_asset = prefix + parsed.config.package_path.generic_string();
    const auto package_bytes = reader(package_asset);
    output.bootstrap = verify_player_config_and_package(config_text, package_bytes, supported);
    if (!output.bootstrap.success())
        return output;

    const auto final_root = bootstrap_root / output.bootstrap.config.package_sha256;
    const auto final_config = final_root / "player.json";
    std::error_code final_config_error;
    if (std::filesystem::is_regular_file(final_config, final_config_error) && !final_config_error) {
        auto existing = load_and_verify_player(final_config, supported);
        if (existing.success()) {
            output.bootstrap = std::move(existing);
            output.config_path = final_config;
            return output;
        }
        std::error_code discard_error;
        std::filesystem::remove_all(final_root, discard_error);
    }

    std::error_code error;
    std::filesystem::create_directories(bootstrap_root, error);
    const auto nonce = std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());
    const auto temporary_root = bootstrap_root / (".incoming-" + nonce);
    std::filesystem::remove_all(temporary_root, error);
    error.clear();
    std::filesystem::create_directories(temporary_root, error);
    if (!error) {
        std::ofstream config_file(temporary_root / "player.json", std::ios::binary);
        config_file.write(config_text.data(), static_cast<std::streamsize>(config_text.size()));
        std::ofstream package_file(temporary_root / output.bootstrap.config.package_path,
                                   std::ios::binary);
        package_file.write(reinterpret_cast<const char*>(package_bytes.data()),
                           static_cast<std::streamsize>(package_bytes.size()));
        if (!config_file || !package_file)
            error = std::make_error_code(std::errc::io_error);
    }
    if (!error) {
        auto staged = load_and_verify_player(temporary_root / "player.json", supported);
        if (!staged.success()) {
            output.bootstrap = std::move(staged);
            error = std::make_error_code(std::errc::invalid_argument);
        }
    }
    if (!error) {
        std::filesystem::rename(temporary_root, final_root, error);
        std::error_code final_root_error;
        if (error && std::filesystem::is_directory(final_root, final_root_error) &&
            !final_root_error) {
            error.clear();
            std::filesystem::remove_all(temporary_root, error);
            error.clear();
        }
    }
    if (error) {
        std::filesystem::remove_all(temporary_root, error);
        if (output.bootstrap.diagnostics.empty())
            fail(output.bootstrap, PlayerBootstrapError::Materialization, bootstrap_root.string(),
                 "could not atomically materialize the packaged game");
        return output;
    }
    output.config_path = final_config;
    output.copied = true;
    for (const auto& entry : std::filesystem::directory_iterator(bootstrap_root, error)) {
        if (error)
            break;
        std::error_code entry_error;
        const bool is_directory = entry.is_directory(entry_error);
        if (!entry_error && is_directory && entry.path() != final_root &&
            !entry.path().filename().string().starts_with(".incoming-"))
            std::filesystem::remove_all(entry.path(), error);
    }
    output.bootstrap = load_and_verify_player(final_config, supported);
    return output;
}

const char* player_bootstrap_error_name(PlayerBootstrapError error) noexcept
{
    switch (error) {
    case PlayerBootstrapError::ConfigDiscovery:
        return "config-discovery";
    case PlayerBootstrapError::ConfigParse:
        return "config-parse";
    case PlayerBootstrapError::PackageDiscovery:
        return "package-discovery";
    case PlayerBootstrapError::PackageChecksum:
        return "package-checksum";
    case PlayerBootstrapError::PackageApi:
        return "package-api";
    case PlayerBootstrapError::Capability:
        return "capability";
    case PlayerBootstrapError::PackageContent:
        return "package-content";
    case PlayerBootstrapError::WritableRoot:
        return "writable-root";
    case PlayerBootstrapError::Materialization:
        return "materialization";
    }
    return "unknown";
}

} // namespace noveltea::core
