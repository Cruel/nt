#pragma once

#include "noveltea/core/diagnostic.hpp"
#include "noveltea/core/domain_ids.hpp"
#include "noveltea/core/result.hpp"

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <utility>
#include <variant>

namespace noveltea::core {

class DiagnosticCode {
public:
    DiagnosticCode() = delete;
    [[nodiscard]] static Result<DiagnosticCode, Diagnostics> create(std::string value)
    {
        bool segment_start = true;
        bool valid = !value.empty();
        for (const char character : value) {
            if (character == '.') {
                valid = valid && !segment_start;
                segment_start = true;
                continue;
            }
            const bool letter = character >= 'a' && character <= 'z';
            const bool digit = character >= '0' && character <= '9';
            valid =
                valid &&
                (segment_start ? letter : letter || digit || character == '_' || character == '-');
            segment_start = false;
        }
        if (!valid || segment_start)
            return Result<DiagnosticCode, Diagnostics>::failure(
                Diagnostics{Diagnostic{.code = "domain.invalid_diagnostic_code",
                                       .message = "Diagnostic code is invalid"}});
        return Result<DiagnosticCode, Diagnostics>::success(DiagnosticCode(std::move(value)));
    }
    [[nodiscard]] const std::string& text() const noexcept { return m_value; }

private:
    explicit DiagnosticCode(std::string value) : m_value(std::move(value)) {}
    std::string m_value;
};

class JsonPointer {
public:
    JsonPointer() = delete;
    [[nodiscard]] static Result<JsonPointer, Diagnostics> create(std::string value)
    {
        if (!value.empty() && value.front() != '/')
            return Result<JsonPointer, Diagnostics>::failure(
                Diagnostics{Diagnostic{.code = "domain.invalid_json_pointer",
                                       .message = "JSON pointer must be empty or begin with /"}});
        for (std::size_t index = 0; index < value.size(); ++index) {
            if (value[index] == '~' &&
                (index + 1 >= value.size() || (value[index + 1] != '0' && value[index + 1] != '1')))
                return Result<JsonPointer, Diagnostics>::failure(
                    Diagnostics{Diagnostic{.code = "domain.invalid_json_pointer",
                                           .message = "JSON pointer escape is invalid"}});
        }
        return Result<JsonPointer, Diagnostics>::success(JsonPointer(std::move(value)));
    }
    [[nodiscard]] const std::string& text() const noexcept { return m_value; }

private:
    explicit JsonPointer(std::string value) : m_value(std::move(value)) {}
    std::string m_value;
};

class SourceLocation {
public:
    SourceLocation() = delete;
    [[nodiscard]] static Result<SourceLocation, Diagnostics>
    create(std::string source_path, std::uint32_t line = 0, std::uint32_t column = 0)
    {
        if (source_path.empty() || (line == 0 && column != 0))
            return Result<SourceLocation, Diagnostics>::failure(Diagnostics{Diagnostic{
                .code = "domain.invalid_source_location",
                .message = "Source location requires a path and a line when a column is present"}});
        return Result<SourceLocation, Diagnostics>::success(
            SourceLocation(std::move(source_path), line == 0 ? std::nullopt : std::optional{line},
                           column == 0 ? std::nullopt : std::optional{column}));
    }
    [[nodiscard]] const std::string& source_path() const noexcept { return m_source_path; }
    [[nodiscard]] std::optional<std::uint32_t> line() const noexcept { return m_line; }
    [[nodiscard]] std::optional<std::uint32_t> column() const noexcept { return m_column; }

private:
    SourceLocation(std::string source_path, std::optional<std::uint32_t> line,
                   std::optional<std::uint32_t> column)
        : m_source_path(std::move(source_path)), m_line(line), m_column(column)
    {
    }
    std::string m_source_path;
    std::optional<std::uint32_t> m_line;
    std::optional<std::uint32_t> m_column;
};

struct SceneStepPath {
    SceneId scene;
    SceneStepId step;
};
struct SceneActorSlotPath {
    SceneId scene;
    ActorSlotId slot;
};
struct SceneStepActorSlotPath {
    SceneId scene;
    SceneStepId step;
    ActorSlotId slot;
};
struct DialogueBlockPath {
    DialogueId dialogue;
    DialogueBlockId block;
};
struct DialogueSegmentPath {
    DialogueId dialogue;
    DialogueBlockId block;
    DialogueSegmentId segment;
};
struct DialogueEdgePath {
    DialogueId dialogue;
    DialogueBlockId block;
    DialogueEdgeId edge;
};
struct RoomPlacementPath {
    RoomId room;
    RoomPlacementId placement;
};
struct RoomExitPath {
    RoomId room;
    RoomExitId exit;
};
using NestedOwnerPath =
    std::variant<SceneStepPath, SceneActorSlotPath, SceneStepActorSlotPath, DialogueBlockPath,
                 DialogueSegmentPath, DialogueEdgePath, RoomPlacementPath, RoomExitPath>;

} // namespace noveltea::core
