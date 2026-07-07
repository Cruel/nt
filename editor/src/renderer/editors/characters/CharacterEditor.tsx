import { useMemo, useRef } from 'react';
import { EnginePreview } from '@/components/engine-preview';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectItem } from '@/components/ui/select';
import { useCommandStore } from '@/commands/command-store';
import { useProjectStore } from '@/project/project-store';
import { parseAssetData } from '../../../shared/project-schema/authoring-assets';
import {
  characterAssetRef,
  characterMaterialRef,
  characterPreviewBackgroundValues,
  defaultCharacterData,
  parseCharacterData,
  validateCharacterData,
  type CharacterData,
  type CharacterExpressionData,
  type CharacterPoseData,
} from '../../../shared/project-schema/authoring-characters';
import { isAuthoringProject } from '../../../shared/project-schema/authoring-project';
import { buildCharacterPreviewDocumentData, characterPreviewRevision } from '../../../shared/project-schema/character-project';
import type { WorkbenchEditorProps } from '@/workbench/editor-registry';
import {
  captureScrollViewState,
  restoreScrollViewState,
  useWorkbenchEditorTabState,
  type ScrollViewState,
  type WorkbenchTabStatePayload,
} from '@/workbench/workbench-tab-state';

const CHARACTER_EDITOR_TAB_STATE_SCHEMA = 'noveltea.editor.tab-state.character';

interface CharacterEditorTabStatePayload {
  scroll?: ScrollViewState;
}

type CharacterEditorTabState = WorkbenchTabStatePayload & {
  schema: typeof CHARACTER_EDITOR_TAB_STATE_SCHEMA;
  payload?: CharacterEditorTabStatePayload;
};

function isScrollViewState(value: unknown): value is ScrollViewState {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && typeof (value as ScrollViewState).scrollTop === 'number'
    && typeof (value as ScrollViewState).scrollLeft === 'number';
}

function parseCharacterEditorTabState(value: WorkbenchTabStatePayload): CharacterEditorTabStatePayload | null {
  if (value.schema !== CHARACTER_EDITOR_TAB_STATE_SCHEMA || typeof value.payload !== 'object' || value.payload === null || Array.isArray(value.payload)) return null;
  const payload = value.payload as Record<string, unknown>;
  return {
    scroll: isScrollViewState(payload.scroll) ? payload.scroll : undefined,
  };
}

function commitCharacter(characterId: string, next: CharacterData, label: string) {
  return useCommandStore.getState().executeCommand({
    type: 'character.replaceData',
    label,
    payload: { characterId, data: next },
  });
}

function nextUniqueId(existing: Iterable<string>, base: string) {
  const used = new Set(existing);
  if (!used.has(base)) return base;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base}-${index}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

function toNumber(value: string, fallback: number) {
  const next = Number.parseFloat(value);
  return Number.isFinite(next) ? next : fallback;
}

function refValue(ref: { $ref: { id: string } } | null | undefined) {
  return ref?.$ref.id ?? '__none__';
}

function poseForPreview(data: CharacterData) {
  return data.poses.find((pose) => pose.id === data.preview.poseId)
    ?? data.poses.find((pose) => pose.id === data.defaults.poseId)
    ?? data.poses[0]
    ?? null;
}

function expressionForPreview(data: CharacterData) {
  return data.expressions.find((expression) => expression.id === data.preview.expressionId)
    ?? data.expressions.find((expression) => expression.id === data.defaults.expressionId)
    ?? data.expressions[0]
    ?? null;
}

