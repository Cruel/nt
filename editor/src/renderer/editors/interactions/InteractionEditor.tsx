import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { RecursiveConditionEditor } from '@/components/conditions/ConditionEditor';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectItem } from '@/components/ui/select';
import { useCommandStore } from '@/commands/command-store';
import { recordSaveUnitId } from '@/project/save-unit-registry';
import { useProjectStore } from '@/project/project-store';
import type { WorkbenchEditorProps } from '@/workbench/editor-registry';
import {
  parseInteractionData,
  type InteractionRule,
} from '../../../shared/project-schema/authoring-interactions';
import { parseVerbData } from '../../../shared/project-schema/authoring-verbs';
import {
  analyzeInteractionRules,
  type RuleAnalysis,
} from '../../../shared/interaction-resolver-analysis';
import { SubjectSelectorEditor, defaultSubjectSelector } from './SubjectSelectorEditor';
import {
  authoringProjectFromDocument,
  defaultInteractionProgram,
  InteractionProgramEditor,
  nextNestedId,
  typedRef,
  type AuthoringEditorProject,
} from './InteractionProgramEditor';

type InteractionData = NonNullable<ReturnType<typeof parseInteractionData>>;

function defaultSlots(project: AuthoringEditorProject, verbId: string): InteractionRule['slots'] {
  const verb = parseVerbData(project.verbs[verbId]?.data);
  return (verb?.bindingOrder ?? []).map((slotId) => ({
    slotId,
    selectors: [defaultSubjectSelector(project)],
  }));
}

function GuardEditor({
  rule,
  project,
  onChange,
}: {
  rule: InteractionRule;
  project: AuthoringEditorProject;
  onChange: (next: InteractionRule) => void;
}) {
  return (
    <div className="space-y-2">
      <Label>Guard</Label>
      <RecursiveConditionEditor
        value={rule.guard}
        project={project}
        scope={{ interactionSlots: rule.slots.map((slot) => slot.slotId), currentRoom: true }}
        onChange={(guard) => onChange({ ...rule, guard })}
      />
    </div>
  );
}

