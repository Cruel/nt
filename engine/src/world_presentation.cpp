#include "noveltea/world_presentation.hpp"

#include <algorithm>
#include <charconv>
#include <cmath>
#include <limits>
#include <numbers>
#include <tuple>
#include <type_traits>
#include <unordered_set>

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

std::string presentation_owner_identity(const core::PresentationOwner& owner)
{
    return std::visit(
        [](const auto& value) -> std::string {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, core::ScenePresentationOwner>) {
                return "scene/" + std::to_string(value.invocation.number()) + "/" +
                       value.scene.text();
            } else if constexpr (std::is_same_v<T, core::CurrentRoomPresentationOwner>) {
                return "current-room/" + std::to_string(value.visit.number()) + "/" +
                       value.room.text();
            } else if constexpr (std::is_same_v<T, core::RoomPresentationOwner>) {
                return "room/" + value.room.text();
            } else if constexpr (std::is_same_v<T, core::SessionPresentationOwner>) {
                return "session/" + std::to_string(value.session.number());
            } else {
                return "shell/" + std::to_string(value.scope.number());
            }
        },
        owner);
}

std::string environment_identity(const core::PresentationEnvironment& environment)
{
    return presentation_owner_identity(environment.owner) + "/environment/" +
           environment.instance.text();
}

void append_visual_draw(std::vector<WorldPresentationDraw>& draws, core::PresentationPlane plane,
                        WorldDrawFamily family, std::int32_t order, std::string stable_identity,
                        std::uint8_t sublayer, Rect rect, Rect uv,
                        const WorldPreparedVisual& visual,
                        std::optional<core::compiled::CharacterIdle> actor_idle = std::nullopt,
                        std::optional<core::LayoutClockDomain> environment_clock = std::nullopt,
                        core::compiled::Vector2 environment_scroll_per_second = {0.0, 0.0})
{
    if (!visual.texture && !visual.material)
        return;
    QuadCommand command;
    command.rect = rect;
    command.uv = uv;
    command.color = visual.tint;
    command.layer = layer_for_plane(plane);
    if (visual.texture) {
        command.texture = Texture{visual.texture->handle};
        command.texture_sampler = visual.texture->sampler;
    }
    if (visual.material)
        command.material = *visual.material;
    draws.push_back({plane, family, order, std::move(stable_identity), sublayer, std::move(command),
                     std::move(actor_idle), environment_clock, environment_scroll_per_second,
                     visual.texture_lease, visual.material_lease, std::nullopt});
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

core::PresentationCamera resolved_camera(core::PresentationCamera camera) noexcept
{
    if (camera.space.edge_policy != core::compiled::WorldPresentationEdgePolicy::Contain)
        return camera;
    const auto bounds = camera.space.bounds.value_or(
        core::compiled::WorldPresentationRect{0.0, 0.0, camera.space.size.x, camera.space.size.y});
    constexpr double degrees_to_radians = 0.017453292519943295769;
    const double radians = camera.view.rotation_degrees * degrees_to_radians;
    const double cosine = std::abs(std::cos(radians));
    const double sine = std::abs(std::sin(radians));
    const double half_width =
        (cosine * camera.space.size.x + sine * camera.space.size.y) / (2.0 * camera.view.zoom);
    const double half_height =
        (sine * camera.space.size.x + cosine * camera.space.size.y) / (2.0 * camera.view.zoom);
    const auto clamp_axis = [](double center, double start, double extent, double half_extent) {
        if (half_extent * 2.0 >= extent)
            return start + extent * 0.5;
        return std::clamp(center, start + half_extent, start + extent - half_extent);
    };
    camera.view.center.x = clamp_axis(camera.view.center.x, bounds.x, bounds.width, half_width);
    camera.view.center.y = clamp_axis(camera.view.center.y, bounds.y, bounds.height, half_height);
    return camera;
}

void apply_camera(QuadCommand& command, const core::PresentationCamera& camera,
                  Size viewport) noexcept
{
    const float center_x =
        static_cast<float>(camera.view.center.x / camera.space.size.x) * viewport.width;
    const float center_y =
        static_cast<float>(camera.view.center.y / camera.space.size.y) * viewport.height;
    const float zoom = static_cast<float>(camera.view.zoom);
    command.rect.x = (command.rect.x - center_x) * zoom + viewport.width * 0.5f;
    command.rect.y = (command.rect.y - center_y) * zoom + viewport.height * 0.5f;
    command.rect.width *= zoom;
    command.rect.height *= zoom;
    command.rotation_degrees = static_cast<float>(-camera.view.rotation_degrees);
    command.rotation_origin = {viewport.width * 0.5f, viewport.height * 0.5f};
}

Vec2 inverse_camera_point(Vec2 point, const core::PresentationCamera& camera,
                          Size viewport) noexcept
{
    const float origin_x = viewport.width * 0.5f;
    const float origin_y = viewport.height * 0.5f;
    constexpr float degrees_to_radians = 0.017453292519943295769f;
    const float radians = static_cast<float>(camera.view.rotation_degrees) * degrees_to_radians;
    const float sine = std::sin(radians);
    const float cosine = std::cos(radians);
    const float local_x = point.x - origin_x;
    const float local_y = point.y - origin_y;
    const float unrotated_x = origin_x + local_x * cosine - local_y * sine;
    const float unrotated_y = origin_y + local_x * sine + local_y * cosine;
    const float center_x =
        static_cast<float>(camera.view.center.x / camera.space.size.x) * viewport.width;
    const float center_y =
        static_cast<float>(camera.view.center.y / camera.space.size.y) * viewport.height;
    const float zoom = static_cast<float>(camera.view.zoom);
    return {(unrotated_x - origin_x) / zoom + center_x, (unrotated_y - origin_y) / zoom + center_y};
}

bool valid_draw_plane(core::PresentationPlane plane) noexcept
{
    return layer_for_plane(plane) != GameLayer::Count;
}

std::chrono::microseconds clock_time(const core::RuntimeClockUpdate& clock,
                                     core::LayoutClockDomain domain) noexcept
{
    return domain == core::LayoutClockDomain::Gameplay ? clock.gameplay_time
                                                       : clock.unscaled_presentation_time;
}

std::string loop_key(const WorldPresentationDraw& draw)
{
    return std::to_string(static_cast<std::uint8_t>(draw.family)) + ":" + draw.stable_identity;
}

bool same_hotspot_owner(const core::compiled::HotspotRef& left,
                        const core::compiled::HotspotRef& right)
{
    if (left.index() != right.index())
        return false;
    return std::visit(
        [](const auto& lhs, const auto& rhs) {
            using L = std::decay_t<decltype(lhs)>;
            using R = std::decay_t<decltype(rhs)>;
            if constexpr (!std::is_same_v<L, R>)
                return false;
            else if constexpr (std::is_same_v<L, core::compiled::RoomHotspotRef>)
                return lhs.room == rhs.room;
            else
                return lhs.interactable == rhs.interactable;
        },
        left, right);
}

std::string hotspot_identity(const core::compiled::HotspotRef& ref)
{
    return std::visit(
        [](const auto& value) {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, core::compiled::RoomHotspotRef>)
                return "room/" + value.room.text() + "/hotspot/" + value.hotspot_id.text();
            else
                return "interactable/" + value.interactable.text() + "/hotspot/" +
                       value.hotspot_id.text();
        },
        ref);
}

} // namespace

