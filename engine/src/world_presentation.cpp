#include "noveltea/world_presentation.hpp"

#include <algorithm>
#include <charconv>
#include <cmath>
#include <limits>
#include <tuple>
#include <type_traits>

namespace noveltea {
namespace {

core::Diagnostic diagnostic(std::string code, std::string message, std::string_view context)
{
    return {.code = std::move(code),
            .message = std::move(message),
            .source_path = std::string(context)};
}

std::optional<Color> parse_color(std::string_view value)
{
    if (value.size() != 7 && value.size() != 9)
        return std::nullopt;
    if (value.front() != '#')
        return std::nullopt;

    const auto component = [value](std::size_t offset) -> std::optional<unsigned> {
        unsigned result = 0;
        const char* begin = value.data() + offset;
        const char* end = begin + 2;
        const auto parsed = std::from_chars(begin, end, result, 16);
        return parsed.ec == std::errc{} && parsed.ptr == end ? std::optional<unsigned>{result}
                                                             : std::nullopt;
    };
    const auto red = component(1);
    const auto green = component(3);
    const auto blue = component(5);
    const auto alpha = value.size() == 9 ? component(7) : std::optional<unsigned>{255};
    if (!red || !green || !blue || !alpha)
        return std::nullopt;
    return Color::from_rgba8(*red, *green, *blue, *alpha);
}

GameLayer layer_for_plane(core::PresentationPlane plane)
{
    switch (plane) {
    case core::PresentationPlane::WorldBackground:
        return GameLayer::Background;
    case core::PresentationPlane::WorldContent:
        return GameLayer::Main;
    case core::PresentationPlane::WorldOverlay:
        return GameLayer::Foreground;
    case core::PresentationPlane::GameUi:
        return GameLayer::UIOverlay;
    default:
        return GameLayer::Count;
    }
}

std::string actor_identity(const core::ActorPresentationKey& key)
{
    return std::visit(
        [](const auto& value) -> std::string {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, core::CharacterActorKey>) {
                return "character/" + value.character.text();
            } else if constexpr (std::is_same_v<T, core::RoomCastActorKey>) {
                return "room-cast/" + value.room.text() + "/" + value.entry.text();
            } else if constexpr (std::is_same_v<T, core::SceneActorKey>) {
                return "scene/" + std::to_string(value.owner.invocation.number()) + "/" +
                       value.owner.scene.text() + "/" + value.slot.text();
            } else {
                return "scoped/" + value.instance.text();
            }
        },
        key);
}

std::string prop_identity(const core::PresentationPropKey& key)
{
    return std::visit(
        [](const auto& value) -> std::string {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, core::RoomPropPresentationKey>)
                return "room/" + value.room.text() + "/" + value.prop.text();
            else
                return "scoped/" + value.instance.text();
        },
        key);
}

void append_visual_draw(std::vector<WorldPresentationDraw>& draws, core::PresentationPlane plane,
                        WorldDrawFamily family, std::int32_t order, std::string stable_identity,
                        std::uint8_t sublayer, Rect rect, Rect uv,
                        const WorldPreparedVisual& visual)
{
    if (!visual.texture && !visual.material)
        return;
    QuadCommand command;
    command.rect = rect;
    command.uv = uv;
    command.color = visual.tint;
    command.layer = layer_for_plane(plane);
    if (visual.texture)
        command.texture = Texture{visual.texture->handle};
    if (visual.material)
        command.material = *visual.material;
    draws.push_back(
        {plane, family, order, std::move(stable_identity), sublayer, std::move(command)});
}

void append_resource_diagnostics(core::Diagnostics& diagnostics,
                                 core::Result<WorldPreparedVisual, core::Diagnostics>& resolved)
{
    if (!resolved)
        core::append_diagnostics(diagnostics, std::move(resolved.error()));
}

Size visual_size(const WorldPreparedVisual& visual) noexcept
{
    return visual.texture ? Size{static_cast<float>(visual.texture->width),
                                 static_cast<float>(visual.texture->height)}
                          : Size{};
}

