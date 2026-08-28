import { useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogDescription, DialogPopup, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { PropertyManager, type PropertyManagerRow } from '@/components/properties/PropertyManager';
import {
  newTypedPropertyDraft,
  ownerDefaultPropertyFromDraft,
  type TypedPropertyDraft,
} from '@/components/properties/TypedPropertyFields';
import { useCommandStore } from '@/commands/command-store';
import { useProjectStore } from '@/project/project-store';
import { SAVE_UNIT_IDS } from '@/project/save-unit-registry';
import type { WorkbenchEditorProps } from '@/workbench/editor-registry';
import {
  isAuthoringProject,
  type AuthoringProject,
} from '../../../shared/project-schema/authoring-project';
import { parseInteractionData } from '../../../shared/project-schema/authoring-interactions';
import {
  propertyOwnerKindValues,
  type OwnerLocalProperty,
  type PropertyOwnerKind,
  type TraitDefinition,
  type TraitProperty,
} from '../../../shared/project-schema/authoring-properties';
import {
  parseVerbData,
  type SubjectSelector,
} from '../../../shared/project-schema/authoring-verbs';

const TRAIT_COLORS = [
  '#64748b',
  '#2563eb',
  '#7c3aed',
  '#db2777',
  '#dc2626',
  '#ea580c',
  '#ca8a04',
  '#16a34a',
  '#0891b2',
] as const;

interface TraitMetadataDraft {
  id: string;
  label: string;
  description: string;
  ownerKinds: PropertyOwnerKind[];
  color: string;
}

interface JsonPatch {
  op: 'add' | 'replace' | 'remove';
  path: string;
  value?: unknown;
}

function escapeSegment(value: string) {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

function colorForIndex(index: number) {
  return TRAIT_COLORS[index % TRAIT_COLORS.length]!;
}

function draftForTrait(
  project: AuthoringProject,
  id: string,
  trait: TraitDefinition,
): TraitMetadataDraft {
  return {
    id,
    label: trait.label,
    description: trait.description ?? '',
    ownerKinds: [...trait.ownerKinds],
    color: project.editor.recordMetadata.traits?.[id]?.color ?? colorForIndex(0),
  };
}

function newTraitDraft(project: AuthoringProject): TraitMetadataDraft {
  return {
    id: '',
    label: '',
    description: '',
    ownerKinds: ['room'],
    color: colorForIndex(Object.keys(project.traits).length),
  };
}

function traitFromMetadataDraft(draft: TraitMetadataDraft, properties: readonly TraitProperty[]) {
  const id = draft.id.trim();
  if (!id) return { ok: false as const, message: 'Trait ID is required.' };
  if (!draft.label.trim()) return { ok: false as const, message: 'Trait label is required.' };
  if (draft.ownerKinds.length === 0)
    return { ok: false as const, message: 'Traits must apply to at least one owner kind.' };
  return {
    ok: true as const,
    id,
    trait: {
      id,
      label: draft.label.trim(),
      ...(draft.description.trim() ? { description: draft.description.trim() } : {}),
      ownerKinds: [...draft.ownerKinds],
      properties: [...properties],
    } satisfies TraitDefinition,
  };
}

function traitPropertyFromDraft(
  draft: TypedPropertyDraft,
): { ok: true; property: TraitProperty } | { ok: false; message: string } {
  const parsed = ownerDefaultPropertyFromDraft(draft);
  if (!parsed.ok) return parsed;
  return { ok: true, property: parsed.property };
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function traitSelectorId(selector: SubjectSelector): string | null {
  return selector.kind === 'trait' ? selector.trait.$ref.id : null;
}

function traitUsagePaths(project: AuthoringProject, traitId: string): string[] {
  const paths: string[] = [];
  for (const collection of ['rooms', 'characters', 'interactables'] as const) {
    for (const [id, record] of Object.entries(project[collection])) {
      if ((record.traits ?? []).includes(traitId)) paths.push(`/${collection}/${id}/traits`);
      const data = objectRecord(record.data);
      const features = Array.isArray(data?.features) ? data.features : [];
      for (const [index, feature] of features.entries()) {
        const featureRecord = objectRecord(feature);
        if (Array.isArray(featureRecord?.traits) && featureRecord.traits.includes(traitId))
          paths.push(`/${collection}/${id}/data/features/${index}/traits`);
      }
    }
  }
  for (const [id, instance] of Object.entries(project.interactableInstances)) {
    if (instance.traits.add.includes(traitId))
      paths.push(`/interactableInstances/${id}/traits/add`);
    if (instance.traits.remove.includes(traitId))
      paths.push(`/interactableInstances/${id}/traits/remove`);
  }
  for (const [id, archetype] of Object.entries(project.archetypes)) {
    const data = objectRecord(archetype.data);
    const overrides = objectRecord(data?.overrides);
    for (const [pointer, value] of Object.entries(overrides ?? {})) {
      if (
        (pointer === '/traits' && Array.isArray(value) && value.includes(traitId)) ||
        (pointer.startsWith('/traits/') && value === traitId)
      )
        paths.push(`/archetypes/${id}/data/overrides/${escapeSegment(pointer)}`);
    }
  }
  for (const [id, verb] of Object.entries(project.verbs)) {
    const data = parseVerbData(verb.data);
    if (!data) continue;
    data.slots.forEach((slot, slotIndex) =>
      slot.selectors.forEach((selector, selectorIndex) => {
        if (traitSelectorId(selector) === traitId)
          paths.push(`/verbs/${id}/data/slots/${slotIndex}/selectors/${selectorIndex}`);
      }),
    );
    data.offers.forEach((offer, offerIndex) =>
      offer.selectors.forEach((selector, selectorIndex) => {
        if (traitSelectorId(selector) === traitId)
          paths.push(`/verbs/${id}/data/offers/${offerIndex}/selectors/${selectorIndex}`);
      }),
    );
  }
  for (const [id, interaction] of Object.entries(project.interactions)) {
    const data = parseInteractionData(interaction.data);
    if (!data) continue;
    data.rules.forEach((rule, ruleIndex) =>
      rule.slots.forEach((slot, slotIndex) =>
        slot.selectors.forEach((selector, selectorIndex) => {
          if (traitSelectorId(selector) === traitId)
            paths.push(
              `/interactions/${id}/data/rules/${ruleIndex}/slots/${slotIndex}/selectors/${selectorIndex}`,
            );
        }),
      ),
    );
  }
  return paths;
}

function ownerLocalFromTrait(property: TraitProperty, value: unknown): OwnerLocalProperty | null {
  if (
    !(
      value === null ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    )
  )
    return null;
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

function preservationPatchesForRemovedTraitProperties(
  project: AuthoringProject,
  traitId: string,
  removed: readonly TraitProperty[],
): JsonPatch[] {
  const patches: JsonPatch[] = [];
  if (removed.length === 0) return patches;
  for (const collection of ['rooms', 'characters'] as const) {
    for (const [ownerId, record] of Object.entries(project[collection])) {
      if (!(record.traits ?? []).includes(traitId)) continue;
      const nextLocal = [...(record.localProperties ?? [])];
      let changed = false;
      for (const property of removed) {
        const stillSupplied = (record.traits ?? []).some(
          (otherTraitId: string) =>
            otherTraitId !== traitId &&
            project.traits[otherTraitId]?.properties.some(
              (candidate) => candidate.id === property.id,
            ),
        );
        if (stillSupplied || nextLocal.some((candidate) => candidate.id === property.id)) continue;
        if (property.defaultValue === undefined) continue;
        const local = ownerLocalFromTrait(property, property.defaultValue);
        if (!local) continue;
        nextLocal.push(local);
        changed = true;
      }
      if (!changed) continue;
      patches.push({
        op: Object.prototype.hasOwnProperty.call(record, 'localProperties') ? 'replace' : 'add',
        path: `/${collection}/${escapeSegment(ownerId)}/localProperties`,
        value: nextLocal,
      });
    }
  }
  return patches;
}

function attachmentRewritePatches(
  project: AuthoringProject,
  fromId: string,
  toId: string | null,
): JsonPatch[] {
  const patches: JsonPatch[] = [];
  const rewrite = (values: readonly string[]) =>
    values.flatMap((value) => (value === fromId ? (toId ? [toId] : []) : [value]));
  for (const collection of ['rooms', 'characters', 'interactables'] as const) {
    for (const [id, record] of Object.entries(project[collection])) {
      if ((record.traits ?? []).includes(fromId))
        patches.push({
          op: 'replace',
          path: `/${collection}/${escapeSegment(id)}/traits`,
          value: rewrite(record.traits ?? []),
        });
      const data = objectRecord(record.data);
      const features = Array.isArray(data?.features) ? data.features : [];
      for (const [index, feature] of features.entries()) {
        const featureRecord = objectRecord(feature);
        if (!Array.isArray(featureRecord?.traits) || !featureRecord.traits.includes(fromId))
          continue;
        patches.push({
          op: 'replace',
          path: `/${collection}/${escapeSegment(id)}/data/features/${index}/traits`,
          value: rewrite(featureRecord.traits as string[]),
        });
      }
    }
  }
  for (const [id, instance] of Object.entries(project.interactableInstances)) {
    for (const delta of ['add', 'remove'] as const) {
      if (!instance.traits[delta].includes(fromId)) continue;
      patches.push({
        op: 'replace',
        path: `/interactableInstances/${escapeSegment(id)}/traits/${delta}`,
        value: rewrite(instance.traits[delta]),
      });
    }
  }
  for (const [id, archetype] of Object.entries(project.archetypes)) {
    const data = objectRecord(archetype.data);
    const overrides = objectRecord(data?.overrides);
    for (const [pointer, value] of Object.entries(overrides ?? {})) {
      const path = `/archetypes/${escapeSegment(id)}/data/overrides/${escapeSegment(pointer)}`;
      if (pointer === '/traits' && Array.isArray(value) && value.includes(fromId))
        patches.push({ op: 'replace', path, value: rewrite(value as string[]) });
      else if (pointer.startsWith('/traits/') && value === fromId) {
        if (toId) patches.push({ op: 'replace', path, value: toId });
        else patches.push({ op: 'remove', path });
      }
    }
  }
  return patches;
}

function selectorRenamePatches(
  project: AuthoringProject,
  fromId: string,
  toId: string,
): JsonPatch[] {
  const patches: JsonPatch[] = [];
  const replacement = { kind: 'trait', trait: { $ref: { collection: 'traits', id: toId } } };
  for (const [id, verb] of Object.entries(project.verbs)) {
    const data = parseVerbData(verb.data);
    if (!data) continue;
    data.slots.forEach((slot, slotIndex) =>
      slot.selectors.forEach((selector, selectorIndex) => {
        if (traitSelectorId(selector) !== fromId) return;
        patches.push({
          op: 'replace',
          path: `/verbs/${escapeSegment(id)}/data/slots/${slotIndex}/selectors/${selectorIndex}`,
          value: replacement,
        });
      }),
    );
    data.offers.forEach((offer, offerIndex) =>
      offer.selectors.forEach((selector, selectorIndex) => {
        if (traitSelectorId(selector) !== fromId) return;
        patches.push({
          op: 'replace',
          path: `/verbs/${escapeSegment(id)}/data/offers/${offerIndex}/selectors/${selectorIndex}`,
          value: replacement,
        });
      }),
    );
  }
  for (const [id, interaction] of Object.entries(project.interactions)) {
    const data = parseInteractionData(interaction.data);
    if (!data) continue;
    data.rules.forEach((rule, ruleIndex) =>
      rule.slots.forEach((slot, slotIndex) =>
        slot.selectors.forEach((selector, selectorIndex) => {
          if (traitSelectorId(selector) !== fromId) return;
          patches.push({
            op: 'replace',
            path: `/interactions/${escapeSegment(id)}/data/rules/${ruleIndex}/slots/${slotIndex}/selectors/${selectorIndex}`,
            value: replacement,
          });
        }),
      ),
    );
  }
  return patches;
}

function ownerKindLabel(kind: PropertyOwnerKind) {
  return kind[0]!.toUpperCase() + kind.slice(1);
}

function TraitMetadataFields({
  value,
  onChange,
}: {
  value: TraitMetadataDraft;
  onChange: (next: TraitMetadataDraft) => void;
}) {
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label>Stable ID</Label>
          <Input
            className="font-mono"
            value={value.id}
            onChange={(event) => onChange({ ...value, id: event.currentTarget.value })}
            placeholder="inspectable"
          />
        </div>
        <div className="space-y-1.5">
          <Label>Label</Label>
          <Input
            value={value.label}
            onChange={(event) => onChange({ ...value, label: event.currentTarget.value })}
            placeholder="Inspectable"
          />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label>
          Description <span className="font-normal text-muted-foreground">(optional)</span>
        </Label>
        <Input
          value={value.description}
          onChange={(event) => onChange({ ...value, description: event.currentTarget.value })}
        />
      </div>
      <div className="space-y-1.5">
        <Label>Applies To</Label>
        <div className="flex flex-wrap gap-3 rounded border p-2">
          {propertyOwnerKindValues.map((kind) => (
            <label key={kind} className="flex items-center gap-2 text-xs">
              <Switch
                checked={value.ownerKinds.includes(kind)}
                onCheckedChange={(checked) =>
                  onChange({
                    ...value,
                    ownerKinds: checked
                      ? [...value.ownerKinds, kind]
                      : value.ownerKinds.filter((candidate) => candidate !== kind),
                  })
                }
                aria-label={`Applies to ${ownerKindLabel(kind)}`}
              />
              {ownerKindLabel(kind)}
            </label>
          ))}
        </div>
      </div>
      <div className="space-y-1.5">
        <Label>Editor color</Label>
        <div className="flex items-center gap-2">
          <Input
            type="color"
            className="h-8 w-14 p-1"
            value={value.color}
            onChange={(event) => onChange({ ...value, color: event.currentTarget.value })}
          />
          <Input
            className="w-28 font-mono"
            value={value.color}
            onChange={(event) => onChange({ ...value, color: event.currentTarget.value })}
          />
        </div>
      </div>
    </>
  );
}

export function TraitsEditor({ tab: _tab }: WorkbenchEditorProps) {
  const projectDocument = useProjectStore((state) => state.document);
  const executeCommand = useCommandStore((state) => state.executeCommand);
  const project = isAuthoringProject(projectDocument) ? projectDocument : null;
  const [metadataId, setMetadataId] = useState<string | null>(null);
  const [metadataDraft, setMetadataDraft] = useState<TraitMetadataDraft | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const traitEntries = useMemo(
    () =>
      project
        ? Object.entries(project.traits).sort(([, left], [, right]) =>
            left.label.localeCompare(right.label),
          )
        : [],
    [project],
  );

  if (!project)
    return <div className="p-4 text-sm text-muted-foreground">No authoring project loaded.</div>;

  const runPatches = (label: string, patches: JsonPatch[]) => {
    const result = executeCommand({
      type: 'project.applyPatch',
      label,
      payload: patches,
      originSaveUnitId: SAVE_UNIT_IDS.traitCollection,
      persistencePolicy: 'manual-save',
    });
    return (
      result.diagnostics.find((diagnostic) => diagnostic.severity === 'error')?.message ??
      (result.ok ? null : 'Command failed.')
    );
  };

  const metadataPatch = (traitId: string, color: string): JsonPatch =>
    project.editor.recordMetadata.traits
      ? {
          op: project.editor.recordMetadata.traits[traitId] ? 'replace' : 'add',
          path: `/editor/recordMetadata/traits/${escapeSegment(traitId)}`,
          value: { tags: [], color },
        }
      : {
          op: 'add',
          path: '/editor/recordMetadata/traits',
          value: { [traitId]: { tags: [], color } },
        };

  const openCreate = () => {
    setMetadataId('');
    setMetadataDraft(newTraitDraft(project));
    setMessage(null);
  };

  const openMetadata = (traitId: string) => {
    const trait = project.traits[traitId];
    if (!trait) return;
    setMetadataId(traitId);
    setMetadataDraft(draftForTrait(project, traitId, trait));
    setMessage(null);
  };

  const saveMetadata = () => {
    if (metadataId === null || !metadataDraft) return;
    const previous = metadataId ? project.traits[metadataId] : undefined;
    const parsed = traitFromMetadataDraft(metadataDraft, previous?.properties ?? []);
    if (!parsed.ok) {
      setMessage(parsed.message);
      return;
    }
    if (parsed.id !== metadataId && project.traits[parsed.id]) {
      setMessage(`Trait '${parsed.id}' already exists.`);
      return;
    }
    const patches: JsonPatch[] = [];
    if (!previous) {
      patches.push(
        { op: 'add', path: `/traits/${escapeSegment(parsed.id)}`, value: parsed.trait },
        metadataPatch(parsed.id, metadataDraft.color),
      );
    } else if (parsed.id === metadataId) {
      patches.push(
        { op: 'replace', path: `/traits/${escapeSegment(metadataId)}`, value: parsed.trait },
        metadataPatch(metadataId, metadataDraft.color),
      );
    } else {
      patches.push(
        ...attachmentRewritePatches(project, metadataId, parsed.id),
        ...selectorRenamePatches(project, metadataId, parsed.id),
        { op: 'add', path: `/traits/${escapeSegment(parsed.id)}`, value: parsed.trait },
        { op: 'remove', path: `/traits/${escapeSegment(metadataId)}` },
      );
      if (project.editor.recordMetadata.traits?.[metadataId])
        patches.push({
          op: 'remove',
          path: `/editor/recordMetadata/traits/${escapeSegment(metadataId)}`,
        });
      patches.push(metadataPatch(parsed.id, metadataDraft.color));
    }
    const failure = runPatches(
      previous ? `Update Trait ${metadataId}` : `Create Trait ${parsed.id}`,
      patches,
    );
    if (failure) {
      setMessage(failure);
      return;
    }
    setMetadataId(null);
    setMetadataDraft(null);
    setMessage(null);
  };

  const replaceProperties = (
    traitId: string,
    nextProperties: TraitProperty[],
    removed: readonly TraitProperty[] = [],
  ) => {
    const trait = project.traits[traitId];
    if (!trait) return 'Trait no longer exists.';
    return runPatches(`Update Trait ${traitId} Properties`, [
      ...preservationPatchesForRemovedTraitProperties(project, traitId, removed),
      {
        op: 'replace',
        path: `/traits/${escapeSegment(traitId)}`,
        value: { ...trait, properties: nextProperties },
      },
    ]);
  };

  const deleteTrait = () => {
    if (!deleteId) return;
    const trait = project.traits[deleteId];
    if (!trait) return;
    const patches: JsonPatch[] = [
      ...preservationPatchesForRemovedTraitProperties(project, deleteId, trait.properties),
      ...attachmentRewritePatches(project, deleteId, null),
      { op: 'remove', path: `/traits/${escapeSegment(deleteId)}` },
    ];
    if (project.editor.recordMetadata.traits?.[deleteId])
      patches.push({
        op: 'remove',
        path: `/editor/recordMetadata/traits/${escapeSegment(deleteId)}`,
      });
    const failure = runPatches(`Delete Trait ${deleteId}`, patches);
    if (failure) {
      setMessage(failure);
      return;
    }
    setDeleteId(null);
  };

  const usagePaths = deleteId ? traitUsagePaths(project, deleteId) : [];

  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto bg-background p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold">Traits</h2>
          <Badge variant="outline">{traitEntries.length}</Badge>
        </div>
        <Button size="sm" onClick={openCreate}>
          <Plus className="size-4" /> New Trait
        </Button>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Traits are reusable semantic capability contracts. Their Properties use the same editor as
        Variables and owner-local state.
      </p>

      <div className="mt-4 space-y-4">
        {traitEntries.length === 0 ? (
          <div className="rounded border border-dashed p-8 text-center text-sm text-muted-foreground">
            No Traits yet.
          </div>
        ) : null}
        {traitEntries.map(([traitId, trait]) => {
          const color = project.editor.recordMetadata.traits?.[traitId]?.color ?? null;
          const rows: PropertyManagerRow[] = trait.properties.map((property, index) => ({
            id: property.id,
            label: property.label,
            description: property.description,
            type: property.type,
            nullable: property.nullable,
            enumValues: property.enumValues,
            ...(property.defaultValue === undefined ? {} : { value: property.defaultValue }),
            valueState: property.defaultValue === undefined ? 'missing' : 'normal',
            editMode: 'schema',
            deletable: true,
            canMoveUp: index > 0,
            canMoveDown: index < trait.properties.length - 1,
          }));
          return (
            <section key={traitId} className="rounded-lg border bg-card/20 p-3">
              <div className="flex items-start justify-between gap-3">
                <Button
                  variant="ghost"
                  className="h-auto min-w-0 justify-start px-1 py-0.5 text-left"
                  aria-label={`Edit ${trait.label}`}
                  onClick={() => openMetadata(traitId)}
                >
                  <span
                    className="mr-2 size-3 shrink-0 rounded-full border"
                    style={{ backgroundColor: color ?? undefined }}
                  />
                  <span className="min-w-0">
                    <span className="block truncate font-semibold">{trait.label}</span>
                    <span className="block truncate font-mono text-[11px] text-muted-foreground">
                      {traitId}
                    </span>
                  </span>
                </Button>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  className="text-destructive"
                  aria-label={`Delete ${trait.label}`}
                  onClick={() => setDeleteId(traitId)}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
              {trait.description ? (
                <p className="mt-1 text-xs text-muted-foreground">{trait.description}</p>
              ) : null}
              <div className="mt-2 flex flex-wrap gap-1.5">
                {trait.ownerKinds.map((kind) => (
                  <Badge key={kind} variant="outline">
                    {ownerKindLabel(kind)}
                  </Badge>
                ))}
              </div>

              <div className="mt-3">
                <PropertyManager
                  title="Properties"
                  description="Ordered typed contracts. A missing Default must be supplied by a more-specific concrete owner."
                  valueLabel="Default"
                  valueOptional
                  rows={rows}
                  emptyLabel="This Trait has no Properties."
                  addLabel="Add Property"
                  newDraft={() => ({ ...newTypedPropertyDraft(), valuePresent: false })}
                  editDescription={() =>
                    'The Property schema belongs to this Trait. Default is optional.'
                  }
                  onCreate={(draft) => {
                    const parsed = traitPropertyFromDraft(draft);
                    if (!parsed.ok) return parsed.message;
                    if (trait.properties.some((property) => property.id === parsed.property.id))
                      return `Trait Property '${parsed.property.id}' already exists.`;
                    return replaceProperties(traitId, [...trait.properties, parsed.property]);
                  }}
                  onEdit={(row, draft) => {
                    const parsed = traitPropertyFromDraft(draft);
                    if (!parsed.ok) return parsed.message;
                    if (
                      trait.properties.some(
                        (property) => property.id === parsed.property.id && property.id !== row.id,
                      )
                    )
                      return `Trait Property '${parsed.property.id}' already exists.`;
                    const previous = trait.properties.find((property) => property.id === row.id);
                    if (!previous) return 'Trait Property no longer exists.';
                    const next = trait.properties.map((property) =>
                      property.id === row.id ? parsed.property : property,
                    );
                    return replaceProperties(
                      traitId,
                      next,
                      row.id === parsed.property.id ? [] : [previous],
                    );
                  }}
                  onDelete={(row) => {
                    const previous = trait.properties.find((property) => property.id === row.id);
                    if (!previous) return 'Trait Property no longer exists.';
                    return replaceProperties(
                      traitId,
                      trait.properties.filter((property) => property.id !== row.id),
                      [previous],
                    );
                  }}
                  deleteMessage={(row) =>
                    `Deleting '${row.label ?? row.id}' removes this Property from the Trait contract. Explicit surviving owner state is preserved where possible.`
                  }
                  onMove={(row, direction) => {
                    const index = trait.properties.findIndex((property) => property.id === row.id);
                    const target = direction === 'up' ? index - 1 : index + 1;
                    if (index < 0 || target < 0 || target >= trait.properties.length) return null;
                    const next = [...trait.properties];
                    [next[index], next[target]] = [next[target]!, next[index]!];
                    return replaceProperties(traitId, next);
                  }}
                  className="border-0 bg-transparent p-0"
                  modeMarker="trait"
                />
              </div>
            </section>
          );
        })}
      </div>

      <Dialog
        open={metadataId !== null}
        onOpenChange={(open) => {
          if (!open) {
            setMetadataId(null);
            setMetadataDraft(null);
            setMessage(null);
          }
        }}
      >
        <DialogPopup className="w-[min(620px,calc(100vw-2rem))]">
          <DialogTitle>{metadataId === '' ? 'New Trait' : 'Edit Trait'}</DialogTitle>
          <DialogDescription>
            Trait identity and applicability are separate from the ordered Property contract below.
          </DialogDescription>
          {metadataDraft ? (
            <TraitMetadataFields value={metadataDraft} onChange={setMetadataDraft} />
          ) : null}
          {message ? <p className="text-xs text-destructive">{message}</p> : null}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setMetadataId(null)}>
              Cancel
            </Button>
            <Button onClick={saveMetadata}>
              {metadataId === '' ? 'Create Trait' : 'Save Trait'}
            </Button>
          </div>
        </DialogPopup>
      </Dialog>

      <Dialog open={deleteId !== null} onOpenChange={(open) => !open && setDeleteId(null)}>
        <DialogPopup className="w-[min(560px,calc(100vw-2rem))]">
          <DialogTitle>Delete Trait?</DialogTitle>
          <DialogDescription>
            Known structural attachments and deltas will be cleaned up. Explicit owner state is
            preserved when its last Trait source disappears.
          </DialogDescription>
          {usagePaths.length > 0 ? (
            <div className="max-h-40 overflow-auto rounded border bg-muted/20 p-2 font-mono text-[11px]">
              {usagePaths.map((path) => (
                <div key={path}>{path}</div>
              ))}
            </div>
          ) : (
            <div className="text-xs text-muted-foreground">No known structural usages.</div>
          )}
          {message ? <p className="text-xs text-destructive">{message}</p> : null}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setDeleteId(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={deleteTrait}>
              Delete Trait
            </Button>
          </div>
        </DialogPopup>
      </Dialog>
    </div>
  );
}
