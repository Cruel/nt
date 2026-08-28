import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectItem } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { SearchSelectorDialog } from '@/workspace/SearchSelectorDialog';
import {
  buildCommandPaletteItems,
  filterSelectorItems,
  type SelectorItem,
} from '@/workspace/command-palette-search';
import {
  defaultArchetypeData,
  gameplayInstanceKindValues,
  parseArchetypeData,
  type GameplayInstanceKind,
} from '../../../../shared/project-schema/authoring-archetypes';
import { defaultCharacterData } from '../../../../shared/project-schema/authoring-characters';
import { defaultInteractableData } from '../../../../shared/project-schema/authoring-interactables';
import { defaultHotspotBehavior } from '../../../../shared/project-schema/authoring-hotspots';
import { defaultDialogueData } from '../../../../shared/project-schema/authoring-dialogues';
import {
  defaultLayoutData,
  layoutKindValues,
  type LayoutKind,
} from '../../../../shared/project-schema/authoring-layouts';
import {
  defaultMaterialData,
  materialPreviewBackgroundValues,
  materialPreviewGeometryValues,
} from '../../../../shared/project-schema/authoring-materials';
import {
  defaultRoomData,
  roomBackgroundFitValues,
} from '../../../../shared/project-schema/authoring-rooms';
import { defaultSceneData } from '../../../../shared/project-schema/authoring-scenes';
import {
  defaultShaderData,
  shaderRoleValues,
} from '../../../../shared/project-schema/authoring-shaders';
import { defaultTestData } from '../../../../shared/project-schema/authoring-tests';
import {
  defaultVariableData,
  variableTypeValues,
  type VariableType,
} from '../../../../shared/project-schema/authoring-variables';
import { visualForCollection } from '../../../workspace/collection-visuals';
import type { AuthoringProject } from '../../../../shared/project-schema/authoring-project';
import type { NewEntityWizardDraft, NewEntityWizardTypeDefinition } from './common';
import { ref, selected } from './common';

function visual(collection: NewEntityWizardTypeDefinition['collection']) {
  const base = visualForCollection(collection);
  return { icon: base.icon, iconClassName: base.colorClassName };
}

function recordOptions<T extends string>(
  records: Record<string, { label?: string }>,
  noneLabel: string,
  mapValue: (id: string) => T = (id) => id as T,
) {
  return (
    <>
      <SelectItem value="__none__">{noneLabel}</SelectItem>
      {Object.entries(records).map(([id, record]) => (
        <SelectItem key={id} value={mapValue(id)}>
          {record.label || id} ({id})
        </SelectItem>
      ))}
    </>
  );
}

function choiceItem(id: string, title: string, subtitle: string): SelectorItem {
  return {
    id,
    kind: 'record',
    title,
    subtitle,
    tags: [],
    collectionTerms: [subtitle],
    actionTerms: [],
  };
}

