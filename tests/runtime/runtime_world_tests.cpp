#include "noveltea/core/compiled_project_codec.hpp"
#include "noveltea/core/property_resolver.hpp"
#include "noveltea/core/save_state_codec.hpp"
#include "noveltea/core/session_state.hpp"
#include "noveltea/core/shared_evaluator.hpp"
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
    for (auto& instance : document["interactableInstances"])
        if (!instance.contains("featureOverrides"))
            instance["featureOverrides"] = nlohmann::json::array();
    return document;
}

core::CompiledProject decode_fixture(nlohmann::json document, std::string_view filename)
{
    auto decoded = core::decode_compiled_project(document, std::string(filename));
    if (!decoded)
        for (const auto& diagnostic : decoded.error())
            UNSCOPED_INFO(diagnostic.code << ": " << diagnostic.message << " @ "
                                          << diagnostic.source_path << diagnostic.json_pointer);
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
    document["archetypes"] = nlohmann::json::array(
        {{{"id", "runtime-room"}, {"instanceKind", "room"}, {"configuration", room}},
         {{"id", "runtime-character"}, {"instanceKind", "character"}, {"configuration", character}},
         {{"id", "runtime-interactable"},
          {"instanceKind", "interactable"},
          {"configuration", interactable}}});
    return decode_fixture(std::move(document), "comprehensive-runtime-archetypes.json");
}

core::CompiledProject load_stackable_interactable_fixture()
{
    auto document = load_fixture_document("comprehensive.json");
    for (auto& room : document["definitions"]["rooms"])
        if (room["id"] == "hall")
            room["fallbackInteractablePlacementId"] = "coin-placement";
    for (auto& definition : document["definitions"]["interactables"]) {
        if (definition["id"] == "dust") {
            definition["stackable"] = true;
            definition["stackLimit"] = 3;
        }
    }
    for (auto& instance : document["interactableInstances"]) {
        if (instance["id"] == "dust")
            instance["quantity"] = 2;
    }
    return decode_fixture(std::move(document), "stackable-interactable.json");
}

core::InteractableInstanceId create_from_declared_definition(
    RuntimeWorld& world, const core::CompiledProject& project,
    const core::InteractableInstanceId& source,
    core::compiled::InteractableLocation location = core::compiled::UnplacedLocation{},
    bool enabled = true, bool visible = true,
    InteractableRoomPresentationPolicy presentation = InteractableRoomPresentationPolicy::Resolve)
{
    const auto* declaration = project.find_interactable_instance(source);
    REQUIRE(declaration != nullptr);
    auto created = world.create_interactable_quantity(
        declaration->definition, 1, std::move(location), enabled, visible, presentation);
    REQUIRE(created);
    REQUIRE(created.value_if()->created.size() == 1);
    return created.value_if()->created.front();
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
    const auto key = id<core::InteractableInstanceId>("key");

    REQUIRE(world.resolved_configuration(start) != nullptr);
    REQUIRE(world.resolved_configuration(hero) != nullptr);
    REQUIRE(world.resolved_configuration(key) != nullptr);
    CHECK(world.resolved_configuration(start)->display_name ==
          project.find_room(start)->display_name);
    CHECK(world.resolved_configuration(hero)->display_name ==
          project.find_character(hero)->display_name);
    const auto* key_instance = project.find_interactable_instance(key);
    REQUIRE(key_instance != nullptr);
    CHECK(world.resolved_configuration(key)->display_name ==
          project.find_interactable_definition(key_instance->definition)->display_name);
    CHECK(world.resolved_configuration(id<core::RoomId>("missing")) == nullptr);
    CHECK(world.resolved_configuration(id<core::CharacterId>("missing")) == nullptr);
    CHECK(world.resolved_configuration(id<core::InteractableInstanceId>("missing")) == nullptr);

    REQUIRE(world.character_state(hero) != nullptr);
    REQUIRE(world.interactable_state(key) != nullptr);
    CHECK(world.character_state(hero) == state.character_world(hero));
    CHECK(world.interactable_state(key) == state.interactable(key));
}

TEST_CASE("shared recursive Conditions inspect identity Trait Location slots and direct Inventory "
          "quantity")
{
    const auto project = load_fixture("comprehensive.json");
    auto state_result = core::SessionState::create(project);
    REQUIRE(state_result);
    auto state = std::move(state_result).value();
    core::FlowExecutor flow(project, state);
    core::SharedPrimitiveEvaluator evaluator(project, state, flow);
    RuntimeWorld world(project, state);

    const auto key = id<core::InteractableInstanceId>("key");
    const auto wallet = id<core::InteractableInstanceId>("wallet");
    const auto start = id<core::RoomId>("start");
    const auto player_inventory = core::compiled::InventoryRef{
        core::compiled::ProjectInventoryOwner{}, id<core::InventoryId>("player")};

    core::Condition recursive = core::AllCondition{{
        core::Condition{core::IdentityPropertyTruthiness{core::GameplayIdentityOperand{key},
                                                         id<core::PropertyId>("enabled"),
                                                         core::TruthinessOperator::Truthy}},
        core::Condition{core::TraitPresenceCondition{core::GameplayIdentityOperand{wallet},
                                                     id<core::TraitId>("currency"), true}},
        core::Condition{core::LocationComparisonCondition{
            core::LocationSubjectOperand{key}, core::EqualityComparisonOperator::Equal,
            core::LocationOperand{core::RoomLocationOperand{core::RoomOperand{start}}}}},
        core::Condition{core::NotCondition{{core::Condition{core::TraitPresenceCondition{
            core::GameplayIdentityOperand{key}, id<core::TraitId>("currency"), true}}}}},
    }};
    auto recursive_result = evaluator.evaluate(recursive);
    REQUIRE(recursive_result);
    CHECK(recursive_result.value());

    const std::vector<core::InteractionSubjectBinding> bindings{{
        id<core::VerbSlotId>("target"),
        core::compiled::InteractableInteractionSubject{key},
    }};
    core::Condition slot_property = core::IdentityPropertyTruthiness{
        core::GameplayIdentityOperand{core::InteractionSlotOperand{id<core::VerbSlotId>("target")}},
        id<core::PropertyId>("enabled"), core::TruthinessOperator::Truthy};
    auto slot_result = evaluator.evaluate(
        slot_property,
        core::ConditionEvaluationContext{.interaction_bindings = bindings, .command_results = {}});
    REQUIRE(slot_result);
    CHECK(slot_result.value());

    const std::vector<core::CommandResultBinding> results{
        {id<core::CommandResultBindingId>("created"), core::GameplayOperandValue{key}}};
    core::Condition result_property = core::IdentityPropertyTruthiness{
        core::GameplayIdentityOperand{
            core::CommandResultOperand{id<core::CommandResultBindingId>("created")}},
        id<core::PropertyId>("enabled"), core::TruthinessOperator::Truthy};
    auto result_binding = evaluator.evaluate(
        result_property,
        core::ConditionEvaluationContext{.interaction_bindings = {}, .command_results = results});
    REQUIRE(result_binding);
    CHECK(result_binding.value());

    auto missing_result = evaluator.evaluate(
        result_property,
        core::ConditionEvaluationContext{.interaction_bindings = {}, .command_results = {}});
    REQUIRE_FALSE(missing_result);
    CHECK(missing_result.error().front().code == "execution.condition_result_unavailable");

    core::Condition quantity = core::InventoryQuantityComparisonCondition{
        .inventory = core::ExactInventoryOperand{player_inventory},
        .matcher =
            core::ConditionInteractableMatcher{
                .definition = id<core::InteractableDefinitionId>("credits"),
                .traits = {id<core::TraitId>("currency")},
                .properties = {},
                .exact = std::nullopt,
            },
        .operation = core::ValueComparisonOperator::Equal,
        .quantity = 1,
    };
    auto quantity_result = evaluator.evaluate(quantity);
    REQUIRE(quantity_result);
    CHECK(quantity_result.value());

    auto created = world.create_interactable_quantity(
        id<core::InteractableDefinitionId>("credits"), 1,
        core::compiled::InteractableLocation{core::compiled::InventoryLocation{player_inventory}});
    REQUIRE(created);
    quantity = core::InventoryQuantityComparisonCondition{
        .inventory = core::ExactInventoryOperand{player_inventory},
        .matcher =
            core::ConditionInteractableMatcher{
                .definition = id<core::InteractableDefinitionId>("credits"),
                .traits = {id<core::TraitId>("currency")},
                .properties = {},
                .exact = std::nullopt,
            },
        .operation = core::ValueComparisonOperator::Equal,
        .quantity = 2,
    };
    quantity_result = evaluator.evaluate(quantity);
    REQUIRE(quantity_result);
    CHECK(quantity_result.value());
}

