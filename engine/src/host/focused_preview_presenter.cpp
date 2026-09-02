#include "host/focused_preview_presenter.hpp"

#include "noveltea/assets/asset_cache_keys.hpp"
#include "noveltea/core/editor_runtime_protocol.hpp"
#include "noveltea/presentation/room_presentation.hpp"
#include "noveltea/runtime/runtime_capabilities.hpp"
#include "noveltea/runtime/runtime_query_provider.hpp"
#include "noveltea/render/shader_manifest.hpp"
#include "ui/rmlui/runtime_ui.hpp"

#include <algorithm>
#include <cmath>
#include <set>
#include <unordered_set>
#include <utility>

namespace noveltea::host {
namespace {

core::Diagnostic error(std::string code, std::string message, std::string pointer = {})
{
    return {
        .code = std::move(code), .message = std::move(message), .json_pointer = std::move(pointer)};
}

core::Diagnostics script_error(const script::ScriptError& value)
{
    return {error("editor_preview.focused_lua_failed", value.message, value.chunk)};
}

core::Diagnostics unadmitted(std::string operation)
{
    return {error("editor_preview.focused_lua_query_unadmitted",
                  std::move(operation) + " is not admitted by the focused document")};
}

std::string_view shader_variant_name(core::editor::EditorPreviewShaderVariant variant) noexcept
{
    switch (variant) {
    case core::editor::EditorPreviewShaderVariant::Glsl120:
        return "glsl-120";
    case core::editor::EditorPreviewShaderVariant::Essl100:
        return "essl-100";
    case core::editor::EditorPreviewShaderVariant::Essl300:
        return "essl-300";
    case core::editor::EditorPreviewShaderVariant::Metal:
        return "metal";
    }
    return {};
}

void upsert_preview_material(ShaderMaterialProject& project, std::string material_id,
                             std::string shader_id)
{
    project.materials.erase(std::remove_if(project.materials.begin(), project.materials.end(),
                                           [&](const MaterialDefinition& material) {
                                               return material.id.string() == material_id;
                                           }),
                            project.materials.end());
    MaterialDefinition material;
    material.id = MaterialId(std::move(material_id));
    material.role = ShaderRole::RmlUiDecorator;
    material.shader = ShaderId(std::move(shader_id));
    material.display_name = "Editor Preview Shader Material";
    project.materials.push_back(std::move(material));
}

void replace_all(std::string& value, std::string_view needle, std::string_view replacement)
{
    if (needle.empty())
        return;
    std::size_t position = 0;
    while ((position = value.find(needle, position)) != std::string::npos) {
        value.replace(position, needle.size(), replacement);
        position += replacement.size();
    }
}

core::editor::TypedFocusedRoomLayoutDefinition
standalone_layout_definition(const core::editor::TypedEditorLayoutPreviewDocument& document,
                             std::string rcss_prefix)
{
    using Definition = core::editor::TypedFocusedRoomLayoutDefinition;
    const bool fragment = document.layout_kind == core::editor::EditorPreviewLayoutKind::Fragment;
    return {
        .instance_id = "standalone-layout-preview",
        .layout_id = document.layout_id,
        .source_kind = Definition::SourceKind::Authored,
        .layout_kind =
            fragment ? Definition::LayoutKind::Fragment : Definition::LayoutKind::Document,
        .mount_kind = Definition::MountKind::GameHud,
        .overlay_id = std::nullopt,
        .template_id = document.template_id,
        .source_url = document.source_url,
        .default_parent = document.default_parent,
        .scoped_styles = document.scoped_styles,
        .script_namespace = document.script_namespace,
        .rml = document.rml,
        .rcss = document.rcss,
        .lua = document.lua,
        .scale_policy = document.environment.scale_policy,
        .order = 0,
        .visible = true,
        .script_enabled = document.script_enabled,
        .contains_dedicated_lua_source =
            document.script_enabled &&
            (document.lua.kind ==
                 core::editor::TypedEditorLayoutSourceComponent::Kind::LogicalAsset ||
             !document.lua.value.empty()),
        .contains_executable_rml_lua = false,
        .rcss_prefix = std::move(rcss_prefix),
        .standalone_fragment_host = fragment,
    };
}

core::editor::TypedFocusedRoomLayoutDefinition
shader_layout_definition(const core::editor::TypedEditorShaderPreviewDocument& document)
{
    constexpr std::string_view rml = R"rml(<rml>
<head><title>NovelTea Shader Preview</title></head>
<body>
    <div id="nt-shader-preview-stage">
        <div id="nt-shader-preview-square" data-preview-material="__NT_PREVIEW_MATERIAL_ID__"></div>
    </div>
</body>
</rml>
)rml";
    constexpr std::string_view rcss = R"rcss(body {
    margin: 0;
    width: 100%;
    height: 100%;
    background-color: #0f172a;
    font-family: Liberation Sans;
}

#nt-shader-preview-stage {
    position: absolute;
    left: 0;
    top: 0;
    right: 0;
    bottom: 0;
    background-color: #0f172a;
}

#nt-shader-preview-square {
    position: absolute;
    left: 50%;
    top: 50%;
    width: 256px;
    height: 256px;
    margin-left: -128px;
    margin-top: -128px;
    background-color: #1e293b;
    border: 1px #94a3b8;
    decorator: shader("__NT_PREVIEW_MATERIAL_ID__");
}
)rcss";
    std::string resolved_rml(rml);
    std::string resolved_rcss(rcss);
    replace_all(resolved_rml, "__NT_PREVIEW_MATERIAL_ID__", document.preview_material_id);
    replace_all(resolved_rcss, "__NT_PREVIEW_MATERIAL_ID__", document.preview_material_id);
    using Definition = core::editor::TypedFocusedRoomLayoutDefinition;
    return {
        .instance_id = "standalone-shader-preview",
        .layout_id = std::nullopt,
        .source_kind = Definition::SourceKind::Authored,
        .layout_kind = Definition::LayoutKind::Document,
        .mount_kind = Definition::MountKind::GameHud,
        .overlay_id = std::nullopt,
        .template_id = document.template_id,
        .source_url = "preview://templates/shader-square-preview.rml",
        .default_parent = std::nullopt,
        .scoped_styles = true,
        .script_namespace = std::nullopt,
        .rml = {.kind = core::editor::TypedEditorLayoutSourceComponent::Kind::Inline,
                .value = std::move(resolved_rml)},
        .rcss = {.kind = core::editor::TypedEditorLayoutSourceComponent::Kind::Inline,
                 .value = std::move(resolved_rcss)},
        .lua = {.kind = core::editor::TypedEditorLayoutSourceComponent::Kind::Inline, .value = {}},
        .scale_policy = {},
        .order = 0,
        .visible = true,
        .script_enabled = false,
        .contains_dedicated_lua_source = false,
        .contains_executable_rml_lua = false,
        .rcss_prefix = {},
        .standalone_fragment_host = false,
    };
}

core::Result<void, core::Diagnostics>
validate_room_manifest_closure(const core::editor::FocusedEditorDocumentRequest& request,
                               const core::editor::TypedEditorRoomPreviewDocument& document)
{
    std::set<std::string> asset_ids;
    std::set<std::string> logical_paths;
    for (const auto& resource : request.resources) {
        logical_paths.insert(resource.logical_path);
        if (resource.source_kind == "authoring-asset" && resource.asset_id)
            asset_ids.insert(*resource.asset_id);
    }
    core::Diagnostics diagnostics;
    const auto require_asset = [&](const std::optional<std::string>& id, std::string path) {
        if (id && !asset_ids.contains(*id))
            diagnostics.push_back(
                error("editor_preview.manifest_asset_missing",
                      "Focused Room references Asset '" + *id + "' outside the manifest.",
                      std::move(path)));
    };
    const auto require_path = [&](std::string_view path, std::string pointer) {
        if (!logical_paths.contains(std::string(path)))
            diagnostics.push_back(error("editor_preview.manifest_path_missing",
                                        "Focused Room references logical path '" +
                                            std::string(path) + "' outside the manifest.",
                                        std::move(pointer)));
    };

    require_asset(document.world.background.asset_id, "/world/background/assetId");
    for (std::size_t index = 0; index < document.world.persistent_characters.size(); ++index) {
        const auto& value = document.world.persistent_characters[index];
        for (std::size_t layer = 0; layer < value.visual.layers.size(); ++layer)
            require_asset(value.visual.layers[layer].sprite_asset_id,
                          "/world/persistentCharacters/" + std::to_string(index) +
                              "/visual/layers/" + std::to_string(layer) + "/spriteAssetId");
    }
    for (std::size_t index = 0; index < document.world.cast.size(); ++index) {
        const auto& value = document.world.cast[index];
        for (std::size_t layer = 0; layer < value.visual.layers.size(); ++layer)
            require_asset(value.visual.layers[layer].sprite_asset_id,
                          "/world/cast/" + std::to_string(index) + "/visual/layers/" +
                              std::to_string(layer) + "/spriteAssetId");
    }
    for (std::size_t index = 0; index < document.world.interactables.size(); ++index)
        require_asset(document.world.interactables[index].sprite_asset_id,
                      "/world/interactables/" + std::to_string(index) + "/spriteAssetId");
    for (std::size_t index = 0; index < document.world.props.size(); ++index)
        require_asset(document.world.props[index].asset_id,
                      "/world/props/" + std::to_string(index) + "/assetId");
    for (std::size_t index = 0; index < document.world.environments.size(); ++index)
        require_asset(document.world.environments[index].asset_id,
                      "/world/environments/" + std::to_string(index) + "/assetId");

    for (std::size_t index = 0; index < document.layouts.size(); ++index) {
        const auto& layout = document.layouts[index];
        if (layout.source_kind !=
            core::editor::TypedFocusedRoomLayoutDefinition::SourceKind::Authored)
            continue;
        const auto require_component =
            [&](const core::editor::TypedEditorLayoutSourceComponent& source,
                std::string_view name) {
                if (source.kind ==
                    core::editor::TypedEditorLayoutSourceComponent::Kind::LogicalAsset)
                    require_path(source.value, "/layouts/" + std::to_string(index) + "/source/" +
                                                   std::string(name) + "/logicalPath");
            };
        require_component(layout.rml, "rml");
        require_component(layout.rcss, "rcss");
        require_component(layout.lua, "lua");
    }
    if (document.composition && !document.composition->source.inline_source)
        require_path(document.composition->source.value, "/composition/source/logicalPath");
    for (std::size_t material_index = 0;
         material_index < document.shader_materials.materials.size(); ++material_index) {
        const auto& material = document.shader_materials.materials[material_index];
        if (find_shader(document.shader_materials, material.shader) == nullptr)
            diagnostics.push_back(
                error("editor_preview.material_shader_missing",
                      "Focused Material references a missing Shader.",
                      "/shaderMaterials/materials/" + std::to_string(material_index) + "/shader"));
        for (std::size_t texture_index = 0; texture_index < material.textures.size();
             ++texture_index)
            require_path(material.textures[texture_index].source,
                         "/shaderMaterials/materials/" + std::to_string(material_index) +
                             "/textures/" + std::to_string(texture_index) + "/source");
    }
    if (!diagnostics.empty())
        return core::Result<void, core::Diagnostics>::failure(std::move(diagnostics));
    return core::Result<void, core::Diagnostics>::success();
}