function RuleEditor({
  rule,
  analysis,
  index,
  count,
  project,
  onChange,
  onMove,
  onDelete,
}: {
  rule: InteractionRule;
  analysis: RuleAnalysis;
  index: number;
  count: number;
  project: AuthoringEditorProject;
  onChange: (next: InteractionRule) => void;
  onMove: (direction: -1 | 1) => void;
  onDelete: () => void;
}) {
  return (
    <section
      className="space-y-3 rounded border p-3"
      data-workbench-anchor={`interaction.rule.${rule.id}`}
    >
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
                slots: defaultSlots(project, String(verbId)),
                offer: null,
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
        <div>
          <Label>Priority</Label>
          <Input
            type="number"
            value={rule.priority}
            onChange={(event) =>
              onChange({ ...rule, priority: Number(event.currentTarget.value) || 0 })
            }
          />
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
      <div
        className="rounded border bg-muted/20 p-2 text-xs"
        data-workbench-anchor={`interaction.rule.${rule.id}.analysis`}
      >
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <span className="font-medium">Resolver analysis</span>
          <Badge variant={analysis.unreachable === 'yes' ? 'destructive' : 'outline'}>
            {analysis.unreachable === 'yes'
              ? 'Unreachable'
              : analysis.unreachable === 'unknown'
                ? 'Conditionally reachable'
                : 'Reachable'}
          </Badge>
          {analysis.uncertainty && <Badge variant="secondary">Runtime-dependent</Badge>}
        </div>
        <div className="grid gap-1 text-muted-foreground md:grid-cols-2">
          <div>
            <span className="text-foreground">Match space:</span>{' '}
            {rule.slots.length
              ? rule.slots
                  .map(
                    (slot) =>
                      `${slot.slotId} = ${slot.selectors.map((selector) => selector.kind).join(' | ')}`,
                  )
                  .join('; ')
              : 'no subjects'}
          </div>
          <div>
            <span className="text-foreground">Dominates:</span>{' '}
            {analysis.broader.length ? analysis.broader.join(', ') : 'none'}
          </div>
          <div>
            <span className="text-foreground">Narrower rules:</span>{' '}
            {analysis.narrower.length ? analysis.narrower.join(', ') : 'none'}
          </div>
          <div>
            <span className="text-foreground">Overlaps:</span>{' '}
            {analysis.overlaps.length
              ? analysis.overlaps
                  .map((item) => `${item.ruleId}${item.certainty === 'unknown' ? ' (?)' : ''}`)
                  .join(', ')
              : 'none'}
          </div>
          <div>
            <span className="text-foreground">Priority:</span> {rule.priority}
          </div>
          <div>
            <span className="text-foreground">Guard:</span>{' '}
            {rule.guard.kind === 'always' ? 'always passes' : 'evaluated at runtime'}
          </div>
        </div>
        {analysis.conflicts.length > 0 && (
          <div className="mt-2 space-y-1">
            {analysis.conflicts.map((conflict) => (
              <div
                key={conflict.ruleId}
                className={
                  conflict.certainty === 'yes'
                    ? 'text-destructive'
                    : 'text-amber-700 dark:text-amber-400'
                }
              >
                {conflict.certainty === 'yes' ? 'Conflict' : 'Possible ambiguity'} with{' '}
                <code>{conflict.ruleId}</code>: {conflict.reason}.
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="space-y-3">
        <Label>Named slot selectors</Label>
        {rule.slots.map((slot, slotIndex) => (
          <section className="space-y-2 rounded border p-2" key={slot.slotId}>
            <div className="text-sm font-medium">{slot.slotId}</div>
            {slot.selectors.map((selector, selectorIndex) => (
              <SubjectSelectorEditor
                key={selectorIndex}
                value={selector}
                project={project}
                onChange={(nextSelector) =>
                  onChange({
                    ...rule,
                    slots: rule.slots.map((current, currentSlot) =>
                      currentSlot === slotIndex
                        ? {
                            ...current,
                            selectors: current.selectors.map((value, currentSelector) =>
                              currentSelector === selectorIndex ? nextSelector : value,
                            ),
                          }
                        : current,
                    ),
                  })
                }
                onDelete={
                  slot.selectors.length > 1
                    ? () =>
                        onChange({
                          ...rule,
                          slots: rule.slots.map((current, currentSlot) =>
                            currentSlot === slotIndex
                              ? {
                                  ...current,
                                  selectors: current.selectors.filter(
                                    (_, currentSelector) => currentSelector !== selectorIndex,
                                  ),
                                }
                              : current,
                          ),
                        })
                    : undefined
                }
              />
            ))}
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() =>
                onChange({
                  ...rule,
                  slots: rule.slots.map((current, currentSlot) =>
                    currentSlot === slotIndex
                      ? { ...current, selectors: [...current.selectors, { kind: 'any-subject' }] }
                      : current,
                  ),
                })
              }
            >
              Add selector
            </Button>
          </section>
        ))}
      </div>
      <div className="space-y-2 rounded border p-2">
        <label className="flex items-center gap-2 text-sm font-medium">
          <input
            type="checkbox"
            checked={rule.offer !== null}
            onChange={(event) =>
              onChange({
                ...rule,
                offer: event.currentTarget.checked
                  ? {
                      slotId: rule.slots[0]?.slotId ?? '',
                      rank: 0,
                      primary: false,
                    }
                  : null,
              })
            }
          />
          Derive Verb Offer from this rule
        </label>
        {rule.offer && (
          <div className="grid gap-2 md:grid-cols-4">
            <div>
              <Label>Offer slot</Label>
              <Select
                value={rule.offer.slotId}
                onValueChange={(slotId) =>
                  onChange({ ...rule, offer: { ...rule.offer!, slotId: String(slotId) } })
                }
              >
                {rule.slots.map((slot) => (
                  <SelectItem value={slot.slotId} key={slot.slotId}>
                    {slot.slotId}
                  </SelectItem>
                ))}
              </Select>
            </div>
            <div>
              <Label>Authored rank</Label>
              <Input
                type="number"
                value={rule.offer.rank}
                onChange={(event) =>
                  onChange({
                    ...rule,
                    offer: { ...rule.offer!, rank: Number(event.currentTarget.value) || 0 },
                  })
                }
              />
            </div>
            <label className="flex items-end gap-2 text-sm">
              <input
                type="checkbox"
                checked={rule.offer.primary}
                onChange={(event) =>
                  onChange({
                    ...rule,
                    offer: { ...rule.offer!, primary: event.currentTarget.checked },
                  })
                }
              />
              Primary
            </label>
            <div>
              <Label>Offer condition</Label>
              {rule.offer.condition ? (
                <div className="space-y-2">
                  <RecursiveConditionEditor
                    value={rule.offer.condition}
                    project={project}
                    scope={{ interactionSlots: [rule.offer.slotId], currentRoom: true }}
                    onChange={(condition) =>
                      onChange({ ...rule, offer: { ...rule.offer!, condition } })
                    }
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      onChange({ ...rule, offer: { ...rule.offer!, condition: undefined } })
                    }
                  >
                    Remove condition
                  </Button>
                </div>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    onChange({ ...rule, offer: { ...rule.offer!, condition: { kind: 'always' } } })
                  }
                >
                  Add condition
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
      <GuardEditor rule={rule} project={project} onChange={onChange} />
      <InteractionProgramEditor
        value={rule.program}
        project={project}
        interactionSlots={rule.slots.map((slot) => slot.slotId)}
        onChange={(program) => onChange({ ...rule, program })}
      />
    </section>
  );
}

function InteractionForm({
  interactionId,
  data,
  project,
  onChange,
}: {
  interactionId: string;
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
          slots: defaultSlots(project, verbId),
          offer: null,
          guard: { kind: 'always' },
          priority: 0,
          program: defaultInteractionProgram(),
        },
      ],
    });
  };
  const otherRules = Object.entries(project.interactions).flatMap(([id, record]) =>
    id === interactionId ? [] : (parseInteractionData(record.data)?.rules ?? []),
  );
  const analyses = analyzeInteractionRules(project, [...data.rules, ...otherRules]).slice(
    0,
    data.rules.length,
  );
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
          analysis={analyses[index]!}
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
      originSaveUnitId: recordSaveUnitId('interactions', id),
      persistencePolicy: 'manual-save',
    });
  return (
    <div className="h-full overflow-auto bg-background p-4">
      <div className="mb-4 flex gap-2">
        <h2 className="text-lg font-semibold">{record.label}</h2>
        <Badge variant="outline">{id}</Badge>
      </div>
      <InteractionForm interactionId={id} data={data} project={project} onChange={commit} />
    </div>
  );
}
