#include "tooling_native.hpp"

#include "text/text_engine.hpp"

#include <noveltea/text/font.hpp>
#include <noveltea/text/text.hpp>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <mutex>
#include <optional>
#include <set>
#include <string>
#include <string_view>
#include <system_error>
#include <utility>
#include <vector>

#if defined(_WIN32)
#include <windows.h>
#elif defined(__APPLE__)
#include <mach-o/dyld.h>
#include <sys/stat.h>
#else
#include <sys/stat.h>
#endif

namespace {

std::string string_value(const nlohmann::json& object, const char* key)
{
    const auto found = object.find(key);
    return found != object.end() && found->is_string() ? found->get<std::string>() : std::string{};
}

bool bool_value(const nlohmann::json& object, const char* key)
{
    const auto found = object.find(key);
    return found != object.end() && found->is_boolean() && found->get<bool>();
}

nlohmann::json failure(std::string message)
{
    return {{"ok", false},
            {"success", false},
            {"error", std::move(message)},
            {"diagnostics", nlohmann::json::array()}};
}

struct FontCoverageFileSource {
    std::filesystem::path project_root;
    std::filesystem::path system_root;
};

struct FontCoverageFingerprint {
    std::string logical_path;
    std::string source_identity;
    std::uint64_t byte_size = 0;
    std::uint64_t mtime_nanoseconds = 0;
    std::string error;

