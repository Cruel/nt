#pragma once

#include <optional>
#include <string>
#include <string_view>

namespace noveltea::assets {

class AssetPath {
public:
    AssetPath() = default;
    explicit AssetPath(std::string logical);

    [[nodiscard]] static std::optional<AssetPath> parse(std::string_view logical);
    [[nodiscard]] static std::optional<AssetPath>
    parse_with_default_namespace(std::string_view logical,
                                 std::string_view default_namespace = "project");

    [[nodiscard]] const std::string& namespace_name() const { return m_namespace; }
    [[nodiscard]] const std::string& relative_path() const { return m_relative_path; }
    [[nodiscard]] std::string logical_path() const;
    [[nodiscard]] bool has_namespace() const { return !m_namespace.empty(); }
    [[nodiscard]] bool empty() const { return m_relative_path.empty(); }

private:
    std::string m_namespace;
    std::string m_relative_path;
};

} // namespace noveltea::assets
