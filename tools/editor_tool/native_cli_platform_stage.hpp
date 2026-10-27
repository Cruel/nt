#pragma once

#include "native_cli_platform.hpp"

#include <filesystem>
#include <functional>

namespace noveltea::cli {

// Platform-local packaging operates exclusively on a native-admitted Project,
// a verified template descriptor, and a freshly prepared runtime package.
// Stage publication is isolated from the Project owner and is never performed
// by platform export --check.
PlatformCliResult stage_native_platform_export(
    const PlatformJson& admission, const PlatformJson& profile,
    const PlatformJson& template_descriptor, const std::filesystem::path& template_directory,
    const std::filesystem::path& icon_source, const std::filesystem::path& destination, bool force,
    bool allow_localization_warnings, bool include_unused_assets, bool include_shader_sources,
    const PlatformExportTools& tools, const std::function<bool()>& source_current);

// An interrupted prior transaction is recovered only on a mutating invocation.
// Read-only --check treats an existing journal as a conflict instead.
bool recover_native_platform_publication(const std::filesystem::path& destination,
                                         std::string& error);
bool has_native_platform_publication(const std::filesystem::path& destination);

} // namespace noveltea::cli
