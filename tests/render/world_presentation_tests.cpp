#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include "noveltea/world_presentation.hpp"

#include <algorithm>
#include <bit>
#include <optional>
#include <string>
#include <string_view>
#include <unordered_map>
#include <utility>
#include <vector>

using namespace noveltea;
using namespace noveltea::core;
namespace compiled = noveltea::core::compiled;

namespace {

template<class Id> Id id(const char* value) { return std::move(Id::create(value)).value(); }

compiled::ResolvedHotspotTarget semantic_target(const char* value)
{
    return compiled::CharacterInteractionSubject{id<CharacterId>(value)};
}

FlowFrameId flow_frame_id(std::uint64_t value)
{
    static_assert(sizeof(FlowFrameId) == sizeof(value));
    return std::bit_cast<FlowFrameId>(value);
}

using ScopedActorInstanceId = decltype(std::declval<ScopedActorKey>().instance);

class TextureLeaseControl final : public assets::AssetLeaseControl<assets::TextureAsset> {
public:
    explicit TextureLeaseControl(assets::TextureAsset asset)
        : m_asset(std::move(asset)), m_key{m_asset.path, {1}}
    {
    }

    void assert_owner_thread() const noexcept override {}
    void retain_pin_on_owner() noexcept override { ++m_pins; }
    void release_pin_on_owner() noexcept override { --m_pins; }
    void mark_used_on_owner() noexcept override {}
    const assets::TextureAsset& asset_on_owner() const noexcept override { return m_asset; }
    const assets::AssetCacheKey& cache_key_on_owner() const noexcept override { return m_key; }

private:
    assets::TextureAsset m_asset;
    assets::AssetCacheKey m_key;
    std::size_t m_pins = 0;
};

class FakeWorldResources final : public WorldPresentationResourceResolver {
public:
    void add_texture(const char* asset, std::uint16_t handle, std::uint16_t width,
                     std::uint16_t height,
                     MaterialTextureSampler sampler = MaterialTextureSampler::ClampLinear)
    {
        m_textures.emplace(asset, assets::TextureAsset{.handle = handle,
                                                       .path = "project:/" + std::string(asset),
                                                       .width = width,
                                                       .height = height,
                                                       .sampler = sampler});
    }

    void set_alpha_coverage(const char* asset, assets::TextureAlphaCoverage coverage)
    {
        m_textures.at(asset).alpha_coverage = std::move(coverage);
    }

    void fail_asset(const char* asset) { m_failed_asset = asset; }

    Result<WorldPreparedVisual, Diagnostics> resolve(std::optional<AssetId> asset,
                                                     std::optional<core::MaterialId> material,
                                                     std::string_view context) override
    {
        ++resolve_calls;
        WorldPreparedVisual result;
        if (asset) {
            if (asset->text() == m_failed_asset) {
                return Result<WorldPreparedVisual, Diagnostics>::failure(
                    {{.code = "test.world_resource_failure",
                      .message = "failed " + asset->text(),
                      .source_path = std::string(context)}});
            }
            const auto found = m_textures.find(asset->text());
            if (found == m_textures.end()) {
                return Result<WorldPreparedVisual, Diagnostics>::failure(
                    {{.code = "test.world_resource_missing",
                      .message = "missing " + asset->text(),
                      .source_path = std::string(context)}});
            }
            result.texture = found->second;
            auto control = std::make_shared<TextureLeaseControl>(found->second);
            control->retain_pin_on_owner();
            result.texture_lease =
                assets::AssetLease<assets::TextureAsset>::adopt_existing_pin_on_owner(
                    std::move(control));
        }
        if (material) {
            if (material->text() == "failed-environment") {
                return Result<WorldPreparedVisual, Diagnostics>::failure(
                    {{.code = "test.world_environment_failure",
                      .message = "failed environment",
                      .source_path = std::string(context)}});
            }
            result.material = noveltea::MaterialId(material->text());
            if (material->text() == "rain")
                result.tint = {0.75f, 0.85f, 1.0f, 0.25f};
        }
        return Result<WorldPreparedVisual, Diagnostics>::success(std::move(result));
    }

    Result<WorldPreparedHotspotResources, Diagnostics>
    resolve_hotspot(const PresentationHotspot& hotspot, std::span<const PresentationHotspot>,
                    std::string_view context) override
    {
        ++hotspot_resolve_calls;
        if (fail_hotspot_resources) {
            return Result<WorldPreparedHotspotResources, Diagnostics>::failure(
                {{.code = "test.hotspot_resource_failure",
                  .message = "failed hotspot resources",
                  .source_path = std::string(context)}});
        }
        WorldPreparedHotspotResources result;
        if (const auto* authored =
                std::get_if<compiled::MaterialHotspotHighlight>(&hotspot.highlight))
            result.material = noveltea::MaterialId(authored->material.text());
        else
            result.material =
                noveltea::MaterialId(std::holds_alternative<AlphaHotspotShape>(hotspot.shape)
                                         ? std::string(builtin_hotspot_alpha_material_id)
                                         : std::string(builtin_hotspot_custom_material_id));
        if (std::holds_alternative<compiled::NormalizedRect>(hotspot.shape))
            result.mask =
                assets::HotspotMaskAsset{.owner = compiled::RoomHotspotOwnerRef{id<RoomId>("room")},
                                         .handle = 91,
                                         .width = hotspot.source_width,
                                         .height = hotspot.source_height};
        return Result<WorldPreparedHotspotResources, Diagnostics>::success(std::move(result));
    }

