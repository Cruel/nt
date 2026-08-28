import { useMemo, useState } from 'react';
import { Plus, RotateCcw, Trash2, Unlink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogDescription, DialogPopup, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import {
  effectiveInteractableDefinitionProperties,
  effectiveInteractableInstanceProperties,
  effectiveInteractableInstanceTraits,
} from '../../../shared/project-schema/authoring-interactable-properties';
import type { InteractableInstanceData } from '../../../shared/project-schema/authoring-interactables';
import type { AuthoringProject } from '../../../shared/project-schema/authoring-project';
import {
  arePropertySchemasCompatible,
  type AuthoredRuntimeValue,
  type OwnerDefaultProperty,
  type OwnerLocalProperty,
} from '../../../shared/project-schema/authoring-properties';
import {
  parseVariableValueText,
  variableValueToText,
} from '../../../shared/project-schema/authoring-variables';
import {
  newTypedPropertyDraft,
  ownerDefaultPropertyFromDraft,
  ownerLocalPropertyFromDraft,
  TypedPropertyFields,
  typedPropertyDraftFromOwnerDefault,
  typedPropertyDraftFromOwnerLocal,
  type TypedPropertyDraft,
} from './TypedPropertyFields';

function formatValue(value: AuthoredRuntimeValue | undefined) {
  if (value === undefined) return 'Missing';
  if (value === null) return 'null';
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

function traitChoices(project: AuthoringProject, attached: readonly string[]) {
  return Object.entries(project.traits)
    .filter(([id, trait]) => !attached.includes(id) && trait.ownerKinds.includes('interactable'))
    .sort(([, left], [, right]) => left.label.localeCompare(right.label));
}

export function InteractableDefinitionPropertiesEditor({
  project,
  definitionId,
  properties,
  attachedTraits,
  onChange,
}: {
  project: AuthoringProject;
  definitionId: string;
  properties: readonly OwnerDefaultProperty[];
  attachedTraits: readonly string[];
  onChange: (state: { properties: OwnerDefaultProperty[]; traits: string[] }) => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<TypedPropertyDraft>(() => newTypedPropertyDraft());
  const [message, setMessage] = useState<string | null>(null);
  const [traitId, setTraitId] = useState('');
  const effective = useMemo(
    () => effectiveInteractableDefinitionProperties(project, definitionId),
    [definitionId, project],
  );
  const availableTraits = useMemo(
    () => traitChoices(project, attachedTraits),
    [attachedTraits, project],
  );
  const localById = useMemo(() => new Map(properties.map((item) => [item.id, item])), [properties]);

  const openNew = () => {
    setEditingId('');
    setDraft(newTypedPropertyDraft());
    setMessage(null);
  };
  const openEdit = (property: OwnerDefaultProperty) => {
    setEditingId(property.id);
    setDraft(typedPropertyDraftFromOwnerDefault(property));
    setMessage(null);
  };
  const submit = () => {
    const parsed = ownerDefaultPropertyFromDraft(draft);
    if (!parsed.ok) {
      setMessage(parsed.message);
      return;
    }
    const oldId = editingId ?? '';
    const existingEffective = effective.find((item) => item.id === parsed.property.id);
    if (oldId === '' && existingEffective) {
      setMessage(
        `Property '${parsed.property.id}' is already effective. Edit or override the existing row instead.`,
      );
      return;
    }
    const editingLocal = oldId !== '' && properties.some((item) => item.id === oldId);
    if (oldId !== '' && !editingLocal && parsed.property.id !== oldId) {
      setMessage('An inherited Property keeps its existing ID when specialized by the definition.');
      return;
    }
    if (properties.some((item) => item.id === parsed.property.id && item.id !== oldId)) {
      setMessage(`Property '${parsed.property.id}' already exists on this definition.`);
      return;
    }
    const next =
      oldId === ''
        ? [...properties, parsed.property]
        : editingLocal
          ? properties.map((item) => (item.id === oldId ? parsed.property : item))
          : [...properties, parsed.property];
    onChange({ properties: next, traits: [...attachedTraits] });
    setEditingId(null);
  };
  const setTraitDefault = (propertyId: string) => {
    const row = effective.find((item) => item.id === propertyId);
    if (!row) return;
    const value = row.defaultValue;
    const property: OwnerDefaultProperty = {
      id: row.id,
      ...(row.contract.label ? { label: row.contract.label } : {}),
      ...(row.contract.description ? { description: row.contract.description } : {}),
      type: row.contract.type,
      nullable: row.contract.nullable,
      ...(row.contract.enumValues ? { enumValues: [...row.contract.enumValues] } : {}),
      ...(value === undefined ? {} : { defaultValue: value }),
    };
    openEdit(property);
  };
  const attachTrait = () => {
    if (!traitId) return;
    const trait = project.traits[traitId];
    if (!trait) return;
    for (const member of trait.properties) {
      const row = effective.find((item) => item.id === member.id);
      if (row && !arePropertySchemasCompatible(row.contract, member)) {
        setMessage(
          `Cannot attach '${trait.label}': Property '${member.id}' has an incompatible effective schema.`,
        );
        return;
      }
    }
    onChange({ properties: [...properties], traits: [...attachedTraits, traitId] });
    setTraitId('');
    setMessage(null);
  };

  return (
    <section
      className="space-y-3 rounded-md border p-3"
      data-workbench-anchor="interactable.properties"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">Properties</h3>
          <p className="text-xs text-muted-foreground">
            Reusable Property schemas and optional Defaults for Interactable Instances.
          </p>
        </div>
        <Button size="sm" onClick={openNew}>
          <Plus className="size-4" /> Add Property
        </Button>
      </div>

      <div className="space-y-2 rounded border bg-muted/20 p-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium">Traits</span>
          {attachedTraits.map((id) => (
            <div
              key={id}
              className="flex items-center gap-1 rounded border bg-background px-2 py-1"
            >
              <span className="text-xs">{project.traits[id]?.label ?? id}</span>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={`Detach ${id}`}
                onClick={() =>
                  onChange({
                    properties: [...properties],
                    traits: attachedTraits.filter((candidate) => candidate !== id),
                  })
                }
              >
                <Unlink className="size-3" />
              </Button>
            </div>
          ))}
          {attachedTraits.length === 0 ? (
            <span className="text-xs text-muted-foreground">No Traits attached.</span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <Select value={traitId} onValueChange={(value) => setTraitId(value ?? '')}>
            <SelectTrigger className="!h-8 min-w-48" aria-label="Trait to attach">
              <SelectValue placeholder="Choose Trait" />
            </SelectTrigger>
            <SelectContent>
              {availableTraits.map(([id, trait]) => (
                <SelectItem key={id} value={id}>
                  {trait.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button size="sm" variant="outline" disabled={!traitId} onClick={attachTrait}>
            Attach Trait
          </Button>
        </div>
      </div>

      <div className="overflow-hidden rounded border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-3 py-2">Property</th>
              <th className="w-px whitespace-nowrap px-3 py-2">Type</th>
              <th className="px-3 py-2">Default</th>
              <th className="w-px px-2 py-2">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {effective.length === 0 ? (
              <tr>
                <td colSpan={4} className="p-5 text-center text-xs text-muted-foreground">
                  No Property contracts.
                </td>
              </tr>
            ) : null}
            {effective.map((row) => {
              const local = localById.get(row.id);
              return (
                <tr key={row.id} className="border-t">
                  <td className="px-3 py-2">
                    <div className="font-medium">{row.contract.label ?? row.id}</div>
                    <div className="font-mono text-[11px] text-muted-foreground">{row.id}</div>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-xs text-muted-foreground">
                    {row.contract.type}
                    {row.contract.nullable ? '?' : ''}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">
                    {formatValue(row.defaultValue)}
                    <span className="ml-2 font-sans text-muted-foreground">
                      {local ? 'definition' : row.source}
                    </span>
                  </td>
                  <td className="px-1 py-1">
                    <div className="flex justify-end">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => (local ? openEdit(local) : setTraitDefault(row.id))}
                      >
                        Edit
                      </Button>
                      {local ? (
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          className="text-destructive"
                          aria-label={`Delete ${row.id}`}
                          onClick={() =>
                            onChange({
                              properties: properties.filter((item) => item.id !== row.id),
                              traits: [...attachedTraits],
                            })
                          }
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {message ? <p className="text-xs text-destructive">{message}</p> : null}

      <Dialog open={editingId !== null} onOpenChange={(open) => !open && setEditingId(null)}>
        <DialogPopup className="w-[min(620px,calc(100vw-2rem))]">
          <DialogTitle>{editingId === '' ? 'Add Property' : 'Edit Property'}</DialogTitle>
          <DialogDescription>
            This reusable contract may omit its Default; concrete Instances must resolve a Value.
          </DialogDescription>
          <TypedPropertyFields
            draft={draft}
            onChange={setDraft}
            valueLabel="Default"
            valueOptional
          />
          {message ? <p className="text-xs text-destructive">{message}</p> : null}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setEditingId(null)}>
              Cancel
            </Button>
            <Button onClick={submit}>{editingId === '' ? 'Add Property' : 'Save changes'}</Button>
          </div>
        </DialogPopup>
      </Dialog>
    </section>
  );
}

export function InteractableInstancePropertiesEditor({
  project,
  instanceId,
  instance,
  onChange,
  compact = false,
}: {
  project: AuthoringProject;
  instanceId: string;
  instance: InteractableInstanceData;
  onChange: (instance: InteractableInstanceData) => void;
  compact?: boolean;
}) {
  const [editingLocalId, setEditingLocalId] = useState<string | null>(null);
  const [draft, setDraft] = useState<TypedPropertyDraft>(() => newTypedPropertyDraft());
  const [editingValueId, setEditingValueId] = useState<string | null>(null);
  const [valueText, setValueText] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [traitId, setTraitId] = useState('');
  const rows = useMemo(
    () => effectiveInteractableInstanceProperties(project, instance),
    [instance, project],
  );
  const effectiveTraits = useMemo(
    () => effectiveInteractableInstanceTraits(project, instance),
    [instance, project],
  );
  const definitionTraits = useMemo(
    () =>
      new Set(
        effectiveInteractableInstanceTraits(project, {
          ...instance,
          traits: { add: [], remove: [] },
        }),
      ),
    [instance, project],
  );
  const availableTraits = useMemo(
    () => traitChoices(project, effectiveTraits),
    [effectiveTraits, project],
  );
  const editingValue = rows.find((row) => row.id === editingValueId);

  const updateTraits = (nextTraits: string[]) => {
    const add = nextTraits.filter((id) => !definitionTraits.has(id));
    const remove = [...definitionTraits].filter((id) => !nextTraits.includes(id));
    onChange({ ...instance, traits: { add, remove } });
  };
  const attachTrait = () => {
    if (!traitId) return;
    const trait = project.traits[traitId];
    if (!trait) return;
    for (const member of trait.properties) {
      const existing = rows.find((row) => row.id === member.id);
      if (existing && !arePropertySchemasCompatible(existing.contract, member)) {
        setMessage(
          `Cannot attach '${trait.label}': Property '${member.id}' has an incompatible effective schema.`,
        );
        return;
      }
    }
    const nextLocal = [...instance.localProperties];
    const nextOverrides = { ...instance.properties };
    for (const member of trait.properties) {
      const localIndex = nextLocal.findIndex((property) => property.id === member.id);
      if (localIndex < 0) continue;
      const local = nextLocal[localIndex]!;
      if (!arePropertySchemasCompatible(local, member)) continue;
      nextOverrides[member.id] = local.value;
      nextLocal.splice(localIndex, 1);
    }
    const nextTraits = [...effectiveTraits, traitId];
    const add = nextTraits.filter((id) => !definitionTraits.has(id));
    const remove = [...definitionTraits].filter((id) => !nextTraits.includes(id));
    onChange({
      ...instance,
      traits: { add, remove },
      properties: nextOverrides,
      localProperties: nextLocal,
    });
    setTraitId('');
    setMessage(null);
  };
  const detachTrait = (id: string) => {
    const departing = project.traits[id];
    const remainingTraits = effectiveTraits.filter((candidate) => candidate !== id);
    const remainingInstance: InteractableInstanceData = {
      ...instance,
      traits: {
        add: remainingTraits.filter((candidate) => !definitionTraits.has(candidate)),
        remove: [...definitionTraits].filter((candidate) => !remainingTraits.includes(candidate)),
      },
    };
    const remainingRows = effectiveInteractableInstanceProperties(project, remainingInstance);
    const remainingIds = new Set(remainingRows.map((row) => row.id));
    const nextOverrides = { ...instance.properties };
    const nextLocal = [...instance.localProperties];
    for (const member of departing?.properties ?? []) {
      if (remainingIds.has(member.id)) continue;
      if (!Object.prototype.hasOwnProperty.call(nextOverrides, member.id)) continue;
      const value = nextOverrides[member.id]!;
      if (!nextLocal.some((item) => item.id === member.id)) {
        nextLocal.push({
          id: member.id,
          ...(member.label ? { label: member.label } : {}),
          ...(member.description ? { description: member.description } : {}),
          type: member.type,
          nullable: member.nullable,
          value,
          ...(member.enumValues ? { enumValues: [...member.enumValues] } : {}),
        });
      }
      delete nextOverrides[member.id];
    }
    onChange({ ...remainingInstance, properties: nextOverrides, localProperties: nextLocal });
  };
  const openNew = () => {
    setEditingLocalId('');
    setDraft(newTypedPropertyDraft());
    setMessage(null);
  };
  const openLocal = (property: OwnerLocalProperty) => {
    setEditingLocalId(property.id);
    setDraft(typedPropertyDraftFromOwnerLocal(property));
    setMessage(null);
  };
  const saveLocal = () => {
    const parsed = ownerLocalPropertyFromDraft(draft);
    if (!parsed.ok) {
      setMessage(parsed.message);
      return;
    }
    const oldId = editingLocalId ?? '';
    if (oldId === '' && rows.some((row) => row.id === parsed.property.id)) {
      setMessage(
        `Property '${parsed.property.id}' is already effective. Edit or override the existing row instead.`,
      );
      return;
    }
    if (
      instance.localProperties.some(
        (property) => property.id === parsed.property.id && property.id !== oldId,
      )
    ) {
      setMessage(`Property '${parsed.property.id}' already exists on this Instance.`);
      return;
    }
    const localProperties =
      oldId === ''
        ? [...instance.localProperties, parsed.property]
        : instance.localProperties.map((property) =>
            property.id === oldId ? parsed.property : property,
          );
    onChange({ ...instance, localProperties });
    setEditingLocalId(null);
  };
  const openValue = (id: string) => {
    const row = rows.find((candidate) => candidate.id === id);
    if (!row) return;
    setEditingValueId(id);
    setValueText(variableValueToText(row.value ?? null));
    setMessage(null);
  };
  const saveValue = () => {
    if (!editingValue) return;
    const parsed = parseVariableValueText(
      editingValue.contract.type,
      valueText,
      editingValue.contract.enumValues,
      editingValue.contract.nullable,
    );
    if (!parsed.ok) {
      setMessage(parsed.message);
      return;
    }
    onChange({
      ...instance,
      properties: { ...instance.properties, [editingValue.id]: parsed.value },
      localProperties:
        !editingValue.localOnly && editingValue.localProperty
          ? instance.localProperties.filter((item) => item.id !== editingValue.id)
          : instance.localProperties,
    });
    setEditingValueId(null);
  };

  return (
    <section
      className={`space-y-3 rounded-md border ${compact ? 'p-2' : 'p-3'}`}
      data-instance-properties={instanceId}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h4 className="text-sm font-semibold">Instance Properties</h4>
          <p className="text-xs text-muted-foreground">
            Exact state for <span className="font-mono">{instanceId}</span>.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={openNew}>
          <Plus className="size-4" /> Add local
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium">Traits</span>
        {effectiveTraits.map((id) => (
          <div key={id} className="flex items-center gap-1 rounded border px-2 py-1">
            <span className="text-xs">{project.traits[id]?.label ?? id}</span>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={`Detach ${id}`}
              onClick={() => detachTrait(id)}
            >
              <Unlink className="size-3" />
            </Button>
          </div>
        ))}
        <Select value={traitId} onValueChange={(value) => setTraitId(value ?? '')}>
          <SelectTrigger className="!h-7 min-w-40" aria-label="Instance Trait to attach">
            <SelectValue placeholder="Add Trait" />
          </SelectTrigger>
          <SelectContent>
            {availableTraits.map(([id, trait]) => (
              <SelectItem key={id} value={id}>
                {trait.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button size="sm" variant="ghost" disabled={!traitId} onClick={attachTrait}>
          Attach
        </Button>
      </div>
      <div className="overflow-hidden rounded border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-3 py-2">Property</th>
              <th className="w-px whitespace-nowrap px-3 py-2">Type</th>
              <th className="px-3 py-2">Value</th>
              <th className="w-px px-2 py-2">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={4} className="p-4 text-center text-xs text-muted-foreground">
                  No Properties.
                </td>
              </tr>
            ) : null}
            {rows.map((row) => {
              const hasStoredOverride = Object.prototype.hasOwnProperty.call(
                instance.properties,
                row.id,
              );
              const hasLocalOverride = !row.localOnly && row.localProperty !== undefined;
              const hasOverride = hasStoredOverride || hasLocalOverride;
              return (
                <tr key={row.id} className={`border-t ${row.localOnly ? 'bg-muted/15' : ''}`}>
                  <td className="px-3 py-2">
                    <div className="font-medium">{row.contract.label ?? row.id}</div>
                    <div className="font-mono text-[11px] text-muted-foreground">{row.id}</div>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-xs text-muted-foreground">
                    {row.contract.type}
                    {row.contract.nullable ? '?' : ''}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">
                    {formatValue(row.value)}
                    <span className="ml-2 font-sans text-muted-foreground">
                      {row.localOnly
                        ? 'local'
                        : hasOverride
                          ? 'override'
                          : row.hasValue
                            ? row.source
                            : 'required'}
                    </span>
                  </td>
                  <td className="px-1 py-1">
                    <div className="flex justify-end">
                      {row.localOnly && row.localProperty ? (
                        <>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => openLocal(row.localProperty!)}
                          >
                            Edit
                          </Button>
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            className="text-destructive"
                            aria-label={`Delete ${row.id}`}
                            onClick={() =>
                              onChange({
                                ...instance,
                                localProperties: instance.localProperties.filter(
                                  (item) => item.id !== row.id,
                                ),
                              })
                            }
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        </>
                      ) : (
                        <>
                          {hasOverride ? (
                            <Button
                              size="icon-sm"
                              variant="ghost"
                              aria-label={`Reset ${row.id}`}
                              onClick={() => {
                                const properties = { ...instance.properties };
                                delete properties[row.id];
                                onChange({
                                  ...instance,
                                  properties,
                                  localProperties: hasLocalOverride
                                    ? instance.localProperties.filter((item) => item.id !== row.id)
                                    : instance.localProperties,
                                });
                              }}
                            >
                              <RotateCcw className="size-4" />
                            </Button>
                          ) : null}
                          <Button size="sm" variant="ghost" onClick={() => openValue(row.id)}>
                            Set Value
                          </Button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {message ? <p className="text-xs text-destructive">{message}</p> : null}

      <Dialog
        open={editingLocalId !== null}
        onOpenChange={(open) => !open && setEditingLocalId(null)}
      >
        <DialogPopup className="w-[min(620px,calc(100vw-2rem))]">
          <DialogTitle>
            {editingLocalId === '' ? 'Add Instance Property' : 'Edit Instance Property'}
          </DialogTitle>
          <DialogDescription>
            A completely Instance-local typed Property and concrete Value.
          </DialogDescription>
          <TypedPropertyFields draft={draft} onChange={setDraft} valueLabel="Value" />
          {message ? <p className="text-xs text-destructive">{message}</p> : null}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setEditingLocalId(null)}>
              Cancel
            </Button>
            <Button onClick={saveLocal}>
              {editingLocalId === '' ? 'Add Property' : 'Save changes'}
            </Button>
          </div>
        </DialogPopup>
      </Dialog>

      <Dialog
        open={editingValueId !== null}
        onOpenChange={(open) => !open && setEditingValueId(null)}
      >
        <DialogPopup className="w-[min(460px,calc(100vw-2rem))]">
          <DialogTitle>Set Instance Value</DialogTitle>
          <DialogDescription>
            Overrides the inherited effective Value for this exact Instance.
          </DialogDescription>
          {editingValue ? (
            <div className="space-y-2">
              <Label>Value</Label>
              {editingValue.contract.type === 'boolean' ? (
                <div className="flex items-center gap-2">
                  <Switch
                    checked={valueText === 'true'}
                    onCheckedChange={(value) => setValueText(String(value))}
                  />
                  <span className="text-sm text-muted-foreground">{valueText}</span>
                </div>
              ) : editingValue.contract.type === 'enum' ? (
                <Select value={valueText} onValueChange={(value) => value && setValueText(value)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(editingValue.contract.enumValues ?? []).map((value) => (
                      <SelectItem key={value} value={value}>
                        {value}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  type={
                    editingValue.contract.type === 'integer' ||
                    editingValue.contract.type === 'number'
                      ? 'number'
                      : 'text'
                  }
                  step={
                    editingValue.contract.type === 'integer'
                      ? 1
                      : editingValue.contract.type === 'number'
                        ? 'any'
                        : undefined
                  }
                  value={valueText}
                  onChange={(event) => setValueText(event.currentTarget.value)}
                />
              )}
              {editingValue.contract.nullable ? (
                <Button size="sm" variant="outline" onClick={() => setValueText('null')}>
                  Set null
                </Button>
              ) : null}
            </div>
          ) : null}
          {message ? <p className="text-xs text-destructive">{message}</p> : null}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setEditingValueId(null)}>
              Cancel
            </Button>
            <Button onClick={saveValue}>Save Value</Button>
          </div>
        </DialogPopup>
      </Dialog>
    </section>
  );
}
