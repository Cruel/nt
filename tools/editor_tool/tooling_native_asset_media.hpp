#pragma once

#include <filesystem>
#include <string_view>

// The first successfully decoded frame/block is a bounded FFmpeg source proof.
// Never invoke a shell or accept container metadata as a decoder substitute.
bool native_probe_asset_media(const std::filesystem::path& source, std::string_view kind);
