import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectItem } from '@/components/ui/select';
import {
  IdentityOperandEditor,
  InventoryOperandEditor,
  LocationSubjectOperandEditor,
  MatcherEditor,
  RecursiveConditionEditor,
  defaultIdentity,
  defaultLocationSubject,
  type CommandResultEditorBinding,
  type CommandResultEditorKind,
  type ConditionEditorScope,
} from '@/components/conditions/ConditionEditor';
import type { AuthoringEditorProject } from '../../editors/interactions/InteractionProgramEditor';
import type {
  GameplayCommand,
  GameplayConfigurationSource,
  InteractableOperand,
  InventoryOperand,
  LocationOperand,
} from '../../../shared/project-schema/authoring-flow';

export type GameplayCommandKind = GameplayCommand['kind'];

export interface GameplayCommandEditorPolicy extends ConditionEditorScope {
  admittedKinds?: readonly GameplayCommandKind[];
}

const allKinds: readonly GameplayCommandKind[] = [
  'set-global-property',
  'unset-global-property',
  'set-property',
  'unset-property',
  'add-trait',
  'remove-trait',
  'set-enabled',
  'set-visible',
  'move-instance',
  'create-room',
  'create-character',
  'create-interactable',
  'destroy-instance',
  'split-quantity',
  'merge-quantity',
  'transfer-quantity',
  'add-quantity',
  'consume-quantity',
  'present-inventory',
  'call-scene',
  'call-dialogue',
  'notify',
  'run-lua',
  'if',
];

const labelForKind = (kind: GameplayCommandKind) =>
  kind
    .split('-')
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(' ');

const variableRef = (id: string) => ({ $ref: { collection: 'variables' as const, id } });
const traitRef = (id: string) => ({ $ref: { collection: 'traits' as const, id } });
const sceneRef = (id: string) => ({ $ref: { collection: 'scenes' as const, id } });
const dialogueRef = (id: string) => ({ $ref: { collection: 'dialogues' as const, id } });
const layoutRef = (id: string) => ({ $ref: { collection: 'layouts' as const, id } });
const interactableRef = (id: string) => ({ $ref: { collection: 'interactables' as const, id } });
const archetypeRef = (id: string) => ({ $ref: { collection: 'archetypes' as const, id } });
const roomRef = (id: string) => ({ $ref: { collection: 'rooms' as const, id } });
const characterRef = (id: string) => ({ $ref: { collection: 'characters' as const, id } });
const instanceRef = (id: string) => ({ $ref: { registry: 'interactableInstances' as const, id } });

function resultBindings(
  policy: GameplayCommandEditorPolicy,
  kinds: readonly CommandResultEditorKind[],
): readonly CommandResultEditorBinding[] {
  return policy.commandResults?.filter((result) => kinds.includes(result.kind)) ?? [];
}