TEST_CASE("declared Interactable Instances realize independent exact Features and Inventories")
{
    auto document = load_fixture_document("interaction-program.json");
    auto key_declaration = *std::find_if(
        document["interactableInstances"].begin(), document["interactableInstances"].end(),
        [](const auto& declaration) { return declaration["id"] == "key"; });
    key_declaration["id"] = "key-spare";
    key_declaration["location"] = {{"kind", "unplaced"}};
    key_declaration["featureOverrides"] = nlohmann::json::array();
    document["interactableInstances"].push_back(key_declaration);
    for (auto& declaration : document["interactableInstances"]) {
        if (declaration["id"] == "key") {
            declaration["featureOverrides"] = nlohmann::json::array(
                {{{"featureId", "surface"},
                  {"traitAdds", nlohmann::json::array()},
                  {"traitRemoves", nlohmann::json::array()},
                  {"propertyOverrides",
                   nlohmann::json::array({{{"propertyId", "enabled"}, {"value", false}}})}}});
        }
    }

    const auto project = decode_fixture(std::move(document), "instance-feature-overrides.json");
    auto state_result = core::SessionState::create(project);
    REQUIRE(state_result);
    auto state = std::move(state_result).value();
    RuntimeWorld world(project, state);
    core::PropertyResolver properties(project, state);

    const auto key = id<core::InteractableInstanceId>("key");
    const auto spare = id<core::InteractableInstanceId>("key-spare");
    const auto surface = id<core::FeatureId>("surface");
    const auto enabled = id<core::PropertyId>("enabled");
    const core::PropertyOwnerRef key_surface{core::InteractableFeatureRef{key, surface}};
    const core::PropertyOwnerRef spare_surface{core::InteractableFeatureRef{spare, surface}};

    const auto key_value = properties.get(key_surface, enabled);
    REQUIRE(key_value);
    REQUIRE(std::holds_alternative<core::RuntimeValue>(key_value.value()));
    CHECK(std::get<core::RuntimeValue>(key_value.value()) == core::RuntimeValue{false});
    const auto spare_value = properties.get(spare_surface, enabled);
    REQUIRE(spare_value);
    REQUIRE(std::holds_alternative<core::RuntimeValue>(spare_value.value()));
    CHECK(std::get<core::RuntimeValue>(spare_value.value()) == core::RuntimeValue{true});

    const auto hidden = id<core::InventoryId>("hidden");
    const auto groove = id<core::InventoryId>("groove");
    const auto dust = id<core::InteractableInstanceId>("dust");
    const core::compiled::InventoryRef key_groove{core::InteractableFeatureRef{key, surface},
                                                  groove};
    CHECK(world.has_inventory(
        core::compiled::InventoryRef{core::compiled::InteractableInventoryOwner{key}, hidden}));
    CHECK(world.has_inventory(
        core::compiled::InventoryRef{core::compiled::InteractableInventoryOwner{spare}, hidden}));
    CHECK(world.has_inventory(
        core::compiled::InventoryRef{core::InteractableFeatureRef{key, surface}, groove}));
    CHECK(world.has_inventory(
        core::compiled::InventoryRef{core::InteractableFeatureRef{spare, surface}, groove}));

    REQUIRE(world.move_interactable(dust, core::compiled::InventoryLocation{key_groove}));
    auto saved = core::make_save_state(project, state);
    REQUIRE(saved);
    auto encoded = core::encode_save_state(project, saved.value());
    REQUIRE(encoded);
    auto decoded = core::decode_save_state(project, encoded.value(), "instance-feature-overrides");
    REQUIRE(decoded);
    auto restored_result = test_support::restore_session(project, decoded.value());
    REQUIRE(restored_result);
    auto restored = std::move(restored_result).value();
    RuntimeWorld restored_world(project, restored);
    core::PropertyResolver restored_properties(project, restored);

    const auto restored_key_value = restored_properties.get(key_surface, enabled);
    const auto restored_spare_value = restored_properties.get(spare_surface, enabled);
    REQUIRE(restored_key_value);
    REQUIRE(restored_spare_value);
    CHECK(std::get<core::RuntimeValue>(restored_key_value.value()) == core::RuntimeValue{false});
    CHECK(std::get<core::RuntimeValue>(restored_spare_value.value()) == core::RuntimeValue{true});
    REQUIRE(restored_world.interactable_state(dust) != nullptr);
    const auto* restored_location = std::get_if<core::compiled::InventoryLocation>(
        &restored_world.interactable_state(dust)->location);
    REQUIRE(restored_location != nullptr);
    CHECK(restored_location->inventory == key_groove);
    CHECK(restored_world.has_inventory(key_groove));
    CHECK(restored_world.has_inventory(
        core::compiled::InventoryRef{core::InteractableFeatureRef{spare, surface}, groove}));
}