    std::size_t resolve_calls = 0;
    std::size_t hotspot_resolve_calls = 0;
    bool fail_hotspot_resources = false;

private:
    std::unordered_map<std::string, assets::TextureAsset> m_textures;
    std::string m_failed_asset;
};

PresentationActor actor(ActorPresentationKey key, std::int32_t order = 0)
{
    return PresentationActor{std::move(key),
                             id<CharacterId>("hero"),
                             id<CharacterPoseId>("standing"),
                             id<CharacterExpressionId>("neutral"),
                             std::nullopt,
                             id<AssetId>("pose"),
                             id<core::MaterialId>("pose-material"),
                             {0.5, 1.0},
                             {0.0, 0.0},
                             1.0,
                             id<AssetId>("expression"),
                             id<core::MaterialId>("expression-material"),
                             {},
                             std::nullopt,
                             std::nullopt,
                             PresentationPlane::WorldContent,
                             order,
                             true,
                             true,
                             true};
}

RuntimePresentationSnapshot base_snapshot(std::uint64_t revision = 1)
{
    RuntimePresentationSnapshot snapshot;
    snapshot.revision = PresentationSnapshotRevision::from_number(revision);
    snapshot.mode = PresentationRuntimeMode::Room;
    return snapshot;
}

const WorldPresentationDraw* find_draw(const WorldPresentationFrame& frame,
                                       std::string_view identity, std::uint8_t sublayer = 0)
{
    const auto found = std::find_if(frame.draws.begin(), frame.draws.end(), [&](const auto& draw) {
        return draw.stable_identity == identity && draw.sublayer == sublayer;
    });
    return found == frame.draws.end() ? nullptr : &*found;
}

} // namespace

TEST_CASE("world background fit policy implements cover contain stretch and center")
{
    const Size viewport{1600.0f, 900.0f};
    const Size square{1000.0f, 1000.0f};

    const auto cover = WorldPresentationLayoutPolicy::fit_background(
        viewport, square, compiled::BackgroundFit::Cover);
    CHECK(cover.rect.x == 0.0f);
    CHECK(cover.rect.width == 1600.0f);
    CHECK(cover.uv.y == Catch::Approx(0.21875f));
    CHECK(cover.uv.height == Catch::Approx(0.5625f));

    const auto contain = WorldPresentationLayoutPolicy::fit_background(
        viewport, square, compiled::BackgroundFit::Contain);
    CHECK(contain.rect.x == Catch::Approx(350.0f));
    CHECK(contain.rect.y == 0.0f);
    CHECK(contain.rect.width == Catch::Approx(900.0f));
    CHECK(contain.rect.height == Catch::Approx(900.0f));

    const auto stretch = WorldPresentationLayoutPolicy::fit_background(
        viewport, square, compiled::BackgroundFit::Stretch);
    CHECK(stretch.rect.width == 1600.0f);
    CHECK(stretch.rect.height == 900.0f);
    CHECK(stretch.uv.width == 1.0f);

    const auto center = WorldPresentationLayoutPolicy::fit_background(
        viewport, square, compiled::BackgroundFit::Center);
    CHECK(center.rect.x == Catch::Approx(300.0f));
    CHECK(center.rect.y == Catch::Approx(-50.0f));
    CHECK(center.rect.width == 1000.0f);
    CHECK(center.rect.height == 1000.0f);
}

TEST_CASE("world actor layout centralizes logical slots room anchors and pose layering")
{
    FakeWorldResources resources;
    resources.add_texture("pose", 1, 100, 200);
    resources.add_texture("expression", 2, 100, 200);
    WorldPresentationBackend backend(resources);

    auto snapshot = base_snapshot();
    auto left = actor(CharacterActorKey{id<CharacterId>("hero")});
    left.placement.position = compiled::ActorPosition::Left;
    snapshot.actors.push_back(left);

    auto room = actor(RoomCastActorKey{id<RoomId>("atrium"), id<RoomCastEntryId>("guard")}, 1);
    room.room_bounds = compiled::NormalizedRect{0.1, 0.2, 0.2, 0.4};
    snapshot.actors.push_back(room);

    auto reconciled = backend.reconcile(snapshot, {1000.0f, 500.0f});
    REQUIRE(reconciled);
    REQUIRE(reconciled.value());
    REQUIRE(backend.frame());

    const auto* left_pose = find_draw(*backend.frame(), "character/hero", 0);
    const auto* left_expression = find_draw(*backend.frame(), "character/hero", 1);
    REQUIRE(left_pose);
    REQUIRE(left_expression);
    CHECK(left_pose->command.rect.x == Catch::Approx(200.0f));
    CHECK(left_pose->command.rect.y == Catch::Approx(300.0f));
    CHECK(left_pose->command.rect.width == Catch::Approx(100.0f));
    CHECK(left_pose->command.material.value() == "pose-material");
    CHECK(left_expression->command.rect.x == left_pose->command.rect.x);
    CHECK(left_expression->command.rect.y == left_pose->command.rect.y);
    CHECK(left_expression->command.material.value() == "expression-material");

    const auto* room_pose = find_draw(*backend.frame(), "room-cast/atrium/guard", 0);
    REQUIRE(room_pose);
    CHECK(room_pose->command.rect.x == Catch::Approx(150.0f));
    CHECK(room_pose->command.rect.y == Catch::Approx(100.0f));
}