std::string world_actor_identity(const core::ActorPresentationKey& key)
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

void AssetWorldPresentationResourceResolver::bind_project(const core::CompiledProject& project)
{
    WorldPresentationResourceCatalog catalog;
    for (const auto& asset : project.assets()) {
        if (asset.kind == core::compiled::AssetKind::Image) {
            assert(asset.sampling.has_value());
            const auto sampler = *asset.sampling == core::compiled::ImageSampling::Nearest
                                     ? MaterialTextureSampler::ClampNearest
                                     : MaterialTextureSampler::ClampLinear;
            catalog.images.push_back({.asset_id = asset.id,
                                      .logical_path = "project:/" + asset.path,
                                      .sampler = sampler});
        }
    }
    bind_catalog(std::move(catalog));
}

void AssetWorldPresentationResourceResolver::bind_catalog(WorldPresentationResourceCatalog catalog)
{
    m_images.clear();
    for (auto& image : catalog.images)
        m_images.emplace(image.asset_id.text(), std::move(image));
}

void AssetWorldPresentationResourceResolver::clear() { m_images.clear(); }

core::Result<WorldPreparedVisual, core::Diagnostics>
AssetWorldPresentationResourceResolver::resolve(std::optional<core::AssetId> asset,
                                                std::optional<core::MaterialId> material,
                                                std::string_view context)
{
    WorldPreparedVisual result;
    if (asset) {
        const auto found = m_images.find(asset->text());
        if (found == m_images.end()) {
            return core::Result<WorldPreparedVisual, core::Diagnostics>::failure({diagnostic(
                "presentation.world_asset_unresolved",
                "World presentation image is not in the prepared project catalog: " + asset->text(),
                context)});
        }
        const assets::TextureAssetRequest request{.path = found->second.logical_path,
                                                  .sampler = found->second.sampler};
        const auto* lease = m_assets.leased_texture_on_owner(request);
        if (lease == nullptr) {
            return core::Result<WorldPreparedVisual, core::Diagnostics>::failure({diagnostic(
                "presentation.world_texture_lease_missing",
                "Mandatory world texture is not resident: " + found->second.logical_path + " (" +
                    m_assets.describe_texture_lease_lookup_on_owner(request) + ")",
                context)});
        }
        lease->mark_used_on_owner();
        result.texture = lease->asset();
        result.texture_lease = *lease;
        if (result.texture->width == 0 || result.texture->height == 0) {
            return core::Result<WorldPreparedVisual, core::Diagnostics>::failure({diagnostic(
                "presentation.world_texture_dimensions_invalid",
                "Prepared world texture has zero dimensions: " + found->second.logical_path,
                context)});
        }
    }
    if (material) {
        const assets::MaterialAssetRequest request{.id = material->text()};
        const auto* lease = m_assets.leased_material_on_owner(request);
        if (lease == nullptr) {
            return core::Result<WorldPreparedVisual, core::Diagnostics>::failure({diagnostic(
                "presentation.world_material_lease_missing",
                "Mandatory world material is not resident: " + material->text(), context)});
        }
        lease->mark_used_on_owner();
        const MaterialDefinition* definition = lease->asset().definition;
        if (definition == nullptr || definition->role != ShaderRole::Engine2D) {
            return core::Result<WorldPreparedVisual, core::Diagnostics>::failure({diagnostic(
                "presentation.world_material_role_invalid",
                "World presentation material must declare the engine-2d role: " + material->text(),
                context)});
        }
        result.material = MaterialId(material->text());
        result.material_lease = *lease;
    }
    return core::Result<WorldPreparedVisual, core::Diagnostics>::success(std::move(result));
}

