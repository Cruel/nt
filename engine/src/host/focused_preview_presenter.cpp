#include "host/focused_preview_presenter.hpp"

#include "noveltea/assets/asset_cache_keys.hpp"
#include "noveltea/core/editor_runtime_protocol.hpp"
#include "noveltea/presentation/room_presentation.hpp"
#include "ui/rmlui/runtime_ui.hpp"

#include <algorithm>
#include <cmath>
#include <set>
#include <utility>

namespace noveltea::host {
namespace {

core::Diagnostic error(std::string code, std::string message, std::string pointer = {})
{
    return {
        .code = std::move(code), .message = std::move(message), .json_pointer = std::move(pointer)};
}

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
               const core::editor::TypedFocusedCondition& condition)
{
    if (condition.kind == core::editor::TypedFocusedCondition::Kind::Always)
        return core::Result<bool, core::Diagnostics>::success(true);
    if (condition.kind == core::editor::TypedFocusedCondition::Kind::LuaPredicate)
        return core::Result<bool, core::Diagnostics>::failure(
            {error("editor_preview.room_lua_predicate_requires_phase_12",
                   "Focused Room Lua predicates are unavailable until Phase 12.")});
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

core::Result<std::pair<core::RoomPresentationResolution,
                       std::vector<core::editor::TypedFocusedRoomLayoutDefinition>>,
             core::Diagnostics>
resolve_focused_room(const core::editor::TypedEditorRoomPreviewDocument& document)
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
        .props = {},
        .environments = {},
        .placements = {},
        .exits = {},
        .has_composition = document.composition.has_value(),
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
                {character, decoded_id<core::CharacterPoseId>(visual.resolved_pose_id),
                 decoded_id<core::CharacterExpressionId>(visual.expression_id),
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
             decoded_id<core::CharacterPoseId>(cast.visual.resolved_pose_id),
             decoded_id<core::CharacterExpressionId>(cast.visual.expression_id),
             cast.visual.idle_id
                 ? std::optional{decoded_id<core::CharacterIdleId>(*cast.visual.idle_id)}
                 : std::nullopt,
             cast.visible, cast.order});
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
    for (const auto& character : document.world.persistent_characters)
        state.characters.push_back({decoded_id<core::CharacterId>(character.character_id),
                                    decoded_id<core::RoomPlacementId>(character.placement_id),
                                    character.enabled, character.visible});
    for (const auto& interactable : document.world.interactables)
        state.interactables.push_back(
            {decoded_id<core::InteractableId>(interactable.interactable_id),
             decoded_id<core::RoomPlacementId>(interactable.placement_id), interactable.enabled,
             interactable.visible});