TEST_CASE("world backend realizes canonical family order and every actor key family")
{
    FakeWorldResources resources;
    resources.add_texture("pose", 1, 100, 200);
    resources.add_texture("expression", 2, 100, 200);
    resources.add_texture("prop", 3, 40, 40);
    resources.add_texture("item", 4, 32, 32);
    WorldPresentationBackend backend(resources);

    auto snapshot = base_snapshot();
    snapshot.environments.push_back(
        {id<PresentationEnvironmentInstanceId>("weather"),
         SessionPresentationOwner{PresentationSessionId::from_number(1)},
         id<PresentationEnvironmentStopKey>("weather"),
         std::nullopt,
         id<core::MaterialId>("rain"),
         {0.0, 0.0, 1.0, 1.0},
         PresentationPlane::WorldContent,
         50,
         LayoutClockDomain::Gameplay,
         {0.1, 0.0},
         0.5,
         true});
    snapshot.props.push_back(
        {ScopedPropPresentationKey{id<PresentationPropInstanceId>("foreground-prop")},
         SessionPresentationOwner{PresentationSessionId::from_number(1)},
         id<AssetId>("prop"),
         std::nullopt,
         std::nullopt,
         {0.2, 0.3, 0.1, 0.2},
         PresentationPlane::WorldContent,
         40,
         true});
    snapshot.interactables.push_back({id<InteractableId>("key"),
                                      {id<RoomId>("atrium"), id<RoomPlacementId>("table")},
                                      {0.4, 0.5, 0.1, 0.15},
                                      id<AssetId>("item"),
                                      id<core::MaterialId>("item-material"),
                                      PresentationPlane::WorldContent,
                                      30,
                                      true,
                                      true});

    const ScenePresentationOwner scene_owner{flow_frame_id(7), id<SceneId>("opening")};
    snapshot.actors.push_back(actor(ScopedActorKey{id<ScopedActorInstanceId>("temporary")}));
    snapshot.actors.push_back(actor(SceneActorKey{scene_owner, id<ActorSlotId>("lead")}));
    snapshot.actors.push_back(
        actor(RoomCastActorKey{id<RoomId>("atrium"), id<RoomCastEntryId>("guard")}));
    snapshot.actors.push_back(actor(CharacterActorKey{id<CharacterId>("hero")}));

    REQUIRE(backend.reconcile(snapshot, {1000.0f, 500.0f}));
    REQUIRE(backend.frame());
    const auto& draws = backend.frame()->draws;
    REQUIRE(draws.size() == 11);
    CHECK(draws[0].family == WorldDrawFamily::Environment);
    CHECK(draws[1].family == WorldDrawFamily::Prop);
    CHECK(draws[2].family == WorldDrawFamily::Interactable);
    CHECK(draws[2].command.rect.x == Catch::Approx(400.0f));
    CHECK(draws[2].command.rect.y == Catch::Approx(250.0f));
    CHECK(draws[2].command.rect.width == Catch::Approx(100.0f));
    CHECK(draws[2].command.material.value() == "item-material");

    std::vector<std::string> actor_identities;
    for (const auto& draw : draws) {
        if (draw.family == WorldDrawFamily::Actor && draw.sublayer == 0)
            actor_identities.push_back(draw.stable_identity);
    }
    CHECK(actor_identities == std::vector<std::string>{"character/hero", "room-cast/atrium/guard",
                                                       "scene/7/opening/lead", "scoped/temporary"});
}

TEST_CASE("world reconciliation is failure atomic and identical snapshots do no work")
{
    FakeWorldResources resources;
    resources.add_texture("prop", 3, 40, 40);
    resources.add_texture("missing", 4, 40, 40);
    WorldPresentationBackend backend(resources);

    auto snapshot = base_snapshot(1);
    snapshot.props.push_back({ScopedPropPresentationKey{id<PresentationPropInstanceId>("prop")},
                              SessionPresentationOwner{PresentationSessionId::from_number(1)},
                              id<AssetId>("prop"),
                              std::nullopt,
                              std::nullopt,
                              {0.0, 0.0, 0.2, 0.2},
                              PresentationPlane::WorldContent,
                              0,
                              true});
    auto first = backend.reconcile(snapshot, {1000.0f, 500.0f});
    REQUIRE(first);
    REQUIRE(first.value());
    REQUIRE(backend.frame());
    const auto first_generation = backend.generation();
    const auto first_calls = resources.resolve_calls;
    const auto first_identity = backend.frame()->draws.front().stable_identity;

    auto identical = backend.reconcile(snapshot, {1000.0f, 500.0f});
    REQUIRE(identical);
    CHECK_FALSE(identical.value());
    CHECK(backend.generation() == first_generation);
    CHECK(resources.resolve_calls == first_calls);

    auto failed = snapshot;
    failed.revision = PresentationSnapshotRevision::from_number(2);
    failed.props.front().asset = id<AssetId>("missing");
    resources.fail_asset("missing");
    auto result = backend.reconcile(failed, {1000.0f, 500.0f});
    REQUIRE_FALSE(result);
    CHECK(backend.generation() == first_generation);
    REQUIRE(backend.frame());
    CHECK(backend.frame()->revision.number() == 1);
    CHECK(backend.frame()->draws.front().stable_identity == first_identity);

    auto resized = backend.resize({500.0f, 250.0f});
    REQUIRE(resized);
    REQUIRE(resized.value());
    CHECK(backend.generation() == first_generation + 1);
    CHECK(backend.frame()->draws.front().command.rect.width == Catch::Approx(100.0f));
}

TEST_CASE("world backend keeps Map imagery in the GameUi underlay")
{
    FakeWorldResources resources;
    resources.add_texture("map", 8, 400, 200, MaterialTextureSampler::ClampNearest);
    WorldPresentationBackend backend(resources);

    auto snapshot = base_snapshot();
    snapshot.map =
        PresentationMap{id<MapId>("city"),  compiled::InitialMapMode::FullMap, true, std::nullopt,
                        id<AssetId>("map"), id<LayoutId>("map-layout")};
    REQUIRE(backend.reconcile(snapshot, {1000.0f, 500.0f}));
    REQUIRE(backend.frame());
    REQUIRE(backend.frame()->draws.size() == 1);
    const auto& draw = backend.frame()->draws.front();
    CHECK(draw.family == WorldDrawFamily::MapUnderlay);
    CHECK(draw.plane == PresentationPlane::GameUi);
    CHECK(draw.command.layer == GameLayer::UIOverlay);
    CHECK(draw.command.rect.x == 0.0f);
    CHECK(draw.command.rect.y == 0.0f);
    CHECK(draw.command.rect.width == 1000.0f);
    CHECK(draw.command.rect.height == 500.0f);
    CHECK(backend.frame()->world_composition_batch.commands().empty());
    REQUIRE(backend.frame()->game_ui_underlay_batch.commands().size() == 1);
    CHECK(backend.frame()->game_ui_underlay_batch.commands().front().layer == GameLayer::UIOverlay);
    CHECK(backend.frame()->game_ui_underlay_batch.commands().front().texture_sampler ==
          MaterialTextureSampler::ClampNearest);
}

