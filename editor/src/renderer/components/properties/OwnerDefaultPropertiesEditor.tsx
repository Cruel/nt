import { useMemo, useState } from 'react';
import { Plus, RotateCcw, Trash2, Unlink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogDescription, DialogPopup, DialogTitle } from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  arePropertySchemasCompatible,
  authoredRuntimeValuesEqual,
  type AuthoredRuntimeValue,
  type OwnerDefaultProperty,
  type PropertyOwnerKind,
  type TraitDefinition,
  type TraitProperty,
} from '../../../shared/project-schema/authoring-properties';
import {
  newTypedPropertyDraft,
  ownerDefaultPropertyFromDraft,
  TypedPropertyFields,
  typedPropertyDraftFromOwnerDefault,
  type TypedPropertyDraft,
} from './TypedPropertyFields';

export interface InheritedDefaultProperty {
  property: OwnerDefaultProperty;
  sourceLabel: string;
}

interface EffectiveRow {
  id: string;
  contract: OwnerDefaultProperty | TraitProperty;
  defaultValue?: AuthoredRuntimeValue;
  source: 'local' | 'inherited' | 'trait';
  sourceLabel: string;
  traitIds: string[];
  inheritedSchema: boolean;
}

function formatValue(value: AuthoredRuntimeValue | undefined) {
  if (value === undefined) return 'Missing';
  if (value === null) return 'null';
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

function cloneDefault(contract: OwnerDefaultProperty | TraitProperty): OwnerDefaultProperty {
  return {
    id: contract.id,
    ...(contract.label ? { label: contract.label } : {}),
    ...(contract.description ? { description: contract.description } : {}),
    type: contract.type,
    nullable: contract.nullable,
    ...(contract.defaultValue === undefined ? {} : { defaultValue: contract.defaultValue }),
    ...(contract.enumValues ? { enumValues: [...contract.enumValues] } : {}),
  };
}

function buildRows(
  traits: Readonly<Record<string, TraitDefinition>>,
  ownerKind: PropertyOwnerKind,
  attachedTraits: readonly string[],
  inheritedProperties: readonly InheritedDefaultProperty[],
  localProperties: readonly OwnerDefaultProperty[],
): EffectiveRow[] {
  const rows = new Map<string, EffectiveRow>();
  for (const traitId of attachedTraits) {
    const trait = traits[traitId];
    if (!trait || !trait.ownerKinds.includes(ownerKind)) continue;
    for (const property of trait.properties) {
      const existing = rows.get(property.id);
      if (!existing) {
        rows.set(property.id, {
          id: property.id,
          contract: structuredClone(property),
          ...(property.defaultValue === undefined ? {} : { defaultValue: property.defaultValue }),
          source: 'trait',
          sourceLabel: trait.label,
          traitIds: [traitId],
          inheritedSchema: true,
        });
        continue;
      }
      if (!arePropertySchemasCompatible(existing.contract, property)) continue;
      existing.traitIds.push(traitId);
      existing.sourceLabel = existing.traitIds.map((id) => traits[id]?.label ?? id).join(', ');
      if (existing.defaultValue === undefined && property.defaultValue !== undefined)
        existing.defaultValue = property.defaultValue;
      else if (
        existing.defaultValue !== undefined &&
        property.defaultValue !== undefined &&
        !authoredRuntimeValuesEqual(existing.defaultValue, property.defaultValue)
      )
        delete existing.defaultValue;
    }
  }
  for (const inherited of inheritedProperties) {
    const existing = rows.get(inherited.property.id);
    rows.set(inherited.property.id, {
      id: inherited.property.id,
      contract: structuredClone(inherited.property),
      ...(inherited.property.defaultValue === undefined
        ? existing?.defaultValue === undefined
          ? {}
          : { defaultValue: existing.defaultValue }
        : { defaultValue: inherited.property.defaultValue }),
      source: 'inherited',
      sourceLabel: inherited.sourceLabel,
      traitIds: existing?.traitIds ?? [],
      inheritedSchema: true,
    });
  }
  for (const property of localProperties) {
    const existing = rows.get(property.id);
    rows.set(property.id, {
      id: property.id,
      contract: structuredClone(property),
      ...(property.defaultValue === undefined
        ? existing?.defaultValue === undefined
          ? {}
          : { defaultValue: existing.defaultValue }
        : { defaultValue: property.defaultValue }),
      source: 'local',
      sourceLabel: 'local',
      traitIds: existing?.traitIds ?? [],
      inheritedSchema: existing?.inheritedSchema ?? false,
    });
  }
  return [...rows.values()];
}

function traitBackground(
  traitIds: readonly string[],
  traitColorFor: ((traitId: string) => string | null) | undefined,
) {
  const colors = [...traitIds]
    .sort()
    .flatMap((traitId) => (traitColorFor?.(traitId) ? [traitColorFor!(traitId)!] : []));
  if (colors.length === 0) return undefined;
  if (colors.length === 1) return colors[0];
  const segment = 100 / colors.length;
  return `linear-gradient(to right, ${colors
    .flatMap((color, index) => [
      `${color} ${index * segment}%`,
      `${color} ${(index + 1) * segment}%`,
    ])
    .join(', ')})`;
}

export function OwnerDefaultPropertiesEditor({
  ownerLabel,
  ownerKind,
  properties,
  inheritedProperties = [],
  inheritedTraits = [],
  attachedTraits,
  traits,
  onChange,
  usageCountFor,
  traitColorFor,
}: {
  ownerLabel: string;
  ownerKind: PropertyOwnerKind;
  properties: readonly OwnerDefaultProperty[];
  inheritedProperties?: readonly InheritedDefaultProperty[];
  inheritedTraits?: readonly string[];
  attachedTraits: readonly string[];
  traits: Readonly<Record<string, TraitDefinition>>;
  onChange: (state: { properties: OwnerDefaultProperty[]; traits: string[] }) => void;
  usageCountFor?: (propertyId: string) => number;
  traitColorFor?: (traitId: string) => string | null;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingInherited, setEditingInherited] = useState(false);
  const [draft, setDraft] = useState<TypedPropertyDraft>(() => newTypedPropertyDraft());
  const [message, setMessage] = useState<string | null>(null);
  const [traitId, setTraitId] = useState('');
  const rows = useMemo(
    () => buildRows(traits, ownerKind, attachedTraits, inheritedProperties, properties),
    [attachedTraits, inheritedProperties, ownerKind, properties, traits],
  );
  const localById = useMemo(() => new Map(properties.map((item) => [item.id, item])), [properties]);
  const localTraitIds = useMemo(
    () => attachedTraits.filter((id) => !inheritedTraits.includes(id)),
    [attachedTraits, inheritedTraits],
  );
  const effectiveTraits = (localIds: readonly string[]) => [
    ...inheritedTraits,
    ...localIds.filter((id) => !inheritedTraits.includes(id)),
  ];
  const availableTraits = useMemo(
    () =>
      Object.entries(traits)
        .filter(
          ([id, trait]) => !attachedTraits.includes(id) && trait.ownerKinds.includes(ownerKind),
        )
        .sort(([, left], [, right]) => left.label.localeCompare(right.label)),
    [attachedTraits, ownerKind, traits],
  );

  const openNew = () => {
    setEditingId('');
    setEditingInherited(false);
    setDraft(newTypedPropertyDraft());
    setMessage(null);
  };
  const openRow = (row: EffectiveRow) => {
    const local = localById.get(row.id);
    const property = local ?? {
      ...cloneDefault(row.contract),
      ...(row.defaultValue === undefined ? {} : { defaultValue: row.defaultValue }),
    };
    setEditingId(row.id);
    setEditingInherited(row.inheritedSchema);
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
    const effective = rows.find((row) => row.id === oldId);
    if (editingInherited && effective) {
      if (
        parsed.property.id !== effective.id ||
        !arePropertySchemasCompatible(parsed.property, effective.contract)
      ) {
        setMessage(
          'Inherited Property schemas are read-only; only the Default may be specialized here.',
        );
        return;
      }
      parsed.property = {
        ...cloneDefault(effective.contract),
        ...(parsed.property.defaultValue === undefined
          ? {}
          : { defaultValue: parsed.property.defaultValue }),
      };
    }
    if (oldId === '' && rows.some((row) => row.id === parsed.property.id)) {
      setMessage(
        `Property '${parsed.property.id}' is already effective. Edit the existing row instead.`,
      );
      return;
    }
    if (properties.some((item) => item.id === parsed.property.id && item.id !== oldId)) {
      setMessage(`Property '${parsed.property.id}' already exists on this owner.`);
      return;
    }
    const local = oldId === '' ? undefined : localById.get(oldId);
    const next =
      oldId === ''
        ? [...properties, parsed.property]
        : local
          ? properties.map((item) => (item.id === oldId ? parsed.property : item))
          : [...properties, parsed.property];
    onChange({ properties: next, traits: effectiveTraits(localTraitIds) });
    setEditingId(null);
    setEditingInherited(false);
  };
  const attachTrait = () => {
    if (!traitId) return;
    const trait = traits[traitId];
    if (!trait) return;
    for (const member of trait.properties) {
      const row = rows.find((candidate) => candidate.id === member.id);
      if (row && !arePropertySchemasCompatible(row.contract, member)) {
        setMessage(
          `Cannot attach '${trait.label}': Property '${member.id}' has an incompatible effective schema.`,
        );
        return;
      }
      if (
        member.defaultValue !== undefined &&
        row?.source === 'trait' &&
        row.defaultValue !== undefined &&
        !authoredRuntimeValuesEqual(member.defaultValue, row.defaultValue)
      ) {
        setMessage(
          `Cannot attach '${trait.label}': Property '${member.id}' has a conflicting Trait Default.`,
        );
        return;
      }
    }
    onChange({
      properties: [...properties],
      traits: effectiveTraits([...localTraitIds, traitId]),
    });
    setTraitId('');
    setMessage(null);
  };

  return (
    <section className="space-y-3 rounded-md border p-3" data-property-manager-mode="default">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">Properties</h3>
          <p className="text-xs text-muted-foreground">
            Typed Property schemas and optional Defaults for {ownerLabel}.
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
              <span
                className="size-2 rounded-full border"
                style={{ backgroundColor: traitColorFor?.(id) ?? undefined }}
              />
              <span className="text-xs">{traits[id]?.label ?? id}</span>
              {!inheritedTraits.includes(id) ? (
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Detach ${id}`}
                  onClick={() =>
                    onChange({
                      properties: [...properties],
                      traits: effectiveTraits(
                        localTraitIds.filter((candidate) => candidate !== id),
                      ),
                    })
                  }
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
              <th className="w-px whitespace-nowrap px-3 py-2 text-center">Use</th>
              <th className="w-px">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={5} className="p-5 text-center text-xs text-muted-foreground">
                  No Property contracts.
                </td>
              </tr>
            ) : null}
            {rows.map((row) => {
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
                    <span className="ml-2 font-sans text-muted-foreground">{row.sourceLabel}</span>
                  </td>
                  <td
                    className="px-3 py-2 text-center text-xs"
                    style={{ background: traitBackground(row.traitIds, traitColorFor) }}
                    title={
                      row.traitIds.length
                        ? `Trait sources: ${row.traitIds.map((id) => traits[id]?.label ?? id).join(', ')}`
                        : undefined
                    }
                  >
                    <span className="rounded bg-background/85 px-1.5 py-0.5 text-foreground shadow-sm">
                      {usageCountFor?.(row.id) ?? 0}
                    </span>
                  </td>
                  <td className="px-1 py-1">
                    <div className="flex justify-end">
                      {local && row.inheritedSchema ? (
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label={`Reset ${row.id}`}
                          onClick={() =>
                            onChange({
                              properties: properties.filter((item) => item.id !== row.id),
                              traits: effectiveTraits(localTraitIds),
                            })
                          }
                        >
                          <RotateCcw className="size-4" />
                        </Button>
                      ) : null}
                      <Button size="sm" variant="ghost" onClick={() => openRow(row)}>
                        {local ? 'Edit' : 'Set Default'}
                      </Button>
                      {local && !row.inheritedSchema ? (
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          className="text-destructive"
                          aria-label={`Delete ${row.id}`}
                          onClick={() =>
                            onChange({
                              properties: properties.filter((item) => item.id !== row.id),
                              traits: effectiveTraits(localTraitIds),
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
          <DialogTitle>
            {editingId === ''
              ? 'Add Property'
              : editingInherited
                ? 'Set Property Default'
                : 'Edit Property'}
          </DialogTitle>
          <DialogDescription>
            {editingInherited
              ? 'The inherited Property schema is read-only. This owner may provide a more-specific Default.'
              : 'Reusable Property contracts may omit their Default until a more-specific consumer supplies one.'}
          </DialogDescription>
          <TypedPropertyFields
            draft={draft}
            onChange={setDraft}
            valueLabel="Default"
            valueOptional
            schemaReadOnly={editingInherited}
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
