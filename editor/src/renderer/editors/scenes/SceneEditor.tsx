import { useEffect, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectItem } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { DiagnosticList } from '@/diagnostics/DiagnosticList';
import { useCommandStore } from '@/commands/command-store';
import { recordSaveUnitId } from '@/project/save-unit-registry';
import { DerivedPreviewPane } from '@/preview/DerivedPreviewPane';
import { useProjectStore } from '@/project/project-store';
import type { WorkbenchEditorProps } from '@/workbench/editor-registry';
import {
  defaultSceneData,
  defaultSceneStep,
  parseSceneData,
  sceneAssetRef,
  sceneCharacterRef,
  sceneDialogueRef,
  sceneLayoutRef,
  sceneMaterialRef,
  sceneRoomRef,
  sceneSceneRef,
  sceneStepTypeValues,
  sceneVariableRef,
  validateSceneData,
  type SceneConditionData,
  type SceneData,
  type SceneEffectData,
  type SceneInputBinding,
  type SceneInputDefinition,
  type SceneStepData,
  type SceneStepType,
  type SceneTerminal,
  type SceneTransitionGroupChildData,
} from '../../../shared/project-schema/authoring-scenes';
import { parseRoomData } from '../../../shared/project-schema/authoring-rooms';
import { resolveMaterialData } from '../../../shared/project-schema/authoring-materials';
import {
  parseShaderData,
  type ShaderUniformData,
  type ShaderUniformValue,
} from '../../../shared/project-schema/authoring-shaders';
import { isAuthoringProject } from '../../../shared/project-schema/authoring-project';
import {
  buildScenePreviewDocumentData,
  scenePreviewRevision,
} from '../../../shared/project-schema/scene-project';

