import { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogDescription, DialogPopup, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  newTypedPropertyDraft,
  TypedPropertyFields,
  typedPropertyValueFromDraft,
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
import { variableValueToText } from '../../../shared/project-schema/authoring-variables';
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

interface TraitPropertyDraft {
  fields: TypedPropertyDraft;
  hasDefault: boolean;
}

interface TraitDraft {
  id: string;
  label: string;
  description: string;
  ownerKinds: PropertyOwnerKind[];
  color: string;
  properties: TraitPropertyDraft[];
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

function traitPropertyDraft(property: TraitProperty): TraitPropertyDraft {
  return {
    fields: {
      id: property.id,
      label: property.label ?? '',
      description: property.description ?? '',
      type: property.type,
      nullable: property.nullable,
      valuePresent: property.defaultValue !== undefined,
      valueText:
        property.defaultValue === undefined
          ? property.type === 'boolean'
            ? 'false'
            : property.type === 'enum'
              ? (property.enumValues?.[0] ?? '')
              : property.type === 'string'
                ? ''
                : '0'
          : variableValueToText(property.defaultValue),
      enumText: property.enumValues?.join(', ') ?? 'default',
    },
    hasDefault: property.defaultValue !== undefined,
  };
}

function draftForTrait(project: AuthoringProject, id: string, trait: TraitDefinition): TraitDraft {
  return {
    id,
    label: trait.label,
    description: trait.description ?? '',
    ownerKinds: [...trait.ownerKinds],
    color: project.editor.recordMetadata.traits?.[id]?.color ?? colorForIndex(0),
    properties: trait.properties.map(traitPropertyDraft),
  };
}

function newTraitDraft(project: AuthoringProject): TraitDraft {
  return {
    id: '',
    label: '',
    description: '',
    ownerKinds: ['room'],
    color: colorForIndex(Object.keys(project.traits).length),
    properties: [],
  };
}

function traitPropertyFromDraft(
  draft: TraitPropertyDraft,
): { ok: true; property: TraitProperty } | { ok: false; message: string } {
  const id = draft.fields.id.trim();
  if (!id) return { ok: false, message: 'Every Trait Property requires an ID.' };
  const parsed = typedPropertyValueFromDraft(draft.fields);
  if (!parsed.ok) return parsed;
  return {
    ok: true,
    property: {
      id,
      ...(draft.fields.label.trim() ? { label: draft.fields.label.trim() } : {}),
      ...(draft.fields.description.trim() ? { description: draft.fields.description.trim() } : {}),
      type: draft.fields.type,
      nullable: draft.fields.nullable,
      ...(parsed.enumValues ? { enumValues: parsed.enumValues } : {}),
      ...(draft.hasDefault ? { defaultValue: parsed.value } : {}),
    },
  };
}

function traitFromDraft(draft: TraitDraft) {
  const id = draft.id.trim();
  if (!id) return { ok: false as const, message: 'Trait ID is required.' };
  if (!draft.label.trim()) return { ok: false as const, message: 'Trait label is required.' };
  if (draft.ownerKinds.length === 0)
    return { ok: false as const, message: 'Traits must apply to at least one owner kind.' };
  const properties: TraitProperty[] = [];
  const seen = new Set<string>();
  for (const propertyDraft of draft.properties) {
    const parsed = traitPropertyFromDraft(propertyDraft);
    if (!parsed.ok) return parsed;
    if (seen.has(parsed.property.id))
      return {
        ok: false as const,
        message: `Trait Property '${parsed.property.id}' is declared more than once.`,
      };
    seen.add(parsed.property.id);
    properties.push(parsed.property);
  }
  return {
    ok: true as const,
    id,
    trait: {
      id,
      label: draft.label.trim(),
      ...(draft.description.trim() ? { description: draft.description.trim() } : {}),
      ownerKinds: [...draft.ownerKinds],
      properties,
    } satisfies TraitDefinition,
  };
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

export function TraitsEditor({ tab: _tab }: WorkbenchEditorProps) {
  const projectDocument = useProjectStore((state) => state.document);
  const executeCommand = useCommandStore((state) => state.executeCommand);
  const project = isAuthoringProject(projectDocument) ? projectDocument : null;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<TraitDraft | null>(null);
  const [creating, setCreating] = useState(false);
  const [createDraft, setCreateDraft] = useState<TraitDraft | null>(null);
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

  useEffect(() => {
    if (!project) return;
    const id =
      selectedId && project.traits[selectedId] ? selectedId : (traitEntries[0]?.[0] ?? null);
    if (id !== selectedId) setSelectedId(id);
    if (id && project.traits[id]) setDraft(draftForTrait(project, id, project.traits[id]!));
    else setDraft(null);
  }, [project, selectedId, traitEntries]);

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

  const createTrait = () => {
    if (!createDraft) return;
    const parsed = traitFromDraft(createDraft);
    if (!parsed.ok) {
      setMessage(parsed.message);
      return;
    }
    if (project.traits[parsed.id]) {
      setMessage(`Trait '${parsed.id}' already exists.`);
      return;
    }
    const failure = runPatches(`Create Trait ${parsed.id}`, [
      { op: 'add', path: `/traits/${escapeSegment(parsed.id)}`, value: parsed.trait },
      metadataPatch(parsed.id, createDraft.color),
    ]);
    if (failure) {
      setMessage(failure);
      return;
    }
    setCreating(false);
    setSelectedId(parsed.id);
    setMessage(null);
  };

  const saveTrait = () => {
    if (!draft || !selectedId) return;
    const parsed = traitFromDraft(draft);
    if (!parsed.ok) {
      setMessage(parsed.message);
      return;
    }
    if (parsed.id !== selectedId && project.traits[parsed.id]) {
      setMessage(`Trait '${parsed.id}' already exists.`);
      return;
    }
    const previous = project.traits[selectedId]!;
    const nextIds = new Set(parsed.trait.properties.map((property) => property.id));
    const removed = previous.properties.filter((property) => !nextIds.has(property.id));
    const patches = preservationPatchesForRemovedTraitProperties(project, selectedId, removed);
    if (parsed.id === selectedId) {
      patches.push(
        { op: 'replace', path: `/traits/${escapeSegment(selectedId)}`, value: parsed.trait },
        metadataPatch(selectedId, draft.color),
      );
    } else {
      patches.push(
        ...attachmentRewritePatches(project, selectedId, parsed.id),
        ...selectorRenamePatches(project, selectedId, parsed.id),
        { op: 'add', path: `/traits/${escapeSegment(parsed.id)}`, value: parsed.trait },
        { op: 'remove', path: `/traits/${escapeSegment(selectedId)}` },
      );
      const oldMetadata = project.editor.recordMetadata.traits?.[selectedId];
      if (oldMetadata)
        patches.push({
          op: 'remove',
          path: `/editor/recordMetadata/traits/${escapeSegment(selectedId)}`,
        });
      patches.push(metadataPatch(parsed.id, draft.color));
    }
    const failure = runPatches(`Update Trait ${selectedId}`, patches);
    if (failure) {
      setMessage(failure);
      return;
    }
    setSelectedId(parsed.id);
    setMessage(null);
  };

  const deleteTrait = () => {
    if (!deleteId) return;
    const trait = project.traits[deleteId];
    if (!trait) return;
    const patches = [
      ...preservationPatchesForRemovedTraitProperties(project, deleteId, trait.properties),
      ...attachmentRewritePatches(project, deleteId, null),
      { op: 'remove' as const, path: `/traits/${escapeSegment(deleteId)}` },
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
    setSelectedId(null);
  };

  const usagePaths = deleteId ? traitUsagePaths(project, deleteId) : [];

  const renderMetadataFields = (value: TraitDraft, onChange: (next: TraitDraft) => void) => (
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

  return (
    <div className="flex h-full min-h-0 bg-background">
      <aside className="flex w-64 shrink-0 flex-col border-r">
        <div className="flex items-center justify-between border-b p-3">
          <div className="flex items-center gap-2">
            <h2 className="font-semibold">Traits</h2>
            <Badge variant="outline">{traitEntries.length}</Badge>
          </div>
          <Button
            size="icon-sm"
            aria-label="New Trait"
            onClick={() => {
              setCreateDraft(newTraitDraft(project));
              setMessage(null);
              setCreating(true);
            }}
          >
            <Plus className="size-4" />
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-2">
          {traitEntries.length === 0 ? (
            <div className="p-3 text-xs text-muted-foreground">No Traits yet.</div>
          ) : null}
          {traitEntries.map(([id, trait]) => (
            <Button
              key={id}
              variant={selectedId === id ? 'secondary' : 'ghost'}
              className="mb-1 h-auto w-full justify-start px-2 py-2 text-left"
              onClick={() => setSelectedId(id)}
            >
              <span
                className="mr-2 size-3 shrink-0 rounded-full border"
                style={{
                  backgroundColor: project.editor.recordMetadata.traits?.[id]?.color ?? undefined,
                }}
              />
              <span className="min-w-0">
                <span className="block truncate text-sm">{trait.label}</span>
                <span className="block truncate font-mono text-[10px] text-muted-foreground">
                  {id}
                </span>
              </span>
            </Button>
          ))}
        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-auto p-4">
        {!draft || !selectedId ? (
          <div className="text-sm text-muted-foreground">Create or select a Trait to edit it.</div>
        ) : (
          <div className="mx-auto max-w-3xl space-y-5">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">{project.traits[selectedId]?.label}</h2>
                <p className="text-xs text-muted-foreground">
                  Traits own reusable typed Property contracts. Empty Traits are valid.
                </p>
              </div>
              <div className="flex gap-2">
                <Button variant="destructive" size="sm" onClick={() => setDeleteId(selectedId)}>
                  <Trash2 className="size-4" /> Delete
                </Button>
                <Button size="sm" onClick={saveTrait}>
                  Save Trait
                </Button>
              </div>
            </div>

            <section className="space-y-3 rounded border p-3">
              <h3 className="text-sm font-semibold">Trait metadata</h3>
              {renderMetadataFields(draft, setDraft)}
            </section>

            <section className="space-y-3 rounded border p-3">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <h3 className="text-sm font-semibold">Trait Properties</h3>
                  <p className="text-xs text-muted-foreground">
                    Order is authored. A Property without a Default must be supplied by a concrete
                    owner.
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    setDraft({
                      ...draft,
                      properties: [
                        ...draft.properties,
                        { fields: newTypedPropertyDraft(), hasDefault: false },
                      ],
                    })
                  }
                >
                  <Plus className="size-4" /> Add Property
                </Button>
              </div>
              {draft.properties.length === 0 ? (
                <div className="rounded border border-dashed p-4 text-center text-xs text-muted-foreground">
                  This Trait has no Properties.
                </div>
              ) : null}
              {draft.properties.map((property, index) => (
                <div key={index} className="space-y-3 rounded border bg-muted/10 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium">Property {index + 1}</span>
                    <div className="flex gap-1">
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        disabled={index === 0}
                        aria-label="Move Property up"
                        onClick={() => {
                          const next = [...draft.properties];
                          [next[index - 1], next[index]] = [next[index], next[index - 1]];
                          setDraft({ ...draft, properties: next });
                        }}
                      >
                        <ArrowUp className="size-3" />
                      </Button>
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        disabled={index === draft.properties.length - 1}
                        aria-label="Move Property down"
                        onClick={() => {
                          const next = [...draft.properties];
                          [next[index], next[index + 1]] = [next[index + 1], next[index]];
                          setDraft({ ...draft, properties: next });
                        }}
                      >
                        <ArrowDown className="size-3" />
                      </Button>
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        className="text-destructive"
                        aria-label="Delete Trait Property"
                        onClick={() =>
                          setDraft({
                            ...draft,
                            properties: draft.properties.filter(
                              (_, candidate) => candidate !== index,
                            ),
                          })
                        }
                      >
                        <Trash2 className="size-3" />
                      </Button>
                    </div>
                  </div>
                  <TypedPropertyFields
                    draft={property.fields}
                    onChange={(fields) =>
                      setDraft({
                        ...draft,
                        properties: draft.properties.map((candidate, candidateIndex) =>
                          candidateIndex === index ? { ...candidate, fields } : candidate,
                        ),
                      })
                    }
                    valueLabel="Default"
                    descriptionPlaceholder="What this Trait Property represents"
                  />
                  <div className="flex items-center gap-2 text-xs">
                    <Switch
                      checked={property.hasDefault}
                      onCheckedChange={(hasDefault) =>
                        setDraft({
                          ...draft,
                          properties: draft.properties.map((candidate, candidateIndex) =>
                            candidateIndex === index ? { ...candidate, hasDefault } : candidate,
                          ),
                        })
                      }
                      aria-label={`Property ${index + 1} has Default`}
                    />
                    <span>
                      {property.hasDefault
                        ? 'Default is part of the Trait contract.'
                        : 'No Default; concrete owners must provide a Value.'}
                    </span>
                  </div>
                </div>
              ))}
            </section>

            {message ? (
              <div className="rounded border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
                {message}
              </div>
            ) : null}
          </div>
        )}
      </main>

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogPopup className="w-[min(620px,calc(100vw-2rem))]">
          <DialogTitle>New Trait</DialogTitle>
          <DialogDescription>
            Choose the Trait identity and owner kinds now; Properties may be added after creation.
          </DialogDescription>
          {createDraft ? renderMetadataFields(createDraft, setCreateDraft) : null}
          {message ? <div className="text-xs text-destructive">{message}</div> : null}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button onClick={createTrait}>Create Trait</Button>
          </div>
        </DialogPopup>
      </Dialog>

      <Dialog open={deleteId !== null} onOpenChange={(open) => !open && setDeleteId(null)}>
        <DialogPopup className="w-[min(560px,calc(100vw-2rem))]">
          <DialogTitle>Delete Trait?</DialogTitle>
          <DialogDescription>
            Known structural attachments and deltas will be cleaned up. Explicit Room/Character
            Values are preserved as standalone local Properties when their last Trait source
            disappears.
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
