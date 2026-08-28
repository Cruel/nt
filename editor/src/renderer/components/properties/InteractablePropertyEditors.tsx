import { useMemo, useState } from 'react';
import { Plus, RotateCcw, Trash2, Unlink } from 'lucide-react';
import { PropertyManager } from './PropertyManager';
import { resolveArchetypeConfiguration } from '../../../shared/project-schema/authoring-archetypes';
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
  ownerLocalPropertyFromDraft,
  TypedPropertyFields,
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
  const record = project.interactables[definitionId];
  const inheritedConfiguration = useMemo(() => {
    if (!record?.archetype) return null;
    return resolveArchetypeConfiguration(project, record.archetype.$ref.id);
  }, [project, record?.archetype]);
  const inheritedProperties = useMemo(() => {
    if (!record?.archetype) return [];
    return (inheritedConfiguration?.defaultProperties ?? []).map((property) => ({
      property,
      sourceLabel: project.archetypes[record.archetype!.$ref.id]?.label ?? 'Archetype',
    }));
  }, [inheritedConfiguration, project.archetypes, record?.archetype]);
  return (
    <PropertyManager
      mode="default"
      ownerLabel={`Interactable definition '${record?.label ?? definitionId}'`}
      ownerKind="interactable"
      traits={project.traits}
      attachedTraits={attachedTraits}
      properties={properties}
      inheritedProperties={inheritedProperties}
      inheritedTraits={inheritedConfiguration?.traits ?? []}
      onChange={onChange}
    />
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
    const nextTraits = [...effectiveTraits, traitId];
    const add = nextTraits.filter((id) => !definitionTraits.has(id));
    const remove = [...definitionTraits].filter((id) => !nextTraits.includes(id));
    onChange({
      ...instance,
      traits: { add, remove },
      localProperties: [...instance.localProperties],
    });
    setTraitId('');
    setMessage(null);
  };
  const detachTrait = (id: string) => {
    const remainingTraits = effectiveTraits.filter((candidate) => candidate !== id);
    const remainingInstance: InteractableInstanceData = {
      ...instance,
      traits: {
        add: remainingTraits.filter((candidate) => !definitionTraits.has(candidate)),
        remove: [...definitionTraits].filter((candidate) => !remainingTraits.includes(candidate)),
      },
    };
    onChange({ ...remainingInstance, localProperties: [...instance.localProperties] });
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
    const contract = editingValue.contract;
    const replacement: OwnerLocalProperty = {
      id: contract.id,
      ...(contract.label ? { label: contract.label } : {}),
      ...(contract.description ? { description: contract.description } : {}),
      type: contract.type,
      nullable: contract.nullable,
      value: parsed.value,
      ...(contract.enumValues ? { enumValues: [...contract.enumValues] } : {}),
    };
    const existing = instance.localProperties.findIndex((item) => item.id === editingValue.id);
    onChange({
      ...instance,
      localProperties:
        existing < 0
          ? [...instance.localProperties, replacement]
          : instance.localProperties.map((item, index) =>
              index === existing ? replacement : item,
            ),
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
              const hasLocalOverride = !row.localOnly && row.localProperty !== undefined;
              const hasOverride = hasLocalOverride;
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
                              onClick={() =>
                                onChange({
                                  ...instance,
                                  localProperties: instance.localProperties.filter(
                                    (item) => item.id !== row.id,
                                  ),
                                })
                              }
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
