#pragma once

#include "native_cli_platform.hpp"

#include <filesystem>
#include <functional>
#include <optional>

namespace noveltea::cli {

// The destination lock is held from recovery through accepted publication.
// Lock files are intentionally persistent: unlinking a locked inode allows
// concurrent publishers to acquire different locks for the same destination.
class PlatformPublicationLock {
public:
    explicit PlatformPublicationLock(const std::filesystem::path& destination);
    ~PlatformPublicationLock();
    PlatformPublicationLock(const PlatformPublicationLock&) = delete;
    PlatformPublicationLock& operator=(const PlatformPublicationLock&) = delete;
    [[nodiscard]] const std::filesystem::path& destination() const { return destination_; }

private:
    std::filesystem::path destination_;
#if defined(_WIN32)
    void* handle_ = nullptr;
#else
    int handle_ = -1;
#endif
};

void validate_platform_publication_path(const std::filesystem::path& destination);

// Resolved, strict editor/user-local configuration for exactly one export
// invocation. The caller selects a matching signer before constructing this
// value; platform stages consume only these target-neutral fields, not the
// global config file or user signing-profile registry. Never persist or log
// signing contents: they may reference credentials or signing commands.
struct PlatformResolvedExportSettings {
    PlatformJson toolchains = PlatformJson::object();
    PlatformJson signing = PlatformJson::object();
    bool signing_requested = false;
    bool dmg_requested = false;
};

// Shared, read-only capability boundary. The CLI must call this before
// acquiring a publication lock or recovering an existing transaction; the
// stage independently enforces it for direct native callers. A null result
// means the resolved options can proceed to staging, not that publication
// will succeed or the target is supported.
std::optional<PlatformCliResult>
validate_native_platform_export_settings(const PlatformResolvedExportSettings& settings,
                                         const PlatformJson& profile);

// Platform-local packaging operates exclusively on a native-admitted Project,
// a verified template descriptor, and a freshly prepared runtime package.
// Stage publication is isolated from the Project owner and is never performed
// by platform export --check.
PlatformCliResult stage_native_platform_export(
    const PlatformJson& admission, const PlatformJson& profile,
    const PlatformJson& template_descriptor, const std::filesystem::path& template_directory,
    const std::filesystem::path& icon_source, const std::filesystem::path& destination, bool force,
    bool allow_localization_warnings, bool include_unused_assets, bool include_shader_sources,
    const PlatformResolvedExportSettings& settings, const PlatformPublicationLock& lock,
    const PlatformExportTools& tools, const std::function<bool()>& source_current);

// An interrupted prior transaction is recovered only on a mutating invocation.
// Read-only --check treats an existing journal as a conflict instead.
bool recover_native_platform_publication(const std::filesystem::path& destination,
                                         const PlatformPublicationLock& lock, std::string& error);
bool has_native_platform_publication(const std::filesystem::path& destination);

} // namespace noveltea::cli
