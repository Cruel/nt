#pragma once

#include "noveltea/core/domain_ids.hpp"
#include "noveltea/core/gameplay_references.hpp"
#include "noveltea/core/runtime_value.hpp"
#include "noveltea/core/text_content.hpp"

#include <cstdint>
#include <optional>
#include <string>
#include <utility>
#include <variant>
#include <vector>

namespace noveltea::core {

enum class ValueComparisonOperator : std::uint8_t {
    Equal,
    NotEqual,
    Less,
    LessEqual,
    Greater,
    GreaterEqual
};
enum class TruthinessOperator : std::uint8_t {
    Truthy,
    Falsy
};
struct GlobalPropertyValueComparison {
    PropertyId property_id;
    ValueComparisonOperator operation;
    RuntimeValue value;
    bool operator==(const GlobalPropertyValueComparison&) const = default;
};
struct GlobalPropertyTruthiness {
    PropertyId property_id;
    TruthinessOperator operation;
    bool operator==(const GlobalPropertyTruthiness&) const = default;
};
using GlobalPropertyComparison =
    std::variant<GlobalPropertyValueComparison, GlobalPropertyTruthiness>;
struct Always {
    bool operator==(const Always&) const = default;
};
struct LuaPredicate {
    std::string source;
    bool operator==(const LuaPredicate&) const = default;
};

struct InteractablePropertyMatch {
    PropertyId property_id;
    RuntimeValue value;
    bool operator==(const InteractablePropertyMatch&) const = default;
};
struct ConditionInteractableMatcher {
    std::optional<InteractableDefinitionId> definition;
    std::vector<TraitId> traits;
    std::vector<InteractablePropertyMatch> properties;
    std::optional<InteractableOperand> exact;
    bool operator==(const ConditionInteractableMatcher&) const = default;
};

struct IdentityPropertyValueComparison {
    GameplayIdentityOperand owner;
    PropertyId property_id;
    ValueComparisonOperator operation;
    RuntimeValue value;
    bool operator==(const IdentityPropertyValueComparison&) const = default;
};
struct IdentityPropertyTruthiness {
    GameplayIdentityOperand owner;
    PropertyId property_id;
    TruthinessOperator operation;
    bool operator==(const IdentityPropertyTruthiness&) const = default;
};
using IdentityPropertyComparison =
    std::variant<IdentityPropertyValueComparison, IdentityPropertyTruthiness>;
struct TraitPresenceCondition {
    GameplayIdentityOperand owner;
    TraitId trait;
    bool present = true;
    bool operator==(const TraitPresenceCondition&) const = default;
};
enum class EqualityComparisonOperator : std::uint8_t {
    Equal,
    NotEqual
};
struct LocationComparisonCondition {
    LocationSubjectOperand subject;
    EqualityComparisonOperator operation = EqualityComparisonOperator::Equal;
    LocationOperand location;
    bool operator==(const LocationComparisonCondition&) const = default;
};
struct InventoryQuantityComparisonCondition {
    InventoryOperand inventory;
    ConditionInteractableMatcher matcher;
    ValueComparisonOperator operation = ValueComparisonOperator::Equal;
    std::uint64_t quantity = 0;
    bool operator==(const InventoryQuantityComparisonCondition&) const = default;
};

struct Condition;
struct AllCondition {
    std::vector<Condition> conditions;
    bool operator==(const AllCondition&) const = default;
};
struct AnyCondition {
    std::vector<Condition> conditions;
    bool operator==(const AnyCondition&) const = default;
};
struct NotCondition {
    std::vector<Condition> condition;
    bool operator==(const NotCondition&) const = default;
};

struct Condition {
    using Value = std::variant<Always, AllCondition, AnyCondition, NotCondition,
                               GlobalPropertyComparison, IdentityPropertyComparison,
                               TraitPresenceCondition, LocationComparisonCondition,
                               InventoryQuantityComparisonCondition, LuaPredicate>;

    Condition() : value(Always{}) {}
    template<class T> Condition(T item) : value(std::move(item)) {}

