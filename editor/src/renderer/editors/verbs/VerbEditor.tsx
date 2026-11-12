import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { RecursiveConditionEditor } from '@/components/conditions/ConditionEditor';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectItem } from '@/components/ui/select';
import {
  AuthoredRecordErrors,
  AuthoredMemberIdInput,
  AuthoredMemberNumber,
  commitAuthoredRecord,
  useAuthoredRecordField,
} from '@/commands/authored-record-fields';
import { useProjectStore } from '@/project/project-store';
import { buildJsonPointer } from '@/project/json-pointer';
import { recordSaveUnitId } from '@/project/save-unit-registry';
import { selectPendingInput, usePendingInputStore } from '@/workbench/pending-input-store';
import type { WorkbenchEditorProps } from '@/workbench/editor-registry';
import type { Condition, TextContent } from '../../../shared/project-schema/authoring-flow';
import { renameVerbSlot } from './verb-slot-rename';
import { defaultVerbData, parseVerbData } from '../../../shared/project-schema/authoring-verbs';
import {
  SubjectSelectorEditor,
  defaultSubjectSelector,
} from '../interactions/SubjectSelectorEditor';
import {
  authoringProjectFromDocument,
  InteractionProgramEditor,
  type AuthoringEditorProject,
} from '@/editors/interactions/InteractionProgramEditor';

type VerbData = NonNullable<ReturnType<typeof parseVerbData>>;

function TextContentEditor({
  value,
  onChange,
  pending,
}: {
  value: TextContent;
  onChange: (next: TextContent) => void;
  pending: { owner: string; path: string };
}) {
  const raw = usePendingInputStore((state) =>
    selectPendingInput(state, pending.owner, pending.path),
  );
  const clearRaw = () =>
    usePendingInputStore.getState().clearPendingInput(pending.owner, pending.path);
  return (
    <div className="grid gap-2 @3xl:grid-cols-3">
      <Select
        value={value.source.kind}
        onValueChange={(kind) => {
          clearRaw();
          if (kind === 'localized') onChange({ ...value, source: { kind, key: 'text.key' } });
          else if (kind === 'lua-expression')
            onChange({ ...value, source: { kind, source: 'return ""' } });
          else onChange({ ...value, source: { kind: 'inline', text: '' } });
        }}
      >
        <SelectItem value="inline">Inline</SelectItem>
        <SelectItem value="localized">Localized key</SelectItem>
        <SelectItem value="lua-expression">Lua string</SelectItem>
      </Select>
      <Input
        aria-invalid={Boolean(raw)}
        value={
          raw?.value ??
          (value.source.kind === 'inline'
            ? value.source.text
            : value.source.kind === 'localized'
              ? value.source.key
              : value.source.source)
        }
        onChange={(event) => {
          const nextText = event.currentTarget.value;
          if (value.source.kind === 'lua-expression' && nextText === '') {
            // Empty Lua source is intentionally invalid, but must stay visible
            // and recoverable as exact raw input rather than being coerced or
            // dispatched to the native authoring state.
            usePendingInputStore.getState().setPendingInput(pending.owner, pending.path, {
              value: nextText,
              diagnosticCode: 'editor.pending-input.expression.invalid',
            });
            return;
          }
          clearRaw();
          if (value.source.kind === 'inline')
            onChange({ ...value, source: { kind: 'inline', text: nextText } });
          else if (value.source.kind === 'localized')
            onChange({ ...value, source: { kind: 'localized', key: nextText } });
          else
            onChange({
              ...value,
              source: { ...value.source, source: nextText },
            });
        }}
      />
      <Select
        value={value.markup}
        onValueChange={(markup) => onChange({ ...value, markup: markup as TextContent['markup'] })}
      >
        <SelectItem value="plain">Plain</SelectItem>
        <SelectItem value="active-text">Active text</SelectItem>
      </Select>
    </div>
  );
}

function ConditionEditor({
  value,
  project,
  onChange,
}: {
  value: Condition;
  project: AuthoringEditorProject;
  onChange: (next: Condition) => void;
}) {
  return <RecursiveConditionEditor value={value} project={project} onChange={onChange} />;
}

