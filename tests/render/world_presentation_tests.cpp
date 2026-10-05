#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include "noveltea/core/compiled_project_codec.hpp"
#include "noveltea/core/flow_executor.hpp"
#include "noveltea/core/session_state.hpp"
#include "noveltea/presentation/room_presentation.hpp"
#include "noveltea/presentation/runtime_presentation.hpp"
#include "noveltea/runtime/runtime_world.hpp"
#include "noveltea/world_presentation.hpp"

#include <algorithm>
#include <bit>
#include <fstream>
#include <iterator>
#include <nlohmann/json.hpp>
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

    Result<WorldPreparedVisual, Diagnostics>
    resolve_visual(const compiled::Visual& visual, std::optional<core::MaterialId> material,
                   std::string_view context) override
    {
        if (const auto* image = std::get_if<compiled::ImageVisual>(&visual))
            return resolve(image->image, material, context);
        const auto& animation = std::get<compiled::AnimationVisual>(visual);
        if (animation.animation.text() != "rain-animation")
            return Result<WorldPreparedVisual, Diagnostics>::failure(
                {{.code = "test.world_animation_missing",
                  .message = "missing " + animation.animation.text(),
                  .source_path = std::string(context)}});
        auto prepared = resolve(std::nullopt, material, context);
        if (!prepared)
            return prepared;
        auto result = std::move(*prepared.value_if());
        const auto first = m_textures.find("rain-a");
        const auto second = m_textures.find("rain-b");
        if (first == m_textures.end() || second == m_textures.end())
            return Result<WorldPreparedVisual, Diagnostics>::failure(
                {{.code = "test.world_animation_frame_missing",
                  .message = "missing animation frame",
                  .source_path = std::string(context)}});
        result.logical_size = Size{64.0f, 32.0f};
        result.animation_key = animation.animation.text() + ":" +
                               (animation.motion ? animation.motion->text() : "fall");
        auto first_prepared = resolve(id<AssetId>("rain-a"), std::nullopt, context);
        auto second_prepared = resolve(id<AssetId>("rain-b"), std::nullopt, context);
        if (!first_prepared)
            return first_prepared;
        if (!second_prepared)
            return second_prepared;
        result.animation_frames = {
            {50, first->second, first_prepared.value_if()->texture_lease},
            {100, second->second, second_prepared.value_if()->texture_lease}};
        result.texture = first->second;
        result.texture_lease = result.animation_frames.front().texture_lease;
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
                             std::nullopt,
                             id<CharacterId>("hero"),
                             id<CharacterPresentationProfileId>("stage"),
                             id<CharacterPoseId>("standing"),
                             id<CharacterExpressionId>("neutral"),
                             std::nullopt,
                             std::nullopt,
                             {},
                             {},
                             {{id<CharacterPresentationLayerId>("body"),
                               std::string{"body"},
                               id<AssetId>("pose"),
                               id<core::MaterialId>("pose-material"),
                               {},
                               {},
                               {0.5, 1.0},
                               {0.0, 0.0},
                               1.0,
                               true},
                              {id<CharacterPresentationLayerId>("face"),
                               std::string{"face"},
                               id<AssetId>("expression"),
                               id<core::MaterialId>("expression-material"),
                               {},
                               {},
                               {0.5, 1.0},
                               {0.0, 0.0},
                               1.0,
                               true}},
                             {},
                             std::nullopt,
                             std::nullopt,
                             PresentationPlane::WorldContent,
                             order,
                             true,
                             true,
                             true,
                             false};
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

CompiledProject placement_independent_order_project(bool move_lower_occurrence)
{
    std::ifstream input(
        std::string(NOVELTEA_SOURCE_DIR) +
        "/editor/src/renderer/test/fixtures/compiled-project-golden/interaction-program.json");
    REQUIRE(input.good());
    const std::string source((std::istreambuf_iterator<char>(input)), {});
    auto document = nlohmann::json::parse(source);

    auto& rooms = document["definitions"]["rooms"];
    auto room = std::find_if(rooms.begin(), rooms.end(),
                             [](const nlohmann::json& value) { return value["id"] == "start"; });
    REQUIRE(room != rooms.end());
    REQUIRE((*room)["interactables"].size() == 1);
    REQUIRE((*room)["placements"].size() == 1);

    (*room)["interactables"][0]["order"] = 20;
    (*room)["placements"].push_back(
        {{"bounds", {{"x", 0.7}, {"y", 0.1}, {"width", 0.15}, {"height", 0.15}}},
         {"id", "alternate-placement"},
         {"presentation", {{"label", nullptr}, {"layout", nullptr}, {"layoutOrder", nullptr}}}});

    auto& instances = document["interactableInstances"];
    const auto original =
        std::find_if(instances.begin(), instances.end(),
                     [](const nlohmann::json& value) { return value["id"] == "key"; });
    REQUIRE(original != instances.end());
    auto second = *original;
    second["id"] = "key-2";
    instances.push_back(std::move(second));

    (*room)["interactables"].push_back(
        {{"condition", {{"kind", "always"}}},
         {"id", "key-2"},
         {"interactable", {{"id", "key-2"}, {"kind", "interactable"}}},
         {"order", 10},
         {"placementId", move_lower_occurrence ? "alternate-placement" : "key-placement"},
         {"visible", true}});

    auto decoded = decode_compiled_project(document, "placement-independent-order.json");
    REQUIRE(decoded);
    return std::move(decoded).value();
}

