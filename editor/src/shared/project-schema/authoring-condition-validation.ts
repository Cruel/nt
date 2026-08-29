import type {
  Condition,
  GameplayIdentityOperand,
  InventoryOperand,
  InventoryOwnerOperand,
  LocationSubjectOperand,
} from './authoring-flow';
import type { AuthoringProject } from './authoring-project';
import { validateInventoryReference } from './authoring-inventory-validation';
import { validateVariableRuntimeValue } from './authoring-variable-usage';

export interface ConditionValidationScope {
  interactionSlots?: readonly string[];
  commandResults?: readonly string[];
  allowCurrentRoom?: boolean;
  allowPlayerInventory?: boolean;
}

export interface ConditionValidationDiagnostic {
  severity: 'error';
  path: string;
  message: string;
  category: 'Conditions';
  code: string;
}

const diagnostic = (
  path: string,
  message: string,
  code: string,
): ConditionValidationDiagnostic => ({
  severity: 'error',
  path,
  message,
  category: 'Conditions',
  code,
});

function validateDynamicReference(
  kind: 'interaction-slot' | 'command-result',
  id: string,
  path: string,
  scope: ConditionValidationScope,
): ConditionValidationDiagnostic[] {
  const allowed = kind === 'interaction-slot' ? scope.interactionSlots : scope.commandResults;
  if (allowed?.includes(id)) return [];
  return [
    diagnostic(
      path,
      `${kind === 'interaction-slot' ? 'Interaction slot' : 'Command result'} '${id}' is not in scope here.`,
      kind === 'interaction-slot'
        ? 'authoring.condition.slot-out-of-scope'
        : 'authoring.condition.result-out-of-scope',
    ),
  ];
}

function validateIdentityOperand(
  project: AuthoringProject,
  operand: GameplayIdentityOperand,
  path: string,
  scope: ConditionValidationScope,
): ConditionValidationDiagnostic[] {
  switch (operand.kind) {
    case 'room':
      return project.rooms[operand.room.$ref.id]
        ? []
        : [
            diagnostic(
              `${path}/room/$ref`,
              `Missing Room '${operand.room.$ref.id}'.`,
              'authoring.condition.room-missing',
            ),
          ];
    case 'character':
      return project.characters[operand.character.$ref.id]
        ? []
        : [
            diagnostic(
              `${path}/character/$ref`,
              `Missing Character '${operand.character.$ref.id}'.`,
              'authoring.condition.character-missing',
            ),
          ];
    case 'interactable':
      return project.interactableInstances[operand.interactable.$ref.id]
        ? []
        : [
            diagnostic(
              `${path}/interactable/$ref`,
              `Missing Interactable Instance '${operand.interactable.$ref.id}'.`,
              'authoring.condition.interactable-missing',
            ),
          ];
    case 'room-feature': {
      const room = project.rooms[operand.room.$ref.id];
      if (!room)
        return [
          diagnostic(
            `${path}/room/$ref`,
            `Missing Room '${operand.room.$ref.id}'.`,
            'authoring.condition.room-missing',
          ),
        ];
      return [];
    }
    case 'interactable-feature':
      return project.interactableInstances[operand.interactable.$ref.id]
        ? []
        : [
            diagnostic(
              `${path}/interactable/$ref`,
              `Missing Interactable Instance '${operand.interactable.$ref.id}'.`,
              'authoring.condition.interactable-missing',
            ),
          ];
    case 'current-room':
      return scope.allowCurrentRoom
        ? []
        : [
            diagnostic(
              path,
              'Current Room is not available in this Condition host.',
              'authoring.condition.current-room-out-of-scope',
            ),
          ];
    case 'interaction-slot':
      return validateDynamicReference('interaction-slot', operand.slotId, `${path}/slotId`, scope);
    case 'command-result':
      return validateDynamicReference(
        'command-result',
        operand.bindingId,
        `${path}/bindingId`,
        scope,
      );
  }
}