core::Result<WorldPreparedHotspotResources, core::Diagnostics>
AssetWorldPresentationResourceResolver::resolve_hotspot(
    const core::PresentationHotspot& hotspot,
    std::span<const core::PresentationHotspot> owner_hotspots, std::string_view context)
{
    WorldPreparedHotspotResources result;
    if (std::holds_alternative<core::compiled::NoHotspotHighlight>(hotspot.highlight))
        return core::Result<WorldPreparedHotspotResources, core::Diagnostics>::success(
            std::move(result));

    const bool custom = std::holds_alternative<core::compiled::NormalizedRect>(hotspot.shape);
    if (const auto* authored =
            std::get_if<core::compiled::MaterialHotspotHighlight>(&hotspot.highlight)) {
        const assets::MaterialAssetRequest request{.id = authored->material.text()};
        const auto* lease = m_assets.leased_material_on_owner(request);
        if (lease == nullptr || lease->asset().definition == nullptr ||
            lease->asset().definition->role != ShaderRole::HotspotOverlay) {
            return core::Result<WorldPreparedHotspotResources, core::Diagnostics>::failure(
                {diagnostic("presentation.hotspot_material_lease_missing",
                            "Mandatory hotspot-overlay Material is unavailable: " +
                                authored->material.text(),
                            context)});
        }
        lease->mark_used_on_owner();
        result.material = MaterialId(authored->material.text());
        result.material_lease = *lease;
    } else {
        const auto interface =
            custom ? HotspotMaterialInterface::Custom : HotspotMaterialInterface::Alpha;
        if (!m_builtin_program_validator || !m_builtin_program_validator(interface)) {
            return core::Result<WorldPreparedHotspotResources, core::Diagnostics>::failure(
                {diagnostic("presentation.hotspot_builtin_program_missing",
                            "Required renderer-owned hotspot overlay program is unavailable",
                            context)});
        }
        result.material = MaterialId(std::string(custom ? builtin_hotspot_custom_material_id
                                                        : builtin_hotspot_alpha_material_id));
    }

    if (custom) {
        assets::HotspotMaskAssetRequest request{
            .owner = std::visit(
                [](const auto& ref) -> core::compiled::HotspotOwnerRef {
                    using T = std::decay_t<decltype(ref)>;
                    if constexpr (std::is_same_v<T, core::compiled::RoomHotspotRef>)
                        return core::compiled::RoomHotspotOwnerRef{ref.room};
                    else
                        return core::compiled::InteractableHotspotOwnerRef{ref.interactable};
                },
                hotspot.ref),
            .width = hotspot.source_width,
            .height = hotspot.source_height,
            .regions = {}};
        for (const auto& candidate : owner_hotspots) {
            if (const auto* bounds = std::get_if<core::compiled::NormalizedRect>(&candidate.shape))
                request.regions.push_back(
                    {std::visit([](const auto& ref) { return ref.hotspot_id; }, candidate.ref),
                     *bounds});
        }
        const auto* lease = m_assets.leased_hotspot_mask_on_owner(request);
        if (lease == nullptr) {
            return core::Result<WorldPreparedHotspotResources, core::Diagnostics>::failure(
                {diagnostic("presentation.hotspot_mask_lease_missing",
                            "Mandatory generated hotspot mask is unavailable", context)});
        }
        lease->mark_used_on_owner();
        result.mask = lease->asset();
        result.mask_lease = *lease;
    }
    return core::Result<WorldPreparedHotspotResources, core::Diagnostics>::success(
        std::move(result));
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
    if (snapshot.camera)
        candidate.camera = resolved_camera(*snapshot.camera);
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
                                           WorldDrawFamily::Background,
                                           0,
                                           "background",
                                           0,
                                           std::move(command),
                                           std::nullopt,
                                           std::nullopt,
                                           {0.0, 0.0},
                                           std::nullopt,
                                           std::nullopt,
                                           std::nullopt});
            }
        }
        auto resolved = m_resources.resolve(background.asset, background.material, "background");
        if (!resolved) {
            append_resource_diagnostics(diagnostics, resolved);
        } else if (const auto* visual = resolved.value_if(); visual->texture || visual->material) {
            const WorldFittedRect fitted = WorldPresentationLayoutPolicy::fit_background(
                viewport, visual_size(*visual), background.fit);
            append_visual_draw(candidate.draws, core::PresentationPlane::WorldBackground,
                               WorldDrawFamily::Background, 0, "background", 1, fitted.rect,
                               fitted.uv, *visual);
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
        auto resolved = m_resources.resolve(environment.asset, environment.material,
                                            "environment/" + environment.instance.text());
        if (!resolved) {
            append_resource_diagnostics(diagnostics, resolved);
        } else {
            auto visual = *resolved.value_if();
            visual.tint.a *= static_cast<float>(environment.opacity);
            append_visual_draw(
                candidate.draws, environment.plane, WorldDrawFamily::Environment, environment.order,
                environment_identity(environment), 0,
                WorldPresentationLayoutPolicy::normalized_rect(environment.bounds, viewport),
                full_uv, visual, std::nullopt, environment.clock, environment.scroll_per_second);
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
        const auto* visual = resolved.value_if();
        append_visual_draw(candidate.draws, prop.plane, WorldDrawFamily::Prop, prop.order, identity,
                           0, WorldPresentationLayoutPolicy::normalized_rect(prop.bounds, viewport),
                           full_uv, *visual);
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
        const auto* visual = resolved.value_if();
        append_visual_draw(
            candidate.draws, interactable.plane, WorldDrawFamily::Interactable, interactable.order,
            identity, 0,
            WorldPresentationLayoutPolicy::normalized_rect(interactable.bounds, viewport), full_uv,
            *visual);
    }

    for (const auto& actor : snapshot.actors) {
        if (!actor.enabled || !actor.visible)
            continue;
        const std::string identity = world_actor_identity(actor.key);
        if (!valid_draw_plane(actor.plane)) {
            diagnostics.push_back(diagnostic("presentation.world_plane_unsupported",
                                             "Engine actor uses a non-engine presentation plane",
                                             "actor/" + identity));
            continue;
        }
        auto pose = m_resources.resolve(actor.pose_sprite, actor.pose_material,
                                        "actor/" + identity + "/pose");
        const WorldPreparedVisual* pose_visual = nullptr;
        if (!pose) {
            append_resource_diagnostics(diagnostics, pose);
        } else {
            pose_visual = pose.value_if();
            const Rect rect = WorldPresentationLayoutPolicy::actor_rect(actor, viewport,
                                                                        visual_size(*pose_visual));
            append_visual_draw(candidate.draws, actor.plane, WorldDrawFamily::Actor, actor.order,
                               identity, 0, rect, full_uv, *pose_visual, actor.idle);
        }

        auto expression = m_resources.resolve(actor.expression_sprite, actor.expression_material,
                                              "actor/" + identity + "/expression");
        if (!expression) {
            append_resource_diagnostics(diagnostics, expression);
        } else if (const auto* visual = expression.value_if();
                   visual->texture || visual->material) {
            Size size = visual_size(*visual);
            if (size.width <= 0.0f || size.height <= 0.0f)
                size = pose_visual ? visual_size(*pose_visual) : Size{};
            const Rect rect = WorldPresentationLayoutPolicy::actor_rect(actor, viewport, size);
            append_visual_draw(candidate.draws, actor.plane, WorldDrawFamily::Actor, actor.order,
                               identity, 1, rect, full_uv, *visual, actor.idle);
        }
    }

    const auto owner_draw_for =
        [&](const core::compiled::HotspotRef& ref) -> const WorldPresentationDraw* {
        if (std::holds_alternative<core::compiled::RoomHotspotRef>(ref)) {
            const auto found =
                std::find_if(candidate.draws.begin(), candidate.draws.end(), [](const auto& draw) {
                    return draw.family == WorldDrawFamily::Background &&
                           draw.stable_identity == "background" && draw.sublayer == 1;
                });
            return found == candidate.draws.end() ? nullptr : &*found;
        }
        const auto& interactable = std::get<core::compiled::InteractableHotspotRef>(ref);
        const auto found =
            std::find_if(candidate.draws.begin(), candidate.draws.end(), [&](const auto& draw) {
                return draw.family == WorldDrawFamily::Interactable &&
                       draw.stable_identity == interactable.interactable.text() &&
                       draw.sublayer == 0;
            });
        return found == candidate.draws.end() ? nullptr : &*found;
    };

    for (const auto& hotspot : snapshot.hotspots) {
        if (!hotspot.condition_eligible || !hotspot.target_available)
            continue;
        const WorldPresentationDraw* owner_draw = owner_draw_for(hotspot.ref);
        if (owner_draw == nullptr || !owner_draw->command.texture.valid())
            continue;
        candidate.hotspot_hit_targets.push_back(
            {.ref = hotspot.ref,
             .target = hotspot.target,
             .plane = owner_draw->plane,
             .family = owner_draw->family,
             .owner_order = owner_draw->order,
             .stable_identity = owner_draw->stable_identity,
             .base_sublayer = owner_draw->sublayer,
             .input_order = hotspot.input_order,
             .owner_rect = owner_draw->command.rect,
             .owner_uv = owner_draw->command.uv,
             .shape = hotspot.shape,
             .source_texture_lease = owner_draw->texture_lease});
    }
    std::sort(candidate.hotspot_hit_targets.begin(), candidate.hotspot_hit_targets.end(),
              [](const auto& lhs, const auto& rhs) {
                  const auto lhs_owner = std::tie(lhs.plane, lhs.family, lhs.owner_order,
                                                  lhs.stable_identity, lhs.base_sublayer);
                  const auto rhs_owner = std::tie(rhs.plane, rhs.family, rhs.owner_order,
                                                  rhs.stable_identity, rhs.base_sublayer);
                  if (lhs_owner != rhs_owner)
                      return lhs_owner > rhs_owner;
                  if (lhs.input_order != rhs.input_order)
                      return lhs.input_order > rhs.input_order;
                  return hotspot_identity(lhs.ref) < hotspot_identity(rhs.ref);
              });

    for (const auto& hotspot : snapshot.hotspots) {
        if (std::holds_alternative<core::compiled::NoHotspotHighlight>(hotspot.highlight))
            continue;
        const WorldPresentationDraw* owner_draw = owner_draw_for(hotspot.ref);
        if (owner_draw == nullptr || !owner_draw->command.texture.valid()) {
            diagnostics.push_back(diagnostic("presentation.hotspot_owner_visual_missing",
                                             "Hotspot owner has no prepared source-image draw",
                                             hotspot_identity(hotspot.ref)));
            continue;
        }
        std::vector<core::PresentationHotspot> owner_hotspots;
        for (const auto& candidate_hotspot : snapshot.hotspots) {
            if (same_hotspot_owner(hotspot.ref, candidate_hotspot.ref))
                owner_hotspots.push_back(candidate_hotspot);
        }
        auto resources =
            m_resources.resolve_hotspot(hotspot, owner_hotspots, hotspot_identity(hotspot.ref));
        if (!resources) {
            core::append_diagnostics(diagnostics, std::move(resources.error()));
            continue;
        }
        auto prepared = std::move(*resources.value_if());
        WorldPresentationDraw overlay = *owner_draw;
        overlay.sublayer = static_cast<std::uint8_t>(owner_draw->sublayer + 1);
        overlay.stable_identity = owner_draw->stable_identity;
        overlay.command.material = prepared.material;
        overlay.command.hotspot_bounds = std::visit(
            [](const auto& shape) -> Rect {
                using T = std::decay_t<decltype(shape)>;
                if constexpr (std::is_same_v<T, core::AlphaHotspotShape>)
                    return {0.0f, 0.0f, 1.0f, 1.0f};
                else
                    return {static_cast<float>(shape.x), static_cast<float>(shape.y),
                            static_cast<float>(shape.width), static_cast<float>(shape.height)};
            },
            hotspot.shape);
        overlay.command.hotspot_image_dimensions = {static_cast<float>(hotspot.source_width),
                                                    static_cast<float>(hotspot.source_height)};
        if (prepared.mask) {
            overlay.command.hotspot_mask = Texture{prepared.mask->handle};
            overlay.command.hotspot_mask_dimensions = {static_cast<float>(prepared.mask->width),
                                                       static_cast<float>(prepared.mask->height)};
        }
        overlay.material_lease = std::move(prepared.material_lease);
        overlay.hotspot_mask_lease = std::move(prepared.mask_lease);
        candidate.hotspot_surfaces.push_back({hotspot.ref, std::move(overlay)});
    }

    if (!diagnostics.empty())
        return core::Result<bool, core::Diagnostics>::failure(std::move(diagnostics));

    if (candidate.camera) {
        for (auto& draw : candidate.draws)
            if (draw.plane != core::PresentationPlane::GameUi)
                apply_camera(draw.command, *candidate.camera, viewport);
        for (auto& surface : candidate.hotspot_surfaces)
            if (surface.overlay.plane != core::PresentationPlane::GameUi)
                apply_camera(surface.overlay.command, *candidate.camera, viewport);
    }

    std::sort(candidate.draws.begin(), candidate.draws.end(), [](const auto& lhs, const auto& rhs) {
        return std::tie(lhs.plane, lhs.family, lhs.order, lhs.stable_identity, lhs.sublayer) <
               std::tie(rhs.plane, rhs.family, rhs.order, rhs.stable_identity, rhs.sublayer);
    });
    rebuild_batches(candidate);

    m_snapshot = snapshot;
    m_viewport = viewport;
    m_snapshots.insert_or_assign(snapshot.revision.number(), snapshot);
    m_frames.insert_or_assign(snapshot.revision.number(), candidate);
    m_frame = std::move(candidate);
    if (m_generation != std::numeric_limits<std::uint64_t>::max())
        ++m_generation;
    return core::Result<bool, core::Diagnostics>::success(true);
}