    std::vector<std::string> exit_labels;
    exit_labels.reserve(document.ui.exits.size());
    for (const auto& exit : document.ui.exits)
        exit_labels.push_back(exit.label);
    core::RoomPresentationResolverCore resolver;
    auto resolved = resolver.resolve(
        definition, state, {definition.room, std::nullopt, std::nullopt, 1},
        [&](core::RoomPresentationConditionToken token) {
            if (token >= conditions.size())
                return core::Result<bool, core::Diagnostics>::failure(
                    {error("editor_preview.room_condition_token_invalid",
                           "Focused Room condition token is invalid.")});
            return compare_scalar(document.query_state, *conditions[token]);
        },
        [&](core::RoomPresentationTextToken token) {
            if (token < texts.size() && texts[token] != nullptr) {
                if (texts[token]->source_kind ==
                    core::editor::TypedFocusedText::SourceKind::LuaExpression)
                    return core::Result<std::string, core::Diagnostics>::failure({error(
                        "editor_preview.room_lua_expression_requires_phase_12",
                        "Focused Room Lua text expressions are unavailable until Phase 12.")});
                return core::Result<std::string, core::Diagnostics>::success(texts[token]->source);
            }
            const auto index = token - (texts.size() - exit_labels.size());
            if (index < exit_labels.size())
                return core::Result<std::string, core::Diagnostics>::success(exit_labels[index]);
            return core::Result<std::string, core::Diagnostics>::failure({error(
                "editor_preview.room_text_token_invalid", "Focused Room text token is invalid.")});
        });
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
        if (layout.script_enabled && layout.contains_dedicated_lua_source)
            return core::Result<
                std::pair<core::RoomPresentationResolution,
                          std::vector<core::editor::TypedFocusedRoomLayoutDefinition>>,
                core::Diagnostics>::
                failure(
                    {error("editor_preview.room_layout_lua_requires_phase_12",
                           "Mounted focused Layout dedicated Lua is unavailable until Phase 12.")});
        if (layout.contains_executable_rml_lua)
            return core::Result<
                std::pair<core::RoomPresentationResolution,
                          std::vector<core::editor::TypedFocusedRoomLayoutDefinition>>,
                core::Diagnostics>::
                failure({error("editor_preview.room_rml_lua_requires_phase_12",
                               "Mounted focused Layout RML Lua is unavailable until Phase 12.")});
        mounted.push_back(layout);
    }
    if (document.composition)
        return core::Result<std::pair<core::RoomPresentationResolution,
                                      std::vector<core::editor::TypedFocusedRoomLayoutDefinition>>,
                            core::Diagnostics>::
            failure({error("editor_preview.room_composition_requires_phase_12",
                           "Focused Room composition is unavailable until Phase 12.")});
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
        result.characters.push_back(
            {decoded_id<core::CharacterId>(character_id),
             decoded_id<core::CharacterPoseId>(visual.resolved_pose_id),
             decoded_id<core::CharacterExpressionId>(visual.expression_id),
             visual.idle_id ? std::optional{decoded_id<core::CharacterIdleId>(*visual.idle_id)}
                            : std::nullopt,
             visual.pose.sprite_asset_id
                 ? std::optional{decoded_id<core::AssetId>(*visual.pose.sprite_asset_id)}
                 : std::nullopt,
             visual.pose.material_id
                 ? std::optional{decoded_id<core::MaterialId>(*visual.pose.material_id)}
                 : std::nullopt,
             {visual.pose.anchor.x, visual.pose.anchor.y},
             {visual.pose.offset.x, visual.pose.offset.y},
             visual.pose.scale,
             visual.expression.sprite_asset_id
                 ? std::optional{decoded_id<core::AssetId>(*visual.expression.sprite_asset_id)}
                 : std::nullopt,
             visual.expression.material_id
                 ? std::optional{decoded_id<core::MaterialId>(*visual.expression.material_id)}
                 : std::nullopt,
             std::move(idle)});
    };
    for (const auto& character : document.world.persistent_characters)
        append_character(character.character_id, character.visual);
    for (const auto& cast : document.world.cast)
        append_character(cast.character_id, cast.visual);
    for (const auto& interactable : document.world.interactables)
        result.interactables.push_back(
            {decoded_id<core::InteractableId>(interactable.interactable_id),
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
    : m_dependencies(std::move(dependencies))
{
}

FocusedPreviewPresenter::~FocusedPreviewPresenter() { clear(); }

void FocusedPreviewPresenter::clear() noexcept
{
    supersede_candidate();
    m_dependencies.layouts.clear_focused_preview();
    m_dependencies.world_resources.clear();
    m_dependencies.assets.clear_focused_published_leases_on_owner();
    m_committed = {};
    m_rollback = {};
    m_project_instance_id.clear();
    m_resource_generation = 0;
}

void FocusedPreviewPresenter::supersede_candidate()
{
    if (!m_candidate)
        return;
    m_candidate->asset_group->cancel_on_owner();
    m_dependencies.complete(m_candidate->request, "superseded", {});
    m_candidate.reset();
}

core::Result<std::vector<assets::StructuredAssetRequestDescriptor>, core::Diagnostics>
FocusedPreviewPresenter::build_asset_requests(
    const core::editor::FocusedEditorDocumentRequest& request,
    const core::editor::TypedEditorRoomPreviewDocument& document) const
{
    std::vector<assets::StructuredAssetRequestDescriptor> result;
    const auto generation = m_dependencies.assets.source_generation_on_owner();
    for (const auto& resource : request.resources) {
        if (resource.source_kind != "authoring-asset")
            continue;
        const auto path = resource.logical_path.find(":/") == std::string::npos
                              ? "project:/" + resource.logical_path
                              : resource.logical_path;
        if (resource.kind == "image") {
            const assets::TextureAssetRequest typed{
                .path = path,
                .sampler = resource.sampling == "nearest" ? MaterialTextureSampler::ClampNearest
                                                          : MaterialTextureSampler::ClampLinear};
            result.push_back(
                {.request = typed, .cache_key = assets::make_texture_cache_key(typed, generation)});
        } else if (resource.kind == "font") {
            const assets::FontAssetRequest typed{
                .alias = resource.asset_id.value_or(resource.resource_id)};
            result.push_back(
                {.request = typed, .cache_key = assets::make_font_cache_key(typed, generation)});
        }
    }
    for (const auto& material : document.shader_materials.materials) {
        const assets::MaterialAssetRequest typed{.id = material.id.string()};
        result.push_back(
            {.request = typed, .cache_key = assets::make_material_cache_key(typed, generation)});
    }
    return core::Result<std::vector<assets::StructuredAssetRequestDescriptor>,
                        core::Diagnostics>::success(std::move(result));
}

core::Result<FocusedPreviewPresenter::FocusedState, core::Diagnostics>
FocusedPreviewPresenter::prepare_room_state(
    const core::editor::FocusedEditorDocumentRequest& request,
    const core::editor::TypedEditorRoomPreviewDocument& document) const
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
    for (const auto& resource : request.resources) {
        if (resource.source_kind != "authoring-asset" || resource.kind != "image" ||
            !resource.asset_id)
            continue;
        const auto asset_id = core::AssetId::create(*resource.asset_id);
        if (!asset_id)
            continue;
        state.world_catalog.images.push_back(
            {.asset_id = *asset_id.value_if(),
             .logical_path = resource.logical_path.find(":/") == std::string::npos
                                 ? "project:/" + resource.logical_path
                                 : resource.logical_path,
             .sampler = resource.sampling == "nearest" ? MaterialTextureSampler::ClampNearest
                                                       : MaterialTextureSampler::ClampLinear});
    }
    for (const auto& layout : document.layouts)
        state.layout_instance_ids.push_back(layout.instance_id);
    auto resolution = resolve_focused_room(document);
    if (!resolution)
        return core::Result<FocusedState, core::Diagnostics>::failure(
            std::move(resolution).error());
    state.room_resolution = std::move(resolution.value_if()->first);
    auto snapshot = core::RoomPresentationSnapshotProjector::project(
        *state.room_resolution, focused_visual_catalog(document));
    if (!snapshot)
        return core::Result<FocusedState, core::Diagnostics>::failure(std::move(snapshot).error());
    snapshot.value_if()->revision =
        core::PresentationSnapshotRevision::from_number(request.apply_sequence);
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
        m_project_instance_id = request.project_instance_id;
        m_resource_generation = 0;
    }
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
        const bool applied = m_dependencies.apply_legacy_document(std::move(*decoded.value_if()));
        if (applied) {
            m_rollback = m_committed;
            m_committed = {};
            m_committed.owner = {.kind = owner_kind(request.kind),
                                 .project_instance_id = request.project_instance_id,
                                 .record_id = request.record_id,
                                 .revision = request.revision,
                                 .apply_sequence = request.apply_sequence};
        }
        m_dependencies.complete(request, applied ? "applied" : "failed", {});
        return true;
    }

    auto decoded = core::editor::decode_editor_room_preview_document_text(request.data_json);
    if (!decoded) {
        m_dependencies.report(std::move(decoded).error());
        return false;
    }
    supersede_candidate();
    auto prepared = prepare_room_state(request, *decoded.value_if());
    if (!prepared) {
        auto diagnostics = std::move(prepared).error();
        m_dependencies.report(diagnostics);
        m_dependencies.complete(request, "failed", diagnostics);
        return false;
    }
    auto requests = build_asset_requests(request, *decoded.value_if());
    if (!requests) {
        m_dependencies.report(std::move(requests).error());
        return false;
    }
    auto resolved = resolve_focused_room(*decoded.value_if());
    if (!resolved) {
        auto diagnostics = std::move(resolved).error();
        m_dependencies.report(diagnostics);
        m_dependencies.complete(request, "failed", diagnostics);
        return false;
    }
    auto group = std::make_unique<assets::MandatoryAssetRequestGroup>(
        m_dependencies.assets, std::move(*requests.value_if()),
        assets::MandatoryAssetGroupOptions{.show_overlay_immediately = false,
                                           .retryable = false,
                                           .presentation_revision = std::nullopt});
    m_candidate = Candidate{.request = std::move(request),
                            .document = std::move(*decoded.value_if()),
                            .state = std::move(*prepared.value_if()),
                            .mounted_layouts = std::move(resolved.value_if()->second),
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
    m_candidate.reset();
}

