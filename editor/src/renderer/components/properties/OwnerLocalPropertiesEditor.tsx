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
  arePropertySchemasCompatible,
  authoredRuntimeValuesEqual,
  type AuthoredRuntimeValue,
  type OwnerDefaultProperty,
  type OwnerLocalProperty,
  type PropertyAssignments,
  type PropertyOwnerKind,
  type TraitDefinition,
  type TraitProperty,
} from '../../../shared/project-schema/authoring-properties';
import {
  parseVariableValueText,
  variableValueToText,
} from '../../../shared/project-schema/authoring-variables';
import type { InheritedDefaultProperty } from './OwnerDefaultPropertiesEditor';
import {
  newTypedPropertyDraft,
  ownerLocalPropertyFromDraft,
  TypedPropertyFields,
  typedPropertyDraftFromOwnerLocal,
  type TypedPropertyDraft,
} from './TypedPropertyFields';

interface TraitSource {
  traitId: string;
  trait: TraitDefinition;
  property: TraitProperty;
}

export interface OwnerPropertyTraitState {
  traits: string[];
  localProperties: OwnerLocalProperty[];
  properties: PropertyAssignments;
}

function formatValue(value: AuthoredRuntimeValue | undefined) {
  if (value === undefined) return 'Missing';
  if (value === null) return 'null';
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

function traitSources(
  traits: Readonly<Record<string, TraitDefinition>>,
  attachedTraits: readonly string[],
) {
  const byProperty = new Map<string, TraitSource[]>();
  for (const traitId of attachedTraits) {
    const trait = traits[traitId];
    if (!trait) continue;
    for (const property of trait.properties) {
      const sources = byProperty.get(property.id) ?? [];
      sources.push({ traitId, trait, property });
      byProperty.set(property.id, sources);
    }
  }
  return byProperty;
}

function resolvedTraitDefault(sources: readonly TraitSource[]) {
  const defaults = sources.flatMap((source) =>
    source.property.defaultValue === undefined ? [] : [source.property.defaultValue],
  );
  if (defaults.length === 0) return { kind: 'missing' as const };
  if (defaults.every((value) => authoredRuntimeValuesEqual(value, defaults[0]!)))
    return { kind: 'value' as const, value: defaults[0]! };
  return { kind: 'conflict' as const };
}

function ownerLocalFromTrait(
  property: TraitProperty,
  value: AuthoredRuntimeValue,
): OwnerLocalProperty {
  return {
    id: property.id,
    ...(property.label ? { label: property.label } : {}),
    ...(property.description ? { description: property.description } : {}),
    type: property.type,
    nullable: property.nullable,
    value,
    ...(property.enumValues ? { enumValues: [...property.enumValues] } : {}),
  };
}

function parseTraitValue(property: TraitProperty | OwnerDefaultProperty, valueText: string) {
  return parseVariableValueText(property.type, valueText, property.enumValues, property.nullable);
}

function traitUseBackground(
  sources: readonly TraitSource[],
  traitColorFor: ((traitId: string) => string | null) | undefined,
): string | undefined {
  const colors = [...sources]
    .sort((left, right) => left.traitId.localeCompare(right.traitId))
    .flatMap((source) => {
      const color = traitColorFor?.(source.traitId) ?? null;
      return color ? [color] : [];
    });
  if (colors.length === 0) return undefined;
  if (colors.length === 1) return colors[0];
  const segment = 100 / colors.length;
  return `linear-gradient(to right, ${colors
    .flatMap((color, index) => {
      const start = index * segment;
      const end = (index + 1) * segment;
      return [`${color} ${start}%`, `${color} ${end}%`];
    })
    .join(', ')})`;
}

export function OwnerLocalPropertiesEditor({
  ownerLabel,
  properties,
  onChange,
  usageCountFor,
  traits = {},
  ownerKind,
  attachedTraits = [],
  inheritedTraits = [],
  inheritedProperties = [],
  propertyOverrides = {},
  traitColorFor,
  onTraitStateChange,
}: {
  ownerLabel: string;
  properties: readonly OwnerLocalProperty[];
  onChange: (
    properties: OwnerLocalProperty[],
    change?: { kind: 'rename'; fromId: string; toId: string },
  ) => void;
  usageCountFor?: (propertyId: string) => number;
  traits?: Readonly<Record<string, TraitDefinition>>;
  ownerKind?: PropertyOwnerKind;
  attachedTraits?: readonly string[];
  inheritedTraits?: readonly string[];
  inheritedProperties?: readonly InheritedDefaultProperty[];
  propertyOverrides?: Readonly<PropertyAssignments>;
  traitColorFor?: (traitId: string) => string | null;
  onTraitStateChange?: (state: OwnerPropertyTraitState) => void;
}) {
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [draft, setDraft] = useState<TypedPropertyDraft>(() => newTypedPropertyDraft());
  const [message, setMessage] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{
    index: number;
    propertyId: string;
    usages: number;
  } | null>(null);
  const [attachTraitId, setAttachTraitId] = useState('');
  const [editingTraitProperty, setEditingTraitProperty] = useState<{
    propertyId: string;
    valueText: string;
  } | null>(null);

  const sourcesByProperty = useMemo(
    () => traitSources(traits, attachedTraits),
    [attachedTraits, traits],
  );
  const inheritedByProperty = useMemo(
    () => new Map(inheritedProperties.map((entry) => [entry.property.id, entry])),
    [inheritedProperties],
  );
  const effectivePropertyIds = useMemo(
    () => [...new Set([...sourcesByProperty.keys(), ...inheritedByProperty.keys()])],
    [inheritedByProperty, sourcesByProperty],
  );
  const localTraitIds = useMemo(
    () => attachedTraits.filter((id) => !inheritedTraits.includes(id)),
    [attachedTraits, inheritedTraits],
  );
  const availableTraits = useMemo(
    () =>
      Object.entries(traits)
        .filter(
          ([traitId, trait]) =>
            !attachedTraits.includes(traitId) &&
            (!ownerKind || trait.ownerKinds.includes(ownerKind)),
        )
        .sort(([, left], [, right]) => left.label.localeCompare(right.label)),
    [attachedTraits, ownerKind, traits],
  );

  const openNew = () => {
    setEditingIndex(-1);
    setDraft(newTypedPropertyDraft());
    setMessage(null);
  };

  const openEdit = (index: number) => {
    setEditingIndex(index);
    setDraft(typedPropertyDraftFromOwnerLocal(properties[index]!));
    setMessage(null);
  };

  const submit = () => {
    const parsed = ownerLocalPropertyFromDraft(draft);
    if (!parsed.ok) {
      setMessage(parsed.message);
      return;
    }
    if (sourcesByProperty.has(parsed.property.id) || inheritedByProperty.has(parsed.property.id)) {
      setMessage(
        `Property '${parsed.property.id}' has an inherited schema; set its Value from the existing row.`,
      );
      return;
    }
    const duplicateIndex = properties.findIndex(
      (property, index) => property.id === parsed.property.id && index !== editingIndex,
    );
    if (duplicateIndex >= 0) {
      setMessage(`Property '${parsed.property.id}' already exists on this owner.`);
      return;
    }
    if (editingIndex === -1) onChange([...properties, parsed.property]);
    else if (editingIndex !== null) {
      const previous = properties[editingIndex]!;
      onChange(
        properties.map((property, index) => (index === editingIndex ? parsed.property : property)),
        previous.id === parsed.property.id
          ? undefined
          : { kind: 'rename', fromId: previous.id, toId: parsed.property.id },
      );
    }
    setEditingIndex(null);
  };

  const attachTrait = () => {
    if (!attachTraitId || !onTraitStateChange) return;
    const trait = traits[attachTraitId];
    if (!trait) return;
    for (const contract of trait.properties) {
      const existingSources = sourcesByProperty.get(contract.id) ?? [];
      const incompatibleSource = existingSources.find(
        (source) => !arePropertySchemasCompatible(source.property, contract),
      );
      if (incompatibleSource) {
        setMessage(
          `Cannot attach '${trait.label}': Property '${contract.id}' is incompatible with Trait '${incompatibleSource.trait.label}'.`,
        );
        return;
      }
      if (contract.defaultValue !== undefined) {
        const conflictingDefault = existingSources.find(
          (source) =>
            source.property.defaultValue !== undefined &&
            !authoredRuntimeValuesEqual(source.property.defaultValue, contract.defaultValue!),
        );
        if (conflictingDefault) {
          setMessage(
            `Cannot attach '${trait.label}': Property '${contract.id}' has a Default that conflicts with Trait '${conflictingDefault.trait.label}'.`,
          );
          return;
        }
      }
      const inherited = inheritedByProperty.get(contract.id)?.property;
      if (inherited && !arePropertySchemasCompatible(inherited, contract)) {
        setMessage(
          `Cannot attach '${trait.label}': inherited Property '${contract.id}' has an incompatible schema.`,
        );
        return;
      }
      const local = properties.find((property) => property.id === contract.id);
      if (local && !arePropertySchemasCompatible(local, contract)) {
        setMessage(
          `Cannot attach '${trait.label}': local Property '${contract.id}' has an incompatible schema.`,
        );
        return;
      }
    }
    const nextLocal = [...properties];
    const nextOverrides = { ...propertyOverrides };
    for (const contract of trait.properties) {
      const localIndex = nextLocal.findIndex((property) => property.id === contract.id);
      if (localIndex < 0) continue;
      const local = nextLocal[localIndex]!;
      if (!arePropertySchemasCompatible(local, contract)) continue;
      nextOverrides[contract.id] = local.value;
      nextLocal.splice(localIndex, 1);
    }
    onTraitStateChange({
      traits: [...localTraitIds, attachTraitId],
      localProperties: nextLocal,
      properties: nextOverrides,
    });
    setAttachTraitId('');
  };

  const detachTrait = (traitId: string) => {
    if (!onTraitStateChange) return;
    const departing = traits[traitId];
    const remainingTraits = attachedTraits.filter((id) => id !== traitId);
    const remainingSources = traitSources(traits, remainingTraits);
    const nextLocal = [...properties];
    const nextOverrides = { ...propertyOverrides };
    for (const contract of departing?.properties ?? []) {
      if (remainingSources.has(contract.id)) continue;
      if (!Object.prototype.hasOwnProperty.call(nextOverrides, contract.id)) continue;
      if (!nextLocal.some((property) => property.id === contract.id))
        nextLocal.push(ownerLocalFromTrait(contract, nextOverrides[contract.id]!));
      delete nextOverrides[contract.id];
    }
    onTraitStateChange({
      traits: remainingTraits.filter((id) => !inheritedTraits.includes(id)),
      localProperties: nextLocal,
      properties: nextOverrides,
    });
  };

  const saveTraitValue = () => {
    if (!editingTraitProperty || !onTraitStateChange) return;
    const sources = sourcesByProperty.get(editingTraitProperty.propertyId);
    const contract =
      inheritedByProperty.get(editingTraitProperty.propertyId)?.property ?? sources?.[0]?.property;
    if (!contract) return;
    const parsed = parseTraitValue(contract, editingTraitProperty.valueText);
    if (!parsed.ok) {
      setMessage(parsed.message);
      return;
    }
    onTraitStateChange({
      traits: [...localTraitIds],
      localProperties: [...properties],
      properties: { ...propertyOverrides, [contract.id]: parsed.value },
    });
    setEditingTraitProperty(null);
    setMessage(null);
  };

  const resetTraitValue = (propertyId: string) => {
    if (!onTraitStateChange) return;
    const nextOverrides = { ...propertyOverrides };
    delete nextOverrides[propertyId];
    onTraitStateChange({
      traits: [...localTraitIds],
      localProperties: properties.filter(
        (property) =>
          property.id !== propertyId ||
          (!sourcesByProperty.has(propertyId) && !inheritedByProperty.has(propertyId)),
      ),
      properties: nextOverrides,
    });
  };

  return (
    <section className="space-y-4 rounded-md border p-3" data-workbench-anchor="properties.local">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">Properties</h3>
          <p className="text-xs text-muted-foreground">
            Typed state local to {ownerLabel}, including contracts supplied by attached Traits.
          </p>
        </div>
        <Button size="sm" onClick={openNew}>
          <Plus className="size-4" /> Add Property
        </Button>
      </div>

      {ownerKind && onTraitStateChange ? (
        <div className="space-y-2 rounded border bg-muted/20 p-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium">Traits</span>
            {attachedTraits.map((traitId) => (
              <div
                key={traitId}
                className="flex items-center gap-1 rounded border bg-background px-2 py-1"
              >
                <span
                  className="size-2 rounded-full border"
                  style={{ backgroundColor: traitColorFor?.(traitId) ?? undefined }}
                />
                <span className="text-xs">{traits[traitId]?.label ?? traitId}</span>
                {!inheritedTraits.includes(traitId) ? (
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Detach ${traitId}`}
                    onClick={() => detachTrait(traitId)}
                  >
                    <Unlink className="size-3" />
                  </Button>
                ) : (
                  <span className="px-1 text-[10px] text-muted-foreground">inherited</span>
                )}
              </div>
            ))}
            {attachedTraits.length === 0 ? (
              <span className="text-xs text-muted-foreground">No Traits attached.</span>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <Select value={attachTraitId} onValueChange={(value) => setAttachTraitId(value ?? '')}>
              <SelectTrigger className="!h-8 min-w-48" aria-label="Trait to attach">
                <SelectValue placeholder="Choose Trait" />
              </SelectTrigger>
              <SelectContent>
                {availableTraits.map(([traitId, trait]) => (
                  <SelectItem key={traitId} value={traitId}>
                    {trait.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button size="sm" variant="outline" disabled={!attachTraitId} onClick={attachTrait}>
              Attach Trait
            </Button>
          </div>
        </div>
      ) : null}

      <div className="overflow-hidden rounded border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-3 py-2">Property</th>
              <th className="w-px whitespace-nowrap px-3 py-2">Type</th>
              <th className="px-3 py-2">Value</th>
              <th className="w-px whitespace-nowrap px-3 py-2 text-center">Use</th>
              <th className="w-px">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {properties.length === 0 && effectivePropertyIds.length === 0 ? (
              <tr>
                <td colSpan={5} className="p-5 text-center text-xs text-muted-foreground">
                  No local, inherited, or Trait Properties.
                </td>
              </tr>
            ) : null}
            {effectivePropertyIds.map((propertyId) => {
              const sources = sourcesByProperty.get(propertyId) ?? [];
              const inherited = inheritedByProperty.get(propertyId);
              const contract = inherited?.property ?? sources[0]!.property;
              const useBackground = traitUseBackground(sources, traitColorFor);
              const hasOverride = Object.prototype.hasOwnProperty.call(
                propertyOverrides,
                propertyId,
              );
              const traitFallback = resolvedTraitDefault(sources);
              const inheritedDefault = inherited?.property.defaultValue;
              const fallback =
                inheritedDefault !== undefined
                  ? { kind: 'value' as const, value: inheritedDefault }
                  : traitFallback;
              const local = properties.find((property) => property.id === propertyId);
              const value = hasOverride
                ? propertyOverrides[propertyId]
                : local
                  ? local.value
                  : fallback.kind === 'value'
                    ? fallback.value
                    : undefined;
              return (
                <tr key={`inherited:${propertyId}`} className="border-t bg-muted/10">
                  <td className="px-3 py-2">
                    <div className="font-medium">{contract.label ?? propertyId}</div>
                    {contract.label ? (
                      <div className="font-mono text-[11px] text-muted-foreground">
                        {propertyId}
                      </div>
                    ) : null}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-xs text-muted-foreground">
                    {contract.type}
                    {contract.nullable ? '?' : ''}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">
                    {fallback.kind === 'conflict' && !hasOverride
                      ? 'Conflicting Defaults'
                      : formatValue(value)}
                    {hasOverride || local ? (
                      <span className="ml-2 font-sans text-muted-foreground">override</span>
                    ) : inherited ? (
                      <span className="ml-2 font-sans text-muted-foreground">
                        {inherited.sourceLabel}
                      </span>
                    ) : null}
                  </td>
                  <td
                    className="px-3 py-2 text-center text-xs"
                    style={{ background: useBackground }}
                    title={
                      sources.length
                        ? `Trait sources: ${sources.map((source) => source.trait.label).join(', ')}`
                        : inherited?.sourceLabel
                    }
                    aria-label={`Use count ${usageCountFor?.(propertyId) ?? 0}${sources.length ? `; Trait sources: ${sources.map((source) => source.trait.label).join(', ')}` : ''}`}
                  >
                    <span className="rounded bg-background/85 px-1.5 py-0.5 text-foreground shadow-sm">
                      {usageCountFor?.(propertyId) ?? 0}
                    </span>
                  </td>
                  <td className="px-1 py-1">
                    <div className="flex">
                      {hasOverride || local ? (
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label={`Reset ${propertyId}`}
                          onClick={() => resetTraitValue(propertyId)}
                        >
                          <RotateCcw className="size-4" />
                        </Button>
                      ) : null}
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          setEditingTraitProperty({
                            propertyId,
                            valueText: variableValueToText(value ?? null),
                          })
                        }
                      >
                        Set Value
                      </Button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {properties
              .filter(
                (property) =>
                  !sourcesByProperty.has(property.id) && !inheritedByProperty.has(property.id),
              )
              .map((property) => {
                const index = properties.indexOf(property);
                return (
                  <tr
                    key={`${property.id}:${index}`}
                    className="cursor-pointer border-t hover:bg-muted/30"
                    onClick={() => openEdit(index)}
                  >
                    <td className="px-3 py-2">
                      <div className="font-medium">{property.label ?? property.id}</div>
                      {property.label ? (
                        <div className="font-mono text-[11px] text-muted-foreground">
                          {property.id}
                        </div>
                      ) : null}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-xs text-muted-foreground">
                      {property.type}
                      {property.nullable ? '?' : ''}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">{formatValue(property.value)}</td>
                    <td className="px-3 py-2 text-center text-xs text-muted-foreground">
                      {usageCountFor?.(property.id) ?? 0}
                    </td>
                    <td className="px-1 py-1">
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        className="text-destructive"
                        aria-label={`Delete ${property.id}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          setDeleteTarget({
                            index,
                            propertyId: property.id,
                            usages: usageCountFor?.(property.id) ?? 0,
                          });
                        }}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </div>

      <Dialog open={editingIndex !== null} onOpenChange={(open) => !open && setEditingIndex(null)}>
        <DialogPopup className="w-[min(620px,calc(100vw-2rem))]">
          <DialogTitle>{editingIndex === -1 ? 'Add Property' : 'Edit Property'}</DialogTitle>
          <DialogDescription>
            This declaration and concrete Value belong only to {ownerLabel}.
          </DialogDescription>
          <TypedPropertyFields draft={draft} onChange={setDraft} valueLabel="Value" />
          {message ? (
            <div className="rounded border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
              {message}
            </div>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setEditingIndex(null)}>
              Cancel
            </Button>
            <Button onClick={submit}>
              {editingIndex === -1 ? 'Add Property' : 'Save changes'}
            </Button>
          </div>
        </DialogPopup>
      </Dialog>

      <Dialog
        open={editingTraitProperty !== null}
        onOpenChange={(open) => !open && setEditingTraitProperty(null)}
      >
        <DialogPopup className="w-[min(480px,calc(100vw-2rem))]">
          <DialogTitle>Set Trait Property Value</DialogTitle>
          <DialogDescription>
            The Trait owns this Property schema. This owner may only provide a more-specific Value.
          </DialogDescription>
          {editingTraitProperty
            ? (() => {
                const contract = sourcesByProperty.get(editingTraitProperty.propertyId)?.[0]
                  ?.property;
                if (!contract) return null;
                const nullSelected = contract.nullable && editingTraitProperty.valueText === 'null';
                return (
                  <div className="space-y-3">
                    <div className="rounded border bg-muted/20 p-2 text-xs">
                      <span className="font-mono">{contract.id}</span> · {contract.type}
                      {contract.nullable ? '?' : ''}
                    </div>
                    <div className="space-y-1.5">
                      <Label>Value</Label>
                      {contract.nullable ? (
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <Switch
                            checked={nullSelected}
                            onCheckedChange={(checked) =>
                              setEditingTraitProperty({
                                ...editingTraitProperty,
                                valueText: checked
                                  ? 'null'
                                  : contract.type === 'boolean'
                                    ? 'false'
                                    : contract.type === 'enum'
                                      ? (contract.enumValues?.[0] ?? '')
                                      : contract.type === 'string'
                                        ? ''
                                        : '0',
                              })
                            }
                          />
                          Null
                        </div>
                      ) : null}
                      {!nullSelected ? (
                        contract.type === 'boolean' ? (
                          <Switch
                            checked={editingTraitProperty.valueText === 'true'}
                            onCheckedChange={(checked) =>
                              setEditingTraitProperty({
                                ...editingTraitProperty,
                                valueText: String(checked),
                              })
                            }
                          />
                        ) : contract.type === 'enum' ? (
                          <Select
                            value={editingTraitProperty.valueText}
                            onValueChange={(value) =>
                              value &&
                              setEditingTraitProperty({ ...editingTraitProperty, valueText: value })
                            }
                          >
                            <SelectTrigger className="!h-8">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {(contract.enumValues ?? []).map((value) => (
                                <SelectItem key={value} value={value}>
                                  {value}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : (
                          <Input
                            type={
                              contract.type === 'integer' || contract.type === 'number'
                                ? 'number'
                                : 'text'
                            }
                            step={
                              contract.type === 'integer'
                                ? 1
                                : contract.type === 'number'
                                  ? 'any'
                                  : undefined
                            }
                            value={editingTraitProperty.valueText}
                            onChange={(event) =>
                              setEditingTraitProperty({
                                ...editingTraitProperty,
                                valueText: event.currentTarget.value,
                              })
                            }
                          />
                        )
                      ) : null}
                    </div>
                  </div>
                );
              })()
            : null}
          {message ? <div className="text-xs text-destructive">{message}</div> : null}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setEditingTraitProperty(null)}>
              Cancel
            </Button>
            <Button onClick={saveTraitValue}>Save Value</Button>
          </div>
        </DialogPopup>
      </Dialog>

      <Dialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogPopup className="w-[min(480px,calc(100vw-2rem))]">
          <DialogTitle>Delete Property?</DialogTitle>
          <DialogDescription>
            {deleteTarget?.usages
              ? `Property '${deleteTarget.propertyId}' has ${deleteTarget.usages} known usage${deleteTarget.usages === 1 ? '' : 's'}. Deleting it will leave those references for validation to report.`
              : `Property '${deleteTarget?.propertyId ?? ''}' has no known usages.`}
          </DialogDescription>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (!deleteTarget) return;
                onChange(properties.filter((_, index) => index !== deleteTarget.index));
                setDeleteTarget(null);
              }}
            >
              Delete Property
            </Button>
          </div>
        </DialogPopup>
      </Dialog>
    </section>
  );
}
