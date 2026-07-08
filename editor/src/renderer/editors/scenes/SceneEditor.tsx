import { useMemo, useRef } from 'react';
import { SourceEditor } from '@/components/source/SourceEditor';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectItem } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useCommandStore } from '@/commands/command-store';
import { DerivedPreviewPane } from '@/preview/DerivedPreviewPane';
import { useProjectStore } from '@/project/project-store';
import type { WorkbenchEditorProps } from '@/workbench/editor-registry';
import {
  defaultSceneData,
  defaultSceneStep,
  parseSceneData,
  sceneAssetRef,
  sceneAudioActionValues,
  sceneAudioChannelValues,
  sceneBackgroundFitValues,
  sceneBackgroundTransitionValues,
  sceneCharacterActionValues,
  sceneCharacterPositionValues,
  sceneCharacterRef,
  sceneCharacterTransitionValues,
  sceneDialogueModeValues,
  sceneDialogueRef,
  sceneLayoutActionValues,
  sceneLayoutRef,
  sceneLayoutSlotValues,
  sceneMaterialRef,
  scenePreviewBackgroundValues,
  scenePreviewPlaybackValues,
  sceneStepTypeValues,
  sceneTransitionKindValues,
  sceneVariableComparisonValues,
  sceneVariableOperationValues,
  sceneVariableRef,
  sceneWaitModeValues,
  validateSceneData,
  type SceneData,
  type SceneStepData,
  type SceneStepType,
  type SceneBranchChoiceData,
} from '../../../shared/project-schema/authoring-scenes';
import { parseCharacterData } from '../../../shared/project-schema/authoring-characters';
import { parseDialogueData } from '../../../shared/project-schema/authoring-dialogues';
import { isAuthoringProject } from '../../../shared/project-schema/authoring-project';
import { buildScenePreviewDocumentData, scenePreviewRevision } from '../../../shared/project-schema/scene-project';
import {
  captureScrollViewState,
  captureSourceEditorViewStates,
  isScrollViewState,
  parseSourceEditorViewStates,
  restoreScrollViewState,
  restoreSourceEditorViewStates,
  useSourceEditorViewStateRefs,
  useWorkbenchEditorTabState,
  type ScrollViewState,
  type SourceEditorViewStates,
  type WorkbenchTabStatePayload,
} from '@/workbench/workbench-tab-state';

const SCENE_EDITOR_TAB_STATE_SCHEMA = 'noveltea.editor.tab-state.scene';

interface SceneEditorTabStatePayload {
  scroll?: ScrollViewState;
  sourceViewStates?: SourceEditorViewStates;
}

type SceneEditorTabState = WorkbenchTabStatePayload & {
  schema: typeof SCENE_EDITOR_TAB_STATE_SCHEMA;
  payload?: SceneEditorTabStatePayload;
};

function parseSceneEditorTabState(value: WorkbenchTabStatePayload): SceneEditorTabStatePayload | null {
  if (value.schema !== SCENE_EDITOR_TAB_STATE_SCHEMA || typeof value.payload !== 'object' || value.payload === null || Array.isArray(value.payload)) return null;
  const payload = value.payload as Record<string, unknown>;
  return {
    scroll: isScrollViewState(payload.scroll) ? payload.scroll : undefined,
    sourceViewStates: parseSourceEditorViewStates(payload.sourceViewStates),
  };
}

function commitScene(sceneId: string, next: SceneData, label: string) {
  return useCommandStore.getState().executeCommand({ type: 'scene.replaceData', label, payload: { sceneId, data: next } });
}

function titleCase(value: string) {
  return value.split('-').map((part) => part[0]?.toUpperCase() + part.slice(1)).join(' ');
}