template<class Id> Id decoded_id(const std::string& value);

class FocusedRoomQueryProvider final : public runtime::RuntimeQueryProvider {
public:
    FocusedRoomQueryProvider(const core::editor::TypedFocusedRoomLuaAdmission& admission,
                             const core::editor::TypedFocusedRoomQueryState& state,
                             runtime::CapabilityGeneration generation)
        : m_state(state), m_generation(generation)
    {
        m_variables.insert(admission.variable_ids.begin(), admission.variable_ids.end());
        m_locations.insert(admission.interactable_location_ids.begin(),
                           admission.interactable_location_ids.end());
        for (const auto& value : admission.definitions)
            m_definitions.insert(value.collection + "\n" + value.id);
        for (const auto& value : admission.properties)
            m_properties.insert(value.owner_kind + "\n" + value.owner_id + "\n" +
                                value.property_id);
    }

    void close() noexcept override { m_active = false; }
    bool active(runtime::CapabilityGeneration generation) const noexcept override
    {
        return m_active && generation == m_generation;
    }

    core::Result<core::ProjectDefinitionSummary, core::Diagnostics>
    definition(core::ProjectDefinitionKind kind, std::string id) const override
    {
        const auto collection = [](core::ProjectDefinitionKind value) -> std::string_view {
            using K = core::ProjectDefinitionKind;
            switch (value) {
            case K::Room:
                return "rooms";
            case K::Scene:
                return "scenes";
            case K::Dialogue:
                return "dialogues";
            case K::Character:
                return "characters";
            case K::Interactable:
                return "interactables";
            case K::Verb:
                return "verbs";
            case K::Interaction:
                return "interactions";
            case K::Map:
                return "maps";
            }
            return {};
        }(kind);
        if (!m_definitions.contains(std::string(collection) + "\n" + id))
            return core::Result<core::ProjectDefinitionSummary, core::Diagnostics>::failure(
                unadmitted("definition query"));
        const auto found = std::find_if(
            m_state.definitions.begin(), m_state.definitions.end(),
            [&](const auto& value) { return value.collection == collection && value.id == id; });
        if (found == m_state.definitions.end())
            return core::Result<core::ProjectDefinitionSummary, core::Diagnostics>::failure(
                {error("editor_preview.focused_definition_missing",
                       "Admitted focused definition is missing from deterministic query state")});
        return core::Result<core::ProjectDefinitionSummary, core::Diagnostics>::success(
            {kind, std::move(id), found->display_name});
    }

    core::Result<core::RuntimeValue, core::Diagnostics>
    global_property(const core::PropertyId& id) const override
    {
        if (!m_variables.contains(id.text()))
            return core::Result<core::RuntimeValue, core::Diagnostics>::failure(
                unadmitted("Global Property read"));
        const auto found = std::find_if(m_state.variables.begin(), m_state.variables.end(),
                                        [&](const auto& value) { return value.id == id.text(); });
        if (found == m_state.variables.end())
            return core::Result<core::RuntimeValue, core::Diagnostics>::failure(
                {error("editor_preview.focused_variable_missing",
                       "Admitted focused Variable is missing from deterministic query state")});
        return core::Result<core::RuntimeValue, core::Diagnostics>::success(found->value);
    }

    core::Result<core::PropertyLookupResult, core::Diagnostics>
    property(const core::PropertyOwnerRef& owner, const core::PropertyId& property) const override
    {
        const auto identity = std::visit(
            [&](const auto& id) {
                std::string kind;
                std::string owner_id;
                using T = std::decay_t<decltype(id)>;
                if constexpr (std::is_same_v<T, core::RoomId>)
                    kind = "room";
                else if constexpr (std::is_same_v<T, core::CharacterId>)
                    kind = "character";
                else if constexpr (std::is_same_v<T, core::InteractableInstanceId>)
                    kind = "interactable";
                else if constexpr (std::is_same_v<T, core::RoomFeatureRef>) {
                    kind = "feature";
                    owner_id = "room:" + id.room.text() + "/feature:" + id.feature_id.text();
                } else if constexpr (std::is_same_v<T, core::InteractableFeatureRef>) {
                    kind = "feature";
                    owner_id = "interactable:" + id.interactable.text() +
                               "/feature:" + id.feature_id.text();
                }
                if constexpr (!std::is_same_v<T, core::RoomFeatureRef> &&
                              !std::is_same_v<T, core::InteractableFeatureRef>)
                    owner_id = id.text();
                return kind + "\n" + owner_id + "\n" + property.text();
            },
            owner);
        if (!m_properties.contains(identity))
            return core::Result<core::PropertyLookupResult, core::Diagnostics>::failure(
                unadmitted("property read"));
        const auto found = std::find_if(
            m_state.properties.begin(), m_state.properties.end(), [&](const auto& value) {
                return value.identity.owner_kind + "\n" + value.identity.owner_id + "\n" +
                           value.identity.property_id ==
                       identity;
            });
        if (found == m_state.properties.end())
            return core::Result<core::PropertyLookupResult, core::Diagnostics>::failure(
                {error("editor_preview.focused_property_missing",
                       "Admitted focused property is missing from deterministic query state")});
        if (found->missing)
            return core::Result<core::PropertyLookupResult, core::Diagnostics>::success(
                core::MissingPropertyValue{core::property_target(owner), property});
        return core::Result<core::PropertyLookupResult, core::Diagnostics>::success(found->value);
    }

    core::Result<core::compiled::InteractableLocation, core::Diagnostics>
    interactable_location(const core::InteractableInstanceId& interactable) const override
    {
        if (!m_locations.contains(interactable.text()))
            return core::Result<core::compiled::InteractableLocation, core::Diagnostics>::failure(
                unadmitted("Interactable location query"));
        const auto found = std::find_if(
            m_state.interactable_locations.begin(), m_state.interactable_locations.end(),
            [&](const auto& value) { return value.interactable_id == interactable.text(); });
        if (found == m_state.interactable_locations.end())
            return core::Result<core::compiled::InteractableLocation, core::Diagnostics>::failure(
                {error(
                    "editor_preview.focused_location_missing",
                    "Admitted Interactable location is missing from deterministic query state")});
        return core::Result<core::compiled::InteractableLocation, core::Diagnostics>::success(
            found->location);
    }

    core::Result<core::CharacterWorldLocation, core::Diagnostics>
    character_location(const core::CharacterId&) const override
    {
        return core::Result<core::CharacterWorldLocation, core::Diagnostics>::failure(
            unadmitted("Character location query"));
    }

private:
    core::editor::TypedFocusedRoomQueryState m_state;
    runtime::CapabilityGeneration m_generation;
    bool m_active = true;
    std::unordered_set<std::string> m_variables;
    std::unordered_set<std::string> m_definitions;
    std::unordered_set<std::string> m_properties;
    std::unordered_set<std::string> m_locations;
};

FocusedContentKind owner_kind(core::editor::FocusedEditorDocumentKind kind)
{
    switch (kind) {
    case core::editor::FocusedEditorDocumentKind::Layout:
        return FocusedContentKind::Layout;
    case core::editor::FocusedEditorDocumentKind::Shader:
        return FocusedContentKind::Shader;
    case core::editor::FocusedEditorDocumentKind::Room:
        return FocusedContentKind::Room;
    }
    return FocusedContentKind::None;
}

template<class Id> Id decoded_id(const std::string& value)
{
    auto decoded = Id::create(value);
    assert(decoded);
    return *decoded.value_if();
}