function VerbForm({
  verbId,
  data,
  project,
  onChange,
}: {
  verbId: string;
  data: VerbData;
  project: AuthoringEditorProject;
  onChange: (next: VerbData) => void;
}) {
  const owner = recordSaveUnitId('verbs', verbId);
  const rawPath = (...parts: string[]) =>
    buildJsonPointer(['verbs', verbId, 'data', ...parts, 'source', 'source']);
  const addSlot = () => {
    const used = new Set(data.slots.map((slot) => slot.id));
    let index = data.slots.length + 1;
    let id = `subject-${index}`;
    while (used.has(id)) id = `subject-${++index}`;
    const label = { source: { kind: 'inline' as const, text: id }, markup: 'plain' as const };
    onChange({
      ...data,
      slots: [
        ...data.slots,
        { id, label, prompt: label, selectors: [defaultSubjectSelector(project)] },
      ],
      bindingOrder: [...data.bindingOrder, id],
    });
  };
  return (
    <div className="space-y-4">
      <div className="flex items-end gap-2">
        <Button type="button" size="sm" variant="outline" onClick={addSlot}>
          Add subject slot
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!data.slots.length}
          onClick={() => {
            const used = new Set(data.offers.map((offer) => offer.id));
            let index = data.offers.length + 1;
            let id = `offer-${index}`;
            while (used.has(id)) id = `offer-${++index}`;
            onChange({
              ...data,
              offers: [
                ...data.offers,
                {
                  id,
                  slotId: data.bindingOrder[0] ?? data.slots[0]!.id,
                  selectors: [defaultSubjectSelector(project)],
                  rank: data.offers.length,
                  primary: false,
                },
              ],
            });
          }}
        >
          Add explicit Offer
        </Button>
      </div>
      <div>
        <Label>Action text</Label>
        <TextContentEditor
          value={data.actionText}
          pending={{ owner, path: rawPath('actionText') }}
          onChange={(actionText) => onChange({ ...data, actionText })}
        />
      </div>
      <div>
        <Label>Completed command text</Label>
        <TextContentEditor
          value={data.completedCommandText}
          pending={{ owner, path: rawPath('completedCommandText') }}
          onChange={(completedCommandText) => onChange({ ...data, completedCommandText })}
        />
      </div>
      <div className="space-y-3">
        <Label>Named subject slots</Label>
        {data.slots.map((slot, index) => (
          <section className="space-y-2 rounded border p-3" key={slot.id}>
            <div className="grid gap-2 @3xl:grid-cols-[1fr_auto_auto_auto]">
              <AuthoredMemberIdInput
                collection="verbs"
                recordId={verbId}
                family="slots"
                memberId={slot.id}
                ids={data.slots.map((item) => item.id)}
                label="Subject slot ID"
                onCommit={(id) => onChange(renameVerbSlot(data, slot.id, id))}
              />
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={data.bindingOrder.indexOf(slot.id) <= 0}
                onClick={() => {
                  const order = [...data.bindingOrder];
                  const at = order.indexOf(slot.id);
                  if (at <= 0) return;
                  [order[at - 1], order[at]] = [order[at], order[at - 1]];
                  onChange({ ...data, bindingOrder: order });
                }}
              >
                Earlier
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={data.bindingOrder.indexOf(slot.id) >= data.bindingOrder.length - 1}
                onClick={() => {
                  const order = [...data.bindingOrder];
                  const at = order.indexOf(slot.id);
                  if (at < 0 || at >= order.length - 1) return;
                  [order[at], order[at + 1]] = [order[at + 1], order[at]];
                  onChange({ ...data, bindingOrder: order });
                }}
              >
                Later
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() =>
                  onChange({
                    ...data,
                    slots: data.slots.filter((_, current) => current !== index),
                    bindingOrder: data.bindingOrder.filter((id) => id !== slot.id),
                    offers: data.offers.filter((offer) => offer.slotId !== slot.id),
                  })
                }
              >
                Delete
              </Button>
            </div>
            <div>
              <Label>Slot label</Label>
              <TextContentEditor
                value={slot.label}
                pending={{ owner, path: rawPath('slots', '@' + slot.id, 'label') }}
                onChange={(label) =>
                  onChange({
                    ...data,
                    slots: data.slots.map((item, current) =>
                      current === index ? { ...item, label } : item,
                    ),
                  })
                }
              />
            </div>
            <div>
              <Label>Slot prompt</Label>
              <TextContentEditor
                value={slot.prompt}
                pending={{ owner, path: rawPath('slots', '@' + slot.id, 'prompt') }}
                onChange={(prompt) =>
                  onChange({
                    ...data,
                    slots: data.slots.map((item, current) =>
                      current === index ? { ...item, prompt } : item,
                    ),
                  })
                }
              />
            </div>
            <div className="space-y-2">
              <Label>Allowed subjects</Label>
              {slot.selectors.map((selector, selectorIndex) => (
                <SubjectSelectorEditor
                  key={selectorIndex}
                  value={selector}
                  project={project}
                  onChange={(next) =>
                    onChange({
                      ...data,
                      slots: data.slots.map((item, current) =>
                        current === index
                          ? {
                              ...item,
                              selectors: item.selectors.map((value, currentSelector) =>
                                currentSelector === selectorIndex ? next : value,
                              ),
                            }
                          : item,
                      ),
                    })
                  }
                  onDelete={
                    slot.selectors.length > 1
                      ? () =>
                          onChange({
                            ...data,
                            slots: data.slots.map((item, current) =>
                              current === index
                                ? {
                                    ...item,
                                    selectors: item.selectors.filter(
                                      (_, currentSelector) => currentSelector !== selectorIndex,
                                    ),
                                  }
                                : item,
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
                    ...data,
                    slots: data.slots.map((item, current) =>
                      current === index
                        ? { ...item, selectors: [...item.selectors, { kind: 'any-subject' }] }
                        : item,
                    ),
                  })
                }
              >
                Add selector
              </Button>
            </div>
          </section>
        ))}
        {data.slots.length > 0 && (
          <p className="text-xs text-muted-foreground">
            Binding order: {data.bindingOrder.join(' → ')}
          </p>
        )}
      </div>
      <div className="space-y-3">
        <Label>Explicit Offers</Label>
        {data.offers.map((offer, offerIndex) => (
          <section className="space-y-2 rounded border p-3" key={offer.id}>
            <div className="grid gap-2 @3xl:grid-cols-4">
              <div>
                <Label>Offer ID</Label>
                <AuthoredMemberIdInput
                  collection="verbs"
                  recordId={verbId}
                  family="offers"
                  memberId={offer.id}
                  ids={data.offers.map((item) => item.id)}
                  label="Offer ID"
                  onCommit={(id) =>
                    onChange({
                      ...data,
                      offers: data.offers.map((current, index) =>
                        index === offerIndex ? { ...current, id } : current,
                      ),
                    })
                  }
                />
              </div>
              <div>
                <Label>Starting slot</Label>
                <Select
                  value={offer.slotId}
                  onValueChange={(slotId) =>
                    onChange({
                      ...data,
                      offers: data.offers.map((current, index) =>
                        index === offerIndex ? { ...current, slotId: String(slotId) } : current,
                      ),
                    })
                  }
                >
                  {data.bindingOrder.map((slotId) => (
                    <SelectItem value={slotId} key={slotId}>
                      {slotId}
                    </SelectItem>
                  ))}
                </Select>
              </div>
              <div>
                <Label>Authored rank</Label>
                <AuthoredMemberNumber
                  collection="verbs"
                  recordId={verbId}
                  memberId={offer.id}
                  field="rank"
                  label="Authored rank"
                  mode="integer"
                  value={offer.rank}
                  onChange={(rank) =>
                    onChange({
                      ...data,
                      offers: data.offers.map((current, index) =>
                        index === offerIndex ? { ...current, rank } : current,
                      ),
                    })
                  }
                />
              </div>
              <div className="flex items-end justify-between gap-2">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={offer.primary}
                    onChange={(event) =>
                      onChange({
                        ...data,
                        offers: data.offers.map((current, index) =>
                          index === offerIndex
                            ? { ...current, primary: event.currentTarget.checked }
                            : current,
                        ),
                      })
                    }
                  />
                  Primary
                </label>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    onChange({
                      ...data,
                      offers: data.offers.filter((_, index) => index !== offerIndex),
                    })
                  }
                >
                  Delete
                </Button>
              </div>
            </div>
            <div className="space-y-2">
              <Label>Subject selectors</Label>
              {offer.selectors.map((selector, selectorIndex) => (
                <SubjectSelectorEditor
                  key={selectorIndex}
                  value={selector}
                  project={project}
                  onChange={(next) =>
                    onChange({
                      ...data,
                      offers: data.offers.map((current, index) =>
                        index === offerIndex
                          ? {
                              ...current,
                              selectors: current.selectors.map((value, currentSelector) =>
                                currentSelector === selectorIndex ? next : value,
                              ),
                            }
                          : current,
                      ),
                    })
                  }
                  onDelete={
                    offer.selectors.length > 1
                      ? () =>
                          onChange({
                            ...data,
                            offers: data.offers.map((current, index) =>
                              index === offerIndex
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
                    ...data,
                    offers: data.offers.map((current, index) =>
                      index === offerIndex
                        ? { ...current, selectors: [...current.selectors, { kind: 'any-subject' }] }
                        : current,
                    ),
                  })
                }
              >
                Add selector
              </Button>
            </div>
            <div>
              <label className="mb-2 flex items-center gap-2 text-sm font-medium">
                <input
                  type="checkbox"
                  checked={offer.condition !== undefined}
                  onChange={(event) =>
                    onChange({
                      ...data,
                      offers: data.offers.map((current, index) =>
                        index === offerIndex
                          ? {
                              ...current,
                              condition: event.currentTarget.checked
                                ? { kind: 'always' }
                                : undefined,
                            }
                          : current,
                      ),
                    })
                  }
                />
                Offer condition
              </label>
              {offer.condition && (
                <ConditionEditor
                  value={offer.condition}
                  project={project}
                  onChange={(condition) =>
                    onChange({
                      ...data,
                      offers: data.offers.map((current, index) =>
                        index === offerIndex ? { ...current, condition } : current,
                      ),
                    })
                  }
                />
              )}
            </div>
          </section>
        ))}
        {!data.offers.length && (
          <p className="text-xs text-muted-foreground">
            No explicit Offers. Interaction Rules can opt in to rule-derived Offers.
          </p>
        )}
      </div>
      <div>
        <Label>Availability</Label>
        <ConditionEditor
          value={data.availability}
          project={project}
          onChange={(availability) => onChange({ ...data, availability })}
        />
      </div>
      <section>
        <h3 className="mb-2 text-sm font-medium">Default Interaction Program</h3>
        <InteractionProgramEditor
          value={data.defaultProgram}
          project={project}
          interactionSlots={data.slots.map((slot) => slot.id)}
          onChange={(defaultProgram) => onChange({ ...data, defaultProgram })}
        />
      </section>
    </div>
  );
}

export function VerbEditor({ tab }: WorkbenchEditorProps) {
  const document = useProjectStore((state) => state.document);
  const project = authoringProjectFromDocument(document);
  const id = tab.resource?.entityId;
  const record = id && project ? project.verbs[id] : null;
  const acknowledged = parseVerbData(record?.data) ?? defaultVerbData();
  const kind = useAuthoredRecordField('verbs', id, tab.id, 'kind', acknowledged.kind);
  const slots = useAuthoredRecordField('verbs', id, tab.id, 'slots', acknowledged.slots);
  const bindingOrder = useAuthoredRecordField(
    'verbs',
    id,
    tab.id,
    'bindingOrder',
    acknowledged.bindingOrder,
  );
  const actionText = useAuthoredRecordField(
    'verbs',
    id,
    tab.id,
    'actionText',
    acknowledged.actionText,
  );
  const completedCommandText = useAuthoredRecordField(
    'verbs',
    id,
    tab.id,
    'completedCommandText',
    acknowledged.completedCommandText,
  );
  const offers = useAuthoredRecordField('verbs', id, tab.id, 'offers', acknowledged.offers);
  const availability = useAuthoredRecordField(
    'verbs',
    id,
    tab.id,
    'availability',
    acknowledged.availability,
  );
  const defaultProgram = useAuthoredRecordField(
    'verbs',
    id,
    tab.id,
    'defaultProgram',
    acknowledged.defaultProgram,
  );
  const fields = {
    kind,
    slots,
    bindingOrder,
    actionText,
    completedCommandText,
    offers,
    availability,
    defaultProgram,
  };
  const data: VerbData = {
    kind: kind.value,
    slots: slots.value,
    bindingOrder: bindingOrder.value,
    actionText: actionText.value,
    completedCommandText: completedCommandText.value,
    offers: offers.value,
    availability: availability.value,
    defaultProgram: defaultProgram.value,
  };
  if (!project || !id || !record || !parseVerbData(record.data))
    return <div className="p-4 text-sm text-muted-foreground">Verb record not found.</div>;
  const commit = (next: VerbData) =>
    commitAuthoredRecord({
      collection: 'verbs',
      id,
      before: data,
      after: next,
      fields,
      label: 'Update verb',
    });
  return (
    <div className="h-full overflow-auto bg-background p-4">
      <div className="mb-4 flex gap-2">
        <h2 className="text-lg font-semibold">{record.label}</h2>
        <Badge variant="outline">{id}</Badge>
      </div>
      <AuthoredRecordErrors fields={fields} collection="verbs" recordId={id} />
      <VerbForm verbId={id} data={data} project={project} onChange={commit} />
    </div>
  );
}
