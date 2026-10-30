#pragma once

#include <noveltea/core/player_bootstrap.hpp>

#include <algorithm>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <map>
#include <optional>
#include <set>
#include <span>
#include <string>
#include <string_view>

namespace noveltea::core {

struct ShaderBinaryRevision {
    std::string sha256;
    std::uint64_t byte_size = 0;
};

// The shader metadata is the immutable compilation proof. Only project-owned
// compiled variants are packaged; system:/ entries come from the player.
template<class Json>
[[nodiscard]] std::optional<std::map<std::string, ShaderBinaryRevision>>
shader_binary_revisions(const Json& metadata, const std::set<std::string>& required)
{
    std::map<std::string, ShaderBinaryRevision> revisions;
    if (required.empty() && metadata.is_null())
        return revisions;
    if (!metadata.is_object() || !metadata.contains("shaders") || !metadata["shaders"].is_object())
        return std::nullopt;
    for (const auto& [id, shader] : metadata["shaders"].items()) {
        (void)id;
        if (!shader.is_object() || !shader.contains("stages") || !shader["stages"].is_object())
            return std::nullopt;
        for (const auto& [stage, value] : shader["stages"].items()) {
            (void)stage;
            if (!value.is_object() || !value.contains("compiled") || !value["compiled"].is_object())
                return std::nullopt;
            for (const auto& [variant, compiled] : value["compiled"].items()) {
                (void)variant;
                if (!compiled.is_object() || !compiled.contains("runtimePath") ||
                    !compiled["runtimePath"].is_string())
                    return std::nullopt;
                const auto runtime_path = compiled["runtimePath"].template get<std::string>();
                if (!runtime_path.starts_with("project:/")) {
                    if (!runtime_path.starts_with("system:/"))
                        return std::nullopt;
                    continue;
                }
                const auto relative = runtime_path.substr(std::string_view("project:/").size());
                const std::filesystem::path path{relative};
                if ((!relative.starts_with("shaders/derived/") &&
                     !relative.starts_with("shaders/bgfx/")) ||
                    path.is_absolute() || path.empty())
                    return std::nullopt;
                for (const auto& segment : path)
                    if (segment.empty() || segment == "." || segment == "..")
                        return std::nullopt;
                if (!compiled.contains("byteHash") || !compiled["byteHash"].is_string() ||
                    !compiled.contains("byteSize") || !compiled["byteSize"].is_number_unsigned())
                    return std::nullopt;
                const auto hash = compiled["byteHash"].template get<std::string>();
                const auto size = compiled["byteSize"].template get<std::uint64_t>();
                if (hash.size() != 71 || !hash.starts_with("sha256:") ||
                    !std::all_of(hash.begin() + 7, hash.end(),
                                 [](char ch) {
                                     return (ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f');
                                 }) ||
                    size > 64ull * 1024 * 1024)
                    return std::nullopt;
                auto [found, inserted] =
                    revisions.emplace(relative, ShaderBinaryRevision{hash, size});
                if (!inserted && (found->second.sha256 != hash || found->second.byte_size != size))
                    return std::nullopt;
            }
        }
    }
    std::set<std::string> pinned;
    for (const auto& [path, revision] : revisions) {
        (void)revision;
        pinned.insert(path);
    }
    if (pinned != required)
        return std::nullopt;
    return revisions;
}

// Cache admission and final CLI publication use exactly the same proof as the
// package writer, but against disk rather than staged ZIP entry bytes.
template<class Json>
[[nodiscard]] bool shader_binary_files_current(const Json& metadata,
                                               const std::set<std::string>& required,
                                               const std::filesystem::path& asset_root)
{
    const auto revisions = shader_binary_revisions(metadata, required);
    if (!revisions)
        return false;
    for (const auto& [relative, revision] : *revisions) {
        auto source = asset_root;
        std::error_code error;
        for (const auto& segment : std::filesystem::path(relative)) {
            source /= segment;
            const auto status = std::filesystem::symlink_status(source, error);
            if (error || std::filesystem::is_symlink(status))
                return false;
        }
        if (!std::filesystem::is_regular_file(source, error) || error ||
            std::filesystem::file_size(source, error) != revision.byte_size || error)
            return false;
        std::ifstream input(source, std::ios::binary);
        if (!input)
            return false;
        const std::string bytes{std::istreambuf_iterator<char>(input),
                                std::istreambuf_iterator<char>()};
        if (input.bad() || bytes.size() != revision.byte_size ||
            "sha256:" + sha256_hex(std::as_bytes(std::span(bytes.data(), bytes.size()))) !=
                revision.sha256)
            return false;
    }
    return true;
}

} // namespace noveltea::core
