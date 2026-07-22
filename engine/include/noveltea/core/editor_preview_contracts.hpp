#pragma once

#include "noveltea/core/compiled_project.hpp"
#include "noveltea/core/layout_scale_policy.hpp"
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

struct TypedEditorAuthoredPreviewEnvironment {
    std::string profile_name;
    compiled::ReferenceResolution native_resolution{};
    LayoutScalePolicy scale_policy{};
    compiled::DisplaySettings project_display{};
    compiled::AccessibilitySettings accessibility{};
};

struct TypedEditorLayoutPreviewDocument {
    EditorPreviewLayoutKind layout_kind = EditorPreviewLayoutKind::Document;
    std::string rml;
    std::string rcss;
    std::string lua;
    bool script_enabled = true;
    std::optional<std::string> fragment_host_rml;
    std::optional<std::string> fragment_host_rcss;
    TypedEditorAuthoredPreviewEnvironment environment;
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