bool valid_viewport(Size viewport) noexcept
{
    return std::isfinite(viewport.width) && std::isfinite(viewport.height) &&
           viewport.width > 0.0f && viewport.height > 0.0f;
}

bool valid_draw_plane(core::PresentationPlane plane) noexcept
{
    return layer_for_plane(plane) != GameLayer::Count;
}

} // namespace

void AssetWorldPresentationResourceResolver::bind_project(const core::CompiledProject& project)
{
    m_image_paths.clear();
    for (const auto& asset : project.assets()) {
        if (asset.kind == core::compiled::AssetKind::Image)
            m_image_paths.emplace(asset.id.text(), "project:/" + asset.path);
    }
}

void AssetWorldPresentationResourceResolver::clear() { m_image_paths.clear(); }

core::Result<WorldPreparedVisual, core::Diagnostics>
AssetWorldPresentationResourceResolver::resolve(std::optional<core::AssetId> asset,
                                                std::optional<core::MaterialId> material,
                                                std::string_view context)
{
    WorldPreparedVisual result;
    if (asset) {
        const auto found = m_image_paths.find(asset->text());
        if (found == m_image_paths.end()) {
            return core::Result<WorldPreparedVisual, core::Diagnostics>::failure({diagnostic(
                "presentation.world_asset_unresolved",
                "World presentation image is not in the prepared project catalog: " + asset->text(),
                context)});
        }
        auto loaded = m_assets.load_texture({.path = found->second});
        if (!loaded) {
            return core::Result<WorldPreparedVisual, core::Diagnostics>::failure(
                {diagnostic("presentation.world_texture_prepare_failed", loaded.error, context)});
        }
        if (loaded.value->width == 0 || loaded.value->height == 0) {
            return core::Result<WorldPreparedVisual, core::Diagnostics>::failure({diagnostic(
                "presentation.world_texture_dimensions_invalid",
                "Prepared world texture has zero dimensions: " + found->second, context)});
        }
        result.texture = std::move(*loaded.value);
    }
    if (material) {
        auto loaded = m_assets.load_material({.id = material->text()});
        if (!loaded) {
            return core::Result<WorldPreparedVisual, core::Diagnostics>::failure(
                {diagnostic("presentation.world_material_prepare_failed", loaded.error, context)});
        }
        if (loaded.value->definition == nullptr ||
            loaded.value->definition->role != ShaderRole::Engine2D) {
            return core::Result<WorldPreparedVisual, core::Diagnostics>::failure({diagnostic(
                "presentation.world_material_role_invalid",
                "World presentation material must declare the engine-2d role: " + material->text(),
                context)});
        }
        result.material = MaterialId(material->text());
    }
    return core::Result<WorldPreparedVisual, core::Diagnostics>::success(std::move(result));
}

core::Result<std::optional<WorldPreparedVisual>, core::Diagnostics>
AssetWorldPresentationResourceResolver::resolve_environment(std::string_view kind,
                                                            std::string_view context)
{
    constexpr std::string_view prefix = "material:";
    if (!kind.starts_with(prefix))
        return core::Result<std::optional<WorldPreparedVisual>, core::Diagnostics>::success(
            std::nullopt);
    const std::string material_text(kind.substr(prefix.size()));
    if (material_text.empty()) {
        return core::Result<std::optional<WorldPreparedVisual>, core::Diagnostics>::failure(
            {diagnostic("presentation.world_environment_material_invalid",
                        "Environment material kind must include a material ID", context)});
    }
    auto material = core::MaterialId::create(material_text);
    if (!material)
        return core::Result<std::optional<WorldPreparedVisual>, core::Diagnostics>::failure(
            std::move(material.error()));
    auto resolved = resolve(std::nullopt, std::move(*material.value_if()), context);
    if (!resolved)
        return core::Result<std::optional<WorldPreparedVisual>, core::Diagnostics>::failure(
            std::move(resolved.error()));
    return core::Result<std::optional<WorldPreparedVisual>, core::Diagnostics>::success(
        std::move(*resolved.value_if()));
}