core::Result<bool, core::Diagnostics>
compare_scalar(const core::editor::TypedFocusedRoomQueryState& state,
               const core::editor::TypedFocusedCondition& condition, script::ScriptRuntime& scripts,
               script::ScriptEnvironmentHandle environment, runtime::RuntimeQueryProvider& provider,
               runtime::CapabilityGeneration generation)
{
    if (condition.kind == core::editor::TypedFocusedCondition::Kind::Always)
        return core::Result<bool, core::Diagnostics>::success(true);
    if (condition.kind == core::editor::TypedFocusedCondition::Kind::All) {
        for (const auto& child : condition.conditions) {
            auto result = compare_scalar(state, child, scripts, environment, provider, generation);
            const auto* value = result.value_if();
            if (value == nullptr)
                return result;
            if (!*value)
                return core::Result<bool, core::Diagnostics>::success(false);
        }
        return core::Result<bool, core::Diagnostics>::success(true);
    }
    if (condition.kind == core::editor::TypedFocusedCondition::Kind::Any) {
        for (const auto& child : condition.conditions) {
            auto result = compare_scalar(state, child, scripts, environment, provider, generation);
            const auto* value = result.value_if();
            if (value == nullptr)
                return result;
            if (*value)
                return core::Result<bool, core::Diagnostics>::success(true);
        }
        return core::Result<bool, core::Diagnostics>::success(false);
    }
    if (condition.kind == core::editor::TypedFocusedCondition::Kind::Not) {
        if (condition.conditions.size() != 1)
            return core::Result<bool, core::Diagnostics>::failure(
                {error("editor_preview.focused_condition_invalid",
                       "Focused Not Condition must contain exactly one child")});
        auto result = compare_scalar(state, condition.conditions.front(), scripts, environment,
                                     provider, generation);
        const auto* value = result.value_if();
        return value ? core::Result<bool, core::Diagnostics>::success(!*value) : result;
    }
    if (condition.kind == core::editor::TypedFocusedCondition::Kind::RuntimeOnly)
        return core::Result<bool, core::Diagnostics>::failure({error(
            "editor_preview.runtime_condition_requires_full_preview",
            "Focused Room preview cannot evaluate runtime-only Condition kind '" +
                condition.runtime_condition_kind + "'; use full Play preview for this state")});
    if (condition.kind == core::editor::TypedFocusedCondition::Kind::LuaPredicate) {
        runtime::RuntimeCapabilityIssuer issuer(provider, generation);
        const auto capabilities =
            issuer.issue(runtime::RuntimeCapabilityProfile::SynchronousExpression);
        if (!capabilities)
            return core::Result<bool, core::Diagnostics>::failure(
                {error("editor_preview.focused_lua_capabilities_failed",
                       "Focused Lua expression capabilities could not be issued")});
        runtime::ScriptInvocationRequest request{.source = condition.lua_source,
                                                 .chunk_name = "focused-room-condition",
                                                 .owner = std::nullopt,
                                                 .invocation = std::nullopt,
                                                 .source_context = {},
                                                 .result_kind =
                                                     runtime::ScriptInvocationResultKind::Boolean,
                                                 .asset_path = std::nullopt};
        auto result = scripts.invoke_in_environment(environment, request, *capabilities);
        if (!result)
            return core::Result<bool, core::Diagnostics>::failure(script_error(result.error()));
        const auto* completed = std::get_if<runtime::ScriptInvocationCompleted>(result.value_if());
        if (completed == nullptr)
            return core::Result<bool, core::Diagnostics>::failure(
                {error("editor_preview.focused_lua_completion_invalid",
                       "Focused Lua predicate did not complete synchronously")});
        if (const auto* value = std::get_if<bool>(&completed->value))
            return core::Result<bool, core::Diagnostics>::success(*value);
        return core::Result<bool, core::Diagnostics>::failure(
            {error("editor_preview.focused_lua_result_invalid",
                   "Focused Lua predicate did not return a Boolean")});
    }
    const auto found =
        std::find_if(state.variables.begin(), state.variables.end(),
                     [&](const auto& variable) { return variable.id == condition.variable_id; });
    if (found == state.variables.end())
        return core::Result<bool, core::Diagnostics>::failure(
            {error("editor_preview.room_variable_missing",
                   "Focused Room condition references a missing deterministic Variable.")});

    const auto truthy = [](const core::editor::TypedFocusedScalar& value) {
        return std::visit(
            [](const auto& current) {
                using T = std::decay_t<decltype(current)>;
                if constexpr (std::is_same_v<T, std::monostate>)
                    return false;
                else if constexpr (std::is_same_v<T, bool>)
                    return current;
                else if constexpr (std::is_arithmetic_v<T>)
                    return current != 0;
                else
                    return !current.empty();
            },
            value);
    };
    if (condition.comparison_operator == "truthy")
        return core::Result<bool, core::Diagnostics>::success(truthy(found->value));
    if (condition.comparison_operator == "falsy")
        return core::Result<bool, core::Diagnostics>::success(!truthy(found->value));
    if (!condition.value)
        return core::Result<bool, core::Diagnostics>::failure(
            {error("editor_preview.room_variable_operand_missing",
                   "Focused Room comparison is missing its operand.")});

    const auto equal = [&]() {
        if (found->value.index() == condition.value->index())
            return found->value == *condition.value;
        const auto numeric = [](const auto& value) -> std::optional<double> {
            return std::visit(
                [](const auto& current) -> std::optional<double> {
                    using T = std::decay_t<decltype(current)>;
                    if constexpr (std::is_same_v<T, std::int64_t> || std::is_same_v<T, double>)
                        return static_cast<double>(current);
                    return std::nullopt;
                },
                value);
        };
        const auto left = numeric(found->value);
        const auto right = numeric(*condition.value);
        return left && right && *left == *right;
    }();
    if (condition.comparison_operator == "equal")
        return core::Result<bool, core::Diagnostics>::success(equal);
    if (condition.comparison_operator == "not-equal")
        return core::Result<bool, core::Diagnostics>::success(!equal);

    const auto order = std::visit(
        [](const auto& left, const auto& right) -> std::optional<int> {
            using L = std::decay_t<decltype(left)>;
            using R = std::decay_t<decltype(right)>;
            if constexpr ((std::is_same_v<L, std::int64_t> || std::is_same_v<L, double>) &&
                          (std::is_same_v<R, std::int64_t> || std::is_same_v<R, double>)) {
                const double a = static_cast<double>(left);
                const double b = static_cast<double>(right);
                return a < b ? -1 : a > b ? 1 : 0;
            } else if constexpr (std::is_same_v<L, std::string> && std::is_same_v<R, std::string>) {
                return left < right ? -1 : left > right ? 1 : 0;
            }
            return std::nullopt;
        },
        found->value, *condition.value);
    if (!order)
        return core::Result<bool, core::Diagnostics>::failure(
            {error("editor_preview.room_variable_comparison_invalid",
                   "Focused Room ordered comparison uses incompatible values.")});
    const bool result = condition.comparison_operator == "less"            ? *order < 0
                        : condition.comparison_operator == "less-equal"    ? *order <= 0
                        : condition.comparison_operator == "greater"       ? *order > 0
                        : condition.comparison_operator == "greater-equal" ? *order >= 0
                                                                           : false;
    return core::Result<bool, core::Diagnostics>::success(result);
}

std::string lua_quote(std::string_view value)
{
    std::string result{"\""};
    for (const char character : value) {
        if (character == '\\' || character == '"')
            result.push_back('\\');
        result.push_back(character);
    }
    result.push_back('"');
    return result;
}

class FocusedRoomComposition final : public core::RoomCompositionCallback {
public:
    FocusedRoomComposition(const core::editor::TypedFocusedRoomCompositionDefinition& definition,
                           const core::editor::TypedFocusedRoomLuaAdmission& admission,
                           script::ScriptRuntime& scripts,
                           script::ScriptEnvironmentHandle environment,
                           runtime::RuntimeQueryProvider& provider,
                           runtime::CapabilityGeneration generation) noexcept
        : m_definition(definition), m_admission(admission), m_scripts(scripts),
          m_environment(environment), m_provider(provider), m_generation(generation)
    {
    }