TEST_CASE("runtime world mutates declared gameplay instance state without mutating definitions")
{
    const auto project = load_fixture("comprehensive.json");
    auto state_result = core::SessionState::create(project);
    REQUIRE(state_result);
    auto state = std::move(state_result).value();
    RuntimeWorld world(project, state);

    const auto hero = id<core::CharacterId>("hero");
    const auto key = id<core::InteractableInstanceId>("key");
    const auto hall = id<core::RoomId>("hall");

    const auto* hero_definition = world.resolved_configuration(hero);
    const auto* key_definition = world.resolved_configuration(key);
    REQUIRE(hero_definition != nullptr);
    REQUIRE(key_definition != nullptr);
    CHECK(hero_definition->initial_world_state.visible);
    REQUIRE(project.find_interactable_instance(key) != nullptr);
    CHECK(project.find_interactable_instance(key)->visible);

    REQUIRE(world.set_character_visible(hero, false));
    REQUIRE(world.set_interactable_visible(key, false));
    REQUIRE(world.move_interactable(key, core::compiled::RoomLocation{hall},
                                    InteractableRoomPresentationPolicy::None));

    REQUIRE(world.character_state(hero) != nullptr);
    REQUIRE(world.interactable_state(key) != nullptr);
    CHECK_FALSE(world.character_state(hero)->visible);
    CHECK_FALSE(world.interactable_state(key)->visible);
    const auto* moved =
        std::get_if<core::compiled::RoomLocation>(&world.interactable_state(key)->location);
    REQUIRE(moved != nullptr);
    CHECK(moved->room == hall);

    CHECK(hero_definition->initial_world_state.visible);
    CHECK(project.find_interactable_instance(key)->visible);
    CHECK(world.resolved_configuration(hero) == hero_definition);
    CHECK(world.resolved_configuration(key) == key_definition);
}

TEST_CASE("runtime world creates splits merges and transfers stackable Interactable quantities")
{
    const auto project = load_stackable_interactable_fixture();
    auto state_result = core::SessionState::create(project);
    REQUIRE(state_result);
    auto state = std::move(state_result).value();
    RuntimeWorld world(project, state);

    const auto dust_definition = id<core::InteractableDefinitionId>("dust");
    const auto dust = id<core::InteractableInstanceId>("dust");
    const auto hall = id<core::RoomId>("hall");

    auto created =
        world.create_interactable_quantity(dust_definition, 7, core::compiled::UnplacedLocation{});
    REQUIRE(created);
    REQUIRE(created.value().created.size() == 3);
    CHECK(world.interactable_state(dust)->quantity == 2);
    CHECK(world.interactable_state(created.value().created[0])->quantity == 3);
    CHECK(world.interactable_state(created.value().created[1])->quantity == 3);
    CHECK(world.interactable_state(created.value().created[2])->quantity == 1);

    auto split = world.split_interactable_quantity(dust, 1);
    REQUIRE(split);
    REQUIRE(split.value().created.size() == 1);
    const auto split_id = split.value().created.front();
    CHECK(world.interactable_state(dust)->quantity == 1);
    CHECK(world.interactable_state(split_id)->quantity == 1);

    auto merged = world.merge_interactable_quantities(dust, split_id);
    REQUIRE(merged);
    CHECK(world.interactable_state(dust)->quantity == 2);
    CHECK(world.interactable_state(split_id) == nullptr);

    auto transferred =
        world.transfer_interactable_quantity(dust, 1, core::compiled::RoomLocation{hall});
    REQUIRE(transferred);
    REQUIRE(transferred.value().created.size() == 1);
    const auto moved_id = transferred.value().created.front();
    CHECK(world.interactable_state(dust)->quantity == 1);
    const auto* moved = world.interactable_state(moved_id);
    REQUIRE(moved != nullptr);
    CHECK(moved->quantity == 1);
    REQUIRE(std::get_if<core::compiled::RoomLocation>(&moved->location) != nullptr);
    CHECK(std::get<core::compiled::RoomLocation>(moved->location).room == hall);
}

TEST_CASE("aggregate Interactable transfer preserves whole identities and splits only its boundary")
{
    const auto project = load_stackable_interactable_fixture();
    auto state_result = core::SessionState::create(project);
    REQUIRE(state_result);
    auto state = std::move(state_result).value();
    RuntimeWorld world(project, state);

    const auto dust_definition = id<core::InteractableDefinitionId>("dust");
    const auto declared_dust = id<core::InteractableInstanceId>("dust");
    const auto hall = id<core::RoomId>("hall");
    REQUIRE(world.move_interactable(declared_dust, core::compiled::RoomLocation{hall}));
    auto destination =
        world.create_interactable_quantity(dust_definition, 1, core::compiled::RoomLocation{hall});
    REQUIRE(destination);
    REQUIRE(destination.value().created.size() == 1);
    const auto destination_id = destination.value().created.front();

    auto sources =
        world.create_interactable_quantity(dust_definition, 7, core::compiled::UnplacedLocation{});
    REQUIRE(sources);
    REQUIRE(sources.value().created.size() == 3);
    const auto whole_id = sources.value().created[0];
    const auto boundary_source_id = sources.value().created[1];
    CHECK(world.interactable_state(whole_id)->quantity == 3);
    CHECK(world.interactable_state(boundary_source_id)->quantity == 3);

    InteractableQuantityFilter filter{dust_definition, core::compiled::UnplacedLocation{}};
    auto transferred =
        world.transfer_interactable_quantity(filter, 5, core::compiled::RoomLocation{hall});
    REQUIRE(transferred);
    CHECK(transferred.value().quantity == 5);
    REQUIRE(transferred.value().created.size() == 1);
    const auto boundary_created_id = transferred.value().created.front();

    const auto* whole = world.interactable_state(whole_id);
    REQUIRE(whole != nullptr);
    CHECK(whole->quantity == 3);
    REQUIRE(std::holds_alternative<core::compiled::RoomLocation>(whole->location));
    CHECK(std::get<core::compiled::RoomLocation>(whole->location).room == hall);

    const auto* boundary_source = world.interactable_state(boundary_source_id);
    REQUIRE(boundary_source != nullptr);
    CHECK(boundary_source->quantity == 1);
    CHECK(std::holds_alternative<core::compiled::UnplacedLocation>(boundary_source->location));
    const auto* boundary_created = world.interactable_state(boundary_created_id);
    REQUIRE(boundary_created != nullptr);
    CHECK(boundary_created->quantity == 2);
    REQUIRE(std::holds_alternative<core::compiled::RoomLocation>(boundary_created->location));
    CHECK(std::get<core::compiled::RoomLocation>(boundary_created->location).room == hall);

    const auto* preexisting_destination = world.interactable_state(destination_id);
    REQUIRE(preexisting_destination != nullptr);
    CHECK(preexisting_destination->quantity == 1);
    CHECK(destination_id != whole_id);
    CHECK(destination_id != boundary_created_id);
}

