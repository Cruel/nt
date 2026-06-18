#pragma once

#include <span>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include <nlohmann/json.hpp>

#include <noveltea/core/entity_ref.hpp>

namespace noveltea::core {

struct ProjectImportResult;

class ProjectDocument {
public:
    ProjectDocument();
    explicit ProjectDocument(nlohmann::json root);

    [[nodiscard]] static ProjectDocument new_project();
    [[nodiscard]] static ProjectImportResult import_legacy_json_text(std::string_view source);
    [[nodiscard]] static ProjectImportResult import_legacy_json(const nlohmann::json& root);

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

struct ProjectImportResult {
    std::optional<ProjectDocument> document;
    std::vector<std::string> diagnostics;

    [[nodiscard]] bool success() const noexcept { return document.has_value() && diagnostics.empty(); }
};

} // namespace noveltea::core