function InteractableWizardOptions({
  project,
  draft,
  setOption,
}: {
  project: AuthoringProject;
  draft: NewEntityWizardDraft;
  setOption: (key: string, value: string | boolean | number | null) => void;
}) {
  const [archetypeOpen, setArchetypeOpen] = useState(false);
  const [spriteOpen, setSpriteOpen] = useState(false);
  const selectorItems = useMemo(() => buildCommandPaletteItems(project), [project]);
  const archetypeItems = useMemo(
    () =>
      filterSelectorItems(selectorItems, {
        collections: ['archetypes'],
        includeActions: false,
      }).filter((item) => {
        const record = item.entityId ? project.archetypes[item.entityId] : null;
        return record ? parseArchetypeData(record.data)?.instanceKind === 'interactable' : false;
      }),
    [project.archetypes, selectorItems],
  );
  const imageAssetItems = useMemo(
    () =>
      filterSelectorItems(selectorItems, {
        collections: ['assets'],
        assetKinds: ['image'],
        includeActions: false,
      }),
    [selectorItems],
  );
  const archetypeId = String(draft.options.archetypeId ?? '__none__');
  const spriteId = String(draft.options.spriteId ?? '__none__');
  const selectedArchetype = archetypeItems.find((item) => item.entityId === archetypeId);
  const selectedSprite = imageAssetItems.find((item) => item.entityId === spriteId);
  const archetypeChoices = useMemo(
    () => [choiceItem('choice:no-archetype', 'No archetype', 'Archetype'), ...archetypeItems],
    [archetypeItems],
  );
  const spriteChoices = useMemo(
    () => [
      ...(archetypeId !== '__none__'
        ? [choiceItem('choice:inherit-sprite', 'From archetype', 'Sprite')]
        : []),
      choiceItem('choice:no-sprite', 'No sprite', 'Sprite'),
      ...imageAssetItems,
    ],
    [archetypeId, imageAssetItems],
  );

  const setArchetype = (nextId: string) => {
    setOption('archetypeId', nextId);
    if (nextId !== '__none__' && spriteId === '__none__') setOption('spriteId', '__inherit__');
    else if (nextId === '__none__' && spriteId === '__inherit__') setOption('spriteId', '__none__');
  };

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label>Archetype</Label>
          <Button
            type="button"
            aria-label="Interactable archetype"
            variant="outline"
            className="h-auto w-full justify-start px-3 py-2 text-left"
            onClick={() => setArchetypeOpen(true)}
          >
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">
                {selectedArchetype?.title ?? 'No archetype'}
              </span>
              <span className="block truncate text-xs text-muted-foreground">
                {selectedArchetype?.entityId ?? `${archetypeItems.length} compatible archetypes`}
              </span>
            </span>
          </Button>
        </div>
        <div className="space-y-1">
          <Label>Sprite</Label>
          <Button
            type="button"
            aria-label="Interactable sprite"
            variant="outline"
            className="h-auto w-full justify-start px-3 py-2 text-left"
            onClick={() => setSpriteOpen(true)}
          >
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">
                {spriteId === '__inherit__'
                  ? 'From archetype'
                  : (selectedSprite?.title ?? 'No sprite')}
              </span>
              <span className="block truncate text-xs text-muted-foreground">
                {spriteId === '__inherit__'
                  ? 'Use the Archetype presentation sprite'
                  : (selectedSprite?.entityId ?? `${imageAssetItems.length} image assets`)}
              </span>
            </span>
          </Button>
        </div>
      </div>
      <SearchSelectorDialog
        open={archetypeOpen}
        title="Choose Interactable Archetype"
        placeholder="Search Interactable Archetypes..."
        emptyMessage="No compatible Interactable Archetypes match your search."
        items={archetypeChoices}
        selectedId={selectedArchetype?.id ?? 'choice:no-archetype'}
        onOpenChange={setArchetypeOpen}
        onSelect={(item) =>
          setArchetype(
            item.id === 'choice:no-archetype' ? '__none__' : (item.entityId ?? '__none__'),
          )
        }
      />
      <SearchSelectorDialog
        open={spriteOpen}
        title="Choose Interactable sprite"
        placeholder="Search image assets..."
        emptyMessage="No image assets match your search."
        items={spriteChoices}
        selectedId={
          spriteId === '__inherit__'
            ? 'choice:inherit-sprite'
            : (selectedSprite?.id ?? 'choice:no-sprite')
        }
        leadingMediaSize={{ width: 80, height: 48 }}
        onOpenChange={setSpriteOpen}
        onSelect={(item) => {
          if (item.id === 'choice:inherit-sprite') setOption('spriteId', '__inherit__');
          else if (item.id === 'choice:no-sprite') setOption('spriteId', '__none__');
          else if (item.entityId) setOption('spriteId', item.entityId);
        }}
      />
    </>
  );
}

