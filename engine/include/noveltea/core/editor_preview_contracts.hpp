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
    Metal,
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
    bool retain_alpha_coverage = false;
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

struct TypedFocusedRoomPreviewEnvironment {
    std::string profile_name;
    compiled::ReferenceResolution native_resolution{};
    compiled::ReferenceResolution reference_resolution{};
    std::string world_raster_policy;
    std::string bar_color;
    compiled::AccessibilitySettings accessibility{};
};

struct TypedEditorLayoutSourceComponent {
    enum class Kind : std::uint8_t {
        Inline,
        LogicalAsset,
    };

    Kind kind = Kind::Inline;
    std::string value;
};

struct TypedFocusedRoomLayoutDefinition {
    enum class SourceKind : std::uint8_t {
        BuiltinGameHud,
        Authored,
    };
    enum class LayoutKind : std::uint8_t {
        Document,
        Fragment,
    };
    enum class MountKind : std::uint8_t {
        GameHud,
        RoomOverlay,
    };

    std::string instance_id;
    std::optional<std::string> layout_id;
    SourceKind source_kind = SourceKind::BuiltinGameHud;
    LayoutKind layout_kind = LayoutKind::Document;
    MountKind mount_kind = MountKind::GameHud;
    std::optional<std::string> overlay_id;
    std::optional<std::string> template_id;
    std::string source_url;
    std::optional<std::string> default_parent;
    bool scoped_styles = true;
    std::optional<std::string> script_namespace;
    TypedEditorLayoutSourceComponent rml;
    TypedEditorLayoutSourceComponent rcss;
    TypedEditorLayoutSourceComponent lua;
    LayoutScalePolicy scale_policy{};
    std::int32_t order = 0;
    bool visible = true;
    bool script_enabled = false;
    bool contains_dedicated_lua_source = false;
    bool contains_executable_rml_lua = false;
    std::string rcss_prefix;
    bool standalone_fragment_host = false;
};

struct TypedFocusedRoomLuaAdmission {
    struct Definition {
        std::string collection;
        std::string id;
    };
    struct Property {
        std::string owner_kind;
        std::string owner_id;
        std::string property_id;
    };

    std::vector<std::string> variable_ids;
    std::vector<Definition> definitions;
    std::vector<Property> properties;
    std::vector<std::string> interactable_location_ids;
    std::vector<std::string> composition_draft_character_ids;
    std::vector<std::string> composition_draft_interactable_ids;
};

using TypedFocusedScalar = std::variant<std::monostate, bool, std::int64_t, double, std::string>;

struct TypedFocusedRoomQueryState {
    struct Variable {
        std::string id;
        std::string type;
        TypedFocusedScalar value;
    };
    struct Property {
        TypedFocusedRoomLuaAdmission::Property identity;
        bool missing = false;
        TypedFocusedScalar value;
    };
    struct Definition {
        std::string collection;
        std::string id;
        std::optional<std::string> display_name;
    };
    struct InteractableLocation {
        enum class Kind : std::uint8_t {
            Inventory,
            Nowhere,
            RoomPlacement,
        };
        std::string interactable_id;
        Kind kind = Kind::Nowhere;
        std::optional<std::string> room_id;
        std::optional<std::string> placement_id;
    };
    std::vector<Variable> variables;
    std::vector<Property> properties;
    std::vector<Definition> definitions;
    std::vector<InteractableLocation> interactable_locations;
};

struct TypedFocusedCondition {
    enum class Kind : std::uint8_t {
        Always,
        VariableComparison,
        LuaPredicate,
    };
    Kind kind = Kind::Always;
    std::string variable_id;
    std::string comparison_operator;
    std::optional<TypedFocusedScalar> value;
    std::string lua_source;
};

struct TypedFocusedText {
    enum class Markup : std::uint8_t {
        Plain,
        ActiveText,
    };
    enum class SourceKind : std::uint8_t {
        Resolved,
        LuaExpression,
    };
    Markup markup = Markup::Plain;
    SourceKind source_kind = SourceKind::Resolved;
    std::string source;
};

struct TypedFocusedVector2 {
    double x = 0.0;
    double y = 0.0;
};

struct TypedFocusedNormalizedRect {
    double x = 0.0;
    double y = 0.0;
    double width = 0.0;
    double height = 0.0;
};

struct TypedFocusedCharacterVisual {
    struct Pose {
        std::optional<std::string> sprite_asset_id;
        std::optional<std::string> material_id;
        TypedFocusedVector2 offset;
        double scale = 1.0;
        TypedFocusedVector2 anchor;
    };
    struct Expression {
        std::optional<std::string> sprite_asset_id;
        std::optional<std::string> material_id;
    };
    struct Idle {
        std::string kind;
        double amplitude = 0.0;
        std::uint64_t period_ms = 0;
        std::string clock;
    };
    std::string requested_pose_id;
    std::string resolved_pose_id;
    std::string expression_id;
    std::optional<std::string> idle_id;
    Pose pose;
    Expression expression;
    std::optional<Idle> idle;
};