TEST_CASE(
    "runtime world Interactable Matcher covers broad definition Trait Property and exact Instance")
{
    auto document = load_fixture_document("comprehensive.json");
    for (auto& definition : document["definitions"]["interactables"])
        if (definition["id"] == "key")
            definition["traits"] = nlohmann::json::array({"currency"});
    const auto project = decode_fixture(std::move(document), "interactable-matcher.json");
    auto state_result = core::SessionState::create(project);
    REQUIRE(state_result);
    auto state = std::move(state_result).value();
    RuntimeWorld world(project, state);

    const auto definition = id<core::InteractableDefinitionId>("key");
    const auto declared = id<core::InteractableInstanceId>("key");
    auto created =
        world.create_interactable_quantity(definition, 1, core::compiled::UnplacedLocation{});
    REQUIRE(created);
    REQUIRE(created.value().created.size() == 1);
    const auto runtime_created = created.value().created.front();

    CHECK(world.matches_interactable(declared, InteractableMatcher{}));
    CHECK(world.matches_interactable(runtime_created, InteractableMatcher{}));
    CHECK(world.matches_interactable(declared, InteractableMatcher{definition}));
    CHECK(world.matches_interactable(runtime_created, InteractableMatcher{definition}));

    InteractableMatcher trait_matcher;
    trait_matcher.traits.push_back(id<core::TraitId>("currency"));
    CHECK(world.matches_interactable(declared, trait_matcher));
    CHECK(world.matches_interactable(runtime_created, trait_matcher));

    InteractableMatcher property_matcher;
    property_matcher.properties.push_back(
        {id<core::PropertyId>("enabled"), core::RuntimeValue{true}});
    CHECK(world.matches_interactable(declared, property_matcher));
    CHECK(world.matches_interactable(runtime_created, property_matcher));

    InteractableMatcher exact_matcher;
    exact_matcher.instance = runtime_created;
    CHECK_FALSE(world.matches_interactable(declared, exact_matcher));
    CHECK(world.matches_interactable(runtime_created, exact_matcher));
}

TEST_CASE(
    "runtime world resolves Room presentation atomically with authored fallback and none policies")
{
    auto document = load_fixture_document("comprehensive.json");
    for (auto& room : document["definitions"]["rooms"])
        if (room["id"] == "hall")
            room["fallbackInteractablePlacementId"] = "coin-placement";
    const auto project = decode_fixture(std::move(document), "room-interactable-fallback.json");
    auto state_result = core::SessionState::create(project);
    REQUIRE(state_result);
    auto state = std::move(state_result).value();
    RuntimeWorld world(project, state);

    const auto key = id<core::InteractableInstanceId>("key");
    const auto start = id<core::RoomId>("start");
    const auto hall = id<core::RoomId>("hall");
    const auto tower = id<core::RoomId>("tower");

    auto authored = world.resolve_interactable_room_placement(key, start);
    REQUIRE(authored);
    CHECK(authored->source == InteractableRoomPlacementSource::Authored);
    CHECK(authored->placement == id<core::RoomPlacementId>("key-placement"));

    REQUIRE(world.move_interactable(key, core::compiled::RoomLocation{hall}));
    const auto* in_hall = world.interactable_state(key);
    REQUIRE(in_hall != nullptr);
    REQUIRE(in_hall->dynamic_room_occurrence);
    CHECK(in_hall->dynamic_room_occurrence->room == hall);
    CHECK(in_hall->dynamic_room_occurrence->placement ==
          id<core::RoomPlacementId>("coin-placement"));

    auto saved = core::make_save_state(project, state);
    REQUIRE(saved);
    auto encoded = core::encode_save_state(project, saved.value());
    REQUIRE(encoded);
    auto decoded = core::decode_save_state(project, encoded.value(), "room-occurrence-save.json");
    REQUIRE(decoded);
    const auto restored = std::ranges::find_if(
        decoded.value().interactables, [&](const auto& item) { return item.interactable == key; });
    REQUIRE(restored != decoded.value().interactables.end());
    REQUIRE(restored->dynamic_room_occurrence);
    CHECK(restored->dynamic_room_occurrence == in_hall->dynamic_room_occurrence);

    auto rejected = world.move_interactable(key, core::compiled::RoomLocation{tower});
    REQUIRE_FALSE(rejected);
    const auto* still_in_hall = world.interactable_state(key);
    REQUIRE(still_in_hall != nullptr);
    CHECK(std::get<core::compiled::RoomLocation>(still_in_hall->location).room == hall);
    REQUIRE(still_in_hall->dynamic_room_occurrence);
    CHECK(still_in_hall->dynamic_room_occurrence->room == hall);

    REQUIRE(world.move_interactable(key, core::compiled::RoomLocation{tower},
                                    InteractableRoomPresentationPolicy::None));
    const auto* semantic_only = world.interactable_state(key);
    REQUIRE(semantic_only != nullptr);
    CHECK(std::get<core::compiled::RoomLocation>(semantic_only->location).room == tower);
    CHECK_FALSE(semantic_only->dynamic_room_occurrence);
}

TEST_CASE("splitting stackable Interactable in a Room inherits resolved presentation placement")
{
    auto document = load_fixture_document("comprehensive.json");
    for (auto& room : document["definitions"]["rooms"])
        if (room["id"] == "hall")
            room["fallbackInteractablePlacementId"] = "coin-placement";
    for (auto& definition : document["definitions"]["interactables"])
        if (definition["id"] == "dust") {
            definition["stackable"] = true;
            definition["stackLimit"] = 3;
        }
    const auto project = decode_fixture(std::move(document), "room-interactable-split.json");
    auto state_result = core::SessionState::create(project);
    REQUIRE(state_result);
    auto state = std::move(state_result).value();
    RuntimeWorld world(project, state);

    const auto hall = id<core::RoomId>("hall");
    auto created = world.create_interactable_quantity(id<core::InteractableDefinitionId>("dust"), 2,
                                                      core::compiled::RoomLocation{hall});
    REQUIRE(created);
    REQUIRE(created.value().created.size() == 1);
    const auto source = created.value().created.front();
    auto split = world.split_interactable_quantity(source, 1);
    REQUIRE(split);
    REQUIRE(split.value().created.size() == 1);
    const auto clone = split.value().created.front();
    const auto* source_state = world.interactable_state(source);
    const auto* clone_state = world.interactable_state(clone);
    REQUIRE(source_state != nullptr);
    REQUIRE(clone_state != nullptr);
    REQUIRE(source_state->dynamic_room_occurrence);
    REQUIRE(clone_state->dynamic_room_occurrence);
    CHECK(clone_state->dynamic_room_occurrence == source_state->dynamic_room_occurrence);
    CHECK(std::get<core::compiled::RoomLocation>(clone_state->location).room == hall);
}