Rect WorldPresentationLayoutPolicy::normalized_rect(const core::compiled::NormalizedRect& bounds,
                                                    Size viewport) noexcept
{
    return {static_cast<float>(bounds.x) * viewport.width,
            static_cast<float>(bounds.y) * viewport.height,
            static_cast<float>(bounds.width) * viewport.width,
            static_cast<float>(bounds.height) * viewport.height};
}

WorldFittedRect
WorldPresentationLayoutPolicy::fit_background(Size viewport, Size texture,
                                              core::compiled::BackgroundFit fit) noexcept
{
    WorldFittedRect result{{0.0f, 0.0f, viewport.width, viewport.height}, {0.0f, 0.0f, 1.0f, 1.0f}};
    if (texture.width <= 0.0f || texture.height <= 0.0f || viewport.width <= 0.0f ||
        viewport.height <= 0.0f || fit == core::compiled::BackgroundFit::Stretch)
        return result;

    const float texture_aspect = texture.width / texture.height;
    const float viewport_aspect = viewport.width / viewport.height;
    if (fit == core::compiled::BackgroundFit::Cover) {
        if (texture_aspect > viewport_aspect) {
            result.uv.width = viewport_aspect / texture_aspect;
            result.uv.x = (1.0f - result.uv.width) * 0.5f;
        } else if (texture_aspect < viewport_aspect) {
            result.uv.height = texture_aspect / viewport_aspect;
            result.uv.y = (1.0f - result.uv.height) * 0.5f;
        }
        return result;
    }

    if (fit == core::compiled::BackgroundFit::Contain) {
        const float scale =
            std::min(viewport.width / texture.width, viewport.height / texture.height);
        result.rect.width = texture.width * scale;
        result.rect.height = texture.height * scale;
    } else {
        result.rect.width = texture.width;
        result.rect.height = texture.height;
    }
    result.rect.x = (viewport.width - result.rect.width) * 0.5f;
    result.rect.y = (viewport.height - result.rect.height) * 0.5f;
    return result;
}

Rect WorldPresentationLayoutPolicy::actor_rect(const core::PresentationActor& actor, Size viewport,
                                               Size texture) noexcept
{
    if (texture.width <= 0.0f || texture.height <= 0.0f)
        texture = {viewport.width * 0.32f, viewport.height * 0.78f};
    const float scale = static_cast<float>(actor.pose_scale * actor.placement.scale);
    const float width = texture.width * scale;
    const float height = texture.height * scale;

    float anchor_x = viewport.width * 0.5f;
    float anchor_y = viewport.height;
    if (actor.room_bounds) {
        const Rect bounds = normalized_rect(*actor.room_bounds, viewport);
        anchor_x = bounds.x + bounds.width * 0.5f;
        anchor_y = bounds.y + bounds.height;
    } else {
        switch (actor.placement.position) {
        case core::compiled::ActorPosition::Left:
            anchor_x = viewport.width * 0.25f;
            break;
        case core::compiled::ActorPosition::Right:
            anchor_x = viewport.width * 0.75f;
            break;
        case core::compiled::ActorPosition::Center:
        case core::compiled::ActorPosition::Custom:
            break;
        }
    }

    anchor_x += static_cast<float>(actor.placement.offset.x) * viewport.width;
    anchor_y += static_cast<float>(actor.placement.offset.y) * viewport.height;
    anchor_x += static_cast<float>(actor.pose_offset.x) * scale;
    anchor_y += static_cast<float>(actor.pose_offset.y) * scale;
    return {anchor_x - static_cast<float>(actor.pose_anchor.x) * width,
            anchor_y - static_cast<float>(actor.pose_anchor.y) * height, width, height};
}

