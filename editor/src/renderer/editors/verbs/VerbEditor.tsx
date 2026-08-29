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
import type { Condition, TextContent } from '../../../shared/project-schema/authoring-flow';
import { parseVerbData } from '../../../shared/project-schema/authoring-verbs';
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
}: {
  value: TextContent;
  onChange: (next: TextContent) => void;
}) {
  return (
    <div className="grid gap-2 md:grid-cols-3">
      <Select
        value={value.source.kind}
        onValueChange={(kind) => {
          if (kind === 'localized') onChange({ ...value, source: { kind, key: 'text-key' } });
          else if (kind === 'lua-expression')
            onChange({ ...value, source: { kind, source: 'return ""' } });
          else onChange({ ...value, source: { kind: 'inline', text: '' } });
        }}
      >
        <SelectItem value="inline">Inline</SelectItem>
        <SelectItem value="localized">Localized key</SelectItem>
        <SelectItem value="lua-expression">Lua expression</SelectItem>
      </Select>
      <Input
        value={
          value.source.kind === 'inline'
            ? value.source.text
            : value.source.kind === 'localized'
              ? value.source.key
              : value.source.source
        }
        onChange={(event) => {
          if (value.source.kind === 'inline')
            onChange({ ...value, source: { kind: 'inline', text: event.currentTarget.value } });
          else if (value.source.kind === 'localized')
            onChange({ ...value, source: { kind: 'localized', key: event.currentTarget.value } });
          else
            onChange({
              ...value,
              source: { kind: 'lua-expression', source: event.currentTarget.value || ' ' },
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
  data,
  project,
  onChange,
}: {
  data: VerbData;
  project: AuthoringEditorProject;
  onChange: (next: VerbData) => void;
}) {
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
          onChange={(actionText) => onChange({ ...data, actionText })}
        />
      </div>
      <div>
        <Label>Completed command text</Label>
        <TextContentEditor
          value={data.completedCommandText}
          onChange={(completedCommandText) => onChange({ ...data, completedCommandText })}
        />
      </div>
      <div className="space-y-3">
        <Label>Named subject slots</Label>
        {data.slots.map((slot, index) => (
          <section className="space-y-2 rounded border p-3" key={slot.id}>
            <div className="grid gap-2 md:grid-cols-[1fr_auto_auto_auto]">
              <Input
                value={slot.id}
                onChange={(event) => {
                  const id = event.currentTarget.value;
                  onChange({
                    ...data,
                    slots: data.slots.map((item, current) =>
                      current === index ? { ...item, id } : item,
                    ),
                    bindingOrder: data.bindingOrder.map((current) =>
                      current === slot.id ? id : current,
                    ),
                    offers: data.offers.map((offer) =>
                      offer.slotId === slot.id ? { ...offer, slotId: id } : offer,
                    ),
                  });
                }}
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
            <div className="grid gap-2 md:grid-cols-4">
              <div>
                <Label>Offer ID</Label>
                <Input
                  value={offer.id}
                  onChange={(event) =>
                    onChange({
                      ...data,
                      offers: data.offers.map((current, index) =>
                        index === offerIndex
                          ? { ...current, id: event.currentTarget.value }
                          : current,
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
                <Input
                  type="number"
                  value={offer.rank}
                  onChange={(event) =>
                    onChange({
                      ...data,
                      offers: data.offers.map((current, index) =>
                        index === offerIndex
                          ? { ...current, rank: Number(event.currentTarget.value) || 0 }
                          : current,
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
  const data = parseVerbData(record?.data);
  if (!project || !id || !record || !data)
    return <div className="p-4 text-sm text-muted-foreground">Verb record not found.</div>;
  const commit = (next: VerbData) =>
    useCommandStore.getState().executeCommand({
      type: 'verb.replaceData',
      label: 'Update verb',
      payload: { verbId: id, data: next },
      originSaveUnitId: recordSaveUnitId('verbs', id),
      persistencePolicy: 'manual-save',
    });
  return (
    <div className="h-full overflow-auto bg-background p-4">
      <div className="mb-4 flex gap-2">
        <h2 className="text-lg font-semibold">{record.label}</h2>
        <Badge variant="outline">{id}</Badge>
      </div>
      <VerbForm data={data} project={project} onChange={commit} />
    </div>
  );
}
