import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectItem } from '@/components/ui/select';
import {
  defaultInteractionProgram,
  type InteractionInstruction,
  type InteractionProgram,
} from '../../../shared/project-schema/authoring-interaction-programs';
import { isAuthoringProject } from '../../../shared/project-schema/authoring-project';

export type AuthoringEditorProject = NonNullable<ReturnType<typeof authoringProjectFromDocument>>;
export const authoringProjectFromDocument = (value: unknown) =>
  isAuthoringProject(value) ? value : null;
export const typedRef = <Collection extends string>(collection: Collection, id: string) => ({
  $ref: { collection, id },
});
export const nextNestedId = (ids: Iterable<string>, stem: string) => {
  const used = new Set(ids);
  for (let index = 1; index < 1000; index += 1) {
    const id = index === 1 ? stem : `${stem}-${index}`;
    if (!used.has(id)) return id;
  }
  return `${stem}-new`;
};

function replaceInstruction(
  value: InteractionProgram,
  index: number,
  instruction: InteractionInstruction,
): InteractionProgram {
  return {
    ...value,
    instructions: value.instructions.map((current, item) =>
      item === index ? instruction : current,
    ),
  };
}

function InstructionEditor({
  instruction,
  project,
  onChange,
}: {
  instruction: InteractionInstruction;
  project: AuthoringEditorProject;
  onChange: (next: InteractionInstruction) => void;
}) {
  const interactables = Object.entries(project.interactables);
  if (instruction.kind === 'apply-effect') {
    const variables = Object.entries(project.variables);
    const effect = instruction.effect;
    const effectFields =
      effect.kind === 'run-lua-effect' ? (
        <Input
          value={effect.source}
          onChange={(event) =>
            onChange({
              ...instruction,
              effect: { kind: 'run-lua-effect', source: event.currentTarget.value || ' ' },
            })
          }
        />
      ) : (
        <>
          <Select
            value={effect.variable.$ref.id}
            onValueChange={(id) =>
              onChange({
                ...instruction,
                effect: {
                  kind: 'set-variable',
                  variable: typedRef('variables', String(id)),
                  value: effect.value,
                },
              })
            }
          >
            {variables.map(([id, record]) => (
              <SelectItem value={id} key={id}>
                {record.label}
              </SelectItem>
            ))}
          </Select>
          <Input
            value={String(effect.value ?? '')}
            onChange={(event) =>
              onChange({
                ...instruction,
                effect: {
                  kind: 'set-variable',
                  variable: effect.variable,
                  value: event.currentTarget.value,
                },
              })
            }
          />
        </>
      );
    return (
      <div className="grid gap-2 md:grid-cols-3">
        <Select
          value={effect.kind}
          onValueChange={(kind) => {
            if (kind === 'set-variable' && variables[0])
              onChange({
                id: instruction.id,
                kind: 'apply-effect',
                effect: { kind, variable: typedRef('variables', variables[0][0]), value: null },
              });
            else
              onChange({
                id: instruction.id,
                kind: 'apply-effect',
                effect: { kind: 'run-lua-effect', source: 'return true' },
              });
          }}
        >
          <SelectItem value="run-lua-effect">Lua effect</SelectItem>
          <SelectItem value="set-variable" disabled={!variables.length}>
            Set variable
          </SelectItem>
        </Select>
        {effectFields}
      </div>
    );
  }
  if (instruction.kind === 'move-interactable') {
    const target = instruction.target.kind;
    const placementFields =
      instruction.target.kind === 'room-placement'
        ? (() => {
            const placement = instruction.target.placement;
            return (
              <>
                <Select
                  value={placement.room}
                  onValueChange={(room) =>
                    onChange({
                      ...instruction,
                      target: {
                        kind: 'room-placement',
                        placement: { room: String(room), placement: '' },
                      },
                    })
                  }
                >
                  {Object.entries(project.rooms).map(([id, record]) => (
                    <SelectItem value={id} key={id}>
                      {record.label}
                    </SelectItem>
                  ))}
                </Select>
                <Input
                  placeholder="Placement ID"
                  value={placement.placement}
                  onChange={(event) =>
                    onChange({
                      ...instruction,
                      target: {
                        kind: 'room-placement',
                        placement: { ...placement, placement: event.currentTarget.value },
                      },
                    })
                  }
                />
              </>
            );
          })()
        : null;
    return (
      <div className="grid gap-2 md:grid-cols-3">
        <Select
          value={instruction.interactable.$ref.id}
          onValueChange={(id) =>
            onChange({ ...instruction, interactable: typedRef('interactables', String(id)) })
          }
        >
          {interactables.map(([id, record]) => (
            <SelectItem value={id} key={id}>
              {record.label}
            </SelectItem>
          ))}
        </Select>
        <Select
          value={target}
          onValueChange={(kind) => {
            if (kind === 'room-placement')
              onChange({
                ...instruction,
                target: {
                  kind,
                  placement: { room: Object.keys(project.rooms)[0] ?? '', placement: '' },
                },
              });
            else if (kind === 'inventory' || kind === 'nowhere')
              onChange({ ...instruction, target: { kind } });
          }}
        >
          <SelectItem value="inventory">Inventory</SelectItem>
          <SelectItem value="nowhere">Nowhere</SelectItem>
          <SelectItem value="room-placement" disabled={!Object.keys(project.rooms).length}>
            Room placement
          </SelectItem>
        </Select>
        {placementFields}
      </div>
    );
  }
  if (instruction.kind === 'set-interactable-state') {
    return (
      <div className="grid gap-2 md:grid-cols-3">
        <Select
          value={instruction.interactable.$ref.id}
          onValueChange={(id) =>
            onChange({ ...instruction, interactable: typedRef('interactables', String(id)) })
          }
        >
          {interactables.map(([id, record]) => (
            <SelectItem value={id} key={id}>
              {record.label}
            </SelectItem>
          ))}
        </Select>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={instruction.enabled ?? false}
            onChange={(event) =>
              onChange({ ...instruction, enabled: event.currentTarget.checked || undefined })
            }
          />
          Enabled
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={instruction.visible ?? false}
            onChange={(event) =>
              onChange({ ...instruction, visible: event.currentTarget.checked || undefined })
            }
          />
          Visible
        </label>
      </div>
    );
  }
  if (instruction.kind === 'notify')
    return (
      <Input
        value={instruction.message.source.kind === 'inline' ? instruction.message.source.text : ''}
        onChange={(event) =>
          onChange({
            ...instruction,
            message: {
              source: { kind: 'inline', text: event.currentTarget.value },
              markup: instruction.message.markup,
            },
          })
        }
      />
    );
  if (instruction.kind === 'call-scene')
    return (
      <Select
        value={instruction.scene.$ref.id}
        onValueChange={(id) => onChange({ ...instruction, scene: typedRef('scenes', String(id)) })}
      >
        {Object.entries(project.scenes).map(([id, record]) => (
          <SelectItem value={id} key={id}>
            {record.label}
          </SelectItem>
        ))}
      </Select>
    );
  return (
    <Select
      value={instruction.dialogue.$ref.id}
      onValueChange={(id) =>
        onChange({ ...instruction, dialogue: typedRef('dialogues', String(id)) })
      }
    >
      {Object.entries(project.dialogues).map(([id, record]) => (
        <SelectItem value={id} key={id}>
          {record.label}
        </SelectItem>
      ))}
    </Select>
  );
}

