#include "tooling_native.hpp"

#include "text/text_engine.hpp"

#include <noveltea/text/font.hpp>
#include <noveltea/text/text.hpp>
#include <noveltea/core/fingerprint.hpp>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <cerrno>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <map>
#include <mutex>
#include <tuple>
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
    std::string exact_content_revision;

    bool operator==(const FontCoverageFingerprint& other) const
    {
        // The same bytes under the same logical font binding shape identically,
        // even after a metadata-only touch or a same-content atomic replace.
        // Metadata is inspected for physical admission, not cache identity.
        return logical_path == other.logical_path &&
               exact_content_revision == other.exact_content_revision && error == other.error;
    }

    bool same_physical_capture(const FontCoverageFingerprint& other) const
    {
        // Cache eligibility compares content. A mid-execution race instead
        // needs the stronger original metadata + content proof, even if a
        // different file happened to contain identical bytes at the end.
        return *this == other && source_identity == other.source_identity &&
               byte_size == other.byte_size &&
               mtime_nanoseconds == other.mtime_nanoseconds;
    }
};

struct FontCoverageCacheEntry {
    std::string request;
    std::vector<FontCoverageFingerprint> fingerprints;
    int exit_code = 1;
    std::string response_json;
};

std::mutex font_coverage_cache_mutex;
// Bounded per-locale entries, not one union of all glyphs requested so far.
// An independently edited locale cannot evict another locale's result.
std::vector<FontCoverageCacheEntry> font_coverage_cache;
std::vector<FontCoverageCacheEntry> font_coverage_failures;

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
        .exact_content_revision = {},
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
        const auto code = GetLastError();
        if (code == ERROR_FILE_NOT_FOUND || code == ERROR_PATH_NOT_FOUND) {
            fingerprint.source_identity = "absent";
            fingerprint.exact_content_revision = "absent";
            return fingerprint;
        }
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
    if (::stat(candidate->c_str(), &info) != 0) {
        if (errno == ENOENT) {
            fingerprint.source_identity = "absent";
            fingerprint.exact_content_revision = "absent";
            return fingerprint;
        }
        fingerprint.error = "font file metadata could not be inspected";
        return fingerprint;
    }
    if (!S_ISREG(info.st_mode) || info.st_size < 0) {
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
    // Metadata is an inexpensive hint, never proof of unchanged font bytes.
    // In particular a same-size replacement with restored mtime must revoke
    // both cached missing glyphs and cached successful coverage.
    std::ifstream input(*candidate, std::ios::binary);
    if (!input) {
        fingerprint.error = "font source could not be opened for content verification";
        return fingerprint;
    }
    const std::string bytes{std::istreambuf_iterator<char>{input},
                            std::istreambuf_iterator<char>{}};
    if (input.bad() || bytes.size() != fingerprint.byte_size) {
        fingerprint.error = "font source changed during content verification";
        return fingerprint;
    }
    fingerprint.exact_content_revision = noveltea::core::xxh3_128_revision(bytes);
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
        return failure("Font coverage could not load the safe system fallback font '" +
                       std::string(noveltea::kSystemFontAsset) + "' from system root '" +
                       system_root.string() + "'. Check that the system font assets are available.");
    engine.set_default_font_family(system_handle);

    nlohmann::json diagnostics = nlohmann::json::array();
    // Different locales frequently share the same font stack. A family only
    // depends on its font source, not the locale requesting it; reuse the
    // loaded FreeType/HarfBuzz faces within this coverage request.
    std::map<std::string, std::optional<std::string>> shared_font_aliases;
    using CoverageKey = std::tuple<std::string, std::vector<std::string>, std::string>;
    std::map<CoverageKey, std::vector<noveltea::text::TextCoverageGap>> shaped_text_cache;
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
            for (const auto& font : *fonts) {
                if (!font.is_string())
                    continue;
                const auto logical_path = font.get<std::string>();
                effective_stack.push_back(logical_path);
                auto cached = shared_font_aliases.find(logical_path);
                if (cached == shared_font_aliases.end()) {
                    const auto alias =
                        "coverage-shared-" + std::to_string(shared_font_aliases.size());
                    noveltea::FontFamilyDesc family;
                    family.alias = alias;
                    family.regular = noveltea::FontDesc{logical_path};
                    const bool loaded = static_cast<bool>(engine.register_font_family(family));
                    cached = shared_font_aliases
                                 .emplace(logical_path,
                                          loaded ? std::optional<std::string>{alias} : std::nullopt)
                                 .first;
                }
                if (cached->second)
                    aliases.push_back(*cached->second);
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
            const CoverageKey coverage_key{locale, effective_stack, text};
            auto shaped = shaped_text_cache.find(coverage_key);
            if (shaped == shaped_text_cache.end())
                shaped = shaped_text_cache.emplace(coverage_key, engine.unresolved_clusters(styled))
                             .first;
            for (const auto& gap : shaped->second) {
                diagnostics.push_back(nlohmann::json::object({
                    {"code", "localization.font_coverage"},
                    {"severity", bool_value(locale_request, "supported") ? "error" : "warning"},
                    {"path", source_path},
                    {"messageId", message_id},
                    {"locale", locale},
                    {"cluster", gap.text},
                    {"fontStack", coverage_context.effective_font_stack},
                    {"message", "Locale '" + locale + "' cannot shape cluster '" + gap.text +
                                    "' with its effective font stack."},
                }));
            }
        }
    }
    return {
        {"ok", true}, {"success", diagnostics.empty()}, {"diagnostics", std::move(diagnostics)}};
}

} // namespace