void FocusedPreviewPresenter::commit_candidate(assets::StructuredAssetLeaseSet leases)
{
    if (!m_candidate)
        return;
    auto candidate = std::move(*m_candidate);
    m_candidate.reset();
    m_dependencies.assets.stage_focused_candidate_leases_on_owner(std::move(leases));
    auto layout_result = m_dependencies.layouts.stage_focused_preview(candidate.mounted_layouts);
    if (!layout_result) {
        m_dependencies.assets.rollback_focused_candidate_leases_on_owner();
        m_dependencies.complete(candidate.request, "failed", std::move(layout_result).error());
        return;
    }
    candidate.prepared_world_resources =
        std::make_unique<AssetWorldPresentationResourceResolver>(m_dependencies.assets);
    candidate.prepared_world_resources->bind_catalog(candidate.state.world_catalog);
    candidate.prepared_world =
        std::make_unique<WorldPresentationBackend>(*candidate.prepared_world_resources);
    if (!candidate.state.snapshot) {
        m_dependencies.layouts.rollback_focused_preview();
        m_dependencies.assets.rollback_focused_candidate_leases_on_owner();
        m_dependencies.complete(candidate.request, "failed",
                                {error("editor_preview.room_snapshot_missing",
                                       "Focused Room candidate has no prepared snapshot.")});
        return;
    }
    auto world_result = candidate.prepared_world->reconcile(
        *candidate.state.snapshot,
        {static_cast<float>(candidate.document.environment.reference_resolution.width),
         static_cast<float>(candidate.document.environment.reference_resolution.height)});
    if (!world_result) {
        m_dependencies.layouts.rollback_focused_preview();
        m_dependencies.assets.rollback_focused_candidate_leases_on_owner();
        m_dependencies.complete(candidate.request, "failed", std::move(world_result).error());
        return;
    }
    auto environment_result = m_dependencies.apply_environment(*candidate.state.environment);
    if (!environment_result) {
        m_dependencies.layouts.rollback_focused_preview();
        m_dependencies.assets.rollback_focused_candidate_leases_on_owner();
        m_dependencies.complete(candidate.request, "failed", std::move(environment_result).error());
        return;
    }
    if (!m_dependencies.apply_ui_values(RuntimeUiGameplayValues{
            candidate.request.apply_sequence, candidate.state.static_gameplay_values})) {
        m_dependencies.layouts.rollback_focused_preview();
        m_dependencies.assets.rollback_focused_candidate_leases_on_owner();
        m_dependencies.complete(candidate.request, "failed",
                                {error("editor_preview.room_ui_prepare_failed",
                                       "Focused Room RuntimeUI values could not be prepared.")});
        return;
    }
    m_dependencies.bind_input_sink(&m_passive_input);
    candidate.state.owns_committed_typed_leases = true;
    m_dependencies.layouts.commit_focused_preview();
    m_dependencies.assets.commit_focused_candidate_leases_on_owner();
    m_dependencies.world_resources.bind_catalog(candidate.state.world_catalog);
    m_dependencies.world.swap_prepared(*candidate.prepared_world);
    candidate.state.passive_input_baseline = m_passive_input.baseline;
    m_rollback = m_committed;
    m_committed = std::move(candidate.state);
    m_dependencies.complete(candidate.request, "applied", {});
}

void FocusedPreviewPresenter::update()
{
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
    if (!m_fixture_room_commit) {
        fail_candidate({error("editor_preview.room_visual_commit_deferred",
                              "Focused Room visual commit remains fixture-only until Phase 11.")});
        return;
    }
    commit_candidate(std::move(*leases));
}

} // namespace noveltea::host
