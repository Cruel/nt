import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectItem } from '@/components/ui/select';
import { useCommandStore } from '@/commands/command-store';
import { useProjectStore } from '@/project/project-store';
import type { WorkbenchEditorProps } from '@/workbench/editor-registry';
import {
  parseInteractionData,
  type InteractionRule,
} from '../../../shared/project-schema/authoring-interactions';
import { parseVerbData } from '../../../shared/project-schema/authoring-verbs';
import {
  authoringProjectFromDocument,
  defaultInteractionProgram,
  InteractionProgramEditor,
  nextNestedId,
  typedRef,
  type AuthoringEditorProject,
} from './InteractionProgramEditor';

type InteractionData = NonNullable<ReturnType<typeof parseInteractionData>>;

function defaultOperands(
  project: AuthoringEditorProject,
  verbId: string,
): InteractionRule['operands'] {
  const verb = parseVerbData(project.verbs[verbId]?.data);
  return Array.from({ length: verb?.arity ?? 0 }, () => ({ kind: 'any-interactable' as const }));
}

function ContextEditor({
  rule,
  project,
  onChange,
}: {
  rule: InteractionRule;
  project: AuthoringEditorProject;
  onChange: (next: InteractionRule) => void;
}) {
  const context = rule.context;
  return (
    <div className="grid gap-2 md:grid-cols-3">
      <div>
        <Label>Context</Label>
        <Select
          value={context.kind}
          onValueChange={(kind) => {
            if (kind === 'active-room') {
              onChange({
                ...rule,
                context: { kind, room: typedRef('rooms', Object.keys(project.rooms)[0] ?? '') },
              });
            } else if (kind === 'room-placement') {
              onChange({
                ...rule,
                context: {
                  kind,
                  placement: { room: Object.keys(project.rooms)[0] ?? '', placement: '' },
                },
              });
            } else if (kind === 'predicate') {
              onChange({
                ...rule,
                context: { kind, condition: { kind: 'lua-predicate', source: 'return true' } },
              });
            } else {
              onChange({ ...rule, context: { kind: 'any' } });
            }
          }}
        >
          <SelectItem value="any">Any</SelectItem>
          <SelectItem value="active-room" disabled={!Object.keys(project.rooms).length}>
            Active room
          </SelectItem>
          <SelectItem value="room-placement" disabled={!Object.keys(project.rooms).length}>
            Room placement
          </SelectItem>
          <SelectItem value="predicate">Predicate</SelectItem>
        </Select>
      </div>
      {context.kind === 'active-room' && (
        <Select
          value={context.room.$ref.id}
          onValueChange={(id) =>
            onChange({
              ...rule,
              context: { kind: 'active-room', room: typedRef('rooms', String(id)) },
            })
          }
        >
          {Object.entries(project.rooms).map(([id, record]) => (
            <SelectItem value={id} key={id}>
              {record.label}
            </SelectItem>
          ))}
        </Select>
      )}
      {context.kind === 'room-placement' && (
        <>
          <Select
            value={context.placement.room}
            onValueChange={(room) =>
              onChange({
                ...rule,
                context: {
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
            value={context.placement.placement}
            onChange={(event) =>
              onChange({
                ...rule,
                context: {
                  kind: 'room-placement',
                  placement: { ...context.placement, placement: event.currentTarget.value },
                },
              })
            }
          />
        </>
      )}
      {context.kind === 'predicate' && (
        <Input
          value={context.condition.kind === 'lua-predicate' ? context.condition.source : ''}
          onChange={(event) =>
            onChange({
              ...rule,
              context: {
                kind: 'predicate',
                condition: { kind: 'lua-predicate', source: event.currentTarget.value || ' ' },
              },
            })
          }
        />
      )}
    </div>
  );
}

function RuleEditor({
  rule,
  index,
  count,
  project,
  onChange,
  onMove,
  onDelete,
}: {
  rule: InteractionRule;
  index: number;
  count: number;
  project: AuthoringEditorProject;
  onChange: (next: InteractionRule) => void;
  onMove: (direction: -1 | 1) => void;
  onDelete: () => void;
}) {
  return (
    <section className="space-y-3 rounded border p-3">
      <div className="grid gap-2 md:grid-cols-4">
        <div>
          <Label>Rule ID</Label>
          <Input
            value={rule.id}
            onChange={(event) => onChange({ ...rule, id: event.currentTarget.value })}
          />
        </div>
        <div>
          <Label>Verb</Label>
          <Select
            value={rule.verb.$ref.id}
            onValueChange={(verbId) =>
              onChange({
                ...rule,
                verb: typedRef('verbs', String(verbId)),
                operands: defaultOperands(project, String(verbId)),
              })
            }
          >
            {Object.entries(project.verbs).map(([id, record]) => (
              <SelectItem value={id} key={id}>
                {record.label}
              </SelectItem>
            ))}
          </Select>
        </div>
        <div className="flex items-end gap-1">
          <Button
            size="sm"
            type="button"
            variant="ghost"
            disabled={index === 0}
            onClick={() => onMove(-1)}
          >
            Up
          </Button>
          <Button
            size="sm"
            type="button"
            variant="ghost"
            disabled={index === count - 1}
            onClick={() => onMove(1)}
          >
            Down
          </Button>
        </div>
        <Button className="self-end" size="sm" type="button" variant="ghost" onClick={onDelete}>
          Delete
        </Button>
      </div>
      <div className="space-y-2">
        <Label>Operands</Label>
        {rule.operands.map((operand, operandIndex) => (
          <div className="grid gap-2 md:grid-cols-2" key={operandIndex}>
            <Select
              value={operand.kind === 'exact' ? `exact-${operand.subject.kind}` : operand.kind}
              onValueChange={(kind) => {
                const next = [...rule.operands];
                const firstInteractable = Object.keys(project.interactables)[0];
                const firstCharacter = Object.keys(project.characters)[0];
                next[operandIndex] =
                  kind === 'exact-interactable' && firstInteractable
                    ? {
                        kind: 'exact',
                        subject: {
                          kind: 'interactable',
                          interactable: typedRef('interactables', firstInteractable),
                        },
                      }
                    : kind === 'any-character'
                      ? { kind: 'any-character' }
                      : kind === 'any-subject'
                        ? { kind: 'any-subject' }
                        : kind === 'exact-character' && firstCharacter
                          ? {
                              kind: 'exact',
                              subject: {
                                kind: 'character',
                                character: typedRef('characters', firstCharacter),
                              },
                            }
                          : { kind: 'any-interactable' };
                onChange({ ...rule, operands: next });
              }}
            >
              <SelectItem value="any-interactable">Any interactable</SelectItem>
              <SelectItem value="any-character">Any character</SelectItem>
              <SelectItem value="any-subject">Any subject</SelectItem>
              <SelectItem
                value="exact-interactable"
                disabled={!Object.keys(project.interactables).length}
              >
                Exact interactable
              </SelectItem>
              <SelectItem
                value="exact-character"
                disabled={!Object.keys(project.characters).length}
              >
                Exact character
              </SelectItem>
            </Select>
            {operand.kind === 'exact' && operand.subject.kind === 'interactable' && (
              <Select
                value={operand.subject.interactable.$ref.id}
                onValueChange={(id) => {
                  const next = [...rule.operands];
                  next[operandIndex] = {
                    kind: 'exact',
                    subject: {
                      kind: 'interactable',
                      interactable: typedRef('interactables', String(id)),
                    },
                  };
                  onChange({ ...rule, operands: next });
                }}
              >
                {Object.entries(project.interactables).map(([id, record]) => (
                  <SelectItem value={id} key={id}>
                    {record.label}
                  </SelectItem>
                ))}
              </Select>
            )}
            {operand.kind === 'exact' && operand.subject.kind === 'character' && (
              <Select
                value={operand.subject.character.$ref.id}
                onValueChange={(id) => {
                  const next = [...rule.operands];
                  next[operandIndex] = {
                    kind: 'exact',
                    subject: { kind: 'character', character: typedRef('characters', String(id)) },
                  };
                  onChange({ ...rule, operands: next });
                }}
              >
                {Object.entries(project.characters).map(([id, record]) => (
                  <SelectItem value={id} key={id}>
                    {record.label}
                  </SelectItem>
                ))}
              </Select>
            )}
          </div>
        ))}
      </div>
      <ContextEditor rule={rule} project={project} onChange={onChange} />
      <InteractionProgramEditor
        value={rule.program}
        project={project}
        onChange={(program) => onChange({ ...rule, program })}
      />
    </section>
  );
}

function InteractionForm({
  data,
  project,
  onChange,
}: {
  data: InteractionData;
  project: AuthoringEditorProject;
  onChange: (next: InteractionData) => void;
}) {
  const add = () => {
    const verbId = Object.keys(project.verbs)[0];
    if (!verbId) return;
    onChange({
      ...data,
      rules: [
        ...data.rules,
        {
          id: nextNestedId(
            data.rules.map((rule) => rule.id),
            'rule',
          ),
          verb: typedRef('verbs', verbId),
          operands: defaultOperands(project, verbId),
          context: { kind: 'any' },
          program: defaultInteractionProgram(),
        },
      ],
    });
  };
  const update = (index: number, rule: InteractionRule) =>
    onChange({
      ...data,
      rules: data.rules.map((current, item) => (item === index ? rule : current)),
    });
  return (
    <div className="space-y-3">
      <Button
        size="sm"
        type="button"
        variant="outline"
        disabled={!Object.keys(project.verbs).length}
        onClick={add}
      >
        Add rule
      </Button>
      {data.rules.map((rule, index) => (
        <RuleEditor
          key={rule.id}
          rule={rule}
          index={index}
          count={data.rules.length}
          project={project}
          onChange={(next) => update(index, next)}
          onMove={(direction) => {
            const next = [...data.rules];
            [next[index], next[index + direction]] = [next[index + direction], next[index]];
            onChange({ ...data, rules: next });
          }}
          onDelete={() =>
            onChange({ ...data, rules: data.rules.filter((_, current) => current !== index) })
          }
        />
      ))}
    </div>
  );
}

export function InteractionEditor({ tab }: WorkbenchEditorProps) {
  const document = useProjectStore((state) => state.document);
  const project = authoringProjectFromDocument(document);
  const id = tab.resource?.entityId;
  const record = id && project ? project.interactions[id] : null;
  const data = parseInteractionData(record?.data);
  if (!project || !id || !record || !data)
    return <div className="p-4 text-sm text-muted-foreground">Interaction record not found.</div>;
  const commit = (next: InteractionData) =>
    useCommandStore.getState().executeCommand({
      type: 'interaction.replaceData',
      label: 'Update interaction',
      payload: { interactionId: id, data: next },
    });
  return (
    <div className="h-full overflow-auto bg-background p-4">
      <div className="mb-4 flex gap-2">
        <h2 className="text-lg font-semibold">{record.label}</h2>
        <Badge variant="outline">{id}</Badge>
      </div>
      <InteractionForm data={data} project={project} onChange={commit} />
    </div>
  );
}
