#pragma once

#include <string>
#include <vector>

#include <noveltea/core/project_document.hpp>

namespace noveltea::core {

struct ValidationIssue {
    std::string path;
    std::string message;
};

class ProjectValidator {
public:
    [[nodiscard]] static std::vector<ValidationIssue> validate(const ProjectDocument& project);
};

} // namespace noveltea::core
