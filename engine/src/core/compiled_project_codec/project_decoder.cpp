#include "internal.hpp"

namespace noveltea::core::compiled::wire {
using namespace detail;

Result<Condition, Diagnostics> decode_condition(const nlohmann::json& value,
                                                std::string source_path, std::string json_pointer)
{
    Decoder decoder(std::move(source_path));
    auto result = decode_condition_impl(decoder, value, json_pointer);
    if (!result || decoder.failed())
        return Result<Condition, Diagnostics>::failure(decoder.take_diagnostics());
    return Result<Condition, Diagnostics>::success(std::move(*result));
}

Result<Effect, Diagnostics> decode_effect(const nlohmann::json& value, std::string source_path,
                                          std::string json_pointer)
{
    Decoder decoder(std::move(source_path));
    auto result = decode_effect_impl(decoder, value, json_pointer);
    if (!result || decoder.failed())
        return Result<Effect, Diagnostics>::failure(decoder.take_diagnostics());
    return Result<Effect, Diagnostics>::success(std::move(*result));
}

Result<FlowTarget, Diagnostics>
decode_flow_target(const nlohmann::json& value, std::string source_path, std::string json_pointer)
{
    Decoder decoder(std::move(source_path));
    auto result = decode_flow_target_impl(decoder, value, json_pointer);
    if (!result || decoder.failed())
        return Result<FlowTarget, Diagnostics>::failure(decoder.take_diagnostics());
    return Result<FlowTarget, Diagnostics>::success(std::move(*result));
}

Result<SharedProject, Diagnostics> decode_shared_project(const nlohmann::json& document,
                                                         std::string source_path)
{
    Decoder decoder(std::move(source_path));
    if (!decoder.object(document, "",
                        {"archetypes", "bootstrapModule", "definitions", "entrypoint",
                         "inventories", "localization", "project", "properties", "resources",
                         "itemStacks", "saveContract", "schema", "schemaVersion", "settings",
                         "traits", "undefinedInteractionProgram"}))
        return Result<SharedProject, Diagnostics>::failure(decoder.take_diagnostics());

    const auto* schema_value = decoder.member(document, "schema", "");
    const auto* version_value = decoder.member(document, "schemaVersion", "");
    const auto* project_value = decoder.member(document, "project", "");
    const auto* settings_value = decoder.member(document, "settings", "");
    const auto* entrypoint_value = decoder.member(document, "entrypoint", "");
    const auto* bootstrap_value = decoder.member(document, "bootstrapModule", "");
    const auto* save_contract_value = decoder.member(document, "saveContract", "");
    const auto* localization_value = decoder.member(document, "localization", "");
    const auto* inventories_value = decoder.member(document, "inventories", "");
    const auto* item_stacks_value = decoder.member(document, "itemStacks", "");
    const auto* properties_value = decoder.member(document, "properties", "");
    const auto* traits_value = decoder.member(document, "traits", "");
    const auto* archetypes_value = decoder.member(document, "archetypes", "");
    const auto* resources_value = decoder.member(document, "resources", "");
    const auto* definitions_value = decoder.member(document, "definitions", "");
    const auto undefined_interaction_iter = document.find("undefinedInteractionProgram");
    const auto* undefined_interaction_value =
        undefined_interaction_iter == document.end() ? nullptr : &*undefined_interaction_iter;

    auto schema = schema_value ? decoder.string(*schema_value, "/schema") : std::nullopt;
    if (schema && *schema != "noveltea.compiled.project") {
        if (*schema == "noveltea.runtime.project")
            decoder.error("compiled_project.unsupported_provisional_schema",
                          "The provisional 'noveltea.runtime.project' schema is unsupported; "
                          "expected 'noveltea.compiled.project' version 4.",
                          "/schema");
        else
            decoder.error("compiled_project.unsupported_schema",
                          "Expected schema 'noveltea.compiled.project'.", "/schema");
        schema.reset();
    }
    auto version = version_value
                       ? decoder.unsigned_integer<std::uint32_t>(*version_value, "/schemaVersion")
                       : std::nullopt;
    if (version && *version != 4) {
        decoder.error("compiled_project.unsupported_version", "Only schema version 4 is supported.",
                      "/schemaVersion");
        version.reset();
    }
    auto identity =
        project_value ? decode_project_identity(decoder, *project_value, "/project") : std::nullopt;
    auto settings =
        settings_value ? decode_settings(decoder, *settings_value, "/settings") : std::nullopt;
    auto entrypoint = entrypoint_value
                          ? decode_entrypoint(decoder, *entrypoint_value, "/entrypoint")
                          : std::nullopt;
    auto bootstrap = bootstrap_value ? decode_reference<ScriptId>(decoder, *bootstrap_value,
                                                                  "/bootstrapModule", "script")
                                     : std::nullopt;
    auto save_contract =
        save_contract_value ? decoder.string(*save_contract_value, "/saveContract") : std::nullopt;
    if (save_contract) {
        const auto suffix = std::string_view(*save_contract)
                                .substr(std::min<std::size_t>(4, save_contract->size()));
        const bool lowercase_hex = std::ranges::all_of(suffix, [](const char character) {
            return (character >= '0' && character <= '9') || (character >= 'a' && character <= 'f');
        });
        if (!save_contract->starts_with("sc1:") || save_contract->size() != 36 || !lowercase_hex) {
            decoder.error("compiled_project.invalid_save_contract",
                          "Save Contract must use canonical 'sc1:' identity spelling.",
                          "/saveContract");
            save_contract.reset();
        }
    }
    auto localization = localization_value
                            ? decode_localization(decoder, *localization_value, "/localization")
                            : std::nullopt;
    bool undefined_interaction_valid = true;
    std::optional<InteractionProgram> undefined_interaction_program;
    if (undefined_interaction_value && !undefined_interaction_value->is_null()) {
        auto decoded = decode_interaction_program(decoder, *undefined_interaction_value,
                                                  "/undefinedInteractionProgram");
        undefined_interaction_valid = decoded.has_value();
        if (decoded)
            undefined_interaction_program = std::move(*decoded);
    }
    auto inventories =
        inventories_value
            ? decoder.array<InventoryDefinition>(
                  *inventories_value, "/inventories",
                  [&](const nlohmann::json& item,
                      const std::string& pointer) -> std::optional<InventoryDefinition> {
                      if (!decoder.object(item, pointer, {"id", "label"}))
                          return std::nullopt;
                      const auto* id_value = decoder.member(item, "id", pointer);
                      const auto* label_value = decoder.member(item, "label", pointer);
                      auto id = id_value ? decoder.id<InventoryId>(*id_value,
                                                                   pointer_child(pointer, "id"))
                                         : std::nullopt;
                      auto label = label_value ? decoder.string(*label_value,
                                                                pointer_child(pointer, "label"))
                                               : std::nullopt;
                      return id && label ? std::optional<InventoryDefinition>(InventoryDefinition{
                                               std::move(*id), std::move(*label)})
                                         : std::nullopt;
                  })
            : std::nullopt;
    auto properties = properties_value
                          ? decoder.array<PropertyDeclaration>(
                                *properties_value, "/properties",
                                [&](const nlohmann::json& item, const std::string& pointer) {
                                    return decode_property(decoder, item, pointer);
                                })
                          : std::nullopt;
    auto item_stacks =
        item_stacks_value
            ? decoder.array<ItemStackDeclaration>(
                  *item_stacks_value, "/itemStacks",
                  [&](const nlohmann::json& item,
                      const std::string& pointer) -> std::optional<ItemStackDeclaration> {
                      if (!decoder.object(item, pointer,
                                          {"definition", "id", "location", "quantity"}))
                          return std::nullopt;
                      const auto* id_value = decoder.member(item, "id", pointer);
                      const auto* definition_value = decoder.member(item, "definition", pointer);
                      const auto* quantity_value = decoder.member(item, "quantity", pointer);
                      const auto* location_value = decoder.member(item, "location", pointer);
                      auto id = id_value ? decoder.id<ItemStackId>(*id_value,
                                                                   pointer_child(pointer, "id"))
                                         : std::nullopt;
                      auto definition = definition_value ? decode_reference<ItemDefinitionId>(
                                                               decoder, *definition_value,
                                                               pointer_child(pointer, "definition"),
                                                               "item-definition")
                                                         : std::nullopt;
                      auto quantity = quantity_value ? decoder.unsigned_integer<std::uint64_t>(
                                                           *quantity_value,
                                                           pointer_child(pointer, "quantity"), true)
                                                     : std::nullopt;
                      if (quantity && *quantity > max_item_stack_quantity) {
                          decoder.error(k_code_number,
                                        "Item Stack quantity exceeds the portable numeric range.",
                                        pointer_child(pointer, "quantity"));
                          quantity.reset();
                      }
                      auto location = location_value
                                          ? decode_location(decoder, *location_value,
                                                            pointer_child(pointer, "location"))
                                          : std::nullopt;
                      return id && definition && quantity && location
                                 ? std::optional<ItemStackDeclaration>(
                                       ItemStackDeclaration{std::move(*id), std::move(*definition),
                                                            *quantity, std::move(*location)})
                                 : std::nullopt;
                  })
            : std::nullopt;
    auto traits = traits_value ? decoder.array<TraitDeclaration>(
                                     *traits_value, "/traits",
                                     [&](const nlohmann::json& item, const std::string& pointer) {
                                         return decode_trait(decoder, item, pointer);
                                     })
                               : std::nullopt;
    auto archetypes = archetypes_value
                          ? decoder.array<ArchetypeDefinition>(
                                *archetypes_value, "/archetypes",
                                [&](const nlohmann::json& item, const std::string& pointer) {
                                    return decode_archetype(decoder, item, pointer);
                                })
                          : std::nullopt;

    std::optional<std::vector<AssetResource>> assets;
    std::optional<std::vector<LayoutResource>> layouts;
    std::optional<std::vector<MaterialInterfaceResource>> material_interfaces;
    std::optional<std::vector<ScriptResource>> scripts;
    if (resources_value && decoder.object(*resources_value, "/resources",
                                          {"assets", "layouts", "materialInterfaces", "scripts"})) {
        const auto* assets_value = decoder.member(*resources_value, "assets", "/resources");
        const auto* layouts_value = decoder.member(*resources_value, "layouts", "/resources");
        const auto* material_interfaces_value =
            decoder.member(*resources_value, "materialInterfaces", "/resources");
        const auto* scripts_value = decoder.member(*resources_value, "scripts", "/resources");
        if (assets_value)
            assets = decoder.array<AssetResource>(
                *assets_value, "/resources/assets",
                [&](const nlohmann::json& item, const std::string& pointer) {
                    return decode_asset(decoder, item, pointer);
                });
        if (layouts_value)
            layouts = decoder.array<LayoutResource>(
                *layouts_value, "/resources/layouts",
                [&](const nlohmann::json& item, const std::string& pointer) {
                    return decode_layout(decoder, item, pointer);
                });
        if (material_interfaces_value)
            material_interfaces = decoder.array<MaterialInterfaceResource>(
                *material_interfaces_value, "/resources/materialInterfaces",
                [&](const nlohmann::json& item,
                    const std::string& pointer) -> std::optional<MaterialInterfaceResource> {
                    if (!decoder.object(item, pointer,
                                        {"id", "parameters", "postprocessScope", "role"}))
                        return std::nullopt;
                    const auto* id_value = decoder.member(item, "id", pointer);
                    const auto* role_value = decoder.member(item, "role", pointer);
                    const auto* scope_value = decoder.member(item, "postprocessScope", pointer);
                    const auto* parameters_value = decoder.member(item, "parameters", pointer);
                    auto id = id_value
                                  ? decoder.id<MaterialId>(*id_value, pointer_child(pointer, "id"))
                                  : std::nullopt;
                    auto role = role_value
                                    ? decoder.enumeration<MaterialRole>(
                                          *role_value, pointer_child(pointer, "role"),
                                          {{"engine-2d", MaterialRole::Engine2D},
                                           {"active-text", MaterialRole::ActiveText},
                                           {"rmlui-decorator", MaterialRole::RmlUiDecorator},
                                           {"rmlui-filter", MaterialRole::RmlUiFilter},
                                           {"postprocess", MaterialRole::Postprocess},
                                           {"hotspot-overlay", MaterialRole::HotspotOverlay}})
                                    : std::nullopt;
                    auto scope = scope_value
                                     ? decoder.enumeration<MaterialPostprocessScope>(
                                           *scope_value, pointer_child(pointer, "postprocessScope"),
                                           {{"world", MaterialPostprocessScope::World},
                                            {"full-game-viewport",
                                             MaterialPostprocessScope::FullGameViewport}})
                                     : std::nullopt;
                    auto parameters =
                        parameters_value
                            ? decoder.array<MaterialParameterDeclaration>(
                                  *parameters_value, pointer_child(pointer, "parameters"),
                                  [&](const nlohmann::json& parameter,
                                      const std::string& parameter_pointer)
                                      -> std::optional<MaterialParameterDeclaration> {
                                      if (!decoder.object(parameter, parameter_pointer,
                                                          {"name", "rendererBinding", "type"}))
                                          return std::nullopt;
                                      const auto* name_value =
                                          decoder.member(parameter, "name", parameter_pointer);
                                      const auto* type_value =
                                          decoder.member(parameter, "type", parameter_pointer);
                                      const auto* binding_value = decoder.member(
                                          parameter, "rendererBinding", parameter_pointer);
                                      auto name =
                                          name_value ? decoder.string(
                                                           *name_value,
                                                           pointer_child(parameter_pointer, "name"))
                                                     : std::nullopt;
                                      auto type =
                                          type_value ? decoder.enumeration<MaterialParameterType>(
                                                           *type_value,
                                                           pointer_child(parameter_pointer, "type"),
                                                           {{"float", MaterialParameterType::Float},
                                                            {"vec2", MaterialParameterType::Vec2},
                                                            {"vec3", MaterialParameterType::Vec3},
                                                            {"vec4", MaterialParameterType::Vec4},
                                                            {"color", MaterialParameterType::Color},
                                                            {"int", MaterialParameterType::Int},
                                                            {"bool", MaterialParameterType::Bool}})
                                                     : std::nullopt;
                                      std::optional<std::string> binding;
                                      bool binding_ok = binding_value != nullptr;
                                      if (binding_value && !binding_value->is_null()) {
                                          binding = decoder.string(
                                              *binding_value,
                                              pointer_child(parameter_pointer, "rendererBinding"));
                                          binding_ok = binding.has_value();
                                      }
                                      return name && type && binding_ok
                                                 ? std::optional<MaterialParameterDeclaration>(
                                                       MaterialParameterDeclaration{
                                                           std::move(*name), *type,
                                                           std::move(binding)})
                                                 : std::nullopt;
                                  })
                            : std::nullopt;
                    if (parameters) {
                        std::unordered_set<std::string> names;
                        for (std::size_t index = 0; index < parameters->size(); ++index) {
                            if (!names.emplace((*parameters)[index].name).second)
                                decoder.error(k_code_duplicate,
                                              "Duplicate Material Parameter declaration name.",
                                              pointer_child(pointer_child(pointer, "parameters"),
                                                            std::to_string(index)) +
                                                  "/name");
                        }
                    }
                    return id && role && scope && parameters
                               ? std::optional<MaterialInterfaceResource>(MaterialInterfaceResource{
                                     std::move(*id), *role, *scope, std::move(*parameters)})
                               : std::nullopt;
                });
        if (scripts_value)
            scripts = decoder.array<ScriptResource>(
                *scripts_value, "/resources/scripts",
                [&](const nlohmann::json& item, const std::string& pointer) {
                    return decode_script(decoder, item, pointer);
                });
    }

    std::optional<std::vector<CharacterDefinition>> characters;
    std::optional<std::vector<RoomDefinition>> rooms;
    std::optional<std::vector<InteractableDefinition>> interactables;
    std::optional<std::vector<ItemDefinition>> item_definitions;
    std::optional<std::vector<VerbDefinition>> verbs;
    std::optional<std::vector<InteractionDefinition>> interactions;
    std::optional<std::vector<SceneDefinition>> scenes;
    std::optional<std::vector<DialogueDefinition>> dialogues;
    std::optional<std::vector<MapDefinition>> maps;
    if (definitions_value &&
        decoder.object(*definitions_value, "/definitions",
                       {"characters", "dialogues", "interactables", "interactions",
                        "itemDefinitions", "maps", "rooms", "scenes", "verbs"})) {
#define NOVELTEA_DECODE_DEFINITION(member_name, variable_name, type_name, function_name)           \
    if (const auto* collection = decoder.member(*definitions_value, member_name, "/definitions"))  \
    variable_name =                                                                                \
        decoder.array<type_name>(*collection, "/definitions/" member_name,                         \
                                 [&](const nlohmann::json& item, const std::string& pointer) {     \
                                     return function_name(decoder, item, pointer);                 \
                                 })
        NOVELTEA_DECODE_DEFINITION("characters", characters, CharacterDefinition, decode_character);
        NOVELTEA_DECODE_DEFINITION("rooms", rooms, RoomDefinition, decode_room);
        NOVELTEA_DECODE_DEFINITION("interactables", interactables, InteractableDefinition,
                                   decode_interactable);
        NOVELTEA_DECODE_DEFINITION("itemDefinitions", item_definitions, ItemDefinition,
                                   decode_item_definition);
        NOVELTEA_DECODE_DEFINITION("verbs", verbs, VerbDefinition, decode_verb);
        NOVELTEA_DECODE_DEFINITION("interactions", interactions, InteractionDefinition,
                                   decode_interaction);
        NOVELTEA_DECODE_DEFINITION("scenes", scenes, SceneDefinition, decode_scene);
        NOVELTEA_DECODE_DEFINITION("dialogues", dialogues, DialogueDefinition, decode_dialogue);
        NOVELTEA_DECODE_DEFINITION("maps", maps, MapDefinition, decode_map);
#undef NOVELTEA_DECODE_DEFINITION
    }

    if (inventories)
        decoder.duplicate_ids(
            *inventories, "/inventories",
            [](const InventoryDefinition& value) -> const InventoryId& { return value.id; });
    if (properties)
        decoder.duplicate_ids(
            *properties, "/properties",
            [](const PropertyDeclaration& value) -> const PropertyId& { return value.id; });
    if (item_stacks)
        decoder.duplicate_ids(
            *item_stacks, "/itemStacks",
            [](const ItemStackDeclaration& value) -> const ItemStackId& { return value.id; });
    if (traits)
        decoder.duplicate_ids(
            *traits, "/traits",
            [](const TraitDeclaration& value) -> const TraitId& { return value.id; });
    if (archetypes)
        decoder.duplicate_ids(
            *archetypes, "/archetypes",
            [](const ArchetypeDefinition& value) -> const ArchetypeId& { return value.id; });
    if (assets)
        decoder.duplicate_ids(
            *assets, "/resources/assets",
            [](const AssetResource& value) -> const AssetId& { return value.id; });
    if (layouts)
        decoder.duplicate_ids(
            *layouts, "/resources/layouts",
            [](const LayoutResource& value) -> const LayoutId& { return value.id; });
    if (material_interfaces)
        decoder.duplicate_ids(
            *material_interfaces, "/resources/materialInterfaces",
            [](const MaterialInterfaceResource& value) -> const MaterialId& { return value.id; });
    if (scripts)
        decoder.duplicate_ids(
            *scripts, "/resources/scripts",
            [](const ScriptResource& value) -> const ScriptId& { return value.id; });
#define NOVELTEA_DUPLICATE_DEFINITION(variable_name, pointer, id_type)                             \
    if (variable_name)                                                                             \
    decoder.duplicate_ids(*variable_name, pointer,                                                 \
                          [](const auto& value) -> const id_type& { return value.identity.id; })
    NOVELTEA_DUPLICATE_DEFINITION(characters, "/definitions/characters", CharacterId);
    NOVELTEA_DUPLICATE_DEFINITION(rooms, "/definitions/rooms", RoomId);
    NOVELTEA_DUPLICATE_DEFINITION(interactables, "/definitions/interactables", InteractableId);
    NOVELTEA_DUPLICATE_DEFINITION(item_definitions, "/definitions/itemDefinitions",
                                  ItemDefinitionId);
    NOVELTEA_DUPLICATE_DEFINITION(verbs, "/definitions/verbs", VerbId);
    NOVELTEA_DUPLICATE_DEFINITION(interactions, "/definitions/interactions", InteractionId);
    NOVELTEA_DUPLICATE_DEFINITION(scenes, "/definitions/scenes", SceneId);
    NOVELTEA_DUPLICATE_DEFINITION(dialogues, "/definitions/dialogues", DialogueId);
    NOVELTEA_DUPLICATE_DEFINITION(maps, "/definitions/maps", MapId);
#undef NOVELTEA_DUPLICATE_DEFINITION

    const bool complete = schema && version && identity && settings && entrypoint && bootstrap &&
                          save_contract && localization && inventories && properties && traits &&
                          archetypes && item_stacks && assets && layouts && material_interfaces &&
                          scripts && characters && rooms && interactables && item_definitions &&
                          verbs && interactions && undefined_interaction_valid && scenes &&
                          dialogues && maps;
    if (!complete || decoder.failed())
        return Result<SharedProject, Diagnostics>::failure(decoder.take_diagnostics());

    return Result<SharedProject, Diagnostics>::success(
        SharedProject{std::move(*identity),
                      std::move(*settings),
                      std::move(*entrypoint),
                      std::move(*bootstrap),
                      std::move(*save_contract),
                      std::move(*localization),
                      std::move(*properties),
                      std::move(*traits),
                      std::move(*archetypes),
                      std::move(*inventories),
                      std::move(*assets),
                      std::move(*layouts),
                      std::move(*material_interfaces),
                      std::move(*scripts),
                      std::move(*characters),
                      std::move(*rooms),
                      std::move(*interactables),
                      std::move(*item_definitions),
                      std::move(*item_stacks),
                      std::move(*verbs),
                      std::move(*interactions),
                      std::move(undefined_interaction_program),
                      std::move(*scenes),
                      std::move(*dialogues),
                      std::move(*maps)});
}

} // namespace noveltea::core::compiled::wire
