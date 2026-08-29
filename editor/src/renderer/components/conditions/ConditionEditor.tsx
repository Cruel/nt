import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectItem } from '@/components/ui/select';
import { LuaExplicitFallbackEditor } from '@/components/lua-explicit-fallback-editor';
import type { AuthoringEditorProject } from '../../editors/interactions/InteractionProgramEditor';
import type {
  Condition,
  GameplayIdentityOperand,
  InteractableMatcher,
  InventoryOperand,
  InventoryOwnerOperand,
  LocationOperand,
  LocationSubjectOperand,
  RuntimeScalar,
} from '../../../shared/project-schema/authoring-flow';

export type CommandResultEditorKind = 'room' | 'character' | 'interactable';

export interface CommandResultEditorBinding {
  id: string;
  kind: CommandResultEditorKind;
}

export interface ConditionEditorScope {
  interactionSlots?: readonly string[];
  commandResults?: readonly CommandResultEditorBinding[];
  currentRoom?: boolean;
  playerInventory?: boolean;
}

export interface ConditionEditorProps {
  value: Condition;
  project: AuthoringEditorProject;
  onChange: (next: Condition) => void;
  scope?: ConditionEditorScope;
  compact?: boolean;
}

const comparisonOperators = [
  'equal',
  'not-equal',
  'less',
  'less-equal',
  'greater',
  'greater-equal',
  'truthy',
  'falsy',
] as const;

const orderedComparisonOperators = comparisonOperators.slice(0, 6);

function variableRef(id: string) {
  return { $ref: { collection: 'variables' as const, id } };
}

function roomRef(id: string) {
  return { $ref: { collection: 'rooms' as const, id } };
}

function characterRef(id: string) {
  return { $ref: { collection: 'characters' as const, id } };
}

function interactableRef(id: string) {
  return { $ref: { registry: 'interactableInstances' as const, id } };
}

function traitRef(id: string) {
  return { $ref: { collection: 'traits' as const, id } };
}

function commandResults(
  scope: ConditionEditorScope,
  kinds: readonly CommandResultEditorKind[],
): readonly CommandResultEditorBinding[] {
  return scope.commandResults?.filter((result) => kinds.includes(result.kind)) ?? [];
}

export function defaultIdentity(project: AuthoringEditorProject, scope: ConditionEditorScope) {
  if (scope.interactionSlots?.[0])
    return { kind: 'interaction-slot' as const, slotId: scope.interactionSlots[0] };
  const result = commandResults(scope, ['room', 'character', 'interactable'])[0];
  if (result) return { kind: 'command-result' as const, bindingId: result.id };
  if (scope.currentRoom) return { kind: 'current-room' as const };
  const room = Object.keys(project.rooms)[0];
  if (room) return { kind: 'room' as const, room: roomRef(room) };
  const character = Object.keys(project.characters)[0];
  if (character) return { kind: 'character' as const, character: characterRef(character) };
  const interactable = Object.keys(project.interactableInstances)[0];
  if (interactable)
    return { kind: 'interactable' as const, interactable: interactableRef(interactable) };
  return { kind: 'current-room' as const };
}

export function defaultLocationSubject(
  project: AuthoringEditorProject,
  scope: ConditionEditorScope,
): LocationSubjectOperand {
  if (scope.interactionSlots?.[0])
    return { kind: 'interaction-slot', slotId: scope.interactionSlots[0] };
  const result = commandResults(scope, ['character', 'interactable'])[0];
  if (result) return { kind: 'command-result', bindingId: result.id };
  const interactable = Object.keys(project.interactableInstances)[0];
  if (interactable) return { kind: 'interactable', interactable: interactableRef(interactable) };
  const character = Object.keys(project.characters)[0];
  if (character) return { kind: 'character', character: characterRef(character) };
  return { kind: 'interaction-slot', slotId: scope.interactionSlots?.[0] ?? 'target' };
}

function defaultInventory(
  project: AuthoringEditorProject,
  scope: ConditionEditorScope,
): InventoryOperand {
  if (scope.playerInventory) return { kind: 'player-inventory' };
  const inventory = project.inventories[0];
  if (inventory)
    return {
      kind: 'inventory',
      inventory: { owner: { kind: 'project' }, inventoryId: inventory.id },
    };
  if (scope.interactionSlots?.[0])
    return {
      kind: 'owner-inventory',
      owner: { kind: 'interaction-slot', slotId: scope.interactionSlots[0] },
      inventoryId: 'inventory',
    };
  return {
    kind: 'owner-inventory',
    owner: { kind: 'project' },
    inventoryId: 'inventory',
  };
}