void finish_initial_room_transition(FlowExecutor& executor)
{
    REQUIRE(executor.advance_room_transition(RoomTransitionStage::BeforeEnter));
    REQUIRE(executor.advance_room_transition(RoomTransitionStage::CommitRoomSwitch));
    REQUIRE(executor.advance_room_transition(RoomTransitionStage::AfterEnter));
    REQUIRE(executor.advance_room_transition(RoomTransitionStage::Complete));
    REQUIRE(executor.complete_room_transition());
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

TEST_CASE("world resource invalidation re-resolves an unchanged semantic snapshot")
{
    FakeWorldResources resources;
    resources.add_texture("background", 7, 640, 360);
    WorldPresentationBackend backend(resources);

    auto snapshot = base_snapshot();
    snapshot.background = PresentationBackground{.asset = id<AssetId>("background"),
                                                 .color = std::nullopt,
                                                 .fit = compiled::BackgroundFit::Cover,
                                                 .material = std::nullopt};

    auto initial = backend.reconcile(snapshot, {1280.0f, 720.0f});
    REQUIRE(initial);
    CHECK(initial.value());
    CHECK(resources.resolve_calls == 1);

    auto unchanged = backend.reconcile(snapshot, {1280.0f, 720.0f});
    REQUIRE(unchanged);
    CHECK_FALSE(unchanged.value());
    CHECK(resources.resolve_calls == 1);

    backend.invalidate_resources();
    auto refreshed = backend.reconcile(snapshot, {1280.0f, 720.0f});
    REQUIRE(refreshed);
    CHECK(refreshed.value());
    CHECK(resources.resolve_calls == 2);
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

TEST_CASE("world backend interleaves WorldContent families by authored order")
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
         std::nullopt,
         id<PresentationEnvironmentStopKey>("weather"),
         std::nullopt,
         std::nullopt,
         id<core::MaterialId>("rain"),
         {},
         {},
         {0.0, 0.0, 1.0, 1.0},
         PresentationPlane::WorldContent,
         10,
         LayoutClockDomain::Gameplay,
         {0.1, 0.0},
         0.5,
         true});
    snapshot.props.push_back(
        {ScopedPropPresentationKey{id<PresentationPropInstanceId>("foreground-prop")},
         SessionPresentationOwner{PresentationSessionId::from_number(1)},
         std::nullopt,
         id<AssetId>("prop"),
         std::nullopt,
         {},
         {},
         std::nullopt,
         {0.2, 0.3, 0.1, 0.2},
         PresentationPlane::WorldContent,
         50,
         true});
    snapshot.interactables.push_back({id<InteractableInstanceId>("key"),
                                      {id<RoomId>("atrium"), id<RoomPlacementId>("table")},
                                      {0.4, 0.5, 0.1, 0.15},
                                      compiled::ImageVisual{id<AssetId>("item")},
                                      id<core::MaterialId>("item-material"),
                                      std::nullopt,
                                      {},
                                      PresentationPlane::WorldContent,
                                      30,
                                      true,
                                      true});

    const ScenePresentationOwner scene_owner{flow_frame_id(7), id<SceneId>("opening")};
    snapshot.actors.push_back(actor(ScopedActorKey{id<ScopedActorInstanceId>("temporary")}, 70));
    snapshot.actors.push_back(actor(SceneActorKey{scene_owner, id<ActorSlotId>("lead")}, 60));
    snapshot.actors.push_back(
        actor(RoomCastActorKey{id<RoomId>("atrium"), id<RoomCastEntryId>("guard")}, 40));
    snapshot.actors.push_back(actor(CharacterActorKey{id<CharacterId>("hero")}, 20));

    REQUIRE(backend.reconcile(snapshot, {1000.0f, 500.0f}));
    REQUIRE(backend.frame());
    const auto& draws = backend.frame()->draws;
    REQUIRE(draws.size() == 11);
    CHECK(draws[0].family == WorldDrawFamily::Environment);
    CHECK(draws[1].family == WorldDrawFamily::Actor);
    CHECK(draws[1].stable_identity == "character/hero");
    CHECK(draws[2].family == WorldDrawFamily::Actor);
    CHECK(draws[2].stable_identity == "character/hero");
    CHECK(draws[3].family == WorldDrawFamily::Interactable);
    CHECK(draws[3].command.rect.x == Catch::Approx(400.0f));
    CHECK(draws[3].command.rect.y == Catch::Approx(250.0f));
    CHECK(draws[3].command.rect.width == Catch::Approx(100.0f));
    CHECK(draws[3].command.material.value() == "item-material");
    CHECK(draws[4].family == WorldDrawFamily::Actor);
    CHECK(draws[4].stable_identity == "room-cast/atrium/guard");
    CHECK(draws[6].family == WorldDrawFamily::Prop);

    std::vector<std::string> actor_identities;
    for (const auto& draw : draws) {
        if (draw.family == WorldDrawFamily::Actor && draw.sublayer == 0)
            actor_identities.push_back(draw.stable_identity);
    }
    CHECK(actor_identities == std::vector<std::string>{"character/hero", "room-cast/atrium/guard",
                                                       "scene/7/opening/lead", "scoped/temporary"});
}

TEST_CASE("world rendering keeps Interactable stacking occurrence-owned across placements")
{
    const auto render_interactables = [](const CompiledProject& project) {
        auto created = SessionState::create(project);
        REQUIRE(created);
        auto state = std::move(created).value();
        FlowExecutor flow(project, state);
        finish_initial_room_transition(flow);
        REQUIRE(state.commit_room_entry(project, id<RoomId>("start"), std::nullopt));
        REQUIRE(state.room_visit());

        runtime::RuntimeWorld world(project, state);
        RoomPresentationResolver resolver;
        auto resolution = resolver.resolve(
            project, world, state, *state.room_visit(),
            [](const Condition&) { return Result<bool, Diagnostics>::success(true); },
            [](const TextSource&) {
                return Result<std::string, Diagnostics>::success(std::string{"test"});
            });
        REQUIRE(resolution);

        auto snapshot =
            PresentationProjector::project(project, world, state, &resolution.value().presentation);
        REQUIRE(snapshot);

        FakeWorldResources resources;
        resources.add_texture("image-main", 1, 64, 64);
        resources.set_alpha_coverage("image-main",
                                     {.width = 64,
                                      .height = 64,
                                      .row_stride_bytes = 8,
                                      .occupancy_bits = std::vector<std::uint8_t>(512, 255)});
        WorldPresentationBackend backend(resources);
        REQUIRE(backend.reconcile(snapshot.value(), {1000.0f, 500.0f}));
        REQUIRE(backend.frame());

        std::vector<std::pair<std::string, float>> result;
        for (const auto& draw : backend.frame()->draws) {
            if (draw.family == WorldDrawFamily::Interactable && draw.sublayer == 0)
                result.emplace_back(draw.stable_identity, draw.command.rect.x);
        }
        return result;
    };

    const auto shared_placement = render_interactables(placement_independent_order_project(false));
    REQUIRE(shared_placement.size() == 2);
    CHECK(shared_placement[0].first == "start/key-2/authored/key-2");
    CHECK(shared_placement[1].first == "start/key/authored/key");
    CHECK(shared_placement[0].second == Catch::Approx(shared_placement[1].second));

    const auto moved_placement = render_interactables(placement_independent_order_project(true));
    REQUIRE(moved_placement.size() == 2);
    CHECK(moved_placement[0].first == "start/key-2/authored/key-2");
    CHECK(moved_placement[1].first == "start/key/authored/key");
    CHECK(moved_placement[0].second != Catch::Approx(moved_placement[1].second));
}

