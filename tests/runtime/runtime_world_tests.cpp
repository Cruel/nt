#include "noveltea/core/compiled_project_codec.hpp"
#include "noveltea/core/property_resolver.hpp"
#include "noveltea/core/session_state.hpp"
#include "noveltea/runtime/runtime_world.hpp"
#include "../runtime_test_services.hpp"

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

nlohmann::json load_fixture_document(std::string_view filename)
{
    std::ifstream input(std::string(NOVELTEA_SOURCE_DIR) +
                        "/editor/src/renderer/test/fixtures/compiled-project-golden/" +
                        std::string(filename));
    REQUIRE(input.good());
    const std::string source((std::istreambuf_iterator<char>(input)),
                             std::istreambuf_iterator<char>());
    auto document = nlohmann::json::parse(source, nullptr, false);
    REQUIRE_FALSE(document.is_discarded());
    return document;
}

core::CompiledProject decode_fixture(nlohmann::json document, std::string_view filename)
{
    auto decoded = core::decode_compiled_project(document, std::string(filename));
    REQUIRE(decoded);
    return std::move(decoded).value();
}

core::CompiledProject load_fixture(std::string_view filename)
{
    return decode_fixture(load_fixture_document(filename), filename);
}

core::CompiledProject load_fixture_with_runtime_archetypes()
{
    auto document = load_fixture_document("comprehensive.json");
    auto room = document["definitions"]["rooms"][0];
    room.erase("id");
    auto character = document["definitions"]["characters"][0];
    character.erase("id");
    character.erase("initialWorldState");
    auto interactable = document["definitions"]["interactables"][0];
    interactable.erase("id");
    interactable.erase("initialState");
    document["archetypes"] = nlohmann::json::array(
        {{{"id", "runtime-room"}, {"instanceKind", "room"}, {"configuration", room}},
         {{"id", "runtime-character"}, {"instanceKind", "character"}, {"configuration", character}},
         {{"id", "runtime-interactable"},
          {"instanceKind", "interactable"},
          {"configuration", interactable}}});
    return decode_fixture(std::move(document), "comprehensive-runtime-archetypes.json");
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

    REQUIRE(world.resolved_configuration(start) != nullptr);
    REQUIRE(world.resolved_configuration(hero) != nullptr);
    REQUIRE(world.resolved_configuration(key) != nullptr);
    CHECK(world.resolved_configuration(start)->display_name ==
          project.find_room(start)->display_name);
    CHECK(world.resolved_configuration(hero)->display_name ==
          project.find_character(hero)->display_name);
    CHECK(world.resolved_configuration(key)->display_name ==
          project.find_interactable(key)->display_name);
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

    const auto* hero_definition = world.resolved_configuration(hero);
    const auto* key_definition = world.resolved_configuration(key);
    REQUIRE(hero_definition != nullptr);
    REQUIRE(key_definition != nullptr);
    CHECK(hero_definition->initial_world_state.visible);
    CHECK(key_definition->initial_state.visible);

    REQUIRE(world.set_character_visible(hero, false));
    REQUIRE(world.set_interactable_visible(key, false));
    REQUIRE(world.move_interactable(key, core::compiled::RoomLocation{hall}));

    REQUIRE(world.character_state(hero) != nullptr);
    REQUIRE(world.interactable_state(key) != nullptr);
    CHECK_FALSE(world.character_state(hero)->visible);
    CHECK_FALSE(world.interactable_state(key)->visible);
    const auto* moved =
        std::get_if<core::compiled::RoomLocation>(&world.interactable_state(key)->location);
    REQUIRE(moved != nullptr);
    CHECK(moved->room == hall);

    CHECK(hero_definition->initial_world_state.visible);
    CHECK(key_definition->initial_state.visible);
    CHECK(world.resolved_configuration(hero) == hero_definition);
    CHECK(world.resolved_configuration(key) == key_definition);
}