function commitScene(sceneId: string, data: SceneData, label: string) {
  return useCommandStore.getState().executeCommand({
    type: 'scene.replaceData',
    label,
    payload: { sceneId, data },
    originSaveUnitId: recordSaveUnitId('scenes', sceneId),
    persistencePolicy: 'manual-save',
  });
}
function title(value: string) {
  return value
    .split('-')
    .map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`)
    .join(' ');
}
function isPresentationOwnedStep(step: SceneStepData): step is Extract<
  SceneStepData,
  {
    type:
      | 'set-background'
      | 'actor-cue'
      | 'audio-cue'
      | 'set-layout'
      | 'material-parameter'
      | 'postprocess-effect'
      | 'transition-group';
  }
> {
  return (
    step.type === 'set-background' ||
    step.type === 'actor-cue' ||
    step.type === 'audio-cue' ||
    step.type === 'set-layout' ||
    step.type === 'material-parameter' ||
    step.type === 'postprocess-effect' ||
    step.type === 'transition-group'
  );
}
function uniqueId(steps: SceneStepData[], base: string) {
  const used = new Set(steps.map((step) => step.id));
  if (!used.has(base)) return base;
  for (let index = 2; index < 1000; index += 1)
    if (!used.has(`${base}-${index}`)) return `${base}-${index}`;
  return `${base}-${Date.now()}`;
}

function sceneInputText(value: SceneInputBinding['value'] | undefined): string {
  if (value === undefined) return '';
  if (value === null) return 'null';
  return String(value);
}

function parseSceneInputValue(
  input: SceneInputDefinition,
  text: string,
): SceneInputBinding['value'] | undefined {
  if (input.nullable && text === 'null') return null;
  if (input.type === 'string') return text;
  if (input.type === 'boolean') {
    if (text === 'true') return true;
    if (text === 'false') return false;
    return undefined;
  }
  const value = Number(text);
  if (!Number.isFinite(value)) return undefined;
  if (input.type === 'integer' && !Number.isInteger(value)) return undefined;
  return value;
}
function uniqueNestedId(ids: readonly string[], base: string) {
  const used = new Set(ids);
  if (!used.has(base)) return base;
  for (let index = 2; index < 1000; index += 1)
    if (!used.has(`${base}-${index}`)) return `${base}-${index}`;
  return `${base}-${Date.now()}`;
}
function refId(ref: { $ref: { id: string } } | null) {
  return ref?.$ref.id ?? '__none__';
}
function scalar(value: string): string | number | boolean | null {
  if (value === 'null') return null;
  if (value === 'true') return true;
  if (value === 'false') return false;
  const number = Number(value);
  return value.trim() !== '' && Number.isFinite(number) ? number : value;
}

function materialUniforms(
  project: NonNullable<ReturnType<typeof useProjectStore.getState>['document']>,
  materialId: string,
): ShaderUniformData[] {
  if (!isAuthoringProject(project)) return [];
  const material = resolveMaterialData(project, materialId).data;
  if (!material?.shader) return [];
  const shader = parseShaderData(project.shaders[material.shader.$ref.id]?.data);
  return shader?.uniforms.filter((uniform) => !uniform.binding) ?? [];
}

function defaultUniformValue(
  uniform: ShaderUniformData | undefined,
): Exclude<ShaderUniformValue, null> {
  if (uniform?.default !== undefined && uniform.default !== null) return uniform.default;
  switch (uniform?.type) {
    case 'bool':
      return false;
    case 'vec2':
      return [0, 0];
    case 'vec3':
      return [0, 0, 0];
    case 'vec4':
      return [0, 0, 0, 0];
    case 'color':
      return { r: 1, g: 1, b: 1, a: 1 };
    default:
      return 0;
  }
}

function uniformValueText(value: Exclude<ShaderUniformValue, null>): string {
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

function parseUniformValue(
  text: string,
  uniform: ShaderUniformData | undefined,
): Exclude<ShaderUniformValue, null> | null {
  if (!uniform) return null;
  if (uniform.type === 'bool') return text === 'true';
  if (uniform.type === 'float' || uniform.type === 'int') {
    const value = Number(text);
    if (!Number.isFinite(value) || (uniform.type === 'int' && !Number.isInteger(value)))
      return null;
    return value;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (uniform.type === 'vec2' && Array.isArray(parsed) && parsed.length === 2)
      return parsed as [number, number];
    if (uniform.type === 'vec3' && Array.isArray(parsed) && parsed.length === 3)
      return parsed as [number, number, number];
    if (uniform.type === 'vec4' && Array.isArray(parsed) && parsed.length === 4)
      return parsed as [number, number, number, number];
    if (
      uniform.type === 'color' &&
      typeof parsed === 'object' &&
      parsed !== null &&
      ['r', 'g', 'b', 'a'].every(
        (key) => typeof (parsed as Record<string, unknown>)[key] === 'number',
      )
    )
      return parsed as { r: number; g: number; b: number; a: number };
  } catch {
    return null;
  }
  return null;
}

export function SceneEditor({ tab }: WorkbenchEditorProps) {
  const document = useProjectStore((state) => state.document);
  const project = isAuthoringProject(document) ? document : null;
  const sceneId = tab.resource?.entityId;
  const record = sceneId && project ? project.scenes[sceneId] : null;
  const data = parseSceneData(record?.data) ?? defaultSceneData(record?.label ?? 'Scene');
  const [selectedId, setSelectedId] = useState<string | null>(data.events[0]?.id ?? null);
  const [scrubMs, setScrubMs] = useState(0);
  const [timelinePlaying, setTimelinePlaying] = useState(false);
  const selected = data.events.find((step) => step.id === selectedId) ?? data.events[0] ?? null;
  const diagnostics = useMemo(
    () => (project && record && sceneId ? validateSceneData(project, sceneId, record) : []),
    [project, record, sceneId],
  );

  const blankStage = data.stage.kind === 'blank' ? data.stage : null;
  const timelineEndMs = Math.max(
    1000,
    ...data.events.map((event) => event.timeline.startMs + Math.max(event.timeline.durationMs, 1)),
  );
  const timelineTracks = [...new Set(data.events.map((event) => event.timeline.trackId))];
  useEffect(() => {
    if (!timelinePlaying) return;
    const timer = window.setInterval(() => {
      setScrubMs((current) => {
        const next = current + 50;
        return next > timelineEndMs ? 0 : next;
      });
    }, 50);
    return () => window.clearInterval(timer);
  }, [timelinePlaying, timelineEndMs]);
  useEffect(() => {
    if (!timelinePlaying) return;
    const active = [...data.events]
      .reverse()
      .find(
        (event) =>
          scrubMs >= event.timeline.startMs &&
          scrubMs <= event.timeline.startMs + Math.max(event.timeline.durationMs, 1),
      );
    if (active && active.id !== selectedId) setSelectedId(active.id);
  }, [data.events, scrubMs, selectedId, timelinePlaying]);
  if (!project || !record || !sceneId)
    return <div className="p-4 text-sm text-muted-foreground">Scene not found.</div>;
  const sceneActorSlots = [
    ...new Set(data.events.flatMap((step) => (step.type === 'actor-cue' ? [step.slotId] : []))),
  ];
  const roomAnchorOptions = Object.entries(project.rooms).flatMap(([roomId, room]) => {
    const roomData = parseRoomData(room.data);
    return (roomData?.anchors ?? []).map((anchor) => ({
      roomId,
      roomLabel: room.label || roomId,
      anchorId: anchor.id,
    }));
  });
  const commit = (next: SceneData, label = 'Update scene') => commitScene(sceneId, next, label);
  const replaceStep = (next: SceneStepData) =>
    commit(
      { ...data, events: data.events.map((step) => (step.id === next.id ? next : step)) },
      'Update scene step',
    );
  const stepForProject = (type: SceneStepType, label?: string): SceneStepData | null => {
    const step = defaultSceneStep(type, label) as SceneStepData;
    if (step.type === 'actor-cue') {
      const id = Object.keys(project.characters)[0];
      return id ? { ...step, character: sceneCharacterRef(id) } : null;
    }
    if (step.type === 'call-dialogue') {
      const id = Object.keys(project.dialogues)[0];
      return id ? { ...step, dialogue: sceneDialogueRef(id) } : null;
    }
    if (step.type === 'call-scene' || step.type === 'start-detached-scene') {
      const id = Object.keys(project.scenes).find((candidate) => candidate !== sceneId);
      return id ? { ...step, scene: sceneSceneRef(id) } : null;
    }
    if (step.type === 'set-variable') {
      const id = Object.keys(project.variables)[0];
      const value = project.variables[id!]?.data.defaultValue;
      return id &&
        (value === null ||
          typeof value === 'boolean' ||
          typeof value === 'number' ||
          typeof value === 'string')
        ? { ...step, variable: sceneVariableRef(id), value }
        : null;
    }
    if (step.type === 'material-parameter') {
      const materialId = Object.keys(project.materials).find(
        (id) => resolveMaterialData(project, id).data?.role === 'engine-2d',
      );
      if (!materialId) return null;
      const uniform = materialUniforms(project, materialId)[0];
      if (!uniform) return null;
      return {
        ...step,
        material: sceneMaterialRef(materialId),
        parameter: uniform.name,
        value: defaultUniformValue(uniform),
      };
    }
    if (step.type === 'postprocess-effect') {
      const materialId = Object.keys(project.materials).find(
        (id) => resolveMaterialData(project, id).data?.role === 'postprocess',
      );
      if (!materialId) return step;
      const material = resolveMaterialData(project, materialId).data;
      return {
        ...step,
        action: 'upsert',
        material: sceneMaterialRef(materialId),
        scope: material?.postprocessScope ?? 'world',
      };
    }
    return step;
  };
  const changeType = (type: SceneStepType) => {
    if (!selected) return;
    const created = stepForProject(type, selected.label);
    if (!created) return;
    const next = { ...created, id: selected.id } as SceneStepData;
    replaceStep(next);
  };
  const addStep = (type: SceneStepType) => {
    const created = stepForProject(type, title(type));
    if (!created) return;
    const step = { ...created, id: uniqueId(data.events, type) } as SceneStepData;
    commit({ ...data, events: [...data.events, step] }, 'Add scene event');
    setSelectedId(step.id);
  };
  const duplicate = () => {
    if (!selected) return;
    const id = uniqueId(data.events, selected.id);
    const step = structuredClone({
      ...selected,
      id,
      label: `${selected.label} Copy`,
    }) as SceneStepData;
    const index = data.events.findIndex((item) => item.id === selected.id);
    const steps = [...data.events];
    steps.splice(index + 1, 0, step);
    commit({ ...data, events: steps }, 'Duplicate scene event');
    setSelectedId(id);
  };
  const remove = () => {
    if (!selected || data.events.length === 1) return;
    const index = data.events.findIndex((item) => item.id === selected.id);
    const steps = data.events.filter((item) => item.id !== selected.id);
    commit({ ...data, events: steps }, 'Delete scene event');
    setSelectedId(steps[Math.min(index, steps.length - 1)]?.id ?? null);
  };
  const move = (delta: number) => {
    if (!selected) return;
    const index = data.events.findIndex((item) => item.id === selected.id);
    const target = index + delta;
    if (target < 0 || target >= data.events.length) return;
    const steps = [...data.events];
    [steps[index], steps[target]] = [steps[target]!, steps[index]!];
    commit({ ...data, events: steps }, 'Reorder scene events');
  };
  const renameStep = (nextId: string) => {
    if (!selected || nextId === selected.id || data.events.some((step) => step.id === nextId))
      return;
    const previousId = selected.id;
    const steps = data.events.map((step): SceneStepData => {
      const renamed = step.id === previousId ? ({ ...step, id: nextId } as SceneStepData) : step;
      if (renamed.type === 'conditional-branch')
        return {
          ...renamed,
          fallbackStepId: renamed.fallbackStepId === previousId ? nextId : renamed.fallbackStepId,
          branches: renamed.branches.map((branch) => ({
            ...branch,
            targetStepId: branch.targetStepId === previousId ? nextId : branch.targetStepId,
          })),
        };
      if (renamed.type === 'choice')
        return {
          ...renamed,
          options: renamed.options.map((option) => ({
            ...option,
            targetStepId: option.targetStepId === previousId ? nextId : option.targetStepId,
          })),
        };
      return renamed;
    });
    commit({ ...data, events: steps }, 'Rename scene event');
    setSelectedId(nextId);
  };

  const terminalOptions = [
    ...Object.keys(project.scenes).map((id) => ({
      value: `continue-scene:${id}`,
      label: `Continue/Replace Scene: ${project.scenes[id]!.label}`,
    })),
    ...Object.keys(project.dialogues).map((id) => ({
      value: `continue-dialogue:${id}`,
      label: `Continue/Replace Dialogue: ${project.dialogues[id]!.label}`,
    })),
    { value: 'return', label: 'Return' },
    { value: 'release-to-exploration', label: 'Release to Exploration' },
    { value: 'complete-game', label: 'Complete Game' },
  ];
  const terminalValue =
    data.terminal.kind === 'continue-scene'
      ? `continue-scene:${data.terminal.scene.$ref.id}`
      : data.terminal.kind === 'continue-dialogue'
        ? `continue-dialogue:${data.terminal.dialogue.$ref.id}`
        : data.terminal.kind;
  const conditionEditor = (
    condition: SceneConditionData | undefined,
    onChange: (condition: SceneConditionData | undefined) => void,
  ) => {
    const variableId = Object.keys(project.variables)[0];
    return (
      <div className="space-y-2 rounded border p-2">
        <Label>
          Condition
          <Select
            value={condition?.kind ?? 'none'}
            onValueChange={(kind) => {
              if (kind === 'none') onChange(undefined);
              else if (kind === 'always') onChange({ kind: 'always' });
              else if (kind === 'lua-predicate')
                onChange({ kind: 'lua-predicate', source: '-- return true' });
              else if (variableId)
                onChange({
                  kind: 'variable-comparison',
                  variable: sceneVariableRef(variableId),
                  operator: 'equal',
                  value: project.variables[variableId]!.data.defaultValue as
                    | string
                    | number
                    | boolean
                    | null,
                });
            }}
          >
            <SelectItem value="none">None</SelectItem>
            <SelectItem value="always">Always</SelectItem>
            <SelectItem value="variable-comparison" disabled={!variableId}>
              Variable comparison
            </SelectItem>
            <SelectItem value="lua-predicate">Lua predicate</SelectItem>
          </Select>
        </Label>
        {condition?.kind === 'lua-predicate' && (
          <Label>
            Lua predicate
            <textarea
              className="min-h-24 w-full rounded border bg-background p-2 font-mono text-sm"
              value={condition.source}
              onChange={(event) => onChange({ ...condition, source: event.target.value })}
            />
          </Label>
        )}
        {condition?.kind === 'variable-comparison' && (
          <>
            <Label>
              Variable
              <Select
                value={condition.variable.$ref.id}
                onValueChange={(id) => {
                  if (id)
                    onChange({
                      ...condition,
                      variable: sceneVariableRef(id),
                      value: project.variables[id]!.data.defaultValue as
                        | string
                        | number
                        | boolean
                        | null,
                    });
                }}
              >
                {Object.entries(project.variables).map(([id, item]) => (
                  <SelectItem key={id} value={id}>
                    {item.label}
                  </SelectItem>
                ))}
              </Select>
            </Label>
            <Label>
              Operator
              <Select
                value={condition.operator}
                onValueChange={(operator) =>
                  onChange({ ...condition, operator: operator as typeof condition.operator })
                }
              >
                {[
                  'equal',
                  'not-equal',
                  'less',
                  'less-equal',
                  'greater',
                  'greater-equal',
                  'truthy',
                  'falsy',
                ].map((operator) => (
                  <SelectItem key={operator} value={operator}>
                    {title(operator)}
                  </SelectItem>
                ))}
              </Select>
            </Label>
            {!['truthy', 'falsy'].includes(condition.operator) && (
              <Label>
                Value
                <Input
                  value={String(condition.value ?? '')}
                  onChange={(event) =>
                    onChange({ ...condition, value: scalar(event.target.value) })
                  }
                />
              </Label>
            )}
          </>
        )}
      </div>
    );
  };
  const effectEditor = (effect: SceneEffectData, onChange: (effect: SceneEffectData) => void) => (
    <div className="space-y-2 rounded border p-2">
      <Label>
        Effect
        <Select
          value={effect.kind}
          onValueChange={(kind) => {
            const variableId = Object.keys(project.variables)[0];
            if (kind === 'run-lua-effect') onChange({ kind, source: '-- Lua effect' });
            else if (variableId)
              onChange({
                kind: 'set-variable',
                variable: sceneVariableRef(variableId),
                value: project.variables[variableId]!.data.defaultValue as
                  | string
                  | number
                  | boolean
                  | null,
              });
          }}
        >
          <SelectItem value="set-variable" disabled={Object.keys(project.variables).length === 0}>
            Set variable
          </SelectItem>
          <SelectItem value="run-lua-effect">Run Lua effect</SelectItem>
        </Select>
      </Label>
      {effect.kind === 'run-lua-effect' ? (
        <textarea
          className="min-h-20 w-full rounded border bg-background p-2 font-mono text-sm"
          value={effect.source}
          onChange={(event) => onChange({ ...effect, source: event.target.value })}
        />
      ) : (
        <>
          <Select
            value={effect.variable.$ref.id}
            onValueChange={(id) => {
              if (id)
                onChange({
                  ...effect,
                  variable: sceneVariableRef(id),
                  value: project.variables[id]!.data.defaultValue as
                    | string
                    | number
                    | boolean
                    | null,
                });
            }}
          >
            {Object.entries(project.variables).map(([id, item]) => (
              <SelectItem key={id} value={id}>
                {item.label}
              </SelectItem>
            ))}
          </Select>
          <Input
            value={String(effect.value)}
            onChange={(event) => onChange({ ...effect, value: scalar(event.target.value) })}
          />
        </>
      )}
    </div>
  );
  const revision = scenePreviewRevision(project, sceneId);
  const previewDocument = {
    kind: 'scene-preview' as const,
    recordId: sceneId,
    revision,
    data: buildScenePreviewDocumentData(project, sceneId, selected?.id),
  };
  const diagnosticItems = diagnostics.map((item) => ({ ...item, target: null }));

  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(240px,0.7fr)_minmax(360px,1.3fr)_minmax(320px,1fr)]">
      <section className="min-h-0 overflow-auto border-r p-3">
        <div className="mb-3 flex gap-2">
          <Select value="comment" onValueChange={(value) => addStep(value as SceneStepType)}>
            {sceneStepTypeValues.map((type) => (
              <SelectItem key={type} value={type}>
                Add {title(type)}
              </SelectItem>
            ))}
          </Select>
        </div>
        <div className="mb-4 rounded border bg-muted/20 p-2">
          <div className="mb-2 flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setTimelinePlaying((playing) => !playing)}
            >
              {timelinePlaying ? 'Pause' : 'Play'}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setTimelinePlaying(false);
                setScrubMs(0);
              }}
            >
              Reset
            </Button>
            <span className="ml-auto text-xs tabular-nums text-muted-foreground">
              {(scrubMs / 1000).toFixed(2)}s / {(timelineEndMs / 1000).toFixed(2)}s
            </span>
          </div>
          <input
            className="mb-2 w-full"
            type="range"
            min={0}
            max={timelineEndMs}
            step={10}
            value={Math.min(scrubMs, timelineEndMs)}
            onChange={(event) => {
              setTimelinePlaying(false);
              const next = Number(event.target.value);
              setScrubMs(next);
              const active = [...data.events]
                .reverse()
                .find(
                  (item) =>
                    next >= item.timeline.startMs &&
                    next <= item.timeline.startMs + Math.max(item.timeline.durationMs, 1),
                );
              if (active) setSelectedId(active.id);
            }}
          />
          <div className="space-y-1">
            {timelineTracks.map((trackId) => (
              <div key={trackId} className="grid grid-cols-[72px_1fr] items-center gap-2">
                <span className="truncate text-xs text-muted-foreground" title={trackId}>
                  {trackId}
                </span>
                <div className="relative h-8 overflow-hidden rounded bg-background">
                  <div
                    className="pointer-events-none absolute inset-y-0 w-px bg-foreground/60"
                    style={{ left: `${(Math.min(scrubMs, timelineEndMs) / timelineEndMs) * 100}%` }}
                  />
                  {data.events
                    .filter((event) => event.timeline.trackId === trackId)
                    .map((event) => {
                      const left = (event.timeline.startMs / timelineEndMs) * 100;
                      const width = Math.max(
                        1.5,
                        (Math.max(event.timeline.durationMs, 1) / timelineEndMs) * 100,
                      );
                      return (
                        <button
                          key={event.id}
                          type="button"
                          title={`${event.label} · ${event.timeline.startMs}–${event.timeline.startMs + event.timeline.durationMs} ms`}
                          className={`absolute top-1 h-6 overflow-hidden rounded border px-1 text-left text-[10px] ${event.id === selected?.id ? 'bg-accent' : 'bg-muted hover:bg-accent/60'}`}
                          style={{ left: `${left}%`, width: `${Math.min(width, 100 - left)}%` }}
                          onClick={() => {
                            setSelectedId(event.id);
                            setScrubMs(event.timeline.startMs);
                          }}
                        >
                          <span className="block truncate">{event.label}</span>
                        </button>
                      );
                    })}
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="space-y-1">
          {data.events.map((step, index) => (
            <button
              key={step.id}
              className={`flex w-full items-center gap-2 rounded px-2 py-2 text-left text-sm ${step.id === selected?.id ? 'bg-accent' : 'hover:bg-muted'}`}
              onClick={() => setSelectedId(step.id)}
            >
              <span className="w-6 text-muted-foreground">{index + 1}</span>
              <span className="min-w-0 flex-1 truncate">{step.label}</span>
              <Badge variant="outline">{title(step.type)}</Badge>
            </button>
          ))}
        </div>
      </section>

      <section className="min-h-0 overflow-auto border-r p-4">
        <div className="mb-4 grid gap-3">
          <Label>
            Display name
            <Input
              value={data.displayName}
              onChange={(event) => commit({ ...data, displayName: event.target.value })}
            />
          </Label>
          <Label>
            Terminal action
            <Select
              value={terminalValue}
              onValueChange={(value) => {
                if (!value) return;
                const [kind, id] = value.split(':');
                const terminal: SceneTerminal =
                  kind === 'continue-scene' && id
                    ? { kind, scene: sceneSceneRef(id), inputs: [] }
                    : kind === 'continue-dialogue' && id
                      ? { kind, dialogue: sceneDialogueRef(id) }
                      : kind === 'return'
                        ? { kind, outcome: null }
                        : kind === 'release-to-exploration'
                          ? { kind }
                          : { kind: 'complete-game' };
                commit({
                  ...data,
                  terminal,
                });
              }}
            >
              {terminalOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </Select>
          </Label>
          {data.terminal.kind === 'return' && data.outcomes.length > 0 ? (
            <Label>
              Return outcome
              <Select
                value={data.terminal.outcome ?? '__none__'}
                onValueChange={(outcome) =>
                  commit({
                    ...data,
                    terminal: {
                      kind: 'return',
                      outcome: outcome === '__none__' ? null : outcome,
                    },
                  })
                }
              >
                <SelectItem value="__none__">No outcome</SelectItem>
                {data.outcomes.map((outcome) => (
                  <SelectItem key={outcome.id} value={outcome.id}>
                    {outcome.label}
                  </SelectItem>
                ))}
              </Select>
            </Label>
          ) : null}
          {data.terminal.kind === 'continue-scene' ? (
            <div className="space-y-2 rounded border p-2">
              <span className="text-xs font-medium">Continue Scene inputs</span>
              {(
                parseSceneData(project.scenes[data.terminal.scene.$ref.id]?.data)?.inputs ?? []
              ).map((input) => {
                const binding =
                  data.terminal.kind === 'continue-scene'
                    ? data.terminal.inputs.find((candidate) => candidate.inputId === input.id)
                    : undefined;
                return (
                  <Label key={input.id}>
                    {input.label} ({input.type})
                    <Input
                      value={sceneInputText(binding?.value)}
                      placeholder={input.nullable ? 'null' : input.id}
                      onChange={(event) => {
                        if (data.terminal.kind !== 'continue-scene') return;
                        const value = parseSceneInputValue(input, event.target.value);
                        const inputs = data.terminal.inputs.filter(
                          (candidate) => candidate.inputId !== input.id,
                        );
                        if (value !== undefined) inputs.push({ inputId: input.id, value });
                        commit({ ...data, terminal: { ...data.terminal, inputs } });
                      }}
                    />
                  </Label>
                );
              })}
            </div>
          ) : null}
          <div className="space-y-2 rounded border p-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium">Inputs</span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  const used = new Set(data.inputs.map((input) => input.id));
                  let suffix = 1;
                  while (used.has(`input-${suffix}`)) suffix += 1;
                  commit({
                    ...data,
                    inputs: [
                      ...data.inputs,
                      {
                        id: `input-${suffix}`,
                        label: `Input ${suffix}`,
                        type: 'string',
                        nullable: false,
                      },
                    ],
                  });
                }}
              >
                Add Input
              </Button>
            </div>
            {data.inputs.map((input, index) => (
              <div
                key={`${input.id}-${index}`}
                className="grid grid-cols-[1fr_1fr_110px_auto] gap-2"
              >
                <Input
                  value={input.id}
                  aria-label={`Input ${index + 1} ID`}
                  onChange={(event) => {
                    const inputs = [...data.inputs];
                    inputs[index] = { ...input, id: event.target.value };
                    commit({ ...data, inputs });
                  }}
                />
                <Input
                  value={input.label}
                  aria-label={`Input ${index + 1} label`}
                  onChange={(event) => {
                    const inputs = [...data.inputs];
                    inputs[index] = { ...input, label: event.target.value };
                    commit({ ...data, inputs });
                  }}
                />
                <Select
                  value={input.type}
                  onValueChange={(type) => {
                    const inputs = [...data.inputs];
                    inputs[index] = {
                      ...input,
                      type: type as typeof input.type,
                      defaultValue: undefined,
                    };
                    commit({ ...data, inputs });
                  }}
                >
                  <SelectItem value="boolean">Boolean</SelectItem>
                  <SelectItem value="integer">Integer</SelectItem>
                  <SelectItem value="number">Number</SelectItem>
                  <SelectItem value="string">String</SelectItem>
                </Select>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    commit({ ...data, inputs: data.inputs.filter((_, item) => item !== index) })
                  }
                >
                  Remove
                </Button>
              </div>
            ))}
          </div>
          <div className="space-y-2 rounded border p-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium">Outcomes</span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  const used = new Set(data.outcomes.map((outcome) => outcome.id));
                  let suffix = 1;
                  while (used.has(`outcome-${suffix}`)) suffix += 1;
                  commit({
                    ...data,
                    outcomes: [
                      ...data.outcomes,
                      { id: `outcome-${suffix}`, label: `Outcome ${suffix}` },
                    ],
                  });
                }}
              >
                Add Outcome
              </Button>
            </div>
            {data.outcomes.map((outcome, index) => (
              <div key={`${outcome.id}-${index}`} className="grid grid-cols-[1fr_1fr_auto] gap-2">
                <Input
                  value={outcome.id}
                  aria-label={`Outcome ${index + 1} ID`}
                  onChange={(event) => {
                    const outcomes = [...data.outcomes];
                    outcomes[index] = { ...outcome, id: event.target.value };
                    commit({ ...data, outcomes });
                  }}
                />
                <Input
                  value={outcome.label}
                  aria-label={`Outcome ${index + 1} label`}
                  onChange={(event) => {
                    const outcomes = [...data.outcomes];
                    outcomes[index] = { ...outcome, label: event.target.value };
                    commit({ ...data, outcomes });
                  }}
                />
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    commit({ ...data, outcomes: data.outcomes.filter((_, item) => item !== index) })
                  }
                >
                  Remove
                </Button>
              </div>
            ))}
          </div>
          <Label>
            Stage
            <Select
              value={data.stage.kind}
              onValueChange={(kind) => {
                if (kind === 'inherited') commit({ ...data, stage: { kind: 'inherited' } });
                else if (kind === 'staged-room')
                  commit({
                    ...data,
                    stage: {
                      kind: 'staged-room',
                      room: sceneRoomRef(Object.keys(project.rooms)[0] ?? 'room'),
                    },
                  });
                else
                  commit({
                    ...data,
                    stage: {
                      kind: 'blank',
                      background: {
                        asset: null,
                        material: null,
                        color: '#0f172a',
                        fit: 'cover',
                      },
                      layout: null,
                    },
                  });
              }}
            >
              <SelectItem value="inherited">Inherited</SelectItem>
              <SelectItem value="staged-room">Staged Room</SelectItem>
              <SelectItem value="blank">Blank</SelectItem>
            </Select>
          </Label>
          {data.stage.kind === 'staged-room' ? (
            <Label>
              Staged Room
              <Select
                value={data.stage.room.$ref.id}
                onValueChange={(id) => {
                  if (id)
                    commit({ ...data, stage: { kind: 'staged-room', room: sceneRoomRef(id) } });
                }}
              >
                {Object.entries(project.rooms).map(([id, item]) => (
                  <SelectItem key={id} value={id}>
                    {item.label}
                  </SelectItem>
                ))}
              </Select>
            </Label>
          ) : null}
          {blankStage ? (
            <Label>
              Stage background asset
              <Select
                value={refId(blankStage.background.asset)}
                onValueChange={(id) => {
                  if (id)
                    commit({
                      ...data,
                      stage: {
                        ...blankStage,
                        background: {
                          ...blankStage.background,
                          asset: id === '__none__' ? null : sceneAssetRef(id),
                        },
                      },
                    });
                }}
              >
                <SelectItem value="__none__">None</SelectItem>
                {Object.entries(project.assets).map(([id, item]) => (
                  <SelectItem key={id} value={id}>
                    {item.label}
                  </SelectItem>
                ))}
              </Select>
            </Label>
          ) : null}
          {blankStage ? (
            <Label>
              Stage background material
              <Select
                value={refId(blankStage.background.material)}
                onValueChange={(id) => {
                  if (id)
                    commit({
                      ...data,
                      stage: {
                        ...blankStage,
                        background: {
                          ...blankStage.background,
                          material: id === '__none__' ? null : sceneMaterialRef(id),
                        },
                      },
                    });
                }}
              >
                <SelectItem value="__none__">None</SelectItem>
                {Object.entries(project.materials).map(([id, item]) => (
                  <SelectItem key={id} value={id}>
                    {item.label}
                  </SelectItem>
                ))}
              </Select>
            </Label>
          ) : null}
          {blankStage ? (
            <Label>
              Stage background color
              <Input
                value={blankStage.background.color ?? ''}
                onChange={(event) =>
                  commit({
                    ...data,
                    stage: {
                      ...blankStage,
                      background: {
                        ...blankStage.background,
                        color: event.target.value || null,
                      },
                    },
                  })
                }
              />
            </Label>
          ) : null}
          {blankStage ? (
            <Label>
              Stage background fit
              <Select
                value={blankStage.background.fit}
                onValueChange={(fit) =>
                  commit({
                    ...data,
                    stage: {
                      ...blankStage,
                      background: {
                        ...blankStage.background,
                        fit: fit as typeof blankStage.background.fit,
                      },
                    },
                  })
                }
              >
                {['cover', 'contain', 'stretch', 'center'].map((value) => (
                  <SelectItem key={value} value={value}>
                    {title(value)}
                  </SelectItem>
                ))}
              </Select>
            </Label>
          ) : null}
          {blankStage ? (
            <Label>
              Stage layout
              <Select
                value={refId(blankStage.layout)}
                onValueChange={(id) => {
                  if (id)
                    commit({
                      ...data,
                      stage: {
                        ...blankStage,
                        layout: id === '__none__' ? null : sceneLayoutRef(id),
                      },
                    });
                }}
              >
                <SelectItem value="__none__">None</SelectItem>
                {Object.entries(project.layouts).map(([id, item]) => (
                  <SelectItem key={id} value={id}>
                    {item.label}
                  </SelectItem>
                ))}
              </Select>
            </Label>
          ) : null}
        </div>
        {!selected ? null : (
          <div className="space-y-4">
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => move(-1)}>
                Up
              </Button>
              <Button size="sm" variant="outline" onClick={() => move(1)}>
                Down
              </Button>
              <Button size="sm" variant="outline" onClick={duplicate}>
                Duplicate
              </Button>
              <Button
                size="sm"
                variant="destructive"
                disabled={data.events.length === 1}
                onClick={remove}
              >
                Delete
              </Button>
            </div>
            <Label>
              Type
              <Select
                value={selected.type}
                onValueChange={(value) => changeType(value as SceneStepType)}
              >
                {sceneStepTypeValues.map((type) => (
                  <SelectItem key={type} value={type}>
                    {title(type)}
                  </SelectItem>
                ))}
              </Select>
            </Label>
            <Label>
              Event ID
              <Input value={selected.id} onChange={(event) => renameStep(event.target.value)} />
            </Label>
            <Label>
              Label
              <Input
                value={selected.label}
                onChange={(event) =>
                  replaceStep({ ...selected, label: event.target.value } as SceneStepData)
                }
              />
            </Label>
            <div className="grid grid-cols-3 gap-3">
              <Label>
                Timeline track
                <Input
                  value={selected.timeline.trackId}
                  onChange={(event) =>
                    replaceStep({
                      ...selected,
                      timeline: { ...selected.timeline, trackId: event.target.value },
                    } as SceneStepData)
                  }
                />
              </Label>
              <Label>
                Start (ms)
                <Input
                  type="number"
                  min={0}
                  value={selected.timeline.startMs}
                  onChange={(event) =>
                    replaceStep({
                      ...selected,
                      timeline: {
                        ...selected.timeline,
                        startMs: Math.max(0, Number(event.target.value) || 0),
                      },
                    } as SceneStepData)
                  }
                />
              </Label>
              <Label>
                Duration (ms)
                <Input
                  type="number"
                  min={0}
                  value={selected.timeline.durationMs}
                  onChange={(event) =>
                    replaceStep({
                      ...selected,
                      timeline: {
                        ...selected.timeline,
                        durationMs: Math.max(0, Number(event.target.value) || 0),
                      },
                    } as SceneStepData)
                  }
                />
              </Label>
            </div>
            {'completionDependencies' in selected && (
              <Label>
                Completion dependencies
                <Input
                  value={selected.completionDependencies.join(', ')}
                  placeholder="Earlier Event IDs, comma-separated"
                  onChange={(event) =>
                    replaceStep({
                      ...selected,
                      completionDependencies: event.target.value
                        .split(',')
                        .map((value) => value.trim())
                        .filter(Boolean),
                    } as SceneStepData)
                  }
                />
              </Label>
            )}
            {'enabled' in selected && (
              <Label className="flex items-center gap-2">
                Enabled
                <Switch
                  checked={selected.enabled}
                  onCheckedChange={(enabled) =>
                    replaceStep({ ...selected, enabled } as SceneStepData)
                  }
                />
              </Label>
            )}
            {'condition' in selected &&
              conditionEditor(selected.condition, (condition) =>
                replaceStep({ ...selected, condition } as SceneStepData),
              )}
            {'autosaveSafePoint' in selected && (
              <Label className="flex items-center gap-2">
                Autosave safe point
                <Switch
                  checked={selected.autosaveSafePoint}
                  onCheckedChange={(autosaveSafePoint) =>
                    replaceStep({ ...selected, autosaveSafePoint } as SceneStepData)
                  }
                />
              </Label>
            )}
            {isPresentationOwnedStep(selected) && (
              <Label>
                Presentation ownership
                <Select
                  value={selected.owner}
                  onValueChange={(owner) =>
                    replaceStep({ ...selected, owner: owner as typeof selected.owner })
                  }
                >
                  <SelectItem value="invocation">Scene Invocation</SelectItem>
                  <SelectItem value="active-room">Active Room</SelectItem>
                  <SelectItem value="runtime-session">Runtime Session</SelectItem>
                </Select>
              </Label>
            )}
            {selected.type === 'set-background' && (
              <>
                <Label>
                  Asset
                  <Select
                    value={refId(selected.asset)}
                    onValueChange={(id) => {
                      if (id)
                        replaceStep({
                          ...selected,
                          asset: id === '__none__' ? null : sceneAssetRef(id),
                        });
                    }}
                  >
                    <SelectItem value="__none__">None</SelectItem>
                    {Object.entries(project.assets).map(([id, item]) => (
                      <SelectItem key={id} value={id}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </Select>
                </Label>
                <Label>
                  Material
                  <Select
                    value={refId(selected.material)}
                    onValueChange={(id) => {
                      if (id)
                        replaceStep({
                          ...selected,
                          material: id === '__none__' ? null : sceneMaterialRef(id),
                        });
                    }}
                  >
                    <SelectItem value="__none__">None</SelectItem>
                    {Object.entries(project.materials).map(([id, item]) => (
                      <SelectItem key={id} value={id}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </Select>
                </Label>
                <Label>
                  Color
                  <Input
                    value={selected.color ?? ''}
                    onChange={(event) =>
                      replaceStep({ ...selected, color: event.target.value || null })
                    }
                  />
                </Label>
                <Label>
                  Fit
                  <Select
                    value={selected.fit}
                    onValueChange={(fit) =>
                      replaceStep({ ...selected, fit: fit as typeof selected.fit })
                    }
                  >
                    {['cover', 'contain', 'stretch', 'center'].map((value) => (
                      <SelectItem key={value} value={value}>
                        {title(value)}
                      </SelectItem>
                    ))}
                  </Select>
                </Label>
                <Label>
                  Transition
                  <Select
                    value={selected.transition}
                    onValueChange={(value) => {
                      const transition = value as typeof selected.transition;
                      replaceStep({
                        ...selected,
                        transition,
                        durationMs: transition === 'fade' ? Math.max(selected.durationMs, 500) : 0,
                        waitForCompletion: transition === 'fade' && selected.waitForCompletion,
                      });
                    }}
                  >
                    {['none', 'fade', 'cut'].map((value) => (
                      <SelectItem key={value} value={value}>
                        {title(value)}
                      </SelectItem>
                    ))}
                  </Select>
                </Label>
                <Label>
                  Duration (ms)
                  <Input
                    disabled={selected.transition !== 'fade'}
                    type="number"
                    min="0"
                    value={selected.durationMs}
                    onChange={(event) =>
                      replaceStep({ ...selected, durationMs: Number(event.target.value) })
                    }
                  />
                </Label>
                <Label className="flex items-center gap-2">
                  Wait for completion
                  <Switch
                    disabled={selected.transition !== 'fade'}
                    checked={selected.waitForCompletion}
                    onCheckedChange={(waitForCompletion) =>
                      replaceStep({ ...selected, waitForCompletion })
                    }
                  />
                </Label>
                <Label className="flex items-center gap-2">
                  Skippable
                  <Switch
                    disabled={selected.transition !== 'fade'}
                    checked={selected.skippable}
                    onCheckedChange={(skippable) => replaceStep({ ...selected, skippable })}
                  />
                </Label>
              </>
            )}
            {selected.type === 'actor-cue' && (
              <>
                <Label>
                  Actor slot
                  <Input
                    value={selected.slotId}
                    onChange={(event) => replaceStep({ ...selected, slotId: event.target.value })}
                  />
                </Label>
                <Label>
                  Character
                  <Select
                    value={selected.character.$ref.id}
                    onValueChange={(id) => {
                      if (id) replaceStep({ ...selected, character: sceneCharacterRef(id) });
                    }}
                  >
                    {Object.entries(project.characters).map(([id, item]) => (
                      <SelectItem key={id} value={id}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </Select>
                </Label>
                <Label>
                  Action
                  <Select
                    value={selected.action}
                    onValueChange={(action) =>
                      replaceStep({ ...selected, action: action as typeof selected.action })
                    }
                  >
                    {['show', 'hide', 'move', 'profile', 'pose', 'expression', 'appearance'].map(
                      (value) => (
                        <SelectItem key={value} value={value}>
                          {title(value)}
                        </SelectItem>
                      ),
                    )}
                  </Select>
                </Label>
                <Label>
                  Profile ID
                  <Input
                    value={selected.profileId ?? ''}
                    onChange={(event) =>
                      replaceStep({ ...selected, profileId: event.target.value || null })
                    }
                  />
                </Label>
                <Label>
                  Pose ID
                  <Input
                    value={selected.poseId ?? ''}
                    onChange={(event) =>
                      replaceStep({ ...selected, poseId: event.target.value || null })
                    }
                  />
                </Label>
                <Label>
                  Appearance ID
                  <Input
                    value={selected.appearanceId ?? ''}
                    onChange={(event) =>
                      replaceStep({ ...selected, appearanceId: event.target.value || null })
                    }
                  />
                </Label>
                <Label>
                  Expression ID
                  <Input
                    value={selected.expressionId ?? ''}
                    onChange={(event) =>
                      replaceStep({ ...selected, expressionId: event.target.value || null })
                    }
                  />
                </Label>
                <Label>
                  Position
                  <Select
                    value={selected.position}
                    onValueChange={(position) =>
                      replaceStep({ ...selected, position: position as typeof selected.position })
                    }
                  >
                    {['left', 'center', 'right', 'custom'].map((value) => (
                      <SelectItem key={value} value={value}>
                        {title(value)}
                      </SelectItem>
                    ))}
                  </Select>
                </Label>
                <Label>
                  Offset X
                  <Input
                    type="number"
                    value={selected.offset.x}
                    onChange={(event) =>
                      replaceStep({
                        ...selected,
                        offset: { ...selected.offset, x: Number(event.target.value) },
                      })
                    }
                  />
                </Label>
                <Label>
                  Offset Y
                  <Input
                    type="number"
                    value={selected.offset.y}
                    onChange={(event) =>
                      replaceStep({
                        ...selected,
                        offset: { ...selected.offset, y: Number(event.target.value) },
                      })
                    }
                  />
                </Label>
                <Label>
                  Scale
                  <Input
                    type="number"
                    min="0.01"
                    step="0.05"
                    value={selected.scale}
                    onChange={(event) =>
                      replaceStep({ ...selected, scale: Number(event.target.value) })
                    }
                  />
                </Label>
                <Label>
                  Transition
                  <Select
                    value={selected.transition}
                    onValueChange={(value) => {
                      const transition = value as typeof selected.transition;
                      replaceStep({
                        ...selected,
                        transition,
                        durationMs: transition === 'none' ? 0 : Math.max(selected.durationMs, 300),
                        waitForCompletion: transition !== 'none' && selected.waitForCompletion,
                      });
                    }}
                  >
                    {['none', 'fade', 'slide'].map((value) => (
                      <SelectItem key={value} value={value}>
                        {title(value)}
                      </SelectItem>
                    ))}
                  </Select>
                </Label>
                <Label>
                  Duration (ms)
                  <Input
                    disabled={selected.transition === 'none'}
                    type="number"
                    min="0"
                    value={selected.durationMs}
                    onChange={(event) =>
                      replaceStep({ ...selected, durationMs: Number(event.target.value) })
                    }
                  />
                </Label>
                <Label className="flex items-center gap-2">
                  Wait for completion
                  <Switch
                    disabled={selected.transition === 'none'}
                    checked={selected.waitForCompletion}
                    onCheckedChange={(waitForCompletion) =>
                      replaceStep({ ...selected, waitForCompletion })
                    }
                  />
                </Label>
                <Label className="flex items-center gap-2">
                  Skippable
                  <Switch
                    disabled={selected.transition === 'none'}
                    checked={selected.skippable}
                    onCheckedChange={(skippable) => replaceStep({ ...selected, skippable })}
                  />
                </Label>
              </>
            )}
            {selected.type === 'call-dialogue' && (
              <>
                <Label>
                  Dialogue
                  <Select
                    value={selected.dialogue.$ref.id}
                    onValueChange={(id) => {
                      if (id) replaceStep({ ...selected, dialogue: sceneDialogueRef(id) });
                    }}
                  >
                    {Object.entries(project.dialogues).map(([id, item]) => (
                      <SelectItem key={id} value={id}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </Select>
                </Label>
                <Label>
                  Start block ID
                  <Input
                    value={selected.startBlockId ?? ''}
                    onChange={(event) =>
                      replaceStep({ ...selected, startBlockId: event.target.value || null })
                    }
                  />
                </Label>
              </>
            )}
            {(selected.type === 'call-scene' || selected.type === 'start-detached-scene') && (
              <>
                <Label>
                  Scene
                  <Select
                    value={selected.scene.$ref.id}
                    onValueChange={(id) => {
                      if (id) replaceStep({ ...selected, scene: sceneSceneRef(id), inputs: [] });
                    }}
                  >
                    {Object.entries(project.scenes)
                      .filter(([id]) => id !== sceneId)
                      .map(([id, item]) => (
                        <SelectItem key={id} value={id}>
                          {item.label}
                        </SelectItem>
                      ))}
                  </Select>
                </Label>
                {selected.type === 'start-detached-scene' ? (
                  <Label>
                    Ownership
                    <Select
                      value={selected.owner}
                      onValueChange={(owner) =>
                        replaceStep({
                          ...selected,
                          owner: owner as typeof selected.owner,
                        })
                      }
                    >
                      <SelectItem value="flow">Flow</SelectItem>
                      <SelectItem value="active-room">Active Room</SelectItem>
                      <SelectItem value="runtime-session">Runtime Session</SelectItem>
                    </Select>
                  </Label>
                ) : null}
                <div className="space-y-2 rounded border p-2">
                  <span className="text-xs font-medium">Input bindings</span>
                  {(parseSceneData(project.scenes[selected.scene.$ref.id]?.data)?.inputs ?? []).map(
                    (input) => {
                      const binding = selected.inputs.find(
                        (candidate) => candidate.inputId === input.id,
                      );
                      return (
                        <Label key={input.id}>
                          {input.label} ({input.type})
                          <Input
                            value={sceneInputText(binding?.value)}
                            placeholder={input.nullable ? 'null' : input.id}
                            onChange={(event) => {
                              const value = parseSceneInputValue(input, event.target.value);
                              const inputs = selected.inputs.filter(
                                (candidate) => candidate.inputId !== input.id,
                              );
                              if (value !== undefined) inputs.push({ inputId: input.id, value });
                              replaceStep({ ...selected, inputs });
                            }}
                          />
                        </Label>
                      );
                    },
                  )}
                </div>
              </>
            )}
            {selected.type === 'show-text' && (
              <>
                <Label>
                  Text source
                  <Select
                    value={selected.text.source.kind}
                    onValueChange={(kind) =>
                      replaceStep({
                        ...selected,
                        text: {
                          ...selected.text,
                          source:
                            kind === 'inline'
                              ? { kind, text: '' }
                              : kind === 'localized'
                                ? { kind, key: 'text-key' }
                                : { kind: 'lua-expression', source: '-- return text' },
                        },
                      })
                    }
                  >
                    <SelectItem value="inline">Inline</SelectItem>
                    <SelectItem value="localized">Localized</SelectItem>
                    <SelectItem value="lua-expression">Lua expression</SelectItem>
                  </Select>
                </Label>
                <Label>
                  Text
                  <Input
                    value={
                      selected.text.source.kind === 'inline'
                        ? selected.text.source.text
                        : selected.text.source.kind === 'localized'
                          ? selected.text.source.key
                          : selected.text.source.source
                    }
                    onChange={(event) =>
                      replaceStep({
                        ...selected,
                        text: {
                          ...selected.text,
                          source:
                            selected.text.source.kind === 'inline'
                              ? { ...selected.text.source, text: event.target.value }
                              : selected.text.source.kind === 'localized'
                                ? { ...selected.text.source, key: event.target.value }
                                : { ...selected.text.source, source: event.target.value },
                        },
                      })
                    }
                  />
                </Label>
                <Label>
                  Markup
                  <Select
                    value={selected.text.markup}
                    onValueChange={(markup) =>
                      replaceStep({
                        ...selected,
                        text: { ...selected.text, markup: markup as typeof selected.text.markup },
                      })
                    }
                  >
                    <SelectItem value="plain">Plain</SelectItem>
                    <SelectItem value="active-text">Active text</SelectItem>
                  </Select>
                </Label>
                <Label>
                  Speaker
                  <Select
                    value={refId(selected.speaker)}
                    onValueChange={(id) => {
                      if (id)
                        replaceStep({
                          ...selected,
                          speaker: id === '__none__' ? null : sceneCharacterRef(id),
                        });
                    }}
                  >
                    <SelectItem value="__none__">None</SelectItem>
                    {Object.entries(project.characters).map(([id, item]) => (
                      <SelectItem key={id} value={id}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </Select>
                </Label>
                <Label>
                  Wait
                  <Select
                    value={selected.wait}
                    onValueChange={(wait) =>
                      replaceStep({ ...selected, wait: wait as typeof selected.wait })
                    }
                  >
                    <SelectItem value="input">Input</SelectItem>
                    <SelectItem value="immediate">Immediate</SelectItem>
                  </Select>
                </Label>
              </>
            )}
            {selected.type === 'audio-cue' && (
              <>
                <Label>
                  Asset
                  <Select
                    value={refId(selected.asset)}
                    onValueChange={(id) => {
                      if (id)
                        replaceStep({
                          ...selected,
                          asset: id === '__none__' ? null : sceneAssetRef(id),
                        });
                    }}
                  >
                    <SelectItem value="__none__">None</SelectItem>
                    {Object.entries(project.assets).map(([id, item]) => (
                      <SelectItem key={id} value={id}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </Select>
                </Label>
                <Label>
                  Purpose
                  <Select
                    value={selected.purpose}
                    onValueChange={(purpose) =>
                      replaceStep({ ...selected, purpose: purpose as typeof selected.purpose })
                    }
                  >
                    {['music', 'ambience', 'voice', 'sound-effect', 'ui-sound'].map((value) => (
                      <SelectItem key={value} value={value}>
                        {title(value)}
                      </SelectItem>
                    ))}
                  </Select>
                </Label>
                <Label>
                  Lifetime
                  <Select
                    value={selected.lifetime}
                    onValueChange={(lifetime) =>
                      replaceStep({ ...selected, lifetime: lifetime as typeof selected.lifetime })
                    }
                  >
                    <SelectItem value="desired-loop">Desired loop</SelectItem>
                    <SelectItem value="one-shot">One shot</SelectItem>
                  </Select>
                </Label>
                <Label>
                  Action
                  <Select
                    value={selected.action}
                    onValueChange={(action) =>
                      replaceStep({ ...selected, action: action as typeof selected.action })
                    }
                  >
                    {['play', 'stop', 'fade-in', 'fade-out'].map((value) => (
                      <SelectItem key={value} value={value}>
                        {title(value)}
                      </SelectItem>
                    ))}
                  </Select>
                </Label>
                <Label>
                  Pause policy
                  <Select
                    value={selected.pausePolicy}
                    onValueChange={(pausePolicy) =>
                      replaceStep({
                        ...selected,
                        pausePolicy: pausePolicy as typeof selected.pausePolicy,
                      })
                    }
                  >
                    <SelectItem value="gameplay">Follow gameplay pause</SelectItem>
                    <SelectItem value="owner">Follow owner policy</SelectItem>
                    <SelectItem value="unscaled">Continue while paused</SelectItem>
                  </Select>
                </Label>
                <Label>
                  Gain
                  <Input
                    type="number"
                    min="0"
                    max="1"
                    step="0.05"
                    value={selected.gain}
                    onChange={(event) =>
                      replaceStep({ ...selected, gain: Number(event.target.value) })
                    }
                  />
                </Label>
                <Label>
                  Stereo pan
                  <Input
                    type="number"
                    min="-1"
                    max="1"
                    step="0.05"
                    value={selected.pan}
                    onChange={(event) =>
                      replaceStep({ ...selected, pan: Number(event.target.value) })
                    }
                  />
                </Label>
                <Label>
                  Pan Source
                  <Select
                    value={selected.panSource?.kind ?? '__none__'}
                    onValueChange={(kind) => {
                      if (kind === '__none__') {
                        replaceStep({ ...selected, panSource: null });
                        return;
                      }
                      if (kind === 'scene-actor') {
                        const slotId = sceneActorSlots[0];
                        if (slotId)
                          replaceStep({
                            ...selected,
                            panSource: { kind: 'scene-actor', slotId },
                          });
                        return;
                      }
                      const anchor = roomAnchorOptions[0];
                      if (anchor)
                        replaceStep({
                          ...selected,
                          panSource: {
                            kind: 'room-anchor',
                            room: sceneRoomRef(anchor.roomId),
                            anchorId: anchor.anchorId,
                          },
                        });
                    }}
                  >
                    <SelectItem value="__none__">Fixed pan only</SelectItem>
                    {sceneActorSlots.length > 0 ? (
                      <SelectItem value="scene-actor">Scene Actor</SelectItem>
                    ) : null}
                    {roomAnchorOptions.length > 0 ? (
                      <SelectItem value="room-anchor">Room Anchor</SelectItem>
                    ) : null}
                  </Select>
                </Label>
                {selected.panSource?.kind === 'scene-actor' ? (
                  <Label>
                    Scene Actor slot
                    <Select
                      value={selected.panSource.slotId}
                      onValueChange={(slotId) => {
                        if (slotId)
                          replaceStep({
                            ...selected,
                            panSource: { kind: 'scene-actor', slotId },
                          });
                      }}
                    >
                      {sceneActorSlots.map((slotId) => (
                        <SelectItem key={slotId} value={slotId}>
                          {slotId}
                        </SelectItem>
                      ))}
                    </Select>
                  </Label>
                ) : null}
                {selected.panSource?.kind === 'room-anchor' ? (
                  <Label>
                    Room Anchor
                    <Select
                      value={`${selected.panSource.room.$ref.id}\t${selected.panSource.anchorId}`}
                      onValueChange={(value) => {
                        const anchor = roomAnchorOptions.find(
                          (candidate) => `${candidate.roomId}\t${candidate.anchorId}` === value,
                        );
                        if (anchor)
                          replaceStep({
                            ...selected,
                            panSource: {
                              kind: 'room-anchor',
                              room: sceneRoomRef(anchor.roomId),
                              anchorId: anchor.anchorId,
                            },
                          });
                      }}
                    >
                      {roomAnchorOptions.map((anchor) => (
                        <SelectItem
                          key={`${anchor.roomId}:${anchor.anchorId}`}
                          value={`${anchor.roomId}\t${anchor.anchorId}`}
                        >
                          {anchor.roomLabel} · {anchor.anchorId}
                        </SelectItem>
                      ))}
                    </Select>
                  </Label>
                ) : null}
                <Label>
                  Fade (ms)
                  <Input
                    type="number"
                    min="0"
                    value={selected.fadeMs}
                    onChange={(event) =>
                      replaceStep({ ...selected, fadeMs: Number(event.target.value) })
                    }
                  />
                </Label>
                {selected.lifetime === 'desired-loop' ? (
                  <>
                    <Label>
                      Instance ID
                      <Input
                        value={selected.instanceId ?? ''}
                        placeholder="music-main"
                        onChange={(event) =>
                          replaceStep({ ...selected, instanceId: event.target.value || null })
                        }
                      />
                    </Label>
                    <Label>
                      Replacement group
                      <Input
                        value={selected.replacementGroup ?? ''}
                        placeholder="Optional"
                        onChange={(event) =>
                          replaceStep({
                            ...selected,
                            replacementGroup: event.target.value || null,
                          })
                        }
                      />
                    </Label>
                  </>
                ) : (
                  <>
                    <Label>
                      Causality
                      <Select
                        value={selected.causality}
                        onValueChange={(causality) =>
                          replaceStep({
                            ...selected,
                            causality: causality as typeof selected.causality,
                          })
                        }
                      >
                        <SelectItem value="causal">Causal</SelectItem>
                        <SelectItem value="disposable">Disposable</SelectItem>
                      </Select>
                    </Label>
                    <Label>
                      Skip behavior
                      <Select
                        value={selected.skipBehavior}
                        onValueChange={(skipBehavior) =>
                          replaceStep({
                            ...selected,
                            skipBehavior: skipBehavior as typeof selected.skipBehavior,
                          })
                        }
                      >
                        <SelectItem value="suppress">Suppress if not started</SelectItem>
                        <SelectItem value="stop">Stop if started</SelectItem>
                        <SelectItem value="play">Play on skip</SelectItem>
                      </Select>
                    </Label>
                    <Label className="flex items-center gap-2">
                      Synchronized cue
                      <Switch
                        checked={selected.synchronized}
                        onCheckedChange={(synchronized) =>
                          replaceStep({ ...selected, synchronized })
                        }
                      />
                    </Label>
                  </>
                )}
                <Label className="flex items-center gap-2">
                  Wait for completion
                  <Switch
                    checked={selected.waitForCompletion}
                    onCheckedChange={(waitForCompletion) =>
                      replaceStep({ ...selected, waitForCompletion })
                    }
                  />
                </Label>
              </>
            )}
            {selected.type === 'set-variable' && (
              <>
                <Label>
                  Variable
                  <Select
                    value={selected.variable.$ref.id}
                    onValueChange={(id) => {
                      if (id) replaceStep({ ...selected, variable: sceneVariableRef(id) });
                    }}
                  >
                    {Object.entries(project.variables).map(([id, item]) => (
                      <SelectItem key={id} value={id}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </Select>
                </Label>
                <Label>
                  Value
                  <Input
                    value={String(selected.value)}
                    onChange={(event) =>
                      replaceStep({ ...selected, value: scalar(event.target.value) })
                    }
                  />
                </Label>
              </>
            )}
            {selected.type === 'run-lua' && (
              <>
                <Label>
                  Lua source
                  <textarea
                    className="min-h-32 w-full rounded border bg-background p-2 font-mono text-sm"
                    value={selected.source}
                    onChange={(event) => replaceStep({ ...selected, source: event.target.value })}
                  />
                </Label>
                <Label className="flex items-center gap-2">
                  May yield
                  <Switch
                    checked={selected.mayYield}
                    onCheckedChange={(mayYield) => replaceStep({ ...selected, mayYield })}
                  />
                </Label>
              </>
            )}
            {selected.type === 'wait' && (
              <>
                <Label>
                  Wait kind
                  <Select
                    value={selected.waitKind}
                    onValueChange={(kind) => {
                      const common = {
                        id: selected.id,
                        label: selected.label,
                        type: 'wait' as const,
                        enabled: selected.enabled,
                        condition: selected.condition,
                        timeline: selected.timeline,
                        completionDependencies: selected.completionDependencies,
                        skippable: selected.skippable,
                      };
                      if (kind === 'input') replaceStep({ ...common, waitKind: 'input' });
                      else if (kind === 'condition')
                        replaceStep({
                          ...common,
                          waitKind: 'condition',
                          waitCondition: { kind: 'always' },
                        });
                      else if (kind === 'operation')
                        replaceStep({
                          ...common,
                          waitKind: 'operation',
                          eventId: data.events[0]?.id ?? selected.id,
                        });
                      else if (kind === 'audio')
                        replaceStep({
                          ...common,
                          waitKind: 'audio',
                          eventId: data.events[0]?.id ?? selected.id,
                        });
                      else if (kind === 'layout-signal')
                        replaceStep({
                          ...common,
                          waitKind: 'layout-signal',
                          owner: 'invocation',
                          slot: 'custom',
                          signalId: 'signal',
                        });
                      else replaceStep({ ...common, waitKind: 'duration', durationMs: 1000 });
                    }}
                  >
                    <SelectItem value="duration">Duration</SelectItem>
                    <SelectItem value="input">Input</SelectItem>
                    <SelectItem value="condition">Condition</SelectItem>
                    <SelectItem value="operation">Presentation Operation</SelectItem>
                    <SelectItem value="audio">Audio Operation</SelectItem>
                    <SelectItem value="layout-signal">Layout Signal</SelectItem>
                  </Select>
                </Label>
                {selected.waitKind === 'duration' && (
                  <Label>
                    Duration (ms)
                    <Input
                      type="number"
                      min="0"
                      value={selected.durationMs}
                      onChange={(event) =>
                        replaceStep({ ...selected, durationMs: Number(event.target.value) })
                      }
                    />
                  </Label>
                )}
                {selected.waitKind === 'condition' &&
                  conditionEditor(selected.waitCondition, (waitCondition) =>
                    waitCondition ? replaceStep({ ...selected, waitCondition }) : undefined,
                  )}
                {(selected.waitKind === 'operation' || selected.waitKind === 'audio') && (
                  <Label>
                    Event
                    <Select
                      value={selected.eventId}
                      onValueChange={(eventId) => {
                        if (eventId) replaceStep({ ...selected, eventId });
                      }}
                    >
                      {data.events
                        .filter((step) => step.id !== selected.id)
                        .map((step) => (
                          <SelectItem key={step.id} value={step.id}>
                            {step.label}
                          </SelectItem>
                        ))}
                    </Select>
                  </Label>
                )}
                {selected.waitKind === 'layout-signal' && (
                  <>
                    <Label>
                      Mount ownership
                      <Select
                        value={selected.owner}
                        onValueChange={(owner) =>
                          replaceStep({ ...selected, owner: owner as typeof selected.owner })
                        }
                      >
                        <SelectItem value="invocation">Scene Invocation</SelectItem>
                        <SelectItem value="active-room">Active Room</SelectItem>
                        <SelectItem value="runtime-session">Runtime Session</SelectItem>
                      </Select>
                    </Label>
                    <Label>
                      Mount slot
                      <Select
                        value={selected.slot}
                        onValueChange={(slot) =>
                          replaceStep({ ...selected, slot: slot as typeof selected.slot })
                        }
                      >
                        <SelectItem value="hud">HUD</SelectItem>
                        <SelectItem value="dialogue-box">Dialogue Box</SelectItem>
                        <SelectItem value="overlay">Overlay</SelectItem>
                        <SelectItem value="custom">Custom</SelectItem>
                      </Select>
                    </Label>
                    <Label>
                      Signal ID
                      <Input
                        value={selected.signalId}
                        onChange={(event) =>
                          replaceStep({ ...selected, signalId: event.target.value })
                        }
                      />
                    </Label>
                  </>
                )}
              </>
            )}
            {selected.type === 'conditional-branch' && (
              <>
                <Label>
                  Fallback step
                  <Select
                    value={selected.fallbackStepId}
                    onValueChange={(fallbackStepId) => {
                      if (fallbackStepId) replaceStep({ ...selected, fallbackStepId });
                    }}
                  >
                    {data.events.map((step) => (
                      <SelectItem key={step.id} value={step.id}>
                        {step.label}
                      </SelectItem>
                    ))}
                  </Select>
                </Label>
                <Button
                  variant="outline"
                  onClick={() =>
                    replaceStep({
                      ...selected,
                      branches: [
                        ...selected.branches,
                        {
                          id: uniqueNestedId(
                            selected.branches.map((branch) => branch.id),
                            'branch',
                          ),
                          condition: { kind: 'always' },
                          targetStepId: data.events[0]!.id,
                        },
                      ],
                    })
                  }
                >
                  Add branch
                </Button>
                {selected.branches.map((branch, index) => (
                  <div key={branch.id} className="space-y-2 rounded border p-2">
                    <Label>
                      Branch ID
                      <Input
                        value={branch.id}
                        onChange={(event) =>
                          replaceStep({
                            ...selected,
                            branches: selected.branches.map((item, itemIndex) =>
                              itemIndex === index ? { ...item, id: event.target.value } : item,
                            ),
                          })
                        }
                      />
                    </Label>
                    {conditionEditor(
                      branch.condition,
                      (condition) =>
                        condition &&
                        replaceStep({
                          ...selected,
                          branches: selected.branches.map((item, itemIndex) =>
                            itemIndex === index ? { ...item, condition } : item,
                          ),
                        }),
                    )}
                    <Label>
                      Target
                      <Select
                        value={branch.targetStepId}
                        onValueChange={(targetStepId) => {
                          if (targetStepId)
                            replaceStep({
                              ...selected,
                              branches: selected.branches.map((item, itemIndex) =>
                                itemIndex === index ? { ...item, targetStepId } : item,
                              ),
                            });
                        }}
                      >
                        {data.events.map((step) => (
                          <SelectItem key={step.id} value={step.id}>
                            {step.label}
                          </SelectItem>
                        ))}
                      </Select>
                    </Label>
                  </div>
                ))}
              </>
            )}
            {selected.type === 'choice' && (
              <>
                <Button
                  variant="outline"
                  onClick={() =>
                    replaceStep({
                      ...selected,
                      options: [
                        ...selected.options,
                        {
                          id: uniqueNestedId(
                            selected.options.map((option) => option.id),
                            'option',
                          ),
                          label: {
                            source: { kind: 'inline', text: 'Option' },
                            markup: 'active-text',
                          },
                          effects: [],
                          targetStepId: data.events[0]!.id,
                        },
                      ],
                    })
                  }
                >
                  Add option
                </Button>
                {selected.options.map((option, index) => (
                  <div key={option.id} className="space-y-2 rounded border p-2">
                    <Label>
                      Option ID
                      <Input
                        value={option.id}
                        onChange={(event) =>
                          replaceStep({
                            ...selected,
                            options: selected.options.map((item, itemIndex) =>
                              itemIndex === index ? { ...item, id: event.target.value } : item,
                            ),
                          })
                        }
                      />
                    </Label>
                    <Input
                      value={option.label.source.kind === 'inline' ? option.label.source.text : ''}
                      onChange={(event) =>
                        replaceStep({
                          ...selected,
                          options: selected.options.map((item, itemIndex) =>
                            itemIndex === index
                              ? {
                                  ...item,
                                  label: {
                                    source: { kind: 'inline', text: event.target.value },
                                    markup: item.label.markup,
                                  },
                                }
                              : item,
                          ),
                        })
                      }
                    />
                    {conditionEditor(option.condition, (condition) =>
                      replaceStep({
                        ...selected,
                        options: selected.options.map((item, itemIndex) =>
                          itemIndex === index ? { ...item, condition } : item,
                        ),
                      }),
                    )}
                    <Select
                      value={option.targetStepId}
                      onValueChange={(targetStepId) => {
                        if (targetStepId)
                          replaceStep({
                            ...selected,
                            options: selected.options.map((item, itemIndex) =>
                              itemIndex === index ? { ...item, targetStepId } : item,
                            ),
                          });
                      }}
                    >
                      {data.events.map((step) => (
                        <SelectItem key={step.id} value={step.id}>
                          {step.label}
                        </SelectItem>
                      ))}
                    </Select>
                    <Button
                      variant="outline"
                      onClick={() =>
                        replaceStep({
                          ...selected,
                          options: selected.options.map((item, itemIndex) =>
                            itemIndex === index
                              ? {
                                  ...item,
                                  effects: [
                                    ...item.effects,
                                    { kind: 'run-lua-effect', source: '-- Lua effect' },
                                  ],
                                }
                              : item,
                          ),
                        })
                      }
                    >
                      Add effect
                    </Button>
                    {option.effects.map((effect, effectIndex) => (
                      <div key={effectIndex}>
                        {effectEditor(effect, (next) =>
                          replaceStep({
                            ...selected,
                            options: selected.options.map((item, itemIndex) =>
                              itemIndex === index
                                ? {
                                    ...item,
                                    effects: item.effects.map((current, currentIndex) =>
                                      currentIndex === effectIndex ? next : current,
                                    ),
                                  }
                                : item,
                            ),
                          }),
                        )}
                      </div>
                    ))}
                  </div>
                ))}
              </>
            )}
            {selected.type === 'set-layout' && (
              <>
                <Label>
                  Layout
                  <Select
                    value={refId(selected.layout)}
                    onValueChange={(id) => {
                      if (id)
                        replaceStep({
                          ...selected,
                          layout: id === '__none__' ? null : sceneLayoutRef(id),
                        });
                    }}
                  >
                    <SelectItem value="__none__">None</SelectItem>
                    {Object.entries(project.layouts).map(([id, item]) => (
                      <SelectItem key={id} value={id}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </Select>
                </Label>
                <Label>
                  Action
                  <Select
                    value={selected.action}
                    onValueChange={(action) =>
                      replaceStep({ ...selected, action: action as typeof selected.action })
                    }
                  >
                    {['show', 'hide', 'swap'].map((value) => (
                      <SelectItem key={value} value={value}>
                        {title(value)}
                      </SelectItem>
                    ))}
                  </Select>
                </Label>
                <Label>
                  Slot
                  <Select
                    value={selected.slot}
                    onValueChange={(slot) =>
                      replaceStep({ ...selected, slot: slot as typeof selected.slot })
                    }
                  >
                    {['hud', 'dialogue-box', 'overlay', 'custom'].map((value) => (
                      <SelectItem key={value} value={value}>
                        {title(value)}
                      </SelectItem>
                    ))}
                  </Select>
                </Label>
                <Label>
                  Transition
                  <Select
                    value={selected.transition}
                    onValueChange={(value) => {
                      const transition = value as typeof selected.transition;
                      replaceStep({
                        ...selected,
                        transition,
                        durationMs: transition === 'fade' ? Math.max(selected.durationMs, 250) : 0,
                        waitForCompletion: transition === 'fade' && selected.waitForCompletion,
                      });
                    }}
                  >
                    <SelectItem value="none">None</SelectItem>
                    <SelectItem value="fade">Fade</SelectItem>
                  </Select>
                </Label>
                <Label>
                  Duration (ms)
                  <Input
                    disabled={selected.transition === 'none'}
                    type="number"
                    min="0"
                    value={selected.durationMs}
                    onChange={(event) =>
                      replaceStep({ ...selected, durationMs: Number(event.target.value) })
                    }
                  />
                </Label>
                <Label className="flex items-center gap-2">
                  Wait for completion
                  <Switch
                    disabled={selected.transition === 'none'}
                    checked={selected.waitForCompletion}
                    onCheckedChange={(waitForCompletion) =>
                      replaceStep({ ...selected, waitForCompletion })
                    }
                  />
                </Label>
                <Label className="flex items-center gap-2">
                  Skippable
                  <Switch
                    disabled={selected.transition === 'none'}
                    checked={selected.skippable}
                    onCheckedChange={(skippable) => replaceStep({ ...selected, skippable })}
                  />
                </Label>
              </>
            )}
            {selected.type === 'material-parameter' &&
              (() => {
                const targetKey =
                  selected.target.kind === 'background'
                    ? 'background'
                    : selected.target.kind === 'actor'
                      ? `actor:${selected.target.slotId}:${selected.target.layerId}`
                      : selected.target.kind === 'layout'
                        ? `layout:${selected.target.slot}`
                        : `postprocess:${selected.target.instanceId}`;
                const allowedRoles =
                  selected.target.kind === 'layout'
                    ? new Set(['rmlui-decorator'])
                    : selected.target.kind === 'postprocess'
                      ? new Set(['postprocess'])
                      : new Set(['engine-2d']);
                const materialIds = Object.keys(project.materials).filter((id) => {
                  const role = resolveMaterialData(project, id).data?.role;
                  return role ? allowedRoles.has(role) : false;
                });
                const uniforms = materialUniforms(project, selected.material.$ref.id);
                const uniform = uniforms.find((item) => item.name === selected.parameter);
                const tweenable = uniform ? !['bool', 'int'].includes(uniform.type) : false;
                return (
                  <>
                    <Label>
                      Target
                      <Select
                        value={targetKey}
                        onValueChange={(value) => {
                          if (!value) return;
                          let target: typeof selected.target;
                          if (value === 'background') target = { kind: 'background' };
                          else if (value.startsWith('actor:')) {
                            const [, slotId = '', layerId = 'body'] = value.split(':');
                            target = {
                              kind: 'actor',
                              slotId,
                              layerId,
                            };
                          } else if (value.startsWith('layout:')) {
                            const [, slot = 'overlay'] = value.split(':');
                            target = {
                              kind: 'layout',
                              slot: slot as Extract<
                                typeof selected.target,
                                { kind: 'layout' }
                              >['slot'],
                            };
                          } else {
                            target = {
                              kind: 'postprocess',
                              instanceId: value.slice('postprocess:'.length),
                            };
                          }
                          const roles =
                            target.kind === 'layout'
                              ? new Set(['rmlui-decorator'])
                              : target.kind === 'postprocess'
                                ? new Set(['postprocess'])
                                : new Set(['engine-2d']);
                          const nextMaterial = Object.keys(project.materials).find((id) => {
                            const role = resolveMaterialData(project, id).data?.role;
                            return role ? roles.has(role) : false;
                          });
                          if (!nextMaterial) {
                            replaceStep({ ...selected, target });
                            return;
                          }
                          const nextUniform = materialUniforms(project, nextMaterial)[0];
                          replaceStep({
                            ...selected,
                            target,
                            material: sceneMaterialRef(nextMaterial),
                            parameter: nextUniform?.name ?? selected.parameter,
                            value: nextUniform ? defaultUniformValue(nextUniform) : selected.value,
                            transition:
                              nextUniform && ['bool', 'int'].includes(nextUniform.type)
                                ? 'none'
                                : selected.transition,
                            durationMs:
                              nextUniform && ['bool', 'int'].includes(nextUniform.type)
                                ? 0
                                : selected.durationMs,
                            waitForCompletion:
                              nextUniform && ['bool', 'int'].includes(nextUniform.type)
                                ? false
                                : selected.waitForCompletion,
                          });
                        }}
                      >
                        <SelectItem value="background">Background</SelectItem>
                        {sceneActorSlots.map((slotId) => (
                          <SelectItem key={`${slotId}-body`} value={`actor:${slotId}:body`}>
                            Actor {slotId} / body
                          </SelectItem>
                        ))}
                        {(['hud', 'dialogue-box', 'overlay', 'custom'] as const).map((slot) => (
                          <SelectItem key={slot} value={`layout:${slot}`}>
                            Layout / {title(slot)}
                          </SelectItem>
                        ))}
                        {data.events
                          .filter((step) => step.type === 'postprocess-effect')
                          .map((step) => (
                            <SelectItem
                              key={step.instanceId}
                              value={`postprocess:${step.instanceId}`}
                            >
                              Postprocess / {step.instanceId}
                            </SelectItem>
                          ))}
                      </Select>
                    </Label>
                    <Label>
                      Material
                      <Select
                        value={selected.material.$ref.id}
                        onValueChange={(materialId) => {
                          if (!materialId) return;
                          const nextUniform = materialUniforms(project, materialId)[0];
                          replaceStep({
                            ...selected,
                            material: sceneMaterialRef(materialId),
                            parameter: nextUniform?.name ?? selected.parameter,
                            value: nextUniform ? defaultUniformValue(nextUniform) : selected.value,
                            transition:
                              nextUniform && ['bool', 'int'].includes(nextUniform.type)
                                ? 'none'
                                : selected.transition,
                            durationMs:
                              nextUniform && ['bool', 'int'].includes(nextUniform.type)
                                ? 0
                                : selected.durationMs,
                            waitForCompletion:
                              nextUniform && ['bool', 'int'].includes(nextUniform.type)
                                ? false
                                : selected.waitForCompletion,
                          });
                        }}
                      >
                        {materialIds.map((id) => (
                          <SelectItem key={id} value={id}>
                            {project.materials[id]?.label ?? id}
                          </SelectItem>
                        ))}
                      </Select>
                    </Label>
                    <Label>
                      Parameter
                      <Select
                        value={selected.parameter}
                        onValueChange={(parameter) => {
                          if (!parameter) return;
                          const nextUniform = uniforms.find((item) => item.name === parameter);
                          replaceStep({
                            ...selected,
                            parameter,
                            value: defaultUniformValue(nextUniform),
                            transition:
                              nextUniform && ['bool', 'int'].includes(nextUniform.type)
                                ? 'none'
                                : selected.transition,
                            durationMs:
                              nextUniform && ['bool', 'int'].includes(nextUniform.type)
                                ? 0
                                : selected.durationMs,
                            waitForCompletion:
                              nextUniform && ['bool', 'int'].includes(nextUniform.type)
                                ? false
                                : selected.waitForCompletion,
                          });
                        }}
                      >
                        {uniforms.map((item) => (
                          <SelectItem key={item.name} value={item.name}>
                            {item.label ?? item.name} ({item.type})
                          </SelectItem>
                        ))}
                      </Select>
                    </Label>
                    <Label>
                      Value
                      {uniform?.type === 'bool' ? (
                        <Select
                          value={selected.value === true ? 'true' : 'false'}
                          onValueChange={(value) =>
                            replaceStep({ ...selected, value: value === 'true' })
                          }
                        >
                          <SelectItem value="false">False</SelectItem>
                          <SelectItem value="true">True</SelectItem>
                        </Select>
                      ) : (
                        <Input
                          value={uniformValueText(selected.value)}
                          onChange={(event) => {
                            const value = parseUniformValue(event.target.value, uniform);
                            if (value !== null) replaceStep({ ...selected, value });
                          }}
                        />
                      )}
                    </Label>
                    <Label>
                      Transition
                      <Select
                        value={selected.transition}
                        onValueChange={(value) => {
                          const transition = value === 'tween' && tweenable ? 'tween' : 'none';
                          replaceStep({
                            ...selected,
                            transition,
                            durationMs:
                              transition === 'tween' ? Math.max(1, selected.durationMs || 250) : 0,
                            waitForCompletion:
                              transition === 'tween' ? selected.waitForCompletion : false,
                          });
                        }}
                      >
                        <SelectItem value="none">Immediate</SelectItem>
                        <SelectItem value="tween" disabled={!tweenable}>
                          Tween
                        </SelectItem>
                      </Select>
                    </Label>
                    {selected.transition === 'tween' && (
                      <>
                        <Label>
                          Duration (ms)
                          <Input
                            type="number"
                            min="1"
                            value={selected.durationMs}
                            onChange={(event) =>
                              replaceStep({ ...selected, durationMs: Number(event.target.value) })
                            }
                          />
                        </Label>
                        <Label>
                          Easing
                          <Select
                            value={selected.easing}
                            onValueChange={(easing) =>
                              replaceStep({ ...selected, easing: easing as typeof selected.easing })
                            }
                          >
                            {['linear', 'ease-in', 'ease-out', 'ease-in-out'].map((value) => (
                              <SelectItem key={value} value={value}>
                                {title(value)}
                              </SelectItem>
                            ))}
                          </Select>
                        </Label>
                        <Label className="flex items-center gap-2">
                          Wait for completion
                          <Switch
                            checked={selected.waitForCompletion}
                            onCheckedChange={(waitForCompletion) =>
                              replaceStep({ ...selected, waitForCompletion })
                            }
                          />
                        </Label>
                        <Label className="flex items-center gap-2">
                          Skippable
                          <Switch
                            checked={selected.skippable}
                            onCheckedChange={(skippable) => replaceStep({ ...selected, skippable })}
                          />
                        </Label>
                      </>
                    )}
                    <Label>
                      Material clock
                      <Select
                        value={selected.clock}
                        onValueChange={(clock) =>
                          replaceStep({ ...selected, clock: clock as typeof selected.clock })
                        }
                      >
                        <SelectItem value="gameplay">Gameplay</SelectItem>
                        <SelectItem value="unscaled-presentation">Unscaled Presentation</SelectItem>
                      </Select>
                    </Label>
                  </>
                );
              })()}
            {selected.type === 'postprocess-effect' &&
              (() => {
                const postprocessMaterials = Object.keys(project.materials).filter(
                  (id) => resolveMaterialData(project, id).data?.role === 'postprocess',
                );
                const materialId = selected.material?.$ref.id ?? '';
                const uniforms = materialId ? materialUniforms(project, materialId) : [];
                return (
                  <>
                    <Label>
                      Action
                      <Select
                        value={selected.action}
                        onValueChange={(value) => {
                          const action = value === 'upsert' ? 'upsert' : 'remove';
                          if (action === 'remove') {
                            replaceStep({ ...selected, action, material: null, parameters: [] });
                            return;
                          }
                          const nextMaterial = materialId || postprocessMaterials[0] || '';
                          const material = nextMaterial
                            ? resolveMaterialData(project, nextMaterial).data
                            : null;
                          replaceStep({
                            ...selected,
                            action,
                            material: nextMaterial ? sceneMaterialRef(nextMaterial) : null,
                            scope: material?.postprocessScope ?? selected.scope,
                          });
                        }}
                      >
                        <SelectItem value="upsert">Add / Update</SelectItem>
                        <SelectItem value="remove">Remove</SelectItem>
                      </Select>
                    </Label>
                    <Label>
                      Stable effect ID
                      <Input
                        value={selected.instanceId}
                        onChange={(event) =>
                          replaceStep({ ...selected, instanceId: event.target.value })
                        }
                      />
                    </Label>
                    {selected.action === 'upsert' && (
                      <>
                        <Label>
                          Material
                          <Select
                            value={materialId}
                            onValueChange={(id) => {
                              if (!id) return;
                              const material = resolveMaterialData(project, id).data;
                              replaceStep({
                                ...selected,
                                material: sceneMaterialRef(id),
                                scope: material?.postprocessScope ?? selected.scope,
                                parameters: [],
                              });
                            }}
                          >
                            {postprocessMaterials.map((id) => (
                              <SelectItem key={id} value={id}>
                                {project.materials[id]?.label ?? id}
                              </SelectItem>
                            ))}
                          </Select>
                        </Label>
                        <Label>
                          Scope
                          <Select value={selected.scope} disabled>
                            <SelectItem value="world">World</SelectItem>
                            <SelectItem value="full-game-viewport">Full Game Viewport</SelectItem>
                          </Select>
                        </Label>
                        <Label>
                          Order
                          <Input
                            type="number"
                            value={selected.order}
                            onChange={(event) =>
                              replaceStep({ ...selected, order: Number(event.target.value) })
                            }
                          />
                        </Label>
                        <Label>
                          Material clock
                          <Select
                            value={selected.clock}
                            onValueChange={(clock) =>
                              replaceStep({ ...selected, clock: clock as typeof selected.clock })
                            }
                          >
                            <SelectItem value="gameplay">Gameplay</SelectItem>
                            <SelectItem value="unscaled-presentation">
                              Unscaled Presentation
                            </SelectItem>
                          </Select>
                        </Label>
                        <div className="space-y-2">
                          <div className="flex items-center justify-between gap-2">
                            <Label>Initial parameters</Label>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              disabled={
                                uniforms.length === 0 ||
                                selected.parameters.length >= uniforms.length
                              }
                              onClick={() => {
                                const available = uniforms.find(
                                  (uniform) =>
                                    !selected.parameters.some(
                                      (parameter) => parameter.name === uniform.name,
                                    ),
                                );
                                if (!available) return;
                                replaceStep({
                                  ...selected,
                                  parameters: [
                                    ...selected.parameters,
                                    { name: available.name, value: defaultUniformValue(available) },
                                  ],
                                });
                              }}
                            >
                              Add parameter
                            </Button>
                          </div>
                          {selected.parameters.map((parameter, index) => {
                            const parameterUniform = uniforms.find(
                              (uniform) => uniform.name === parameter.name,
                            );
                            return (
                              <div
                                key={`${parameter.name}-${index}`}
                                className="grid gap-2 rounded border p-2"
                              >
                                <Select
                                  value={parameter.name}
                                  onValueChange={(name) => {
                                    if (!name) return;
                                    const nextUniform = uniforms.find(
                                      (uniform) => uniform.name === name,
                                    );
                                    replaceStep({
                                      ...selected,
                                      parameters: selected.parameters.map((current, currentIndex) =>
                                        currentIndex === index
                                          ? {
                                              name,
                                              value: defaultUniformValue(nextUniform),
                                            }
                                          : current,
                                      ),
                                    });
                                  }}
                                >
                                  {uniforms.map((uniform) => (
                                    <SelectItem key={uniform.name} value={uniform.name}>
                                      {uniform.label ?? uniform.name} ({uniform.type})
                                    </SelectItem>
                                  ))}
                                </Select>
                                {parameterUniform?.type === 'bool' ? (
                                  <Select
                                    value={parameter.value === true ? 'true' : 'false'}
                                    onValueChange={(value) =>
                                      replaceStep({
                                        ...selected,
                                        parameters: selected.parameters.map(
                                          (current, currentIndex) =>
                                            currentIndex === index
                                              ? { ...current, value: value === 'true' }
                                              : current,
                                        ),
                                      })
                                    }
                                  >
                                    <SelectItem value="false">False</SelectItem>
                                    <SelectItem value="true">True</SelectItem>
                                  </Select>
                                ) : (
                                  <Input
                                    value={uniformValueText(parameter.value)}
                                    onChange={(event) => {
                                      const value = parseUniformValue(
                                        event.target.value,
                                        parameterUniform,
                                      );
                                      if (value === null) return;
                                      replaceStep({
                                        ...selected,
                                        parameters: selected.parameters.map(
                                          (current, currentIndex) =>
                                            currentIndex === index
                                              ? { ...current, value }
                                              : current,
                                        ),
                                      });
                                    }}
                                  />
                                )}
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  onClick={() =>
                                    replaceStep({
                                      ...selected,
                                      parameters: selected.parameters.filter(
                                        (_, currentIndex) => currentIndex !== index,
                                      ),
                                    })
                                  }
                                >
                                  Remove parameter
                                </Button>
                              </div>
                            );
                          })}
                        </div>
                      </>
                    )}
                  </>
                );
              })()}
            {selected.type === 'transition-group' && (
              <>
                <Label>
                  Transition
                  <Select
                    value={selected.transitionKind}
                    onValueChange={(transitionKind) =>
                      replaceStep({
                        ...selected,
                        transitionKind: transitionKind as typeof selected.transitionKind,
                      })
                    }
                  >
                    {['fade', 'cut', 'dissolve'].map((value) => (
                      <SelectItem key={value} value={value}>
                        {title(value)}
                      </SelectItem>
                    ))}
                  </Select>
                </Label>
                <Label>
                  Duration (ms)
                  <Input
                    type="number"
                    min="0"
                    value={selected.durationMs}
                    onChange={(event) =>
                      replaceStep({ ...selected, durationMs: Number(event.target.value) })
                    }
                  />
                </Label>
                <Label>
                  Fade color
                  <Input
                    disabled={selected.transitionKind !== 'fade'}
                    value={selected.color ?? ''}
                    onChange={(event) =>
                      replaceStep({ ...selected, color: event.target.value || null })
                    }
                  />
                </Label>
                <Label className="flex items-center gap-2">
                  Wait for completion
                  <Switch
                    disabled={selected.transitionKind === 'cut'}
                    checked={selected.waitForCompletion}
                    onCheckedChange={(waitForCompletion) =>
                      replaceStep({ ...selected, waitForCompletion })
                    }
                  />
                </Label>
                <Label className="flex items-center gap-2">
                  Skippable
                  <Switch
                    checked={selected.skippable}
                    onCheckedChange={(skippable) => replaceStep({ ...selected, skippable })}
                  />
                </Label>
                <div className="space-y-2 rounded border p-2">
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        replaceStep({
                          ...selected,
                          children: [
                            ...selected.children,
                            {
                              id: uniqueNestedId(
                                selected.children.map((child) => child.id),
                                'background',
                              ),
                              type: 'set-background',
                              asset: null,
                              material: null,
                              color: '#0f172a',
                              fit: 'cover',
                            },
                          ],
                        })
                      }
                    >
                      Add background
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        replaceStep({
                          ...selected,
                          children: [
                            ...selected.children,
                            {
                              id: uniqueNestedId(
                                selected.children.map((child) => child.id),
                                'clear-background',
                              ),
                              type: 'clear-background',
                            },
                          ],
                        })
                      }
                    >
                      Clear background
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={Object.keys(project.characters).length === 0}
                      onClick={() => {
                        const characterId = Object.keys(project.characters)[0];
                        if (!characterId) return;
                        replaceStep({
                          ...selected,
                          children: [
                            ...selected.children,
                            {
                              id: uniqueNestedId(
                                selected.children.map((child) => child.id),
                                'actor',
                              ),
                              type: 'actor-cue',
                              slotId: 'actor',
                              character: sceneCharacterRef(characterId),
                              action: 'show',
                              poseId: null,
                              expressionId: null,
                              position: 'center',
                              offset: { x: 0, y: 0 },
                              scale: 1,
                            },
                          ],
                        });
                      }}
                    >
                      Add actor
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        replaceStep({
                          ...selected,
                          children: [
                            ...selected.children,
                            {
                              id: uniqueNestedId(
                                selected.children.map((child) => child.id),
                                'layout',
                              ),
                              type: 'set-layout',
                              layout: null,
                              action: 'hide',
                              slot: 'overlay',
                            },
                          ],
                        })
                      }
                    >
                      Add Layout
                    </Button>
                  </div>
                  {selected.children.map((child, childIndex) => {
                    const updateChild = (next: SceneTransitionGroupChildData) =>
                      replaceStep({
                        ...selected,
                        children: selected.children.map((item, index) =>
                          index === childIndex ? next : item,
                        ),
                      });
                    return (
                      <div key={child.id} className="space-y-2 rounded border p-2">
                        <div className="flex items-center gap-2">
                          <Badge variant="outline">{title(child.type)}</Badge>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={selected.children.length === 1}
                            onClick={() =>
                              replaceStep({
                                ...selected,
                                children: selected.children.filter(
                                  (_, index) => index !== childIndex,
                                ),
                              })
                            }
                          >
                            Remove
                          </Button>
                        </div>
                        <Label>
                          Child ID
                          <Input
                            value={child.id}
                            onChange={(event) =>
                              updateChild({
                                ...child,
                                id: event.target.value,
                              } as SceneTransitionGroupChildData)
                            }
                          />
                        </Label>
                        {child.type === 'set-background' && (
                          <>
                            <Label>
                              Asset
                              <Select
                                value={refId(child.asset)}
                                onValueChange={(id) => {
                                  if (id)
                                    updateChild({
                                      ...child,
                                      asset: id === '__none__' ? null : sceneAssetRef(id),
                                    });
                                }}
                              >
                                <SelectItem value="__none__">None</SelectItem>
                                {Object.entries(project.assets).map(([id, item]) => (
                                  <SelectItem key={id} value={id}>
                                    {item.label}
                                  </SelectItem>
                                ))}
                              </Select>
                            </Label>
                            <Label>
                              Material
                              <Select
                                value={refId(child.material)}
                                onValueChange={(id) => {
                                  if (id)
                                    updateChild({
                                      ...child,
                                      material: id === '__none__' ? null : sceneMaterialRef(id),
                                    });
                                }}
                              >
                                <SelectItem value="__none__">None</SelectItem>
                                {Object.entries(project.materials).map(([id, item]) => (
                                  <SelectItem key={id} value={id}>
                                    {item.label}
                                  </SelectItem>
                                ))}
                              </Select>
                            </Label>
                            <Label>
                              Color
                              <Input
                                value={child.color ?? ''}
                                onChange={(event) =>
                                  updateChild({ ...child, color: event.target.value || null })
                                }
                              />
                            </Label>
                            <Label>
                              Fit
                              <Select
                                value={child.fit}
                                onValueChange={(fit) =>
                                  updateChild({ ...child, fit: fit as typeof child.fit })
                                }
                              >
                                {['cover', 'contain', 'stretch', 'center'].map((value) => (
                                  <SelectItem key={value} value={value}>
                                    {title(value)}
                                  </SelectItem>
                                ))}
                              </Select>
                            </Label>
                          </>
                        )}
                        {child.type === 'actor-cue' && (
                          <>
                            <Label>
                              Actor slot
                              <Input
                                value={child.slotId}
                                onChange={(event) =>
                                  updateChild({ ...child, slotId: event.target.value })
                                }
                              />
                            </Label>
                            <Label>
                              Character
                              <Select
                                value={child.character.$ref.id}
                                onValueChange={(id) => {
                                  if (id)
                                    updateChild({ ...child, character: sceneCharacterRef(id) });
                                }}
                              >
                                {Object.entries(project.characters).map(([id, item]) => (
                                  <SelectItem key={id} value={id}>
                                    {item.label}
                                  </SelectItem>
                                ))}
                              </Select>
                            </Label>
                            <Label>
                              Action
                              <Select
                                value={child.action}
                                onValueChange={(action) =>
                                  updateChild({ ...child, action: action as typeof child.action })
                                }
                              >
                                {[
                                  'show',
                                  'hide',
                                  'move',
                                  'profile',
                                  'pose',
                                  'expression',
                                  'appearance',
                                ].map((value) => (
                                  <SelectItem key={value} value={value}>
                                    {title(value)}
                                  </SelectItem>
                                ))}
                              </Select>
                            </Label>
                            <Label>
                              Profile ID
                              <Input
                                value={child.profileId ?? ''}
                                onChange={(event) =>
                                  updateChild({ ...child, profileId: event.target.value || null })
                                }
                              />
                            </Label>
                            <Label>
                              Pose ID
                              <Input
                                value={child.poseId ?? ''}
                                onChange={(event) =>
                                  updateChild({ ...child, poseId: event.target.value || null })
                                }
                              />
                            </Label>
                            <Label>
                              Appearance ID
                              <Input
                                value={child.appearanceId ?? ''}
                                onChange={(event) =>
                                  updateChild({
                                    ...child,
                                    appearanceId: event.target.value || null,
                                  })
                                }
                              />
                            </Label>
                            <Label>
                              Expression ID
                              <Input
                                value={child.expressionId ?? ''}
                                onChange={(event) =>
                                  updateChild({
                                    ...child,
                                    expressionId: event.target.value || null,
                                  })
                                }
                              />
                            </Label>
                            <Label>
                              Position
                              <Select
                                value={child.position}
                                onValueChange={(position) =>
                                  updateChild({
                                    ...child,
                                    position: position as typeof child.position,
                                  })
                                }
                              >
                                {['left', 'center', 'right', 'custom'].map((value) => (
                                  <SelectItem key={value} value={value}>
                                    {title(value)}
                                  </SelectItem>
                                ))}
                              </Select>
                            </Label>
                            <Label>
                              Offset X
                              <Input
                                type="number"
                                value={child.offset.x}
                                onChange={(event) =>
                                  updateChild({
                                    ...child,
                                    offset: { ...child.offset, x: Number(event.target.value) },
                                  })
                                }
                              />
                            </Label>
                            <Label>
                              Offset Y
                              <Input
                                type="number"
                                value={child.offset.y}
                                onChange={(event) =>
                                  updateChild({
                                    ...child,
                                    offset: { ...child.offset, y: Number(event.target.value) },
                                  })
                                }
                              />
                            </Label>
                            <Label>
                              Scale
                              <Input
                                type="number"
                                min="0.01"
                                step="0.05"
                                value={child.scale}
                                onChange={(event) =>
                                  updateChild({ ...child, scale: Number(event.target.value) })
                                }
                              />
                            </Label>
                          </>
                        )}
                        {child.type === 'set-layout' && (
                          <>
                            <Label>
                              Layout
                              <Select
                                value={refId(child.layout)}
                                onValueChange={(id) => {
                                  if (id)
                                    updateChild({
                                      ...child,
                                      layout: id === '__none__' ? null : sceneLayoutRef(id),
                                    });
                                }}
                              >
                                <SelectItem value="__none__">None</SelectItem>
                                {Object.entries(project.layouts).map(([id, item]) => (
                                  <SelectItem key={id} value={id}>
                                    {item.label}
                                  </SelectItem>
                                ))}
                              </Select>
                            </Label>
                            <Label>
                              Action
                              <Select
                                value={child.action}
                                onValueChange={(action) =>
                                  updateChild({ ...child, action: action as typeof child.action })
                                }
                              >
                                {['show', 'hide', 'swap'].map((value) => (
                                  <SelectItem key={value} value={value}>
                                    {title(value)}
                                  </SelectItem>
                                ))}
                              </Select>
                            </Label>
                            <Label>
                              WorldOverlay slot
                              <Select
                                value={child.slot}
                                onValueChange={(slot) =>
                                  updateChild({ ...child, slot: slot as 'overlay' | 'custom' })
                                }
                              >
                                <SelectItem value="overlay">Overlay</SelectItem>
                                <SelectItem value="custom">Custom</SelectItem>
                              </Select>
                            </Label>
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              </>
            )}
            {selected.type === 'comment' && (
              <Label>
                Comment
                <textarea
                  className="min-h-28 w-full rounded border bg-background p-2 text-sm"
                  value={selected.text}
                  onChange={(event) => replaceStep({ ...selected, text: event.target.value })}
                />
              </Label>
            )}
          </div>
        )}
        <div className="mt-6">
          <DiagnosticList items={diagnosticItems} emptyMessage="No scene diagnostics." />
        </div>
      </section>

      <DerivedPreviewPane
        ownerTabId={tab.id}
        previewMode="scene"
        previewDocument={previewDocument}
      />
    </div>
  );
}