    core::Result<void, core::Diagnostics> compose(const core::RoomVisitContext& visit,
                                                  core::RoomPresentationDraft& draft) override
    {
        std::unordered_set<std::string> characters(
            m_admission.composition_draft_character_ids.begin(),
            m_admission.composition_draft_character_ids.end());
        std::unordered_set<std::string> interactables(
            m_admission.composition_draft_interactable_ids.begin(),
            m_admission.composition_draft_interactable_ids.end());
        runtime::RoomCompositionDraftAccess access(draft, std::move(characters),
                                                   std::move(interactables));
        runtime::RuntimeCapabilityIssuer issuer(m_provider, m_generation);
        const auto capabilities = issuer.issue_room_composition(access);
        struct Close final {
            runtime::RoomCompositionDraftAccess& access;
            ~Close() { access.close(); }
        } close{access};

        std::string module_source;
        if (m_definition.source.inline_source) {
            module_source = m_definition.source.value;
        } else {
            auto loaded = m_scripts.read_script_source(m_definition.source.value);
            if (!loaded)
                return core::Result<void, core::Diagnostics>::failure({error(
                    "editor_preview.focused_composition_load_failed", loaded.error().message)});
            module_source = std::move(*loaded.value_if());
        }

        std::string invocation =
            "local __module = (function()\n" + module_source +
            "\nend)(); if type(__module) ~= 'table' then "
            "error('Room Hook Registry module must return a table') end; "
            "local __handler = __module[" +
            lua_quote(m_definition.export_name) +
            "]; if type(__handler) ~= 'function' then error('Room Compose hook export is not "
            "callable') end; "
            "local context = { room = " +
            lua_quote(visit.room.text()) + ", visit_index = " + std::to_string(visit.visit_index) +
            ", entry_sequence = " + std::to_string(visit.entry_sequence) + ", entry_cause = " +
            lua_quote(visit.entry_cause == core::RoomEntryCause::Entrypoint ? "entrypoint"
                      : visit.entry_cause == core::RoomEntryCause::NavigationAttempt
                          ? "navigation-attempt"
                          : "directed-room-change");
        if (visit.source_room)
            invocation += ", source_room = " + lua_quote(visit.source_room->text());
        if (visit.entry_exit)
            invocation += ", entry_room = " + lua_quote(visit.entry_exit->room.text()) +
                          ", entry_exit = " + lua_quote(visit.entry_exit->exit_id.text());
        invocation += " }; __handler(context, noveltea.room_presentation)";
        runtime::ScriptInvocationRequest call{.source = std::move(invocation),
                                              .chunk_name = "focused-room-compose-call",
                                              .owner = std::nullopt,
                                              .invocation = std::nullopt,
                                              .source_context = {},
                                              .result_kind =
                                                  runtime::ScriptInvocationResultKind::None,
                                              .asset_path = std::nullopt};
        auto invoked = m_scripts.invoke_in_environment(m_environment, call, capabilities);
        if (!invoked)
            return core::Result<void, core::Diagnostics>::failure(script_error(invoked.error()));
        if (!std::holds_alternative<runtime::ScriptInvocationCompleted>(*invoked.value_if()))
            return core::Result<void, core::Diagnostics>::failure(
                {error("editor_preview.focused_composition_yielded",
                       "Focused Room composition must complete synchronously")});
        return core::Result<void, core::Diagnostics>::success();
    }

private:
    const core::editor::TypedFocusedRoomCompositionDefinition& m_definition;
    const core::editor::TypedFocusedRoomLuaAdmission& m_admission;
    script::ScriptRuntime& m_scripts;
    script::ScriptEnvironmentHandle m_environment;
    runtime::RuntimeQueryProvider& m_provider;
    runtime::CapabilityGeneration m_generation;
};

core::Result<std::pair<core::RoomPresentationResolution,
                       std::vector<core::editor::TypedFocusedRoomLayoutDefinition>>,
             core::Diagnostics>
resolve_focused_room(const core::editor::TypedEditorRoomPreviewDocument& document,
                     script::ScriptRuntime& scripts, script::ScriptEnvironmentHandle environment,
                     runtime::RuntimeQueryProvider& provider,
                     runtime::CapabilityGeneration generation)
{
    core::RoomPresentationDefinitionView definition{
        .room = decoded_id<core::RoomId>(document.room_id),
        .background = {.asset = document.world.background.asset_id
                                    ? std::optional{decoded_id<core::AssetId>(
                                          *document.world.background.asset_id)}
                                    : std::nullopt,
                       .color = document.world.background.color,
                       .fit = document.world.background.fit == "contain"
                                  ? core::compiled::BackgroundFit::Contain
                              : document.world.background.fit == "stretch"
                                  ? core::compiled::BackgroundFit::Stretch
                              : document.world.background.fit == "center"
                                  ? core::compiled::BackgroundFit::Center
                                  : core::compiled::BackgroundFit::Cover,
                       .material = document.world.background.material_id
                                       ? std::optional{decoded_id<core::MaterialId>(
                                             *document.world.background.material_id)}
                                       : std::nullopt},
        .description = 0,
        .description_markup =
            document.ui.description.markup == core::editor::TypedFocusedText::Markup::ActiveText
                ? core::TextMarkup::ActiveText
                : core::TextMarkup::Plain,
        .character_defaults = {},
        .overlays = {},
        .cast = {},
        .interactables = {},
        .fallback_interactable_placement = std::nullopt,
        .props = {},
        .environments = {},
        .placements = {},
        .exits = {},
    };
    std::vector<const core::editor::TypedFocusedCondition*> conditions;
    std::vector<const core::editor::TypedFocusedText*> texts{&document.ui.description};
    const auto condition_token = [&](const auto& condition) {
        conditions.push_back(&condition);
        return conditions.size() - 1;
    };
    const auto text_token = [&](const auto& text) {
        texts.push_back(&text);
        return texts.size() - 1;
    };
    const auto add_character_defaults = [&](const std::string& character_id, const auto& visual) {
        const auto character = decoded_id<core::CharacterId>(character_id);
        if (std::none_of(definition.character_defaults.begin(), definition.character_defaults.end(),
                         [&](const auto& current) { return current.character == character; }))
            definition.character_defaults.push_back(
                {character, decoded_id<core::CharacterPresentationProfileId>(visual.profile_id),
                 decoded_id<core::CharacterPoseId>(visual.resolved_pose_id),
                 decoded_id<core::CharacterExpressionId>(visual.expression_id),
                 visual.appearance_id
                     ? std::optional{decoded_id<core::CharacterAppearanceId>(*visual.appearance_id)}
                     : std::nullopt,
                 visual.idle_id ? std::optional{decoded_id<core::CharacterIdleId>(*visual.idle_id)}
                                : std::nullopt});
    };
    for (const auto& character : document.world.persistent_characters)
        add_character_defaults(character.character_id, character.visual);
    for (const auto& cast : document.world.cast)
        add_character_defaults(cast.character_id, cast.visual);
    for (const auto& placement : document.world.placements)
        definition.placements.push_back(
            {decoded_id<core::RoomPlacementId>(placement.id),
             {placement.bounds.x, placement.bounds.y, placement.bounds.width,
              placement.bounds.height},
             placement.label ? std::optional{text_token(*placement.label)} : std::nullopt,
             placement.label &&
                     placement.label->markup == core::editor::TypedFocusedText::Markup::ActiveText
                 ? core::TextMarkup::ActiveText
                 : core::TextMarkup::Plain,
             placement.layout_id ? std::optional{decoded_id<core::LayoutId>(*placement.layout_id)}
                                 : std::nullopt,
             placement.order});
    for (const auto& overlay : document.world.overlays)
        definition.overlays.push_back({decoded_id<core::RoomOverlayId>(overlay.overlay_id),
                                       decoded_id<core::LayoutId>(overlay.layout_id),
                                       condition_token(overlay.condition), overlay.visible,
                                       overlay.order});
    for (const auto& cast : document.world.cast)
        definition.cast.push_back(
            {decoded_id<core::RoomCastEntryId>(cast.entry_id),
             decoded_id<core::CharacterId>(cast.character_id), condition_token(cast.condition),
             decoded_id<core::RoomPlacementId>(cast.placement_id),
             decoded_id<core::CharacterPresentationProfileId>(cast.visual.profile_id),
             decoded_id<core::CharacterPoseId>(cast.visual.resolved_pose_id),
             decoded_id<core::CharacterExpressionId>(cast.visual.expression_id),
             cast.visual.appearance_id ? std::optional{decoded_id<core::CharacterAppearanceId>(
                                             *cast.visual.appearance_id)}
                                       : std::nullopt,
             cast.visual.idle_id
                 ? std::optional{decoded_id<core::CharacterIdleId>(*cast.visual.idle_id)}
                 : std::nullopt,
             cast.occurrence_visible, cast.order});
    for (const auto& interactable : document.world.interactables)
        definition.interactables.push_back(
            {decoded_id<core::RoomInteractableEntryId>(interactable.occurrence_id),
             decoded_id<core::InteractableInstanceId>(interactable.interactable_id),
             condition_token(interactable.condition),
             decoded_id<core::RoomPlacementId>(interactable.placement_id),
             interactable.occurrence_visible, interactable.order});
    for (const auto& prop : document.world.props)
        definition.props.push_back(
            {decoded_id<core::RoomPropId>(prop.prop_id), condition_token(prop.condition),
             decoded_id<core::RoomPlacementId>(prop.placement_id),
             prop.asset_id ? std::optional{decoded_id<core::AssetId>(*prop.asset_id)}
                           : std::nullopt,
             prop.material_id ? std::optional{decoded_id<core::MaterialId>(*prop.material_id)}
                              : std::nullopt,
             prop.visible, prop.order});
    for (const auto& environment : document.world.environments)
        definition.environments.push_back(
            {decoded_id<core::RoomEnvironmentId>(environment.environment_id),
             condition_token(environment.condition),
             environment.asset_id ? std::optional{decoded_id<core::AssetId>(*environment.asset_id)}
                                  : std::nullopt,
             decoded_id<core::MaterialId>(environment.material_id),
             {environment.bounds.x, environment.bounds.y, environment.bounds.width,
              environment.bounds.height},
             environment.plane == "world-background" ? core::PresentationPlane::WorldBackground
             : environment.plane == "world-overlay"  ? core::PresentationPlane::WorldOverlay
                                                     : core::PresentationPlane::WorldContent,
             environment.order,
             environment.clock == "unscaled-presentation"
                 ? core::LayoutClockDomain::UnscaledPresentation
                 : core::LayoutClockDomain::Gameplay,
             {environment.scroll_per_second.x, environment.scroll_per_second.y},
             environment.opacity,
             environment.visible});
    const auto direction = [](const std::string& value) {
        using D = core::compiled::RoomExitDirection;
        return value == "northwest"   ? D::Northwest
               : value == "north"     ? D::North
               : value == "northeast" ? D::Northeast
               : value == "west"      ? D::West
               : value == "east"      ? D::East
               : value == "southwest" ? D::Southwest
               : value == "south"     ? D::South
               : value == "southeast" ? D::Southeast
                                      : D::Custom;
    };
    for (const auto& exit : document.ui.exits) {
        texts.push_back(nullptr);
        definition.exits.push_back({decoded_id<core::RoomExitId>(exit.exit_id),
                                    condition_token(exit.condition), direction(exit.direction),
                                    texts.size() - 1,
                                    decoded_id<core::RoomId>(exit.target_room_id)});
        // Exit labels are already resolved strings; the null token is handled below.
    }

    core::RoomPresentationStateView state;
    const auto append_character_state = [&](const core::CharacterId& id, bool enabled,
                                            bool visible) {
        if (std::none_of(state.characters.begin(), state.characters.end(),
                         [&](const auto& current) { return current.character == id; }))
            state.characters.push_back({id, enabled, visible});
    };
    for (const auto& character : document.world.persistent_characters)
        append_character_state(decoded_id<core::CharacterId>(character.character_id),
                               character.enabled, character.visible);
    for (const auto& cast : document.world.cast)
        append_character_state(decoded_id<core::CharacterId>(cast.character_id), cast.enabled,
                               cast.visible);
    for (const auto& interactable : document.world.interactables) {
        const auto id = decoded_id<core::InteractableInstanceId>(interactable.interactable_id);
        if (std::none_of(state.interactables.begin(), state.interactables.end(),
                         [&](const auto& current) { return current.interactable == id; }))
            state.interactables.push_back(
                {id, interactable.enabled, interactable.visible, true, std::nullopt});
    }

    std::vector<std::string> exit_labels;
    exit_labels.reserve(document.ui.exits.size());
    for (const auto& exit : document.ui.exits)
        exit_labels.push_back(exit.label);
    std::optional<FocusedRoomComposition> composition;
    if (document.composition)
        composition.emplace(*document.composition, document.lua_admission, scripts, environment,
                            provider, generation);
    core::RoomPresentationResolverCore resolver;
    auto resolved = resolver.resolve(
        definition, state,
        {definition.room, std::nullopt, std::nullopt, core::RoomEntryCause::Entrypoint, 1, 1},
        [&](core::RoomPresentationConditionToken token) {
            if (token >= conditions.size())
                return core::Result<bool, core::Diagnostics>::failure(
                    {error("editor_preview.room_condition_token_invalid",
                           "Focused Room condition token is invalid.")});
            return compare_scalar(document.query_state, *conditions[token], scripts, environment,
                                  provider, generation);
        },
        [&](core::RoomPresentationTextToken token) {
            if (token < texts.size() && texts[token] != nullptr) {
                if (texts[token]->source_kind ==
                    core::editor::TypedFocusedText::SourceKind::LuaExpression) {
                    runtime::RuntimeCapabilityIssuer issuer(provider, generation);
                    const auto capabilities =
                        issuer.issue(runtime::RuntimeCapabilityProfile::SynchronousExpression);
                    if (!capabilities)
                        return core::Result<std::string, core::Diagnostics>::failure(
                            {error("editor_preview.focused_lua_capabilities_failed",
                                   "Focused Lua expression capabilities could not be issued")});
                    runtime::ScriptInvocationRequest request{
                        .source = texts[token]->source,
                        .chunk_name = "focused-room-text",
                        .owner = std::nullopt,
                        .invocation = std::nullopt,
                        .source_context = {},
                        .result_kind = runtime::ScriptInvocationResultKind::String,
                        .asset_path = std::nullopt};
                    auto result =
                        scripts.invoke_in_environment(environment, request, *capabilities);
                    if (!result)
                        return core::Result<std::string, core::Diagnostics>::failure(
                            script_error(result.error()));
                    const auto* completed =
                        std::get_if<runtime::ScriptInvocationCompleted>(result.value_if());
                    if (completed != nullptr)
                        if (const auto* value = std::get_if<std::string>(&completed->value))
                            return core::Result<std::string, core::Diagnostics>::success(*value);
                    return core::Result<std::string, core::Diagnostics>::failure(
                        {error("editor_preview.focused_lua_result_invalid",
                               "Focused Lua text expression did not return a String")});
                }
                return core::Result<std::string, core::Diagnostics>::success(texts[token]->source);
            }
            const auto index = token - (texts.size() - exit_labels.size());
            if (index < exit_labels.size())
                return core::Result<std::string, core::Diagnostics>::success(exit_labels[index]);
            return core::Result<std::string, core::Diagnostics>::failure({error(
                "editor_preview.room_text_token_invalid", "Focused Room text token is invalid.")});
        },
        composition ? &*composition : nullptr);
    if (!resolved)
        return core::Result<std::pair<core::RoomPresentationResolution,
                                      std::vector<core::editor::TypedFocusedRoomLayoutDefinition>>,
                            core::Diagnostics>::failure(std::move(resolved).error());

    std::set<std::string> mounted_layout_ids;
    for (const auto& overlay : resolved.value_if()->presentation.overlays)
        mounted_layout_ids.insert(overlay.layout.text());
    std::vector<core::editor::TypedFocusedRoomLayoutDefinition> mounted;
    for (const auto& layout : document.layouts) {
        const bool is_mounted =
            layout.source_kind ==
                core::editor::TypedFocusedRoomLayoutDefinition::SourceKind::BuiltinGameHud ||
            (layout.layout_id && mounted_layout_ids.contains(*layout.layout_id));
        if (!is_mounted)
            continue;
        mounted.push_back(layout);
    }
    return core::Result<std::pair<core::RoomPresentationResolution,
                                  std::vector<core::editor::TypedFocusedRoomLayoutDefinition>>,
                        core::Diagnostics>::success({std::move(*resolved.value_if()),
                                                     std::move(mounted)});
}