TEST_CASE(
    "runtime world Add Quantity uses only default semantic state and aggregate mutation is atomic")
{
    const auto project = load_stackable_interactable_fixture();
    auto state_result = core::SessionState::create(project);
    REQUIRE(state_result);
    auto state = std::move(state_result).value();
    RuntimeWorld world(project, state);

    const auto definition = id<core::InteractableDefinitionId>("dust");
    auto specialized =
        world.create_interactable_quantity(definition, 1, core::compiled::UnplacedLocation{});
    auto default_stack =
        world.create_interactable_quantity(definition, 1, core::compiled::UnplacedLocation{});
    REQUIRE(specialized);
    REQUIRE(default_stack);
    REQUIRE(world.set_interactable_enabled(specialized.value().created.front(), false));

    auto added = world.add_interactable_quantity(definition, 4, core::compiled::UnplacedLocation{});
    REQUIRE(added);
    CHECK(world.interactable_state(specialized.value().created.front())->quantity == 1);
    CHECK(world.interactable_state(id<core::InteractableInstanceId>("dust"))->quantity == 3);
    CHECK(world.interactable_state(default_stack.value().created.front())->quantity == 3);
    REQUIRE(added.value().created.size() == 1);
    CHECK(world.interactable_state(added.value().created.front())->quantity == 1);

    const auto before = world.aggregate_interactable_quantity(
        InteractableQuantityFilter{definition, core::compiled::UnplacedLocation{}});
    REQUIRE(before);
    auto ambiguous = world.consume_interactable_quantity(
        InteractableQuantityFilter{definition, core::compiled::UnplacedLocation{}}, 1);
    REQUIRE_FALSE(ambiguous);
    CHECK(ambiguous.error().front().code == "runtime.ambiguous_interactable_quantity_state");
    const auto after = world.aggregate_interactable_quantity(
        InteractableQuantityFilter{definition, core::compiled::UnplacedLocation{}});
    REQUIRE(after);
    CHECK(after.value() == before.value());
}

TEST_CASE("stackable Interactable quantities and allocator round-trip without identity reuse")
{
    const auto project = load_stackable_interactable_fixture();
    auto state_result = core::SessionState::create(project);
    REQUIRE(state_result);
    auto state = std::move(state_result).value();
    RuntimeWorld world(project, state);
    const auto definition = id<core::InteractableDefinitionId>("dust");

    auto created =
        world.create_interactable_quantity(definition, 4, core::compiled::UnplacedLocation{});
    REQUIRE(created);
    REQUIRE(created.value().created.size() == 2);
    const auto ended_id = created.value().created.front();
    const auto live_id = created.value().created.back();
    REQUIRE(world.consume_interactable_quantity(ended_id, 3));
    CHECK(world.interactable_state(ended_id) == nullptr);
    REQUIRE(world.interactable_state(live_id) != nullptr);
    CHECK(world.interactable_state(live_id)->quantity == 1);

    auto saved = core::make_save_state(project, state);
    REQUIRE(saved);
    auto encoded = core::encode_save_state(project, saved.value());
    REQUIRE(encoded);
    auto decoded =
        core::decode_save_state(project, encoded.value(), "stackable-quantity-roundtrip");
    REQUIRE(decoded);
    auto restored_result = test_support::restore_session(project, decoded.value());
    REQUIRE(restored_result);
    auto restored = std::move(restored_result).value();
    RuntimeWorld restored_world(project, restored);
    CHECK(restored_world.interactable_state(ended_id) == nullptr);
    REQUIRE(restored_world.interactable_state(live_id) != nullptr);
    CHECK(restored_world.interactable_state(live_id)->quantity == 1);

    auto next = restored_world.create_interactable_quantity(definition, 1,
                                                            core::compiled::UnplacedLocation{});
    REQUIRE(next);
    REQUIRE(next.value().created.size() == 1);
    CHECK(next.value().created.front() != ended_id);
}

TEST_CASE("fully consumed declared non-stackable Interactable remains stale across save restore")
{
    const auto project = load_fixture("comprehensive.json");
    auto state_result = core::SessionState::create(project);
    REQUIRE(state_result);
    auto state = std::move(state_result).value();
    RuntimeWorld world(project, state);
    const auto key = id<core::InteractableInstanceId>("key");

    REQUIRE(world.consume_interactable_quantity(key, 1));
    CHECK(world.interactable_state(key) == nullptr);

    auto saved = core::make_save_state(project, state);
    REQUIRE(saved);
    auto encoded = core::encode_save_state(project, saved.value());
    REQUIRE(encoded);
    auto decoded =
        core::decode_save_state(project, encoded.value(), "consumed-declared-interactable");
    REQUIRE(decoded);
    auto restored_result = test_support::restore_session(project, decoded.value());
    REQUIRE(restored_result);
    RuntimeWorld restored_world(project, restored_result.value());
    CHECK(restored_world.interactable_state(key) == nullptr);
    CHECK(restored_world.resolved_configuration(key) == nullptr);
}