function nextId(commands: readonly GameplayCommand[], stem: string): string {
  const used = new Set<string>();
  const visit = (items: readonly GameplayCommand[]) => {
    for (const item of items) {
      used.add(item.id);
      if (item.kind === 'if') {
        visit(item.then);
        visit(item.else);
      }
    }
  };
  visit(commands);
  for (let index = 1; index < 1000; index += 1) {
    const candidate = index === 1 ? stem : `${stem}-${index}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${stem}-new`;
}

function resultBindingForCommand(command: GameplayCommand): CommandResultEditorBinding | undefined {
  const result =
    command.kind === 'create-room' ||
    command.kind === 'create-character' ||
    command.kind === 'create-interactable' ||
    command.kind === 'split-quantity' ||
    (command.kind === 'transfer-quantity' && command.mode === 'exact')
      ? command.result
      : undefined;
  if (!result) return undefined;
  if (command.kind === 'create-room') return { id: result, kind: 'room' };
  if (command.kind === 'create-character') return { id: result, kind: 'character' };
  return { id: result, kind: 'interactable' };
}

function definiteResultBindings(
  commands: readonly GameplayCommand[],
): CommandResultEditorBinding[] {
  const results: CommandResultEditorBinding[] = [];
  for (const command of commands) {
    const direct = resultBindingForCommand(command);
    if (direct) {
      results.push(direct);
      continue;
    }
    if (command.kind !== 'if') continue;
    const thenResults = definiteResultBindings(command.then);
    const elseResults = new Map(
      definiteResultBindings(command.else).map((result) => [result.id, result.kind] as const),
    );
    for (const result of thenResults) {
      if (elseResults.get(result.id) === result.kind) results.push(result);
    }
  }
  return results;
}

function defaultInteractableOperand(
  project: AuthoringEditorProject,
  policy: GameplayCommandEditorPolicy,
): InteractableOperand {
  if (policy.interactionSlots?.[0])
    return { kind: 'interaction-slot', slotId: policy.interactionSlots[0] };
  const result = resultBindings(policy, ['interactable'])[0];
  if (result) return { kind: 'command-result', bindingId: result.id };
  return {
    kind: 'interactable',
    interactable: instanceRef(Object.keys(project.interactableInstances)[0] ?? 'interactable'),
  };
}

function defaultInventoryOperand(project: AuthoringEditorProject): InventoryOperand {
  void project;
  return { kind: 'player-inventory' };
}

function defaultLocation(
  project: AuthoringEditorProject,
  policy: GameplayCommandEditorPolicy,
): LocationOperand {
  const result = resultBindings(policy, ['room'])[0];
  if (result) return { kind: 'room', room: { kind: 'command-result', bindingId: result.id } };
  if (policy.currentRoom) return { kind: 'room', room: { kind: 'current-room' } };
  const room = Object.keys(project.rooms)[0];
  return room
    ? { kind: 'room', room: { kind: 'room', room: roomRef(room) } }
    : { kind: 'unplaced' };
}

function defaultSource(
  project: AuthoringEditorProject,
  kind: 'room' | 'character' | 'interactable',
): GameplayConfigurationSource {
  const archetype = Object.entries(project.archetypes).find(([, record]) => {
    const data = record.data as { instanceKind?: unknown } | undefined;
    return data?.instanceKind === kind;
  })?.[0];
  if (archetype) return { kind: 'archetype', archetype: archetypeRef(archetype) };
  if (kind === 'room')
    return {
      kind: 'compiled-instance',
      instance: { kind: 'room', room: roomRef(Object.keys(project.rooms)[0] ?? 'room') },
    };
  if (kind === 'character')
    return {
      kind: 'compiled-instance',
      instance: {
        kind: 'character',
        character: characterRef(Object.keys(project.characters)[0] ?? 'character'),
      },
    };
  return {
    kind: 'compiled-instance',
    instance: {
      kind: 'interactable',
      interactable: instanceRef(Object.keys(project.interactableInstances)[0] ?? 'interactable'),
    },
  };
}

function createCommand(
  kind: GameplayCommandKind,
  id: string,
  project: AuthoringEditorProject,
  policy: GameplayCommandEditorPolicy,
): GameplayCommand {
  const variable = variableRef(Object.keys(project.variables)[0] ?? 'variable');
  const owner = defaultIdentity(project, policy);
  const subject = defaultLocationSubject(project, policy);
  const location = defaultLocation(project, policy);
  const interactable = defaultInteractableOperand(project, policy);
  switch (kind) {
    case 'set-global-property':
      return { id, kind, variable, value: null };
    case 'unset-global-property':
      return { id, kind, variable };
    case 'set-property':
      return { id, kind, owner, propertyId: 'property', value: null };
    case 'unset-property':
      return { id, kind, owner, propertyId: 'property' };
    case 'add-trait':
    case 'remove-trait':
      return { id, kind, owner, trait: traitRef(Object.keys(project.traits)[0] ?? 'trait') };
    case 'set-enabled':
      return { id, kind, subject, enabled: true };
    case 'set-visible':
      return { id, kind, subject, visible: true };
    case 'move-instance':
      return { id, kind, subject, location };
    case 'create-room':
      return { id, kind, source: defaultSource(project, 'room'), result: `${id}-result` };
    case 'create-character':
      return {
        id,
        kind,
        source: defaultSource(project, 'character'),
        location,
        enabled: true,
        visible: true,
        result: `${id}-result`,
      };
    case 'create-interactable':
      return {
        id,
        kind,
        source: defaultSource(project, 'interactable'),
        location,
        enabled: true,
        visible: true,
        result: `${id}-result`,
      };
    case 'destroy-instance':
      return { id, kind, instance: owner };
    case 'split-quantity':
      return { id, kind, source: interactable, quantity: 1, result: `${id}-result` };
    case 'merge-quantity':
      return { id, kind, receiver: interactable, donor: interactable };
    case 'transfer-quantity':
      return {
        id,
        kind,
        mode: 'exact',
        source: interactable,
        quantity: 1,
        location,
        result: `${id}-result`,
      };
    case 'add-quantity':
      return {
        id,
        kind,
        definition: interactableRef(Object.keys(project.interactables)[0] ?? 'interactable'),
        quantity: 1,
        location,
      };
    case 'consume-quantity':
      return { id, kind, mode: 'exact', source: interactable, quantity: 1 };
    case 'present-inventory':
      return { id, kind, inventory: defaultInventoryOperand(project) };
    case 'call-scene':
      return { id, kind, scene: sceneRef(Object.keys(project.scenes)[0] ?? 'scene') };
    case 'call-dialogue':
      return { id, kind, dialogue: dialogueRef(Object.keys(project.dialogues)[0] ?? 'dialogue') };
    case 'notify':
      return { id, kind, message: { source: { kind: 'inline', text: '' }, markup: 'plain' } };
    case 'run-lua':
      return { id, kind, source: 'return true' };
    case 'if':
      return {
        id,
        kind,
        condition: { kind: 'always' },
        // oxlint-disable-next-line unicorn/no-thenable -- `then` is the canonical Gameplay Command field.
        then: [],
        else: [],
      };
  }
}

function InteractableOperandEditor({
  value,
  project,
  policy,
  onChange,
}: {
  value: InteractableOperand;
  project: AuthoringEditorProject;
  policy: GameplayCommandEditorPolicy;
  onChange: (value: InteractableOperand) => void;
}) {
  const results = resultBindings(policy, ['interactable']);
  const kinds = [
    'interactable',
    ...(policy.interactionSlots?.length ? ['interaction-slot'] : []),
    ...(results.length ? ['command-result'] : []),
  ];
  return (
    <div className="flex gap-2">
      <Select
        value={value.kind}
        onValueChange={(kind) => {
          if (kind === 'interactable')
            onChange({
              kind,
              interactable: instanceRef(
                Object.keys(project.interactableInstances)[0] ?? 'interactable',
              ),
            });
          else if (kind === 'interaction-slot')
            onChange({ kind, slotId: policy.interactionSlots?.[0] ?? 'target' });
          else if (kind === 'command-result')
            onChange({ kind, bindingId: results[0]?.id ?? 'result' });
        }}
      >
        {kinds.map((kind) => (
          <SelectItem key={kind} value={kind}>
            {kind}
          </SelectItem>
        ))}
      </Select>
      {value.kind === 'interactable' ? (
        <Select
          value={value.interactable.$ref.id}
          onValueChange={(id) =>
            onChange({ kind: 'interactable', interactable: instanceRef(String(id)) })
          }
        >
          {Object.keys(project.interactableInstances).map((id) => (
            <SelectItem key={id} value={id}>
              {id}
            </SelectItem>
          ))}
        </Select>
      ) : value.kind === 'interaction-slot' ? (
        <Select
          value={value.slotId}
          onValueChange={(slotId) => onChange({ kind: 'interaction-slot', slotId: String(slotId) })}
        >
          {policy.interactionSlots?.map((id) => (
            <SelectItem key={id} value={id}>
              {id}
            </SelectItem>
          ))}
        </Select>
      ) : (
        <Select
          value={value.bindingId}
          onValueChange={(bindingId) =>
            onChange({ kind: 'command-result', bindingId: String(bindingId) })
          }
        >
          {results.map((result) => (
            <SelectItem key={result.id} value={result.id}>
              {result.id}
            </SelectItem>
          ))}
        </Select>
      )}
    </div>
  );
}

function LocationOperandEditor({
  value,
  project,
  policy,
  onChange,
}: {
  value: LocationOperand;
  project: AuthoringEditorProject;
  policy: GameplayCommandEditorPolicy;
  onChange: (value: LocationOperand) => void;
}) {
  const roomResults = resultBindings(policy, ['room']);
  return (
    <div className="flex flex-wrap gap-2">
      <Select
        value={value.kind}
        onValueChange={(kind) => {
          if (kind === 'unplaced') onChange({ kind });
          else if (kind === 'room') onChange(defaultLocation(project, policy));
          else
            onChange({
              kind: 'inventory',
              inventory: policy.playerInventory
                ? { kind: 'player-inventory' }
                : {
                    kind: 'inventory',
                    inventory: {
                      owner: { kind: 'project' },
                      inventoryId: project.inventories[0]?.id ?? 'inventory',
                    },
                  },
            });
        }}
      >
        <SelectItem value="unplaced">Unplaced</SelectItem>
        <SelectItem value="room">Room</SelectItem>
        <SelectItem value="inventory">Inventory</SelectItem>
      </Select>
      {value.kind === 'room' ? (
        <Select
          value={
            value.room.kind === 'current-room'
              ? '__current__'
              : value.room.kind === 'command-result'
                ? `result:${value.room.bindingId}`
                : value.room.room.$ref.id
          }
          onValueChange={(selected) => {
            const id = String(selected);
            if (id === '__current__') onChange({ kind: 'room', room: { kind: 'current-room' } });
            else if (id.startsWith('result:'))
              onChange({ kind: 'room', room: { kind: 'command-result', bindingId: id.slice(7) } });
            else onChange({ kind: 'room', room: { kind: 'room', room: roomRef(id) } });
          }}
        >
          {policy.currentRoom ? <SelectItem value="__current__">Current Room</SelectItem> : null}
          {Object.keys(project.rooms).map((id) => (
            <SelectItem key={id} value={id}>
              {id}
            </SelectItem>
          ))}
          {roomResults.map((result) => (
            <SelectItem key={`result:${result.id}`} value={`result:${result.id}`}>
              Result: {result.id}
            </SelectItem>
          ))}
        </Select>
      ) : null}
      {value.kind === 'inventory' ? (
        <InventoryOperandEditor
          value={value.inventory}
          project={project}
          scope={policy}
          onChange={(inventory) => onChange({ kind: 'inventory', inventory })}
        />
      ) : null}
    </div>
  );
}

function ConfigurationSourceEditor({
  value,
  project,
  policy,
  onChange,
}: {
  value: GameplayConfigurationSource;
  project: AuthoringEditorProject;
  policy: GameplayCommandEditorPolicy;
  onChange: (value: GameplayConfigurationSource) => void;
}) {
  return (
    <div className="grid gap-2 md:grid-cols-2">
      <Select
        value={value.kind}
        onValueChange={(kind) => {
          if (kind === 'archetype')
            onChange({
              kind,
              archetype: archetypeRef(Object.keys(project.archetypes)[0] ?? 'archetype'),
            });
          else
            onChange({
              kind: kind as 'compiled-instance' | 'effective-instance',
              instance: defaultIdentity(project, policy),
            });
        }}
      >
        <SelectItem value="archetype">Archetype</SelectItem>
        <SelectItem value="compiled-instance">Compiled instance</SelectItem>
        <SelectItem value="effective-instance">Effective instance</SelectItem>
      </Select>
      {value.kind === 'archetype' ? (
        <Select
          value={value.archetype.$ref.id}
          onValueChange={(id) =>
            onChange({ kind: 'archetype', archetype: archetypeRef(String(id)) })
          }
        >
          {Object.keys(project.archetypes).map((id) => (
            <SelectItem key={id} value={id}>
              {id}
            </SelectItem>
          ))}
        </Select>
      ) : (
        <IdentityOperandEditor
          value={value.instance}
          project={project}
          scope={policy}
          onChange={(instance) => onChange({ ...value, instance })}
        />
      )}
    </div>
  );
}

function ResultBinding({
  value,
  onChange,
}: {
  value: string | undefined;
  onChange: (value: string | undefined) => void;
}) {
  return (
    <Input
      aria-label="Result binding"
      placeholder="Optional result binding"
      value={value ?? ''}
      onChange={(event) => onChange(event.currentTarget.value || undefined)}
    />
  );
}

function CommandFields({
  command,
  project,
  policy,
  onChange,
}: {
  command: GameplayCommand;
  project: AuthoringEditorProject;
  policy: GameplayCommandEditorPolicy;
  onChange: (command: GameplayCommand) => void;
}) {
  const variables = Object.keys(project.variables);
  const traits = Object.keys(project.traits);
  if (command.kind === 'set-global-property' || command.kind === 'unset-global-property')
    return (
      <div className="grid gap-2 md:grid-cols-2">
        <Select
          value={command.variable.$ref.id}
          onValueChange={(id) => onChange({ ...command, variable: variableRef(String(id)) })}
        >
          {variables.map((id) => (
            <SelectItem key={id} value={id}>
              {id}
            </SelectItem>
          ))}
        </Select>
        {command.kind === 'set-global-property' ? (
          <Input
            value={String(command.value ?? '')}
            onChange={(event) => onChange({ ...command, value: event.currentTarget.value })}
            placeholder="Value"
          />
        ) : null}
      </div>
    );
  if (command.kind === 'set-property' || command.kind === 'unset-property')
    return (
      <div className="grid gap-2">
        <IdentityOperandEditor
          value={command.owner}
          project={project}
          scope={policy}
          onChange={(owner) => onChange({ ...command, owner })}
        />
        <Input
          value={command.propertyId}
          onChange={(event) => onChange({ ...command, propertyId: event.currentTarget.value })}
          placeholder="Property ID"
        />
        {command.kind === 'set-property' ? (
          <Input
            value={String(command.value ?? '')}
            onChange={(event) => onChange({ ...command, value: event.currentTarget.value })}
            placeholder="Value"
          />
        ) : null}
      </div>
    );
  if (command.kind === 'add-trait' || command.kind === 'remove-trait')
    return (
      <div className="grid gap-2 md:grid-cols-2">
        <IdentityOperandEditor
          value={command.owner}
          project={project}
          scope={policy}
          onChange={(owner) => onChange({ ...command, owner })}
        />
        <Select
          value={command.trait.$ref.id}
          onValueChange={(id) => onChange({ ...command, trait: traitRef(String(id)) })}
        >
          {traits.map((id) => (
            <SelectItem key={id} value={id}>
              {id}
            </SelectItem>
          ))}
        </Select>
      </div>
    );
  if (command.kind === 'set-enabled' || command.kind === 'set-visible')
    return (
      <div className="grid gap-2 md:grid-cols-2">
        <LocationSubjectOperandEditor
          value={command.subject}
          project={project}
          scope={policy}
          onChange={(subject) => onChange({ ...command, subject })}
        />
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={command.kind === 'set-enabled' ? command.enabled : command.visible}
            onChange={(event) =>
              onChange(
                command.kind === 'set-enabled'
                  ? { ...command, enabled: event.currentTarget.checked }
                  : { ...command, visible: event.currentTarget.checked },
              )
            }
          />
          {command.kind === 'set-enabled' ? 'Enabled' : 'Visible'}
        </label>
      </div>
    );
  if (command.kind === 'move-instance')
    return (
      <div className="grid gap-2">
        <LocationSubjectOperandEditor
          value={command.subject}
          project={project}
          scope={policy}
          onChange={(subject) => onChange({ ...command, subject })}
        />
        <LocationOperandEditor
          value={command.location}
          project={project}
          policy={policy}
          onChange={(location) => onChange({ ...command, location })}
        />
      </div>
    );
  if (
    command.kind === 'create-room' ||
    command.kind === 'create-character' ||
    command.kind === 'create-interactable'
  )
    return (
      <div className="grid gap-2">
        <ConfigurationSourceEditor
          value={command.source}
          project={project}
          policy={policy}
          onChange={(source) => onChange({ ...command, source })}
        />
        {command.kind !== 'create-room' ? (
          <LocationOperandEditor
            value={command.location}
            project={project}
            policy={policy}
            onChange={(location) => onChange({ ...command, location })}
          />
        ) : null}
        {command.kind !== 'create-room' ? (
          <div className="flex gap-4">
            <label>
              <input
                type="checkbox"
                checked={command.enabled}
                onChange={(event) => onChange({ ...command, enabled: event.currentTarget.checked })}
              />{' '}
              Enabled
            </label>
            <label>
              <input
                type="checkbox"
                checked={command.visible}
                onChange={(event) => onChange({ ...command, visible: event.currentTarget.checked })}
              />{' '}
              Visible
            </label>
          </div>
        ) : null}
        <ResultBinding
          value={command.result}
          onChange={(result) => onChange({ ...command, result })}
        />
      </div>
    );
  if (command.kind === 'destroy-instance')
    return (
      <IdentityOperandEditor
        value={command.instance}
        project={project}
        scope={policy}
        onChange={(instance) => onChange({ ...command, instance })}
      />
    );
  if (command.kind === 'split-quantity')
    return (
      <div className="grid gap-2 md:grid-cols-3">
        <InteractableOperandEditor
          value={command.source}
          project={project}
          policy={policy}
          onChange={(source) => onChange({ ...command, source })}
        />
        <Input
          type="number"
          min={1}
          value={command.quantity}
          onChange={(event) =>
            onChange({ ...command, quantity: Math.max(1, Number(event.currentTarget.value) || 1) })
          }
        />
        <ResultBinding
          value={command.result}
          onChange={(result) => onChange({ ...command, result })}
        />
      </div>
    );
  if (command.kind === 'merge-quantity')
    return (
      <div className="grid gap-2 md:grid-cols-2">
        <InteractableOperandEditor
          value={command.receiver}
          project={project}
          policy={policy}
          onChange={(receiver) => onChange({ ...command, receiver })}
        />
        <InteractableOperandEditor
          value={command.donor}
          project={project}
          policy={policy}
          onChange={(donor) => onChange({ ...command, donor })}
        />
      </div>
    );
  if (command.kind === 'transfer-quantity' || command.kind === 'consume-quantity') {
    const aggregate = command.mode === 'aggregate';
    return (
      <div className="grid gap-2">
        <Select
          value={command.mode}
          onValueChange={(mode) => {
            if (mode === 'exact')
              onChange(
                command.kind === 'transfer-quantity'
                  ? {
                      id: command.id,
                      kind: command.kind,
                      mode,
                      source: defaultInteractableOperand(project, policy),
                      quantity: command.quantity,
                      location: command.location,
                      result: `${command.id}-result`,
                    }
                  : {
                      id: command.id,
                      kind: command.kind,
                      mode,
                      source: defaultInteractableOperand(project, policy),
                      quantity: command.quantity,
                    },
              );
            else
              onChange(
                command.kind === 'transfer-quantity'
                  ? {
                      id: command.id,
                      kind: command.kind,
                      mode: 'aggregate',
                      matcher: { traits: [], properties: [] },
                      quantity: command.quantity,
                      location: command.location,
                    }
                  : {
                      id: command.id,
                      kind: command.kind,
                      mode: 'aggregate',
                      matcher: { traits: [], properties: [] },
                      quantity: command.quantity,
                    },
              );
          }}
        >
          <SelectItem value="exact">Exact instance</SelectItem>
          <SelectItem value="aggregate">Aggregate matcher</SelectItem>
        </Select>
        {aggregate ? (
          <>
            <MatcherEditor
              value={command.matcher}
              project={project}
              scope={policy}
              onChange={(matcher) => onChange({ ...command, matcher })}
            />
            <label className="text-sm">Optional source inventory</label>
            {command.sourceInventory ? (
              <InventoryOperandEditor
                value={command.sourceInventory}
                project={project}
                scope={policy}
                onChange={(sourceInventory) => onChange({ ...command, sourceInventory })}
              />
            ) : (
              <Button
                type="button"
                variant="outline"
                onClick={() =>
                  onChange({ ...command, sourceInventory: { kind: 'player-inventory' } })
                }
              >
                Limit to inventory
              </Button>
            )}
          </>
        ) : (
          <InteractableOperandEditor
            value={command.source}
            project={project}
            policy={policy}
            onChange={(source) => onChange({ ...command, source })}
          />
        )}
        <Input
          type="number"
          min={1}
          value={command.quantity}
          onChange={(event) =>
            onChange({ ...command, quantity: Math.max(1, Number(event.currentTarget.value) || 1) })
          }
        />
        {command.kind === 'transfer-quantity' ? (
          <LocationOperandEditor
            value={command.location}
            project={project}
            policy={policy}
            onChange={(location) => onChange({ ...command, location })}
          />
        ) : null}
        {command.kind === 'transfer-quantity' && command.mode === 'exact' ? (
          <ResultBinding
            value={command.result}
            onChange={(result) => onChange({ ...command, result })}
          />
        ) : null}
      </div>
    );
  }
  if (command.kind === 'add-quantity')
    return (
      <div className="grid gap-2 md:grid-cols-3">
        <Select
          value={command.definition.$ref.id}
          onValueChange={(id) => onChange({ ...command, definition: interactableRef(String(id)) })}
        >
          {Object.keys(project.interactables).map((id) => (
            <SelectItem key={id} value={id}>
              {id}
            </SelectItem>
          ))}
        </Select>
        <Input
          type="number"
          min={1}
          value={command.quantity}
          onChange={(event) =>
            onChange({ ...command, quantity: Math.max(1, Number(event.currentTarget.value) || 1) })
          }
        />
        <LocationOperandEditor
          value={command.location}
          project={project}
          policy={policy}
          onChange={(location) => onChange({ ...command, location })}
        />
      </div>
    );
  if (command.kind === 'present-inventory')
    return (
      <div className="grid gap-2 md:grid-cols-2">
        <div className="space-y-1">
          <Label>Inventory</Label>
          <InventoryOperandEditor
            value={command.inventory}
            project={project}
            scope={policy}
            onChange={(inventory) => onChange({ ...command, inventory })}
          />
        </div>
        <div className="space-y-1">
          <Label>Layout</Label>
          <Select
            value={command.layout?.$ref.id ?? '__default__'}
            onValueChange={(value) =>
              onChange({
                ...command,
                layout: value === '__default__' ? undefined : layoutRef(String(value)),
              })
            }
          >
            <SelectItem value="__default__">Project default / built-in fallback</SelectItem>
            {Object.values(project.layouts).map((layout) => (
              <SelectItem key={layout.id} value={layout.id}>
                {layout.label || layout.id} ({layout.id})
              </SelectItem>
            ))}
          </Select>
        </div>
      </div>
    );
  if (command.kind === 'call-scene')
    return (
      <Select
        value={command.scene.$ref.id}
        onValueChange={(id) => onChange({ ...command, scene: sceneRef(String(id)) })}
      >
        {Object.keys(project.scenes).map((id) => (
          <SelectItem key={id} value={id}>
            {id}
          </SelectItem>
        ))}
      </Select>
    );
  if (command.kind === 'call-dialogue')
    return (
      <Select
        value={command.dialogue.$ref.id}
        onValueChange={(id) => onChange({ ...command, dialogue: dialogueRef(String(id)) })}
      >
        {Object.keys(project.dialogues).map((id) => (
          <SelectItem key={id} value={id}>
            {id}
          </SelectItem>
        ))}
      </Select>
    );
  if (command.kind === 'notify')
    return (
      <Input
        value={command.message.source.kind === 'inline' ? command.message.source.text : ''}
        onChange={(event) =>
          onChange({
            ...command,
            message: {
              source: { kind: 'inline', text: event.currentTarget.value },
              markup: command.message.markup,
            },
          })
        }
      />
    );
  if (command.kind === 'run-lua')
    return (
      <Input
        value={command.source}
        onChange={(event) => onChange({ ...command, source: event.currentTarget.value || ' ' })}
      />
    );
  if (command.kind === 'if')
    return (
      <div className="space-y-3">
        <RecursiveConditionEditor
          value={command.condition}
          project={project}
          scope={policy}
          onChange={(condition) => onChange({ ...command, condition })}
        />
        <div>
          <Label>Then</Label>
          <GameplayCommandListEditor
            value={command.then}
            project={project}
            policy={policy}
            onChange={(then) =>
              onChange({
                ...command,
                // oxlint-disable-next-line unicorn/no-thenable -- `then` is the canonical Gameplay Command field.
                then,
              })
            }
          />
        </div>
        <div>
          <Label>Else</Label>
          <GameplayCommandListEditor
            value={command.else}
            project={project}
            policy={policy}
            onChange={(elseCommands) => onChange({ ...command, else: elseCommands })}
          />
        </div>
      </div>
    );
  return null;
}

export function GameplayCommandListEditor({
  value,
  project,
  onChange,
  policy = {},
}: {
  value: readonly GameplayCommand[];
  project: AuthoringEditorProject;
  onChange: (next: GameplayCommand[]) => void;
  policy?: GameplayCommandEditorPolicy;
}) {
  const admitted = policy.admittedKinds ?? allKinds;
  const earlierResults: CommandResultEditorBinding[] = [];
  return (
    <div className="space-y-2 rounded border p-2">
      {value.map((command, index) => {
        const localPolicy = {
          ...policy,
          commandResults: [...(policy.commandResults ?? []), ...earlierResults],
        };
        const directResult = resultBindingForCommand(command);
        if (directResult) earlierResults.push(directResult);
        else if (command.kind === 'if') earlierResults.push(...definiteResultBindings([command]));
        return (
          <div key={command.id} className="space-y-2 rounded bg-muted/30 p-2">
            <div className="flex flex-wrap items-center gap-2">
              <Select
                value={command.kind}
                onValueChange={(kind) => {
                  const next = [...value];
                  next[index] = createCommand(
                    kind as GameplayCommandKind,
                    command.id,
                    project,
                    localPolicy,
                  );
                  onChange(next);
                }}
              >
                {admitted.map((kind) => (
                  <SelectItem key={kind} value={kind}>
                    {labelForKind(kind)}
                  </SelectItem>
                ))}
              </Select>
              <Input
                aria-label={`${command.kind} command ID`}
                className="h-8 w-44 font-mono text-xs"
                value={command.id}
                onChange={(event) => {
                  const next = [...value];
                  next[index] = { ...command, id: event.currentTarget.value };
                  onChange(next);
                }}
              />
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={index === 0}
                onClick={() => {
                  const next = [...value];
                  [next[index - 1], next[index]] = [next[index]!, next[index - 1]!];
                  onChange(next);
                }}
              >
                Up
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={index === value.length - 1}
                onClick={() => {
                  const next = [...value];
                  [next[index], next[index + 1]] = [next[index + 1]!, next[index]!];
                  onChange(next);
                }}
              >
                Down
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => onChange(value.filter((_, item) => item !== index))}
              >
                Delete
              </Button>
            </div>
            <CommandFields
              command={command}
              project={project}
              policy={localPolicy}
              onChange={(nextCommand) => {
                const next = [...value];
                next[index] = nextCommand;
                onChange(next);
              }}
            />
          </div>
        );
      })}
      <div className="flex flex-wrap gap-1">
        {admitted.map((kind) => (
          <Button
            key={kind}
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              const id = nextId(value, kind);
              onChange([
                ...value,
                createCommand(kind, id, project, {
                  ...policy,
                  commandResults: [...(policy.commandResults ?? []), ...earlierResults],
                }),
              ]);
            }}
          >
            + {labelForKind(kind)}
          </Button>
        ))}
      </div>
    </div>
  );
}