function validateLocationSubject(
  project: AuthoringProject,
  operand: LocationSubjectOperand,
  path: string,
  scope: ConditionValidationScope,
): ConditionValidationDiagnostic[] {
  if (operand.kind === 'interaction-slot')
    return validateDynamicReference('interaction-slot', operand.slotId, `${path}/slotId`, scope);
  if (operand.kind === 'command-result')
    return validateDynamicReference(
      'command-result',
      operand.bindingId,
      `${path}/bindingId`,
      scope,
    );
  if (operand.kind === 'character')
    return project.characters[operand.character.$ref.id]
      ? []
      : [
          diagnostic(
            `${path}/character/$ref`,
            `Missing Character '${operand.character.$ref.id}'.`,
            'authoring.condition.character-missing',
          ),
        ];
  return project.interactableInstances[operand.interactable.$ref.id]
    ? []
    : [
        diagnostic(
          `${path}/interactable/$ref`,
          `Missing Interactable Instance '${operand.interactable.$ref.id}'.`,
          'authoring.condition.interactable-missing',
        ),
      ];
}

function validateInventoryOwnerOperand(
  project: AuthoringProject,
  owner: InventoryOwnerOperand,
  path: string,
  scope: ConditionValidationScope,
): ConditionValidationDiagnostic[] {
  if (owner.kind === 'project') return [];
  if (owner.kind === 'interaction-slot')
    return validateDynamicReference('interaction-slot', owner.slotId, `${path}/slotId`, scope);
  if (owner.kind === 'command-result')
    return validateDynamicReference('command-result', owner.bindingId, `${path}/bindingId`, scope);
  if (owner.kind === 'character')
    return project.characters[owner.character.$ref.id]
      ? []
      : [
          diagnostic(
            `${path}/character/$ref`,
            `Missing Character '${owner.character.$ref.id}'.`,
            'authoring.condition.character-missing',
          ),
        ];
  if (owner.kind === 'interactable' || owner.kind === 'interactable-feature')
    return project.interactableInstances[owner.interactable.$ref.id]
      ? []
      : [
          diagnostic(
            `${path}/interactable/$ref`,
            `Missing Interactable Instance '${owner.interactable.$ref.id}'.`,
            'authoring.condition.interactable-missing',
          ),
        ];
  return project.rooms[owner.room.$ref.id]
    ? []
    : [
        diagnostic(
          `${path}/room/$ref`,
          `Missing Room '${owner.room.$ref.id}'.`,
          'authoring.condition.room-missing',
        ),
      ];
}

function validateInventoryOperand(
  project: AuthoringProject,
  inventory: InventoryOperand,
  path: string,
  scope: ConditionValidationScope,
): ConditionValidationDiagnostic[] {
  if (inventory.kind === 'player-inventory')
    return scope.allowPlayerInventory
      ? []
      : [
          diagnostic(
            path,
            'Player Inventory is not available in this Condition host.',
            'authoring.condition.player-inventory-out-of-scope',
          ),
        ];
  if (inventory.kind === 'command-result')
    return validateDynamicReference(
      'command-result',
      inventory.bindingId,
      `${path}/bindingId`,
      scope,
    );
  if (inventory.kind === 'owner-inventory')
    return validateInventoryOwnerOperand(project, inventory.owner, `${path}/owner`, scope);
  return validateInventoryReference(project, inventory.inventory, path).map((item) =>
    diagnostic(item.path, item.message, item.code),
  );
}