function nextUniqueId(existing: Iterable<string>, base: string) {
  const normalized = base.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'step';
  const used = new Set(existing);
  if (!used.has(normalized)) return normalized;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${normalized}-${index}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${normalized}-${Date.now()}`;
}

function refValue(ref: { $ref: { id: string } } | null | undefined) {
  return ref?.$ref.id ?? '__none__';
}

function selectedStep(data: SceneData) {
  return data.steps.find((step) => step.id === data.preview.selectedStepId) ?? data.steps[0] ?? null;
}

function replaceRefValue<Ref>(value: string, makeRef: (id: string) => Ref): Ref | null {
  return value === '__none__' ? null : makeRef(value);
}

export function SceneEditor({ tab }: WorkbenchEditorProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sourceEditors = useSourceEditorViewStateRefs<'condition' | 'script' | 'branchChoiceCondition' | 'comment'>();
  const projectDocument = useProjectStore((state) => state.document);
  const sceneId = tab.resource?.entityId;
  const project = isAuthoringProject(projectDocument) ? projectDocument : null;
  const record = sceneId && project ? project.scenes[sceneId] : null;
  const parsedData = parseSceneData(record?.data);
  const data = parsedData ?? defaultSceneData(record?.label ?? sceneId ?? 'Scene');
  const diagnostics = useMemo(() => project && record && sceneId ? validateSceneData(project, sceneId, record) : [], [project, record, sceneId]);

  useWorkbenchEditorTabState<SceneEditorTabState>(tab.id, useMemo(() => ({
    captureTabState: () => ({
      schema: SCENE_EDITOR_TAB_STATE_SCHEMA,
      schemaVersion: 1,
      payload: {
        scroll: captureScrollViewState(scrollRef.current),
        sourceViewStates: captureSourceEditorViewStates(sourceEditors.refs.current),
      },
    }),
    restoreTabState: (state: SceneEditorTabState) => {
      const parsed = parseSceneEditorTabState(state);
      if (!parsed) return;
      window.requestAnimationFrame(() => {
        restoreScrollViewState(scrollRef.current, parsed.scroll);
        restoreSourceEditorViewStates(sourceEditors.refs.current, parsed.sourceViewStates);
      });
    },
  }), [sourceEditors.refs]));

  if (!sceneId || !record || !project) return <div className="p-4 text-sm text-muted-foreground">Scene record not found.</div>;

  const activeSceneId = sceneId;
  const activeProject = project;
  const activeRecord = record;
  const activeStep = selectedStep(data);
  const activeStepIndex = activeStep ? data.steps.findIndex((step) => step.id === activeStep.id) : -1;
  const previewDocument = {
    kind: 'scene-preview' as const,
    recordId: activeSceneId,
    revision: scenePreviewRevision(activeProject, activeSceneId),
    data: buildScenePreviewDocumentData(activeProject, activeSceneId),
  };

  const assets = Object.entries(activeProject.assets).map(([id, asset]) => ({ id, label: asset.label }));
  const materials = Object.entries(activeProject.materials).map(([id, material]) => ({ id, label: material.label }));
  const characters = Object.entries(activeProject.characters).map(([id, character]) => ({ id, label: character.label, data: parseCharacterData(character.data) }));
  const dialogues = Object.entries(activeProject.dialogues).map(([id, dialogue]) => ({ id, label: dialogue.label, data: parseDialogueData(dialogue.data) }));
  const layouts = Object.entries(activeProject.layouts).map(([id, layout]) => ({ id, label: layout.label }));
  const variables = Object.entries(activeProject.variables).map(([id, variable]) => ({ id, label: variable.label }));

  function commit(next: SceneData, label = 'Update scene') {
    commitScene(activeSceneId, next, label);
  }

  function patchSettings(patch: Partial<SceneData['settings']>) {
    commit({ ...data, settings: { ...data.settings, ...patch } }, 'Update scene settings');
  }

  function patchDefaults(patch: Partial<SceneData['defaults']>) {
    commit({ ...data, defaults: { ...data.defaults, ...patch } }, 'Update scene defaults');
  }

  function patchPreview(patch: Partial<SceneData['preview']>) {
    commit({ ...data, preview: { ...data.preview, ...patch } }, 'Update scene preview');
  }

  function replaceStep(stepId: string, patch: Partial<SceneStepData>) {
    commit({ ...data, steps: data.steps.map((step) => step.id === stepId ? { ...step, ...patch } : step) }, 'Update scene step');
  }

  function replaceStepPayload<Key extends SceneStepType>(stepId: string, key: Key, patch: Partial<SceneStepData[Key]>) {
    commit({
      ...data,
      steps: data.steps.map((step) => step.id === stepId ? { ...step, [key]: { ...step[key], ...patch } } : step),
    }, 'Update scene step');
  }

  function addStep(type: SceneStepType) {
    const id = nextUniqueId(data.steps.map((step) => step.id), type);
    const step = { ...defaultSceneStep(type, titleCase(type)), id, label: titleCase(type) };
    const insertIndex = activeStepIndex >= 0 ? activeStepIndex + 1 : data.steps.length;
    const steps = [...data.steps];
    steps.splice(insertIndex, 0, step);
    commit({ ...data, steps, preview: { ...data.preview, selectedStepId: id } }, 'Add scene step');
  }

  function deleteStep(stepId: string) {
    if (data.steps.length <= 1) return;
    const index = data.steps.findIndex((step) => step.id === stepId);
    const steps = data.steps.filter((step) => step.id !== stepId);
    const fallback = steps[Math.max(0, Math.min(index, steps.length - 1))] ?? steps[0];
    commit({ ...data, steps, preview: { ...data.preview, selectedStepId: fallback?.id ?? null } }, 'Delete scene step');
  }

  function duplicateStep(step: SceneStepData) {
    const id = nextUniqueId(data.steps.map((item) => item.id), `${step.id}-copy`);
    const copy = { ...step, id, label: `${step.label} Copy` };
    const index = data.steps.findIndex((item) => item.id === step.id);
    const steps = [...data.steps];
    steps.splice(index + 1, 0, copy);
    commit({ ...data, steps, preview: { ...data.preview, selectedStepId: id } }, 'Duplicate scene step');
  }

  function moveStep(stepId: string, direction: -1 | 1) {
    const index = data.steps.findIndex((step) => step.id === stepId);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= data.steps.length) return;
    const steps = [...data.steps];
    const [step] = steps.splice(index, 1);
    steps.splice(nextIndex, 0, step!);
    commit({ ...data, steps }, 'Move scene step');
  }

  function addBranchChoice(step: SceneStepData) {
    const id = nextUniqueId(step.branch.choices.map((choice) => choice.id), 'choice');
    const choice: SceneBranchChoiceData = { id, label: 'Choice', targetStepId: data.steps[0]?.id ?? null, condition: { enabled: false, source: '' }, order: step.branch.choices.length };
    replaceStepPayload(step.id, 'branch', { choices: [...step.branch.choices, choice] });
  }

  function replaceBranchChoice(step: SceneStepData, choiceId: string, patch: Partial<SceneBranchChoiceData>) {
    replaceStepPayload(step.id, 'branch', { choices: step.branch.choices.map((choice) => choice.id === choiceId ? { ...choice, ...patch } : choice) });
  }

  function deleteBranchChoice(step: SceneStepData, choiceId: string) {
    replaceStepPayload(step.id, 'branch', { choices: step.branch.choices.filter((choice) => choice.id !== choiceId) });
  }

  const selectedCharacter = activeStep?.character.character ? characters.find((item) => item.id === activeStep.character.character?.$ref.id) : null;
  const selectedDialogue = activeStep?.dialogue.dialogue ? dialogues.find((item) => item.id === activeStep.dialogue.dialogue?.$ref.id) : null;

  return (
    <div ref={scrollRef} className="flex h-full min-h-0 flex-col overflow-auto bg-background p-4" data-scene-editor-scroll>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-lg font-semibold">{activeRecord.label}</h2>
            <Badge variant="outline">{activeSceneId}</Badge>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">Ordered VN orchestration steps with local inspector and deterministic authoring preview.</p>
        </div>
      </div>

      {!parsedData ? <div className="mt-3 rounded border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">Scene data was invalid; showing editable defaults until you apply a change.</div> : null}

      <div className="mt-4 grid gap-4 xl:grid-cols-[1fr_420px]">
        <div className="space-y-4">
          <section className="grid gap-3 rounded border p-3 md:grid-cols-2 xl:grid-cols-4">
            <div className="space-y-1">
              <Label>Display name</Label>
              <Input value={data.displayName} onChange={(event) => commit({ ...data, displayName: event.currentTarget.value }, 'Update scene display name')} />
            </div>
            <div className="space-y-1">
              <Label>Speed factor</Label>
              <Input value={String(data.settings.speedFactor)} onChange={(event) => patchSettings({ speedFactor: Number.parseFloat(event.currentTarget.value) || 1 })} />
            </div>
            <div className="flex items-center gap-2 pt-6">
              <Switch checked={data.settings.fullScreen} onCheckedChange={(checked) => patchSettings({ fullScreen: Boolean(checked) })} />
              <Label>Full screen</Label>
            </div>
            <div className="flex items-center gap-2 pt-6">
              <Switch checked={data.settings.canFastForward} onCheckedChange={(checked) => patchSettings({ canFastForward: Boolean(checked) })} />
              <Label>Fast-forward</Label>
            </div>
            <div className="space-y-1">
              <Label>Default background asset</Label>
              <Select value={refValue(data.defaults.background.asset)} onValueChange={(value) => patchDefaults({ background: { ...data.defaults.background, asset: replaceRefValue(String(value), sceneAssetRef) } })}>
                <SelectItem value="__none__">No asset</SelectItem>
                {assets.map((asset) => <SelectItem key={asset.id} value={asset.id}>{asset.label} ({asset.id})</SelectItem>)}
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Default background material</Label>
              <Select value={refValue(data.defaults.background.material)} onValueChange={(value) => patchDefaults({ background: { ...data.defaults.background, material: replaceRefValue(String(value), sceneMaterialRef) } })}>
                <SelectItem value="__none__">No material</SelectItem>
                {materials.map((material) => <SelectItem key={material.id} value={material.id}>{material.label} ({material.id})</SelectItem>)}
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Default background color</Label>
              <Input value={data.defaults.background.color ?? ''} onChange={(event) => patchDefaults({ background: { ...data.defaults.background, color: event.currentTarget.value || null } })} />
            </div>
            <div className="space-y-1">
              <Label>Default background fit</Label>
              <Select value={data.defaults.background.fit} onValueChange={(value) => patchDefaults({ background: { ...data.defaults.background, fit: value as SceneData['defaults']['background']['fit'] } })}>
                {sceneBackgroundFitValues.map((fit) => <SelectItem key={fit} value={fit}>{fit}</SelectItem>)}
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Default layout</Label>
              <Select value={refValue(data.defaults.layout)} onValueChange={(value) => patchDefaults({ layout: replaceRefValue(String(value), sceneLayoutRef) })}>
                <SelectItem value="__none__">No layout</SelectItem>
                {layouts.map((layout) => <SelectItem key={layout.id} value={layout.id}>{layout.label} ({layout.id})</SelectItem>)}
              </Select>
            </div>
          </section>

          <section className="space-y-3 rounded border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-medium">Scene steps</h3>
              <div className="flex flex-wrap gap-2">
                {sceneStepTypeValues.map((type) => <Button key={type} size="sm" variant="outline" onClick={() => addStep(type)}>{titleCase(type)}</Button>)}
              </div>
            </div>
            <div className="space-y-2">
              {data.steps.map((step, index) => (
                <button
                  key={step.id}
                  className={`w-full rounded border p-3 text-left text-sm ${step.id === activeStep?.id ? 'border-primary bg-primary/5' : 'bg-background'}`}
                  onClick={() => patchPreview({ selectedStepId: step.id })}
                >
                  <div className="flex items-center gap-2">
                    <Badge variant="outline">{index + 1}</Badge>
                    <span className="font-medium">{step.label}</span>
                    <span className="text-xs text-muted-foreground">{step.type}</span>
                    {!step.enabled ? <Badge variant="outline">disabled</Badge> : null}
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">{step.id}</div>
                </button>
              ))}
            </div>
          </section>
        </div>

        <aside className="space-y-4">
          <section className="space-y-3 rounded border p-3">
            <h3 className="text-sm font-medium">Preview</h3>
            <div className="h-72 overflow-hidden rounded border bg-background">
              <DerivedPreviewPane ownerTabId={tab.id} previewMode="scene" previewDocument={previewDocument} />
            </div>
            <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-1">
              <div className="space-y-1">
                <Label>Playback</Label>
                <Select value={data.preview.playback} onValueChange={(value) => patchPreview({ playback: value as SceneData['preview']['playback'] })}>
                  {scenePreviewPlaybackValues.map((playback) => <SelectItem key={playback} value={playback}>{playback}</SelectItem>)}
                </Select>
              </div>
              <div className="space-y-1">
                <Label>Background</Label>
                <Select value={data.preview.background} onValueChange={(value) => patchPreview({ background: value as SceneData['preview']['background'] })}>
                  {scenePreviewBackgroundValues.map((background) => <SelectItem key={background} value={background}>{background}</SelectItem>)}
                </Select>
              </div>
              <div className="flex items-center gap-2">
                <Switch checked={data.preview.showDisabledSteps} onCheckedChange={(checked) => patchPreview({ showDisabledSteps: Boolean(checked) })} />
                <Label>Show disabled steps</Label>
              </div>
            </div>
          </section>

          {activeStep ? (
            <section className="space-y-3 rounded border p-3">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-medium">Selected step</h3>
                <div className="flex gap-1">
                  <Button size="sm" variant="outline" onClick={() => moveStep(activeStep.id, -1)}>Up</Button>
                  <Button size="sm" variant="outline" onClick={() => moveStep(activeStep.id, 1)}>Down</Button>
                  <Button size="sm" variant="outline" onClick={() => duplicateStep(activeStep)}>Duplicate</Button>
                  <Button size="sm" variant="outline" onClick={() => deleteStep(activeStep.id)} disabled={data.steps.length <= 1}>Delete</Button>
                </div>
              </div>
              <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-1">
                <div className="space-y-1">
                  <Label>Label</Label>
                  <Input value={activeStep.label} onChange={(event) => replaceStep(activeStep.id, { label: event.currentTarget.value })} />
                </div>
                <div className="space-y-1">
                  <Label>Type</Label>
                  <Select value={activeStep.type} onValueChange={(value) => replaceStep(activeStep.id, { type: value as SceneStepType })}>
                    {sceneStepTypeValues.map((type) => <SelectItem key={type} value={type}>{titleCase(type)}</SelectItem>)}
                  </Select>
                </div>
                <div className="flex items-center gap-2">
                  <Switch checked={activeStep.enabled} onCheckedChange={(checked) => replaceStep(activeStep.id, { enabled: Boolean(checked) })} />
                  <Label>Enabled</Label>
                </div>
                <div className="flex items-center gap-2">
                  <Switch checked={activeStep.timing.waitForInput} onCheckedChange={(checked) => replaceStep(activeStep.id, { timing: { ...activeStep.timing, waitForInput: Boolean(checked) } })} />
                  <Label>Wait for input</Label>
                </div>
                <div className="flex items-center gap-2">
                  <Switch aria-label="Can skip" checked={activeStep.timing.canSkip} onCheckedChange={(checked) => replaceStep(activeStep.id, { timing: { ...activeStep.timing, canSkip: Boolean(checked) } })} />
                  <Label>Can skip</Label>
                </div>
                <div className="space-y-1">
                  <Label>Delay ms</Label>
                  <Input value={String(activeStep.timing.delayMs)} onChange={(event) => replaceStep(activeStep.id, { timing: { ...activeStep.timing, delayMs: Number.parseInt(event.currentTarget.value, 10) || 0 } })} />
                </div>
                <div className="space-y-1">
                  <Label>Duration ms</Label>
                  <Input value={String(activeStep.timing.durationMs)} onChange={(event) => replaceStep(activeStep.id, { timing: { ...activeStep.timing, durationMs: Number.parseInt(event.currentTarget.value, 10) || 0 } })} />
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Switch checked={activeStep.condition.enabled} onCheckedChange={(checked) => replaceStep(activeStep.id, { condition: { ...activeStep.condition, enabled: Boolean(checked) } })} />
                <Label>Condition</Label>
              </div>
              <SourceEditor ref={sourceEditors.refFor('condition')} className="h-24" language="lua" value={activeStep.condition.source} onChange={(source) => replaceStep(activeStep.id, { condition: { ...activeStep.condition, source } })} />
              <div className="grid gap-2 text-xs">
                <label className="flex items-center gap-2"><Switch checked={activeStep.autosave.before} onCheckedChange={(checked) => replaceStep(activeStep.id, { autosave: { ...activeStep.autosave, before: Boolean(checked) } })} /> Autosave before</label>
                <label className="flex items-center gap-2"><Switch checked={activeStep.autosave.after} onCheckedChange={(checked) => replaceStep(activeStep.id, { autosave: { ...activeStep.autosave, after: Boolean(checked) } })} /> Autosave after</label>
              </div>
            </section>
          ) : null}

          {activeStep?.type === 'background' ? (
            <section className="space-y-3 rounded border p-3">
              <h3 className="text-sm font-medium">Background</h3>
              <Select value={refValue(activeStep.background.asset)} onValueChange={(value) => replaceStepPayload(activeStep.id, 'background', { asset: replaceRefValue(String(value), sceneAssetRef) })}>
                <SelectItem value="__none__">No asset</SelectItem>
                {assets.map((asset) => <SelectItem key={asset.id} value={asset.id}>{asset.label} ({asset.id})</SelectItem>)}
              </Select>
              <Select value={refValue(activeStep.background.material)} onValueChange={(value) => replaceStepPayload(activeStep.id, 'background', { material: replaceRefValue(String(value), sceneMaterialRef) })}>
                <SelectItem value="__none__">No material</SelectItem>
                {materials.map((material) => <SelectItem key={material.id} value={material.id}>{material.label} ({material.id})</SelectItem>)}
              </Select>
              <Input value={activeStep.background.color ?? ''} placeholder="Color" onChange={(event) => replaceStepPayload(activeStep.id, 'background', { color: event.currentTarget.value || null })} />
              <Select value={activeStep.background.fit} onValueChange={(value) => replaceStepPayload(activeStep.id, 'background', { fit: value as SceneStepData['background']['fit'] })}>{sceneBackgroundFitValues.map((fit) => <SelectItem key={fit} value={fit}>{fit}</SelectItem>)}</Select>
              <Select value={activeStep.background.transition} onValueChange={(value) => replaceStepPayload(activeStep.id, 'background', { transition: value as SceneStepData['background']['transition'] })}>{sceneBackgroundTransitionValues.map((transition) => <SelectItem key={transition} value={transition}>{transition}</SelectItem>)}</Select>
            </section>
          ) : null}

          {activeStep?.type === 'character' ? (
            <section className="space-y-3 rounded border p-3">
              <h3 className="text-sm font-medium">Character</h3>
              <Select value={refValue(activeStep.character.character)} onValueChange={(value) => replaceStepPayload(activeStep.id, 'character', { character: replaceRefValue(String(value), sceneCharacterRef) })}>
                <SelectItem value="__none__">No character</SelectItem>
                {characters.map((character) => <SelectItem key={character.id} value={character.id}>{character.label} ({character.id})</SelectItem>)}
              </Select>
              <Select value={activeStep.character.action} onValueChange={(value) => replaceStepPayload(activeStep.id, 'character', { action: value as SceneStepData['character']['action'] })}>{sceneCharacterActionValues.map((action) => <SelectItem key={action} value={action}>{action}</SelectItem>)}</Select>
              <Select value={activeStep.character.poseId ?? '__none__'} onValueChange={(value) => replaceStepPayload(activeStep.id, 'character', { poseId: value === '__none__' ? null : String(value) })}>
                <SelectItem value="__none__">No pose</SelectItem>
                {(selectedCharacter?.data?.poses ?? []).map((pose) => <SelectItem key={pose.id} value={pose.id}>{pose.label} ({pose.id})</SelectItem>)}
              </Select>
              <Select value={activeStep.character.expressionId ?? '__none__'} onValueChange={(value) => replaceStepPayload(activeStep.id, 'character', { expressionId: value === '__none__' ? null : String(value) })}>
                <SelectItem value="__none__">No expression</SelectItem>
                {(selectedCharacter?.data?.expressions ?? []).map((expression) => <SelectItem key={expression.id} value={expression.id}>{expression.label} ({expression.id})</SelectItem>)}
              </Select>
              <Select value={activeStep.character.position} onValueChange={(value) => replaceStepPayload(activeStep.id, 'character', { position: value as SceneStepData['character']['position'] })}>{sceneCharacterPositionValues.map((position) => <SelectItem key={position} value={position}>{position}</SelectItem>)}</Select>
              <Select value={activeStep.character.transition} onValueChange={(value) => replaceStepPayload(activeStep.id, 'character', { transition: value as SceneStepData['character']['transition'] })}>{sceneCharacterTransitionValues.map((transition) => <SelectItem key={transition} value={transition}>{transition}</SelectItem>)}</Select>
              <Input aria-label="Character scale" value={String(activeStep.character.scale)} onChange={(event) => replaceStepPayload(activeStep.id, 'character', { scale: Number.parseFloat(event.currentTarget.value) || 1 })} />
              <Input aria-label="Character offset x" value={String(activeStep.character.offset.x)} onChange={(event) => replaceStepPayload(activeStep.id, 'character', { offset: { ...activeStep.character.offset, x: Number.parseFloat(event.currentTarget.value) || 0 } })} />
              <Input aria-label="Character offset y" value={String(activeStep.character.offset.y)} onChange={(event) => replaceStepPayload(activeStep.id, 'character', { offset: { ...activeStep.character.offset, y: Number.parseFloat(event.currentTarget.value) || 0 } })} />
            </section>
          ) : null}

          {activeStep?.type === 'dialogue' ? (
            <section className="space-y-3 rounded border p-3">
              <h3 className="text-sm font-medium">Dialogue</h3>
              <Select value={refValue(activeStep.dialogue.dialogue)} onValueChange={(value) => replaceStepPayload(activeStep.id, 'dialogue', { dialogue: replaceRefValue(String(value), sceneDialogueRef), startBlockId: null })}>
                <SelectItem value="__none__">No dialogue</SelectItem>
                {dialogues.map((dialogue) => <SelectItem key={dialogue.id} value={dialogue.id}>{dialogue.label} ({dialogue.id})</SelectItem>)}
              </Select>
              <Select value={activeStep.dialogue.startBlockId ?? '__none__'} onValueChange={(value) => replaceStepPayload(activeStep.id, 'dialogue', { startBlockId: value === '__none__' ? null : String(value) })}>
                <SelectItem value="__none__">Entry block</SelectItem>
                {(selectedDialogue?.data?.blocks ?? []).map((block) => <SelectItem key={block.id} value={block.id}>{block.label} ({block.id})</SelectItem>)}
              </Select>
              <Select value={activeStep.dialogue.mode} onValueChange={(value) => replaceStepPayload(activeStep.id, 'dialogue', { mode: value as SceneStepData['dialogue']['mode'] })}>{sceneDialogueModeValues.map((mode) => <SelectItem key={mode} value={mode}>{mode}</SelectItem>)}</Select>
            </section>
          ) : null}

          {activeStep?.type === 'audio' ? (
            <section className="space-y-3 rounded border p-3">
              <h3 className="text-sm font-medium">Audio</h3>
              <Select value={refValue(activeStep.audio.asset)} onValueChange={(value) => replaceStepPayload(activeStep.id, 'audio', { asset: replaceRefValue(String(value), sceneAssetRef) })}>
                <SelectItem value="__none__">No asset</SelectItem>
                {assets.map((asset) => <SelectItem key={asset.id} value={asset.id}>{asset.label} ({asset.id})</SelectItem>)}
              </Select>
              <Select value={activeStep.audio.channel} onValueChange={(value) => replaceStepPayload(activeStep.id, 'audio', { channel: value as SceneStepData['audio']['channel'] })}>{sceneAudioChannelValues.map((channel) => <SelectItem key={channel} value={channel}>{channel}</SelectItem>)}</Select>
              <Select value={activeStep.audio.action} onValueChange={(value) => replaceStepPayload(activeStep.id, 'audio', { action: value as SceneStepData['audio']['action'] })}>{sceneAudioActionValues.map((action) => <SelectItem key={action} value={action}>{action}</SelectItem>)}</Select>
              <label className="flex items-center gap-2 text-xs"><Switch checked={activeStep.audio.loop} onCheckedChange={(checked) => replaceStepPayload(activeStep.id, 'audio', { loop: Boolean(checked) })} /> Loop</label>
              <Input value={String(activeStep.audio.volume)} onChange={(event) => replaceStepPayload(activeStep.id, 'audio', { volume: Number.parseFloat(event.currentTarget.value) || 0 })} />
              <Input value={String(activeStep.audio.fadeMs)} onChange={(event) => replaceStepPayload(activeStep.id, 'audio', { fadeMs: Number.parseInt(event.currentTarget.value, 10) || 0 })} />
            </section>
          ) : null}

          {activeStep?.type === 'variable' ? (
            <section className="space-y-3 rounded border p-3">
              <h3 className="text-sm font-medium">Variable</h3>
              <Select value={refValue(activeStep.variable.variable)} onValueChange={(value) => replaceStepPayload(activeStep.id, 'variable', { variable: replaceRefValue(String(value), sceneVariableRef) })}>
                <SelectItem value="__none__">No variable</SelectItem>
                {variables.map((variable) => <SelectItem key={variable.id} value={variable.id}>{variable.label} ({variable.id})</SelectItem>)}
              </Select>
              <Select value={activeStep.variable.operation} onValueChange={(value) => replaceStepPayload(activeStep.id, 'variable', { operation: value as SceneStepData['variable']['operation'] })}>{sceneVariableOperationValues.map((operation) => <SelectItem key={operation} value={operation}>{operation}</SelectItem>)}</Select>
              <Select value={activeStep.variable.comparison} onValueChange={(value) => replaceStepPayload(activeStep.id, 'variable', { comparison: value as SceneStepData['variable']['comparison'] })}>{sceneVariableComparisonValues.map((comparison) => <SelectItem key={comparison} value={comparison}>{comparison}</SelectItem>)}</Select>
              <Input value={typeof activeStep.variable.value === 'string' ? activeStep.variable.value : JSON.stringify(activeStep.variable.value)} onChange={(event) => replaceStepPayload(activeStep.id, 'variable', { value: event.currentTarget.value })} />
            </section>
          ) : null}

          {activeStep?.type === 'script' ? (
            <section className="space-y-3 rounded border p-3">
              <h3 className="text-sm font-medium">Script</h3>
              <Input value={activeStep.script.comment} placeholder="Comment" onChange={(event) => replaceStepPayload(activeStep.id, 'script', { comment: event.currentTarget.value })} />
              <SourceEditor ref={sourceEditors.refFor('script')} className="h-40" language="lua" value={activeStep.script.source} onChange={(source) => replaceStepPayload(activeStep.id, 'script', { source })} />
            </section>
          ) : null}

          {activeStep?.type === 'wait' ? (
            <section className="space-y-3 rounded border p-3">
              <h3 className="text-sm font-medium">Wait</h3>
              <Select value={activeStep.wait.mode} onValueChange={(value) => replaceStepPayload(activeStep.id, 'wait', { mode: value as SceneStepData['wait']['mode'] })}>{sceneWaitModeValues.map((mode) => <SelectItem key={mode} value={mode}>{mode}</SelectItem>)}</Select>
              <Input value={String(activeStep.wait.durationMs)} onChange={(event) => replaceStepPayload(activeStep.id, 'wait', { durationMs: Number.parseInt(event.currentTarget.value, 10) || 0 })} />
            </section>
          ) : null}

          {activeStep?.type === 'branch' ? (
            <section className="space-y-3 rounded border p-3">
              <div className="flex items-center justify-between gap-2"><h3 className="text-sm font-medium">Branch choices</h3><Button size="sm" variant="outline" onClick={() => addBranchChoice(activeStep)}>Add Choice</Button></div>
              {activeStep.branch.choices.map((choice) => (
                <div key={choice.id} className="space-y-2 rounded border p-2">
                  <Input value={choice.label} onChange={(event) => replaceBranchChoice(activeStep, choice.id, { label: event.currentTarget.value })} />
                  <Select value={choice.targetStepId ?? '__none__'} onValueChange={(value) => replaceBranchChoice(activeStep, choice.id, { targetStepId: value === '__none__' ? null : String(value) })}>
                    <SelectItem value="__none__">No target</SelectItem>
                    {data.steps.map((step) => <SelectItem key={step.id} value={step.id}>{step.label} ({step.id})</SelectItem>)}
                  </Select>
                  <Input value={String(choice.order)} onChange={(event) => replaceBranchChoice(activeStep, choice.id, { order: Number.parseInt(event.currentTarget.value, 10) || 0 })} />
                  <label className="flex items-center gap-2 text-xs"><Switch aria-label={`Condition ${choice.id}`} checked={choice.condition.enabled} onCheckedChange={(checked) => replaceBranchChoice(activeStep, choice.id, { condition: { ...choice.condition, enabled: Boolean(checked) } })} /> Condition</label>
                  <SourceEditor ref={sourceEditors.refFor('branchChoiceCondition')} className="h-24" language="lua" value={choice.condition.source} onChange={(source) => replaceBranchChoice(activeStep, choice.id, { condition: { ...choice.condition, source } })} />
                  <Button size="sm" variant="outline" onClick={() => deleteBranchChoice(activeStep, choice.id)}>Delete Choice</Button>
                </div>
              ))}
            </section>
          ) : null}

          {activeStep?.type === 'layout' ? (
            <section className="space-y-3 rounded border p-3">
              <h3 className="text-sm font-medium">Layout</h3>
              <Select value={refValue(activeStep.layout.layout)} onValueChange={(value) => replaceStepPayload(activeStep.id, 'layout', { layout: replaceRefValue(String(value), sceneLayoutRef) })}>
                <SelectItem value="__none__">No layout</SelectItem>
                {layouts.map((layout) => <SelectItem key={layout.id} value={layout.id}>{layout.label} ({layout.id})</SelectItem>)}
              </Select>
              <Select value={activeStep.layout.action} onValueChange={(value) => replaceStepPayload(activeStep.id, 'layout', { action: value as SceneStepData['layout']['action'] })}>{sceneLayoutActionValues.map((action) => <SelectItem key={action} value={action}>{action}</SelectItem>)}</Select>
              <Select value={activeStep.layout.slot} onValueChange={(value) => replaceStepPayload(activeStep.id, 'layout', { slot: value as SceneStepData['layout']['slot'] })}>{sceneLayoutSlotValues.map((slot) => <SelectItem key={slot} value={slot}>{slot}</SelectItem>)}</Select>
            </section>
          ) : null}

          {activeStep?.type === 'transition' ? (
            <section className="space-y-3 rounded border p-3">
              <h3 className="text-sm font-medium">Transition</h3>
              <Select value={activeStep.transition.kind} onValueChange={(value) => replaceStepPayload(activeStep.id, 'transition', { kind: value as SceneStepData['transition']['kind'] })}>{sceneTransitionKindValues.map((kind) => <SelectItem key={kind} value={kind}>{kind}</SelectItem>)}</Select>
              <Input value={String(activeStep.transition.durationMs)} onChange={(event) => replaceStepPayload(activeStep.id, 'transition', { durationMs: Number.parseInt(event.currentTarget.value, 10) || 0 })} />
              <Input value={activeStep.transition.color ?? ''} onChange={(event) => replaceStepPayload(activeStep.id, 'transition', { color: event.currentTarget.value || null })} />
            </section>
          ) : null}

          {activeStep?.type === 'comment' ? (
            <section className="space-y-3 rounded border p-3">
              <h3 className="text-sm font-medium">Comment</h3>
              <SourceEditor ref={sourceEditors.refFor('comment')} className="h-32" language="text" value={activeStep.comment.source} onChange={(source) => replaceStepPayload(activeStep.id, 'comment', { source })} />
            </section>
          ) : null}

          <section className="space-y-2 rounded border p-3">
            <h3 className="text-sm font-medium">Diagnostics</h3>
            {diagnostics.length === 0 ? <div className="text-xs text-muted-foreground">No scene diagnostics.</div> : null}
            {diagnostics.map((item) => (
              <div key={`${item.path}:${item.message}`} className="rounded border p-2 text-xs">
                <Badge variant={item.severity === 'error' ? 'destructive' : 'outline'}>{item.severity}</Badge>
                <span className="ml-2">{item.message}</span>
                <div className="mt-1 font-mono text-[10px] text-muted-foreground">{item.path}</div>
              </div>
            ))}
          </section>
        </aside>
      </div>
    </div>
  );
}