namespace {

bool rect_contains_inclusive(Rect rect, Vec2 point) noexcept
{
    return std::isfinite(point.x) && std::isfinite(point.y) && point.x >= rect.x &&
           point.y >= rect.y && point.x <= rect.x + rect.width && point.y <= rect.y + rect.height;
}

bool normalized_hotspot_contains(const core::compiled::NormalizedRect& rect, float u,
                                 float v) noexcept
{
    const float right = static_cast<float>(rect.x + rect.width);
    const float bottom = static_cast<float>(rect.y + rect.height);
    const bool inside_x = u >= rect.x && (u < right || (right == 1.0f && u == 1.0f));
    const bool inside_y = v >= rect.y && (v < bottom || (bottom == 1.0f && v == 1.0f));
    return inside_x && inside_y;
}

bool hotspot_target_contains(const WorldHotspotHitTarget& target, Vec2 point)
{
    if (!rect_contains_inclusive(target.owner_rect, point) || target.owner_rect.width <= 0.0f ||
        target.owner_rect.height <= 0.0f)
        return false;
    const float local_u = (point.x - target.owner_rect.x) / target.owner_rect.width;
    const float local_v = (point.y - target.owner_rect.y) / target.owner_rect.height;
    const float image_u = target.owner_uv.x + local_u * target.owner_uv.width;
    const float image_v = target.owner_uv.y + local_v * target.owner_uv.height;
    return std::visit(
        [&](const auto& shape) {
            using T = std::decay_t<decltype(shape)>;
            if constexpr (std::is_same_v<T, core::AlphaHotspotShape>) {
                return target.source_texture_lease &&
                       (*target.source_texture_lease)->alpha_coverage &&
                       assets::texture_alpha_coverage_contains(
                           *(*target.source_texture_lease)->alpha_coverage, image_u, image_v);
            } else {
                return normalized_hotspot_contains(shape, image_u, image_v);
            }
        },
        target.shape);
}

} // namespace