export function validateCondition(
  project: AuthoringProject,
  condition: Condition,
  path: string,
  scope: ConditionValidationScope = {},
): ConditionValidationDiagnostic[] {
  const diagnostics: ConditionValidationDiagnostic[] = [];
  switch (condition.kind) {
    case 'always':
    case 'lua-predicate':
      return diagnostics;
    case 'all':
    case 'any':
      condition.conditions.forEach((child, index) =>
        diagnostics.push(
          ...validateCondition(project, child, `${path}/conditions/${index}`, scope),
        ),
      );
      return diagnostics;
    case 'not':
      return validateCondition(project, condition.condition, `${path}/condition`, scope);
    case 'variable-comparison': {
      const variableId = condition.variable.$ref.id;
      if (condition.value === undefined) {
        if (!project.variables[variableId])
          diagnostics.push(
            diagnostic(
              `${path}/variable/$ref`,
              `Missing Variable '${variableId}'.`,
              'authoring.condition.variable-missing',
            ),
          );
      } else {
        const result = validateVariableRuntimeValue(project, variableId, condition.value);
        if (!result.ok)
          diagnostics.push(
            diagnostic(
              result.kind === 'missing' ? `${path}/variable/$ref` : `${path}/value`,
              result.message,
              result.kind === 'missing'
                ? 'authoring.condition.variable-missing'
                : 'authoring.condition.variable-type-mismatch',
            ),
          );
      }
      return diagnostics;
    }
    case 'property-comparison':
      diagnostics.push(
        ...validateIdentityOperand(project, condition.owner, `${path}/owner`, scope),
      );
      return diagnostics;
    case 'trait-presence':
      diagnostics.push(
        ...validateIdentityOperand(project, condition.owner, `${path}/owner`, scope),
      );
      if (!project.traits[condition.trait.$ref.id])
        diagnostics.push(
          diagnostic(
            `${path}/trait/$ref`,
            `Missing Trait '${condition.trait.$ref.id}'.`,
            'authoring.condition.trait-missing',
          ),
        );
      return diagnostics;
    case 'location-comparison':
      diagnostics.push(
        ...validateLocationSubject(project, condition.subject, `${path}/subject`, scope),
      );
      if (condition.location.kind === 'room') {
        if (condition.location.room.kind === 'current-room' && !scope.allowCurrentRoom)
          diagnostics.push(
            diagnostic(
              `${path}/location/room`,
              'Current Room is not available in this Condition host.',
              'authoring.condition.current-room-out-of-scope',
            ),
          );
        if (condition.location.room.kind === 'command-result')
          diagnostics.push(
            ...validateDynamicReference(
              'command-result',
              condition.location.room.bindingId,
              `${path}/location/room/bindingId`,
              scope,
            ),
          );
        if (
          condition.location.room.kind === 'room' &&
          !project.rooms[condition.location.room.room.$ref.id]
        )
          diagnostics.push(
            diagnostic(
              `${path}/location/room/room/$ref`,
              `Missing Room '${condition.location.room.room.$ref.id}'.`,
              'authoring.condition.room-missing',
            ),
          );
      } else if (condition.location.kind === 'inventory') {
        diagnostics.push(
          ...validateInventoryOperand(
            project,
            condition.location.inventory,
            `${path}/location/inventory`,
            scope,
          ),
        );
      }
      return diagnostics;
    case 'inventory-quantity-comparison':
      diagnostics.push(
        ...validateInventoryOperand(project, condition.inventory, `${path}/inventory`, scope),
      );
      if (
        condition.matcher.definition &&
        !project.interactables[condition.matcher.definition.$ref.id]
      )
        diagnostics.push(
          diagnostic(
            `${path}/matcher/definition/$ref`,
            `Missing Interactable definition '${condition.matcher.definition.$ref.id}'.`,
            'authoring.condition.interactable-definition-missing',
          ),
        );
      condition.matcher.traits.forEach((trait, index) => {
        if (!project.traits[trait.$ref.id])
          diagnostics.push(
            diagnostic(
              `${path}/matcher/traits/${index}/$ref`,
              `Missing Trait '${trait.$ref.id}'.`,
              'authoring.condition.trait-missing',
            ),
          );
      });
      if (condition.matcher.exact) {
        if (
          condition.matcher.exact.kind === 'interactable' &&
          !project.interactableInstances[condition.matcher.exact.interactable.$ref.id]
        )
          diagnostics.push(
            diagnostic(
              `${path}/matcher/exact/interactable/$ref`,
              `Missing Interactable Instance '${condition.matcher.exact.interactable.$ref.id}'.`,
              'authoring.condition.interactable-missing',
            ),
          );
        if (condition.matcher.exact.kind === 'interaction-slot')
          diagnostics.push(
            ...validateDynamicReference(
              'interaction-slot',
              condition.matcher.exact.slotId,
              `${path}/matcher/exact/slotId`,
              scope,
            ),
          );
        if (condition.matcher.exact.kind === 'command-result')
          diagnostics.push(
            ...validateDynamicReference(
              'command-result',
              condition.matcher.exact.bindingId,
              `${path}/matcher/exact/bindingId`,
              scope,
            ),
          );
      }
      return diagnostics;
  }
}

export function visitCondition(
  condition: Condition,
  visitor: (condition: Condition, path: string) => void,
  path = '',
) {
  visitor(condition, path);
  if (condition.kind === 'all' || condition.kind === 'any')
    condition.conditions.forEach((child, index) =>
      visitCondition(child, visitor, `${path}/conditions/${index}`),
    );
  else if (condition.kind === 'not')
    visitCondition(condition.condition, visitor, `${path}/condition`);
}