struct TypedFocusedRoomWorldDefinition {
    struct Background {
        std::optional<std::string> asset_id;
        std::optional<std::string> material_id;
        std::string fit;
        std::optional<std::string> color;
    };
    struct Placement {
        std::string id;
        TypedFocusedNormalizedRect bounds;
        std::int32_t order = 0;
        std::optional<TypedFocusedText> label;
        std::optional<std::string> layout_id;
    };
    struct PersistentCharacter {
        std::string character_id;
        std::string placement_id;
        bool enabled = false;
        bool visible = false;
        TypedFocusedCharacterVisual visual;
    };
    struct CastEntry {
        std::string entry_id;
        std::string character_id;
        TypedFocusedCondition condition;
        std::string placement_id;
        bool visible = false;
        std::int32_t order = 0;
        TypedFocusedCharacterVisual visual;
    };
    struct Interactable {
        std::string interactable_id;
        std::string placement_id;
        std::optional<std::string> sprite_asset_id;
        std::optional<std::string> material_id;
        bool enabled = false;
        bool visible = false;
        std::int32_t order = 0;
    };
    struct Prop {
        std::string prop_id;
        TypedFocusedCondition condition;
        std::string placement_id;
        std::optional<std::string> asset_id;
        std::optional<std::string> material_id;
        bool visible = false;
        std::int32_t order = 0;
    };
    struct Environment {
        std::string environment_id;
        TypedFocusedCondition condition;
        std::optional<std::string> asset_id;
        std::string material_id;
        TypedFocusedNormalizedRect bounds;
        std::string plane;
        std::int32_t order = 0;
        std::string clock;
        TypedFocusedVector2 scroll_per_second;
        double opacity = 1.0;
        bool visible = false;
    };
    struct Overlay {
        std::string overlay_id;
        TypedFocusedCondition condition;
        std::string layout_id;
        bool visible = false;
        std::int32_t order = 0;
    };
    Background background;
    std::vector<Placement> placements;
    std::vector<PersistentCharacter> persistent_characters;
    std::vector<CastEntry> cast;
    std::vector<Interactable> interactables;
    std::vector<Prop> props;
    std::vector<Environment> environments;
    std::vector<Overlay> overlays;
};

struct TypedFocusedRoomUiDefinition {
    struct Exit {
        std::string exit_id;
        std::string label;
        std::string direction;
        std::string target_room_id;
        TypedFocusedCondition condition;
    };
    TypedFocusedText description;
    std::vector<Exit> exits;
};

struct TypedFocusedRoomCompositionDefinition {
    struct Source {
        bool inline_source = true;
        std::string value;
    };
    std::string script_id;
    Source source;
};

struct TypedEditorRoomPreviewDocument {
    TypedFocusedRoomPreviewEnvironment environment;
    std::string room_id;
    std::string record_label;
    std::string display_name;
    std::vector<TypedFocusedRoomLayoutDefinition> layouts;
    TypedFocusedRoomLuaAdmission lua_admission;
    TypedFocusedRoomQueryState query_state;
    ShaderMaterialProject shader_materials;
    TypedFocusedRoomWorldDefinition world;
    TypedFocusedRoomUiDefinition ui;
    std::optional<TypedFocusedRoomCompositionDefinition> composition;
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
    std::string layout_id;
    EditorPreviewLayoutKind layout_kind = EditorPreviewLayoutKind::Document;
    std::optional<std::string> template_id;
    std::string source_url;
    std::optional<std::string> default_parent;
    bool scoped_styles = true;
    TypedEditorLayoutSourceComponent rml;
    TypedEditorLayoutSourceComponent rcss;
    TypedEditorLayoutSourceComponent lua;
    bool script_enabled = true;
    std::optional<std::string> script_namespace;
    std::optional<ShaderMaterialProject> shader_materials;
    TypedEditorAuthoredPreviewEnvironment environment;
};

struct TypedEditorShaderPreviewDocument {
    ShaderMaterialProject shader_materials;
    std::string preview_material_id = "ui/noise_panel";
    std::string shader_id;
    std::string template_id;
    EditorPreviewShaderVariant active_shader_variant = EditorPreviewShaderVariant::Glsl120;
};

using TypedEditorPreviewDocument =
    std::variant<TypedEditorLayoutPreviewDocument, TypedEditorShaderPreviewDocument>;

} // namespace noveltea::core::editor