core::RoomPresentationVisualCatalog
focused_visual_catalog(const core::editor::TypedEditorRoomPreviewDocument& document)
{
    core::RoomPresentationVisualCatalog result;
    for (const auto& placement : document.world.placements)
        result.placements.push_back({decoded_id<core::RoomPlacementId>(placement.id),
                                     {placement.bounds.x, placement.bounds.y,
                                      placement.bounds.width, placement.bounds.height},
                                     placement.order});
    const auto append_character = [&](const std::string& character_id, const auto& visual) {
        std::optional<core::compiled::CharacterIdle> idle;
        if (visual.idle && visual.idle_id) {
            const auto kind = visual.idle->kind == "sway" ? core::compiled::CharacterIdleKind::Sway
                              : visual.idle->kind == "pulse"
                                  ? core::compiled::CharacterIdleKind::Pulse
                                  : core::compiled::CharacterIdleKind::Bob;
            idle =
                core::compiled::CharacterIdle{decoded_id<core::CharacterIdleId>(*visual.idle_id),
                                              kind, visual.idle->amplitude, visual.idle->period_ms,
                                              visual.idle->clock == "unscaled-presentation"
                                                  ? core::LayoutClockDomain::UnscaledPresentation
                                                  : core::LayoutClockDomain::Gameplay};
        }
        std::vector<core::PresentationActorLayer> layers;
        layers.reserve(visual.layers.size());
        for (const auto& layer : visual.layers)
            layers.push_back({decoded_id<core::CharacterPresentationLayerId>(layer.id),
                              layer.role,
                              layer.sprite_asset_id
                                  ? std::optional{decoded_id<core::AssetId>(*layer.sprite_asset_id)}
                                  : std::nullopt,
                              layer.material_id
                                  ? std::optional{decoded_id<core::MaterialId>(*layer.material_id)}
                                  : std::nullopt,
                              {layer.anchor.x, layer.anchor.y},
                              {layer.offset.x, layer.offset.y},
                              layer.scale,
                              layer.visible});
        result.characters.push_back(
            {decoded_id<core::CharacterId>(character_id),
             decoded_id<core::CharacterPresentationProfileId>(visual.profile_id),
             decoded_id<core::CharacterPoseId>(visual.resolved_pose_id),
             decoded_id<core::CharacterExpressionId>(visual.expression_id),
             visual.appearance_id
                 ? std::optional{decoded_id<core::CharacterAppearanceId>(*visual.appearance_id)}
                 : std::nullopt,
             visual.idle_id ? std::optional{decoded_id<core::CharacterIdleId>(*visual.idle_id)}
                            : std::nullopt,
             std::move(layers), std::move(idle)});
    };
    for (const auto& character : document.world.persistent_characters)
        append_character(character.character_id, character.visual);
    for (const auto& cast : document.world.cast)
        append_character(cast.character_id, cast.visual);
    for (const auto& interactable : document.world.interactables)
        result.interactables.push_back(
            {decoded_id<core::InteractableInstanceId>(interactable.interactable_id),
             interactable.sprite_asset_id
                 ? std::optional{decoded_id<core::AssetId>(*interactable.sprite_asset_id)}
                 : std::nullopt,
             interactable.material_id
                 ? std::optional{decoded_id<core::MaterialId>(*interactable.material_id)}
                 : std::nullopt});
    return result;
}

} // namespace

FocusedPreviewPresenter::FocusedPreviewPresenter(Dependencies dependencies) noexcept
    : m_dependencies(std::move(dependencies)),
      m_publication_scope(m_dependencies.assets,
                          assets::MandatoryPublicationScopeKind::FocusedPreview),
      m_passive_input(*this)
{
}