TEST_CASE("Interactable Material Application overrides reach the draw command")
{
    FakeWorldResources resources;
    resources.add_texture("item", 4, 32, 32);
    WorldPresentationBackend backend(resources);

    auto snapshot = base_snapshot();
    const auto interactable = id<InteractableInstanceId>("key");
    const auto material = id<core::MaterialId>("item-material");
    const PresentationOwner owner = RoomPresentationOwner{id<RoomId>("atrium")};
    snapshot.interactables.push_back({interactable,
                                      {id<RoomId>("atrium"), id<RoomPlacementId>("table")},
                                      {0.4, 0.5, 0.1, 0.15},
                                      compiled::ImageVisual{id<AssetId>("item")},
                                      material,
                                      owner,
                                      {{"s_noise", "project:/assets/noise.png"}},
                                      PresentationPlane::WorldContent,
                                      30,
                                      true,
                                      true});
    snapshot.material_parameters.push_back(
        {owner, InteractableMaterialOccurrence{interactable}, material, "u_amount",
         compiled::MaterialParameterValue{0.5}, std::nullopt, MaterialClockPolicy::Gameplay});

    REQUIRE(backend.reconcile(snapshot, {1000.0f, 500.0f}));
    REQUIRE(backend.frame());
    const auto* draw = find_draw(*backend.frame(), "key", 0);
    REQUIRE(draw);
    REQUIRE(draw->command.material_texture_overrides.size() == 1);
    CHECK(draw->command.material_texture_overrides.front().name == "s_noise");
    CHECK(draw->command.material_texture_overrides.front().source == "project:/assets/noise.png");

    const auto rendered = std::ranges::find_if(
        backend.frame()->base_batch.commands(),
        [&](const QuadCommand& command) { return command.material.string() == material.text(); });
    REQUIRE(rendered != backend.frame()->base_batch.commands().end());
    REQUIRE(rendered->material_uniform_overrides.size() == 1);
    CHECK(rendered->material_uniform_overrides.front().name == "u_amount");
    CHECK(std::get<float>(rendered->material_uniform_overrides.front().value) ==
          Catch::Approx(0.5f));
    REQUIRE(rendered->material_texture_overrides.size() == 1);
    CHECK(rendered->material_texture_overrides.front().source == "project:/assets/noise.png");
}

TEST_CASE("Engine2D Material Applications reach background prop environment and actor draws")
{
    FakeWorldResources resources;
    resources.add_texture("background", 10, 100, 50);
    resources.add_texture("prop", 11, 32, 32);
    resources.add_texture("environment", 12, 64, 64);
    resources.add_texture("pose", 13, 80, 160);
    resources.add_texture("expression", 14, 80, 160);
    WorldPresentationBackend backend(resources);

    auto snapshot = base_snapshot();
    const auto room = id<RoomId>("atrium");
    const PresentationOwner owner = RoomPresentationOwner{room};
    const auto background_material = id<core::MaterialId>("background-material");
    const auto prop_material = id<core::MaterialId>("prop-material");
    const auto environment_material = id<core::MaterialId>("environment-material");
    const auto actor_material = id<core::MaterialId>("pose-material");

    snapshot.background = PresentationBackground{
        .material_owner = owner,
        .material_property_owner = PropertyOwnerRef{room},
        .asset = id<AssetId>("background"),
        .color = std::nullopt,
        .fit = compiled::BackgroundFit::Cover,
        .material = background_material,
        .material_parameters = {},
        .material_texture_overrides = {{"s_noise", "project:/assets/background-noise.png"}},
    };

    const auto prop_instance = id<PresentationPropInstanceId>("room-6-atrium-prop-banner");
    snapshot.props.push_back(PresentationProp{
        .key = RoomPropPresentationKey{room, id<RoomPropId>("banner")},
        .owner = owner,
        .material_property_owner = PropertyOwnerRef{room},
        .asset = id<AssetId>("prop"),
        .material = prop_material,
        .material_parameters = {},
        .material_texture_overrides = {{"s_noise", "project:/assets/prop-noise.png"}},
        .placement = std::nullopt,
        .bounds = {0.1, 0.1, 0.2, 0.2},
        .plane = PresentationPlane::WorldContent,
        .order = 10,
        .visible = true,
    });

    const auto environment_instance = id<PresentationEnvironmentInstanceId>("fog");
    snapshot.environments.push_back(PresentationEnvironment{
        .instance = environment_instance,
        .owner = owner,
        .material_property_owner = PropertyOwnerRef{room},
        .stop_key = id<PresentationEnvironmentStopKey>("fog-stop"),
        .asset = id<AssetId>("environment"),
        .material = environment_material,
        .material_parameters = {},
        .material_texture_overrides = {{"s_noise", "project:/assets/environment-noise.png"}},
        .bounds = {0.0, 0.0, 1.0, 1.0},
        .plane = PresentationPlane::WorldBackground,
        .order = 5,
        .clock = LayoutClockDomain::Gameplay,
        .scroll_per_second = {0.0, 0.0},
        .opacity = 1.0,
        .visible = true,
    });

    auto hero = actor(CharacterActorKey{id<CharacterId>("hero")}, 20);
    hero.material_owner = owner;
    hero.layers.front().material_texture_overrides = {
        {"s_noise", "project:/assets/actor-noise.png"}};
    snapshot.actors.push_back(hero);

    snapshot.material_parameters.push_back(
        {owner, BackgroundMaterialOccurrence{}, background_material, "u_amount",
         compiled::MaterialParameterValue{0.1}, std::nullopt, MaterialClockPolicy::Gameplay});
    snapshot.material_parameters.push_back(
        {owner, PropMaterialOccurrence{prop_instance}, prop_material, "u_amount",
         compiled::MaterialParameterValue{0.2}, std::nullopt, MaterialClockPolicy::Gameplay});
    snapshot.material_parameters.push_back(
        {owner, EnvironmentMaterialOccurrence{environment_instance}, environment_material,
         "u_amount", compiled::MaterialParameterValue{0.3}, std::nullopt,
         MaterialClockPolicy::Gameplay});
    snapshot.material_parameters.push_back(
        {owner, ActorMaterialOccurrence{hero.key, hero.layers.front().id}, actor_material,
         "u_amount", compiled::MaterialParameterValue{0.4}, std::nullopt,
         MaterialClockPolicy::Gameplay});

    REQUIRE(backend.reconcile(snapshot, {1000.0f, 500.0f}));
    REQUIRE(backend.frame());
    const auto& frame = *backend.frame();

    const auto check_draw = [&](std::string_view identity, std::uint8_t sublayer,
                                std::string_view texture_source) {
        const auto* draw = find_draw(frame, identity, sublayer);
        REQUIRE(draw != nullptr);
        REQUIRE(draw->command.material_texture_overrides.size() == 1);
        CHECK(draw->command.material_texture_overrides.front().source == texture_source);
    };
    check_draw("background", 1, "project:/assets/background-noise.png");
    check_draw("room/atrium/banner", 0, "project:/assets/prop-noise.png");
    check_draw("room/atrium/environment/fog", 0, "project:/assets/environment-noise.png");
    check_draw("character/hero", 0, "project:/assets/actor-noise.png");

    const auto check_uniform = [&](const core::MaterialId& material, float expected) {
        const auto rendered =
            std::ranges::find_if(frame.base_batch.commands(), [&](const QuadCommand& command) {
                return command.material.string() == material.text();
            });
        REQUIRE(rendered != frame.base_batch.commands().end());
        REQUIRE(rendered->material_uniform_overrides.size() == 1);
        CHECK(rendered->material_uniform_overrides.front().name == "u_amount");
        CHECK(std::get<float>(rendered->material_uniform_overrides.front().value) ==
              Catch::Approx(expected));
    };
    check_uniform(background_material, 0.1f);
    check_uniform(prop_material, 0.2f);
    check_uniform(environment_material, 0.3f);
    check_uniform(actor_material, 0.4f);
}