export const typedWizardDefinitions: NewEntityWizardTypeDefinition[] = [
  {
    collection: 'archetypes',
    category: 'world',
    supportLevel: 'typed',
    summary: 'Immutable same-kind configuration blueprints for declared Gameplay Instances.',
    currentScope:
      'Creates a Room, Character, or Interactable Archetype with no runtime identity or mutable state.',
    ...visual('archetypes'),
    defaultOptions: () => ({ instanceKind: 'room' }),
    renderOptions: ({ draft, setOption }) => (
      <div className="space-y-1">
        <Label>Gameplay Instance kind</Label>
        <Select
          value={String(draft.options.instanceKind ?? 'room')}
          onValueChange={(value) => setOption('instanceKind', String(value))}
        >
          {gameplayInstanceKindValues.map((kind) => (
            <SelectItem key={kind} value={kind}>
              {kind[0].toUpperCase() + kind.slice(1)}
            </SelectItem>
          ))}
        </Select>
      </div>
    ),
    buildPayload: ({ draft }) => ({
      data: defaultArchetypeData((draft.options.instanceKind || 'room') as GameplayInstanceKind),
    }),
  },
  {
    collection: 'interactables',
    category: 'world',
    supportLevel: 'typed',
    summary: 'Unique world or inventory definitions with explicit initial state.',
    currentScope: 'Creates an Interactable from an optional Archetype and sprite.',
    ...visual('interactables'),
    basicFields: 'identity-only',
    defaultOptions: () => ({ archetypeId: '__none__', spriteId: '__none__' }),
    renderOptions: (props) => <InteractableWizardOptions {...props} />,
    buildPayload: ({ draft }) => {
      const data = defaultInteractableData(draft.basics.label);
      const spriteId =
        draft.options.spriteId === '__inherit__' ? null : selected(draft.options.spriteId);
      if (spriteId) {
        data.presentation.sprite = ref('assets', spriteId);
        data.presentation.hotspots = {
          kind: 'sprite-alpha',
          hotspot: defaultHotspotBehavior(draft.basics.label),
        };
      }
      return { data };
    },
  },
  {
    collection: 'variables',
    category: 'logic',
    supportLevel: 'typed',
    summary: 'Global runtime state used by scenes, tests, and Lua.',
    currentScope: 'Creates a typed global variable with a schema-compatible default value.',
    ...visual('variables'),
    defaultOptions: () => ({ variableType: 'boolean' }),
    renderOptions: ({ draft, setOption }) => (
      <div className="space-y-1">
        <Label>Variable type</Label>
        <Select
          value={String(draft.options.variableType ?? 'boolean')}
          onValueChange={(value) => setOption('variableType', String(value))}
        >
          {variableTypeValues.map((type) => (
            <SelectItem key={type} value={type}>
              {type}
            </SelectItem>
          ))}
        </Select>
      </div>
    ),
    buildPayload: ({ draft }) => ({
      data: defaultVariableData((draft.options.variableType || 'boolean') as VariableType),
    }),
  },
  {
    collection: 'shaders',
    category: 'presentation',
    supportLevel: 'typed',
    summary: 'Inline bgfx shader source metadata for material experiments.',
    currentScope: 'Creates the current default vertex/fragment shader scaffold.',
    ...visual('shaders'),
    defaultOptions: () => ({ role: 'engine-2d' }),
    renderOptions: ({ draft, setOption }) => (
      <div className="space-y-1">
        <Label>Primary role</Label>
        <Select
          value={String(draft.options.role ?? 'engine-2d')}
          onValueChange={(value) => setOption('role', String(value))}
        >
          {shaderRoleValues.map((role) => (
            <SelectItem key={role} value={role}>
              {role}
            </SelectItem>
          ))}
        </Select>
      </div>
    ),
    buildPayload: ({ draft }) => {
      const data = defaultShaderData(draft.basics.label);
      data.roles = [String(draft.options.role ?? 'engine-2d') as (typeof data.roles)[number]];
      return { data };
    },
  },
  {
    collection: 'materials',
    category: 'presentation',
    supportLevel: 'typed',
    summary: 'Material records bind shaders, uniforms, textures, and preview settings.',
    currentScope: 'Creates a default engine-2d material with optional shader selection.',
    ...visual('materials'),
    defaultOptions: () => ({
      shaderId: '__none__',
      previewGeometry: 'quad',
      previewBackground: 'checker',
    }),
    renderOptions: ({ project, draft, setOption }) => (
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1">
          <Label>Shader</Label>
          <Select
            value={String(draft.options.shaderId ?? '__none__')}
            onValueChange={(value) => setOption('shaderId', String(value))}
          >
            {recordOptions(project.shaders, 'No shader')}
          </Select>
        </div>
        <div className="space-y-1">
          <Label>Preview</Label>
          <Select
            value={String(draft.options.previewGeometry ?? 'quad')}
            onValueChange={(value) => setOption('previewGeometry', String(value))}
          >
            {materialPreviewGeometryValues.map((value) => (
              <SelectItem key={value} value={value}>
                {value}
              </SelectItem>
            ))}
          </Select>
        </div>
        <div className="space-y-1">
          <Label>Background</Label>
          <Select
            value={String(draft.options.previewBackground ?? 'checker')}
            onValueChange={(value) => setOption('previewBackground', String(value))}
          >
            {materialPreviewBackgroundValues.map((value) => (
              <SelectItem key={value} value={value}>
                {value}
              </SelectItem>
            ))}
          </Select>
        </div>
      </div>
    ),
    buildPayload: ({ draft }) => {
      const shaderId = selected(draft.options.shaderId);
      const data = defaultMaterialData(draft.basics.label, shaderId ?? undefined);
      data.preview.geometry = String(
        draft.options.previewGeometry ?? 'quad',
      ) as typeof data.preview.geometry;
      data.preview.background = String(
        draft.options.previewBackground ?? 'checker',
      ) as typeof data.preview.background;
      return { data };
    },
  },
  {
    collection: 'layouts',
    category: 'presentation',
    supportLevel: 'typed',
    summary: 'RmlUi layout documents and fragments for runtime UI.',
    currentScope: 'Creates an inline document or fragment using existing defaults.',
    ...visual('layouts'),
    defaultOptions: () => ({ layoutKind: 'fragment' }),
    renderOptions: ({ draft, setOption }) => (
      <div className="space-y-1">
        <Label>Layout kind</Label>
        <Select
          value={String(draft.options.layoutKind ?? 'fragment')}
          onValueChange={(value) => setOption('layoutKind', String(value))}
        >
          {layoutKindValues.map((kind) => (
            <SelectItem key={kind} value={kind}>
              {kind}
            </SelectItem>
          ))}
        </Select>
      </div>
    ),
    buildPayload: ({ draft }) => ({
      data: defaultLayoutData(
        draft.basics.label,
        (draft.options.layoutKind || 'fragment') as LayoutKind,
      ),
    }),
  },
  {
    collection: 'characters',
    category: 'story',
    supportLevel: 'typed',
    summary: 'Character presentation metadata, dialogue naming, poses, and expressions.',
    currentScope:
      'Creates a character with default pose/expression and optional sprite/material refs.',
    ...visual('characters'),
    defaultOptions: () => ({ spriteId: '__none__', materialId: '__none__' }),
    renderOptions: ({ project, draft, setOption }) => (
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label>Default sprite</Label>
          <Select
            value={String(draft.options.spriteId ?? '__none__')}
            onValueChange={(value) => setOption('spriteId', String(value))}
          >
            {recordOptions(
              Object.fromEntries(
                Object.entries(project.assets).filter(
                  ([, record]) => (record.data as { kind?: string }).kind === 'image',
                ),
              ),
              'No sprite',
            )}
          </Select>
        </div>
        <div className="space-y-1">
          <Label>Material</Label>
          <Select
            value={String(draft.options.materialId ?? '__none__')}
            onValueChange={(value) => setOption('materialId', String(value))}
          >
            {recordOptions(project.materials, 'No material')}
          </Select>
        </div>
      </div>
    ),
    buildPayload: ({ draft }) => {
      const data = defaultCharacterData(draft.basics.label);
      const spriteId = selected(draft.options.spriteId);
      const materialId = selected(draft.options.materialId);
      const layer = data.profiles[0]?.poses[0]?.layers[0];
      if (layer && spriteId) layer.sprite = ref('assets', spriteId);
      if (layer && materialId) layer.material = ref('materials', materialId);
      return { data };
    },
  },
  {
    collection: 'rooms',
    category: 'world',
    supportLevel: 'typed',
    summary: 'Navigable runtime locations with backgrounds, descriptions, paths, and hotspots.',
    currentScope: 'Creates a room with optional visual defaults and description text.',
    ...visual('rooms'),
    defaultOptions: () => ({
      backgroundAssetId: '__none__',
      materialId: '__none__',
      fit: 'cover',
      description: '',
      setEntrypoint: false,
    }),
    renderOptions: ({ project, draft, setOption }) => (
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label>Background image</Label>
          <Select
            value={String(draft.options.backgroundAssetId ?? '__none__')}
            onValueChange={(value) => setOption('backgroundAssetId', String(value))}
          >
            {recordOptions(
              Object.fromEntries(
                Object.entries(project.assets).filter(
                  ([, record]) => (record.data as { kind?: string }).kind === 'image',
                ),
              ),
              'No image',
            )}
          </Select>
        </div>
        <div className="space-y-1">
          <Label>Material</Label>
          <Select
            value={String(draft.options.materialId ?? '__none__')}
            onValueChange={(value) => setOption('materialId', String(value))}
          >
            {recordOptions(project.materials, 'No material')}
          </Select>
        </div>
        <div className="space-y-1">
          <Label>Fit</Label>
          <Select
            value={String(draft.options.fit ?? 'cover')}
            onValueChange={(value) => setOption('fit', String(value))}
          >
            {roomBackgroundFitValues.map((fit) => (
              <SelectItem key={fit} value={fit}>
                {fit}
              </SelectItem>
            ))}
          </Select>
        </div>
        <label className="flex items-end gap-2 text-sm">
          <input
            type="checkbox"
            checked={Boolean(draft.options.setEntrypoint)}
            onChange={(event) => setOption('setEntrypoint', event.currentTarget.checked)}
          />
          Set as project entrypoint after creation
        </label>
        <div className="space-y-1 sm:col-span-2">
          <Label>Initial description</Label>
          <Input
            value={String(draft.options.description ?? '')}
            onChange={(event) => setOption('description', event.currentTarget.value)}
            placeholder="Optional room description"
          />
        </div>
      </div>
    ),
    buildPayload: ({ draft }) => {
      const data = defaultRoomData(draft.basics.label);
      const assetId = selected(draft.options.backgroundAssetId);
      const materialId = selected(draft.options.materialId);
      if (assetId) data.background.asset = ref('assets', assetId);
      if (materialId) data.background.material = ref('materials', materialId);
      data.background.fit = String(draft.options.fit ?? 'cover') as typeof data.background.fit;
      data.description.source = { kind: 'inline', text: String(draft.options.description ?? '') };
      return { data };
    },
  },
  {
    collection: 'dialogues',
    category: 'story',
    supportLevel: 'typed',
    summary: 'Dialogue graph data with blocks, lines, speakers, conditions, and scripts.',
    currentScope: 'Creates a starting block with optional speaker and first line.',
    ...visual('dialogues'),
    defaultOptions: () => ({ speakerId: '__none__', lineText: '' }),
    renderOptions: ({ project, draft, setOption }) => (
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label>Default speaker</Label>
          <Select
            value={String(draft.options.speakerId ?? '__none__')}
            onValueChange={(value) => setOption('speakerId', String(value))}
          >
            {recordOptions(project.characters, 'No speaker')}
          </Select>
        </div>
        <div className="space-y-1">
          <Label>First line</Label>
          <Input
            value={String(draft.options.lineText ?? '')}
            onChange={(event) => setOption('lineText', event.currentTarget.value)}
            placeholder="Optional first line"
          />
        </div>
      </div>
    ),
    buildPayload: ({ draft }) => {
      const data = defaultDialogueData(draft.basics.label);
      const start = data.blocks[0];
      const firstLine =
        start?.type === 'sequence' && start.segments[0]?.type === 'line' ? start.segments[0] : null;
      const speakerId = selected(draft.options.speakerId);
      if (speakerId && start?.type === 'sequence' && firstLine) {
        data.defaultSpeaker = ref('characters', speakerId);
        start.defaultSpeaker = ref('characters', speakerId);
        firstLine.speaker = ref('characters', speakerId);
      }
      if (firstLine)
        firstLine.text.source = { kind: 'inline', text: String(draft.options.lineText ?? '') };
      return { data };
    },
  },
  {
    collection: 'scenes',
    category: 'story',
    supportLevel: 'typed',
    summary: 'VN orchestration sequences for backgrounds, characters, dialogue, audio, and logic.',
    currentScope: 'Creates a scene with optional background defaults and layout.',
    ...visual('scenes'),
    defaultOptions: () => ({
      backgroundAssetId: '__none__',
      materialId: '__none__',
      layoutId: '__none__',
    }),
    renderOptions: ({ project, draft, setOption }) => (
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1">
          <Label>Background</Label>
          <Select
            value={String(draft.options.backgroundAssetId ?? '__none__')}
            onValueChange={(value) => setOption('backgroundAssetId', String(value))}
          >
            {recordOptions(
              Object.fromEntries(
                Object.entries(project.assets).filter(
                  ([, record]) => (record.data as { kind?: string }).kind === 'image',
                ),
              ),
              'No image',
            )}
          </Select>
        </div>
        <div className="space-y-1">
          <Label>Material</Label>
          <Select
            value={String(draft.options.materialId ?? '__none__')}
            onValueChange={(value) => setOption('materialId', String(value))}
          >
            {recordOptions(project.materials, 'No material')}
          </Select>
        </div>
        <div className="space-y-1">
          <Label>Layout</Label>
          <Select
            value={String(draft.options.layoutId ?? '__none__')}
            onValueChange={(value) => setOption('layoutId', String(value))}
          >
            {recordOptions(project.layouts, 'No layout')}
          </Select>
        </div>
      </div>
    ),
    buildPayload: ({ draft }) => {
      const data = defaultSceneData(draft.basics.label);
      const assetId = selected(draft.options.backgroundAssetId);
      const materialId = selected(draft.options.materialId);
      const layoutId = selected(draft.options.layoutId);
      if (data.stage.kind === 'blank') {
        if (assetId) data.stage.background.asset = ref('assets', assetId);
        if (materialId) data.stage.background.material = ref('materials', materialId);
        if (layoutId) data.stage.layout = ref('layouts', layoutId);
      }
      return { data };
    },
  },
  {
    collection: 'tests',
    category: 'testing',
    supportLevel: 'typed',
    summary: 'Playback test scenarios.',
    currentScope: 'Creates a semantic playback test for the project entrypoint.',
    ...visual('tests'),
    defaultOptions: () => ({}),
    buildPayload: ({ draft }) => ({ data: defaultTestData(draft.basics.label) }),
  },
];