std::optional<core::compiled::HotspotRef> WorldHotspotController::hit_test(Vec2 point) const
{
    const auto* frame = m_backend.frame();
    if (frame == nullptr)
        return std::nullopt;
    if (frame->camera)
        point = inverse_camera_point(point, *frame->camera, m_backend.viewport());
    for (const auto& target : frame->hotspot_hit_targets) {
        if (hotspot_target_contains(target, point))
            return target.ref;
    }
    return std::nullopt;
}

const WorldHotspotHitTarget*
WorldHotspotController::hit_target(const core::compiled::HotspotRef& ref) const
{
    const auto* frame = m_backend.frame();
    if (frame == nullptr)
        return nullptr;
    const auto found =
        std::find_if(frame->hotspot_hit_targets.begin(), frame->hotspot_hit_targets.end(),
                     [&](const auto& target) { return target.ref == ref; });
    return found == frame->hotspot_hit_targets.end() ? nullptr : &*found;
}

bool WorldHotspotController::contains(const core::compiled::HotspotRef& ref, Vec2 point) const
{
    const auto* frame = m_backend.frame();
    const auto* target = hit_target(ref);
    if (frame == nullptr || target == nullptr)
        return false;
    if (frame->camera)
        point = inverse_camera_point(point, *frame->camera, m_backend.viewport());
    return hotspot_target_contains(*target, point);
}