    bool operator==(const FontCoverageFingerprint&) const = default;
};

struct FontCoverageCacheEntry {
    std::string request;
    std::vector<FontCoverageFingerprint> fingerprints;
    int exit_code = 1;
    std::string response_json;
};

std::mutex font_coverage_cache_mutex;
std::optional<FontCoverageCacheEntry> font_coverage_cache;

std::filesystem::path executable_path()
{
#if defined(_WIN32)
    std::wstring buffer(32768, L'\0');
    const auto length =
        GetModuleFileNameW(nullptr, buffer.data(), static_cast<DWORD>(buffer.size()));
    if (length == 0 || length >= buffer.size())
        return {};
    buffer.resize(length);
    return std::filesystem::path(std::move(buffer));
#elif defined(__APPLE__)
    std::uint32_t size = 0;
    (void)_NSGetExecutablePath(nullptr, &size);
    if (size == 0)
        return {};
    std::string buffer(size, '\0');
    if (_NSGetExecutablePath(buffer.data(), &size) != 0)
        return {};
    return std::filesystem::path(buffer.c_str());
#else
    std::error_code error;
    return std::filesystem::read_symlink("/proc/self/exe", error);
#endif
}

std::filesystem::path default_system_root()
{
    const auto executable = executable_path();
    return executable.empty() ? std::filesystem::path{}
                              : executable.parent_path() / "assets" / "system";
}

bool path_is_within(const std::filesystem::path& root, const std::filesystem::path& candidate)
{
    auto root_it = root.begin();
    auto candidate_it = candidate.begin();
    for (; root_it != root.end(); ++root_it, ++candidate_it) {
        if (candidate_it == candidate.end() || *root_it != *candidate_it)
            return false;
    }
    return true;
}

std::optional<std::filesystem::path> resolve_font_asset_path(const FontCoverageFileSource& source,
                                                             std::string_view logical_path,
                                                             std::string& error_message)
{
    constexpr std::string_view project_prefix = "project:/";
    constexpr std::string_view system_prefix = "system:/";
    const std::filesystem::path* root = nullptr;
    std::string_view relative;
    if (logical_path.starts_with(project_prefix)) {
        root = &source.project_root;
        relative = logical_path.substr(project_prefix.size());
    } else if (logical_path.starts_with(system_prefix)) {
        root = &source.system_root;
        relative = logical_path.substr(system_prefix.size());
    } else {
        error_message = "font path must use project:/ or system:/";
        return std::nullopt;
    }
    std::error_code error;
    const auto canonical_root = std::filesystem::weakly_canonical(*root, error);
    if (error) {
        error_message = "font root could not be resolved";
        return std::nullopt;
    }
    const auto candidate = std::filesystem::weakly_canonical(canonical_root / relative, error);
    if (error || !path_is_within(canonical_root, candidate)) {
        error_message = "font path escapes its mounted root";
        return std::nullopt;
    }
    return candidate;
}

noveltea::text::FontAssetReadResult read_font_asset(const void* context,
                                                    std::string_view logical_path)
{
    const auto* source = static_cast<const FontCoverageFileSource*>(context);
    if (!source)
        return {.bytes = {}, .error = "font coverage has no file source"};

    std::string error_message;
    const auto candidate = resolve_font_asset_path(*source, logical_path, error_message);
    if (!candidate)
        return {.bytes = {}, .error = std::move(error_message)};

    std::ifstream input(*candidate, std::ios::binary);
    if (!input)
        return {.bytes = {}, .error = "font file could not be opened"};
    std::vector<std::uint8_t> bytes((std::istreambuf_iterator<char>(input)), {});
    if (bytes.empty())
        return {.bytes = {}, .error = "font file is empty"};
    return {.bytes = std::move(bytes), .error = {}};
}

FontCoverageFingerprint font_coverage_fingerprint(const FontCoverageFileSource& source,
                                                  std::string logical_path)
{
    FontCoverageFingerprint fingerprint{
        .logical_path = std::move(logical_path),
        .source_identity = {},
        .byte_size = 0,
        .mtime_nanoseconds = 0,
        .error = {},
    };
    std::string error_message;
    const auto candidate = resolve_font_asset_path(source, fingerprint.logical_path, error_message);
    if (!candidate) {
        fingerprint.error = std::move(error_message);
        return fingerprint;
    }
#if defined(_WIN32)
    const auto handle = CreateFileW(candidate->c_str(), FILE_READ_ATTRIBUTES,
                                    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
                                    OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (handle == INVALID_HANDLE_VALUE) {
        fingerprint.error = "font file metadata could not be inspected";
        return fingerprint;
    }
    BY_HANDLE_FILE_INFORMATION info{};
    if (GetFileInformationByHandle(handle, &info) == 0) {
        CloseHandle(handle);
        fingerprint.error = "font file metadata could not be inspected";
        return fingerprint;
    }
    CloseHandle(handle);
    fingerprint.byte_size = (static_cast<std::uint64_t>(info.nFileSizeHigh) << 32U) |
                            static_cast<std::uint64_t>(info.nFileSizeLow);
    ULARGE_INTEGER file_time{};
    file_time.LowPart = info.ftLastWriteTime.dwLowDateTime;
    file_time.HighPart = info.ftLastWriteTime.dwHighDateTime;
    constexpr std::uint64_t unix_epoch_ticks = 116444736000000000ULL;
    if (file_time.QuadPart < unix_epoch_ticks) {
        fingerprint.error = "font file modification time is invalid";
        return fingerprint;
    }
    fingerprint.mtime_nanoseconds = (file_time.QuadPart - unix_epoch_ticks) * 100ULL;
    const auto file_index = (static_cast<std::uint64_t>(info.nFileIndexHigh) << 32U) |
                            static_cast<std::uint64_t>(info.nFileIndexLow);
    fingerprint.source_identity =
        "win:" + std::to_string(static_cast<std::uint64_t>(info.dwVolumeSerialNumber)) + ":" +
        std::to_string(file_index);
#else
    struct stat info {};
    if (::stat(candidate->c_str(), &info) != 0 || !S_ISREG(info.st_mode) || info.st_size < 0) {
        fingerprint.error = "font file metadata could not be inspected";
        return fingerprint;
    }
    fingerprint.byte_size = static_cast<std::uint64_t>(info.st_size);
#if defined(__APPLE__)
    const auto seconds = info.st_mtimespec.tv_sec;
    const auto nanoseconds = info.st_mtimespec.tv_nsec;
#else
    const auto seconds = info.st_mtim.tv_sec;
    const auto nanoseconds = info.st_mtim.tv_nsec;
#endif
    if (seconds < 0 || nanoseconds < 0 || nanoseconds >= 1'000'000'000L) {
        fingerprint.error = "font file modification time is invalid";
        return fingerprint;
    }
    fingerprint.mtime_nanoseconds = static_cast<std::uint64_t>(seconds) * 1'000'000'000ULL +
                                     static_cast<std::uint64_t>(nanoseconds);
    fingerprint.source_identity =
        "posix:" + std::to_string(static_cast<unsigned long long>(info.st_dev)) + ":" +
        std::to_string(static_cast<unsigned long long>(info.st_ino));
#endif
    return fingerprint;
}

std::vector<FontCoverageFingerprint> font_coverage_fingerprints(const nlohmann::json& request)
{
    const auto project_root = string_value(request, "projectRoot");
    const auto configured_system_root = string_value(request, "systemRoot");
    const auto system_root = configured_system_root.empty()
                                 ? default_system_root()
                                 : std::filesystem::path(configured_system_root);
    FontCoverageFileSource source{.project_root = project_root, .system_root = system_root};
    std::set<std::string> logical_paths{std::string(noveltea::kSystemFontAsset)};
    if (const auto locales = request.find("locales"); locales != request.end() && locales->is_array()) {
        for (const auto& locale : *locales) {
            if (!locale.is_object())
                continue;
            if (const auto fonts = locale.find("fonts"); fonts != locale.end() && fonts->is_array())
                for (const auto& font : *fonts)
                    if (font.is_string())
                        logical_paths.insert(font.get<std::string>());
        }
    }
    std::vector<FontCoverageFingerprint> fingerprints;
    fingerprints.reserve(logical_paths.size());
    for (const auto& logical_path : logical_paths)
        fingerprints.push_back(font_coverage_fingerprint(source, logical_path));
    return fingerprints;
}

nlohmann::json validate_font_coverage_request(const nlohmann::json& request)
{
    const auto project_root = string_value(request, "projectRoot");
    const auto configured_system_root = string_value(request, "systemRoot");
    const auto locales = request.find("locales");
    if (project_root.empty() || locales == request.end() || !locales->is_array())
        return failure("Font coverage requires projectRoot and locales.");

    const auto system_root = configured_system_root.empty()
                                 ? default_system_root()
                                 : std::filesystem::path(configured_system_root);
    if (system_root.empty())
        return failure("Font coverage could not resolve the NovelTea system Asset root.");
    FontCoverageFileSource source{.project_root = project_root, .system_root = system_root};
    noveltea::text::TextEngine engine(&read_font_asset, &source);
    if (!engine.valid())
        return failure("Font coverage could not initialize TextEngine.");

    noveltea::FontFamilyDesc system_family;
    system_family.alias = std::string(noveltea::kSystemFontAlias);
    system_family.regular = noveltea::FontDesc{std::string(noveltea::kSystemFontAsset)};
    const auto system_handle = engine.register_font_family(system_family);
    if (!system_handle)
        return failure("Font coverage could not load the safe system fallback font.");
    engine.set_default_font_family(system_handle);

    nlohmann::json diagnostics = nlohmann::json::array();
    for (const auto& locale_request : *locales) {
        if (!locale_request.is_object())
            continue;
        const auto locale = string_value(locale_request, "locale");
        if (locale.empty())
            continue;

        std::vector<std::string> aliases;
        std::vector<std::string> effective_stack;
        if (const auto fonts = locale_request.find("fonts");
            fonts != locale_request.end() && fonts->is_array()) {
            std::size_t index = 0;
            for (const auto& font : *fonts) {
                if (!font.is_string())
                    continue;
                const auto logical_path = font.get<std::string>();
                const auto alias = "coverage-" + locale + "-" + std::to_string(index++);
                noveltea::FontFamilyDesc family;
                family.alias = alias;
                family.regular = noveltea::FontDesc{logical_path};
                effective_stack.push_back(logical_path);
                if (engine.register_font_family(family))
                    aliases.push_back(alias);
            }
        }
        aliases.push_back(std::string(noveltea::kSystemFontAlias));
        effective_stack.push_back(std::string(noveltea::kSystemFontAsset));

        const auto messages = locale_request.find("messages");
        if (messages == locale_request.end() || !messages->is_array())
            continue;
        for (const auto& message : *messages) {
            if (!message.is_object())
                continue;
            const auto message_id = string_value(message, "messageId");
            const auto source_path = string_value(message, "sourcePath");
            const auto text = string_value(message, "text");
            if (text.empty())
                continue;

            noveltea::StyledText styled;
            styled.value = text;
            styled.bounds = {0.0f, 0.0f, 16384.0f, 0.0f};
            styled.language = locale;
            styled.fallback_font_aliases.assign(std::next(aliases.begin()), aliases.end());
            styled.spans.push_back(noveltea::TextSpan{
                .source_byte_begin = 0,
                .source_byte_end = static_cast<std::uint32_t>(styled.value.size()),
                .font_alias = aliases.front(),
                .size = 24.0f,
            });
            const noveltea::text::TextCoverageContext coverage_context{
                .locale = locale,
                .message_id = message_id,
                .source_path = source_path,
                .effective_font_stack = effective_stack,
            };
            for (const auto& diagnostic : engine.coverage_diagnostics(styled, coverage_context)) {
                diagnostics.push_back(nlohmann::json::object({
                    {"code", "localization.font_coverage"},
                    {"severity", bool_value(locale_request, "supported") ? "error" : "warning"},
                    {"path", source_path},
                    {"messageId", message_id},
                    {"locale", locale},
                    {"cluster", diagnostic.gap.text},
                    {"fontStack", diagnostic.context.effective_font_stack},
                    {"message", "Locale '" + locale + "' cannot shape cluster '" +
                                    diagnostic.gap.text + "' with its effective font stack."},
                }));
            }
        }
    }
    return {
        {"ok", true}, {"success", diagnostics.empty()}, {"diagnostics", std::move(diagnostics)}};
}

} // namespace

namespace noveltea::tooling {

NativeOperationResult validate_font_coverage(std::string_view request_json)
{
    const auto request = request_json.empty() ? nlohmann::json::object()
                                              : nlohmann::json::parse(request_json, nullptr, false);
    if (request.is_discarded() || !request.is_object())
        return {.exit_code = 1,
                .response_json = failure("Malformed font coverage request JSON.").dump()};
    const auto canonical_request = request.dump();
    auto fingerprints = font_coverage_fingerprints(request);
    const bool exact_fingerprints = std::all_of(
        fingerprints.begin(), fingerprints.end(), [](const auto& fingerprint) {
            return fingerprint.error.empty() && !fingerprint.source_identity.empty();
        });
    if (exact_fingerprints) {
        std::scoped_lock lock(font_coverage_cache_mutex);
        if (font_coverage_cache && font_coverage_cache->request == canonical_request &&
            font_coverage_cache->fingerprints == fingerprints)
            return {.exit_code = font_coverage_cache->exit_code,
                    .response_json = font_coverage_cache->response_json};
    }

    auto response = validate_font_coverage_request(request);
    NativeOperationResult result{.exit_code = response.value("ok", false) ? 0 : 1,
                                 .response_json = response.dump()};
    if (exact_fingerprints) {
        std::scoped_lock lock(font_coverage_cache_mutex);
        font_coverage_cache = FontCoverageCacheEntry{
            .request = canonical_request,
            .fingerprints = std::move(fingerprints),
            .exit_code = result.exit_code,
            .response_json = result.response_json,
        };
    }
    return result;
}

} // namespace noveltea::tooling