function defaultInventoryOwner(
  project: AuthoringEditorProject,
  scope: ConditionEditorScope,
): InventoryOwnerOperand {
  if (scope.interactionSlots?.[0])
    return { kind: 'interaction-slot', slotId: scope.interactionSlots[0] };
  const result = commandResults(scope, ['character', 'interactable'])[0];
  if (result) return { kind: 'command-result', bindingId: result.id };
  const character = Object.keys(project.characters)[0];
  if (character) return { kind: 'character', character: characterRef(character) };
  const interactable = Object.keys(project.interactableInstances)[0];
  if (interactable) return { kind: 'interactable', interactable: interactableRef(interactable) };
  return { kind: 'project' };
}

function defaultLocation(
  project: AuthoringEditorProject,
  scope: ConditionEditorScope,
): LocationOperand {
  const result = commandResults(scope, ['room'])[0];
  if (result) return { kind: 'room', room: { kind: 'command-result', bindingId: result.id } };
  const room = Object.keys(project.rooms)[0];
  if (room) return { kind: 'room', room: { kind: 'room', room: roomRef(room) } };
  if (scope.currentRoom) return { kind: 'room', room: { kind: 'current-room' } };
  return { kind: 'unplaced' };
}

function defaultMatcher(): InteractableMatcher {
  return { traits: [], properties: [] };
}

function defaultCondition(
  kind: Condition['kind'],
  project: AuthoringEditorProject,
  scope: ConditionEditorScope,
): Condition {
  const variable = Object.keys(project.variables)[0] ?? 'variable';
  const trait = Object.keys(project.traits)[0] ?? 'trait';
  switch (kind) {
    case 'always':
      return { kind };
    case 'all':
    case 'any':
      return { kind, conditions: [{ kind: 'always' }] };
    case 'not':
      return { kind, condition: { kind: 'always' } };
    case 'variable-comparison':
      return { kind, variable: variableRef(variable), operator: 'truthy' };
    case 'property-comparison':
      return {
        kind,
        owner: defaultIdentity(project, scope),
        propertyId: 'property',
        operator: 'truthy',
      };
    case 'trait-presence':
      return {
        kind,
        owner: defaultIdentity(project, scope),
        trait: traitRef(trait),
        present: true,
      };
    case 'location-comparison':
      return {
        kind,
        subject: defaultLocationSubject(project, scope),
        operator: 'equal',
        location: defaultLocation(project, scope),
      };
    case 'inventory-quantity-comparison':
      return {
        kind,
        inventory: defaultInventory(project, scope),
        matcher: defaultMatcher(),
        operator: 'greater',
        quantity: 0,
      };
    case 'lua-predicate':
      return { kind, source: 'return true', additionalDependencies: { targets: [] } };
  }
}

function ScalarInput({
  value,
  onChange,
}: {
  value: RuntimeScalar | undefined;
  onChange: (value: string) => void;
}) {
  return (
    <Input
      value={value === undefined || value === null ? '' : String(value)}
      onChange={(event) => onChange(event.currentTarget.value)}
    />
  );
}