TEST_CASE("raster Animation playback is occurrence-local and survives unrelated republishes")
{
    FakeWorldResources resources;
    resources.add_texture("rain-a", 21, 24, 32);
    resources.add_texture("rain-b", 22, 48, 32);
    WorldPresentationBackend backend(resources);

    auto snapshot = base_snapshot(1);
    const auto room = id<RoomId>("atrium");
    snapshot.environments.push_back(PresentationEnvironment{
        .instance = id<PresentationEnvironmentInstanceId>("rain"),
        .owner = RoomPresentationOwner{room},
        .material_property_owner = PropertyOwnerRef{room},
        .stop_key = id<PresentationEnvironmentStopKey>("rain-stop"),
        .asset = std::nullopt,
        .visual = compiled::AnimationVisual{id<AnimationId>("rain-animation"), std::nullopt},
        .material = id<core::MaterialId>("environment-material"),
        .bounds = {0.0, 0.0, 1.0, 1.0},
        .plane = PresentationPlane::WorldBackground,
        .order = 0,
        .clock = LayoutClockDomain::UnscaledPresentation,
        .scroll_per_second = {0.0, 0.0},
        .opacity = 1.0,
        .visible = true,
    });

    REQUIRE(backend.reconcile(snapshot, {640.0f, 360.0f}));
    RuntimeClockUpdate clock;
    clock.gameplay_time = std::chrono::milliseconds{1000};
    clock.unscaled_presentation_time = std::chrono::milliseconds{2000};
    backend.realize(clock);
    REQUIRE(backend.frame());
    REQUIRE(backend.frame()->base_world_composition_batch.commands().size() == 1);
    CHECK(backend.frame()->base_world_composition_batch.commands().front().texture.handle == 21);

    // Only the selected unscaled presentation clock advances this occurrence.
    clock.gameplay_time += std::chrono::milliseconds{500};
    backend.realize(clock);
    CHECK(backend.frame()->base_world_composition_batch.commands().front().texture.handle == 21);
    clock.unscaled_presentation_time += std::chrono::milliseconds{75};
    backend.realize(clock);
    CHECK(backend.frame()->base_world_composition_batch.commands().front().texture.handle == 22);

    SECTION("retained revisions with different motions advance independently")
    {
        std::get<compiled::AnimationVisual>(*snapshot.environments.front().visual).motion =
            id<AnimationMotionId>("splash");
        snapshot.revision = PresentationSnapshotRevision::from_number(2);
        REQUIRE(backend.reconcile(snapshot, {640.0f, 360.0f}));
        backend.realize(clock);
        CHECK(backend.frame()->base_world_composition_batch.commands().front().texture.handle ==
              21);
        clock.unscaled_presentation_time += std::chrono::milliseconds{75};
        backend.realize(clock);
        REQUIRE(backend.frame(PresentationSnapshotRevision::from_number(1)));
        CHECK(backend.frame(PresentationSnapshotRevision::from_number(1))
                  ->base_world_composition_batch.commands()
                  .front()
                  .texture.handle == 21);
        CHECK(backend.frame()->base_world_composition_batch.commands().front().texture.handle ==
              22);
        clock.unscaled_presentation_time += std::chrono::milliseconds{25};
        backend.realize(clock);
        CHECK(backend.frame()->base_world_composition_batch.commands().front().texture.handle ==
              22);
        std::get<compiled::AnimationVisual>(*snapshot.environments.front().visual).motion.reset();
        snapshot.revision = PresentationSnapshotRevision::from_number(3);
        REQUIRE(backend.reconcile(snapshot, {640.0f, 360.0f}));
        backend.realize(clock);
        CHECK(backend.frame()->base_world_composition_batch.commands().front().texture.handle ==
              21);
        clock.unscaled_presentation_time += std::chrono::milliseconds{75};
        backend.realize(clock);
        CHECK(backend.frame()->base_world_composition_batch.commands().front().texture.handle ==
              22);
        return;
    }
    SECTION("prepared publication preserves compatible Animation epochs")
    {
        WorldPresentationBackend prepared(resources);
        snapshot.revision = PresentationSnapshotRevision::from_number(2);
        REQUIRE(prepared.reconcile(snapshot, {640.0f, 360.0f}));
        prepared.preserve_animation_epochs_from(backend);
        backend.swap_prepared(prepared);
        clock.unscaled_presentation_time += std::chrono::milliseconds{25};
        backend.realize(clock);
        CHECK(backend.frame()->base_world_composition_batch.commands().front().texture.handle ==
              22);
        return;
    }
    SECTION("ordinary republication and reconstruction") {}

    // An unrelated snapshot publication keeps the stable occurrence epoch and therefore its phase.
    snapshot.revision = PresentationSnapshotRevision::from_number(2);
    REQUIRE(backend.reconcile(snapshot, {640.0f, 360.0f}));
    clock.unscaled_presentation_time += std::chrono::milliseconds{25};
    backend.realize(clock);
    CHECK(backend.frame()->base_world_composition_batch.commands().front().texture.handle == 22);

    // A second occurrence sharing the same Animation starts from its own local epoch.
    auto second = snapshot.environments.front();
    second.instance = id<PresentationEnvironmentInstanceId>("rain-second");
    second.stop_key = id<PresentationEnvironmentStopKey>("rain-second-stop");
    second.order = 1;
    snapshot.environments.push_back(std::move(second));
    snapshot.revision = PresentationSnapshotRevision::from_number(3);
    REQUIRE(backend.reconcile(snapshot, {640.0f, 360.0f}));
    clock.unscaled_presentation_time += std::chrono::milliseconds{25};
    backend.realize(clock);
    REQUIRE(backend.frame()->base_world_composition_batch.commands().size() == 2);
    CHECK(backend.frame()->base_world_composition_batch.commands()[0].texture.handle == 22);
    CHECK(backend.frame()->base_world_composition_batch.commands()[1].texture.handle == 21);

    // Reconstruction is intentionally a fresh playback realization.
    backend.reset();
    snapshot.revision = PresentationSnapshotRevision::from_number(4);
    REQUIRE(backend.reconcile(snapshot, {640.0f, 360.0f}));
    backend.realize(clock);
    REQUIRE(backend.frame()->base_world_composition_batch.commands().size() == 2);
    CHECK(backend.frame()->base_world_composition_batch.commands()[0].texture.handle == 21);
    CHECK(backend.frame()->base_world_composition_batch.commands()[1].texture.handle == 21);
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
                              std::nullopt,
                              id<AssetId>("prop"),
                              std::nullopt,
                              {},
                              {},
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
         std::nullopt,
         id<PresentationEnvironmentStopKey>("weather"),
         std::nullopt,
         std::nullopt,
         id<core::MaterialId>("rain"),
         {},
         {},
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
    CHECK(backend.frame()->world_composition_batch.commands().empty());
    REQUIRE(backend.frame()->world_overlay_batches.size() == 1);
    CHECK(backend.frame()->world_overlay_batches.front().order == 0);
    REQUIRE(backend.frame()->world_overlay_batches.front().batch.commands().size() == 1);
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

TEST_CASE("automatic speaking and blink animation phase is disposable and reconstructible")
{
    FakeWorldResources resources;
    resources.add_texture("pose", 1, 640, 960);
    resources.add_texture("expression", 2, 640, 960);
    WorldPresentationBackend backend(resources);
    auto snapshot = base_snapshot(1);
    auto value = actor(ActorPresentationKey{CharacterActorKey{id<CharacterId>("hero")}});
    value.animation_clips = {
        {id<CharacterAnimationClipId>("speaking"),
         LayoutClockDomain::Gameplay,
         {{50,
           {{id<CharacterPresentationLayerId>("face"),
             {},
             {true, id<core::MaterialId>("mouth-open")},
             {},
             {},
             std::nullopt,
             std::nullopt,
             std::nullopt,
             std::nullopt}}},
          {50,
           {{id<CharacterPresentationLayerId>("face"),
             {},
             {true, id<core::MaterialId>("mouth-closed")},
             {},
             {},
             std::nullopt,
             std::nullopt,
             std::nullopt,
             std::nullopt}}}}},
        {id<CharacterAnimationClipId>("blink"),
         LayoutClockDomain::Gameplay,
         {{50,
           {{id<CharacterPresentationLayerId>("face"),
             {},
             {true, id<core::MaterialId>("eyes-closed")},
             {},
             {},
             std::nullopt,
             std::nullopt,
             std::nullopt,
             std::nullopt}}}}},
    };
    value.automatic_animations.speaking =
        compiled::CharacterAutomaticSpeaking{id<CharacterAnimationClipId>("speaking"), "face"};
    value.automatic_animations.blink =
        compiled::CharacterAutomaticBlink{id<CharacterAnimationClipId>("blink"), "face", 100};
    value.speaking = true;
    snapshot.actors.push_back(value);

    REQUIRE(backend.reconcile(snapshot, {1000.0f, 500.0f}));
    RuntimeClockUpdate clock;
    clock.gameplay_time = std::chrono::milliseconds{1000};
    backend.realize(clock);
    REQUIRE(backend.frame());
    REQUIRE(backend.frame()->batch.commands().size() == 2);
    CHECK(backend.frame()->batch.commands()[1].material.value() == "mouth-open");

    clock.gameplay_time += std::chrono::milliseconds{60};
    backend.realize(clock);
    CHECK(backend.frame()->batch.commands()[1].material.value() == "mouth-closed");

    backend.reset();
    REQUIRE(backend.reconcile(snapshot, {1000.0f, 500.0f}));
    clock.gameplay_time += std::chrono::seconds{10};
    backend.realize(clock);
    CHECK(backend.frame()->batch.commands()[1].material.value() == "mouth-open");

    snapshot.actors.front().speaking = false;
    backend.reset();
    REQUIRE(backend.reconcile(snapshot, {1000.0f, 500.0f}));
    clock.gameplay_time += std::chrono::seconds{10};
    backend.realize(clock);
    CHECK(backend.frame()->batch.commands()[1].material.value() == "expression-material");
    clock.gameplay_time += std::chrono::milliseconds{100};
    backend.realize(clock);
    CHECK(backend.frame()->batch.commands()[1].material.value() == "eyes-closed");
}

TEST_CASE("world transition composition contains only world presentation draws")
{
    FakeWorldResources resources;
    WorldPresentationBackend backend(resources);

    auto snapshot = base_snapshot();
    snapshot.background = PresentationBackground{.asset = std::nullopt,
                                                 .color = std::string{"#204060"},
                                                 .fit = compiled::BackgroundFit::Cover,
                                                 .material = std::nullopt};
    REQUIRE(backend.reconcile(snapshot, {1000.0f, 500.0f}));
    REQUIRE(backend.frame());
    REQUIRE(backend.frame()->batch.commands().size() == 1);
    REQUIRE(backend.frame()->world_composition_batch.commands().size() == 1);
    CHECK(backend.frame()->game_ui_underlay_batch.commands().empty());
    CHECK(backend.frame()->world_composition_batch.commands().front().layer ==
          GameLayer::Background);
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

TEST_CASE(
    "retaining transition revisions never prunes the active world frame used by hotspot hover")
{
    FakeWorldResources resources;
    resources.add_texture("room-image", 17, 100, 100);
    WorldPresentationBackend backend(resources);
    WorldHotspotController controller(backend);

    auto snapshot = base_snapshot();
    snapshot.background = PresentationBackground{.asset = id<AssetId>("room-image"),
                                                 .fit = compiled::BackgroundFit::Stretch};
    const compiled::HotspotRef hotspot_ref =
        compiled::RoomHotspotRef{id<RoomId>("room"), id<HotspotId>("desk")};
    snapshot.hotspots.push_back({hotspot_ref, "Desk", true, true, semantic_target("desk"),
                                 compiled::NormalizedRect{0.0, 0.0, 1.0, 1.0}, 0,
                                 compiled::DefaultHotspotHighlight{}, id<AssetId>("room-image"),
                                 100, 100});

    REQUIRE(backend.reconcile(snapshot, {100.0f, 100.0f}));
    backend.retain_only({});
    REQUIRE(backend.snapshot(snapshot.revision));
    REQUIRE(backend.frame(snapshot.revision));

    controller.presentation_changed();
    const auto hovered = controller.handle(
        {WorldPointerEventKind::MouseMove, {50.0f, 50.0f}, {50.0f, 50.0f}, 0, false, true});
    REQUIRE(hovered.hovered);
    CHECK(*hovered.hovered == hotspot_ref);

    REQUIRE(backend.frame());
    REQUIRE(backend.frame()->world_composition_batch.commands().size() ==
            backend.frame()->base_world_composition_batch.commands().size() + 1);
    const auto& overlay = backend.frame()->world_composition_batch.commands().back();
    CHECK(overlay.hotspot_hovered);
    CHECK_FALSE(overlay.hotspot_pressed);
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
         true, semantic_target("hidden"), compiled::NormalizedRect{0, 0, 1, 1}, 0,
         compiled::NoHotspotHighlight{}, id<AssetId>("room-image"), 1600, 900, std::nullopt,
         std::nullopt, PresentationPlane::WorldBackground, 0});

    REQUIRE(backend.reconcile(snapshot, {1000.0f, 500.0f}));
    REQUIRE(backend.frame());
    CHECK(backend.frame()->hotspot_surfaces.empty());
    CHECK(resources.hotspot_resolve_calls == 0);
}

