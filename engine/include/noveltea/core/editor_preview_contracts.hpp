#pragma once

#include "noveltea/core/compiled_project.hpp"
#include "noveltea/core/layout_scale_policy.hpp"
#include "noveltea/render/material.hpp"

#include <cstdint>
#include <cstddef>
#include <optional>
#include <string>
#include <variant>
#include <vector>

namespace noveltea::core::editor {

inline constexpr std::size_t kFocusedPreviewMaxResourceBytes = 128U * 1024U * 1024U;
inline constexpr std::size_t kFocusedPreviewMaxTotalResourceBytes = 512U * 1024U * 1024U;

enum class EditorPreviewShaderVariant : std::uint8_t {
    Glsl120,
    Essl100,
    Essl300,
};

struct FocusedEditorDocumentLimits {
    std::size_t max_request_bytes = 16U * 1024U * 1024U;
    std::size_t max_source_bytes = 4U * 1024U * 1024U;
    std::size_t max_string_bytes = 16U * 1024U;
    std::size_t max_json_depth = 64U;
    std::size_t max_layouts = 512U;
    std::size_t max_resources = 16'384U;
    std::size_t max_items_per_array = 8'192U;
    std::size_t max_admission_items_per_source = 8'192U;
    std::size_t max_resource_bytes = kFocusedPreviewMaxResourceBytes;
    std::size_t max_total_resource_bytes = kFocusedPreviewMaxTotalResourceBytes;
};

struct FocusedEditorManifestProjection {
    std::string resource_id;
    std::string source_kind;
    std::string logical_path;
    std::string content_hash;
    std::uint64_t byte_size = 0;
    std::string kind;
    std::optional<std::string> sampling;
    std::optional<std::string> asset_id;
    std::optional<std::string> shader_id;
    std::optional<std::string> shader_stage;
    std::optional<EditorPreviewShaderVariant> shader_variant;
};

enum class FocusedEditorDocumentKind : std::uint8_t {
    Layout,
    Shader,
    Room
};

struct FocusedEditorDocumentRequest {
    std::string request_id;
    std::uint64_t apply_sequence = 0;
    std::string project_instance_id;
    std::uint64_t resource_stage_generation = 0;
    FocusedEditorDocumentKind kind = FocusedEditorDocumentKind::Layout;
    std::string record_id;
    std::string revision;
    std::string resource_revision;
    std::vector<FocusedEditorManifestProjection> resources;
    std::string data_json;
};

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