export function IdentityOperandEditor({
  value,
  project,
  scope,
  onChange,
}: {
  value: GameplayIdentityOperand;
  project: AuthoringEditorProject;
  scope: ConditionEditorScope;
  onChange: (value: GameplayIdentityOperand) => void;
}) {
  const resultBindings = commandResults(scope, ['room', 'character', 'interactable']);
  const kinds = [
    'room',
    'character',
    'interactable',
    'room-feature',
    'interactable-feature',
    ...(scope.currentRoom ? ['current-room'] : []),
    ...(scope.interactionSlots?.length ? ['interaction-slot'] : []),
    ...(resultBindings.length ? ['command-result'] : []),
  ] as string[];
  return (
    <div className="flex flex-wrap gap-2">
      <Select
        value={value.kind}
        onValueChange={(kind) => {
          if (kind === 'room')
            onChange({ kind, room: roomRef(Object.keys(project.rooms)[0] ?? 'room') });
          else if (kind === 'character')
            onChange({
              kind,
              character: characterRef(Object.keys(project.characters)[0] ?? 'character'),
            });
          else if (kind === 'interactable')
            onChange({
              kind,
              interactable: interactableRef(
                Object.keys(project.interactableInstances)[0] ?? 'interactable',
              ),
            });
          else if (kind === 'room-feature')
            onChange({
              kind,
              room: roomRef(Object.keys(project.rooms)[0] ?? 'room'),
              featureId: 'feature',
            });
          else if (kind === 'interactable-feature')
            onChange({
              kind,
              interactable: interactableRef(
                Object.keys(project.interactableInstances)[0] ?? 'interactable',
              ),
              featureId: 'feature',
            });
          else if (kind === 'current-room') onChange({ kind });
          else if (kind === 'interaction-slot')
            onChange({ kind, slotId: scope.interactionSlots?.[0] ?? 'target' });
          else if (kind === 'command-result')
            onChange({ kind, bindingId: resultBindings[0]?.id ?? 'result' });
        }}
      >
        {kinds.map((kind) => (
          <SelectItem key={kind} value={kind}>
            {kind}
          </SelectItem>
        ))}
      </Select>
      {value.kind === 'room' ? (
        <Select
          value={value.room.$ref.id}
          onValueChange={(id) => onChange({ kind: 'room', room: roomRef(String(id)) })}
        >
          {Object.keys(project.rooms).map((id) => (
            <SelectItem key={id} value={id}>
              {id}
            </SelectItem>
          ))}
        </Select>
      ) : null}
      {value.kind === 'character' ? (
        <Select
          value={value.character.$ref.id}
          onValueChange={(id) =>
            onChange({ kind: 'character', character: characterRef(String(id)) })
          }
        >
          {Object.keys(project.characters).map((id) => (
            <SelectItem key={id} value={id}>
              {id}
            </SelectItem>
          ))}
        </Select>
      ) : null}
      {value.kind === 'interactable' ? (
        <Select
          value={value.interactable.$ref.id}
          onValueChange={(id) =>
            onChange({ kind: 'interactable', interactable: interactableRef(String(id)) })
          }
        >
          {Object.keys(project.interactableInstances).map((id) => (
            <SelectItem key={id} value={id}>
              {id}
            </SelectItem>
          ))}
        </Select>
      ) : null}
      {value.kind === 'room-feature' ? (
        <>
          <Select
            value={value.room.$ref.id}
            onValueChange={(id) => onChange({ ...value, room: roomRef(String(id)) })}
          >
            {Object.keys(project.rooms).map((id) => (
              <SelectItem key={id} value={id}>
                {id}
              </SelectItem>
            ))}
          </Select>
          <Input
            value={value.featureId}
            onChange={(event) => onChange({ ...value, featureId: event.currentTarget.value })}
            placeholder="Feature ID"
          />
        </>
      ) : null}
      {value.kind === 'interactable-feature' ? (
        <>
          <Select
            value={value.interactable.$ref.id}
            onValueChange={(id) =>
              onChange({ ...value, interactable: interactableRef(String(id)) })
            }
          >
            {Object.keys(project.interactableInstances).map((id) => (
              <SelectItem key={id} value={id}>
                {id}
              </SelectItem>
            ))}
          </Select>
          <Input
            value={value.featureId}
            onChange={(event) => onChange({ ...value, featureId: event.currentTarget.value })}
            placeholder="Feature ID"
          />
        </>
      ) : null}
      {value.kind === 'interaction-slot' ? (
        <Select
          value={value.slotId}
          onValueChange={(slotId) => onChange({ kind: 'interaction-slot', slotId: String(slotId) })}
        >
          {scope.interactionSlots?.map((id) => (
            <SelectItem key={id} value={id}>
              {id}
            </SelectItem>
          ))}
        </Select>
      ) : null}
      {value.kind === 'command-result' ? (
        <Select
          value={value.bindingId}
          onValueChange={(bindingId) =>
            onChange({ kind: 'command-result', bindingId: String(bindingId) })
          }
        >
          {resultBindings.map((result) => (
            <SelectItem key={result.id} value={result.id}>
              {result.id}
            </SelectItem>
          ))}
        </Select>
      ) : null}
    </div>
  );
}