TEST_CASE(
    "runtime world resolves gameplay instance properties through current configuration semantics")
{
    const auto project = load_fixture("trait-properties-localization.json");
    auto state_result = core::SessionState::create(project);
    REQUIRE(state_result);
    auto state = std::move(state_result).value();
    RuntimeWorld world(project, state);

    const auto hall = id<core::RoomId>("hall");
    const auto tower = id<core::RoomId>("tower");
    const auto visit_count = id<core::PropertyId>("visit-count");

    const auto authored = world.resolve_property(tower, visit_count);
    REQUIRE(authored);
    REQUIRE(authored.value_if() != nullptr);
    const auto* authored_value = std::get_if<core::RuntimeValue>(authored.value_if());
    REQUIRE(authored_value != nullptr);
    REQUIRE(std::get_if<std::int64_t>(authored_value) != nullptr);
    CHECK(*std::get_if<std::int64_t>(authored_value) == 3);

    core::PropertyResolver properties(project, state);
    REQUIRE(properties.set(core::PropertyOwnerRef{hall}, visit_count,
                           core::RuntimeValue{std::int64_t{11}}));
    const auto overridden = world.resolve_property(tower, visit_count);
    REQUIRE(overridden);
    REQUIRE(overridden.value_if() != nullptr);
    const auto* overridden_value = std::get_if<core::RuntimeValue>(overridden.value_if());
    REQUIRE(overridden_value != nullptr);
    REQUIRE(std::get_if<std::int64_t>(overridden_value) != nullptr);
    CHECK(*std::get_if<std::int64_t>(overridden_value) == 3);

    const auto missing = world.resolve_property(id<core::RoomId>("missing"), visit_count);
    REQUIRE_FALSE(missing);
    CHECK(missing.error().front().code == "runtime.unknown_property_owner");
}

TEST_CASE("runtime world creates deterministic typed identities from admitted compiled vocabulary")
{
    const auto project = load_fixture_with_runtime_archetypes();
    auto state_result = core::SessionState::create(project);
    REQUIRE(state_result);
    auto state = std::move(state_result).value();
    RuntimeWorld world(project, state);

    auto room =
        world.create_room(ArchetypeInstanceConfiguration{id<core::ArchetypeId>("runtime-room")});
    REQUIRE(room);
    CHECK(room.value().text() == "runtime-room-1");

    auto character = world.create_character(
        CompiledInstanceConfiguration{core::GameplayInstanceRef{id<core::CharacterId>("hero")}});
    REQUIRE(character);
    CHECK(character.value().text() == "runtime-character-2");

    auto interactable = world.create_interactable(
        EffectiveInstanceConfiguration{core::GameplayInstanceRef{id<core::InteractableId>("key")}});
    REQUIRE(interactable);
    CHECK(interactable.value().text() == "runtime-interactable-3");
    CHECK(state.next_runtime_instance_id() == 4);

    const auto* room_provenance = world.provenance(core::GameplayInstanceRef{room.value()});
    const auto* character_provenance =
        world.provenance(core::GameplayInstanceRef{character.value()});
    const auto* interactable_provenance =
        world.provenance(core::GameplayInstanceRef{interactable.value()});
    REQUIRE(room_provenance != nullptr);
    REQUIRE(character_provenance != nullptr);
    REQUIRE(interactable_provenance != nullptr);
    CHECK(room_provenance->kind == core::RuntimeInstanceProvenanceKind::Archetype);
    CHECK(room_provenance->archetype == id<core::ArchetypeId>("runtime-room"));
    CHECK(character_provenance->kind == core::RuntimeInstanceProvenanceKind::CompiledDefinition);
    CHECK(interactable_provenance->kind == core::RuntimeInstanceProvenanceKind::Clone);
}

TEST_CASE("runtime Room overlays clear back to immutable cloned birth configuration")
{
    const auto project = load_fixture_with_runtime_archetypes();
    auto state_result = core::SessionState::create(project);
    REQUIRE(state_result);
    auto state = std::move(state_result).value();
    RuntimeWorld world(project, state);

    const auto hall = id<core::RoomId>("hall");
    const auto start = id<core::RoomId>("start");
    const auto tower = id<core::RoomId>("tower");
    const auto east = id<core::RoomExitId>("east-exit");
    REQUIRE(world.retarget_room_exit(hall, east, start));

    auto clone = world.create_room(EffectiveInstanceConfiguration{core::GameplayInstanceRef{hall}});
    REQUIRE(clone);
    const auto clone_id = clone.value();
    const auto* cloned = world.resolved_configuration(clone_id);
    REQUIRE(cloned != nullptr);
    const auto cloned_east = std::find_if(cloned->exits.begin(), cloned->exits.end(),
                                          [&](const auto& value) { return value.id == east; });
    REQUIRE(cloned_east != cloned->exits.end());
    CHECK(cloned_east->target == start);

    REQUIRE(world.replace_structural_configuration(
        clone_id, CompiledInstanceConfiguration{core::GameplayInstanceRef{tower}}));
    REQUIRE(world.resolved_configuration(clone_id) != nullptr);
    CHECK(world.resolved_configuration(clone_id)->display_name ==
          project.find_room(tower)->display_name);

    REQUIRE(world.clear_structural_configuration(clone_id));
    const auto* revealed = world.resolved_configuration(clone_id);
    REQUIRE(revealed != nullptr);
    CHECK(revealed->display_name == project.find_room(hall)->display_name);
    const auto revealed_east = std::find_if(revealed->exits.begin(), revealed->exits.end(),
                                            [&](const auto& value) { return value.id == east; });
    REQUIRE(revealed_east != revealed->exits.end());
    CHECK(revealed_east->target == start);
}

