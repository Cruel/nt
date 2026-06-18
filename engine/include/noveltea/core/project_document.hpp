#pragma once

#include <span>
#include <string>

#include <nlohmann/json.hpp>

#include <noveltea/core/entity_ref.hpp>

namespace noveltea::core {

class ProjectDocument {
public:
    ProjectDocument();
    explicit ProjectDocument(nlohmann::json root);

    [[nodiscard]] static ProjectDocument new_project();

    [[nodiscard]] const nlohmann::json& root() const noexcept { return m_root; }
    [[nodiscard]] nlohmann::json& root() noexcept { return m_root; }

    [[nodiscard]] std::span<const std::string_view> entity_collection_keys() const noexcept;
    [[nodiscard]] bool has_required_project_keys() const;
    [[nodiscard]] bool has_valid_entrypoint() const;
    [[nodiscard]] bool validate_entrypoint(std::string* error_message = nullptr) const;

    [[nodiscard]] std::string dump() const;

private:
    nlohmann::json m_root;
};

} // namespace noveltea::core