TEST_CASE("world backend can roll back a rejected target revision")
{
    FakeWorldResources resources;
    WorldPresentationBackend backend(resources);

    auto source = base_snapshot(1);
    source.background = PresentationBackground{.asset = std::nullopt,
                                               .color = std::string{"#102030"},
                                               .fit = compiled::BackgroundFit::Cover,
                                               .material = std::nullopt};
    auto target = base_snapshot(2);
    target.background = PresentationBackground{.asset = std::nullopt,
                                               .color = std::string{"#405060"},
                                               .fit = compiled::BackgroundFit::Cover,
                                               .material = std::nullopt};

    REQUIRE(backend.reconcile(source, {1000.0f, 500.0f}));
    REQUIRE(backend.reconcile(target, {1000.0f, 500.0f}));
    REQUIRE(backend.frame());
    CHECK(backend.frame()->revision.number() == 2);

    backend.discard_revision(PresentationSnapshotRevision::from_number(2));
    CHECK_FALSE(backend.frame());
    REQUIRE(backend.restore_revision(PresentationSnapshotRevision::from_number(1)));
    REQUIRE(backend.frame());
    CHECK(backend.frame()->revision.number() == 1);
    CHECK(backend.frame(PresentationSnapshotRevision::from_number(2)) == nullptr);
}

TEST_CASE("reconstructible environment loops restart from phase zero after backend reset")
{
    FakeWorldResources resources;
    WorldPresentationBackend backend(resources);
    auto snapshot = base_snapshot(1);
    snapshot.environments.push_back(
        {id<PresentationEnvironmentInstanceId>("rain-loop"),
         SessionPresentationOwner{PresentationSessionId::from_number(1)},
         id<PresentationEnvironmentStopKey>("weather"),
         std::nullopt,
         id<core::MaterialId>("rain"),
         {0.0, 0.0, 1.0, 1.0},
         PresentationPlane::WorldOverlay,
         0,
         LayoutClockDomain::Gameplay,
         {0.25, 0.0},
         1.0,
         true});

    REQUIRE(backend.reconcile(snapshot, {1000.0f, 500.0f}));
    RuntimeClockUpdate clock;
    clock.gameplay_time = std::chrono::seconds{5};
    clock.unscaled_presentation_time = std::chrono::seconds{5};
    backend.realize(clock);
    REQUIRE(backend.frame());
    REQUIRE(backend.frame()->batch.commands().size() == 1);
    CHECK(backend.frame()->batch.commands().front().uv.x == Catch::Approx(0.0f));
    REQUIRE(backend.frame()->batch.commands().front().time_seconds);
    CHECK(*backend.frame()->batch.commands().front().time_seconds == Catch::Approx(0.0f));

    clock.gameplay_time = std::chrono::seconds{6};
    clock.unscaled_presentation_time = std::chrono::seconds{6};
    backend.realize(clock);
    REQUIRE(backend.frame());
    CHECK(backend.frame()->batch.commands().front().uv.x == Catch::Approx(0.25f));
    CHECK(*backend.frame()->batch.commands().front().time_seconds == Catch::Approx(1.0f));

    backend.reset();
    REQUIRE(backend.reconcile(snapshot, {1000.0f, 500.0f}));
    clock.gameplay_time = std::chrono::seconds{11};
    clock.unscaled_presentation_time = std::chrono::seconds{11};
    backend.realize(clock);
    REQUIRE(backend.frame());
    CHECK(backend.frame()->batch.commands().front().uv.x == Catch::Approx(0.0f));
    CHECK(*backend.frame()->batch.commands().front().time_seconds == Catch::Approx(0.0f));
}

TEST_CASE("world transition composition excludes the GameUi underlay")
{
    FakeWorldResources resources;
    resources.add_texture("map", 8, 400, 200);
    WorldPresentationBackend backend(resources);

    auto snapshot = base_snapshot();
    snapshot.background = PresentationBackground{.asset = std::nullopt,
                                                 .color = std::string{"#204060"},
                                                 .fit = compiled::BackgroundFit::Cover,
                                                 .material = std::nullopt};
    snapshot.map =
        PresentationMap{id<MapId>("city"),  compiled::InitialMapMode::FullMap, true, std::nullopt,
                        id<AssetId>("map"), id<LayoutId>("map-layout")};
    REQUIRE(backend.reconcile(snapshot, {1000.0f, 500.0f}));
    REQUIRE(backend.frame());
    REQUIRE(backend.frame()->batch.commands().size() == 2);
    REQUIRE(backend.frame()->world_composition_batch.commands().size() == 1);
    REQUIRE(backend.frame()->game_ui_underlay_batch.commands().size() == 1);
    CHECK(backend.frame()->world_composition_batch.commands().front().layer ==
          GameLayer::Background);
    CHECK(backend.frame()->game_ui_underlay_batch.commands().front().layer == GameLayer::UIOverlay);
}