TEST_CASE("runtime structural replacement rejects dependent inventory invalidation atomically")
{
    const auto project = load_fixture_with_runtime_archetypes();
    auto state_result = core::SessionState::create(project);
    REQUIRE(state_result);
    auto state = std::move(state_result).value();
    RuntimeWorld world(project, state);

    auto owner = world.create_interactable(
        CompiledInstanceConfiguration{core::GameplayInstanceRef{id<core::InteractableId>("key")}});
    auto member = world.create_interactable(
        CompiledInstanceConfiguration{core::GameplayInstanceRef{id<core::InteractableId>("dust")}});
    REQUIRE(owner);
    REQUIRE(member);
    const core::compiled::InventoryRef inventory{
        core::compiled::InteractableInventoryOwner{owner.value()}, id<core::InventoryId>("hidden")};
    REQUIRE(world.move_interactable(member.value(), core::compiled::InventoryLocation{inventory}));

    const auto before = world.resolved_configuration(owner.value())->display_name;
    auto replaced = world.replace_structural_configuration(
        owner.value(),
        CompiledInstanceConfiguration{core::GameplayInstanceRef{id<core::InteractableId>("dust")}});
    REQUIRE_FALSE(replaced);
    CHECK(replaced.error().front().code == "runtime.invalid_structural_edit");
    REQUIRE(world.resolved_configuration(owner.value()) != nullptr);
    CHECK(world.resolved_configuration(owner.value())->display_name == before);
}

TEST_CASE("runtime structural clear rejects dependent invalidation atomically")
{
    const auto project = load_fixture_with_runtime_archetypes();
    auto state_result = core::SessionState::create(project);
    REQUIRE(state_result);
    auto state = std::move(state_result).value();
    RuntimeWorld world(project, state);

    const auto dust = id<core::InteractableId>("dust");
    const auto key = id<core::InteractableId>("key");
    auto owner =
        world.create_interactable(CompiledInstanceConfiguration{core::GameplayInstanceRef{dust}});
    REQUIRE(owner);
    REQUIRE(world.replace_structural_configuration(
        owner.value(), CompiledInstanceConfiguration{core::GameplayInstanceRef{key}}));
    auto member =
        world.create_interactable(CompiledInstanceConfiguration{core::GameplayInstanceRef{dust}});
    REQUIRE(member);
    const core::compiled::InventoryRef inventory{
        core::compiled::InteractableInventoryOwner{owner.value()}, id<core::InventoryId>("hidden")};
    REQUIRE(world.move_interactable(member.value(), core::compiled::InventoryLocation{inventory}));

    auto cleared = world.clear_structural_configuration(owner.value());
    REQUIRE_FALSE(cleared);
    CHECK(cleared.error().front().code == "runtime.invalid_structural_edit");
    REQUIRE(world.resolved_configuration(owner.value()) != nullptr);
    CHECK(world.resolved_configuration(owner.value())->display_name ==
          project.find_interactable(key)->display_name);
    CHECK(world.has_inventory(inventory));
}