void WorldHotspotController::set_visual_state(std::optional<core::compiled::HotspotRef> hovered,
                                              std::optional<core::compiled::HotspotRef> pressed)
{
    m_hovered = hovered;
    (void)m_backend.update_hotspot_visual_state({std::move(hovered), std::move(pressed)});
}

void WorldHotspotController::synchronize_generation()
{
    if (m_generation == m_backend.generation())
        return;
    m_generation = m_backend.generation();
    // A committed replacement invalidates the gesture even when the same logical target survives.
    m_capture.reset();
    m_hovered.reset();
    set_visual_state(m_last_mouse_valid ? hit_test(m_last_mouse_reference) : std::nullopt,
                     std::nullopt);
}

void WorldHotspotController::presentation_changed() { synchronize_generation(); }

void WorldHotspotController::target_completed()
{
    synchronize_generation();
    set_visual_state(m_last_mouse_valid ? hit_test(m_last_mouse_reference) : std::nullopt,
                     std::nullopt);
}

void WorldHotspotController::cancel() noexcept
{
    m_capture.reset();
    m_hovered.reset();
    m_last_mouse_valid = false;
    m_generation = m_backend.generation();
    (void)m_backend.update_hotspot_visual_state({});
}

WorldPointerEventResult WorldHotspotController::handle(const WorldPointerEvent& event)
{
    synchronize_generation();
    WorldPointerEventResult result;
    const bool touch = event.kind == WorldPointerEventKind::TouchDown ||
                       event.kind == WorldPointerEventKind::TouchMove ||
                       event.kind == WorldPointerEventKind::TouchUp;

    if (event.kind == WorldPointerEventKind::Cancel) {
        cancel();
        return result;
    }
    if (!touch) {
        m_last_mouse_reference = event.reference_position;
        m_last_mouse_valid = true;
    }
    if (!event.admitted) {
        if (m_capture)
            cancel();
        else if (!touch)
            set_visual_state(std::nullopt, std::nullopt);
        return result;
    }

    if (event.kind == WorldPointerEventKind::MouseMove ||
        event.kind == WorldPointerEventKind::TouchMove) {
        if (m_capture && m_capture->pointer_id == event.pointer_id && m_capture->touch == touch) {
            result.consumed = true;
            m_capture->reference_position = event.reference_position;
            const float dx = event.host_position.x - m_capture->host_origin.x;
            const float dy = event.host_position.y - m_capture->host_origin.y;
            if (!m_capture->target_canceled && dx * dx + dy * dy > 64.0f) {
                m_capture->target_canceled = true;
                set_visual_state(std::nullopt, std::nullopt);
            }
            return result;
        }
        if (!touch)
            set_visual_state(hit_test(event.reference_position), std::nullopt);
        return result;
    }

    if (event.kind == WorldPointerEventKind::MouseDown ||
        event.kind == WorldPointerEventKind::TouchDown) {
        if (!event.primary || m_capture)
            return result;
        auto target = hit_test(event.reference_position);
        if (!target)
            return result;
        m_capture = Capture{
            *target, event.host_position, event.reference_position, event.pointer_id, touch, false};
        set_visual_state(std::nullopt, target);
        result.consumed = true;
        return result;
    }

    if (!m_capture || m_capture->pointer_id != event.pointer_id || m_capture->touch != touch)
        return result;
    result.consumed = true;
    const auto captured = m_capture->ref;
    const bool select_target =
        !m_capture->target_canceled && contains(captured, event.reference_position);
    const auto* semantic_target = select_target ? hit_target(captured) : nullptr;
    const auto target = semantic_target ? std::optional{semantic_target->target} : std::nullopt;
    m_capture.reset();
    set_visual_state(std::nullopt, std::nullopt);
    if (target) {
        result.target = std::move(target);
    } else if (!touch) {
        set_visual_state(hit_test(event.reference_position), std::nullopt);
    }
    return result;
}