namespace noveltea::tooling {

std::string font_coverage_ledger()
{
    std::lock_guard lock(font_coverage_cache_mutex);
    nlohmann::json result = nlohmann::json::array();
    for (const auto* entries : {&font_coverage_cache, &font_coverage_failures})
        for (const auto& entry : *entries) {
            nlohmann::json fingerprints = nlohmann::json::array();
            for (const auto& fingerprint : entry.fingerprints)
                fingerprints.push_back({{"path", fingerprint.logical_path},
                                        {"revision", fingerprint.exact_content_revision},
                                        {"error", fingerprint.error}});
            result.push_back({{"request", entry.request}, {"fingerprints", fingerprints},
                              {"exitCode", entry.exit_code}, {"response", entry.response_json},
                              {"failure", entries == &font_coverage_failures}});
        }
    return result.dump();
}

bool restore_font_coverage_ledger(std::string_view snapshot)
{
    try {
        const auto value = nlohmann::json::parse(snapshot);
        if (!value.is_array() || value.size() > 72)
            return false;
        std::vector<FontCoverageCacheEntry> successes, failures;
        for (const auto& item : value) {
            if (!item.is_object() || item.size() != 5 || !item.at("request").is_string() ||
                !item.at("fingerprints").is_array() || !item.at("exitCode").is_number_integer() ||
                !item.at("response").is_string() || !item.at("failure").is_boolean())
                return false;
            FontCoverageCacheEntry entry;
            entry.request = item.at("request").get<std::string>();
            entry.exit_code = item.at("exitCode").get<int>();
            entry.response_json = item.at("response").get<std::string>();
            const auto response = nlohmann::json::parse(entry.response_json);
            const bool failure = item.at("failure").get<bool>();
            const auto& diagnostics = failure ? response.at("diagnostics") : response;
            if ((failure && (!response.is_object() || !response.at("ok").is_boolean() ||
                             entry.exit_code == 0)) ||
                (!failure && entry.exit_code != 0) || !diagnostics.is_array() ||
                diagnostics.size() > 10000)
                return false;
            for (const auto& diagnostic : diagnostics) {
                if (!diagnostic.is_object() ||
                    !diagnostic.value("code", nlohmann::json()).is_string() ||
                    !diagnostic.value("severity", nlohmann::json()).is_string() ||
                    !diagnostic.value("message", nlohmann::json()).is_string() ||
                    !diagnostic.value("path", nlohmann::json()).is_string())
                    return false;
            }
            for (const auto& fingerprint : item.at("fingerprints")) {
                if (!fingerprint.is_object() || fingerprint.size() != 3 ||
                    !fingerprint.at("path").is_string() || !fingerprint.at("revision").is_string() ||
                    !fingerprint.at("error").is_string())
                    return false;
                FontCoverageFingerprint restored;
                restored.logical_path = fingerprint.at("path").get<std::string>();
                restored.exact_content_revision = fingerprint.at("revision").get<std::string>();
                restored.error = fingerprint.at("error").get<std::string>();
                entry.fingerprints.push_back(std::move(restored));
            }
            (item.at("failure").get<bool>() ? failures : successes).push_back(std::move(entry));
        }
        std::lock_guard lock(font_coverage_cache_mutex);
        font_coverage_cache = std::move(successes);
        font_coverage_failures = std::move(failures);
        return true;
    } catch (...) {
        return false;
    }
}

NativeOperationResult validate_font_coverage(std::string_view request_json)
{
    const auto request = request_json.empty() ? nlohmann::json::object()
                                              : nlohmann::json::parse(request_json, nullptr, false);
    if (request.is_discarded() || !request.is_object())
        return {.exit_code = 1,
                .response_json = failure("Malformed font coverage request JSON.").dump()};
    if (!request.contains("locales") || !request.at("locales").is_array() ||
        request.at("locales").empty()) {
        auto response = validate_font_coverage_request(request);
        return {.exit_code = response.value("ok", false) ? 0 : 1,
                .response_json = response.dump()};
    }
    struct LocaleResult {
        std::string key;
        std::vector<FontCoverageFingerprint> fingerprints;
        nlohmann::json diagnostics = nlohmann::json::array();
        bool retained = false;
        bool eligible = false;
    };
    std::vector<LocaleResult> results;
    results.reserve(request.at("locales").size());
    auto misses = nlohmann::json::array();
    std::set<std::string> locales;
    bool duplicate_locale = false;
    for (const auto& locale : request.at("locales")) {
        if (!locale.is_object() || string_value(locale, "locale").empty()) {
            auto response = validate_font_coverage_request(request);
            return {.exit_code = response.value("ok", false) ? 0 : 1,
                    .response_json = response.dump()};
        }
        duplicate_locale |= !locales.insert(string_value(locale, "locale")).second;
    }
    if (duplicate_locale) {
        auto response = validate_font_coverage_request(request);
        return {.exit_code = response.value("ok", false) ? 0 : 1,
                .response_json = response.dump()};
    }
    // Unlike a transient read failure, an absent fallback font is a stable
    // physical fact until the next exact path check observes its creation.
    const auto whole_fonts = font_coverage_fingerprints(request);
    const bool whole_proven = std::all_of(
        whole_fonts.begin(), whole_fonts.end(), [](const auto& value) {
            return value.error.empty() && !value.source_identity.empty() &&
                   !value.exact_content_revision.empty();
        });
    if (whole_proven) {
        std::scoped_lock lock(font_coverage_cache_mutex);
        if (!font_coverage_failures.empty()) {
            const auto whole_key = request.dump();
            for (const auto& cached : font_coverage_failures)
                if (cached.request == whole_key && cached.fingerprints == whole_fonts) {
                    auto response = nlohmann::json::parse(cached.response_json);
                    response["work"] = {{"executedLocales", 0},
                                        {"reusedLocales", request.at("locales").size()}};
                    return {.exit_code = cached.exit_code, .response_json = response.dump()};
                }
        }
    }
    auto request_header = nlohmann::json::object();
    for (auto field = request.begin(); field != request.end(); ++field)
        if (field.key() != "locales")
            request_header[field.key()] = field.value();
    for (const auto& locale : request.at("locales")) {
        auto single = request_header;
        single["locales"] = nlohmann::json::array({locale});
        LocaleResult item;
        item.key = single.dump();
        // Proof all distinct font sources once for the complete request,
        // then select only those each locale consumes. Do not repeatedly
        // hash and canonicalize the same system fallback for every locale.
        std::set<std::string> sources{std::string(noveltea::kSystemFontAsset)};
        if (locale.contains("fonts") && locale.at("fonts").is_array())
            for (const auto& font : locale.at("fonts"))
                if (font.is_string())
                    sources.insert(font.get<std::string>());
        for (const auto& source : whole_fonts)
            if (sources.contains(source.logical_path))
                item.fingerprints.push_back(source);
        item.eligible = std::all_of(item.fingerprints.begin(), item.fingerprints.end(),
                                    [](const auto& font) {
                                        return font.error.empty() && !font.source_identity.empty() &&
                                               !font.exact_content_revision.empty();
                                    });
        if (item.eligible) {
            std::scoped_lock lock(font_coverage_cache_mutex);
            for (const auto& cached : font_coverage_cache)
                if (cached.request == item.key && cached.fingerprints == item.fingerprints) {
                    item.diagnostics = nlohmann::json::parse(cached.response_json);
                    item.retained = true;
                    break;
                }
        }
        if (!item.retained)
            misses.push_back(locale);
        results.push_back(std::move(item));
    }
    const auto executed = misses.size();
    if (!misses.empty()) {
        auto missing_request = request_header;
        missing_request["locales"] = misses;
        const auto fresh = validate_font_coverage_request(missing_request);
        if (!fresh.value("ok", false)) {
            auto response = fresh;
            response["work"] = {{"executedLocales", executed},
                                {"reusedLocales", request.at("locales").size() - executed}};
            if (whole_proven &&
                fresh.value("error", std::string{}).starts_with(
                    "Font coverage could not load the safe system fallback font") &&
                font_coverage_fingerprints(request) == whole_fonts) {
                std::scoped_lock lock(font_coverage_cache_mutex);
                if (font_coverage_failures.size() == 8)
                    font_coverage_failures.erase(font_coverage_failures.begin());
                font_coverage_failures.push_back(
                    {request.dump(), whole_fonts, 1, fresh.dump()});
            }
            return {.exit_code = 1, .response_json = response.dump()};
        }
        for (std::size_t index = 0; index < results.size(); ++index) {
            auto& item = results[index];
            if (item.retained)
                continue;
            const auto& locale = request.at("locales")[index];
            for (const auto& diagnostic : fresh.at("diagnostics"))
                if (diagnostic.value("locale", std::string{}) == string_value(locale, "locale"))
                    item.diagnostics.push_back(diagnostic);
        }
    }
    auto diagnostics = nlohmann::json::array();
    for (const auto& item : results)
        for (const auto& diagnostic : item.diagnostics)
            diagnostics.push_back(diagnostic);
    // Recheck even retained entries after the complete response assembly;
    // source generation proof at the public boundary separately protects
    // Project-owned fonts and all other tracked physical inputs.
    const auto after = font_coverage_fingerprints(request);
    if (after.size() != whole_fonts.size() ||
        !std::equal(after.begin(), after.end(), whole_fonts.begin(),
                    [](const auto& left, const auto& right) {
                        return left.same_physical_capture(right);
                    }))
        return {.exit_code = 1,
                .response_json = failure("Font sources changed during coverage validation.").dump()};
    for (const auto& item : results)
        if (item.eligible && !item.retained) {
            std::scoped_lock lock(font_coverage_cache_mutex);
            if (font_coverage_cache.size() == 64)
                font_coverage_cache.erase(font_coverage_cache.begin());
            font_coverage_cache.push_back(
                {item.key, item.fingerprints, 0, item.diagnostics.dump()});
        }
    nlohmann::json response{{"ok", true},
                            {"success", diagnostics.empty()},
                            {"diagnostics", std::move(diagnostics)},
                            {"work", {{"executedLocales", executed},
                                      {"reusedLocales", results.size() - executed}}}};
    return {.exit_code = 0, .response_json = response.dump()};
}

} // namespace noveltea::tooling