TEST_CASE(
    "runtime world checkpoint restoration preserves identities topology provenance and allocator")
{
    const auto project = load_fixture_with_runtime_archetypes();
    auto state_result = core::SessionState::create(project);
    REQUIRE(state_result);
    auto state = std::move(state_result).value();
    RuntimeWorld world(project, state);

    const auto hall = id<core::RoomId>("hall");
    const auto start = id<core::RoomId>("start");
    const auto east = id<core::RoomExitId>("east-exit");
    REQUIRE(world.retarget_room_exit(hall, east, start));
    auto room = world.create_room(EffectiveInstanceConfiguration{core::GameplayInstanceRef{hall}});
    REQUIRE(room);
    auto character = world.create_character(
        ArchetypeInstanceConfiguration{id<core::ArchetypeId>("runtime-character")},
        core::compiled::RoomLocation{room.value()}, false, true);
    REQUIRE(character);
    auto interactable = world.create_interactable(
        ArchetypeInstanceConfiguration{id<core::ArchetypeId>("runtime-interactable")},
        core::compiled::RoomLocation{room.value()}, true, false);
    REQUIRE(interactable);
    const auto wallet = id<core::ItemStackId>("wallet");
    auto split_stack = world.split_item_stack(wallet, 5);
    REQUIRE(split_stack);
    REQUIRE(split_stack.value().created.size() == 1);
    const auto split_stack_id = split_stack.value().created.front();
    core::PropertyResolver properties(project, state);
    REQUIRE(properties.set(core::PropertyOwnerRef{split_stack_id}, id<core::PropertyId>("quality"),
                           core::RuntimeValue{std::string{"ordinary"}}));

    auto saved = core::make_save_state(project, state);
    REQUIRE(saved);
    auto encoded = core::encode_save_state(project, saved.value());
    REQUIRE(encoded);
    auto decoded = core::decode_save_state(project, encoded.value(), "runtime-world-roundtrip");
    REQUIRE(decoded);
    auto restored_result = test_support::restore_session(project, decoded.value());
    REQUIRE(restored_result);
    auto restored = std::move(restored_result).value();
    RuntimeWorld restored_world(project, restored);

    REQUIRE(restored_world.resolved_configuration(room.value()) != nullptr);
    const auto restored_east =
        std::find_if(restored_world.resolved_configuration(room.value())->exits.begin(),
                     restored_world.resolved_configuration(room.value())->exits.end(),
                     [&](const auto& value) { return value.id == east; });
    REQUIRE(restored_east != restored_world.resolved_configuration(room.value())->exits.end());
    CHECK(restored_east->target == start);
    REQUIRE(restored_world.character_state(character.value()) != nullptr);
    CHECK_FALSE(restored_world.character_state(character.value())->enabled);
    REQUIRE(restored_world.interactable_state(interactable.value()) != nullptr);
    CHECK_FALSE(restored_world.interactable_state(interactable.value())->visible);
    const auto* provenance =
        restored_world.provenance(core::GameplayInstanceRef{character.value()});
    REQUIRE(provenance != nullptr);
    CHECK(provenance->kind == core::RuntimeInstanceProvenanceKind::Archetype);
    CHECK(provenance->archetype == id<core::ArchetypeId>("runtime-character"));
    CHECK(restored.next_runtime_instance_id() == 4);
    REQUIRE(restored_world.item_stack(wallet) != nullptr);
    CHECK(restored_world.item_stack(wallet)->quantity == 20);
    REQUIRE(restored_world.item_stack(split_stack_id) != nullptr);
    CHECK(restored_world.item_stack(split_stack_id)->quantity == 5);
    core::PropertyResolver restored_properties(project, restored);
    auto restored_quality = restored_properties.get(core::PropertyOwnerRef{split_stack_id},
                                                    id<core::PropertyId>("quality"));
    REQUIRE(restored_quality);
    CHECK(std::get<core::RuntimeValue>(restored_quality.value()) ==
          core::RuntimeValue{std::string{"ordinary"}});
    CHECK(restored.next_item_stack_id() == 2);

    auto next_stack = restored_world.split_item_stack(wallet, 1);
    REQUIRE(next_stack);
    REQUIRE(next_stack.value().created.size() == 1);
    CHECK(next_stack.value().created.front().text() == "runtime-item-stack-2");

    auto next = restored_world.create_interactable(
        CompiledInstanceConfiguration{core::GameplayInstanceRef{id<core::InteractableId>("dust")}});
    REQUIRE(next);
    CHECK(next.value().text() == "runtime-interactable-4");
}