TEST_CASE("Interactable hotspot overlays inherit placement geometry and authored Material")
{
    FakeWorldResources resources;
    resources.add_texture("item", 23, 400, 200);
    resources.set_alpha_coverage("item", {.width = 400,
                                          .height = 200,
                                          .row_stride_bytes = 50,
                                          .occupancy_bits = std::vector<std::uint8_t>(10000, 255)});
    WorldPresentationBackend backend(resources);
    auto snapshot = base_snapshot();
    snapshot.interactables.push_back({id<InteractableInstanceId>("key"),
                                      {id<RoomId>("room"), id<RoomPlacementId>("table")},
                                      {0.25, 0.4, 0.3, 0.2},
                                      compiled::ImageVisual{id<AssetId>("item")},
                                      std::nullopt,
                                      std::nullopt,
                                      {},
                                      PresentationPlane::WorldContent,
                                      12,
                                      true,
                                      true});
    const compiled::HotspotRef hotspot_ref = compiled::InteractableHotspotRef{
        id<InteractableInstanceId>("key"), id<HotspotId>("inspect")};
    snapshot.hotspots.push_back(
        {hotspot_ref, "Inspect", true, true, semantic_target("inspect"), AlphaHotspotShape{}, 0,
         compiled::MaterialHotspotHighlight{id<core::MaterialId>("custom-highlight")},
         id<AssetId>("item"), 400, 200,
         compiled::RoomPlacementRef{id<RoomId>("room"), id<RoomPlacementId>("table")},
         compiled::NormalizedRect{0.25, 0.4, 0.3, 0.2}, PresentationPlane::WorldContent, 12});
    snapshot.hotspots.back().material_parameters.push_back(
        {"u_glow", compiled::MaterialParameterValue{0.75}, std::nullopt,
         MaterialClockPolicy::Gameplay});
    snapshot.hotspots.back().material_texture_overrides.push_back(
        {"s_noise", "project:/assets/noise.png"});

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
    REQUIRE(overlay.command.material_texture_overrides.size() == 1);
    CHECK(overlay.command.material_texture_overrides.front().name == "s_noise");
    CHECK(overlay.command.material_texture_overrides.front().source == "project:/assets/noise.png");
    REQUIRE(overlay.command.material_uniform_overrides.size() == 1);
    CHECK(overlay.command.material_uniform_overrides.front().name == "u_glow");
    CHECK(std::get<float>(overlay.command.material_uniform_overrides.front().value) ==
          Catch::Approx(0.75f));
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
         semantic_target("desk"), compiled::NormalizedRect{0, 0, 1, 1}, 0,
         compiled::DefaultHotspotHighlight{}, id<AssetId>("room-image"), 1600, 900, std::nullopt,
         std::nullopt, PresentationPlane::WorldBackground, 0});
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
    snapshot.interactables.push_back({id<InteractableInstanceId>("item"),
                                      {id<RoomId>("room"), id<RoomPlacementId>("item-place")},
                                      {0.4, 0.4, 0.2, 0.2},
                                      compiled::ImageVisual{id<AssetId>("item")},
                                      std::nullopt,
                                      std::nullopt,
                                      {},
                                      PresentationPlane::WorldContent,
                                      0,
                                      true,
                                      true});
    const compiled::HotspotRef room_low =
        compiled::RoomHotspotRef{id<RoomId>("room"), id<HotspotId>("low")};
    const compiled::HotspotRef room_high =
        compiled::RoomHotspotRef{id<RoomId>("room"), id<HotspotId>("high")};
    const compiled::HotspotRef item = compiled::InteractableHotspotRef{
        id<InteractableInstanceId>("item"), id<HotspotId>("item-hotspot")};
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