void WorldPresentationBackend::rebuild_batches(WorldPresentationFrame& frame,
                                               const core::RuntimeClockUpdate* clock)
{
    frame.base_batch.clear();
    frame.base_world_composition_batch.clear();
    frame.base_game_ui_underlay_batch.clear();
    for (const auto& draw : frame.draws) {
        QuadCommand command = draw.command;
        double elapsed_seconds = 0.0;
        const auto domain =
            draw.actor_idle ? std::optional{draw.actor_idle->clock} : draw.environment_clock;
        if (clock && domain) {
            const auto now = clock_time(*clock, *domain);
            const auto key = loop_key(draw);
            auto [epoch, inserted] = m_loop_epochs.try_emplace(key, LoopEpoch{*domain, now});
            if (!inserted && epoch->second.clock != *domain)
                epoch->second = LoopEpoch{*domain, now};
            const auto elapsed = now >= epoch->second.started_at ? now - epoch->second.started_at
                                                                 : std::chrono::microseconds{0};
            elapsed_seconds = std::chrono::duration<double>(elapsed).count();
        }

        if (draw.actor_idle) {
            const auto& idle = *draw.actor_idle;
            const double period_seconds = static_cast<double>(idle.period_ms) / 1000.0;
            const double wave = period_seconds > 0.0 ? std::sin((elapsed_seconds / period_seconds) *
                                                                std::numbers::pi_v<double> * 2.0)
                                                     : 0.0;
            const float amount = static_cast<float>(idle.amplitude * wave);
            switch (idle.kind) {
            case core::compiled::CharacterIdleKind::Bob:
                command.rect.y -= amount * m_viewport.height;
                break;
            case core::compiled::CharacterIdleKind::Sway:
                command.rect.x += amount * m_viewport.width;
                break;
            case core::compiled::CharacterIdleKind::Pulse: {
                const float scale = std::max(0.0f, 1.0f + amount);
                const float width = command.rect.width * scale;
                const float height = command.rect.height * scale;
                command.rect.x += (command.rect.width - width) * 0.5f;
                command.rect.y += (command.rect.height - height) * 0.5f;
                command.rect.width = width;
                command.rect.height = height;
                break;
            }
            }
        }
        if (draw.environment_clock) {
            command.uv.x +=
                static_cast<float>(draw.environment_scroll_per_second.x * elapsed_seconds);
            command.uv.y +=
                static_cast<float>(draw.environment_scroll_per_second.y * elapsed_seconds);
            command.time_seconds = static_cast<float>(elapsed_seconds);
        }

        frame.base_batch.draw(command);
        QuadBatch& composition_batch = draw.plane == core::PresentationPlane::GameUi
                                           ? frame.base_game_ui_underlay_batch
                                           : frame.base_world_composition_batch;
        composition_batch.draw(std::move(command));
    }
    rebuild_hotspot_overlays(frame);
}