core::Result<bool, core::Diagnostics>
WorldPresentationBackend::reconcile(const core::RuntimePresentationSnapshot& snapshot,
                                    Size viewport)
{
    if (!valid_viewport(viewport)) {
        return core::Result<bool, core::Diagnostics>::failure({diagnostic(
            "presentation.world_viewport_invalid",
            "World presentation requires a finite positive logical viewport", "world")});
    }
    if (m_snapshot && *m_snapshot == snapshot && m_viewport.width == viewport.width &&
        m_viewport.height == viewport.height)
        return core::Result<bool, core::Diagnostics>::success(false);

    WorldPresentationFrame candidate;
    candidate.revision = snapshot.revision;
    core::Diagnostics diagnostics;
    const Rect full_viewport{0.0f, 0.0f, viewport.width, viewport.height};
    const Rect full_uv{0.0f, 0.0f, 1.0f, 1.0f};

    if (snapshot.background) {
        const auto& background = *snapshot.background;
        if (background.color) {
            const auto color = parse_color(*background.color);
            if (!color) {
                diagnostics.push_back(diagnostic(
                    "presentation.world_background_color_invalid",
                    "World background color must be #RRGGBB or #RRGGBBAA: " + *background.color,
                    "background"));
            } else {
                QuadCommand command;
                command.rect = full_viewport;
                command.color = *color;
                command.layer = GameLayer::Background;
                candidate.draws.push_back({core::PresentationPlane::WorldBackground,
                                           WorldDrawFamily::Background, 0, "background", 0,
                                           std::move(command)});
            }
        }
        auto resolved = m_resources.resolve(background.asset, background.material, "background");
        if (!resolved) {
            append_resource_diagnostics(diagnostics, resolved);
        } else if (resolved.value().texture || resolved.value().material) {
            const WorldFittedRect fitted = WorldPresentationLayoutPolicy::fit_background(
                viewport, visual_size(resolved.value()), background.fit);
            append_visual_draw(candidate.draws, core::PresentationPlane::WorldBackground,
                               WorldDrawFamily::Background, 0, "background", 1, fitted.rect,
                               fitted.uv, resolved.value());
        }
    }

    for (const auto& environment : snapshot.environments) {
        if (!environment.visible)
            continue;
        if (!valid_draw_plane(environment.plane)) {
            diagnostics.push_back(
                diagnostic("presentation.world_plane_unsupported",
                           "Engine environment visual uses a non-engine presentation plane",
                           "environment/" + environment.instance.text()));
            continue;
        }
        auto resolved = m_resources.resolve_environment(
            environment.kind, "environment/" + environment.instance.text());
        if (!resolved) {
            core::append_diagnostics(diagnostics, std::move(resolved.error()));
        } else if (resolved.value()) {
            append_visual_draw(candidate.draws, environment.plane, WorldDrawFamily::Environment,
                               environment.order, environment.instance.text(), 0, full_viewport,
                               full_uv, *resolved.value());
        }
    }

    for (const auto& prop : snapshot.props) {
        if (!prop.visible)
            continue;
        const std::string identity = prop_identity(prop.key);
        if (!valid_draw_plane(prop.plane)) {
            diagnostics.push_back(diagnostic("presentation.world_plane_unsupported",
                                             "Engine prop uses a non-engine presentation plane",
                                             "prop/" + identity));
            continue;
        }
        auto resolved = m_resources.resolve(prop.asset, prop.material, "prop/" + identity);
        if (!resolved) {
            append_resource_diagnostics(diagnostics, resolved);
            continue;
        }
        append_visual_draw(candidate.draws, prop.plane, WorldDrawFamily::Prop, prop.order, identity,
                           0, WorldPresentationLayoutPolicy::normalized_rect(prop.bounds, viewport),
                           full_uv, resolved.value());
    }

    for (const auto& interactable : snapshot.interactables) {
        if (!interactable.visible)
            continue;
        const std::string identity = interactable.interactable.text();
        if (!valid_draw_plane(interactable.plane)) {
            diagnostics.push_back(
                diagnostic("presentation.world_plane_unsupported",
                           "Engine Interactable uses a non-engine presentation plane",
                           "interactable/" + identity));
            continue;
        }
        auto resolved = m_resources.resolve(interactable.sprite, interactable.material,
                                            "interactable/" + identity);
        if (!resolved) {
            append_resource_diagnostics(diagnostics, resolved);
            continue;
        }
        append_visual_draw(
            candidate.draws, interactable.plane, WorldDrawFamily::Interactable, interactable.order,
            identity, 0,
            WorldPresentationLayoutPolicy::normalized_rect(interactable.bounds, viewport), full_uv,
            resolved.value());
    }

    for (const auto& actor : snapshot.actors) {
        if (!actor.enabled || !actor.visible)
            continue;
        const std::string identity = actor_identity(actor.key);
        if (!valid_draw_plane(actor.plane)) {
            diagnostics.push_back(diagnostic("presentation.world_plane_unsupported",
                                             "Engine actor uses a non-engine presentation plane",
                                             "actor/" + identity));
            continue;
        }
        auto pose = m_resources.resolve(actor.pose_sprite, actor.pose_material,
                                        "actor/" + identity + "/pose");
        if (!pose) {
            append_resource_diagnostics(diagnostics, pose);
        } else {
            const Rect rect = WorldPresentationLayoutPolicy::actor_rect(actor, viewport,
                                                                        visual_size(pose.value()));
            append_visual_draw(candidate.draws, actor.plane, WorldDrawFamily::Actor, actor.order,
                               identity, 0, rect, full_uv, pose.value());
        }

        auto expression = m_resources.resolve(actor.expression_sprite, actor.expression_material,
                                              "actor/" + identity + "/expression");
        if (!expression) {
            append_resource_diagnostics(diagnostics, expression);
        } else if (expression.value().texture || expression.value().material) {
            Size size = visual_size(expression.value());
            if (size.width <= 0.0f || size.height <= 0.0f) {
                size = pose ? visual_size(pose.value()) : Size{};
            }
            const Rect rect = WorldPresentationLayoutPolicy::actor_rect(actor, viewport, size);
            append_visual_draw(candidate.draws, actor.plane, WorldDrawFamily::Actor, actor.order,
                               identity, 1, rect, full_uv, expression.value());
        }
    }

    if (snapshot.map && snapshot.map->visible && snapshot.map->background) {
        auto resolved = m_resources.resolve(snapshot.map->background, std::nullopt,
                                            "map/" + snapshot.map->map.text() + "/background");
        if (!resolved) {
            append_resource_diagnostics(diagnostics, resolved);
        } else {
            const WorldFittedRect fitted = WorldPresentationLayoutPolicy::fit_background(
                viewport, visual_size(resolved.value()), core::compiled::BackgroundFit::Contain);
            append_visual_draw(candidate.draws, core::PresentationPlane::GameUi,
                               WorldDrawFamily::MapUnderlay, 0, snapshot.map->map.text(), 0,
                               fitted.rect, fitted.uv, resolved.value());
        }
    }

    if (!diagnostics.empty())
        return core::Result<bool, core::Diagnostics>::failure(std::move(diagnostics));

    std::sort(candidate.draws.begin(), candidate.draws.end(), [](const auto& lhs, const auto& rhs) {
        return std::tie(lhs.plane, lhs.family, lhs.order, lhs.stable_identity, lhs.sublayer) <
               std::tie(rhs.plane, rhs.family, rhs.order, rhs.stable_identity, rhs.sublayer);
    });
    for (const auto& draw : candidate.draws) {
        candidate.batch.draw_material_textured_quad(
            draw.command.rect, draw.command.material, draw.command.texture, draw.command.uv,
            draw.command.color, draw.command.depth, draw.command.layer);
        QuadBatch& composition_batch = draw.plane == core::PresentationPlane::GameUi
                                           ? candidate.game_ui_underlay_batch
                                           : candidate.world_composition_batch;
        composition_batch.draw_material_textured_quad(
            draw.command.rect, draw.command.material, draw.command.texture, draw.command.uv,
            draw.command.color, draw.command.depth, draw.command.layer);
    }

    m_snapshot = snapshot;
    m_viewport = viewport;
    m_snapshots.insert_or_assign(snapshot.revision.number(), snapshot);
    m_frames.insert_or_assign(snapshot.revision.number(), candidate);
    m_frame = std::move(candidate);
    if (m_generation != std::numeric_limits<std::uint64_t>::max())
        ++m_generation;
    return core::Result<bool, core::Diagnostics>::success(true);
}