TEST_CASE("runtime destruction is explicit non-cascading and rejects live dependents")
{
    const auto project = load_fixture_with_runtime_archetypes();
    auto state_result = core::SessionState::create(project);
    REQUIRE(state_result);
    auto state = std::move(state_result).value();
    RuntimeWorld world(project, state);

    auto room = world.create_room(
        CompiledInstanceConfiguration{core::GameplayInstanceRef{id<core::RoomId>("tower")}});
    auto character = world.create_character(
        CompiledInstanceConfiguration{core::GameplayInstanceRef{id<core::CharacterId>("hero")}},
        core::compiled::RoomLocation{room.value()});
    REQUIRE(room);
    REQUIRE(character);

    auto blocked = world.destroy(core::GameplayInstanceRef{room.value()});
    REQUIRE_FALSE(blocked);
    CHECK(blocked.error().front().code == "runtime.instance_has_dependents");
    REQUIRE(world.resolved_configuration(room.value()) != nullptr);

    REQUIRE(world.move_character(character.value(), core::compiled::UnplacedLocation{}));
    REQUIRE(world.destroy(core::GameplayInstanceRef{room.value()}));
    CHECK(world.resolved_configuration(room.value()) == nullptr);
    REQUIRE(world.destroy(core::GameplayInstanceRef{character.value()}));
    CHECK(world.resolved_configuration(character.value()) == nullptr);

    auto declared = world.destroy(core::GameplayInstanceRef{id<core::RoomId>("start")});
    REQUIRE_FALSE(declared);
    CHECK(declared.error().front().code == "runtime.declared_instance_not_destroyable");
}

TEST_CASE("Item Stack arithmetic preserves exact identities compatibility and stable order")
{
    const auto project = load_fixture("comprehensive.json");
    auto state_result = core::SessionState::create(project);
    REQUIRE(state_result);
    auto state = std::move(state_result).value();
    RuntimeWorld world(project, state);

    const auto wallet = id<core::ItemStackId>("wallet");
    const auto credits = id<core::ItemDefinitionId>("credits");
    const auto quality = id<core::PropertyId>("quality");
    REQUIRE(world.item_stack(wallet) != nullptr);
    CHECK(world.item_stack(wallet)->quantity == 25);

    auto split = world.split_item_stack(wallet, 5);
    REQUIRE(split);
    REQUIRE(split.value().created.size() == 1);
    const auto split_id = split.value().created.front();
    CHECK(split_id.text() == "runtime-item-stack-1");
    CHECK(split.value().changed == std::vector<core::ItemStackId>{wallet});
    REQUIRE(world.item_stack(split_id) != nullptr);
    CHECK(world.item_stack(split_id)->quantity == 5);
    CHECK(world.item_stack(wallet)->quantity == 20);

    core::PropertyResolver properties(project, state);
    REQUIRE(properties.set(core::PropertyOwnerRef{split_id}, quality,
                           core::RuntimeValue{std::string{"ordinary"}}));
    auto incompatible = world.merge_item_stacks(wallet, split_id);
    REQUIRE_FALSE(incompatible);
    CHECK(world.item_stack(wallet)->quantity == 20);
    CHECK(world.item_stack(split_id)->quantity == 5);
    REQUIRE(properties.unset(core::PropertyOwnerRef{split_id}, quality));

    auto merged = world.merge_item_stacks(wallet, split_id);
    REQUIRE(merged);
    CHECK(world.item_stack(wallet)->quantity == 25);
    CHECK(world.item_stack(split_id) == nullptr);
    CHECK(merged.value().changed == std::vector<core::ItemStackId>{wallet});
    CHECK(merged.value().ended == std::vector<core::ItemStackId>{split_id});

    auto granted = world.grant_item_quantity(
        credits, 180,
        core::compiled::InventoryLocation{core::compiled::InventoryRef{
            core::compiled::ProjectInventoryOwner{}, id<core::InventoryId>("player")}});
    REQUIRE(granted);
    CHECK(granted.value().created.size() == 2);
    CHECK(granted.value().created[0].text() == "runtime-item-stack-2");
    CHECK(granted.value().created[1].text() == "runtime-item-stack-3");

    ItemStackFilter filter{.definition = credits};
    auto total = world.aggregate_item_quantity(filter);
    REQUIRE(total);
    CHECK(total.value() == 205);
    auto consumed = world.consume_item_quantity(filter, 110);
    REQUIRE(consumed);
    CHECK(consumed.value().ended == granted.value().created);
    REQUIRE(world.item_stack(wallet) != nullptr);
    CHECK(world.item_stack(wallet)->quantity == 95);
    CHECK(state.next_item_stack_id() == 4);
}

} // namespace
} // namespace noveltea::runtime
