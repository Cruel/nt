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

void append_world_overlay_command(std::vector<OrderedWorldOverlayBatch>& batches,
                                  std::int32_t order, QuadCommand command)
{
    const auto found = std::lower_bound(batches.begin(), batches.end(), order,
                                        [](const OrderedWorldOverlayBatch& batch,
                                           std::int32_t value) { return batch.order < value; });
    if (found != batches.end() && found->order == order) {
        found->batch.draw(std::move(command));
        return;
    }
    OrderedWorldOverlayBatch batch;
    batch.order = order;
    batch.batch.draw(std::move(command));
    batches.insert(found, std::move(batch));
}

std::optional<core::PresentationPropInstanceId>
prop_material_instance(const core::PresentationPropKey& key)
{
    return std::visit(
        [](const auto& value) -> std::optional<core::PresentationPropInstanceId> {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, core::RoomPropPresentationKey>) {
                auto id = core::PresentationPropInstanceId::create(
                    "room-" + std::to_string(value.room.text().size()) + "-" + value.room.text() +
                    "-prop-" + value.prop.text());
                return id ? std::optional<core::PresentationPropInstanceId>{*id.value_if()}
                          : std::nullopt;
            } else {
                return value.instance;
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

std::string presentation_owner_identity(const core::PresentationOwner& owner)
{
    return std::visit(
        [](const auto& value) -> std::string {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, core::ScenePresentationOwner>) {
                return "scene/" + std::to_string(value.invocation.number()) + "/" +
                       value.scene.text();
            } else if constexpr (std::is_same_v<T, core::DialoguePresentationOwner>) {
                return "dialogue/" + std::to_string(value.invocation.number()) + "/" +
                       value.dialogue.text();
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

std::optional<QuadCommand> visual_command(core::PresentationPlane plane, Rect rect, Rect uv,
                                          const WorldPreparedVisual& visual)
{
    if (!visual.texture && !visual.material)
        return std::nullopt;
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
    return command;
}

void append_visual_draw(std::vector<WorldPresentationDraw>& draws, core::PresentationPlane plane,
                        WorldDrawFamily family, std::int32_t order, std::string stable_identity,
                        std::uint8_t sublayer, Rect rect, Rect uv,
                        const WorldPreparedVisual& visual,
                        std::optional<core::compiled::CharacterIdle> actor_idle = std::nullopt,
                        std::optional<core::LayoutClockDomain> environment_clock = std::nullopt,
                        core::compiled::Vector2 environment_scroll_per_second = {0.0, 0.0},
                        std::optional<core::PresentationOwner> material_owner = std::nullopt,
                        std::optional<core::MaterialOccurrence> material_occurrence = std::nullopt)
{
    auto command = visual_command(plane, rect, uv, visual);
    if (!command)
        return;
    draws.push_back({plane,
                     family,
                     order,
                     std::move(stable_identity),
                     sublayer,
                     std::move(material_owner),
                     std::move(material_occurrence),
                     std::move(*command),
                     std::move(actor_idle),
                     environment_clock,
                     environment_scroll_per_second,
                     visual.texture_lease,
                     visual.material_lease,
                     std::nullopt,
                     {},
                     {},
                     false,
                     {},
                     {},
                     {}});
    auto& draw = draws.back();
    draw.raster_animation_key = visual.animation_key;
    draw.motion_policy = visual.motion_policy;
    draw.motion_initial_ms = visual.motion_initial_ms;
    draw.raster_animation_frames.reserve(visual.animation_frames.size());
    for (const auto& frame : visual.animation_frames)
        draw.raster_animation_frames.push_back({frame.duration_ms, Texture{frame.texture.handle},
                                                frame.texture.sampler, frame.texture_lease});
}

void append_resource_diagnostics(core::Diagnostics& diagnostics,
                                 core::Result<WorldPreparedVisual, core::Diagnostics>& resolved)
{
    if (!resolved)
        core::append_diagnostics(diagnostics, std::move(resolved.error()));
}

Size visual_size(const WorldPreparedVisual& visual) noexcept
{
    if (visual.logical_size)
        return *visual.logical_size;
    return visual.texture ? Size{static_cast<float>(visual.texture->width),
                                 static_cast<float>(visual.texture->height)}
                          : Size{};
}

std::optional<ShaderUniformValue>
render_material_parameter_value(const core::compiled::MaterialParameterValue& value) noexcept
{
    return std::visit(
        [](const auto& item) -> std::optional<ShaderUniformValue> {
            using T = std::decay_t<decltype(item)>;
            if constexpr (std::is_same_v<T, double>) {
                if (!std::isfinite(item) || item < -std::numeric_limits<float>::max() ||
                    item > std::numeric_limits<float>::max())
                    return std::nullopt;
                return ShaderUniformValue{static_cast<float>(item)};
            } else if constexpr (std::is_same_v<T, std::array<double, 2>>) {
                return ShaderUniformValue{
                    std::array<float, 2>{static_cast<float>(item[0]), static_cast<float>(item[1])}};
            } else if constexpr (std::is_same_v<T, std::array<double, 3>>) {
                return ShaderUniformValue{std::array<float, 3>{static_cast<float>(item[0]),
                                                               static_cast<float>(item[1]),
                                                               static_cast<float>(item[2])}};
            } else if constexpr (std::is_same_v<T, std::array<double, 4>>) {
                return ShaderUniformValue{
                    std::array<float, 4>{static_cast<float>(item[0]), static_cast<float>(item[1]),
                                         static_cast<float>(item[2]), static_cast<float>(item[3])}};
            } else if constexpr (std::is_same_v<T, core::compiled::MaterialColorValue>) {
                return ShaderUniformValue{
                    ShaderColor{static_cast<float>(item.r), static_cast<float>(item.g),
                                static_cast<float>(item.b), static_cast<float>(item.a)}};
            } else if constexpr (std::is_same_v<T, std::int64_t>) {
                if (!core::compiled::material_int_is_exact(item))
                    return std::nullopt;
                return ShaderUniformValue{static_cast<int>(item)};
            } else {
                return ShaderUniformValue{item};
            }
        },
        value);
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

std::string interactable_draw_identity(
    const core::InteractableInstanceId& instance,
    const std::optional<core::ResolvedRoomInteractableOccurrenceId>& occurrence,
    const std::optional<core::compiled::RoomPlacementRef>& placement)
{
    if (!occurrence)
        return instance.text();
    return (placement ? placement->room.text() + "/" : std::string{}) + instance.text() + "/" +
           std::visit(
               [](const auto& value) {
                   using T = std::decay_t<decltype(value)>;
                   if constexpr (std::is_same_v<T, core::RoomInteractableEntryId>)
                       return std::string{"authored/"} + value.text();
                   else if constexpr (std::is_same_v<T, core::DynamicRoomInteractableOccurrenceId>)
                       return std::string{"dynamic/"} + value.interactable.text();
                   else
                       return std::string{"fallback/"} + value.interactable.text();
               },
               *occurrence);
}

std::string raster_animation_identity(const WorldPresentationDraw& draw)
{
    return loop_key(draw) + (draw.actor_layer_id ? ":layer:" + draw.actor_layer_id->text() : "");
}

core::LayoutClockDomain raster_animation_clock(const WorldPresentationDraw& draw)
{
    return draw.motion_policy ? draw.motion_policy->clock
                              : draw.environment_clock.value_or(core::LayoutClockDomain::Gameplay);
}

bool compatible_raster_animation(const WorldPresentationDraw& left,
                                 const WorldPresentationDraw& right)
{
    return !left.raster_animation_frames.empty() &&
           raster_animation_identity(left) == raster_animation_identity(right) &&
           left.raster_animation_key == right.raster_animation_key &&
           left.motion_policy == right.motion_policy &&
           left.motion_initial_ms == right.motion_initial_ms &&
           raster_animation_clock(left) == raster_animation_clock(right);
}

std::string raster_animation_loop_key(const WorldPresentationDraw& draw)
{
    return raster_animation_identity(draw) +
           ":visual-animation:" + std::to_string(draw.raster_animation_epoch);
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

std::string world_hotspot_identity(const core::compiled::HotspotRef& ref)
{
    return hotspot_identity(ref);
}

std::optional<QuadCommand>
WorldPresentationDraw::ActorAnimationFrame::sample(std::uint64_t elapsed_ms,
                                                   const QuadCommand& underlying) const
{
    if (!command)
        return std::nullopt;
    auto result = *command;
    // Choreography that omits Visual selection must not restart the underlying layer.
    if (!overrides_visual) {
        result.texture = underlying.texture;
        result.texture_sampler = underlying.texture_sampler;
        return result;
    }
    std::uint64_t duration_ms = 0;
    for (const auto& frame : visual_frames)
        duration_ms += frame.duration_ms;
    if (duration_ms == 0)
        return result;
    auto phase = elapsed_ms % duration_ms;
    for (const auto& frame : visual_frames) {
        if (phase < frame.duration_ms) {
            result.texture = Texture{frame.texture.handle};
            result.texture_sampler = frame.texture.sampler;
            break;
        }
        phase -= frame.duration_ms;
    }
    return result;
}

void AssetWorldPresentationResourceResolver::bind_project(const core::CompiledProject& project,
                                                          std::string_view active_locale)
{
    WorldPresentationResourceCatalog catalog;
    for (const auto& asset : project.assets()) {
        if (asset.kind != core::compiled::AssetKind::Image)
            continue;
        const auto* resolved = project.resolve_asset(asset.id, active_locale);
        if (resolved == nullptr || resolved->kind != core::compiled::AssetKind::Image)
            continue;
        assert(resolved->sampling.has_value());
        const auto sampler = *resolved->sampling == core::compiled::ImageSampling::Nearest
                                 ? MaterialTextureSampler::ClampNearest
                                 : MaterialTextureSampler::ClampLinear;
        catalog.images.push_back({.asset_id = asset.id,
                                  .logical_path = "project:/" + resolved->path,
                                  .sampler = sampler});
    }
    catalog.animations = project.animations();
    bind_catalog(std::move(catalog));
}

void AssetWorldPresentationResourceResolver::bind_catalog(WorldPresentationResourceCatalog catalog)
{
    m_images.clear();
    for (auto& image : catalog.images)
        m_images.emplace(image.asset_id.text(), std::move(image));
    m_animations.clear();
    for (auto& animation : catalog.animations)
        m_animations.emplace(animation.id.text(), std::move(animation));
}

void AssetWorldPresentationResourceResolver::clear()
{
    m_images.clear();
    m_animations.clear();
}

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
        const auto* lease = m_assets.leased_texture_on_owner(request, m_lookup_scope);
        if (lease == nullptr) {
            return core::Result<WorldPreparedVisual, core::Diagnostics>::failure({diagnostic(
                "presentation.world_texture_lease_missing",
                "Mandatory world texture is not resident: " + found->second.logical_path + " (" +
                    m_assets.describe_texture_lease_lookup_on_owner(request, m_lookup_scope) + ")",
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
        const auto* lease = m_assets.leased_material_on_owner(request, m_lookup_scope);
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

core::Result<WorldPreparedVisual, core::Diagnostics>
AssetWorldPresentationResourceResolver::resolve_visual(const core::compiled::Visual& visual,
                                                       std::optional<core::MaterialId> material,
                                                       std::string_view context)
{
    if (const auto* image = std::get_if<core::compiled::ImageVisual>(&visual))
        return resolve(image->image, material, context);

    const auto& selection = std::get<core::compiled::AnimationVisual>(visual);
    const auto resource = m_animations.find(selection.animation.text());
    if (resource == m_animations.end()) {
        return core::Result<WorldPreparedVisual, core::Diagnostics>::failure(
            {diagnostic("presentation.world_animation_unresolved",
                        "World presentation Animation is not in the prepared project catalog: " +
                            selection.animation.text(),
                        context)});
    }
    const auto motion_id = selection.motion.value_or(resource->second.default_motion);
    const auto motion = std::ranges::find_if(
        resource->second.motions, [&](const auto& candidate) { return candidate.id == motion_id; });
    if (motion == resource->second.motions.end()) {
        return core::Result<WorldPreparedVisual, core::Diagnostics>::failure({diagnostic(
            "presentation.world_animation_motion_unresolved",
            "World presentation Animation motion is unavailable: " + motion_id.text(), context)});
    }

    const auto initial = core::compiled::motion_initial_time(
        *motion, selection.playback.value_or(core::MotionPlaybackPolicy{}));
    if (!initial)
        return core::Result<WorldPreparedVisual, core::Diagnostics>::failure(
            {diagnostic("presentation.world_animation_policy_invalid",
                        "Invalid motion playback policy or initial marker", context)});
    auto material_result = resolve(std::nullopt, material, context);
    if (!material_result)
        return material_result;
    WorldPreparedVisual result = std::move(*material_result.value_if());
    result.logical_size = Size{static_cast<float>(resource->second.canvas.width),
                               static_cast<float>(resource->second.canvas.height)};
    result.animation_key = std::to_string(selection.animation.text().size()) + ":" +
                           selection.animation.text() + ":" +
                           std::to_string(motion_id.text().size()) + ":" + motion_id.text() + ":" +
                           std::to_string(resource->second.canvas.width) + "x" +
                           std::to_string(resource->second.canvas.height);
    result.motion_policy = selection.playback;
    result.motion_initial_ms = *initial;
    result.animation_frames.reserve(motion->frames.size());
    for (std::size_t index = 0; index < motion->frames.size(); ++index) {
        const auto& frame = motion->frames[index];
        auto frame_result = resolve(frame.image, std::nullopt,
                                    std::string(context) + "/frame/" + std::to_string(index));
        if (!frame_result)
            return frame_result;
        auto prepared = std::move(*frame_result.value_if());
        if (!prepared.texture) {
            return core::Result<WorldPreparedVisual, core::Diagnostics>::failure(
                {diagnostic("presentation.world_animation_frame_unresolved",
                            "World presentation Animation frame did not resolve to a texture: " +
                                frame.image.text(),
                            context)});
        }
        result.animation_key += ":" + std::to_string(frame.image.text().size()) + ":" +
                                frame.image.text() + ":" + std::to_string(frame.duration_ms);
        result.animation_frames.push_back(
            {frame.duration_ms, *prepared.texture, std::move(prepared.texture_lease)});
    }
    if (!result.animation_frames.empty()) {
        result.texture = result.animation_frames.front().texture;
        result.texture_lease = result.animation_frames.front().texture_lease;
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
        const auto* lease = m_assets.leased_material_on_owner(request, m_lookup_scope);
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
        const auto* lease = m_assets.leased_hotspot_mask_on_owner(request, m_lookup_scope);
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

WorldProjectedRect
WorldPresentationLayoutPolicy::project_room_rect(const core::compiled::NormalizedRect& bounds,
                                                 const core::PresentationCamera& camera,
                                                 Size viewport) noexcept
{
    QuadCommand command;
    command.rect = normalized_rect(bounds, viewport);
    apply_camera(command, resolved_camera(camera), viewport);
    return {command.rect, command.rotation_degrees, command.rotation_origin};
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

Rect WorldPresentationLayoutPolicy::actor_rect(const core::PresentationActor& actor,
                                               const core::PresentationActorLayer& layer,
                                               Size viewport, Size texture) noexcept
{
    if (texture.width <= 0.0f || texture.height <= 0.0f)
        texture = {viewport.width * 0.32f, viewport.height * 0.78f};
    const float scale = static_cast<float>(layer.scale * actor.placement.scale);
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
    anchor_x += static_cast<float>(layer.offset.x) * scale;
    anchor_y += static_cast<float>(layer.offset.y) * scale;
    return {anchor_x - static_cast<float>(layer.anchor.x) * width,
            anchor_y - static_cast<float>(layer.anchor.y) * height, width, height};
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
    if (!m_resources_dirty && m_snapshot && *m_snapshot == snapshot &&
        m_viewport.width == viewport.width && m_viewport.height == viewport.height)
        return core::Result<bool, core::Diagnostics>::success(false);

    WorldPresentationFrame candidate;
    candidate.revision = snapshot.revision;
    candidate.material_parameters = snapshot.material_parameters;
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
                                           std::nullopt,
                                           std::nullopt,
                                           std::move(command),
                                           std::nullopt,
                                           std::nullopt,
                                           {0.0, 0.0},
                                           std::nullopt,
                                           std::nullopt,
                                           std::nullopt,
                                           {},
                                           {},
                                           false,
                                           {},
                                           {},
                                           {}});
            }
        }
        auto resolved = m_resources.resolve(background.asset, background.material, "background");
        if (!resolved) {
            append_resource_diagnostics(diagnostics, resolved);
        } else if (const auto* visual = resolved.value_if(); visual->texture || visual->material) {
            const WorldFittedRect fitted = WorldPresentationLayoutPolicy::fit_background(
                viewport, visual_size(*visual), background.fit);
            const auto draw_index = candidate.draws.size();
            append_visual_draw(
                candidate.draws, core::PresentationPlane::WorldBackground,
                WorldDrawFamily::Background, 0, "background", 1, fitted.rect, fitted.uv, *visual,
                std::nullopt, std::nullopt, {0.0, 0.0}, background.material_owner,
                background.material_owner
                    ? std::optional<core::MaterialOccurrence>{core::BackgroundMaterialOccurrence{}}
                    : std::nullopt);
            if (candidate.draws.size() != draw_index) {
                auto& command = candidate.draws.back().command;
                for (const auto& texture : background.material_texture_overrides)
                    command.material_texture_overrides.push_back(
                        MaterialTextureOverride{texture.name, texture.source});
            }
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
        auto resolved =
            environment.visual
                ? m_resources.resolve_visual(*environment.visual, environment.material,
                                             "environment/" + environment.instance.text())
                : m_resources.resolve(environment.asset, environment.material,
                                      "environment/" + environment.instance.text());
        if (!resolved) {
            append_resource_diagnostics(diagnostics, resolved);
        } else {
            auto visual = *resolved.value_if();
            visual.tint.a *= static_cast<float>(environment.opacity);
            const auto draw_index = candidate.draws.size();
            append_visual_draw(
                candidate.draws, environment.plane, WorldDrawFamily::Environment, environment.order,
                environment_identity(environment), 0,
                WorldPresentationLayoutPolicy::normalized_rect(environment.bounds, viewport),
                full_uv, visual, std::nullopt, environment.clock, environment.scroll_per_second,
                environment.owner,
                core::MaterialOccurrence{
                    core::EnvironmentMaterialOccurrence{environment.instance}});
            if (candidate.draws.size() != draw_index) {
                auto& command = candidate.draws.back().command;
                for (const auto& texture : environment.material_texture_overrides)
                    command.material_texture_overrides.push_back(
                        MaterialTextureOverride{texture.name, texture.source});
            }
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
        const auto material_instance = prop_material_instance(prop.key);
        const auto draw_index = candidate.draws.size();
        append_visual_draw(
            candidate.draws, prop.plane, WorldDrawFamily::Prop, prop.order, identity, 0,
            WorldPresentationLayoutPolicy::normalized_rect(prop.bounds, viewport), full_uv, *visual,
            std::nullopt, std::nullopt, {0.0, 0.0}, prop.owner,
            material_instance
                ? std::optional<core::MaterialOccurrence>{core::PropMaterialOccurrence{
                      *material_instance}}
                : std::nullopt);
        if (candidate.draws.size() != draw_index) {
            auto& command = candidate.draws.back().command;
            for (const auto& texture : prop.material_texture_overrides)
                command.material_texture_overrides.push_back(
                    MaterialTextureOverride{texture.name, texture.source});
        }
    }

    for (const auto& interactable : snapshot.interactables) {
        if (!interactable.visible)
            continue;
        const std::string identity = interactable_draw_identity(
            interactable.interactable, interactable.occurrence, interactable.placement);
        if (!valid_draw_plane(interactable.plane)) {
            diagnostics.push_back(
                diagnostic("presentation.world_plane_unsupported",
                           "Engine Interactable uses a non-engine presentation plane",
                           "interactable/" + identity));
            continue;
        }
        auto resolved =
            interactable.visual
                ? m_resources.resolve_visual(*interactable.visual, interactable.material,
                                             "interactable/" + identity)
                : m_resources.resolve(std::nullopt, interactable.material,
                                      "interactable/" + identity);
        if (!resolved) {
            append_resource_diagnostics(diagnostics, resolved);
            continue;
        }
        const auto* visual = resolved.value_if();
        const auto draw_index = candidate.draws.size();
        append_visual_draw(
            candidate.draws, interactable.plane, WorldDrawFamily::Interactable, interactable.order,
            identity, 0,
            WorldPresentationLayoutPolicy::normalized_rect(interactable.bounds, viewport), full_uv,
            *visual, std::nullopt, std::nullopt, {0.0, 0.0}, interactable.material_owner,
            interactable.material_owner
                ? std::optional<core::MaterialOccurrence>{core::InteractableMaterialOccurrence{
                      interactable.interactable}}
                : std::nullopt);
        if (candidate.draws.size() == draw_index)
            continue;
        auto& command = candidate.draws.back().command;
        for (const auto& texture : interactable.material_texture_overrides)
            command.material_texture_overrides.push_back(
                MaterialTextureOverride{texture.name, texture.source});
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
        for (std::size_t layer_index = 0; layer_index < actor.layers.size(); ++layer_index) {
            const auto& layer = actor.layers[layer_index];
            if (!layer.visible)
                continue;
            const auto context = "actor/" + identity + "/layer/" + layer.id.text();
            auto resolved = layer.visual
                                ? m_resources.resolve_visual(*layer.visual, layer.material, context)
                                : m_resources.resolve(std::nullopt, layer.material, context);
            if (!resolved) {
                append_resource_diagnostics(diagnostics, resolved);
                continue;
            }
            const auto* visual = resolved.value_if();
            if (!visual->texture && !visual->material)
                continue;
            const Rect rect = WorldPresentationLayoutPolicy::actor_rect(actor, layer, viewport,
                                                                        visual_size(*visual));
            const auto draw_index = candidate.draws.size();
            append_visual_draw(
                candidate.draws, actor.plane, WorldDrawFamily::Actor, actor.order, identity,
                static_cast<std::int32_t>(layer_index), rect, full_uv, *visual, actor.idle,
                std::nullopt, {0.0, 0.0}, actor.material_owner,
                actor.material_owner
                    ? std::optional<core::MaterialOccurrence>{core::ActorMaterialOccurrence{
                          actor.key, layer.id}}
                    : std::nullopt);
            if (candidate.draws.size() == draw_index)
                continue;
            auto& draw = candidate.draws.back();
            for (const auto& texture : layer.material_texture_overrides)
                draw.command.material_texture_overrides.push_back(
                    MaterialTextureOverride{texture.name, texture.source});
            draw.actor_layer_id = layer.id;
            draw.actor_automatic_animations = actor.automatic_animations;
            draw.actor_speaking = actor.speaking;
            draw.actor_animation_clips.reserve(actor.animation_clips.size());
            for (const auto& clip : actor.animation_clips) {
                WorldPresentationDraw::ActorAnimationClip prepared{clip.id, clip.clock, {}};
                prepared.frames.reserve(clip.frames.size());
                for (const auto& frame : clip.frames) {
                    auto animated = layer;
                    const auto patch =
                        std::ranges::find_if(frame.layers, [&](const auto& candidate) {
                            return candidate.layer_id == layer.id;
                        });
                    if (patch != frame.layers.end()) {
                        if (patch->visual.specified)
                            animated.visual = patch->visual.value;
                        if (patch->material.specified) {
                            animated.material = patch->material.value;
                            animated.material_parameters = patch->material_parameters;
                            animated.material_texture_overrides.clear();
                        }
                        if (patch->offset)
                            animated.offset = *patch->offset;
                        if (patch->scale)
                            animated.scale = *patch->scale;
                        if (patch->anchor)
                            animated.anchor = *patch->anchor;
                        if (patch->visible)
                            animated.visible = *patch->visible;
                    }
                    WorldPresentationDraw::ActorAnimationFrame prepared_frame;
                    prepared_frame.duration_ms = frame.duration_ms;
                    prepared_frame.overrides_visual =
                        patch != frame.layers.end() && patch->visual.specified;
                    if (animated.visible) {
                        const auto frame_context = "actor/" + identity + "/animation/" +
                                                   clip.id.text() + "/layer/" + layer.id.text();
                        auto frame_visual =
                            animated.visual
                                ? m_resources.resolve_visual(*animated.visual, animated.material,
                                                             frame_context)
                                : m_resources.resolve(std::nullopt, animated.material,
                                                      frame_context);
                        if (!frame_visual) {
                            append_resource_diagnostics(diagnostics, frame_visual);
                        } else if (const auto* resolved_frame = frame_visual.value_if();
                                   resolved_frame->texture || resolved_frame->material) {
                            prepared_frame.command = visual_command(
                                actor.plane,
                                WorldPresentationLayoutPolicy::actor_rect(
                                    actor, animated, viewport, visual_size(*resolved_frame)),
                                full_uv, *resolved_frame);
                            if (prepared_frame.command)
                                for (const auto& texture : animated.material_texture_overrides)
                                    prepared_frame.command->material_texture_overrides.push_back(
                                        MaterialTextureOverride{texture.name, texture.source});
                            prepared_frame.texture_lease = resolved_frame->texture_lease;
                            prepared_frame.material_lease = resolved_frame->material_lease;
                            prepared_frame.visual_frames = resolved_frame->animation_frames;
                        }
                    }
                    prepared.frames.push_back(std::move(prepared_frame));
                }
                draw.actor_animation_clips.push_back(std::move(prepared));
            }
        }
    }

    const auto owner_draw_for =
        [&](const core::PresentationHotspot& hotspot) -> const WorldPresentationDraw* {
        const auto& ref = hotspot.ref;
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
                       draw.stable_identity ==
                           interactable_draw_identity(interactable.interactable,
                                                      hotspot.interactable_occurrence,
                                                      hotspot.interactable_placement) &&
                       draw.sublayer == 0;
            });
        return found == candidate.draws.end() ? nullptr : &*found;
    };

    for (const auto& hotspot : snapshot.hotspots) {
        if (!hotspot.condition_eligible || !hotspot.target_available)
            continue;
        const WorldPresentationDraw* owner_draw = owner_draw_for(hotspot);
        if (owner_draw == nullptr) {
            const auto* ref = std::get_if<core::compiled::InteractableHotspotRef>(&hotspot.ref);
            const auto occurrence =
                std::ranges::find_if(snapshot.interactables, [&](const auto& value) {
                    return ref && value.interactable == ref->interactable &&
                           value.occurrence == hotspot.interactable_occurrence;
                });
            const bool hidden = occurrence != snapshot.interactables.end() && !occurrence->visible;
            if (!hidden && std::holds_alternative<core::AlphaHotspotShape>(hotspot.shape))
                diagnostics.push_back(diagnostic("presentation.visual_alpha_coverage_unavailable",
                                                 "Visual-alpha owner has no realized raster sample",
                                                 hotspot_identity(hotspot.ref)));
            continue;
        }
        if (std::holds_alternative<core::AlphaHotspotShape>(hotspot.shape)) {
            const auto has_coverage = [](const auto& lease) {
                return lease && (*lease)->alpha_coverage.has_value();
            };
            const bool supported =
                owner_draw->raster_animation_frames.empty()
                    ? has_coverage(owner_draw->texture_lease)
                    : std::ranges::all_of(
                          owner_draw->raster_animation_frames,
                          [&](const auto& frame) { return has_coverage(frame.texture_lease); });
            if (!supported) {
                diagnostics.push_back(diagnostic(
                    "presentation.visual_alpha_coverage_unavailable",
                    "Visual-alpha requires retained CPU coverage for every realized frame",
                    hotspot_identity(hotspot.ref)));
                continue;
            }
        }
        candidate.hotspot_hit_targets.push_back({.ref = hotspot.ref,
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
                                                 .source_texture_lease = owner_draw->texture_lease,
                                                 .cursor = hotspot.cursor});
    }
    std::sort(candidate.hotspot_hit_targets.begin(), candidate.hotspot_hit_targets.end(),
              [](const auto& lhs, const auto& rhs) {
                  const auto lhs_owner = std::tie(lhs.plane, lhs.owner_order, lhs.family,
                                                  lhs.stable_identity, lhs.base_sublayer);
                  const auto rhs_owner = std::tie(rhs.plane, rhs.owner_order, rhs.family,
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
        const WorldPresentationDraw* owner_draw = owner_draw_for(hotspot);
        // Highlight source support does not determine whether analytic geometry can be hit.
        if (owner_draw == nullptr || !owner_draw->command.texture.valid())
            continue;
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
        overlay.command.material_uniform_overrides.clear();
        overlay.command.material_texture_overrides.clear();
        for (const auto& texture : hotspot.material_texture_overrides)
            overlay.command.material_texture_overrides.push_back(
                MaterialTextureOverride{texture.name, texture.source});
        overlay.authored_hotspot_parameters = hotspot.material_parameters;
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
        const auto structural_rank = [](const auto& draw) {
            return draw.plane == core::PresentationPlane::WorldBackground &&
                           draw.family == WorldDrawFamily::Background
                       ? 0
                       : 1;
        };
        const auto lhs_rank = structural_rank(lhs);
        const auto rhs_rank = structural_rank(rhs);
        return std::tie(lhs.plane, lhs_rank, lhs.order, lhs.family, lhs.stable_identity,
                        lhs.sublayer) < std::tie(rhs.plane, rhs_rank, rhs.order, rhs.family,
                                                 rhs.stable_identity, rhs.sublayer);
    });
    for (auto& draw : candidate.draws) {
        if (draw.raster_animation_frames.empty())
            continue;
        if (m_frame) {
            const auto previous = std::ranges::find_if(m_frame->draws, [&](const auto& value) {
                return compatible_raster_animation(value, draw);
            });
            if (previous != m_frame->draws.end())
                draw.raster_animation_epoch = previous->raster_animation_epoch;
        }
        // Returning to an older selection is a new occurrence anchor, not a retained revision's
        // phase.
        if (draw.raster_animation_epoch == 0)
            draw.raster_animation_epoch = ++m_animation_epoch_generation;
    }
    rebuild_batches(candidate);

    m_snapshot = snapshot;
    m_viewport = viewport;
    m_snapshots.insert_or_assign(snapshot.revision.number(), snapshot);
    m_frames.insert_or_assign(snapshot.revision.number(), candidate);
    m_frame = std::move(candidate);
    m_resources_dirty = false;
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

const WorldHotspotHitTarget* WorldHotspotController::hit_target_at(Vec2 point) const
{
    const auto* frame = m_backend.frame();
    if (frame == nullptr)
        return nullptr;
    if (frame->camera)
        point = inverse_camera_point(point, *frame->camera, m_backend.viewport());
    for (const auto& target : frame->hotspot_hit_targets) {
        if (hotspot_target_contains(target, point))
            return &target;
    }
    return nullptr;
}

std::optional<core::compiled::HotspotRef> WorldHotspotController::hit_test(Vec2 point) const
{
    const auto* target = hit_target_at(point);
    return target ? std::optional{target->ref} : std::nullopt;
}

const WorldHotspotHitTarget*
WorldHotspotController::hit_target(const core::compiled::HotspotRef& ref,
                                   const std::optional<std::string>& owner_identity) const
{
    const auto* frame = m_backend.frame();
    if (frame == nullptr)
        return nullptr;
    const auto found =
        std::find_if(frame->hotspot_hit_targets.begin(), frame->hotspot_hit_targets.end(),
                     [&](const auto& target) {
                         return target.ref == ref &&
                                (!owner_identity || target.stable_identity == *owner_identity);
                     });
    return found == frame->hotspot_hit_targets.end() ? nullptr : &*found;
}

bool WorldHotspotController::contains(const core::compiled::HotspotRef& ref,
                                      const std::string& owner_identity, Vec2 point) const
{
    const auto* frame = m_backend.frame();
    const auto* target = hit_target(ref, owner_identity);
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
    const auto* hovered_target =
        hovered && m_last_mouse_valid ? hit_target_at(m_last_mouse_reference) : nullptr;
    m_hovered_owner_identity =
        hovered_target ? std::optional{hovered_target->stable_identity} : std::nullopt;
    auto owner_identity =
        pressed && m_capture ? std::optional{m_capture->owner_identity} : m_hovered_owner_identity;
    (void)m_backend.update_hotspot_visual_state(
        {std::move(hovered), std::move(pressed), std::move(owner_identity)});
}

void WorldHotspotController::synchronize_generation()
{
    if (m_generation == m_backend.generation())
        return;
    m_generation = m_backend.generation();
    // A committed replacement invalidates the gesture even when the same logical target survives.
    m_capture.reset();
    m_hovered.reset();
    set_visual_state(m_last_mouse_valid && m_last_mouse_admitted ? hit_test(m_last_mouse_reference)
                                                                 : std::nullopt,
                     std::nullopt);
}

void WorldHotspotController::presentation_changed() { synchronize_generation(); }

void WorldHotspotController::realization_changed()
{
    synchronize_generation();
    if (!m_capture)
        set_visual_state(m_last_mouse_valid && m_last_mouse_admitted
                             ? hit_test(m_last_mouse_reference)
                             : std::nullopt,
                         std::nullopt);
}

const WorldHotspotHitTarget* WorldHotspotController::hovered_target() const
{
    return m_hovered ? hit_target(*m_hovered, m_hovered_owner_identity) : nullptr;
}

WorldHotspotDebugObservation WorldHotspotController::debug_observation() const
{
    WorldHotspotDebugObservation observation{
        .hovered = m_hovered,
        .pressed =
            m_capture ? std::optional<core::compiled::HotspotRef>{m_capture->ref} : std::nullopt,
        .under_pointer = std::nullopt,
        .last_mouse_reference = m_last_mouse_reference,
        .last_mouse_valid = m_last_mouse_valid,
        .capture_active = m_capture.has_value(),
    };
    if (m_last_mouse_valid)
        observation.under_pointer = hit_test(m_last_mouse_reference);
    return observation;
}

void WorldHotspotController::target_completed()
{
    synchronize_generation();
    set_visual_state(m_last_mouse_valid && m_last_mouse_admitted ? hit_test(m_last_mouse_reference)
                                                                 : std::nullopt,
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
    const auto finish = [this, &result]() -> WorldPointerEventResult {
        result.hovered = m_hovered;
        result.pressed =
            m_capture ? std::optional<core::compiled::HotspotRef>{m_capture->ref} : std::nullopt;
        return result;
    };
    const bool touch = event.kind == WorldPointerEventKind::TouchDown ||
                       event.kind == WorldPointerEventKind::TouchMove ||
                       event.kind == WorldPointerEventKind::TouchUp;

    if (event.kind == WorldPointerEventKind::Cancel) {
        cancel();
        return finish();
    }
    if (!touch) {
        m_last_mouse_reference = event.reference_position;
        m_last_mouse_valid = true;
        m_last_mouse_admitted = event.admitted;
    }
    if (!event.admitted) {
        if (m_capture)
            cancel();
        else if (!touch)
            set_visual_state(std::nullopt, std::nullopt);
        return finish();
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
            return finish();
        }
        if (!touch) {
            result.hit_test_performed = true;
            result.hit = hit_test(event.reference_position);
            set_visual_state(result.hit, std::nullopt);
        }
        return finish();
    }

    if (event.kind == WorldPointerEventKind::MouseDown ||
        event.kind == WorldPointerEventKind::TouchDown) {
        if ((!event.primary && !event.secondary) || m_capture)
            return finish();
        result.hit_test_performed = true;
        auto target = hit_test(event.reference_position);
        result.hit = target;
        if (!target)
            return finish();
        const auto* selected = hit_target_at(event.reference_position);
        m_capture = Capture{*target,
                            selected->stable_identity,
                            event.host_position,
                            event.reference_position,
                            event.pointer_id,
                            touch,
                            event.primary,
                            false};
        set_visual_state(std::nullopt, target);
        result.consumed = true;
        return finish();
    }

    if (!m_capture || m_capture->pointer_id != event.pointer_id || m_capture->touch != touch)
        return finish();
    result.consumed = true;
    const auto captured = m_capture->ref;
    bool select_target = false;
    if (!m_capture->target_canceled) {
        result.hit_test_performed = true;
        select_target = contains(captured, m_capture->owner_identity, event.reference_position);
    }
    if (select_target)
        result.hit = captured;
    const auto* semantic_target =
        select_target ? hit_target(captured, m_capture->owner_identity) : nullptr;
    const auto target = semantic_target ? std::optional{semantic_target->target} : std::nullopt;
    const auto source_rect =
        semantic_target ? std::optional{semantic_target->owner_rect} : std::nullopt;
    const bool primary_activation = m_capture->primary;
    m_capture.reset();
    set_visual_state(std::nullopt, std::nullopt);
    if (target) {
        result.target = std::move(target);
        result.primary_activation = primary_activation;
        const auto viewport = m_backend.viewport();
        if (viewport.width > 0.0f && viewport.height > 0.0f) {
            core::TriggerContext trigger;
            trigger.pointer = core::TriggerPoint{event.reference_position.x / viewport.width,
                                                 event.reference_position.y / viewport.height};
            if (source_rect) {
                trigger.source_bounds = core::TriggerRect{
                    source_rect->x / viewport.width, source_rect->y / viewport.height,
                    source_rect->width / viewport.width, source_rect->height / viewport.height};
            }
            result.trigger_context = trigger;
        }
    } else if (!touch) {
        result.hit_test_performed = true;
        result.hit = hit_test(event.reference_position);
        set_visual_state(result.hit, std::nullopt);
    }
    return finish();
}

void WorldPresentationBackend::rebuild_batches(WorldPresentationFrame& frame,
                                               const core::RuntimeClockUpdate* clock)
{
    frame.base_batch.clear();
    frame.base_world_composition_batch.clear();
    frame.base_world_overlay_batches.clear();
    frame.base_game_ui_underlay_batch.clear();
    for (auto& draw : frame.draws) {
        QuadCommand command = draw.command;
        if (!draw.raster_animation_frames.empty()) {
            const auto policy = draw.motion_policy.value_or(core::MotionPlaybackPolicy{});
            const auto domain = raster_animation_clock(draw);
            std::uint64_t total_duration_ms = 0;
            for (const auto& animation_frame : draw.raster_animation_frames)
                total_duration_ms += animation_frame.duration_ms;
            if (total_duration_ms > 0) {
                const auto now = clock ? clock_time(*clock, domain) : std::chrono::microseconds{0};
                const auto key = raster_animation_loop_key(draw);
                std::chrono::microseconds elapsed{0};
                if (clock) {
                    auto [epoch, inserted] = m_loop_epochs.try_emplace(
                        key, LoopEpoch{domain, now, draw.raster_animation_key});
                    if (!inserted && (epoch->second.clock != domain ||
                                      epoch->second.compatibility != draw.raster_animation_key))
                        epoch->second = LoopEpoch{domain, now, draw.raster_animation_key};
                    if (now >= epoch->second.started_at)
                        elapsed = now - epoch->second.started_at;
                }
                const auto duration = static_cast<long double>(total_duration_ms);
                const auto initial = static_cast<long double>(draw.motion_initial_ms);
                const auto microseconds = static_cast<long double>(elapsed.count());
                const auto rate = static_cast<long double>(policy.rate) / 1000.0L;
                long double phase;
                if (policy.repeat == core::MotionRepeat::Loop) {
                    // Reduce before multiplication: Web long double cannot hold elapsed * DBL_MAX.
                    phase = std::fmod(
                        initial + std::fmod(std::fmod(rate, duration) * microseconds, duration),
                        duration);
                } else {
                    const auto endpoint = duration - 1.0L;
                    const auto remaining = std::max(0.0L, endpoint - initial);
                    phase = microseconds > 0.0L && rate >= remaining / microseconds
                                ? endpoint
                                : std::min(initial + rate * microseconds, endpoint);
                }
                auto phase_ms = phase >= static_cast<long double>(total_duration_ms - 1)
                                    ? total_duration_ms - 1
                                    : static_cast<std::uint64_t>(phase);
                for (const auto& animation_frame : draw.raster_animation_frames) {
                    if (phase_ms < animation_frame.duration_ms) {
                        command.texture = animation_frame.texture;
                        command.texture_sampler = animation_frame.sampler;
                        draw.texture_lease = animation_frame.texture_lease;
                        break;
                    }
                    phase_ms -= animation_frame.duration_ms;
                }
            }
        }
        draw.sampled_visual_texture = command.texture;
        draw.sampled_visual_sampler = command.texture_sampler;
        if (!draw.raster_animation_frames.empty()) {
            for (auto& target : frame.hotspot_hit_targets) {
                if (target.family == draw.family &&
                    target.stable_identity == draw.stable_identity &&
                    target.base_sublayer == draw.sublayer)
                    target.source_texture_lease = draw.texture_lease;
            }
            for (auto& surface : frame.hotspot_surfaces) {
                if (surface.overlay.family == draw.family &&
                    surface.overlay.stable_identity == draw.stable_identity &&
                    surface.overlay.sublayer == draw.sublayer + 1) {
                    surface.overlay.command.texture = command.texture;
                    surface.overlay.command.texture_sampler = command.texture_sampler;
                    surface.overlay.texture_lease = draw.texture_lease;
                    if (draw.texture_lease)
                        surface.overlay.command.hotspot_image_dimensions = {
                            static_cast<float>((*draw.texture_lease)->width),
                            static_cast<float>((*draw.texture_lease)->height)};
                }
            }
        }
        if (clock && !draw.actor_animation_clips.empty()) {
            const WorldPresentationDraw::ActorAnimationClip* active_clip = nullptr;
            std::uint64_t lead_in_ms = 0;
            if (draw.actor_speaking && draw.actor_automatic_animations.speaking) {
                const auto clip_id = draw.actor_automatic_animations.speaking->clip_id;
                const auto found =
                    std::ranges::find_if(draw.actor_animation_clips, [&](const auto& candidate) {
                        return candidate.id == clip_id;
                    });
                if (found != draw.actor_animation_clips.end())
                    active_clip = &*found;
            } else if (draw.actor_automatic_animations.blink) {
                const auto& blink = *draw.actor_automatic_animations.blink;
                const auto found =
                    std::ranges::find_if(draw.actor_animation_clips, [&](const auto& candidate) {
                        return candidate.id == blink.clip_id;
                    });
                if (found != draw.actor_animation_clips.end()) {
                    active_clip = &*found;
                    lead_in_ms = blink.interval_ms;
                }
            }
            if (active_clip && !active_clip->frames.empty()) {
                std::uint64_t clip_duration_ms = 0;
                for (const auto& frame : active_clip->frames)
                    clip_duration_ms += frame.duration_ms;
                if (clip_duration_ms > 0) {
                    const auto now = clock_time(*clock, active_clip->clock);
                    const auto key = loop_key(draw) + ":animation:" + active_clip->id.text() +
                                     (draw.actor_speaking ? ":speaking" : ":blink");
                    auto [epoch, inserted] =
                        m_loop_epochs.try_emplace(key, LoopEpoch{active_clip->clock, now, {}});
                    if (!inserted && epoch->second.clock != active_clip->clock)
                        epoch->second = LoopEpoch{active_clip->clock, now, {}};
                    const auto elapsed = now >= epoch->second.started_at
                                             ? now - epoch->second.started_at
                                             : std::chrono::microseconds{0};
                    const auto elapsed_ms = static_cast<std::uint64_t>(
                        std::chrono::duration_cast<std::chrono::milliseconds>(elapsed).count());
                    const std::uint64_t cycle_ms = lead_in_ms + clip_duration_ms;
                    const std::uint64_t phase_ms = cycle_ms > 0 ? elapsed_ms % cycle_ms : 0;
                    if (phase_ms >= lead_in_ms) {
                        std::uint64_t frame_phase = phase_ms - lead_in_ms;
                        for (const auto& frame : active_clip->frames) {
                            if (frame_phase < frame.duration_ms) {
                                if (auto sampled = frame.sample(frame_phase, command))
                                    command = std::move(*sampled);
                                else
                                    command.color.a = 0.0f;
                                break;
                            }
                            frame_phase -= frame.duration_ms;
                        }
                    }
                }
            }
        }
        double elapsed_seconds = 0.0;
        const auto domain =
            draw.actor_idle ? std::optional{draw.actor_idle->clock} : draw.environment_clock;
        if (clock && domain) {
            const auto now = clock_time(*clock, *domain);
            const auto key = loop_key(draw);
            auto [epoch, inserted] = m_loop_epochs.try_emplace(key, LoopEpoch{*domain, now, {}});
            if (!inserted && epoch->second.clock != *domain)
                epoch->second = LoopEpoch{*domain, now, {}};
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

        if (draw.material_owner && draw.material_occurrence && command.material.valid()) {
            for (const auto& parameter : frame.material_parameters) {
                if (parameter.owner != *draw.material_owner ||
                    parameter.occurrence != *draw.material_occurrence ||
                    parameter.material.text() != command.material.string())
                    continue;
                std::optional<ShaderUniformValue> resolved;
                if (parameter.value) {
                    resolved = render_material_parameter_value(*parameter.value);
                } else if (parameter.standard_facet) {
                    float facet_value = 0.0f;
                    switch (*parameter.standard_facet) {
                    case core::MaterialStandardFacet::OccurrenceTime: {
                        if (clock) {
                            const auto domain =
                                parameter.clock == core::MaterialClockPolicy::Gameplay
                                    ? core::LayoutClockDomain::Gameplay
                                    : core::LayoutClockDomain::UnscaledPresentation;
                            const auto now = clock_time(*clock, domain);
                            const auto key = std::string{"material/"} +
                                             presentation_owner_identity(*draw.material_owner) +
                                             "/" + draw.stable_identity + "/" +
                                             std::to_string(draw.sublayer) + "/" +
                                             command.material.string() + "/" + parameter.parameter;
                            auto [epoch, inserted] =
                                m_loop_epochs.try_emplace(key, LoopEpoch{domain, now, {}});
                            if (!inserted && epoch->second.clock != domain)
                                epoch->second = LoopEpoch{domain, now, {}};
                            const auto elapsed = now >= epoch->second.started_at
                                                     ? now - epoch->second.started_at
                                                     : std::chrono::microseconds{0};
                            facet_value =
                                static_cast<float>(std::chrono::duration<double>(elapsed).count());
                        }
                        break;
                    }
                    case core::MaterialStandardFacet::PaintWidth:
                        facet_value = command.rect.width;
                        break;
                    case core::MaterialStandardFacet::PaintHeight:
                        facet_value = command.rect.height;
                        break;
                    case core::MaterialStandardFacet::ViewportWidth:
                        facet_value = m_viewport.width;
                        break;
                    case core::MaterialStandardFacet::ViewportHeight:
                        facet_value = m_viewport.height;
                        break;
                    case core::MaterialStandardFacet::CameraZoom:
                        facet_value =
                            frame.camera ? static_cast<float>(frame.camera->view.zoom) : 1.0f;
                        break;
                    }
                    resolved = ShaderUniformValue{facet_value};
                }
                if (resolved)
                    command.material_uniform_overrides.push_back(
                        MaterialUniformOverride{parameter.parameter, std::move(*resolved)});
            }
        }

        frame.base_batch.draw(command);
        if (draw.plane == core::PresentationPlane::GameUi)
            frame.base_game_ui_underlay_batch.draw(std::move(command));
        else if (draw.plane == core::PresentationPlane::WorldOverlay)
            append_world_overlay_command(frame.base_world_overlay_batches, draw.order,
                                         std::move(command));
        else
            frame.base_world_composition_batch.draw(std::move(command));
    }

    for (auto& surface : frame.hotspot_surfaces) {
        auto& command = surface.overlay.command;
        command.material_uniform_overrides.clear();
        for (const auto& parameter : surface.overlay.authored_hotspot_parameters) {
            std::optional<ShaderUniformValue> resolved;
            if (parameter.value) {
                resolved = render_material_parameter_value(*parameter.value);
            } else if (parameter.standard_facet) {
                float facet_value = 0.0f;
                switch (*parameter.standard_facet) {
                case core::MaterialStandardFacet::OccurrenceTime: {
                    if (clock) {
                        const auto domain = parameter.clock == core::MaterialClockPolicy::Gameplay
                                                ? core::LayoutClockDomain::Gameplay
                                                : core::LayoutClockDomain::UnscaledPresentation;
                        const auto now = clock_time(*clock, domain);
                        const auto key = std::string{"hotspot-material/"} +
                                         surface.overlay.stable_identity + "/" +
                                         std::to_string(surface.overlay.sublayer) + "/" +
                                         command.material.string() + "/" + parameter.name;
                        auto [epoch, inserted] =
                            m_loop_epochs.try_emplace(key, LoopEpoch{domain, now, {}});
                        if (!inserted && epoch->second.clock != domain)
                            epoch->second = LoopEpoch{domain, now, {}};
                        const auto elapsed = now >= epoch->second.started_at
                                                 ? now - epoch->second.started_at
                                                 : std::chrono::microseconds{0};
                        facet_value =
                            static_cast<float>(std::chrono::duration<double>(elapsed).count());
                    }
                    break;
                }
                case core::MaterialStandardFacet::PaintWidth:
                    facet_value = command.rect.width;
                    break;
                case core::MaterialStandardFacet::PaintHeight:
                    facet_value = command.rect.height;
                    break;
                case core::MaterialStandardFacet::ViewportWidth:
                    facet_value = m_viewport.width;
                    break;
                case core::MaterialStandardFacet::ViewportHeight:
                    facet_value = m_viewport.height;
                    break;
                case core::MaterialStandardFacet::CameraZoom:
                    facet_value = frame.camera ? static_cast<float>(frame.camera->view.zoom) : 1.0f;
                    break;
                }
                resolved = ShaderUniformValue{facet_value};
            }
            if (resolved)
                command.material_uniform_overrides.push_back(
                    MaterialUniformOverride{parameter.name, std::move(*resolved)});
        }
    }
    rebuild_hotspot_overlays(frame);
}

void WorldPresentationBackend::rebuild_hotspot_overlays(WorldPresentationFrame& frame)
{
    frame.batch = frame.base_batch;
    frame.world_composition_batch = frame.base_world_composition_batch;
    frame.world_overlay_batches = frame.base_world_overlay_batches;
    frame.game_ui_underlay_batch = frame.base_game_ui_underlay_batch;
    const auto active = m_hotspot_visual_state.pressed ? m_hotspot_visual_state.pressed
                                                       : m_hotspot_visual_state.hovered;
    if (!active)
        return;
    const auto found = std::find_if(
        frame.hotspot_surfaces.begin(), frame.hotspot_surfaces.end(), [&](const auto& surface) {
            return surface.ref == *active &&
                   (!m_hotspot_visual_state.owner_identity ||
                    surface.overlay.stable_identity == *m_hotspot_visual_state.owner_identity);
        });
    if (found == frame.hotspot_surfaces.end())
        return;
    QuadCommand command = found->overlay.command;
    command.hotspot_hovered = m_hotspot_visual_state.hovered == active;
    command.hotspot_pressed = m_hotspot_visual_state.pressed == active;
    frame.batch.draw(command);
    if (found->overlay.plane == core::PresentationPlane::GameUi)
        frame.game_ui_underlay_batch.draw(std::move(command));
    else if (found->overlay.plane == core::PresentationPlane::WorldOverlay)
        append_world_overlay_command(frame.world_overlay_batches, found->overlay.order,
                                     std::move(command));
    else
        frame.world_composition_batch.draw(std::move(command));
}

bool WorldPresentationBackend::update_hotspot_visual_state(HotspotInteractionVisualState state)
{
    if (state.hovered == m_hotspot_visual_state.hovered &&
        state.pressed == m_hotspot_visual_state.pressed &&
        state.owner_identity == m_hotspot_visual_state.owner_identity)
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
            if (!draw.raster_animation_frames.empty())
                active.insert(raster_animation_loop_key(draw));
            if (draw.actor_speaking && draw.actor_automatic_animations.speaking)
                active.insert(loop_key(draw) + ":animation:" +
                              draw.actor_automatic_animations.speaking->clip_id.text() +
                              ":speaking");
            else if (draw.actor_automatic_animations.blink)
                active.insert(loop_key(draw) + ":animation:" +
                              draw.actor_automatic_animations.blink->clip_id.text() + ":blink");
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
    m_animation_epoch_generation = 0;
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

void WorldPresentationBackend::preserve_animation_epochs_from(
    const WorldPresentationBackend& previous)
{
    if (!m_snapshot || !previous.m_frame)
        return;
    m_animation_epoch_generation =
        std::max(m_animation_epoch_generation, previous.m_animation_epoch_generation);
    const auto found = m_frames.find(m_snapshot->revision.number());
    if (found == m_frames.end())
        return;
    auto& frame = found->second;
    for (auto& draw : frame.draws) {
        if (draw.raster_animation_frames.empty())
            continue;
        const auto previous_draw =
            std::ranges::find_if(previous.m_frame->draws, [&](const auto& value) {
                return compatible_raster_animation(value, draw);
            });
        if (previous_draw == previous.m_frame->draws.end()) {
            draw.raster_animation_epoch = ++m_animation_epoch_generation;
            continue;
        }
        draw.raster_animation_epoch = previous_draw->raster_animation_epoch;
        const auto key = raster_animation_loop_key(draw);
        const auto epoch = previous.m_loop_epochs.find(key);
        if (epoch != previous.m_loop_epochs.end())
            m_loop_epochs.insert_or_assign(key, epoch->second);
    }
    m_frame = frame;
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
    swap(m_animation_epoch_generation, prepared.m_animation_epoch_generation);
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
        if (m_snapshot && m_snapshot->revision.number() == revision)
            return true;
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