function InventoryOwnerOperandEditor({
  value,
  project,
  scope,
  onChange,
}: {
  value: InventoryOwnerOperand;
  project: AuthoringEditorProject;
  scope: ConditionEditorScope;
  onChange: (value: InventoryOwnerOperand) => void;
}) {
  const resultBindings = commandResults(scope, ['character', 'interactable']);
  const kinds = [
    'project',
    'character',
    'interactable',
    'room-feature',
    'interactable-feature',
    ...(scope.interactionSlots?.length ? ['interaction-slot'] : []),
    ...(resultBindings.length ? ['command-result'] : []),
  ];
  return (
    <div className="flex flex-wrap gap-2">
      <Select
        value={value.kind}
        onValueChange={(kind) => {
          if (kind === 'project') onChange({ kind });
          else if (kind === 'character')
            onChange({
              kind,
              character: characterRef(Object.keys(project.characters)[0] ?? 'character'),
            });
          else if (kind === 'interactable')
            onChange({
              kind,
              interactable: interactableRef(
                Object.keys(project.interactableInstances)[0] ?? 'interactable',
              ),
            });
          else if (kind === 'room-feature')
            onChange({
              kind,
              room: roomRef(Object.keys(project.rooms)[0] ?? 'room'),
              featureId: 'feature',
            });
          else if (kind === 'interactable-feature')
            onChange({
              kind,
              interactable: interactableRef(
                Object.keys(project.interactableInstances)[0] ?? 'interactable',
              ),
              featureId: 'feature',
            });
          else if (kind === 'interaction-slot')
            onChange({ kind, slotId: scope.interactionSlots?.[0] ?? 'target' });
          else if (kind === 'command-result')
            onChange({ kind, bindingId: resultBindings[0]?.id ?? 'result' });
        }}
      >
        {kinds.map((kind) => (
          <SelectItem key={kind} value={kind}>
            {kind}
          </SelectItem>
        ))}
      </Select>
      {value.kind === 'character' ? (
        <Select
          value={value.character.$ref.id}
          onValueChange={(id) =>
            onChange({ kind: 'character', character: characterRef(String(id)) })
          }
        >
          {Object.keys(project.characters).map((id) => (
            <SelectItem key={id} value={id}>
              {id}
            </SelectItem>
          ))}
        </Select>
      ) : null}
      {value.kind === 'interactable' ? (
        <Select
          value={value.interactable.$ref.id}
          onValueChange={(id) =>
            onChange({ kind: 'interactable', interactable: interactableRef(String(id)) })
          }
        >
          {Object.keys(project.interactableInstances).map((id) => (
            <SelectItem key={id} value={id}>
              {id}
            </SelectItem>
          ))}
        </Select>
      ) : null}
      {value.kind === 'room-feature' ? (
        <>
          <Select
            value={value.room.$ref.id}
            onValueChange={(id) => onChange({ ...value, room: roomRef(String(id)) })}
          >
            {Object.keys(project.rooms).map((id) => (
              <SelectItem key={id} value={id}>
                {id}
              </SelectItem>
            ))}
          </Select>
          <Input
            value={value.featureId}
            onChange={(event) => onChange({ ...value, featureId: event.currentTarget.value })}
            placeholder="Feature ID"
          />
        </>
      ) : null}
      {value.kind === 'interactable-feature' ? (
        <>
          <Select
            value={value.interactable.$ref.id}
            onValueChange={(id) =>
              onChange({ ...value, interactable: interactableRef(String(id)) })
            }
          >
            {Object.keys(project.interactableInstances).map((id) => (
              <SelectItem key={id} value={id}>
                {id}
              </SelectItem>
            ))}
          </Select>
          <Input
            value={value.featureId}
            onChange={(event) => onChange({ ...value, featureId: event.currentTarget.value })}
            placeholder="Feature ID"
          />
        </>
      ) : null}
      {value.kind === 'interaction-slot' ? (
        <Select
          value={value.slotId}
          onValueChange={(slotId) => onChange({ kind: 'interaction-slot', slotId: String(slotId) })}
        >
          {scope.interactionSlots?.map((id) => (
            <SelectItem key={id} value={id}>
              {id}
            </SelectItem>
          ))}
        </Select>
      ) : null}
      {value.kind === 'command-result' ? (
        <Select
          value={value.bindingId}
          onValueChange={(bindingId) =>
            onChange({ kind: 'command-result', bindingId: String(bindingId) })
          }
        >
          {resultBindings.map((result) => (
            <SelectItem key={result.id} value={result.id}>
              {result.id}
            </SelectItem>
          ))}
        </Select>
      ) : null}
    </div>
  );
}