TEST_CASE("world hotspot hover carries cursor intent and recomputes it for a stationary pointer")
{
    FakeWorldResources resources;
    resources.add_texture("room-image", 17, 100, 100);
    WorldPresentationBackend backend(resources);
    WorldHotspotController controller(backend);
    auto snapshot = base_snapshot();
    snapshot.background = PresentationBackground{.asset = id<AssetId>("room-image"),
                                                 .fit = compiled::BackgroundFit::Stretch};
    const compiled::HotspotRef hotspot =
        compiled::RoomHotspotRef{id<RoomId>("room"), id<HotspotId>("desk")};
    snapshot.hotspots.push_back(
        {.ref = hotspot,
         .label = "Desk",
         .condition_eligible = true,
         .target_available = true,
         .target = semantic_target("desk"),
         .shape = compiled::NormalizedRect{0.0, 0.0, 1.0, 1.0},
         .input_order = 0,
         .highlight = compiled::NoHotspotHighlight{},
         .source_image = id<AssetId>("room-image"),
         .source_width = 100,
         .source_height = 100,
         .cursor = compiled::CursorTarget{compiled::CursorTargetKind::Named,
                                          compiled::CursorSystemName::Default, "inspect"}});

    REQUIRE(backend.reconcile(snapshot, {100.0f, 100.0f}));
    controller.presentation_changed();
    (void)controller.handle(
        {WorldPointerEventKind::MouseMove, {50.0f, 50.0f}, {50.0f, 50.0f}, 0, false, true});
    REQUIRE(controller.hovered_target());
    REQUIRE(controller.hovered_target()->cursor);
    CHECK(controller.hovered_target()->cursor->kind == compiled::CursorTargetKind::Named);
    CHECK(controller.hovered_target()->cursor->named_id == "inspect");
    const auto hovered_observation = controller.debug_observation();
    CHECK(hovered_observation.last_mouse_valid);
    CHECK(hovered_observation.last_mouse_reference.x == 50.0f);
    CHECK(hovered_observation.last_mouse_reference.y == 50.0f);
    REQUIRE(hovered_observation.under_pointer);
    CHECK(world_hotspot_identity(*hovered_observation.under_pointer) == "room/room/hotspot/desk");
    REQUIRE(hovered_observation.hovered);
    CHECK(world_hotspot_identity(*hovered_observation.hovered) == "room/room/hotspot/desk");
    CHECK_FALSE(hovered_observation.capture_active);

    auto replacement = snapshot;
    replacement.revision = PresentationSnapshotRevision::from_number(2);
    replacement.hotspots.front().cursor = compiled::CursorTarget{
        compiled::CursorTargetKind::System, compiled::CursorSystemName::Text, {}};
    REQUIRE(backend.reconcile(replacement, {100.0f, 100.0f}));
    controller.presentation_changed();
    REQUIRE(controller.hovered_target());
    REQUIRE(controller.hovered_target()->cursor);
    CHECK(controller.hovered_target()->cursor->kind == compiled::CursorTargetKind::System);
    CHECK(controller.hovered_target()->cursor->system == compiled::CursorSystemName::Text);

    replacement.revision = PresentationSnapshotRevision::from_number(3);
    replacement.hotspots.clear();
    REQUIRE(backend.reconcile(replacement, {100.0f, 100.0f}));
    controller.presentation_changed();
    CHECK(controller.hovered_target() == nullptr);
    CHECK_FALSE(controller.debug_observation().under_pointer);

    (void)controller.handle(
        {WorldPointerEventKind::Cancel, {50.0f, 50.0f}, {50.0f, 50.0f}, 0, false, false});
    CHECK(controller.hovered_target() == nullptr);
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

TEST_CASE("animated visual-alpha follows the realized frame without a new snapshot")
{
    FakeWorldResources resources;
    resources.add_texture("rain-a", 21, 2, 1);
    resources.add_texture("rain-b", 22, 2, 1);
    resources.set_alpha_coverage(
        "rain-a", {.width = 2, .height = 1, .row_stride_bytes = 1, .occupancy_bits = {0b01}});
    resources.set_alpha_coverage(
        "rain-b", {.width = 2, .height = 1, .row_stride_bytes = 1, .occupancy_bits = {0b10}});
    WorldPresentationBackend backend(resources);
    WorldHotspotController controller(backend);
    auto snapshot = base_snapshot();
    snapshot.interactables.push_back(
        {id<InteractableInstanceId>("rain"),
         {id<RoomId>("room"), id<RoomPlacementId>("place")},
         {0, 0, 1, 1},
         compiled::AnimationVisual{id<AnimationId>("rain-animation"), std::nullopt}});
    const compiled::HotspotRef alpha = compiled::InteractableHotspotRef{
        id<InteractableInstanceId>("rain"), id<HotspotId>("alpha")};
    snapshot.hotspots.push_back({alpha, "Rain", true, true, semantic_target("rain"),
                                 AlphaHotspotShape{}, 0, compiled::DefaultHotspotHighlight{},
                                 std::nullopt, 64, 32});
    snapshot.interactables.front().occurrence = id<RoomInteractableEntryId>("first");
    snapshot.hotspots.front().interactable_occurrence = snapshot.interactables.front().occurrence;
    snapshot.hotspots.front().interactable_placement = snapshot.interactables.front().placement;
    REQUIRE(backend.reconcile(snapshot, {100, 100}));
    const auto hit = [&](float x) {
        return controller
            .handle({WorldPointerEventKind::MouseMove, {x, 50}, {x, 50}, 0, false, true})
            .hit;
    };
    RuntimeClockUpdate clock;
    backend.realize(clock);
    CHECK(hit(25));
    CHECK_FALSE(hit(75));
    CHECK(hit(25));
    REQUIRE(controller.hovered_target());
    clock.gameplay_time = std::chrono::milliseconds{75};
    backend.realize(clock);
    controller.realization_changed();
    CHECK(controller.hovered_target() == nullptr);
    CHECK_FALSE(hit(25));
    CHECK(hit(75));
    CHECK(backend.frame()->revision == snapshot.revision);
    CHECK(backend.frame()->base_batch.commands().front().texture.handle == 22);
    CHECK(backend.frame()->hotspot_surfaces.front().overlay.command.texture.handle == 22);
    snapshot.revision = PresentationSnapshotRevision::from_number(2);
    REQUIRE(backend.reconcile(snapshot, {100, 100}));
    backend.realize(clock);
    CHECK(hit(75));
    CHECK_FALSE(hit(25));

    auto second = snapshot.interactables.front();
    second.occurrence = id<RoomInteractableEntryId>("second");
    second.bounds = {0, 0, 0.2, 1};
    snapshot.interactables.push_back(second);
    auto second_hotspot = snapshot.hotspots.front();
    second_hotspot.interactable_occurrence = second.occurrence;
    snapshot.hotspots.push_back(second_hotspot);
    snapshot.revision = PresentationSnapshotRevision::from_number(3);
    REQUIRE(backend.reconcile(snapshot, {100, 100}));
    backend.realize(clock);
    REQUIRE(backend.frame()->draws.size() == 2);
    CHECK(backend.frame()->draws[0].stable_identity != backend.frame()->draws[1].stable_identity);
    CHECK(backend.frame()->base_batch.commands()[0].texture.handle == 22);
    CHECK(backend.frame()->base_batch.commands()[1].texture.handle == 21);
    CHECK(hit(5));
    CHECK(backend.frame()->batch.commands().back().rect.width == Catch::Approx(20));
    CHECK_FALSE(hit(15));
    CHECK(hit(75));
    REQUIRE(controller.handle({WorldPointerEventKind::MouseDown, {75, 50}, {75, 50}, 0, true, true})
                .consumed);
    const auto first_release =
        controller.handle({WorldPointerEventKind::MouseUp, {75, 50}, {75, 50}, 0, true, true});
    REQUIRE(first_release.target);
    REQUIRE(first_release.trigger_context);
    CHECK(first_release.trigger_context->source_bounds->width == Catch::Approx(1));
    REQUIRE(controller.handle({WorldPointerEventKind::MouseDown, {5, 50}, {5, 50}, 0, true, true})
                .consumed);
    const auto second_release =
        controller.handle({WorldPointerEventKind::MouseUp, {5, 50}, {5, 50}, 0, true, true});
    REQUIRE(second_release.target);
    REQUIRE(second_release.trigger_context);
    CHECK(second_release.trigger_context->source_bounds->width == Catch::Approx(0.2));
}

TEST_CASE(
    "visual-alpha fails explicitly without retained coverage while custom geometry stays usable")
{
    FakeWorldResources resources;
    resources.add_texture("item", 23, 2, 1);
    WorldPresentationBackend backend(resources);
    auto snapshot = base_snapshot();
    snapshot.interactables.push_back({id<InteractableInstanceId>("item"),
                                      {id<RoomId>("room"), id<RoomPlacementId>("place")},
                                      {0, 0, 1, 1},
                                      compiled::ImageVisual{id<AssetId>("item")}});
    snapshot.hotspots.push_back({compiled::InteractableHotspotRef{
                                     id<InteractableInstanceId>("item"), id<HotspotId>("alpha")},
                                 "Item", true, true, semantic_target("item"), AlphaHotspotShape{},
                                 0, compiled::NoHotspotHighlight{}, id<AssetId>("item"), 2, 1});
    SECTION("a Visual with no realized raster sample fails rather than becoming a rectangle")
    {
        snapshot.interactables.front().visual.reset();
    }
    SECTION("an Image without CPU coverage fails") {}
    auto failed = backend.reconcile(snapshot, {100, 100});
    REQUIRE_FALSE(failed);
    CHECK(failed.error().front().code == "presentation.visual_alpha_coverage_unavailable");
    snapshot.interactables.front().visual = compiled::ImageVisual{id<AssetId>("item")};
    snapshot.hotspots.front().shape = compiled::NormalizedRect{0, 0, 1, 1};
    SECTION("custom rectangles do not require alpha coverage") {}
    SECTION("highlight source capability does not gate custom hit geometry")
    {
        snapshot.interactables.front().visual.reset();
        snapshot.interactables.front().material = id<core::MaterialId>("panel");
        snapshot.hotspots.front().highlight = compiled::DefaultHotspotHighlight{};
    }
    REQUIRE(backend.reconcile(snapshot, {100, 100}));
    WorldHotspotController controller(backend);
    CHECK(controller.handle({WorldPointerEventKind::MouseMove, {25, 50}, {25, 50}, 0, false, true})
              .hit);
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
    snapshot.interactables.push_back({id<InteractableInstanceId>("item"),
                                      {id<RoomId>("room"), id<RoomPlacementId>("item-place")},
                                      {0.0, 0.0, 1.0, 1.0},
                                      compiled::ImageVisual{id<AssetId>("item")},
                                      std::nullopt,
                                      std::nullopt,
                                      {},
                                      PresentationPlane::WorldContent,
                                      0,
                                      true,
                                      true});
    const compiled::HotspotRef alpha = compiled::InteractableHotspotRef{
        id<InteractableInstanceId>("item"), id<HotspotId>("alpha")};
    snapshot.hotspots.push_back(
        {alpha, "Alpha", true, true, semantic_target("alpha"), AlphaHotspotShape{}, 0,
         compiled::NoHotspotHighlight{}, id<AssetId>("item"), 2, 1,
         compiled::RoomPlacementRef{id<RoomId>("room"), id<RoomPlacementId>("item-place")},
         compiled::NormalizedRect{0.0, 0.0, 1.0, 1.0}, PresentationPlane::WorldContent, 0});
    REQUIRE(backend.reconcile(snapshot, {100.0f, 100.0f}));
    controller.presentation_changed();

    const auto transparent = controller.handle(
        {WorldPointerEventKind::MouseDown, {25.0f, 50.0f}, {25.0f, 50.0f}, 0, true, true});
    CHECK_FALSE(transparent.consumed);
    CHECK(transparent.hit_test_performed);
    CHECK_FALSE(transparent.hit);
    const auto opaque = controller.handle(
        {WorldPointerEventKind::MouseDown, {75.0f, 50.0f}, {75.0f, 50.0f}, 0, true, true});
    CHECK(opaque.consumed);
    CHECK(opaque.hit_test_performed);
    REQUIRE(opaque.hit);
    CHECK(*opaque.hit == alpha);
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
    controller.realization_changed();
    CHECK_FALSE(controller.hovered_target());
    REQUIRE(
        controller
            .handle(
                {WorldPointerEventKind::MouseMove, {19.0f, 10.0f}, {19.0f, 10.0f}, 0, true, true})
            .consumed);
    controller.realization_changed();
    CHECK_FALSE(controller.hovered_target());
    CHECK(backend.frame()->batch.commands().size() == 1);
    auto canceled = controller.handle(
        {WorldPointerEventKind::MouseUp, {19.0f, 10.0f}, {19.0f, 10.0f}, 0, true, true});
    CHECK(canceled.consumed);
    CHECK(canceled.hit_test_performed);
    REQUIRE(canceled.hit);
    CHECK(*canceled.hit == hotspot);
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
    const auto blocked_move = controller.handle(
        {WorldPointerEventKind::MouseMove, {10.0f, 10.0f}, {10.0f, 10.0f}, 0, true, false});
    CHECK_FALSE(blocked_move.hit_test_performed);
    CHECK_FALSE(blocked_move.hit);
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

    REQUIRE(
        controller
            .handle(
                {WorldPointerEventKind::TouchDown, {20.0f, 20.0f}, {20.0f, 20.0f}, 3, true, true})
            .consumed);
    REQUIRE(
        controller
            .handle(
                {WorldPointerEventKind::TouchMove, {40.0f, 20.0f}, {40.0f, 20.0f}, 3, true, true})
            .consumed);
    const auto canceled_touch_release = controller.handle(
        {WorldPointerEventKind::TouchUp, {40.0f, 20.0f}, {40.0f, 20.0f}, 3, true, true});
    CHECK(canceled_touch_release.consumed);
    CHECK_FALSE(canceled_touch_release.hit_test_performed);
    CHECK_FALSE(canceled_touch_release.hit);
    CHECK_FALSE(canceled_touch_release.target);
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