    Value value;
    bool operator==(const Condition&) const = default;
};

struct SetGlobalProperty {
    PropertyId property_id;
    RuntimeValue value;
};
struct RunLuaEffect {
    std::string source;
};
using Effect = std::variant<SetGlobalProperty, RunLuaEffect>;

enum class GameplayConfigurationSourceKind : std::uint8_t {
    Archetype,
    CompiledInstance,
    EffectiveInstance,
};
struct GameplayConfigurationSource {
    GameplayConfigurationSourceKind kind = GameplayConfigurationSourceKind::CompiledInstance;
    std::variant<ArchetypeId, GameplayIdentityOperand> source;
};

struct SetGlobalPropertyCommand {
    PropertyId property;
    RuntimeValue value;
};
struct UnsetGlobalPropertyCommand {
    PropertyId property;
};
struct SetPropertyCommand {
    GameplayIdentityOperand owner;
    PropertyId property;
    RuntimeValue value;
};
struct UnsetPropertyCommand {
    GameplayIdentityOperand owner;
    PropertyId property;
};
struct AddTraitCommand {
    GameplayIdentityOperand owner;
    TraitId trait;
};
struct RemoveTraitCommand {
    GameplayIdentityOperand owner;
    TraitId trait;
};
struct SetEnabledCommand {
    LocationSubjectOperand subject;
    bool enabled = true;
};
struct SetVisibleCommand {
    LocationSubjectOperand subject;
    bool visible = true;
};
struct MoveInstanceCommand {
    LocationSubjectOperand subject;
    LocationOperand location;
};
struct CreateRoomCommand {
    GameplayConfigurationSource source;
    std::optional<CommandResultBindingId> result;
};
struct CreateCharacterCommand {
    GameplayConfigurationSource source;
    LocationOperand location;
    bool enabled = true;
    bool visible = true;
    std::optional<CommandResultBindingId> result;
};
struct CreateInteractableCommand {
    GameplayConfigurationSource source;
    LocationOperand location;
    bool enabled = true;
    bool visible = true;
    std::optional<CommandResultBindingId> result;
};
struct DestroyInstanceCommand {
    GameplayIdentityOperand instance;
};
struct SplitQuantityCommand {
    InteractableOperand source;
    std::uint64_t quantity = 0;
    std::optional<CommandResultBindingId> result;
};
struct MergeQuantityCommand {
    InteractableOperand receiver;
    InteractableOperand donor;
};
struct TransferQuantityCommand {
    std::variant<InteractableOperand, ConditionInteractableMatcher> source;
    std::optional<InventoryOperand> source_inventory;
    std::uint64_t quantity = 0;
    LocationOperand location;
    std::optional<CommandResultBindingId> result;
};
struct AddQuantityCommand {
    InteractableDefinitionId definition;
    std::uint64_t quantity = 0;
    LocationOperand location;
};
struct ConsumeQuantityCommand {
    std::variant<InteractableOperand, ConditionInteractableMatcher> source;
    std::optional<InventoryOperand> source_inventory;
    std::uint64_t quantity = 0;
};
struct CallSceneCommand {
    SceneId scene;
};
struct CallDialogueCommand {
    DialogueId dialogue;
};
struct NotifyCommand {
    TextContent message;
};
struct RunLuaCommand {
    std::string source;
};

struct GameplayCommand;
struct IfGameplayCommand {
    Condition condition;
    std::vector<GameplayCommand> then_commands;
    std::vector<GameplayCommand> else_commands;
};
struct GameplayCommand {
    using Value =
        std::variant<SetGlobalPropertyCommand, UnsetGlobalPropertyCommand, SetPropertyCommand,
                     UnsetPropertyCommand, AddTraitCommand, RemoveTraitCommand, SetEnabledCommand,
                     SetVisibleCommand, MoveInstanceCommand, CreateRoomCommand,
                     CreateCharacterCommand, CreateInteractableCommand, DestroyInstanceCommand,
                     SplitQuantityCommand, MergeQuantityCommand, TransferQuantityCommand,
                     AddQuantityCommand, ConsumeQuantityCommand, CallSceneCommand,
                     CallDialogueCommand, NotifyCommand, RunLuaCommand, IfGameplayCommand>;

    InteractionInstructionId id;
    Value value;
};

struct ReturnFlow {};
struct EndFlow {};
using FlowTarget = std::variant<SceneId, DialogueId, RoomId, ReturnFlow, EndFlow>;

} // namespace noveltea::core
