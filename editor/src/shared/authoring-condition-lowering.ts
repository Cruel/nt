import type {
  Condition,
  GameplayIdentityOperand,
  InteractableMatcher,
  InteractableOperand,
  InventoryOperand,
  InventoryOwnerOperand,
  LocationOperand,
  LocationSubjectOperand,
  RoomOperand,
} from './project-schema/authoring-flow';
import type { CompiledCondition } from './project-schema/compiled-project';

export function compileIdentityOperand(owner: GameplayIdentityOperand) {
  switch (owner.kind) {
    case 'room':
      return { kind: 'room' as const, room: { kind: 'room' as const, id: owner.room.$ref.id } };
    case 'character':
      return {
        kind: 'character' as const,
        character: { kind: 'character' as const, id: owner.character.$ref.id },
      };
    case 'interactable':
      return {
        kind: 'interactable' as const,
        interactable: { kind: 'interactable' as const, id: owner.interactable.$ref.id },
      };
    case 'room-feature':
      return {
        kind: 'room-feature' as const,
        room: { kind: 'room' as const, id: owner.room.$ref.id },
        featureId: owner.featureId,
      };
    case 'interactable-feature':
      return {
        kind: 'interactable-feature' as const,
        interactable: { kind: 'interactable' as const, id: owner.interactable.$ref.id },
        featureId: owner.featureId,
      };
    case 'current-room':
      return { kind: 'current-room' as const };
    case 'interaction-slot':
      return { kind: 'interaction-slot' as const, slotId: owner.slotId };
    case 'command-result':
      return { kind: 'command-result' as const, bindingId: owner.bindingId };
  }
}

export function compileInteractableOperand(operand: InteractableOperand) {
  if (operand.kind === 'interactable') {
    return {
      kind: 'interactable' as const,
      interactable: { kind: 'interactable' as const, id: operand.interactable.$ref.id },
    };
  }
  return { ...operand };
}

export function compileLocationSubjectOperand(operand: LocationSubjectOperand) {
  if (operand.kind === 'character') {
    return {
      kind: 'character' as const,
      character: { kind: 'character' as const, id: operand.character.$ref.id },
    };
  }
  if (operand.kind === 'interactable') return compileInteractableOperand(operand);
  return { ...operand };
}

export function compileRoomOperand(operand: RoomOperand) {
  if (operand.kind === 'room') {
    return { kind: 'room' as const, room: { kind: 'room' as const, id: operand.room.$ref.id } };
  }
  return { ...operand };
}

function compileInventoryOwnerOperand(owner: InventoryOwnerOperand) {
  if (
    owner.kind === 'project' ||
    owner.kind === 'interaction-slot' ||
    owner.kind === 'command-result'
  )
    return { ...owner };
  if (owner.kind === 'character') {
    return {
      kind: 'character' as const,
      character: { kind: 'character' as const, id: owner.character.$ref.id },
    };
  }
  if (owner.kind === 'interactable') return compileInteractableOperand(owner);
  if (owner.kind === 'room-feature') {
    return {
      kind: 'room-feature' as const,
      room: { kind: 'room' as const, id: owner.room.$ref.id },
      featureId: owner.featureId,
    };
  }
  return {
    kind: 'interactable-feature' as const,
    interactable: { kind: 'interactable' as const, id: owner.interactable.$ref.id },
    featureId: owner.featureId,
  };
}

export function compileInventoryOperand(operand: InventoryOperand) {
  if (operand.kind === 'player-inventory' || operand.kind === 'command-result')
    return { ...operand };
  if (operand.kind === 'owner-inventory') {
    return {
      kind: 'owner-inventory' as const,
      owner: compileInventoryOwnerOperand(operand.owner),
      inventoryId: operand.inventoryId,
    };
  }
  const owner = operand.inventory.owner;
  return {
    kind: 'inventory' as const,
    inventory: {
      owner:
        owner.kind === 'project'
          ? { kind: 'project' as const }
          : owner.kind === 'character'
            ? {
                kind: 'character' as const,
                character: { kind: 'character' as const, id: owner.character.$ref.id },
              }
            : owner.kind === 'interactable'
              ? {
                  kind: 'interactable' as const,
                  interactable: {
                    kind: 'interactable' as const,
                    id: owner.interactable.$ref.id,
                  },
                }
              : owner.kind === 'room-feature'
                ? {
                    kind: 'room-feature' as const,
                    room: { kind: 'room' as const, id: owner.room.$ref.id },
                    featureId: owner.featureId,
                  }
                : {
                    kind: 'interactable-feature' as const,
                    interactable: {
                      kind: 'interactable' as const,
                      id: owner.interactable.$ref.id,
                    },
                    featureId: owner.featureId,
                  },
      inventoryId:
        operand.inventory.owner.kind === 'project' ? 'player' : operand.inventory.inventoryId,
    },
  };
}

export function compileLocationOperand(location: LocationOperand) {
  if (location.kind === 'unplaced') return { kind: 'unplaced' as const };
  if (location.kind === 'room') {
    return { kind: 'room' as const, room: compileRoomOperand(location.room) };
  }
  return { kind: 'inventory' as const, inventory: compileInventoryOperand(location.inventory) };
}

export function compileMatcher(matcher: InteractableMatcher) {
  return {
    ...(matcher.definition
      ? {
          definition: {
            kind: 'interactable-definition' as const,
            id: matcher.definition.$ref.id,
          },
        }
      : {}),
    traits: matcher.traits.map((trait) => ({ kind: 'trait' as const, id: trait.$ref.id })),
    properties: matcher.properties.map((property) => ({ ...property })),
    ...(matcher.exact ? { exact: compileInteractableOperand(matcher.exact) } : {}),
  };
}

export function compileCondition(condition: Condition): CompiledCondition {
  switch (condition.kind) {
    case 'always':
      return { kind: 'always' };
    case 'all':
      return { kind: 'all', conditions: condition.conditions.map(compileCondition) };
    case 'any':
      return { kind: 'any', conditions: condition.conditions.map(compileCondition) };
    case 'not':
      return { kind: 'not', condition: compileCondition(condition.condition) };
    case 'variable-comparison':
      return {
        kind: 'global-property-comparison',
        operator: condition.operator,
        property: { kind: 'property', id: condition.variable.$ref.id },
        ...(condition.value === undefined ? {} : { value: condition.value }),
      };
    case 'property-comparison':
      return {
        kind: 'property-comparison',
        owner: compileIdentityOperand(condition.owner),
        propertyId: condition.propertyId,
        operator: condition.operator,
        ...(condition.value === undefined ? {} : { value: condition.value }),
      };
    case 'trait-presence':
      return {
        kind: 'trait-presence',
        owner: compileIdentityOperand(condition.owner),
        trait: { kind: 'trait', id: condition.trait.$ref.id },
        present: condition.present,
      };
    case 'location-comparison':
      return {
        kind: 'location-comparison',
        subject: compileLocationSubjectOperand(condition.subject),
        operator: condition.operator,
        location: compileLocationOperand(condition.location),
      };
    case 'inventory-quantity-comparison':
      return {
        kind: 'inventory-quantity-comparison',
        inventory: compileInventoryOperand(condition.inventory),
        matcher: compileMatcher(condition.matcher),
        operator: condition.operator,
        quantity: condition.quantity,
      };
    case 'lua-predicate':
      return { kind: 'lua-predicate', source: condition.source };
  }
}