export function InventoryOperandEditor({
  value,
  project,
  scope,
  onChange,
}: {
  value: InventoryOperand;
  project: AuthoringEditorProject;
  scope: ConditionEditorScope;
  onChange: (value: InventoryOperand) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      <Select
        value={value.kind}
        onValueChange={(kind) => {
          if (kind === 'player-inventory') onChange({ kind });
          else if (kind === 'inventory')
            onChange(defaultInventory(project, { ...scope, playerInventory: false }));
          else if (kind === 'owner-inventory')
            onChange({
              kind,
              owner: defaultInventoryOwner(project, scope),
              inventoryId: 'inventory',
            });
        }}
      >
        <SelectItem value="inventory">Exact inventory</SelectItem>
        {scope.playerInventory ? (
          <SelectItem value="player-inventory">Player inventory</SelectItem>
        ) : null}
        <SelectItem value="owner-inventory">Owner-local inventory</SelectItem>
      </Select>
      {value.kind === 'inventory' ? (
        <Select
          value={value.inventory.inventoryId}
          onValueChange={(inventoryId) =>
            onChange({
              kind: 'inventory',
              inventory: { owner: { kind: 'project' }, inventoryId: String(inventoryId) },
            })
          }
        >
          {project.inventories.map((inventory) => (
            <SelectItem key={inventory.id} value={inventory.id}>
              {inventory.label}
            </SelectItem>
          ))}
        </Select>
      ) : null}
      {value.kind === 'owner-inventory' ? (
        <>
          <InventoryOwnerOperandEditor
            value={value.owner}
            project={project}
            scope={scope}
            onChange={(owner) => onChange({ ...value, owner })}
          />
          <Input
            value={value.inventoryId}
            onChange={(event) => onChange({ ...value, inventoryId: event.currentTarget.value })}
            placeholder="Inventory ID"
          />
        </>
      ) : null}
    </div>
  );
}

export function LocationSubjectOperandEditor({
  value,
  project,
  scope,
  onChange,
}: {
  value: LocationSubjectOperand;
  project: AuthoringEditorProject;
  scope: ConditionEditorScope;
  onChange: (value: LocationSubjectOperand) => void;
}) {
  const resultBindings = commandResults(scope, ['character', 'interactable']);
  const kinds = [
    'character',
    'interactable',
    ...(scope.interactionSlots?.length ? ['interaction-slot'] : []),
    ...(resultBindings.length ? ['command-result'] : []),
  ];
  return (
    <div className="flex flex-wrap gap-2">
      <Select
        value={value.kind}
        onValueChange={(kind) => {
          if (kind === 'character')
            onChange({
              kind,
              character: characterRef(Object.keys(project.characters)[0] ?? 'character'),
            });
          else if (kind === 'interactable')
            onChange({
              kind,
              interactable: interactableRef(
                Object.keys(project.interactableInstances)[0] ?? 'interactable',
              ),
            });
          else if (kind === 'interaction-slot')
            onChange({ kind, slotId: scope.interactionSlots?.[0] ?? 'target' });
          else if (kind === 'command-result')
            onChange({ kind, bindingId: resultBindings[0]?.id ?? 'result' });
        }}
      >
        {kinds.map((kind) => (
          <SelectItem key={kind} value={kind}>
            {kind}
          </SelectItem>
        ))}
      </Select>
      {value.kind === 'character' ? (
        <Select
          value={value.character.$ref.id}
          onValueChange={(id) =>
            onChange({ kind: 'character', character: characterRef(String(id)) })
          }
        >
          {Object.keys(project.characters).map((id) => (
            <SelectItem key={id} value={id}>
              {id}
            </SelectItem>
          ))}
        </Select>
      ) : null}
      {value.kind === 'interactable' ? (
        <Select
          value={value.interactable.$ref.id}
          onValueChange={(id) =>
            onChange({ kind: 'interactable', interactable: interactableRef(String(id)) })
          }
        >
          {Object.keys(project.interactableInstances).map((id) => (
            <SelectItem key={id} value={id}>
              {id}
            </SelectItem>
          ))}
        </Select>
      ) : null}
      {value.kind === 'interaction-slot' ? (
        <Select
          value={value.slotId}
          onValueChange={(slotId) => onChange({ kind: 'interaction-slot', slotId: String(slotId) })}
        >
          {scope.interactionSlots?.map((id) => (
            <SelectItem key={id} value={id}>
              {id}
            </SelectItem>
          ))}
        </Select>
      ) : null}
      {value.kind === 'command-result' ? (
        <Select
          value={value.bindingId}
          onValueChange={(bindingId) =>
            onChange({ kind: 'command-result', bindingId: String(bindingId) })
          }
        >
          {resultBindings.map((result) => (
            <SelectItem key={result.id} value={result.id}>
              {result.id}
            </SelectItem>
          ))}
        </Select>
      ) : null}
    </div>
  );
}

