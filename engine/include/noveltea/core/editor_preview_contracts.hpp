#pragma once

#include "noveltea/render/material.hpp"

#include <cstdint>
#include <optional>
#include <string>
#include <variant>

namespace noveltea::core::editor {

enum class EditorPreviewLayoutKind : std::uint8_t {
    Document,
    Fragment,
};

struct TypedEditorLayoutPreviewDocument {
    EditorPreviewLayoutKind layout_kind = EditorPreviewLayoutKind::Document;
    std::string rml;
    std::string rcss;
    std::string lua;
    bool script_enabled = true;
    std::optional<std::string> fragment_host_rml;
    std::optional<std::string> fragment_host_rcss;
};

struct TypedEditorShaderPreviewDocument {
    std::optional<ShaderMaterialProject> shader_materials;
    std::string preview_material_id = "ui/noise_panel";
    std::string shader_id;
    std::optional<std::string> template_rml;
    std::optional<std::string> template_rcss;
};

using TypedEditorPreviewDocument =
    std::variant<TypedEditorLayoutPreviewDocument, TypedEditorShaderPreviewDocument>;

} // namespace noveltea::core::editor