export function CharacterEditor({ tab }: WorkbenchEditorProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const projectDocument = useProjectStore((state) => state.document);
  const characterId = tab.resource?.entityId;
  const project = isAuthoringProject(projectDocument) ? projectDocument : null;
  const record = characterId && project ? project.characters[characterId] : null;
  const parsedData = parseCharacterData(record?.data);
  const data = parsedData ?? defaultCharacterData(record?.label ?? characterId ?? 'Character');
  const diagnostics = useMemo(() => project && record && characterId ? validateCharacterData(project, characterId, record) : [], [project, record, characterId]);
  const imageAssets = project ? Object.entries(project.assets)
    .filter(([, asset]) => parseAssetData(asset.data)?.kind === 'image')
    .map(([id, asset]) => ({ id, label: asset.label })) : [];
  const materials = project ? Object.entries(project.materials).map(([id, material]) => ({ id, label: material.label })) : [];

  useWorkbenchEditorTabState<CharacterEditorTabState>(tab.id, useMemo(() => ({
    captureTabState: () => ({
      schema: CHARACTER_EDITOR_TAB_STATE_SCHEMA,
      schemaVersion: 1,
      payload: {
        scroll: captureScrollViewState(scrollRef.current),
      },
    }),
    restoreTabState: (state: CharacterEditorTabState) => {
      const parsed = parseCharacterEditorTabState(state);
      if (!parsed) return;
      window.requestAnimationFrame(() => restoreScrollViewState(scrollRef.current, parsed.scroll));
    },
  }), []));

  if (!characterId || !record || !project) return <div className="p-4 text-sm text-muted-foreground">Character record not found.</div>;

  const activeCharacterId = characterId;
  const activeRecord = record;
  const activeProject = project;
  const revision = characterPreviewRevision(activeProject, activeCharacterId);
  const previewDocument = {
    kind: 'character-preview' as const,
    recordId: activeCharacterId,
    revision,
    data: buildCharacterPreviewDocumentData(activeProject, activeCharacterId),
  };
  const previewPose = poseForPreview(data);
  const previewExpression = expressionForPreview(data);
  const resolvedSprite = previewExpression?.sprite ?? previewPose?.sprite ?? null;
  const resolvedMaterial = previewExpression?.material ?? previewPose?.material ?? null;

  function commit(next: CharacterData, label = 'Update character') {
    commitCharacter(activeCharacterId, next, label);
  }

  function patchDialogue(patch: Partial<CharacterData['dialogue']>) {
    commit({ ...data, dialogue: { ...data.dialogue, ...patch } }, 'Update character dialogue style');
  }

  function patchDefaults(patch: Partial<CharacterData['defaults']>) {
    commit({ ...data, defaults: { ...data.defaults, ...patch } }, 'Update character defaults');
  }

  function patchPreview(patch: Partial<CharacterData['preview']>) {
    commit({ ...data, preview: { ...data.preview, ...patch } }, 'Update character preview');
  }

  function replacePose(poseId: string, patch: Partial<CharacterPoseData>) {
    commit({
      ...data,
      poses: data.poses.map((pose) => pose.id === poseId ? { ...pose, ...patch } : pose),
    }, 'Update character pose');
  }

  function replaceExpression(expressionId: string, patch: Partial<CharacterExpressionData>) {
    commit({
      ...data,
      expressions: data.expressions.map((expression) => expression.id === expressionId ? { ...expression, ...patch } : expression),
    }, 'Update character expression');
  }

  function addPose() {
    const id = nextUniqueId(data.poses.map((pose) => pose.id), 'pose');
    commit({
      ...data,
      poses: [...data.poses, { id, label: 'Pose', sprite: null, material: null, offset: { x: 0, y: 0 }, scale: 1, anchor: { x: 0.5, y: 1 } }],
    }, 'Add character pose');
  }

  function deletePose(poseId: string) {
    const remaining = data.poses.filter((pose) => pose.id !== poseId);
    if (remaining.length === 0) return;
    const fallback = remaining[0]!.id;
    commit({
      ...data,
      poses: remaining,
      defaults: { ...data.defaults, poseId: data.defaults.poseId === poseId ? fallback : data.defaults.poseId },
      preview: { ...data.preview, poseId: data.preview.poseId === poseId ? fallback : data.preview.poseId },
      expressions: data.expressions.map((expression) => expression.poseId === poseId ? { ...expression, poseId: null } : expression),
    }, 'Delete character pose');
  }

  function addExpression() {
    const id = nextUniqueId(data.expressions.map((expression) => expression.id), 'expression');
    commit({
      ...data,
      expressions: [...data.expressions, { id, label: 'Expression', poseId: null, sprite: null, material: null }],
    }, 'Add character expression');
  }

  function deleteExpression(expressionId: string) {
    const remaining = data.expressions.filter((expression) => expression.id !== expressionId);
    if (remaining.length === 0) return;
    const fallback = remaining[0]!.id;
    commit({
      ...data,
      expressions: remaining,
      defaults: { ...data.defaults, expressionId: data.defaults.expressionId === expressionId ? fallback : data.defaults.expressionId },
      preview: { ...data.preview, expressionId: data.preview.expressionId === expressionId ? fallback : data.preview.expressionId },
    }, 'Delete character expression');
  }

  return (
    <div ref={scrollRef} className="flex h-full min-h-0 flex-col overflow-auto bg-background p-4" data-character-editor-scroll>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-lg font-semibold">{activeRecord.label}</h2>
            <Badge variant="outline">{activeCharacterId}</Badge>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">Character dialogue style, poses, expressions, sprites, material overrides, and live preview.</p>
        </div>
      </div>

      {!parsedData ? <div className="mt-3 rounded border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">Character data was invalid; showing editable defaults until you apply a change.</div> : null}

      <div className="mt-4 grid gap-4 xl:grid-cols-[1fr_320px]">
        <div className="space-y-4">
          <section className="grid gap-3 rounded border p-3 md:grid-cols-2">
            <div className="space-y-1">
              <Label>Display name</Label>
              <Input value={data.displayName} onChange={(event) => commit({ ...data, displayName: event.currentTarget.value }, 'Update character display name')} />
            </div>
            <div className="space-y-1">
              <Label>Dialogue name</Label>
              <Input value={data.dialogue.name} onChange={(event) => patchDialogue({ name: event.currentTarget.value })} />
            </div>
            <div className="space-y-1">
              <Label>Name color</Label>
              <Input value={data.dialogue.nameColor ?? ''} onChange={(event) => patchDialogue({ nameColor: event.currentTarget.value.trim() || null })} placeholder="#f8fafc or empty" />
            </div>
            <div className="space-y-1">
              <Label>Text color</Label>
              <Input value={data.dialogue.textColor ?? ''} onChange={(event) => patchDialogue({ textColor: event.currentTarget.value.trim() || null })} placeholder="#f8fafc or empty" />
            </div>
            <div className="space-y-1 md:col-span-2">
              <Label>Style class</Label>
              <Input value={data.dialogue.styleClass} onChange={(event) => patchDialogue({ styleClass: event.currentTarget.value })} placeholder="dialogue-speaker" />
            </div>
          </section>

          <section className="grid gap-3 rounded border p-3 md:grid-cols-2">
            <div className="space-y-1">
              <Label>Default pose</Label>
              <Select value={data.defaults.poseId} onValueChange={(value) => patchDefaults({ poseId: String(value) })}>
                {data.poses.map((pose) => <SelectItem key={pose.id} value={pose.id}>{pose.label} ({pose.id})</SelectItem>)}
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Default expression</Label>
              <Select value={data.defaults.expressionId} onValueChange={(value) => patchDefaults({ expressionId: String(value) })}>
                {data.expressions.map((expression) => <SelectItem key={expression.id} value={expression.id}>{expression.label} ({expression.id})</SelectItem>)}
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Preview pose</Label>
              <Select value={data.preview.poseId} onValueChange={(value) => patchPreview({ poseId: String(value) })}>
                {data.poses.map((pose) => <SelectItem key={pose.id} value={pose.id}>{pose.label} ({pose.id})</SelectItem>)}
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Preview expression</Label>
              <Select value={data.preview.expressionId} onValueChange={(value) => patchPreview({ expressionId: String(value) })}>
                {data.expressions.map((expression) => <SelectItem key={expression.id} value={expression.id}>{expression.label} ({expression.id})</SelectItem>)}
              </Select>
            </div>
          </section>

          <section className="space-y-3 rounded border p-3">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-medium">Poses</h3>
              <Button size="sm" variant="outline" onClick={addPose}>Add Pose</Button>
            </div>
            {data.poses.map((pose) => (
              <div key={pose.id} className="grid gap-2 rounded border p-2 md:grid-cols-2 xl:grid-cols-4">
                <div className="space-y-1">
                  <Label>ID</Label>
                  <Input value={pose.id} onChange={(event) => replacePose(pose.id, { id: event.currentTarget.value })} />
                </div>
                <div className="space-y-1">
                  <Label>Label</Label>
                  <Input value={pose.label} onChange={(event) => replacePose(pose.id, { label: event.currentTarget.value })} />
                </div>
                <div className="space-y-1">
                  <Label>Sprite</Label>
                  <Select value={refValue(pose.sprite)} onValueChange={(value) => replacePose(pose.id, { sprite: value === '__none__' ? null : characterAssetRef(String(value)) })}>
                    <SelectItem value="__none__">No sprite</SelectItem>
                    {imageAssets.map((asset) => <SelectItem key={asset.id} value={asset.id}>{asset.label} ({asset.id})</SelectItem>)}
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label>Material</Label>
                  <Select value={refValue(pose.material)} onValueChange={(value) => replacePose(pose.id, { material: value === '__none__' ? null : characterMaterialRef(String(value)) })}>
                    <SelectItem value="__none__">No material override</SelectItem>
                    {materials.map((material) => <SelectItem key={material.id} value={material.id}>{material.label} ({material.id})</SelectItem>)}
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label>Offset X</Label>
                  <Input value={String(pose.offset.x)} onChange={(event) => replacePose(pose.id, { offset: { ...pose.offset, x: toNumber(event.currentTarget.value, pose.offset.x) } })} />
                </div>
                <div className="space-y-1">
                  <Label>Offset Y</Label>
                  <Input value={String(pose.offset.y)} onChange={(event) => replacePose(pose.id, { offset: { ...pose.offset, y: toNumber(event.currentTarget.value, pose.offset.y) } })} />
                </div>
                <div className="space-y-1">
                  <Label>Scale</Label>
                  <Input value={String(pose.scale)} onChange={(event) => replacePose(pose.id, { scale: Math.max(0.01, toNumber(event.currentTarget.value, pose.scale)) })} />
                </div>
                <div className="flex items-end">
                  <Button size="sm" variant="outline" onClick={() => deletePose(pose.id)} disabled={data.poses.length <= 1}>Delete</Button>
                </div>
              </div>
            ))}
          </section>

          <section className="space-y-3 rounded border p-3">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-medium">Expressions</h3>
              <Button size="sm" variant="outline" onClick={addExpression}>Add Expression</Button>
            </div>
            {data.expressions.map((expression) => (
              <div key={expression.id} className="grid gap-2 rounded border p-2 md:grid-cols-2 xl:grid-cols-5">
                <div className="space-y-1">
                  <Label>ID</Label>
                  <Input value={expression.id} onChange={(event) => replaceExpression(expression.id, { id: event.currentTarget.value })} />
                </div>
                <div className="space-y-1">
                  <Label>Label</Label>
                  <Input value={expression.label} onChange={(event) => replaceExpression(expression.id, { label: event.currentTarget.value })} />
                </div>
                <div className="space-y-1">
                  <Label>Pose restriction</Label>
                  <Select value={expression.poseId ?? '__all__'} onValueChange={(value) => replaceExpression(expression.id, { poseId: value === '__all__' ? null : String(value) })}>
                    <SelectItem value="__all__">All poses</SelectItem>
                    {data.poses.map((pose) => <SelectItem key={pose.id} value={pose.id}>{pose.label} ({pose.id})</SelectItem>)}
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label>Sprite</Label>
                  <Select value={refValue(expression.sprite)} onValueChange={(value) => replaceExpression(expression.id, { sprite: value === '__none__' ? null : characterAssetRef(String(value)) })}>
                    <SelectItem value="__none__">Use pose sprite</SelectItem>
                    {imageAssets.map((asset) => <SelectItem key={asset.id} value={asset.id}>{asset.label} ({asset.id})</SelectItem>)}
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label>Material</Label>
                  <Select value={refValue(expression.material)} onValueChange={(value) => replaceExpression(expression.id, { material: value === '__none__' ? null : characterMaterialRef(String(value)) })}>
                    <SelectItem value="__none__">Use pose material</SelectItem>
                    {materials.map((material) => <SelectItem key={material.id} value={material.id}>{material.label} ({material.id})</SelectItem>)}
                  </Select>
                </div>
                <div className="flex items-end xl:col-span-5">
                  <Button size="sm" variant="outline" onClick={() => deleteExpression(expression.id)} disabled={data.expressions.length <= 1}>Delete</Button>
                </div>
              </div>
            ))}
          </section>
        </div>

        <aside className="rounded border bg-muted/20 p-4">
          <div className="h-72 overflow-hidden rounded border bg-background">
            <EnginePreview chrome="minimal" previewMode="character" previewDocument={previewDocument} />
          </div>
          <div className="mt-3 space-y-2 text-xs text-muted-foreground">
            <div><span className="font-medium text-foreground">Pose:</span> {previewPose?.label ?? 'None'}</div>
            <div><span className="font-medium text-foreground">Expression:</span> {previewExpression?.label ?? 'None'}</div>
            <div><span className="font-medium text-foreground">Sprite:</span> {resolvedSprite?.$ref.id ?? 'None'}</div>
            <div><span className="font-medium text-foreground">Material:</span> {resolvedMaterial?.$ref.id ?? 'None'}</div>
          </div>
          <div className="mt-4 space-y-1">
            <Label>Background</Label>
            <Select value={data.preview.background} onValueChange={(value) => patchPreview({ background: value as CharacterData['preview']['background'] })}>
              {characterPreviewBackgroundValues.map((background) => <SelectItem key={background} value={background}>{background}</SelectItem>)}
            </Select>
          </div>
          {diagnostics.length > 0 ? (
            <div className="mt-4 rounded border p-2 text-xs text-muted-foreground">
              <div className="font-medium text-foreground">Diagnostics</div>
              <div className="mt-1 space-y-1">
                {diagnostics.slice(0, 4).map((item) => <div key={`${item.path}:${item.message}`}>{item.severity}: {item.message}</div>)}
              </div>
            </div>
          ) : null}
          <div className="mt-3 overflow-hidden font-mono text-[10px] text-muted-foreground">revision {revision.slice(0, 80)}</div>
        </aside>
      </div>
    </div>
  );
}