export function MatcherEditor({
  value,
  project,
  scope,
  onChange,
}: {
  value: InteractableMatcher;
  project: AuthoringEditorProject;
  scope: ConditionEditorScope;
  onChange: (value: InteractableMatcher) => void;
}) {
  const resultBindings = commandResults(scope, ['interactable']);
  const definition = value.definition?.$ref.id ?? '';
  return (
    <div className="grid gap-2 rounded border p-2">
      <Label>Interactable matcher</Label>
      <Select
        value={definition || '__any__'}
        onValueChange={(id) =>
          onChange({
            ...value,
            definition:
              id === '__any__'
                ? undefined
                : { $ref: { collection: 'interactables', id: String(id) } },
          })
        }
      >
        <SelectItem value="__any__">Any definition</SelectItem>
        {Object.keys(project.interactables).map((id) => (
          <SelectItem key={id} value={id}>
            {id}
          </SelectItem>
        ))}
      </Select>
      <Input
        value={value.traits.map((trait) => trait.$ref.id).join(', ')}
        onChange={(event) =>
          onChange({
            ...value,
            traits: event.currentTarget.value
              .split(',')
              .map((id) => id.trim())
              .filter(Boolean)
              .map(traitRef),
          })
        }
        placeholder="Required Traits (comma separated)"
      />
      <div className="space-y-2">
        <Label>Property narrowing</Label>
        {value.properties.map((property, index) => (
          <div key={index} className="flex gap-2">
            <Input
              value={property.propertyId}
              onChange={(event) =>
                onChange({
                  ...value,
                  properties: value.properties.map((item, itemIndex) =>
                    itemIndex === index ? { ...item, propertyId: event.currentTarget.value } : item,
                  ),
                })
              }
              placeholder="Property ID"
            />
            <ScalarInput
              value={property.value}
              onChange={(next) =>
                onChange({
                  ...value,
                  properties: value.properties.map((item, itemIndex) =>
                    itemIndex === index ? { ...item, value: next } : item,
                  ),
                })
              }
            />
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() =>
                onChange({
                  ...value,
                  properties: value.properties.filter((_, itemIndex) => itemIndex !== index),
                })
              }
            >
              Remove
            </Button>
          </div>
        ))}
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() =>
            onChange({
              ...value,
              properties: [...value.properties, { propertyId: 'property', value: '' }],
            })
          }
        >
          Add property
        </Button>
      </div>
      <div className="space-y-2">
        <Label>Exact Instance narrowing</Label>
        <Select
          value={value.exact?.kind ?? '__any__'}
          onValueChange={(kind) => {
            if (kind === '__any__') onChange({ ...value, exact: undefined });
            else if (kind === 'interactable')
              onChange({
                ...value,
                exact: {
                  kind,
                  interactable: interactableRef(
                    Object.keys(project.interactableInstances)[0] ?? 'interactable',
                  ),
                },
              });
            else if (kind === 'interaction-slot')
              onChange({
                ...value,
                exact: { kind, slotId: scope.interactionSlots?.[0] ?? 'target' },
              });
            else if (kind === 'command-result')
              onChange({
                ...value,
                exact: { kind, bindingId: resultBindings[0]?.id ?? 'result' },
              });
          }}
        >
          <SelectItem value="__any__">Any Instance</SelectItem>
          <SelectItem value="interactable">Exact authored Instance</SelectItem>
          {scope.interactionSlots?.length ? (
            <SelectItem value="interaction-slot">Interaction slot</SelectItem>
          ) : null}
          {resultBindings.length ? (
            <SelectItem value="command-result">Command result</SelectItem>
          ) : null}
        </Select>
        {value.exact?.kind === 'interactable' ? (
          <Select
            value={value.exact.interactable.$ref.id}
            onValueChange={(id) =>
              onChange({
                ...value,
                exact: { kind: 'interactable', interactable: interactableRef(String(id)) },
              })
            }
          >
            {Object.keys(project.interactableInstances).map((id) => (
              <SelectItem key={id} value={id}>
                {id}
              </SelectItem>
            ))}
          </Select>
        ) : null}
        {value.exact?.kind === 'interaction-slot' ? (
          <Select
            value={value.exact.slotId}
            onValueChange={(slotId) =>
              onChange({ ...value, exact: { kind: 'interaction-slot', slotId: String(slotId) } })
            }
          >
            {scope.interactionSlots?.map((id) => (
              <SelectItem key={id} value={id}>
                {id}
              </SelectItem>
            ))}
          </Select>
        ) : null}
        {value.exact?.kind === 'command-result' ? (
          <Select
            value={value.exact.bindingId}
            onValueChange={(bindingId) =>
              onChange({
                ...value,
                exact: { kind: 'command-result', bindingId: String(bindingId) },
              })
            }
          >
            {resultBindings.map((result) => (
              <SelectItem key={result.id} value={result.id}>
                {result.id}
              </SelectItem>
            ))}
          </Select>
        ) : null}
      </div>
    </div>
  );
}