FocusedPreviewPresenter::~FocusedPreviewPresenter() { clear(); }

bool FocusedPreviewPresenter::dispatch_layout_event(core::MountedLayoutOwner owner,
                                                    const std::function<bool()>& dispatch)
{
    if (owner != core::MountedLayoutOwner::Gameplay || !dispatch || !m_committed.query_provider ||
        !m_committed.script_environment)
        return false;
    const auto generation =
        runtime::CapabilityGeneration::from_number(m_committed.owner.apply_sequence);
    if (!generation)
        return false;
    runtime::RuntimeCapabilityIssuer issuer(*m_committed.query_provider, *generation);
    auto capabilities = issuer.issue(runtime::RuntimeCapabilityProfile::GameplayLayoutEvent);
    if (!capabilities)
        return false;
    auto activation = m_dependencies.scripts.activate_environment(m_committed.script_environment);
    if (!activation)
        return false;
    m_dependencies.scripts.replace_runtime_capabilities(*capabilities);
    const bool consumed = dispatch();
    m_dependencies.scripts.clear_runtime_capabilities();
    return consumed;
}

void FocusedPreviewPresenter::clear() noexcept
{
    supersede_candidate();
    m_dependencies.layouts.clear_focused_preview();
    m_dependencies.world.reset();
    m_dependencies.world_resources.clear();
    m_publication_scope.clear_on_owner();
    release_state(m_committed);
    release_state(m_rollback);
    m_project_instance_id.clear();
    m_latest_apply_sequence = 0;
    m_resource_generation = 0;
}

void FocusedPreviewPresenter::release_state(FocusedState& state) noexcept
{
    if (state.query_provider)
        state.query_provider->close();
    if (state.script_environment)
        m_dependencies.scripts.destroy_environment(state.script_environment);
    state = {};
}

void FocusedPreviewPresenter::supersede_candidate()
{
    if (m_non_room_candidate) {
        m_non_room_candidate->asset_group->cancel_on_owner();
        m_dependencies.complete(m_non_room_candidate->request, "superseded", {});
        m_non_room_candidate.reset();
    }
    if (!m_candidate)
        return;
    m_candidate->asset_group->cancel_on_owner();
    release_state(m_candidate->state);
    m_dependencies.complete(m_candidate->request, "superseded", {});
    m_candidate.reset();
}

core::Result<std::vector<assets::StructuredAssetRequestDescriptor>, core::Diagnostics>
FocusedPreviewPresenter::build_asset_requests(
    const core::editor::FocusedEditorDocumentRequest& request,
    const ShaderMaterialProject& materials, assets::AssetSourceGeneration generation)
{
    std::vector<assets::StructuredAssetRequestDescriptor> result;
    std::optional<std::string> active_shader_variant;
    for (const auto& resource : request.resources) {
        if (resource.source_kind == "shader-compiled-output" && resource.shader_variant) {
            const auto variant = std::string(shader_variant_name(*resource.shader_variant));
            if (active_shader_variant && *active_shader_variant != variant) {
                return core::Result<std::vector<assets::StructuredAssetRequestDescriptor>,
                                    core::Diagnostics>::
                    failure(
                        {error("editor_preview.shader_variant_conflict",
                               "Focused resources contain more than one active Shader variant")});
            }
            active_shader_variant = std::move(variant);
        }
        if (resource.source_kind != "authoring-asset")
            continue;
        const auto& path = resource.logical_path;
        if (resource.kind == "image") {
            const assets::TextureAssetRequest typed{
                .path = path,
                .sampler = resource.sampling == "nearest" ? MaterialTextureSampler::ClampNearest
                                                          : MaterialTextureSampler::ClampLinear,
                .retain_alpha_coverage = resource.retain_alpha_coverage};
            result.push_back(
                {.request = typed, .cache_key = assets::make_texture_cache_key(typed, generation)});
        } else if (resource.kind == "font") {
            const assets::FontAssetRequest typed{
                .alias = resource.asset_id.value_or(resource.resource_id),
                .source_path = resource.logical_path};
            result.push_back(
                {.request = typed, .cache_key = assets::make_font_cache_key(typed, generation)});
        }
    }
    std::unordered_set<std::string> shader_program_keys;
    for (const auto& material : materials.materials) {
        const assets::MaterialAssetRequest typed{.id = material.id.string()};
        result.push_back(
            {.request = typed, .cache_key = assets::make_material_cache_key(typed, generation)});
        if (!active_shader_variant) {
            return core::Result<std::vector<assets::StructuredAssetRequestDescriptor>,
                                core::Diagnostics>::
                failure({error("editor_preview.shader_variant_missing",
                               "Focused materials require an active compiled Shader variant")});
        }
        const auto resolved =
            resolve_material_shader_program(materials, material.id, *active_shader_variant);
        if (!resolved.program) {
            return core::Result<
                std::vector<assets::StructuredAssetRequestDescriptor>,
                core::Diagnostics>::failure({error("editor_preview.shader_program_unresolved",
                                                   "Focused Material '" + material.id.string() +
                                                       "' has no resolvable program for variant '" +
                                                       *active_shader_variant + "'")});
        }
        const assets::ShaderProgramAssetRequest program{.resolution = *resolved.program};
        const auto key = assets::make_shader_program_cache_key(program, generation);
        if (shader_program_keys.insert(key.stable_identity).second)
            result.push_back({.request = program, .cache_key = key});
    }
    return core::Result<std::vector<assets::StructuredAssetRequestDescriptor>,
                        core::Diagnostics>::success(std::move(result));
}

core::Result<FocusedPreviewPresenter::FocusedState, core::Diagnostics>
FocusedPreviewPresenter::prepare_room_state(
    const core::editor::FocusedEditorDocumentRequest& request,
    const core::editor::TypedEditorRoomPreviewDocument& document,
    std::vector<core::editor::TypedFocusedRoomLayoutDefinition>& mounted_layouts)
{
    FocusedState state;
    state.owner = {.kind = FocusedContentKind::Room,
                   .project_instance_id = request.project_instance_id,
                   .record_id = request.record_id,
                   .revision = request.revision,
                   .apply_sequence = request.apply_sequence};
    state.environment = document.environment;
    state.materials = document.shader_materials;
    state.world = document.world;
    state.query_state = document.query_state;
    state.composition = document.composition;
    state.composition_execution_prepared = false;
    state.world_revision = request.apply_sequence;
    const auto generation = runtime::CapabilityGeneration::from_number(request.apply_sequence);
    if (!generation)
        return core::Result<FocusedState, core::Diagnostics>::failure(
            {error("editor_preview.focused_generation_invalid",
                   "Focused preview apply sequence must be nonzero")});
    auto environment = m_dependencies.scripts.create_environment();
    if (!environment)
        return core::Result<FocusedState, core::Diagnostics>::failure(
            script_error(environment.error()));
    state.script_environment = *environment.value_if();
    state.query_provider = std::make_shared<FocusedRoomQueryProvider>(
        document.lua_admission, document.query_state, *generation);
    for (const auto& resource : request.resources) {
        if (resource.source_kind != "authoring-asset" || resource.kind != "image" ||
            !resource.asset_id)
            continue;
        const auto asset_id = core::AssetId::create(*resource.asset_id);
        if (!asset_id)
            continue;
        state.world_catalog.images.push_back(
            {.asset_id = *asset_id.value_if(),
             .logical_path = resource.logical_path,
             .sampler = resource.sampling == "nearest" ? MaterialTextureSampler::ClampNearest
                                                       : MaterialTextureSampler::ClampLinear});
    }
    for (const auto& layout : document.layouts)
        state.layout_instance_ids.push_back(layout.instance_id);
    auto resolution =
        resolve_focused_room(document, m_dependencies.scripts, state.script_environment,
                             *state.query_provider, *generation);
    if (!resolution) {
        release_state(state);
        return core::Result<FocusedState, core::Diagnostics>::failure(
            std::move(resolution).error());
    }
    state.room_resolution = std::move(resolution.value_if()->first);
    mounted_layouts = std::move(resolution.value_if()->second);
    auto snapshot = core::RoomPresentationSnapshotProjector::project(
        *state.room_resolution, focused_visual_catalog(document));
    if (!snapshot) {
        release_state(state);
        return core::Result<FocusedState, core::Diagnostics>::failure(std::move(snapshot).error());
    }
    snapshot.value_if()->revision =
        core::PresentationSnapshotRevision::from_number(request.apply_sequence);
    snapshot.value_if()->camera =
        core::PresentationCamera{{.size = document.world.presentation_space.size,
                                  .bounds = document.world.presentation_space.bounds,
                                  .edge_policy = document.world.presentation_space.edge_policy,
                                  .default_view = document.world.presentation_space.view,
                                  .views = {}},
                                 document.world.presentation_space.view};
    state.snapshot = std::move(*snapshot.value_if());
    state.static_gameplay_values.mode = "room";
    state.static_gameplay_values.room = state.room_resolution->view;
    state.static_gameplay_values.inventory = {};
    state.static_gameplay_values.text_log = {};
    return core::Result<FocusedState, core::Diagnostics>::success(std::move(state));
}