void WorldPresentationBackend::rebuild_hotspot_overlays(WorldPresentationFrame& frame)
{
    frame.batch = frame.base_batch;
    frame.world_composition_batch = frame.base_world_composition_batch;
    frame.game_ui_underlay_batch = frame.base_game_ui_underlay_batch;
    const auto active = m_hotspot_visual_state.pressed ? m_hotspot_visual_state.pressed
                                                       : m_hotspot_visual_state.hovered;
    if (!active)
        return;
    const auto found = std::find_if(frame.hotspot_surfaces.begin(), frame.hotspot_surfaces.end(),
                                    [&](const auto& surface) { return surface.ref == *active; });
    if (found == frame.hotspot_surfaces.end())
        return;
    QuadCommand command = found->overlay.command;
    command.hotspot_hovered = m_hotspot_visual_state.hovered == active;
    command.hotspot_pressed = m_hotspot_visual_state.pressed == active;
    frame.batch.draw(command);
    QuadBatch& composition_batch = found->overlay.plane == core::PresentationPlane::GameUi
                                       ? frame.game_ui_underlay_batch
                                       : frame.world_composition_batch;
    composition_batch.draw(std::move(command));
}

bool WorldPresentationBackend::update_hotspot_visual_state(HotspotInteractionVisualState state)
{
    if (state.hovered == m_hotspot_visual_state.hovered &&
        state.pressed == m_hotspot_visual_state.pressed)
        return false;
    const auto valid = [&](const auto& ref) {
        return !ref ||
               (m_frame &&
                std::any_of(m_frame->hotspot_surfaces.begin(), m_frame->hotspot_surfaces.end(),
                            [&](const auto& surface) { return surface.ref == *ref; }));
    };
    if (!valid(state.hovered))
        state.hovered.reset();
    if (!valid(state.pressed))
        state.pressed.reset();
    m_hotspot_visual_state = std::move(state);
    for (auto& [_, frame] : m_frames)
        rebuild_hotspot_overlays(frame);
    if (m_snapshot) {
        const auto found = m_frames.find(m_snapshot->revision.number());
        if (found != m_frames.end())
            m_frame = found->second;
    }
    return true;
}

void WorldPresentationBackend::realize(const core::RuntimeClockUpdate& clock)
{
    for (auto& [_, frame] : m_frames)
        rebuild_batches(frame, &clock);
    if (m_snapshot) {
        const auto found = m_frames.find(m_snapshot->revision.number());
        if (found != m_frames.end())
            m_frame = found->second;
    }
}

void WorldPresentationBackend::prune_loop_epochs()
{
    std::unordered_set<std::string> active;
    for (const auto& [_, frame] : m_frames) {
        for (const auto& draw : frame.draws) {
            if (draw.actor_idle || draw.environment_clock)
                active.insert(loop_key(draw));
        }
    }
    std::erase_if(m_loop_epochs,
                  [&active](const auto& item) { return !active.contains(item.first); });
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
        const auto snapshot = previous_snapshots.find(revision);
        if (snapshot == previous_snapshots.end())
            continue;
        auto rebuilt = reconcile(snapshot->second, viewport);
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
    m_loop_epochs.clear();
    m_generation = 0;
    m_hotspot_visual_state = {};
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

const core::RuntimePresentationSnapshot*
WorldPresentationBackend::snapshot(core::PresentationSnapshotRevision revision) const noexcept
{
    const auto found = m_snapshots.find(revision.number());
    return found == m_snapshots.end() ? nullptr : &found->second;
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

void WorldPresentationBackend::swap_prepared(WorldPresentationBackend& prepared) noexcept
{
    using std::swap;
    swap(m_snapshot, prepared.m_snapshot);
    swap(m_viewport, prepared.m_viewport);
    swap(m_frame, prepared.m_frame);
    swap(m_snapshots, prepared.m_snapshots);
    swap(m_frames, prepared.m_frames);
    swap(m_loop_epochs, prepared.m_loop_epochs);
    swap(m_generation, prepared.m_generation);
    swap(m_hotspot_visual_state, prepared.m_hotspot_visual_state);
}

void WorldPresentationBackend::discard_revision(
    core::PresentationSnapshotRevision revision) noexcept
{
    const auto number = revision.number();
    m_snapshots.erase(number);
    m_frames.erase(number);
    prune_loop_epochs();
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
    prune_loop_epochs();
}

} // namespace noveltea