export function InteractionProgramEditor({
  value,
  project,
  onChange,
}: {
  value: InteractionProgram;
  project: AuthoringEditorProject;
  onChange: (next: InteractionProgram) => void;
}) {
  const append = (kind: InteractionInstruction['kind']) => {
    const interactable = Object.keys(project.interactables)[0];
    const scene = Object.keys(project.scenes)[0];
    const dialogue = Object.keys(project.dialogues)[0];
    const id = nextNestedId(
      value.instructions.map((instruction) => instruction.id),
      kind,
    );
    const instruction: InteractionInstruction | null =
      kind === 'apply-effect'
        ? { id, kind, effect: { kind: 'run-lua-effect', source: 'return true' } }
        : kind === 'move-interactable' && interactable
          ? {
              id,
              kind,
              interactable: typedRef('interactables', interactable),
              target: { kind: 'nowhere' },
            }
          : kind === 'set-interactable-state' && interactable
            ? { id, kind, interactable: typedRef('interactables', interactable), enabled: true }
            : kind === 'notify'
              ? { id, kind, message: { source: { kind: 'inline', text: '' }, markup: 'plain' } }
              : kind === 'call-scene' && scene
                ? { id, kind, scene: typedRef('scenes', scene) }
                : kind === 'call-dialogue' && dialogue
                  ? { id, kind, dialogue: typedRef('dialogues', dialogue) }
                  : null;
    if (instruction) onChange({ ...value, instructions: [...value.instructions, instruction] });
  };
  const completion =
    value.completion.kind === 'end' || value.completion.kind === 'return'
      ? value.completion.kind
      : `${value.completion.kind}:${value.completion.id}`;
  return (
    <div className="space-y-3 rounded border p-3">
      <div className="flex flex-wrap gap-1">
        <Button size="sm" type="button" variant="outline" onClick={() => append('apply-effect')}>
          Apply effect
        </Button>
        <Button
          size="sm"
          type="button"
          variant="outline"
          disabled={!Object.keys(project.interactables).length}
          onClick={() => append('move-interactable')}
        >
          Move
        </Button>
        <Button
          size="sm"
          type="button"
          variant="outline"
          disabled={!Object.keys(project.interactables).length}
          onClick={() => append('set-interactable-state')}
        >
          State
        </Button>
        <Button size="sm" type="button" variant="outline" onClick={() => append('notify')}>
          Notify
        </Button>
        <Button
          size="sm"
          type="button"
          variant="outline"
          disabled={!Object.keys(project.scenes).length}
          onClick={() => append('call-scene')}
        >
          Call Scene
        </Button>
        <Button
          size="sm"
          type="button"
          variant="outline"
          disabled={!Object.keys(project.dialogues).length}
          onClick={() => append('call-dialogue')}
        >
          Call Dialogue
        </Button>
      </div>
      {value.instructions.map((instruction, index) => (
        <div className="space-y-2 rounded bg-muted/30 p-2" key={instruction.id}>
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs">{instruction.kind}</span>
            <Input
              aria-label={`${instruction.kind} instruction ID`}
              className="h-8 w-40 font-mono text-xs"
              value={instruction.id}
              onChange={(event) =>
                onChange(
                  replaceInstruction(value, index, {
                    ...instruction,
                    id: event.currentTarget.value,
                  }),
                )
              }
            />
            <Button
              size="sm"
              type="button"
              variant="ghost"
              disabled={index === 0}
              onClick={() => {
                const next = [...value.instructions];
                [next[index - 1], next[index]] = [next[index], next[index - 1]];
                onChange({ ...value, instructions: next });
              }}
            >
              Up
            </Button>
            <Button
              size="sm"
              type="button"
              variant="ghost"
              disabled={index === value.instructions.length - 1}
              onClick={() => {
                const next = [...value.instructions];
                [next[index], next[index + 1]] = [next[index + 1], next[index]];
                onChange({ ...value, instructions: next });
              }}
            >
              Down
            </Button>
            <Button
              size="sm"
              type="button"
              variant="ghost"
              onClick={() =>
                onChange({
                  ...value,
                  instructions: value.instructions.filter((_, current) => current !== index),
                })
              }
            >
              Delete
            </Button>
          </div>
          <InstructionEditor
            instruction={instruction}
            project={project}
            onChange={(next) => onChange(replaceInstruction(value, index, next))}
          />
        </div>
      ))}
      <div className="grid gap-2 md:grid-cols-2">
        <div>
          <Label>Completion</Label>
          <Select
            value={completion}
            onValueChange={(next) => {
              const [kind, id] = String(next).split(':');
              if (kind === 'end' || kind === 'return') onChange({ ...value, completion: { kind } });
              else if (id && (kind === 'room' || kind === 'scene' || kind === 'dialogue'))
                onChange({ ...value, completion: { kind, id } });
            }}
          >
            <SelectItem value="return">Return</SelectItem>
            <SelectItem value="end">End</SelectItem>
            {Object.entries(project.rooms).map(([id, record]) => (
              <SelectItem key={`room:${id}`} value={`room:${id}`}>
                Room: {record.label}
              </SelectItem>
            ))}
            {Object.entries(project.scenes).map(([id, record]) => (
              <SelectItem key={`scene:${id}`} value={`scene:${id}`}>
                Scene: {record.label}
              </SelectItem>
            ))}
            {Object.entries(project.dialogues).map(([id, record]) => (
              <SelectItem key={`dialogue:${id}`} value={`dialogue:${id}`}>
                Dialogue: {record.label}
              </SelectItem>
            ))}
          </Select>
        </div>
        <div>
          <Label>Successful outcome</Label>
          <Select
            value={value.outcome}
            onValueChange={(outcome) =>
              onChange({ ...value, outcome: outcome as InteractionProgram['outcome'] })
            }
          >
            <SelectItem value="handled">Handled</SelectItem>
            <SelectItem value="unhandled">Unhandled</SelectItem>
          </Select>
        </div>
      </div>
    </div>
  );
}

export { defaultInteractionProgram };