bool FocusedPreviewPresenter::apply(core::editor::FocusedEditorDocumentRequest request)
{
    if (request.project_instance_id != m_project_instance_id) {
        supersede_candidate();
        m_dependencies.layouts.clear_focused_preview();
        m_dependencies.world.reset();
        m_dependencies.world_resources.clear();
        m_publication_scope.clear_on_owner();
        release_state(m_committed);
        release_state(m_rollback);
        m_project_instance_id = request.project_instance_id;
        m_latest_apply_sequence = 0;
        m_resource_generation = 0;
    }
    if (request.apply_sequence == 0 || request.apply_sequence <= m_latest_apply_sequence) {
        m_dependencies.report({error("editor_preview.stale_apply_sequence",
                                     "Focused preview apply sequence is stale or invalid.")});
        return false;
    }
    m_latest_apply_sequence = request.apply_sequence;
    supersede_candidate();
    if (request.resource_stage_generation < m_resource_generation) {
        m_dependencies.report({error("editor_preview.stale_resource_generation",
                                     "Focused preview resource generation is stale.")});
        return false;
    }
    if (request.resource_stage_generation > m_resource_generation) {
        auto refreshed = m_dependencies.assets.refresh_namespace_on_owner("project");
        if (!refreshed) {
            m_dependencies.report({std::move(refreshed).error()});
            return false;
        }
        m_resource_generation = request.resource_stage_generation;
    }

    if (request.kind != core::editor::FocusedEditorDocumentKind::Room) {
        const auto kind = request.kind == core::editor::FocusedEditorDocumentKind::Layout
                              ? "layout-preview"
                              : "shader-preview";
        auto decoded = core::editor::decode_editor_preview_document_text(kind, request.data_json);
        if (!decoded) {
            m_dependencies.report(std::move(decoded).error());
            return false;
        }
        ShaderMaterialProject materials;
        std::visit(
            [&](const auto& document) {
                using T = std::decay_t<decltype(document)>;
                if constexpr (std::is_same_v<T, core::editor::TypedEditorLayoutPreviewDocument>) {
                    if (document.shader_materials)
                        materials = *document.shader_materials;
                } else {
                    materials = document.shader_materials;
                    if (!document.preview_material_id.empty() && !document.shader_id.empty())
                        upsert_preview_material(materials, document.preview_material_id,
                                                document.shader_id);
                }
            },
            *decoded.value_if());
        const auto source_generation = m_dependencies.assets.source_generation_on_owner();
        auto requests = build_asset_requests(request, materials, source_generation);
        if (!requests) {
            auto diagnostics = std::move(requests).error();
            m_dependencies.report(diagnostics);
            m_dependencies.complete(request, "failed", diagnostics);
            return false;
        }
        m_dependencies.bind_candidate_materials(&materials);
        auto group = std::make_unique<assets::MandatoryAssetRequestGroup>(
            m_dependencies.assets, std::move(*requests.value_if()),
            assets::MandatoryAssetGroupOptions{.show_overlay_immediately = false,
                                               .presentation_revision = std::nullopt});
        m_dependencies.bind_candidate_materials(nullptr);
        m_non_room_candidate = NonRoomCandidate{
            .request = std::move(request),
            .document = std::move(*decoded.value_if()),
            .materials = std::move(materials),
            .source_generation = source_generation,
            .asset_group = std::move(group),
        };
        return true;
    }

    auto decoded = core::editor::decode_editor_room_preview_document_text(request.data_json);
    if (!decoded) {
        m_dependencies.report(std::move(decoded).error());
        return false;
    }
    auto manifest_closure = validate_room_manifest_closure(request, *decoded.value_if());
    if (!manifest_closure) {
        auto diagnostics = std::move(manifest_closure).error();
        m_dependencies.report(diagnostics);
        m_dependencies.complete(request, "failed", diagnostics);
        return false;
    }
    std::vector<core::editor::TypedFocusedRoomLayoutDefinition> mounted_layouts;
    auto prepared = prepare_room_state(request, *decoded.value_if(), mounted_layouts);
    if (!prepared) {
        auto diagnostics = std::move(prepared).error();
        m_dependencies.report(diagnostics);
        m_dependencies.complete(request, "failed", diagnostics);
        return false;
    }
    const auto source_generation = m_dependencies.assets.source_generation_on_owner();
    auto requests =
        build_asset_requests(request, decoded.value_if()->shader_materials, source_generation);
    if (!requests) {
        auto diagnostics = std::move(requests).error();
        auto prepared_state = std::move(*prepared.value_if());
        release_state(prepared_state);
        m_dependencies.report(diagnostics);
        m_dependencies.complete(request, "failed", diagnostics);
        return false;
    }
    m_dependencies.bind_candidate_materials(&decoded.value_if()->shader_materials);
    auto group = std::make_unique<assets::MandatoryAssetRequestGroup>(
        m_dependencies.assets, std::move(*requests.value_if()),
        assets::MandatoryAssetGroupOptions{.show_overlay_immediately = false,
                                           .presentation_revision = std::nullopt});
    m_dependencies.bind_candidate_materials(nullptr);
    m_candidate = Candidate{.request = std::move(request),
                            .document = std::move(*decoded.value_if()),
                            .state = std::move(*prepared.value_if()),
                            .mounted_layouts = std::move(mounted_layouts),
                            .source_generation = source_generation,
                            .asset_group = std::move(group),
                            .prepared_world_resources = nullptr,
                            .prepared_world = nullptr};
    return true;
}

void FocusedPreviewPresenter::fail_candidate(core::Diagnostics diagnostics)
{
    if (!m_candidate)
        return;
    m_dependencies.complete(m_candidate->request, "failed", diagnostics);
    release_state(m_candidate->state);
    m_candidate.reset();
}

void FocusedPreviewPresenter::fail_non_room_candidate(core::Diagnostics diagnostics)
{
    if (!m_non_room_candidate)
        return;
    m_dependencies.complete(m_non_room_candidate->request, "failed", diagnostics);
    m_non_room_candidate.reset();
}

void FocusedPreviewPresenter::commit_non_room_candidate(assets::StructuredAssetLeaseSet leases)
{
    if (!m_non_room_candidate)
        return;
    auto candidate = std::move(*m_non_room_candidate);
    m_non_room_candidate.reset();
    if (candidate.request.project_instance_id != m_project_instance_id ||
        candidate.request.apply_sequence != m_latest_apply_sequence) {
        candidate.asset_group->cancel_on_owner();
        m_dependencies.complete(candidate.request, "superseded", {});
        return;
    }
    auto transaction = m_publication_scope.begin_transaction_on_owner(std::move(leases),
                                                                      candidate.source_generation);
    FocusedState prepared_state;
    prepared_state.owner = {.kind = owner_kind(candidate.request.kind),
                            .project_instance_id = candidate.request.project_instance_id,
                            .record_id = candidate.request.record_id,
                            .revision = candidate.request.revision,
                            .apply_sequence = candidate.request.apply_sequence};
    prepared_state.materials = candidate.materials;

    const auto fail = [&](core::Diagnostics diagnostics) {
        m_dependencies.layouts.rollback_focused_preview();
        release_state(prepared_state);
        m_dependencies.report(diagnostics);
        m_dependencies.complete(candidate.request, "failed", diagnostics);
    };

    std::function<void()> environment_commit;
    core::Diagnostics preparation_diagnostics;
    bool prepared = std::visit(
        [&](const auto& document) {
            using T = std::decay_t<decltype(document)>;
            if constexpr (std::is_same_v<T, core::editor::TypedEditorLayoutPreviewDocument>) {
                if (!m_dependencies.prepare_layout_environment) {
                    preparation_diagnostics = {
                        error("editor_preview.layout_environment_unavailable",
                              "Focused Layout environment preparation is not configured")};
                    return false;
                }
                if (!m_dependencies.standalone_layout_style_prefix) {
                    preparation_diagnostics = {
                        error("editor_preview.layout_style_defaults_unavailable",
                              "Focused Layout preview style defaults are not configured")};
                    return false;
                }
                auto environment = m_dependencies.prepare_layout_environment(document.environment);
                if (!environment) {
                    preparation_diagnostics = std::move(environment).error();
                    return false;
                }
                environment_commit = std::move(*environment.value_if());
                if (!environment_commit) {
                    preparation_diagnostics = {
                        error("editor_preview.layout_environment_commit_missing",
                              "Focused Layout environment preparation returned no commit")};
                    return false;
                }

                const auto generation =
                    runtime::CapabilityGeneration::from_number(candidate.request.apply_sequence);
                if (!generation) {
                    preparation_diagnostics = {
                        error("editor_preview.focused_layout_generation_invalid",
                              "Focused Layout apply sequence must be nonzero")};
                    return false;
                }
                auto script_environment = m_dependencies.scripts.create_environment();
                if (!script_environment) {
                    preparation_diagnostics = script_error(script_environment.error());
                    return false;
                }
                prepared_state.script_environment = *script_environment.value_if();
                prepared_state.query_provider = std::make_shared<FocusedRoomQueryProvider>(
                    core::editor::TypedFocusedRoomLuaAdmission{},
                    core::editor::TypedFocusedRoomQueryState{}, *generation);
                runtime::RuntimeCapabilityIssuer issuer(*prepared_state.query_provider,
                                                        *generation);
                const auto capabilities =
                    issuer.issue(runtime::RuntimeCapabilityProfile::GameplayLayoutEvent);
                if (!capabilities) {
                    preparation_diagnostics = {
                        error("editor_preview.focused_layout_capabilities_failed",
                              "Focused Layout capabilities could not be issued")};
                    return false;
                }
                m_dependencies.bind_candidate_materials(&candidate.materials);
                auto staged = m_dependencies.layouts.stage_focused_preview(
                    {standalone_layout_definition(
                        document, m_dependencies.standalone_layout_style_prefix(
                                      document.layout_kind ==
                                      core::editor::EditorPreviewLayoutKind::Fragment))},
                    m_dependencies.scripts, prepared_state.script_environment, *capabilities);
                m_dependencies.bind_candidate_materials(nullptr);
                if (!staged) {
                    preparation_diagnostics = std::move(staged).error();
                    return false;
                }
                return true;
            } else {
                if (!m_dependencies.active_shader_variant) {
                    preparation_diagnostics = {
                        error("preview.shader.variant_unavailable",
                              "The active renderer Shader variant is not available.")};
                    return false;
                }
                if (shader_variant_name(document.active_shader_variant) !=
                    m_dependencies.active_shader_variant()) {
                    preparation_diagnostics = {
                        error("preview.shader.variant_mismatch",
                              "Focused Shader document variant does not match the active renderer.",
                              "/activeShaderVariant")};
                    return false;
                }
                if (!m_dependencies.prepare_clear_environment) {
                    preparation_diagnostics = {
                        error("editor_preview.shader_environment_unavailable",
                              "Focused Shader environment preparation is not configured")};
                    return false;
                }
                auto environment = m_dependencies.prepare_clear_environment();
                if (!environment) {
                    preparation_diagnostics = std::move(environment).error();
                    return false;
                }
                environment_commit = std::move(*environment.value_if());
                if (!environment_commit) {
                    preparation_diagnostics = {
                        error("editor_preview.shader_environment_commit_missing",
                              "Focused Shader environment preparation returned no commit")};
                    return false;
                }
                m_dependencies.bind_candidate_materials(&candidate.materials);
                auto staged = m_dependencies.layouts.stage_focused_preview(
                    {shader_layout_definition(document)});
                m_dependencies.bind_candidate_materials(nullptr);
                if (!staged) {
                    preparation_diagnostics = std::move(staged).error();
                    return false;
                }
                return true;
            }
        },
        candidate.document);
    if (!prepared) {
        fail(std::move(preparation_diagnostics));
        return;
    }

    auto committed = transaction.commit_on_owner(false);
    if (!committed) {
        fail({std::move(committed).error()});
        return;
    }

    environment_commit();
    m_dependencies.apply_materials(candidate.materials);
    m_dependencies.bind_input_sink(&m_passive_input);
    if (m_dependencies.retire_legacy_preview)
        m_dependencies.retire_legacy_preview();
    m_dependencies.layouts.commit_focused_preview();
    m_dependencies.world.reset();
    m_dependencies.world_resources.clear();
    release_state(m_rollback);
    m_rollback = std::move(m_committed);
    m_committed = std::move(prepared_state);
    m_dependencies.complete(candidate.request, "applied", {});
}