core::Result<bool, core::Diagnostics> WorldPresentationBackend::resize(Size viewport)
{
    if (!m_snapshot)
        return core::Result<bool, core::Diagnostics>::success(false);
    if (!valid_viewport(viewport)) {
        return core::Result<bool, core::Diagnostics>::failure({diagnostic(
            "presentation.world_viewport_invalid",
            "World presentation requires a finite positive logical viewport", "world")});
    }
    if (m_viewport.width == viewport.width && m_viewport.height == viewport.height)
        return core::Result<bool, core::Diagnostics>::success(false);

    const auto previous_snapshot = m_snapshot;
    const auto previous_viewport = m_viewport;
    const auto previous_frame = m_frame;
    const auto previous_snapshots = m_snapshots;
    const auto previous_frames = m_frames;
    const auto previous_generation = m_generation;
    const auto current_revision = previous_snapshot->revision.number();

    m_snapshot.reset();
    m_frame.reset();
    m_snapshots.clear();
    m_frames.clear();
    std::vector<std::uint64_t> revisions;
    revisions.reserve(previous_snapshots.size());
    for (const auto& [revision, _] : previous_snapshots)
        revisions.push_back(revision);
    std::sort(revisions.begin(), revisions.end());
    const auto current = std::find(revisions.begin(), revisions.end(), current_revision);
    if (current != revisions.end()) {
        revisions.erase(current);
        revisions.push_back(current_revision);
    }
    for (const auto revision : revisions) {
        auto rebuilt = reconcile(previous_snapshots.at(revision), viewport);
        if (!rebuilt) {
            m_snapshot = previous_snapshot;
            m_viewport = previous_viewport;
            m_frame = previous_frame;
            m_snapshots = previous_snapshots;
            m_frames = previous_frames;
            m_generation = previous_generation;
            return rebuilt;
        }
    }
    return core::Result<bool, core::Diagnostics>::success(true);
}