TEST_CASE("hotspot overlays reuse the prepared owner geometry and update transiently")
{
    FakeWorldResources resources;
    resources.add_texture("room-image", 17, 1600, 900);
    WorldPresentationBackend backend(resources);

    auto snapshot = base_snapshot();
    snapshot.background = PresentationBackground{.asset = id<AssetId>("room-image"),
                                                 .color = std::nullopt,
                                                 .fit = compiled::BackgroundFit::Cover,
                                                 .material = std::nullopt};
    const compiled::HotspotRef hotspot_ref =
        compiled::RoomHotspotRef{id<RoomId>("room"), id<HotspotId>("desk")};
    snapshot.hotspots.push_back({hotspot_ref, "Desk", true, true, semantic_target("desk"),
                                 compiled::NormalizedRect{0.2, 0.3, 0.4, 0.2}, 5,
                                 compiled::DefaultHotspotHighlight{}, id<AssetId>("room-image"),
                                 1600, 900, std::nullopt, std::nullopt,
                                 PresentationPlane::WorldBackground, 0});

    REQUIRE(backend.reconcile(snapshot, {1000.0f, 500.0f}));
    REQUIRE(backend.frame());
    REQUIRE(backend.frame()->hotspot_surfaces.size() == 1);
    const auto& owner = backend.frame()->draws.back().command;
    const auto& overlay = backend.frame()->hotspot_surfaces.front().overlay.command;
    CHECK(overlay.rect.x == Catch::Approx(owner.rect.x));
    CHECK(overlay.rect.y == Catch::Approx(owner.rect.y));
    CHECK(overlay.rect.width == Catch::Approx(owner.rect.width));
    CHECK(overlay.rect.height == Catch::Approx(owner.rect.height));
    CHECK(overlay.uv.x == Catch::Approx(owner.uv.x));
    CHECK(overlay.uv.y == Catch::Approx(owner.uv.y));
    CHECK(overlay.uv.width == Catch::Approx(owner.uv.width));
    CHECK(overlay.uv.height == Catch::Approx(owner.uv.height));
    CHECK(overlay.hotspot_bounds.x == Catch::Approx(0.2f));
    CHECK(overlay.hotspot_bounds.y == Catch::Approx(0.3f));
    CHECK(overlay.hotspot_bounds.width == Catch::Approx(0.4f));
    CHECK(overlay.hotspot_bounds.height == Catch::Approx(0.2f));
    CHECK(resources.hotspot_resolve_calls == 1);
    const auto base_command_count = backend.frame()->base_world_composition_batch.commands().size();
    const auto base_texture =
        backend.frame()->base_world_composition_batch.commands().front().texture.handle;

    REQUIRE(backend.update_hotspot_visual_state({hotspot_ref, std::nullopt}));
    REQUIRE(backend.frame());
    REQUIRE(backend.frame()->world_composition_batch.commands().size() == base_command_count + 1);
    const auto& hovered = backend.frame()->world_composition_batch.commands().back();
    CHECK(hovered.hotspot_hovered);
    CHECK_FALSE(hovered.hotspot_pressed);
    CHECK(resources.hotspot_resolve_calls == 1);
    CHECK(backend.frame()->base_world_composition_batch.commands().size() == base_command_count);
    CHECK(backend.frame()->base_world_composition_batch.commands().front().texture.handle ==
          base_texture);

    REQUIRE(backend.update_hotspot_visual_state({hotspot_ref, hotspot_ref}));
    const auto& pressed = backend.frame()->world_composition_batch.commands().back();
    CHECK(pressed.hotspot_hovered);
    CHECK(pressed.hotspot_pressed);
    CHECK(resources.hotspot_resolve_calls == 1);
}

TEST_CASE("no-highlight hotspots stay semantic and allocate no overlay resources")
{
    FakeWorldResources resources;
    resources.add_texture("room-image", 17, 1600, 900);
    WorldPresentationBackend backend(resources);
    auto snapshot = base_snapshot();
    snapshot.background = PresentationBackground{.asset = id<AssetId>("room-image"),
                                                 .color = std::nullopt,
                                                 .fit = compiled::BackgroundFit::Stretch,
                                                 .material = std::nullopt};
    snapshot.hotspots.push_back(
        {compiled::RoomHotspotRef{id<RoomId>("room"), id<HotspotId>("hidden")}, "Hidden", true,
         true, semantic_target("hidden"), AlphaHotspotShape{}, 0, compiled::NoHotspotHighlight{},
         id<AssetId>("room-image"), 1600, 900, std::nullopt, std::nullopt,
         PresentationPlane::WorldBackground, 0});

    REQUIRE(backend.reconcile(snapshot, {1000.0f, 500.0f}));
    REQUIRE(backend.frame());
    CHECK(backend.frame()->hotspot_surfaces.empty());
    CHECK(resources.hotspot_resolve_calls == 0);
}

