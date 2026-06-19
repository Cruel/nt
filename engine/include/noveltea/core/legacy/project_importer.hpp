#pragma once

#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include <nlohmann/json_fwd.hpp>

#include <noveltea/core/project_document.hpp>

namespace noveltea::core::legacy {

struct ImportError {
    std::string message;
};

struct ImportedProject {
    ProjectDocument document;
};

class ProjectImporter {
public:
    [[nodiscard]] static std::optional<ImportedProject>
    import_game_json_text(std::string_view source, std::vector<ImportError>& errors);

    [[nodiscard]] static std::optional<ImportedProject>
    import_game_json(const nlohmann::json& root, std::vector<ImportError>& errors);
};

} // namespace noveltea::core::legacy