void WorldPresentationBackend::reset()
{
    m_snapshot.reset();
    m_viewport = {};
    m_frame.reset();
    m_snapshots.clear();
    m_frames.clear();
    m_generation = 0;
}

const WorldPresentationFrame* WorldPresentationBackend::frame() const noexcept
{
    return m_frame ? &*m_frame : nullptr;
}

const WorldPresentationFrame*
WorldPresentationBackend::frame(core::PresentationSnapshotRevision revision) const noexcept
{
    const auto found = m_frames.find(revision.number());
    return found == m_frames.end() ? nullptr : &found->second;
}

bool WorldPresentationBackend::restore_revision(
    core::PresentationSnapshotRevision revision) noexcept
{
    const auto snapshot = m_snapshots.find(revision.number());
    const auto frame = m_frames.find(revision.number());
    if (snapshot == m_snapshots.end() || frame == m_frames.end())
        return false;
    m_snapshot = snapshot->second;
    m_frame = frame->second;
    return true;
}

void WorldPresentationBackend::discard_revision(
    core::PresentationSnapshotRevision revision) noexcept
{
    const auto number = revision.number();
    m_snapshots.erase(number);
    m_frames.erase(number);
    if (m_snapshot && m_snapshot->revision == revision) {
        m_snapshot.reset();
        m_frame.reset();
    }
}

void WorldPresentationBackend::retain_only(
    std::span<const core::PresentationSnapshotRevision> revisions)
{
    const auto retained = [&](std::uint64_t revision) {
        return std::any_of(revisions.begin(), revisions.end(),
                           [&](const auto value) { return value.number() == revision; });
    };
    for (auto it = m_snapshots.begin(); it != m_snapshots.end();) {
        if (!retained(it->first)) {
            m_frames.erase(it->first);
            it = m_snapshots.erase(it);
        } else {
            ++it;
        }
    }
}

} // namespace noveltea
