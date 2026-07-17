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

FlowFrameId flow_frame_id(std::uint64_t value)
{
    static_assert(sizeof(FlowFrameId) == sizeof(value));
    return std::bit_cast<FlowFrameId>(value);
}

using ScopedActorInstanceId = decltype(std::declval<ScopedActorKey>().instance);

class FakeWorldResources final : public WorldPresentationResourceResolver {
public:
    void add_texture(const char* asset, std::uint16_t handle, std::uint16_t width,
                     std::uint16_t height)
    {
        m_textures.emplace(
            asset, assets::TextureAsset{handle, "project:/" + std::string(asset), width, height});
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
        }
        if (material)
            result.material = noveltea::MaterialId(material->text());
        return Result<WorldPreparedVisual, Diagnostics>::success(std::move(result));
    }

    Result<std::optional<WorldPreparedVisual>, Diagnostics>
    resolve_environment(std::string_view kind, std::string_view context) override
    {
        ++resolve_calls;
        if (kind == "failed") {
            return Result<std::optional<WorldPreparedVisual>, Diagnostics>::failure(
                {{.code = "test.world_environment_failure",
                  .message = "failed environment",
                  .source_path = std::string(context)}});
        }
        if (kind != "material:rain")
            return Result<std::optional<WorldPreparedVisual>, Diagnostics>::success(std::nullopt);
        WorldPreparedVisual result;
        result.material = noveltea::MaterialId("rain");
        result.tint = {0.75f, 0.85f, 1.0f, 0.25f};
        return Result<std::optional<WorldPreparedVisual>, Diagnostics>::success(std::move(result));
    }

    std::size_t resolve_calls = 0;

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
         SessionPresentationOwner{PresentationSessionId::from_number(1)}, "material:rain",
         PresentationPlane::WorldContent, 50, LayoutClockDomain::Gameplay, true});
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
    resources.add_texture("map", 8, 400, 200);
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