void FocusedPreviewPresenter::commit_candidate(assets::StructuredAssetLeaseSet leases)
{
    if (!m_candidate)
        return;
    auto candidate = std::move(*m_candidate);
    m_candidate.reset();
    if (candidate.request.project_instance_id != m_project_instance_id ||
        candidate.request.apply_sequence != m_latest_apply_sequence) {
        candidate.asset_group->cancel_on_owner();
        m_dependencies.complete(candidate.request, "superseded", {});
        release_state(candidate.state);
        return;
    }
    auto transaction = m_publication_scope.begin_transaction_on_owner(std::move(leases),
                                                                      candidate.source_generation);
    const auto generation =
        runtime::CapabilityGeneration::from_number(candidate.request.apply_sequence);
    if (!generation) {
        m_dependencies.complete(candidate.request, "failed",
                                {error("editor_preview.focused_layout_capabilities_failed",
                                       "Focused Layout capabilities could not be issued")});
        release_state(candidate.state);
        return;
    }
    runtime::RuntimeCapabilityIssuer layout_issuer(*candidate.state.query_provider, *generation);
    const auto layout_capabilities =
        layout_issuer.issue(runtime::RuntimeCapabilityProfile::GameplayLayoutEvent);
    if (!layout_capabilities) {
        m_dependencies.complete(candidate.request, "failed",
                                {error("editor_preview.focused_layout_capabilities_failed",
                                       "Focused Layout capabilities could not be issued")});
        release_state(candidate.state);
        return;
    }
    auto layout_result = m_dependencies.layouts.stage_focused_preview(
        candidate.mounted_layouts, m_dependencies.scripts, candidate.state.script_environment,
        *layout_capabilities);
    if (!layout_result) {
        m_dependencies.complete(candidate.request, "failed", std::move(layout_result).error());
        release_state(candidate.state);
        return;
    }
    candidate.prepared_world_resources =
        std::make_unique<AssetWorldPresentationResourceResolver>(m_dependencies.assets);
    candidate.prepared_world_resources->bind_catalog(candidate.state.world_catalog);
    candidate.prepared_world =
        std::make_unique<WorldPresentationBackend>(*candidate.prepared_world_resources);
    if (!candidate.state.snapshot) {
        m_dependencies.layouts.rollback_focused_preview();
        m_dependencies.complete(candidate.request, "failed",
                                {error("editor_preview.room_snapshot_missing",
                                       "Focused Room candidate has no prepared snapshot.")});
        release_state(candidate.state);
        return;
    }
    auto world_result = candidate.prepared_world->reconcile(
        *candidate.state.snapshot,
        {static_cast<float>(candidate.document.environment.reference_resolution.width),
         static_cast<float>(candidate.document.environment.reference_resolution.height)});
    if (!world_result) {
        m_dependencies.layouts.rollback_focused_preview();
        m_dependencies.complete(candidate.request, "failed", std::move(world_result).error());
        release_state(candidate.state);
        return;
    }
    auto prepared_environment = m_dependencies.prepare_environment(*candidate.state.environment);
    if (!prepared_environment) {
        m_dependencies.layouts.rollback_focused_preview();
        m_dependencies.complete(candidate.request, "failed",
                                std::move(prepared_environment).error());
        release_state(candidate.state);
        return;
    }
    auto prepared_ui = m_dependencies.prepare_ui_values(RuntimeUiGameplayValues{
        candidate.request.apply_sequence, candidate.state.static_gameplay_values});
    if (!prepared_ui) {
        m_dependencies.layouts.rollback_focused_preview();
        m_dependencies.complete(candidate.request, "failed", std::move(prepared_ui).error());
        release_state(candidate.state);
        return;
    }
    auto environment_commit = std::move(*prepared_environment.value_if());
    auto ui_commit = std::move(*prepared_ui.value_if());
    auto committed = transaction.commit_on_owner(false);
    if (!committed) {
        m_dependencies.layouts.rollback_focused_preview();
        auto diagnostics = core::Diagnostics{std::move(committed).error()};
        m_dependencies.report(diagnostics);
        m_dependencies.complete(candidate.request, "failed", diagnostics);
        release_state(candidate.state);
        return;
    }
    environment_commit();
    if (candidate.state.materials)
        m_dependencies.apply_materials(*candidate.state.materials);
    m_dependencies.commit_ui_values(std::move(ui_commit));
    m_dependencies.bind_input_sink(&m_passive_input);
    if (m_dependencies.retire_legacy_preview)
        m_dependencies.retire_legacy_preview();
    m_dependencies.layouts.commit_focused_preview();
    m_dependencies.world_resources.bind_catalog(candidate.state.world_catalog);
    m_dependencies.world.swap_prepared(*candidate.prepared_world);
    candidate.state.passive_input_baseline = m_passive_input.baseline;
    release_state(m_rollback);
    m_rollback = std::move(m_committed);
    m_committed = std::move(candidate.state);
    m_dependencies.complete(candidate.request, "applied", {});
}

void FocusedPreviewPresenter::update()
{
    if (m_non_room_candidate) {
        m_non_room_candidate->asset_group->poll_on_owner();
        switch (m_non_room_candidate->asset_group->state_on_owner()) {
        case assets::MandatoryAssetGroupState::Pending:
            break;
        case assets::MandatoryAssetGroupState::Failed:
        case assets::MandatoryAssetGroupState::Canceled:
            fail_non_room_candidate(
                {error("editor_preview.non_room_candidate_failed",
                       "Focused Layout or Shader candidate asset preparation failed.")});
            break;
        case assets::MandatoryAssetGroupState::Ready: {
            auto leases = m_non_room_candidate->asset_group->take_ready_leases_on_owner();
            if (!leases) {
                fail_non_room_candidate(
                    {error("editor_preview.non_room_candidate_leases_missing",
                           "Focused candidate completed without typed leases.")});
            } else {
                commit_non_room_candidate(std::move(*leases));
            }
            break;
        }
        }
    }
    if (!m_candidate)
        return;
    m_candidate->asset_group->poll_on_owner();
    switch (m_candidate->asset_group->state_on_owner()) {
    case assets::MandatoryAssetGroupState::Pending:
        return;
    case assets::MandatoryAssetGroupState::Failed:
    case assets::MandatoryAssetGroupState::Canceled:
        fail_candidate({error("editor_preview.room_candidate_failed",
                              "Focused Room candidate asset preparation failed.")});
        return;
    case assets::MandatoryAssetGroupState::Ready:
        break;
    }
    auto leases = m_candidate->asset_group->take_ready_leases_on_owner();
    if (!leases) {
        fail_candidate({error("editor_preview.room_candidate_leases_missing",
                              "Focused Room candidate completed without typed leases.")});
        return;
    }
    commit_candidate(std::move(*leases));
}

} // namespace noveltea::host