TEST_CASE("declared Interactable Instances sharing one definition save and restore independently")
{
    auto document = load_fixture_document("comprehensive.json");
    document["interactableInstances"].back()["propertyOverrides"][0]["value"] = "ordinary";
    document["interactableInstances"].back()["localProperties"] =
        nlohmann::json::array({{{"id", "serial"},
                                {"label", "Serial"},
                                {"description", ""},
                                {"type", "string"},
                                {"nullable", false},
                                {"enumValues", nlohmann::json::array()},
                                {"value", "wallet-001"}}});
    for (auto& declaration : document["interactableInstances"])
        if (declaration["id"] == "key")
            declaration["traitAdds"] = nlohmann::json::array({"currency"});
    auto spare_declaration = document["interactableInstances"].back();
    spare_declaration["id"] = "wallet-spare";
    spare_declaration["propertyOverrides"] = nlohmann::json::array();
    spare_declaration["traitRemoves"] = {"currency"};
    document["interactableInstances"].push_back(std::move(spare_declaration));
    const auto project = decode_fixture(std::move(document), "shared-interactable-definition.json");
    const auto wallet = id<core::InteractableInstanceId>("wallet");
    const auto spare = id<core::InteractableInstanceId>("wallet-spare");
    const auto key = id<core::InteractableInstanceId>("key");
    const auto credits = id<core::InteractableDefinitionId>("credits");
    const auto currency = id<core::TraitId>("currency");
    const auto quality = id<core::PropertyId>("quality");
    const auto serial = id<core::PropertyId>("serial");
    const auto hall = id<core::RoomId>("hall");

    REQUIRE(project.find_interactable_instance(wallet) != nullptr);
    REQUIRE(project.find_interactable_instance(spare) != nullptr);
    CHECK(project.find_interactable_instance(wallet)->definition == credits);
    CHECK(project.find_interactable_instance(spare)->definition == credits);

    auto state_result = core::SessionState::create(project);
    REQUIRE(state_result);
    auto state = std::move(state_result).value();
    RuntimeWorld world(project, state);

    REQUIRE(world.interactable_state(wallet) != nullptr);
    REQUIRE(world.interactable_state(spare) != nullptr);
    REQUIRE(world.resolved_configuration(wallet) != nullptr);
    REQUIRE(world.resolved_configuration(spare) != nullptr);
    CHECK(std::ranges::find(world.resolved_configuration(wallet)->identity.traits, currency) !=
          world.resolved_configuration(wallet)->identity.traits.end());
    CHECK(std::ranges::find(world.resolved_configuration(spare)->identity.traits, currency) ==
          world.resolved_configuration(spare)->identity.traits.end());
    REQUIRE(world.resolved_configuration(key) != nullptr);
    CHECK(std::ranges::find(world.resolved_configuration(key)->identity.traits, currency) !=
          world.resolved_configuration(key)->identity.traits.end());
    core::PropertyResolver initial_properties(project, state);
    auto wallet_quality = initial_properties.get(core::PropertyOwnerRef{wallet}, quality);
    REQUIRE(wallet_quality);
    CHECK(std::get<core::RuntimeValue>(wallet_quality.value()) ==
          core::RuntimeValue{std::string{"ordinary"}});
    auto wallet_serial = initial_properties.get(core::PropertyOwnerRef{wallet}, serial);
    REQUIRE(wallet_serial);
    CHECK(std::get<core::RuntimeValue>(wallet_serial.value()) ==
          core::RuntimeValue{std::string{"wallet-001"}});
    REQUIRE(world.set_interactable_visible(wallet, false));
    REQUIRE(world.move_interactable(wallet, core::compiled::RoomLocation{hall},
                                    InteractableRoomPresentationPolicy::None));
    core::PropertyResolver properties(project, state);
    REQUIRE(properties.set(core::PropertyOwnerRef{wallet}, id<core::PropertyId>("note"),
                           core::RuntimeValue{std::string{"wallet"}}));
    REQUIRE(properties.set(core::PropertyOwnerRef{spare}, id<core::PropertyId>("note"),
                           core::RuntimeValue{std::string{"spare"}}));
    REQUIRE(properties.set(core::PropertyOwnerRef{wallet}, serial,
                           core::RuntimeValue{std::string{"wallet-002"}}));

    auto saved = core::make_save_state(project, state);
    REQUIRE(saved);
    auto encoded = core::encode_save_state(project, saved.value());
    REQUIRE(encoded);
    auto decoded =
        core::decode_save_state(project, encoded.value(), "shared-interactable-definition");
    REQUIRE(decoded);
    auto restored_result = test_support::restore_session(project, decoded.value());
    REQUIRE(restored_result);
    auto restored = std::move(restored_result).value();
    RuntimeWorld restored_world(project, restored);

    const auto* restored_wallet = restored_world.interactable_state(wallet);
    const auto* restored_spare = restored_world.interactable_state(spare);
    REQUIRE(restored_wallet != nullptr);
    REQUIRE(restored_spare != nullptr);
    CHECK_FALSE(restored_wallet->visible);
    CHECK(restored_spare->visible);
    const auto* wallet_room = std::get_if<core::compiled::RoomLocation>(&restored_wallet->location);
    REQUIRE(wallet_room != nullptr);
    CHECK(wallet_room->room == hall);
    CHECK(std::holds_alternative<core::compiled::InventoryLocation>(restored_spare->location));

    REQUIRE(restored_world.resolved_configuration(wallet) != nullptr);
    REQUIRE(restored_world.resolved_configuration(spare) != nullptr);
    CHECK(restored_world.resolved_configuration(wallet)->identity.id == credits);
    CHECK(restored_world.resolved_configuration(spare)->identity.id == credits);
    CHECK(std::ranges::find(restored_world.resolved_configuration(wallet)->identity.traits,
                            currency) !=
          restored_world.resolved_configuration(wallet)->identity.traits.end());
    CHECK(std::ranges::find(restored_world.resolved_configuration(spare)->identity.traits,
                            currency) ==
          restored_world.resolved_configuration(spare)->identity.traits.end());
    REQUIRE(restored_world.resolved_configuration(key) != nullptr);
    CHECK(
        std::ranges::find(restored_world.resolved_configuration(key)->identity.traits, currency) !=
        restored_world.resolved_configuration(key)->identity.traits.end());

    core::PropertyResolver restored_properties(project, restored);
    auto restored_wallet_quality = restored_properties.get(core::PropertyOwnerRef{wallet}, quality);
    auto wallet_note =
        restored_properties.get(core::PropertyOwnerRef{wallet}, id<core::PropertyId>("note"));
    auto spare_note =
        restored_properties.get(core::PropertyOwnerRef{spare}, id<core::PropertyId>("note"));
    auto restored_wallet_serial = restored_properties.get(core::PropertyOwnerRef{wallet}, serial);
    REQUIRE(restored_wallet_quality);
    REQUIRE(wallet_note);
    REQUIRE(spare_note);
    REQUIRE(restored_wallet_serial);
    CHECK(std::get<core::RuntimeValue>(restored_wallet_quality.value()) ==
          core::RuntimeValue{std::string{"ordinary"}});
    CHECK(std::get<core::RuntimeValue>(wallet_note.value()) ==
          core::RuntimeValue{std::string{"wallet"}});
    CHECK(std::get<core::RuntimeValue>(spare_note.value()) ==
          core::RuntimeValue{std::string{"spare"}});
    CHECK(std::get<core::RuntimeValue>(restored_wallet_serial.value()) ==
          core::RuntimeValue{std::string{"wallet-002"}});
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

    const auto interactable =
        create_from_declared_definition(world, project, id<core::InteractableInstanceId>("key"));
    CHECK(interactable.text() == "runtime-interactable-3");
    CHECK(state.next_runtime_instance_id() == 4);

    const auto* room_provenance = world.provenance(core::GameplayInstanceRef{room.value()});
    const auto* character_provenance =
        world.provenance(core::GameplayInstanceRef{character.value()});
    const auto* interactable_provenance = world.provenance(core::GameplayInstanceRef{interactable});
    REQUIRE(room_provenance != nullptr);
    REQUIRE(character_provenance != nullptr);
    REQUIRE(interactable_provenance != nullptr);
    CHECK(room_provenance->kind == core::RuntimeInstanceProvenanceKind::Archetype);
    CHECK(room_provenance->archetype == id<core::ArchetypeId>("runtime-room"));
    CHECK(character_provenance->kind == core::RuntimeInstanceProvenanceKind::CompiledDefinition);
    CHECK(interactable_provenance->kind == core::RuntimeInstanceProvenanceKind::CompiledDefinition);
}