export function RecursiveConditionEditor({
  value,
  project,
  onChange,
  scope = {},
  compact = false,
}: ConditionEditorProps) {
  const padding = compact ? 'p-1.5' : 'p-3';
  const roomResultBindings = commandResults(scope, ['room']);
  return (
    <div className={`space-y-2 rounded border ${padding}`}>
      <Select
        value={value.kind}
        onValueChange={(kind) =>
          onChange(defaultCondition(kind as Condition['kind'], project, scope))
        }
      >
        <SelectItem value="always">Always</SelectItem>
        <SelectItem value="all">All</SelectItem>
        <SelectItem value="any">Any</SelectItem>
        <SelectItem value="not">Not</SelectItem>
        <SelectItem value="variable-comparison" disabled={!Object.keys(project.variables).length}>
          Variable / Global Property
        </SelectItem>
        <SelectItem value="property-comparison">Identity Property</SelectItem>
        <SelectItem value="trait-presence" disabled={!Object.keys(project.traits).length}>
          Trait presence
        </SelectItem>
        <SelectItem value="location-comparison">Location</SelectItem>
        <SelectItem value="inventory-quantity-comparison">Inventory quantity</SelectItem>
        <SelectItem value="lua-predicate">Lua predicate</SelectItem>
      </Select>

      {value.kind === 'all' || value.kind === 'any' ? (
        <div className="space-y-2 border-l pl-2">
          {value.conditions.map((condition, index) => (
            <div key={index} className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <RecursiveConditionEditor
                  value={condition}
                  project={project}
                  scope={scope}
                  compact
                  onChange={(next) =>
                    onChange({
                      ...value,
                      conditions: value.conditions.map((item, itemIndex) =>
                        itemIndex === index ? next : item,
                      ),
                    })
                  }
                />
              </div>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() =>
                  onChange({
                    ...value,
                    conditions: value.conditions.filter((_, itemIndex) => itemIndex !== index),
                  })
                }
              >
                Remove
              </Button>
            </div>
          ))}
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() =>
              onChange({ ...value, conditions: [...value.conditions, { kind: 'always' }] })
            }
          >
            Add condition
          </Button>
        </div>
      ) : null}

      {value.kind === 'not' ? (
        <RecursiveConditionEditor
          value={value.condition}
          project={project}
          scope={scope}
          compact
          onChange={(condition) => onChange({ ...value, condition })}
        />
      ) : null}

      {value.kind === 'variable-comparison' ? (
        <div className="grid gap-2 md:grid-cols-3">
          <Select
            value={value.variable.$ref.id}
            onValueChange={(id) => onChange({ ...value, variable: variableRef(String(id)) })}
          >
            {Object.keys(project.variables).map((id) => (
              <SelectItem key={id} value={id}>
                {project.variables[id]?.label ?? id}
              </SelectItem>
            ))}
          </Select>
          <Select
            value={value.operator}
            onValueChange={(operator) =>
              onChange({ ...value, operator: operator as typeof value.operator })
            }
          >
            {comparisonOperators.map((operator) => (
              <SelectItem key={operator} value={operator}>
                {operator}
              </SelectItem>
            ))}
          </Select>
          {!['truthy', 'falsy'].includes(value.operator) ? (
            <ScalarInput
              value={value.value}
              onChange={(next) => onChange({ ...value, value: next })}
            />
          ) : null}
        </div>
      ) : null}

      {value.kind === 'property-comparison' ? (
        <div className="space-y-2">
          <IdentityOperandEditor
            value={value.owner}
            project={project}
            scope={scope}
            onChange={(owner) => onChange({ ...value, owner })}
          />
          <div className="grid gap-2 md:grid-cols-3">
            <Input
              value={value.propertyId}
              onChange={(event) => onChange({ ...value, propertyId: event.currentTarget.value })}
              placeholder="Property ID"
            />
            <Select
              value={value.operator}
              onValueChange={(operator) =>
                onChange({ ...value, operator: operator as typeof value.operator })
              }
            >
              {comparisonOperators.map((operator) => (
                <SelectItem key={operator} value={operator}>
                  {operator}
                </SelectItem>
              ))}
            </Select>
            {!['truthy', 'falsy'].includes(value.operator) ? (
              <ScalarInput
                value={value.value}
                onChange={(next) => onChange({ ...value, value: next })}
              />
            ) : null}
          </div>
        </div>
      ) : null}

      {value.kind === 'trait-presence' ? (
        <div className="space-y-2">
          <IdentityOperandEditor
            value={value.owner}
            project={project}
            scope={scope}
            onChange={(owner) => onChange({ ...value, owner })}
          />
          <div className="flex gap-2">
            <Select
              value={value.trait.$ref.id}
              onValueChange={(id) => onChange({ ...value, trait: traitRef(String(id)) })}
            >
              {Object.keys(project.traits).map((id) => (
                <SelectItem key={id} value={id}>
                  {project.traits[id]?.label ?? id}
                </SelectItem>
              ))}
            </Select>
            <Select
              value={value.present ? 'present' : 'absent'}
              onValueChange={(state) => onChange({ ...value, present: state === 'present' })}
            >
              <SelectItem value="present">Present</SelectItem>
              <SelectItem value="absent">Absent</SelectItem>
            </Select>
          </div>
        </div>
      ) : null}

      {value.kind === 'location-comparison' ? (
        <div className="space-y-2">
          <LocationSubjectOperandEditor
            value={value.subject}
            project={project}
            scope={scope}
            onChange={(subject) => onChange({ ...value, subject })}
          />
          <Select
            value={value.operator}
            onValueChange={(operator) =>
              onChange({ ...value, operator: operator as typeof value.operator })
            }
          >
            <SelectItem value="equal">equal</SelectItem>
            <SelectItem value="not-equal">not-equal</SelectItem>
          </Select>
          <Select
            value={value.location.kind}
            onValueChange={(kind) =>
              onChange({
                ...value,
                location:
                  kind === 'unplaced'
                    ? { kind }
                    : kind === 'room'
                      ? defaultLocation(project, scope)
                      : { kind: 'inventory', inventory: defaultInventory(project, scope) },
              })
            }
          >
            <SelectItem value="unplaced">Unplaced</SelectItem>
            <SelectItem value="room">Room</SelectItem>
            <SelectItem value="inventory">Inventory</SelectItem>
          </Select>
          {value.location.kind === 'room' ? (
            <Select
              value={
                value.location.room.kind === 'room'
                  ? value.location.room.room.$ref.id
                  : value.location.room.kind === 'current-room'
                    ? '__current__'
                    : `__result__:${value.location.room.bindingId}`
              }
              onValueChange={(id) =>
                onChange({
                  ...value,
                  location: {
                    kind: 'room',
                    room:
                      id === '__current__'
                        ? { kind: 'current-room' }
                        : String(id).startsWith('__result__:')
                          ? {
                              kind: 'command-result',
                              bindingId: String(id).slice('__result__:'.length),
                            }
                          : { kind: 'room', room: roomRef(String(id)) },
                  },
                })
              }
            >
              {scope.currentRoom ? <SelectItem value="__current__">Current Room</SelectItem> : null}
              {roomResultBindings.map((result) => (
                <SelectItem key={result.id} value={`__result__:${result.id}`}>
                  Result: {result.id}
                </SelectItem>
              ))}
              {Object.keys(project.rooms).map((id) => (
                <SelectItem key={id} value={id}>
                  {id}
                </SelectItem>
              ))}
            </Select>
          ) : null}
          {value.location.kind === 'inventory' ? (
            <InventoryOperandEditor
              value={value.location.inventory}
              project={project}
              scope={scope}
              onChange={(inventory) =>
                onChange({ ...value, location: { kind: 'inventory', inventory } })
              }
            />
          ) : null}
        </div>
      ) : null}

      {value.kind === 'inventory-quantity-comparison' ? (
        <div className="space-y-2">
          <InventoryOperandEditor
            value={value.inventory}
            project={project}
            scope={scope}
            onChange={(inventory) => onChange({ ...value, inventory })}
          />
          <MatcherEditor
            value={value.matcher}
            project={project}
            scope={scope}
            onChange={(matcher) => onChange({ ...value, matcher })}
          />
          <div className="flex gap-2">
            <Select
              value={value.operator}
              onValueChange={(operator) =>
                onChange({ ...value, operator: operator as typeof value.operator })
              }
            >
              {orderedComparisonOperators.map((operator) => (
                <SelectItem key={operator} value={operator}>
                  {operator}
                </SelectItem>
              ))}
            </Select>
            <Input
              type="number"
              min={0}
              value={value.quantity}
              onChange={(event) =>
                onChange({
                  ...value,
                  quantity: Math.max(0, Number(event.currentTarget.value) || 0),
                })
              }
            />
          </div>
        </div>
      ) : null}

      {value.kind === 'lua-predicate' ? (
        <div className="space-y-2">
          <Input
            className="font-mono"
            value={value.source}
            onChange={(event) => onChange({ ...value, source: event.currentTarget.value || ' ' })}
          />
          <LuaExplicitFallbackEditor
            value={value.additionalDependencies}
            onChange={(additionalDependencies) => onChange({ ...value, additionalDependencies })}
          />
        </div>
      ) : null}
    </div>
  );
}
