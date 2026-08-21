#include "noveltea/core/compiled_project_codec.hpp"
#include "noveltea/core/property_resolver.hpp"
#include "noveltea/core/session_state.hpp"
#include "noveltea/runtime/runtime_world.hpp"

#include <catch2/catch_test_macros.hpp>
#include <nlohmann/json.hpp>

#include <fstream>
#include <iterator>
#include <string>
#include <string_view>
#include <utility>

namespace noveltea::runtime {
namespace {

template<class Id> Id id(std::string value)
{
    auto result = Id::create(std::move(value));
    REQUIRE(result);
    return std::move(result).value();
}

core::CompiledProject load_fixture(std::string_view filename)
{
    std::ifstream input(std::string(NOVELTEA_SOURCE_DIR) +
                        "/editor/src/renderer/test/fixtures/compiled-project-golden/" +
                        std::string(filename));
    REQUIRE(input.good());
    const std::string source((std::istreambuf_iterator<char>(input)),
                             std::istreambuf_iterator<char>());
    auto document = nlohmann::json::parse(source, nullptr, false);
    REQUIRE_FALSE(document.is_discarded());
    auto decoded = core::decode_compiled_project(document, std::string(filename));
    REQUIRE(decoded);
    return std::move(decoded).value();
}

TEST_CASE("runtime world resolves declared gameplay instances without owning definitions")
{
    const auto project = load_fixture("comprehensive.json");
    auto state_result = core::SessionState::create(project);
    REQUIRE(state_result);
    auto state = std::move(state_result).value();
    RuntimeWorld world(project, state);

    const auto start = id<core::RoomId>("start");
    const auto hero = id<core::CharacterId>("hero");
    const auto key = id<core::InteractableId>("key");

    CHECK(world.resolved_configuration(start) == project.find_room(start));
    CHECK(world.resolved_configuration(hero) == project.find_character(hero));
    CHECK(world.resolved_configuration(key) == project.find_interactable(key));
    CHECK(world.resolved_configuration(id<core::RoomId>("missing")) == nullptr);
    CHECK(world.resolved_configuration(id<core::CharacterId>("missing")) == nullptr);
    CHECK(world.resolved_configuration(id<core::InteractableId>("missing")) == nullptr);

    REQUIRE(world.character_state(hero) != nullptr);
    REQUIRE(world.interactable_state(key) != nullptr);
    CHECK(world.character_state(hero) == state.character_world(hero));
    CHECK(world.interactable_state(key) == state.interactable(key));
}

TEST_CASE("runtime world mutates declared gameplay instance state without mutating definitions")
{
    const auto project = load_fixture("comprehensive.json");
    auto state_result = core::SessionState::create(project);
    REQUIRE(state_result);
    auto state = std::move(state_result).value();
    RuntimeWorld world(project, state);

    const auto hero = id<core::CharacterId>("hero");
    const auto key = id<core::InteractableId>("key");
    const auto hall = id<core::RoomId>("hall");
    const auto coin_placement = id<core::RoomPlacementId>("coin-placement");

    const auto* hero_definition = world.resolved_configuration(hero);
    const auto* key_definition = world.resolved_configuration(key);
    REQUIRE(hero_definition != nullptr);
    REQUIRE(key_definition != nullptr);
    CHECK(hero_definition->initial_world_state.visible);
    CHECK(key_definition->initial_state.visible);

    REQUIRE(world.set_character_visible(hero, false));
    REQUIRE(world.set_interactable_visible(key, false));
    REQUIRE(world.move_interactable(key, core::compiled::RoomPlacementRef{hall, coin_placement}));

    REQUIRE(world.character_state(hero) != nullptr);
    REQUIRE(world.interactable_state(key) != nullptr);
    CHECK_FALSE(world.character_state(hero)->visible);
    CHECK_FALSE(world.interactable_state(key)->visible);
    const auto* moved =
        std::get_if<core::compiled::RoomPlacementRef>(&world.interactable_state(key)->location);
    REQUIRE(moved != nullptr);
    CHECK(moved->room == hall);
    CHECK(moved->placement_id == coin_placement);

    CHECK(hero_definition->initial_world_state.visible);
    CHECK(key_definition->initial_state.visible);
    CHECK(world.resolved_configuration(hero) == hero_definition);
    CHECK(world.resolved_configuration(key) == key_definition);
}

TEST_CASE(
    "runtime world resolves gameplay instance properties through current configuration semantics")
{
    const auto project = load_fixture("inheritance-properties-localization.json");
    auto state_result = core::SessionState::create(project);
    REQUIRE(state_result);
    auto state = std::move(state_result).value();
    RuntimeWorld world(project, state);

    const auto hall = id<core::RoomId>("hall");
    const auto tower = id<core::RoomId>("tower");
    const auto visit_count = id<core::PropertyId>("visit-count");

    const auto inherited = world.resolve_property(tower, visit_count);
    REQUIRE(inherited);
    REQUIRE(inherited.value_if() != nullptr);
    const auto* inherited_value = std::get_if<core::RuntimeValue>(inherited.value_if());
    REQUIRE(inherited_value != nullptr);
    REQUIRE(std::get_if<std::int64_t>(inherited_value) != nullptr);
    CHECK(*std::get_if<std::int64_t>(inherited_value) == 7);

    core::PropertyResolver properties(project, state);
    REQUIRE(properties.set(core::PropertyOwnerRef{hall}, visit_count,
                           core::RuntimeValue{std::int64_t{11}}));
    const auto overridden = world.resolve_property(tower, visit_count);
    REQUIRE(overridden);
    REQUIRE(overridden.value_if() != nullptr);
    const auto* overridden_value = std::get_if<core::RuntimeValue>(overridden.value_if());
    REQUIRE(overridden_value != nullptr);
    REQUIRE(std::get_if<std::int64_t>(overridden_value) != nullptr);
    CHECK(*std::get_if<std::int64_t>(overridden_value) == 11);

    const auto missing = world.resolve_property(id<core::RoomId>("missing"), visit_count);
    REQUIRE_FALSE(missing);
    CHECK(missing.error().front().code == "runtime.unknown_property_owner");
}

} // namespace
} // namespace noveltea::runtime
