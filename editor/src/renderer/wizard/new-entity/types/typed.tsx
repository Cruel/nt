import { Label } from '@/components/ui/label';
import { Select, SelectItem } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { defaultCharacterData } from '../../../../shared/project-schema/authoring-characters';
import { defaultDialogueData } from '../../../../shared/project-schema/authoring-dialogues';
import { defaultLayoutData, layoutKindValues, type LayoutKind } from '../../../../shared/project-schema/authoring-layouts';
import { defaultMaterialData, materialPreviewBackgroundValues, materialPreviewGeometryValues } from '../../../../shared/project-schema/authoring-materials';
import { defaultRoomData, roomBackgroundFitValues } from '../../../../shared/project-schema/authoring-rooms';
import { defaultSceneData } from '../../../../shared/project-schema/authoring-scenes';
import { defaultShaderData, shaderRoleValues } from '../../../../shared/project-schema/authoring-shaders';
import { defaultTestData, testEntrypointCollectionValues } from '../../../../shared/project-schema/authoring-tests';
import { defaultVariableData, variableTypeValues, type VariableType } from '../../../../shared/project-schema/authoring-variables';
import { visualForCollection } from '../../../workspace/collection-visuals';
import type { NewEntityWizardTypeDefinition } from './common';
import { ref, selected } from './common';

function visual(collection: NewEntityWizardTypeDefinition['collection']) {
  const base = visualForCollection(collection);
  return { icon: base.icon, iconClassName: base.colorClassName };
}

function recordOptions<T extends string>(records: Record<string, { label?: string }>, noneLabel: string, mapValue: (id: string) => T = (id) => id as T) {
  return (
    <>
      <SelectItem value="__none__">{noneLabel}</SelectItem>
      {Object.entries(records).map(([id, record]) => <SelectItem key={id} value={mapValue(id)}>{record.label || id} ({id})</SelectItem>)}
    </>
  );
}