TEST_CASE("Interactable hotspot overlays inherit placement geometry and authored Material")
{
    FakeWorldResources resources;
    resources.add_texture("item", 23, 400, 200);
    WorldPresentationBackend backend(resources);
    auto snapshot = base_snapshot();
    snapshot.interactables.push_back({id<InteractableId>("key"),
                                      {id<RoomId>("room"), id<RoomPlacementId>("table")},
                                      {0.25, 0.4, 0.3, 0.2},
                                      id<AssetId>("item"),
                                      std::nullopt,
                                      PresentationPlane::WorldContent,
                                      12,
                                      true,
                                      true});
    const compiled::HotspotRef hotspot_ref =
        compiled::InteractableHotspotRef{id<InteractableId>("key"), id<HotspotId>("inspect")};
    snapshot.hotspots.push_back(
        {hotspot_ref, "Inspect", true, true, semantic_target("inspect"), AlphaHotspotShape{}, 0,
         compiled::MaterialHotspotHighlight{id<core::MaterialId>("custom-highlight")},
         id<AssetId>("item"), 400, 200,
         compiled::RoomPlacementRef{id<RoomId>("room"), id<RoomPlacementId>("table")},
         compiled::NormalizedRect{0.25, 0.4, 0.3, 0.2}, PresentationPlane::WorldContent, 12});

    REQUIRE(backend.reconcile(snapshot, {1000.0f, 500.0f}));
    REQUIRE(backend.frame());
    REQUIRE(backend.frame()->hotspot_surfaces.size() == 1);
    const auto* owner = find_draw(*backend.frame(), "key");
    REQUIRE(owner);
    const auto& overlay = backend.frame()->hotspot_surfaces.front().overlay;
    CHECK(overlay.command.rect.x == Catch::Approx(owner->command.rect.x));
    CHECK(overlay.command.rect.y == Catch::Approx(owner->command.rect.y));
    CHECK(overlay.command.rect.width == Catch::Approx(owner->command.rect.width));
    CHECK(overlay.command.rect.height == Catch::Approx(owner->command.rect.height));
    CHECK(overlay.command.material.value() == "custom-highlight");
    CHECK(overlay.order == owner->order);
    CHECK(overlay.sublayer == owner->sublayer + 1);
}

TEST_CASE("failed hotspot preparation preserves the prior world candidate")
{
    FakeWorldResources resources;
    resources.add_texture("room-image", 17, 1600, 900);
    WorldPresentationBackend backend(resources);
    auto prior = base_snapshot(1);
    prior.background = PresentationBackground{.asset = id<AssetId>("room-image"),
                                              .color = std::nullopt,
                                              .fit = compiled::BackgroundFit::Stretch,
                                              .material = std::nullopt};
    REQUIRE(backend.reconcile(prior, {1000.0f, 500.0f}));

    auto candidate = prior;
    candidate.revision = PresentationSnapshotRevision::from_number(2);
    candidate.hotspots.push_back(
        {compiled::RoomHotspotRef{id<RoomId>("room"), id<HotspotId>("desk")}, "Desk", true, true,
         semantic_target("desk"), AlphaHotspotShape{}, 0, compiled::DefaultHotspotHighlight{},
         id<AssetId>("room-image"), 1600, 900, std::nullopt, std::nullopt,
         PresentationPlane::WorldBackground, 0});
    resources.fail_hotspot_resources = true;
    CHECK_FALSE(backend.reconcile(candidate, {1000.0f, 500.0f}));
    REQUIRE(backend.frame());
    CHECK(backend.frame()->revision.number() == 1);
    CHECK(backend.frame(PresentationSnapshotRevision::from_number(2)) == nullptr);
}

TEST_CASE("world hotspot controller honors draw order input order and background crop")
{
    FakeWorldResources resources;
    resources.add_texture("room-image", 17, 1000, 1000);
    resources.add_texture("item", 23, 100, 100);
    WorldPresentationBackend backend(resources);
    WorldHotspotController controller(backend);
    auto snapshot = base_snapshot();
    snapshot.background = PresentationBackground{.asset = id<AssetId>("room-image"),
                                                 .fit = compiled::BackgroundFit::Cover};
    snapshot.interactables.push_back({id<InteractableId>("item"),
                                      {id<RoomId>("room"), id<RoomPlacementId>("item-place")},
                                      {0.4, 0.4, 0.2, 0.2},
                                      id<AssetId>("item"),
                                      std::nullopt,
                                      PresentationPlane::WorldContent,
                                      0,
                                      true,
                                      true});
    const compiled::HotspotRef room_low =
        compiled::RoomHotspotRef{id<RoomId>("room"), id<HotspotId>("low")};
    const compiled::HotspotRef room_high =
        compiled::RoomHotspotRef{id<RoomId>("room"), id<HotspotId>("high")};
    const compiled::HotspotRef item =
        compiled::InteractableHotspotRef{id<InteractableId>("item"), id<HotspotId>("item-hotspot")};
    snapshot.hotspots = {
        {room_low, "Low", true, true, semantic_target("low"),
         compiled::NormalizedRect{0.0, 0.0, 1.0, 1.0}, 1, compiled::NoHotspotHighlight{},
         id<AssetId>("room-image"), 1000, 1000},
        {room_high, "High", true, true, semantic_target("high"),
         compiled::NormalizedRect{0.0, 0.0, 1.0, 1.0}, 5, compiled::NoHotspotHighlight{},
         id<AssetId>("room-image"), 1000, 1000},
        {item, "Item", true, true, semantic_target("item"),
         compiled::NormalizedRect{0.0, 0.0, 1.0, 1.0}, 0, compiled::NoHotspotHighlight{},
         id<AssetId>("item"), 100, 100,
         compiled::RoomPlacementRef{id<RoomId>("room"), id<RoomPlacementId>("item-place")},
         compiled::NormalizedRect{0.4, 0.4, 0.2, 0.2}, PresentationPlane::WorldContent, 0},
    };

    REQUIRE(backend.reconcile(snapshot, {1000.0f, 500.0f}));
    controller.presentation_changed();
    auto item_down = controller.handle(
        {WorldPointerEventKind::MouseDown, {500.0f, 250.0f}, {500.0f, 250.0f}, 0, true, true});
    REQUIRE(item_down.consumed);
    auto item_up = controller.handle(
        {WorldPointerEventKind::MouseUp, {500.0f, 250.0f}, {500.0f, 250.0f}, 0, true, true});
    REQUIRE(item_up.target);
    CHECK(*item_up.target == semantic_target("item"));

    auto room_down = controller.handle(
        {WorldPointerEventKind::MouseDown, {100.0f, 250.0f}, {100.0f, 250.0f}, 0, true, true});
    REQUIRE(room_down.consumed);
    auto room_up = controller.handle(
        {WorldPointerEventKind::MouseUp, {100.0f, 250.0f}, {100.0f, 250.0f}, 0, true, true});
    REQUIRE(room_up.target);
    CHECK(*room_up.target == semantic_target("high"));

    auto cropped = controller.handle(
        {WorldPointerEventKind::MouseDown, {500.0f, 10.0f}, {500.0f, 10.0f}, 0, true, true});
    CHECK(cropped.consumed);
}