TEST_CASE("runtime Interactable creation atomically requires effective Property Values")
{
    auto document = load_fixture_document("comprehensive.json");
    auto required = document["definitions"]["interactables"][0];
    required["id"] = "required-interactable";
    required["properties"] = nlohmann::json::array({{{"id", "runtime-state"},
                                                     {"label", "Runtime State"},
                                                     {"description", ""},
                                                     {"type", "string"},
                                                     {"nullable", false},
                                                     {"enumValues", nlohmann::json::array()}}});
    required["features"] = nlohmann::json::array(
        {{{"id", "required-feature"},
          {"label", "Required Feature"},
          {"traits", nlohmann::json::array()},
          {"propertyAssignments", nlohmann::json::array()},
          {"properties", nlohmann::json::array({{{"id", "feature-state"},
                                                 {"label", "Feature State"},
                                                 {"description", ""},
                                                 {"type", "string"},
                                                 {"nullable", false},
                                                 {"enumValues", nlohmann::json::array()}}})},
          {"inventories", nlohmann::json::array()}}});
    auto defaulted = required;
    defaulted["id"] = "defaulted-interactable";
    defaulted["properties"][0]["defaultValue"] = "ready";
    defaulted["features"][0]["properties"][0]["defaultValue"] = "feature-ready";
    document["definitions"]["interactables"].push_back(required);
    document["definitions"]["interactables"].push_back(defaulted);
    const auto project = decode_fixture(std::move(document), "runtime-required-properties.json");
    auto state_result = core::SessionState::create(project);
    REQUIRE(state_result);
    auto state = std::move(state_result).value();
    RuntimeWorld world(project, state);

    const auto before_count = state.runtime_interactables().size();
    const auto before_allocator = state.next_runtime_instance_id();
    auto missing = world.create_interactable_quantity(
        id<core::InteractableDefinitionId>("required-interactable"), 1,
        core::compiled::UnplacedLocation{});
    REQUIRE_FALSE(missing);
    CHECK(missing.error().front().code == "runtime.missing_required_property");
    CHECK(state.runtime_interactables().size() == before_count);
    CHECK(state.next_runtime_instance_id() == before_allocator);

    auto created = world.create_interactable_quantity(
        id<core::InteractableDefinitionId>("defaulted-interactable"), 1,
        core::compiled::UnplacedLocation{});
    REQUIRE(created);
    REQUIRE(created.value_if()->created.size() == 1);
    const auto created_id = created.value_if()->created.front();
    CHECK(created_id.text() == "runtime-interactable-1");
    core::PropertyResolver properties(project, state);
    auto value =
        properties.get(core::PropertyOwnerRef{created_id}, id<core::PropertyId>("runtime-state"));
    REQUIRE(value);
    const auto* runtime_value = std::get_if<core::RuntimeValue>(value.value_if());
    REQUIRE(runtime_value != nullptr);
    REQUIRE(std::get_if<std::string>(runtime_value) != nullptr);
    CHECK(*std::get_if<std::string>(runtime_value) == "ready");
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

TEST_CASE("runtime structural replacement validates dynamic Properties before schema introduction")
{
    auto document = load_fixture_document("comprehensive.json");
    document["traits"].push_back(
        {{"id", "runtime-schema"},
         {"label", "Runtime Schema"},
         {"description", ""},
         {"ownerKinds", nlohmann::json::array({"room"})},
         {"properties", nlohmann::json::array({{{"id", "runtime-value"},
                                                {"label", "Runtime Value"},
                                                {"description", ""},
                                                {"type", "string"},
                                                {"nullable", false},
                                                {"enumValues", nlohmann::json::array()},
                                                {"defaultValue", "fallback"}}})}});
    for (auto& room : document["definitions"]["rooms"])
        if (room["id"] == "hall")
            room["traits"].push_back("runtime-schema");
    const auto project = decode_fixture(std::move(document), "dynamic-structural-schema.json");
    auto state_result = core::SessionState::create(project);
    REQUIRE(state_result);
    auto state = std::move(state_result).value();
    RuntimeWorld world(project, state);
    core::PropertyResolver properties(project, state);

    auto runtime_room = world.create_room(
        CompiledInstanceConfiguration{core::GameplayInstanceRef{id<core::RoomId>("tower")}});
    REQUIRE(runtime_room);
    const core::PropertyOwnerRef owner{runtime_room.value()};
    const auto property = id<core::PropertyId>("runtime-value");
    REQUIRE(properties.set(owner, property, core::RuntimeValue{std::int64_t{7}}));
    const auto before_name = world.resolved_configuration(runtime_room.value())->display_name;

    auto incompatible = world.replace_structural_configuration(
        runtime_room.value(),
        CompiledInstanceConfiguration{core::GameplayInstanceRef{id<core::RoomId>("hall")}});
    REQUIRE_FALSE(incompatible);
    CHECK(incompatible.error().front().code == "runtime.invalid_structural_edit");
    REQUIRE(world.resolved_configuration(runtime_room.value()) != nullptr);
    CHECK(world.resolved_configuration(runtime_room.value())->display_name == before_name);
    CHECK(std::get<core::RuntimeValue>(properties.get(owner, property).value()) ==
          core::RuntimeValue{std::int64_t{7}});

    REQUIRE(properties.set(owner, property, core::RuntimeValue{std::string{"compatible"}}));
    REQUIRE(world.replace_structural_configuration(
        runtime_room.value(),
        CompiledInstanceConfiguration{core::GameplayInstanceRef{id<core::RoomId>("hall")}}));
    CHECK(std::get<core::RuntimeValue>(properties.get(owner, property).value()) ==
          core::RuntimeValue{std::string{"compatible"}});
    CHECK_FALSE(properties.set(owner, property, core::RuntimeValue{std::int64_t{8}}));
}

TEST_CASE("runtime structural replacement rejects dependent inventory invalidation atomically")
{
    const auto project = load_fixture_with_runtime_archetypes();
    auto state_result = core::SessionState::create(project);
    REQUIRE(state_result);
    auto state = std::move(state_result).value();
    RuntimeWorld world(project, state);

    const auto owner =
        create_from_declared_definition(world, project, id<core::InteractableInstanceId>("key"));
    const auto member =
        create_from_declared_definition(world, project, id<core::InteractableInstanceId>("dust"));
    const core::compiled::InventoryRef inventory{core::compiled::InteractableInventoryOwner{owner},
                                                 id<core::InventoryId>("hidden")};
    REQUIRE(world.move_interactable(member, core::compiled::InventoryLocation{inventory}));

    const auto before = world.resolved_configuration(owner)->display_name;
    auto replaced = world.replace_structural_configuration(
        owner, CompiledInstanceConfiguration{
                   core::GameplayInstanceRef{id<core::InteractableInstanceId>("dust")}});
    REQUIRE_FALSE(replaced);
    CHECK(replaced.error().front().code == "runtime.invalid_structural_edit");
    REQUIRE(world.resolved_configuration(owner) != nullptr);
    CHECK(world.resolved_configuration(owner)->display_name == before);
}

TEST_CASE("runtime structural replacement accepts a staged transaction that resolves nested "
          "Inventory occupants")
{
    const auto project = load_fixture("interaction-program.json");
    auto state_result = core::SessionState::create(project);
    REQUIRE(state_result);
    auto state = std::move(state_result).value();
    RuntimeWorld world(project, state);

    const auto key = id<core::InteractableInstanceId>("key");
    const auto dust = id<core::InteractableInstanceId>("dust");
    const auto surface = id<core::FeatureId>("surface");
    const core::compiled::InventoryRef groove{core::InteractableFeatureRef{key, surface},
                                              id<core::InventoryId>("groove")};
    const auto member = create_from_declared_definition(world, project, dust);
    REQUIRE(world.move_interactable(member, core::compiled::InventoryLocation{groove}));

    auto blocked = world.replace_structural_configuration(
        key, CompiledInstanceConfiguration{core::GameplayInstanceRef{dust}});
    REQUIRE_FALSE(blocked);
    CHECK(blocked.error().front().code == "runtime.invalid_structural_edit");
    CHECK(world.has_inventory(groove));
    REQUIRE(world.interactable_state(member) != nullptr);

    auto staged_state = state;
    RuntimeWorld staged_world(project, staged_state);
    REQUIRE(staged_world.destroy(core::GameplayInstanceRef{member}));
    REQUIRE(staged_world.replace_structural_configuration(
        key, CompiledInstanceConfiguration{core::GameplayInstanceRef{dust}}));

    state = std::move(staged_state);
    RuntimeWorld committed_world(project, state);
    CHECK(committed_world.interactable_state(member) == nullptr);
    CHECK_FALSE(committed_world.has_inventory(groove));
    REQUIRE(committed_world.resolved_configuration(key) != nullptr);
    const auto* dust_declaration = project.find_interactable_instance(dust);
    REQUIRE(dust_declaration != nullptr);
    CHECK(committed_world.resolved_configuration(key)->display_name ==
          project.find_interactable_definition(dust_declaration->definition)->display_name);
}

TEST_CASE("runtime structural clear rejects dependent invalidation atomically")
{
    const auto project = load_fixture_with_runtime_archetypes();
    auto state_result = core::SessionState::create(project);
    REQUIRE(state_result);
    auto state = std::move(state_result).value();
    RuntimeWorld world(project, state);

    const auto dust = id<core::InteractableInstanceId>("dust");
    const auto key = id<core::InteractableInstanceId>("key");
    const auto owner = create_from_declared_definition(world, project, dust);
    REQUIRE(world.replace_structural_configuration(
        owner, CompiledInstanceConfiguration{core::GameplayInstanceRef{key}}));
    const auto member = create_from_declared_definition(world, project, dust);
    const core::compiled::InventoryRef inventory{core::compiled::InteractableInventoryOwner{owner},
                                                 id<core::InventoryId>("hidden")};
    REQUIRE(world.move_interactable(member, core::compiled::InventoryLocation{inventory}));

    auto cleared = world.clear_structural_configuration(owner);
    REQUIRE_FALSE(cleared);
    CHECK(cleared.error().front().code == "runtime.invalid_structural_edit");
    REQUIRE(world.resolved_configuration(owner) != nullptr);
    const auto* key_instance = project.find_interactable_instance(key);
    REQUIRE(key_instance != nullptr);
    CHECK(world.resolved_configuration(owner)->display_name ==
          project.find_interactable_definition(key_instance->definition)->display_name);
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
    const auto interactable =
        create_from_declared_definition(world, project, id<core::InteractableInstanceId>("coin"),
                                        core::compiled::RoomLocation{room.value()}, true, false,
                                        InteractableRoomPresentationPolicy::None);

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
    REQUIRE(restored_world.interactable_state(interactable) != nullptr);
    CHECK_FALSE(restored_world.interactable_state(interactable)->visible);
    const auto* provenance =
        restored_world.provenance(core::GameplayInstanceRef{character.value()});
    REQUIRE(provenance != nullptr);
    CHECK(provenance->kind == core::RuntimeInstanceProvenanceKind::Archetype);
    CHECK(provenance->archetype == id<core::ArchetypeId>("runtime-character"));
    CHECK(restored.next_runtime_instance_id() == 4);

    const auto next = create_from_declared_definition(restored_world, project,
                                                      id<core::InteractableInstanceId>("dust"));
    CHECK(next.text() == "runtime-interactable-4");
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

    const auto declared_interactable = id<core::InteractableInstanceId>("key");
    REQUIRE(world.destroy(core::GameplayInstanceRef{declared_interactable}));
    CHECK(world.resolved_configuration(declared_interactable) == nullptr);
    CHECK(world.interactable_state(declared_interactable) == nullptr);

    auto saved = core::make_save_state(project, state);
    REQUIRE(saved);
    auto encoded = core::encode_save_state(project, saved.value());
    REQUIRE(encoded);
    auto decoded =
        core::decode_save_state(project, encoded.value(), "declared-interactable-tombstone");
    REQUIRE(decoded);
    auto restored_result = test_support::restore_session(project, decoded.value());
    REQUIRE(restored_result);
    auto restored = std::move(restored_result).value();
    RuntimeWorld restored_world(project, restored);
    CHECK(restored_world.resolved_configuration(declared_interactable) == nullptr);
    CHECK(restored_world.interactable_state(declared_interactable) == nullptr);
}

} // namespace
} // namespace noveltea::runtime