export const typedWizardDefinitions: NewEntityWizardTypeDefinition[] = [
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
        <Select value={String(draft.options.variableType ?? 'boolean')} onValueChange={(value) => setOption('variableType', String(value))}>
          {variableTypeValues.map((type) => <SelectItem key={type} value={type}>{type}</SelectItem>)}
        </Select>
      </div>
    ),
    buildPayload: ({ draft }) => ({ data: defaultVariableData((draft.options.variableType || 'boolean') as VariableType) }),
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
        <Select value={String(draft.options.role ?? 'engine-2d')} onValueChange={(value) => setOption('role', String(value))}>
          {shaderRoleValues.map((role) => <SelectItem key={role} value={role}>{role}</SelectItem>)}
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
    defaultOptions: () => ({ shaderId: '__none__', previewGeometry: 'quad', previewBackground: 'checker' }),
    renderOptions: ({ project, draft, setOption }) => (
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1"><Label>Shader</Label><Select value={String(draft.options.shaderId ?? '__none__')} onValueChange={(value) => setOption('shaderId', String(value))}>{recordOptions(project.shaders, 'No shader')}</Select></div>
        <div className="space-y-1"><Label>Preview</Label><Select value={String(draft.options.previewGeometry ?? 'quad')} onValueChange={(value) => setOption('previewGeometry', String(value))}>{materialPreviewGeometryValues.map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}</Select></div>
        <div className="space-y-1"><Label>Background</Label><Select value={String(draft.options.previewBackground ?? 'checker')} onValueChange={(value) => setOption('previewBackground', String(value))}>{materialPreviewBackgroundValues.map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}</Select></div>
      </div>
    ),
    buildPayload: ({ draft }) => {
      const shaderId = selected(draft.options.shaderId);
      const data = defaultMaterialData(draft.basics.label, shaderId ?? undefined);
      data.preview.geometry = String(draft.options.previewGeometry ?? 'quad') as typeof data.preview.geometry;
      data.preview.background = String(draft.options.previewBackground ?? 'checker') as typeof data.preview.background;
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
      <div className="space-y-1"><Label>Layout kind</Label><Select value={String(draft.options.layoutKind ?? 'fragment')} onValueChange={(value) => setOption('layoutKind', String(value))}>{layoutKindValues.map((kind) => <SelectItem key={kind} value={kind}>{kind}</SelectItem>)}</Select></div>
    ),
    buildPayload: ({ draft }) => ({ data: defaultLayoutData(draft.basics.label, (draft.options.layoutKind || 'fragment') as LayoutKind) }),
  },
  {
    collection: 'characters',
    category: 'story',
    supportLevel: 'typed',
    summary: 'Character presentation metadata, dialogue naming, poses, and expressions.',
    currentScope: 'Creates a character with default pose/expression and optional sprite/material refs.',
    ...visual('characters'),
    defaultOptions: () => ({ spriteId: '__none__', materialId: '__none__' }),
    renderOptions: ({ project, draft, setOption }) => (
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1"><Label>Default sprite</Label><Select value={String(draft.options.spriteId ?? '__none__')} onValueChange={(value) => setOption('spriteId', String(value))}>{recordOptions(Object.fromEntries(Object.entries(project.assets).filter(([, record]) => (record.data as { kind?: string }).kind === 'image')), 'No sprite')}</Select></div>
        <div className="space-y-1"><Label>Material</Label><Select value={String(draft.options.materialId ?? '__none__')} onValueChange={(value) => setOption('materialId', String(value))}>{recordOptions(project.materials, 'No material')}</Select></div>
      </div>
    ),
    buildPayload: ({ draft }) => {
      const data = defaultCharacterData(draft.basics.label);
      const spriteId = selected(draft.options.spriteId);
      const materialId = selected(draft.options.materialId);
      if (spriteId) data.poses[0]!.sprite = ref('assets', spriteId);
      if (materialId) data.poses[0]!.material = ref('materials', materialId);
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
    defaultOptions: () => ({ backgroundAssetId: '__none__', materialId: '__none__', fit: 'cover', description: '', setEntrypoint: false }),
    renderOptions: ({ project, draft, setOption }) => (
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1"><Label>Background image</Label><Select value={String(draft.options.backgroundAssetId ?? '__none__')} onValueChange={(value) => setOption('backgroundAssetId', String(value))}>{recordOptions(Object.fromEntries(Object.entries(project.assets).filter(([, record]) => (record.data as { kind?: string }).kind === 'image')), 'No image')}</Select></div>
        <div className="space-y-1"><Label>Material</Label><Select value={String(draft.options.materialId ?? '__none__')} onValueChange={(value) => setOption('materialId', String(value))}>{recordOptions(project.materials, 'No material')}</Select></div>
        <div className="space-y-1"><Label>Fit</Label><Select value={String(draft.options.fit ?? 'cover')} onValueChange={(value) => setOption('fit', String(value))}>{roomBackgroundFitValues.map((fit) => <SelectItem key={fit} value={fit}>{fit}</SelectItem>)}</Select></div>
        <label className="flex items-end gap-2 text-sm"><input type="checkbox" checked={Boolean(draft.options.setEntrypoint)} onChange={(event) => setOption('setEntrypoint', event.currentTarget.checked)} />Set as project entrypoint after creation</label>
        <div className="space-y-1 sm:col-span-2"><Label>Initial description</Label><Input value={String(draft.options.description ?? '')} onChange={(event) => setOption('description', event.currentTarget.value)} placeholder="Optional room description" /></div>
      </div>
    ),
    buildPayload: ({ draft }) => {
      const data = defaultRoomData(draft.basics.label);
      const assetId = selected(draft.options.backgroundAssetId);
      const materialId = selected(draft.options.materialId);
      if (assetId) data.background.asset = ref('assets', assetId);
      if (materialId) data.background.material = ref('materials', materialId);
      data.background.fit = String(draft.options.fit ?? 'cover') as typeof data.background.fit;
      data.description.source = String(draft.options.description ?? '');
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
        <div className="space-y-1"><Label>Default speaker</Label><Select value={String(draft.options.speakerId ?? '__none__')} onValueChange={(value) => setOption('speakerId', String(value))}>{recordOptions(project.characters, 'No speaker')}</Select></div>
        <div className="space-y-1"><Label>First line</Label><Input value={String(draft.options.lineText ?? '')} onChange={(event) => setOption('lineText', event.currentTarget.value)} placeholder="Optional first line" /></div>
      </div>
    ),
    buildPayload: ({ draft }) => {
      const data = defaultDialogueData(draft.basics.label);
      const speakerId = selected(draft.options.speakerId);
      if (speakerId) {
        data.defaultSpeaker = ref('characters', speakerId);
        data.blocks[0]!.defaultSpeaker = ref('characters', speakerId);
        data.blocks[0]!.segments[0]!.speaker = ref('characters', speakerId);
      }
      data.blocks[0]!.segments[0]!.text.source = String(draft.options.lineText ?? '');
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
    defaultOptions: () => ({ backgroundAssetId: '__none__', materialId: '__none__', layoutId: '__none__' }),
    renderOptions: ({ project, draft, setOption }) => (
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1"><Label>Background</Label><Select value={String(draft.options.backgroundAssetId ?? '__none__')} onValueChange={(value) => setOption('backgroundAssetId', String(value))}>{recordOptions(Object.fromEntries(Object.entries(project.assets).filter(([, record]) => (record.data as { kind?: string }).kind === 'image')), 'No image')}</Select></div>
        <div className="space-y-1"><Label>Material</Label><Select value={String(draft.options.materialId ?? '__none__')} onValueChange={(value) => setOption('materialId', String(value))}>{recordOptions(project.materials, 'No material')}</Select></div>
        <div className="space-y-1"><Label>Layout</Label><Select value={String(draft.options.layoutId ?? '__none__')} onValueChange={(value) => setOption('layoutId', String(value))}>{recordOptions(project.layouts, 'No layout')}</Select></div>
      </div>
    ),
    buildPayload: ({ draft }) => {
      const data = defaultSceneData(draft.basics.label);
      const assetId = selected(draft.options.backgroundAssetId);
      const materialId = selected(draft.options.materialId);
      const layoutId = selected(draft.options.layoutId);
      if (assetId) data.defaults.background.asset = ref('assets', assetId);
      if (materialId) data.defaults.background.material = ref('materials', materialId);
      if (layoutId) data.defaults.layout = ref('layouts', layoutId);
      return { data };
    },
  },
  {
    collection: 'tests',
    category: 'testing',
    supportLevel: 'typed',
    summary: 'Authoring-side playback test scenarios.',
    currentScope: 'Creates a test with optional scene, room, or dialogue entrypoint.',
    ...visual('tests'),
    defaultOptions: () => ({ entrypoint: '__none__' }),
    renderOptions: ({ project, draft, setOption }) => (
      <div className="space-y-1">
        <Label>Entrypoint</Label>
        <Select value={String(draft.options.entrypoint ?? '__none__')} onValueChange={(value) => setOption('entrypoint', String(value))}>
          <SelectItem value="__none__">No entrypoint</SelectItem>
          {testEntrypointCollectionValues.flatMap((collection) => Object.entries(project[collection]).map(([id, record]) => (
            <SelectItem key={`${collection}:${id}`} value={`${collection}:${id}`}>{record.label || id} ({collection}/{id})</SelectItem>
          )))}
        </Select>
      </div>
    ),
    buildPayload: ({ draft }) => {
      const data = defaultTestData(draft.basics.label);
      const entrypoint = selected(draft.options.entrypoint);
      if (entrypoint) {
        const [collection, id] = entrypoint.split(':') as ['scenes' | 'rooms' | 'dialogues', string];
        if (collection === 'scenes') data.entrypoint = ref('scenes', id);
        else if (collection === 'rooms') data.entrypoint = ref('rooms', id);
        else data.entrypoint = ref('dialogues', id);
      }
      return { data };
    },
  },
];