TEST_CASE("multiple hotspot geometries publish the same owner-qualified Feature subject")
{
    FakeWorldResources resources;
    resources.add_texture("room-image", 17, 100, 100);
    WorldPresentationBackend backend(resources);
    WorldHotspotController controller(backend);
    auto snapshot = base_snapshot();
    snapshot.background = PresentationBackground{.asset = id<AssetId>("room-image"),
                                                 .fit = compiled::BackgroundFit::Stretch};
    const compiled::ResolvedHotspotTarget shared = compiled::FeatureInteractionSubject{
        RoomFeatureRef{id<RoomId>("room"), id<FeatureId>("desk")}};
    snapshot.hotspots = {
        {compiled::RoomHotspotRef{id<RoomId>("room"), id<HotspotId>("desk-left")}, "Desk left",
         true, true, shared, compiled::NormalizedRect{0.0, 0.0, 0.5, 1.0}, 0,
         compiled::NoHotspotHighlight{}, id<AssetId>("room-image"), 100, 100},
        {compiled::RoomHotspotRef{id<RoomId>("room"), id<HotspotId>("desk-right")}, "Desk right",
         true, true, shared, compiled::NormalizedRect{0.5, 0.0, 0.5, 1.0}, 0,
         compiled::NoHotspotHighlight{}, id<AssetId>("room-image"), 100, 100},
    };
    REQUIRE(backend.reconcile(snapshot, {100.0f, 100.0f}));
    controller.presentation_changed();

    REQUIRE(
        controller
            .handle(
                {WorldPointerEventKind::MouseDown, {25.0f, 50.0f}, {25.0f, 50.0f}, 0, true, true})
            .consumed);
    const auto left = controller.handle(
        {WorldPointerEventKind::MouseUp, {25.0f, 50.0f}, {25.0f, 50.0f}, 0, true, true});
    REQUIRE(left.target);
    CHECK(*left.target == shared);

    REQUIRE(
        controller
            .handle(
                {WorldPointerEventKind::MouseDown, {75.0f, 50.0f}, {75.0f, 50.0f}, 0, true, true})
            .consumed);
    const auto right = controller.handle(
        {WorldPointerEventKind::MouseUp, {75.0f, 50.0f}, {75.0f, 50.0f}, 0, true, true});
    REQUIRE(right.target);
    CHECK(*right.target == shared);
}

TEST_CASE("world hotspot alpha coverage passes transparent pixels through")
{
    FakeWorldResources resources;
    resources.add_texture("item", 23, 2, 1);
    resources.set_alpha_coverage(
        "item", {.width = 2, .height = 1, .row_stride_bytes = 1, .occupancy_bits = {0b00000010}});
    WorldPresentationBackend backend(resources);
    WorldHotspotController controller(backend);
    auto snapshot = base_snapshot();
    snapshot.interactables.push_back({id<InteractableId>("item"),
                                      {id<RoomId>("room"), id<RoomPlacementId>("item-place")},
                                      {0.0, 0.0, 1.0, 1.0},
                                      id<AssetId>("item"),
                                      std::nullopt,
                                      PresentationPlane::WorldContent,
                                      0,
                                      true,
                                      true});
    const compiled::HotspotRef alpha =
        compiled::InteractableHotspotRef{id<InteractableId>("item"), id<HotspotId>("alpha")};
    snapshot.hotspots.push_back(
        {alpha, "Alpha", true, true, semantic_target("alpha"), AlphaHotspotShape{}, 0,
         compiled::NoHotspotHighlight{}, id<AssetId>("item"), 2, 1,
         compiled::RoomPlacementRef{id<RoomId>("room"), id<RoomPlacementId>("item-place")},
         compiled::NormalizedRect{0.0, 0.0, 1.0, 1.0}, PresentationPlane::WorldContent, 0});
    REQUIRE(backend.reconcile(snapshot, {100.0f, 100.0f}));
    controller.presentation_changed();

    CHECK_FALSE(
        controller
            .handle(
                {WorldPointerEventKind::MouseDown, {25.0f, 50.0f}, {25.0f, 50.0f}, 0, true, true})
            .consumed);
    CHECK(controller
              .handle(
                  {WorldPointerEventKind::MouseDown, {75.0f, 50.0f}, {75.0f, 50.0f}, 0, true, true})
              .consumed);
}

