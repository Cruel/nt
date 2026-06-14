#pragma once

#include <cstdint>
#include <filesystem>
#include <optional>
#include <string>
#include <vector>

namespace noveltea {

class AssetPath {
public:
    explicit AssetPath(std::filesystem::path root = {});

    void set_root(std::filesystem::path root);
    [[nodiscard]] const std::filesystem::path& root() const { return m_root; }
    [[nodiscard]] std::filesystem::path resolve(const std::filesystem::path& relative) const;

private:
    std::filesystem::path m_root;
};

[[nodiscard]] std::optional<std::vector<std::uint8_t>> read_binary_file(const std::filesystem::path& path);
[[nodiscard]] std::optional<std::string> read_text_file(const std::filesystem::path& path);
void log_info(const char* area, const char* message);
void log_error(const char* area, const char* message);

} // namespace noveltea