TEST_CASE("world hotspot capture uses host-pixel slop and cancels on UI admission")
{
    FakeWorldResources resources;
    resources.add_texture("room-image", 17, 100, 100);
    WorldPresentationBackend backend(resources);
    WorldHotspotController controller(backend);
    auto snapshot = base_snapshot();
    snapshot.background = PresentationBackground{.asset = id<AssetId>("room-image"),
                                                 .fit = compiled::BackgroundFit::Stretch};
    const compiled::HotspotRef hotspot =
        compiled::RoomHotspotRef{id<RoomId>("room"), id<HotspotId>("room")};
    snapshot.hotspots.push_back({hotspot, "Room", true, true, semantic_target("room-target"),
                                 compiled::NormalizedRect{0.0, 0.0, 1.0, 1.0}, 0,
                                 compiled::DefaultHotspotHighlight{}, id<AssetId>("room-image"),
                                 100, 100});
    REQUIRE(backend.reconcile(snapshot, {100.0f, 100.0f}));
    controller.presentation_changed();

    REQUIRE(
        controller
            .handle(
                {WorldPointerEventKind::MouseDown, {10.0f, 10.0f}, {10.0f, 10.0f}, 0, true, true})
            .consumed);
    REQUIRE(
        controller
            .handle(
                {WorldPointerEventKind::MouseMove, {19.0f, 10.0f}, {19.0f, 10.0f}, 0, true, true})
            .consumed);
    auto canceled = controller.handle(
        {WorldPointerEventKind::MouseUp, {19.0f, 10.0f}, {19.0f, 10.0f}, 0, true, true});
    CHECK(canceled.consumed);
    CHECK_FALSE(canceled.target);

    REQUIRE(
        controller
            .handle(
                {WorldPointerEventKind::MouseDown, {10.0f, 10.0f}, {10.0f, 10.0f}, 0, true, true})
            .consumed);
    REQUIRE(
        controller
            .handle(
                {WorldPointerEventKind::MouseMove, {18.0f, 10.0f}, {18.0f, 10.0f}, 0, true, true})
            .consumed);
    auto exact_slop_release = controller.handle(
        {WorldPointerEventKind::MouseUp, {18.0f, 10.0f}, {18.0f, 10.0f}, 0, true, true});
    REQUIRE(exact_slop_release.target);
    CHECK(*exact_slop_release.target == semantic_target("room-target"));

    REQUIRE(
        controller
            .handle(
                {WorldPointerEventKind::MouseDown, {10.0f, 10.0f}, {10.0f, 10.0f}, 0, true, true})
            .consumed);
    (void)controller.handle(
        {WorldPointerEventKind::MouseMove, {10.0f, 10.0f}, {10.0f, 10.0f}, 0, true, false});
    auto blocked_release = controller.handle(
        {WorldPointerEventKind::MouseUp, {10.0f, 10.0f}, {10.0f, 10.0f}, 0, true, true});
    CHECK_FALSE(blocked_release.consumed);
    CHECK_FALSE(blocked_release.target);

    REQUIRE(
        controller
            .handle(
                {WorldPointerEventKind::TouchDown, {20.0f, 20.0f}, {20.0f, 20.0f}, 1, true, true})
            .consumed);
    CHECK_FALSE(
        controller
            .handle(
                {WorldPointerEventKind::TouchDown, {30.0f, 30.0f}, {30.0f, 30.0f}, 2, true, true})
            .consumed);
    CHECK_FALSE(
        controller
            .handle({WorldPointerEventKind::TouchUp, {30.0f, 30.0f}, {30.0f, 30.0f}, 2, true, true})
            .target);
    auto touch_release = controller.handle(
        {WorldPointerEventKind::TouchUp, {20.0f, 20.0f}, {20.0f, 20.0f}, 1, true, true});
    REQUIRE(touch_release.target);
    CHECK(*touch_release.target == semantic_target("room-target"));
}

TEST_CASE("world hotspot capture revalidates release containment and presentation generation")
{
    FakeWorldResources resources;
    resources.add_texture("room-image", 17, 100, 100);
    WorldPresentationBackend backend(resources);
    WorldHotspotController controller(backend);
    auto snapshot = base_snapshot(1);
    snapshot.background = PresentationBackground{.asset = id<AssetId>("room-image"),
                                                 .fit = compiled::BackgroundFit::Stretch};
    const compiled::HotspotRef hotspot =
        compiled::RoomHotspotRef{id<RoomId>("room"), id<HotspotId>("small")};
    snapshot.hotspots.push_back({hotspot, "Small", true, true, semantic_target("small-target"),
                                 compiled::NormalizedRect{0.0, 0.0, 0.1, 0.1}, 0,
                                 compiled::NoHotspotHighlight{}, id<AssetId>("room-image"), 100,
                                 100});
    REQUIRE(backend.reconcile(snapshot, {100.0f, 100.0f}));
    controller.presentation_changed();

    REQUIRE(
        controller
            .handle({WorldPointerEventKind::MouseDown, {5.0f, 5.0f}, {5.0f, 5.0f}, 0, true, true})
            .consumed);
    auto outside_release = controller.handle(
        {WorldPointerEventKind::MouseUp, {11.0f, 5.0f}, {11.0f, 5.0f}, 0, true, true});
    CHECK(outside_release.consumed);
    CHECK_FALSE(outside_release.target);

    REQUIRE(
        controller
            .handle({WorldPointerEventKind::MouseDown, {5.0f, 5.0f}, {5.0f, 5.0f}, 0, true, true})
            .consumed);
    auto replacement = snapshot;
    replacement.revision = PresentationSnapshotRevision::from_number(2);
    REQUIRE(backend.reconcile(replacement, {100.0f, 100.0f}));
    controller.presentation_changed();
    auto surviving_release = controller.handle(
        {WorldPointerEventKind::MouseUp, {5.0f, 5.0f}, {5.0f, 5.0f}, 0, true, true});
    CHECK_FALSE(surviving_release.consumed);
    CHECK_FALSE(surviving_release.target);

    REQUIRE(
        controller
            .handle({WorldPointerEventKind::MouseDown, {5.0f, 5.0f}, {5.0f, 5.0f}, 0, true, true})
            .consumed);
    replacement.revision = PresentationSnapshotRevision::from_number(3);
    replacement.hotspots.clear();
    REQUIRE(backend.reconcile(replacement, {100.0f, 100.0f}));
    controller.presentation_changed();
    auto removed_release = controller.handle(
        {WorldPointerEventKind::MouseUp, {5.0f, 5.0f}, {5.0f, 5.0f}, 0, true, true});
    CHECK_FALSE(removed_release.consumed);
    CHECK_FALSE(removed_release.target);
}
