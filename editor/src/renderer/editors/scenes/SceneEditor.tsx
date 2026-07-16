import { useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectItem } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { DiagnosticList } from '@/diagnostics/DiagnosticList';
import { useCommandStore } from '@/commands/command-store';
import { DerivedPreviewPane } from '@/preview/DerivedPreviewPane';
import { useProjectStore } from '@/project/project-store';
import type { WorkbenchEditorProps } from '@/workbench/editor-registry';
import {
  defaultSceneData, defaultSceneStep, parseSceneData, sceneAssetRef, sceneCharacterRef,
  sceneDialogueRef, sceneLayoutRef, sceneMaterialRef, sceneStepTypeValues, sceneVariableRef, validateSceneData,
  type SceneConditionData, type SceneData, type SceneEffectData, type SceneStepData, type SceneStepType,
  type SceneTransitionGroupChildData,
} from '../../../shared/project-schema/authoring-scenes';
import { isAuthoringProject } from '../../../shared/project-schema/authoring-project';
import { buildScenePreviewDocumentData, scenePreviewRevision } from '../../../shared/project-schema/scene-project';

function commitScene(sceneId: string, data: SceneData, label: string) {
  return useCommandStore.getState().executeCommand({ type: 'scene.replaceData', label, payload: { sceneId, data } });
}
function title(value: string) { return value.split('-').map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`).join(' '); }
function uniqueId(steps: SceneStepData[], base: string) {
  const used = new Set(steps.map((step) => step.id));
  if (!used.has(base)) return base;
  for (let index = 2; index < 1000; index += 1) if (!used.has(`${base}-${index}`)) return `${base}-${index}`;
  return `${base}-${Date.now()}`;
}
function uniqueNestedId(ids: readonly string[], base: string) {
  const used = new Set(ids);
  if (!used.has(base)) return base;
  for (let index = 2; index < 1000; index += 1) if (!used.has(`${base}-${index}`)) return `${base}-${index}`;
  return `${base}-${Date.now()}`;
}
function refId(ref: { $ref: { id: string } } | null) { return ref?.$ref.id ?? '__none__'; }
function scalar(value: string): string | number | boolean | null {
  if (value === 'null') return null;
  if (value === 'true') return true;
  if (value === 'false') return false;
  const number = Number(value);
  return value.trim() !== '' && Number.isFinite(number) ? number : value;
}

export function SceneEditor({ tab }: WorkbenchEditorProps) {
  const document = useProjectStore((state) => state.document);
  const project = isAuthoringProject(document) ? document : null;
  const sceneId = tab.resource?.entityId;
  const record = sceneId && project ? project.scenes[sceneId] : null;
  const data = parseSceneData(record?.data) ?? defaultSceneData(record?.label ?? 'Scene');
  const [selectedId, setSelectedId] = useState<string | null>(data.steps[0]?.id ?? null);
  const selected = data.steps.find((step) => step.id === selectedId) ?? data.steps[0] ?? null;
  const diagnostics = useMemo(() => project && record && sceneId ? validateSceneData(project, sceneId, record) : [], [project, record, sceneId]);

  if (!project || !record || !sceneId) return <div className="p-4 text-sm text-muted-foreground">Scene not found.</div>;
  const commit = (next: SceneData, label = 'Update scene') => commitScene(sceneId, next, label);
  const replaceStep = (next: SceneStepData) => commit({ ...data, steps: data.steps.map((step) => step.id === next.id ? next : step) }, 'Update scene step');
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
    if (step.type === 'set-variable') {
      const id = Object.keys(project.variables)[0];
      const value = project.variables[id!]?.data.defaultValue;
      return id && (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string')
        ? { ...step, variable: sceneVariableRef(id), value }
        : null;
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
    const step = { ...created, id: uniqueId(data.steps, type) } as SceneStepData;
    commit({ ...data, steps: [...data.steps, step] }, 'Add scene step'); setSelectedId(step.id);
  };
  const duplicate = () => {
    if (!selected) return;
    const id = uniqueId(data.steps, selected.id);
    const step = structuredClone({ ...selected, id, label: `${selected.label} Copy` }) as SceneStepData;
    const index = data.steps.findIndex((item) => item.id === selected.id);
    const steps = [...data.steps]; steps.splice(index + 1, 0, step);
    commit({ ...data, steps }, 'Duplicate scene step'); setSelectedId(id);
  };
  const remove = () => {
    if (!selected || data.steps.length === 1) return;
    const index = data.steps.findIndex((item) => item.id === selected.id);
    const steps = data.steps.filter((item) => item.id !== selected.id);
    commit({ ...data, steps }, 'Delete scene step'); setSelectedId(steps[Math.min(index, steps.length - 1)]?.id ?? null);
  };
  const move = (delta: number) => {
    if (!selected) return;
    const index = data.steps.findIndex((item) => item.id === selected.id); const target = index + delta;
    if (target < 0 || target >= data.steps.length) return;
    const steps = [...data.steps]; [steps[index], steps[target]] = [steps[target]!, steps[index]!];
    commit({ ...data, steps }, 'Reorder scene steps');
  };
  const renameStep = (nextId: string) => {
    if (!selected || nextId === selected.id || data.steps.some((step) => step.id === nextId)) return;
    const previousId = selected.id;
    const steps = data.steps.map((step): SceneStepData => {
      const renamed = step.id === previousId ? { ...step, id: nextId } as SceneStepData : step;
      if (renamed.type === 'conditional-branch') return {
        ...renamed,
        fallbackStepId: renamed.fallbackStepId === previousId ? nextId : renamed.fallbackStepId,
        branches: renamed.branches.map((branch) => ({ ...branch, targetStepId: branch.targetStepId === previousId ? nextId : branch.targetStepId })),
      };
      if (renamed.type === 'choice') return {
        ...renamed,
        options: renamed.options.map((option) => ({ ...option, targetStepId: option.targetStepId === previousId ? nextId : option.targetStepId })),
      };
      return renamed;
    });
    commit({ ...data, steps }, 'Rename scene step');
    setSelectedId(nextId);
  };

  const continuationOptions = [
    ...Object.keys(project.scenes).map((id) => ({ value: `scene:${id}`, label: `Scene: ${project.scenes[id]!.label}` })),
    ...Object.keys(project.dialogues).map((id) => ({ value: `dialogue:${id}`, label: `Dialogue: ${project.dialogues[id]!.label}` })),
    ...Object.keys(project.rooms).map((id) => ({ value: `room:${id}`, label: `Room: ${project.rooms[id]!.label}` })),
    { value: 'return', label: 'Return' }, { value: 'end', label: 'End' },
  ];
  const continuationValue = 'id' in data.continuation ? `${data.continuation.kind}:${data.continuation.id}` : data.continuation.kind;
  const conditionEditor = (condition: SceneConditionData | undefined, onChange: (condition: SceneConditionData | undefined) => void) => {
    const variableId = Object.keys(project.variables)[0];
    return <div className="space-y-2 rounded border p-2">
      <Label>Condition<Select value={condition?.kind ?? 'none'} onValueChange={(kind) => {
        if (kind === 'none') onChange(undefined);
        else if (kind === 'always') onChange({ kind: 'always' });
        else if (kind === 'lua-predicate') onChange({ kind: 'lua-predicate', source: '-- return true' });
        else if (variableId) onChange({ kind: 'variable-comparison', variable: sceneVariableRef(variableId), operator: 'equal', value: project.variables[variableId]!.data.defaultValue as string | number | boolean | null });
      }}><SelectItem value="none">None</SelectItem><SelectItem value="always">Always</SelectItem><SelectItem value="variable-comparison" disabled={!variableId}>Variable comparison</SelectItem><SelectItem value="lua-predicate">Lua predicate</SelectItem></Select></Label>
      {condition?.kind === 'lua-predicate' && <Label>Lua predicate<textarea className="min-h-24 w-full rounded border bg-background p-2 font-mono text-sm" value={condition.source} onChange={(event) => onChange({ ...condition, source: event.target.value })} /></Label>}
      {condition?.kind === 'variable-comparison' && <>
        <Label>Variable<Select value={condition.variable.$ref.id} onValueChange={(id) => { if (id) onChange({ ...condition, variable: sceneVariableRef(id), value: project.variables[id]!.data.defaultValue as string | number | boolean | null }); }}>{Object.entries(project.variables).map(([id, item]) => <SelectItem key={id} value={id}>{item.label}</SelectItem>)}</Select></Label>
        <Label>Operator<Select value={condition.operator} onValueChange={(operator) => onChange({ ...condition, operator: operator as typeof condition.operator })}>{['equal','not-equal','less','less-equal','greater','greater-equal','truthy','falsy'].map((operator) => <SelectItem key={operator} value={operator}>{title(operator)}</SelectItem>)}</Select></Label>
        {!['truthy', 'falsy'].includes(condition.operator) && <Label>Value<Input value={String(condition.value ?? '')} onChange={(event) => onChange({ ...condition, value: scalar(event.target.value) })} /></Label>}
      </>}
    </div>;
  };
  const effectEditor = (effect: SceneEffectData, onChange: (effect: SceneEffectData) => void) => <div className="space-y-2 rounded border p-2">
    <Label>Effect<Select value={effect.kind} onValueChange={(kind) => {
      const variableId = Object.keys(project.variables)[0];
      if (kind === 'run-lua-effect') onChange({ kind, source: '-- Lua effect' });
      else if (variableId) onChange({ kind: 'set-variable', variable: sceneVariableRef(variableId), value: project.variables[variableId]!.data.defaultValue as string | number | boolean | null });
    }}><SelectItem value="set-variable" disabled={Object.keys(project.variables).length === 0}>Set variable</SelectItem><SelectItem value="run-lua-effect">Run Lua effect</SelectItem></Select></Label>
    {effect.kind === 'run-lua-effect' ? <textarea className="min-h-20 w-full rounded border bg-background p-2 font-mono text-sm" value={effect.source} onChange={(event) => onChange({ ...effect, source: event.target.value })} /> : <><Select value={effect.variable.$ref.id} onValueChange={(id) => { if (id) onChange({ ...effect, variable: sceneVariableRef(id), value: project.variables[id]!.data.defaultValue as string | number | boolean | null }); }}>{Object.entries(project.variables).map(([id, item]) => <SelectItem key={id} value={id}>{item.label}</SelectItem>)}</Select><Input value={String(effect.value)} onChange={(event) => onChange({ ...effect, value: scalar(event.target.value) })} /></>}
  </div>;
  const revision = scenePreviewRevision(project, sceneId);
  const previewDocument = {
    kind: 'scene-preview' as const,
    recordId: sceneId,
    revision,
    data: buildScenePreviewDocumentData(project, sceneId, selected?.id),
  };
  const diagnosticItems = diagnostics.map((item) => ({ ...item, target: null }));

  return <div className="grid h-full min-h-0 grid-cols-[minmax(240px,0.7fr)_minmax(360px,1.3fr)_minmax(320px,1fr)]">
    <section className="min-h-0 overflow-auto border-r p-3">
      <div className="mb-3 flex gap-2">
        <Select value="comment" onValueChange={(value) => addStep(value as SceneStepType)}>{sceneStepTypeValues.map((type) => <SelectItem key={type} value={type}>Add {title(type)}</SelectItem>)}</Select>
      </div>
      <div className="space-y-1">{data.steps.map((step, index) => <button key={step.id} className={`flex w-full items-center gap-2 rounded px-2 py-2 text-left text-sm ${step.id === selected?.id ? 'bg-accent' : 'hover:bg-muted'}`} onClick={() => setSelectedId(step.id)}>
        <span className="w-6 text-muted-foreground">{index + 1}</span><span className="min-w-0 flex-1 truncate">{step.label}</span><Badge variant="outline">{title(step.type)}</Badge>
      </button>)}</div>
    </section>

    <section className="min-h-0 overflow-auto border-r p-4">
      <div className="mb-4 grid gap-3">
        <Label>Display name<Input value={data.displayName} onChange={(event) => commit({ ...data, displayName: event.target.value })} /></Label>
        <Label>Continuation<Select value={continuationValue} onValueChange={(value) => { if (!value) return; const [kind, id] = value.split(':'); commit({ ...data, continuation: id ? { kind: kind as 'scene' | 'dialogue' | 'room', id } : { kind: kind as 'return' | 'end' } }); }}>{continuationOptions.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</Select></Label>
        <Label>Default background asset<Select value={refId(data.defaultBackground.asset)} onValueChange={(id) => { if (id) commit({ ...data, defaultBackground: { ...data.defaultBackground, asset: id === '__none__' ? null : sceneAssetRef(id) } }); }}><SelectItem value="__none__">None</SelectItem>{Object.entries(project.assets).map(([id, item]) => <SelectItem key={id} value={id}>{item.label}</SelectItem>)}</Select></Label>
        <Label>Default background material<Select value={refId(data.defaultBackground.material)} onValueChange={(id) => { if (id) commit({ ...data, defaultBackground: { ...data.defaultBackground, material: id === '__none__' ? null : sceneMaterialRef(id) } }); }}><SelectItem value="__none__">None</SelectItem>{Object.entries(project.materials).map(([id, item]) => <SelectItem key={id} value={id}>{item.label}</SelectItem>)}</Select></Label>
        <Label>Default background color<Input value={data.defaultBackground.color ?? ''} onChange={(event) => commit({ ...data, defaultBackground: { ...data.defaultBackground, color: event.target.value || null } })} /></Label>
        <Label>Default background fit<Select value={data.defaultBackground.fit} onValueChange={(fit) => commit({ ...data, defaultBackground: { ...data.defaultBackground, fit: fit as typeof data.defaultBackground.fit } })}>{['cover','contain','stretch','center'].map((value) => <SelectItem key={value} value={value}>{title(value)}</SelectItem>)}</Select></Label>
        <Label>Default layout<Select value={refId(data.defaultLayout)} onValueChange={(id) => { if (id) commit({ ...data, defaultLayout: id === '__none__' ? null : sceneLayoutRef(id) }); }}><SelectItem value="__none__">None</SelectItem>{Object.entries(project.layouts).map(([id, item]) => <SelectItem key={id} value={id}>{item.label}</SelectItem>)}</Select></Label>
      </div>
      {!selected ? null : <div className="space-y-4">
        <div className="flex gap-2"><Button size="sm" variant="outline" onClick={() => move(-1)}>Up</Button><Button size="sm" variant="outline" onClick={() => move(1)}>Down</Button><Button size="sm" variant="outline" onClick={duplicate}>Duplicate</Button><Button size="sm" variant="destructive" disabled={data.steps.length === 1} onClick={remove}>Delete</Button></div>
        <Label>Type<Select value={selected.type} onValueChange={(value) => changeType(value as SceneStepType)}>{sceneStepTypeValues.map((type) => <SelectItem key={type} value={type}>{title(type)}</SelectItem>)}</Select></Label>
        <Label>Step ID<Input value={selected.id} onChange={(event) => renameStep(event.target.value)} /></Label>
        <Label>Label<Input value={selected.label} onChange={(event) => replaceStep({ ...selected, label: event.target.value } as SceneStepData)} /></Label>
        {'enabled' in selected && <Label className="flex items-center gap-2">Enabled<Switch checked={selected.enabled} onCheckedChange={(enabled) => replaceStep({ ...selected, enabled } as SceneStepData)} /></Label>}
        {'condition' in selected && conditionEditor(selected.condition, (condition) => replaceStep({ ...selected, condition } as SceneStepData))}
        {'autosaveSafePoint' in selected && <Label className="flex items-center gap-2">Autosave safe point<Switch checked={selected.autosaveSafePoint} onCheckedChange={(autosaveSafePoint) => replaceStep({ ...selected, autosaveSafePoint } as SceneStepData)} /></Label>}
        {selected.type === 'set-background' && <>
          <Label>Asset<Select value={refId(selected.asset)} onValueChange={(id) => { if (id) replaceStep({ ...selected, asset: id === '__none__' ? null : sceneAssetRef(id) }); }}><SelectItem value="__none__">None</SelectItem>{Object.entries(project.assets).map(([id, item]) => <SelectItem key={id} value={id}>{item.label}</SelectItem>)}</Select></Label>
          <Label>Material<Select value={refId(selected.material)} onValueChange={(id) => { if (id) replaceStep({ ...selected, material: id === '__none__' ? null : sceneMaterialRef(id) }); }}><SelectItem value="__none__">None</SelectItem>{Object.entries(project.materials).map(([id, item]) => <SelectItem key={id} value={id}>{item.label}</SelectItem>)}</Select></Label>
          <Label>Color<Input value={selected.color ?? ''} onChange={(event) => replaceStep({ ...selected, color: event.target.value || null })} /></Label>
          <Label>Fit<Select value={selected.fit} onValueChange={(fit) => replaceStep({ ...selected, fit: fit as typeof selected.fit })}>{['cover','contain','stretch','center'].map((value) => <SelectItem key={value} value={value}>{title(value)}</SelectItem>)}</Select></Label>
          <Label>Transition<Select value={selected.transition} onValueChange={(value) => {
            const transition = value as typeof selected.transition;
            replaceStep({ ...selected, transition, durationMs: transition === 'fade' ? Math.max(selected.durationMs, 500) : 0, waitForCompletion: transition === 'fade' && selected.waitForCompletion });
          }}>{['none','fade','cut'].map((value) => <SelectItem key={value} value={value}>{title(value)}</SelectItem>)}</Select></Label>
          <Label>Duration (ms)<Input disabled={selected.transition !== 'fade'} type="number" min="0" value={selected.durationMs} onChange={(event) => replaceStep({ ...selected, durationMs: Number(event.target.value) })} /></Label>
          <Label className="flex items-center gap-2">Wait for completion<Switch disabled={selected.transition !== 'fade'} checked={selected.waitForCompletion} onCheckedChange={(waitForCompletion) => replaceStep({ ...selected, waitForCompletion })} /></Label>
          <Label className="flex items-center gap-2">Skippable<Switch disabled={selected.transition !== 'fade'} checked={selected.skippable} onCheckedChange={(skippable) => replaceStep({ ...selected, skippable })} /></Label>
        </>}
        {selected.type === 'actor-cue' && <>
          <Label>Actor slot<Input value={selected.slotId} onChange={(event) => replaceStep({ ...selected, slotId: event.target.value })} /></Label>
          <Label>Character<Select value={selected.character.$ref.id} onValueChange={(id) => { if (id) replaceStep({ ...selected, character: sceneCharacterRef(id) }); }}>{Object.entries(project.characters).map(([id, item]) => <SelectItem key={id} value={id}>{item.label}</SelectItem>)}</Select></Label>
          <Label>Action<Select value={selected.action} onValueChange={(action) => replaceStep({ ...selected, action: action as typeof selected.action })}>{['show','hide','move','pose','expression'].map((value) => <SelectItem key={value} value={value}>{title(value)}</SelectItem>)}</Select></Label>
          <Label>Pose ID<Input value={selected.poseId ?? ''} onChange={(event) => replaceStep({ ...selected, poseId: event.target.value || null })} /></Label>
          <Label>Expression ID<Input value={selected.expressionId ?? ''} onChange={(event) => replaceStep({ ...selected, expressionId: event.target.value || null })} /></Label>
          <Label>Position<Select value={selected.position} onValueChange={(position) => replaceStep({ ...selected, position: position as typeof selected.position })}>{['left','center','right','custom'].map((value) => <SelectItem key={value} value={value}>{title(value)}</SelectItem>)}</Select></Label>
          <Label>Offset X<Input type="number" value={selected.offset.x} onChange={(event) => replaceStep({ ...selected, offset: { ...selected.offset, x: Number(event.target.value) } })} /></Label>
          <Label>Offset Y<Input type="number" value={selected.offset.y} onChange={(event) => replaceStep({ ...selected, offset: { ...selected.offset, y: Number(event.target.value) } })} /></Label>
          <Label>Scale<Input type="number" min="0.01" step="0.05" value={selected.scale} onChange={(event) => replaceStep({ ...selected, scale: Number(event.target.value) })} /></Label>
          <Label>Transition<Select value={selected.transition} onValueChange={(value) => {
            const transition = value as typeof selected.transition;
            replaceStep({ ...selected, transition, durationMs: transition === 'none' ? 0 : Math.max(selected.durationMs, 300), waitForCompletion: transition !== 'none' && selected.waitForCompletion });
          }}>{['none','fade','slide'].map((value) => <SelectItem key={value} value={value}>{title(value)}</SelectItem>)}</Select></Label>
          <Label>Duration (ms)<Input disabled={selected.transition === 'none'} type="number" min="0" value={selected.durationMs} onChange={(event) => replaceStep({ ...selected, durationMs: Number(event.target.value) })} /></Label>
          <Label className="flex items-center gap-2">Wait for completion<Switch disabled={selected.transition === 'none'} checked={selected.waitForCompletion} onCheckedChange={(waitForCompletion) => replaceStep({ ...selected, waitForCompletion })} /></Label>
          <Label className="flex items-center gap-2">Skippable<Switch disabled={selected.transition === 'none'} checked={selected.skippable} onCheckedChange={(skippable) => replaceStep({ ...selected, skippable })} /></Label>
        </>}
        {selected.type === 'call-dialogue' && <><Label>Dialogue<Select value={selected.dialogue.$ref.id} onValueChange={(id) => { if (id) replaceStep({ ...selected, dialogue: sceneDialogueRef(id) }); }}>{Object.entries(project.dialogues).map(([id, item]) => <SelectItem key={id} value={id}>{item.label}</SelectItem>)}</Select></Label><Label>Start block ID<Input value={selected.startBlockId ?? ''} onChange={(event) => replaceStep({ ...selected, startBlockId: event.target.value || null })} /></Label></>}
        {selected.type === 'show-text' && <><Label>Text source<Select value={selected.text.source.kind} onValueChange={(kind) => replaceStep({ ...selected, text: { ...selected.text, source: kind === 'inline' ? { kind, text: '' } : kind === 'localized' ? { kind, key: 'text-key' } : { kind: 'lua-expression', source: '-- return text' } } })}><SelectItem value="inline">Inline</SelectItem><SelectItem value="localized">Localized</SelectItem><SelectItem value="lua-expression">Lua expression</SelectItem></Select></Label><Label>Text<Input value={selected.text.source.kind === 'inline' ? selected.text.source.text : selected.text.source.kind === 'localized' ? selected.text.source.key : selected.text.source.source} onChange={(event) => replaceStep({ ...selected, text: { ...selected.text, source: selected.text.source.kind === 'inline' ? { ...selected.text.source, text: event.target.value } : selected.text.source.kind === 'localized' ? { ...selected.text.source, key: event.target.value } : { ...selected.text.source, source: event.target.value } } })} /></Label><Label>Markup<Select value={selected.text.markup} onValueChange={(markup) => replaceStep({ ...selected, text: { ...selected.text, markup: markup as typeof selected.text.markup } })}><SelectItem value="plain">Plain</SelectItem><SelectItem value="active-text">Active text</SelectItem></Select></Label><Label>Speaker<Select value={refId(selected.speaker)} onValueChange={(id) => { if (id) replaceStep({ ...selected, speaker: id === '__none__' ? null : sceneCharacterRef(id) }); }}><SelectItem value="__none__">None</SelectItem>{Object.entries(project.characters).map(([id, item]) => <SelectItem key={id} value={id}>{item.label}</SelectItem>)}</Select></Label><Label>Wait<Select value={selected.wait} onValueChange={(wait) => replaceStep({ ...selected, wait: wait as typeof selected.wait })}><SelectItem value="input">Input</SelectItem><SelectItem value="immediate">Immediate</SelectItem></Select></Label></>}
        {selected.type === 'audio-cue' && <><Label>Asset<Select value={refId(selected.asset)} onValueChange={(id) => { if (id) replaceStep({ ...selected, asset: id === '__none__' ? null : sceneAssetRef(id) }); }}><SelectItem value="__none__">None</SelectItem>{Object.entries(project.assets).map(([id, item]) => <SelectItem key={id} value={id}>{item.label}</SelectItem>)}</Select></Label><Label>Channel<Select value={selected.channel} onValueChange={(channel) => replaceStep({ ...selected, channel: channel as typeof selected.channel })}>{['sound-effect','music','voice','ambient'].map((value) => <SelectItem key={value} value={value}>{title(value)}</SelectItem>)}</Select></Label><Label>Action<Select value={selected.action} onValueChange={(action) => replaceStep({ ...selected, action: action as typeof selected.action })}>{['play','stop','fade-in','fade-out'].map((value) => <SelectItem key={value} value={value}>{title(value)}</SelectItem>)}</Select></Label><Label>Volume<Input type="number" min="0" max="1" step="0.05" value={selected.volume} onChange={(event) => replaceStep({ ...selected, volume: Number(event.target.value) })} /></Label><Label>Fade (ms)<Input type="number" min="0" value={selected.fadeMs} onChange={(event) => replaceStep({ ...selected, fadeMs: Number(event.target.value) })} /></Label><Label className="flex items-center gap-2">Loop<Switch checked={selected.loop} onCheckedChange={(loop) => replaceStep({ ...selected, loop })} /></Label><Label className="flex items-center gap-2">Wait for completion<Switch checked={selected.waitForCompletion} onCheckedChange={(waitForCompletion) => replaceStep({ ...selected, waitForCompletion })} /></Label></>}
        {selected.type === 'set-variable' && <><Label>Variable<Select value={selected.variable.$ref.id} onValueChange={(id) => { if (id) replaceStep({ ...selected, variable: sceneVariableRef(id) }); }}>{Object.entries(project.variables).map(([id, item]) => <SelectItem key={id} value={id}>{item.label}</SelectItem>)}</Select></Label><Label>Value<Input value={String(selected.value)} onChange={(event) => replaceStep({ ...selected, value: scalar(event.target.value) })} /></Label></>}
        {selected.type === 'run-lua' && <><Label>Lua source<textarea className="min-h-32 w-full rounded border bg-background p-2 font-mono text-sm" value={selected.source} onChange={(event) => replaceStep({ ...selected, source: event.target.value })} /></Label><Label className="flex items-center gap-2">May yield<Switch checked={selected.mayYield} onCheckedChange={(mayYield) => replaceStep({ ...selected, mayYield })} /></Label></>}
        {selected.type === 'wait' && <><Label>Wait kind<Select value={selected.waitKind} onValueChange={(kind) => replaceStep(kind === 'input' ? { id: selected.id, label: selected.label, type: 'wait', enabled: selected.enabled, condition: selected.condition, waitKind: 'input', skippable: selected.skippable } : { id: selected.id, label: selected.label, type: 'wait', enabled: selected.enabled, condition: selected.condition, waitKind: 'duration', durationMs: 1000, skippable: selected.skippable })}><SelectItem value="duration">Duration</SelectItem><SelectItem value="input">Input</SelectItem></Select></Label>{selected.waitKind === 'duration' && <Label>Duration (ms)<Input type="number" min="0" value={selected.durationMs} onChange={(event) => replaceStep({ ...selected, durationMs: Number(event.target.value) })} /></Label>}</>}
        {selected.type === 'conditional-branch' && <><Label>Fallback step<Select value={selected.fallbackStepId} onValueChange={(fallbackStepId) => { if (fallbackStepId) replaceStep({ ...selected, fallbackStepId }); }}>{data.steps.map((step) => <SelectItem key={step.id} value={step.id}>{step.label}</SelectItem>)}</Select></Label><Button variant="outline" onClick={() => replaceStep({ ...selected, branches: [...selected.branches, { id: uniqueNestedId(selected.branches.map((branch) => branch.id), 'branch'), condition: { kind: 'always' }, targetStepId: data.steps[0]!.id }] })}>Add branch</Button>{selected.branches.map((branch, index) => <div key={branch.id} className="space-y-2 rounded border p-2"><Label>Branch ID<Input value={branch.id} onChange={(event) => replaceStep({ ...selected, branches: selected.branches.map((item, itemIndex) => itemIndex === index ? { ...item, id: event.target.value } : item) })} /></Label>{conditionEditor(branch.condition, (condition) => condition && replaceStep({ ...selected, branches: selected.branches.map((item, itemIndex) => itemIndex === index ? { ...item, condition } : item) }))}<Label>Target<Select value={branch.targetStepId} onValueChange={(targetStepId) => { if (targetStepId) replaceStep({ ...selected, branches: selected.branches.map((item, itemIndex) => itemIndex === index ? { ...item, targetStepId } : item) }); }}>{data.steps.map((step) => <SelectItem key={step.id} value={step.id}>{step.label}</SelectItem>)}</Select></Label></div>)}</>}
        {selected.type === 'choice' && <><Button variant="outline" onClick={() => replaceStep({ ...selected, options: [...selected.options, { id: uniqueNestedId(selected.options.map((option) => option.id), 'option'), label: { source: { kind: 'inline', text: 'Option' }, markup: 'active-text' }, effects: [], targetStepId: data.steps[0]!.id }] })}>Add option</Button>{selected.options.map((option, index) => <div key={option.id} className="space-y-2 rounded border p-2"><Label>Option ID<Input value={option.id} onChange={(event) => replaceStep({ ...selected, options: selected.options.map((item, itemIndex) => itemIndex === index ? { ...item, id: event.target.value } : item) })} /></Label><Input value={option.label.source.kind === 'inline' ? option.label.source.text : ''} onChange={(event) => replaceStep({ ...selected, options: selected.options.map((item, itemIndex) => itemIndex === index ? { ...item, label: { source: { kind: 'inline', text: event.target.value }, markup: item.label.markup } } : item) })} />{conditionEditor(option.condition, (condition) => replaceStep({ ...selected, options: selected.options.map((item, itemIndex) => itemIndex === index ? { ...item, condition } : item) }))}<Select value={option.targetStepId} onValueChange={(targetStepId) => { if (targetStepId) replaceStep({ ...selected, options: selected.options.map((item, itemIndex) => itemIndex === index ? { ...item, targetStepId } : item) }); }}>{data.steps.map((step) => <SelectItem key={step.id} value={step.id}>{step.label}</SelectItem>)}</Select><Button variant="outline" onClick={() => replaceStep({ ...selected, options: selected.options.map((item, itemIndex) => itemIndex === index ? { ...item, effects: [...item.effects, { kind: 'run-lua-effect', source: '-- Lua effect' }] } : item) })}>Add effect</Button>{option.effects.map((effect, effectIndex) => <div key={effectIndex}>{effectEditor(effect, (next) => replaceStep({ ...selected, options: selected.options.map((item, itemIndex) => itemIndex === index ? { ...item, effects: item.effects.map((current, currentIndex) => currentIndex === effectIndex ? next : current) } : item) }))}</div>)}</div>)}</>}
        {selected.type === 'set-layout' && <><Label>Layout<Select value={refId(selected.layout)} onValueChange={(id) => { if (id) replaceStep({ ...selected, layout: id === '__none__' ? null : sceneLayoutRef(id) }); }}><SelectItem value="__none__">None</SelectItem>{Object.entries(project.layouts).map(([id, item]) => <SelectItem key={id} value={id}>{item.label}</SelectItem>)}</Select></Label><Label>Action<Select value={selected.action} onValueChange={(action) => replaceStep({ ...selected, action: action as typeof selected.action })}>{['show','hide','swap'].map((value) => <SelectItem key={value} value={value}>{title(value)}</SelectItem>)}</Select></Label><Label>Slot<Select value={selected.slot} onValueChange={(slot) => replaceStep({ ...selected, slot: slot as typeof selected.slot })}>{['hud','dialogue-box','overlay','custom'].map((value) => <SelectItem key={value} value={value}>{title(value)}</SelectItem>)}</Select></Label><Label>Transition<Select value={selected.transition} onValueChange={(value) => {
          const transition = value as typeof selected.transition;
          replaceStep({ ...selected, transition, durationMs: transition === 'fade' ? Math.max(selected.durationMs, 250) : 0, waitForCompletion: transition === 'fade' && selected.waitForCompletion });
        }}><SelectItem value="none">None</SelectItem><SelectItem value="fade">Fade</SelectItem></Select></Label><Label>Duration (ms)<Input disabled={selected.transition === 'none'} type="number" min="0" value={selected.durationMs} onChange={(event) => replaceStep({ ...selected, durationMs: Number(event.target.value) })} /></Label><Label className="flex items-center gap-2">Wait for completion<Switch disabled={selected.transition === 'none'} checked={selected.waitForCompletion} onCheckedChange={(waitForCompletion) => replaceStep({ ...selected, waitForCompletion })} /></Label><Label className="flex items-center gap-2">Skippable<Switch disabled={selected.transition === 'none'} checked={selected.skippable} onCheckedChange={(skippable) => replaceStep({ ...selected, skippable })} /></Label></>}
        {selected.type === 'transition-group' && <>
          <Label>Transition<Select value={selected.transitionKind} onValueChange={(transitionKind) => replaceStep({ ...selected, transitionKind: transitionKind as typeof selected.transitionKind })}>{['fade','cut','dissolve'].map((value) => <SelectItem key={value} value={value}>{title(value)}</SelectItem>)}</Select></Label>
          <Label>Duration (ms)<Input type="number" min="0" value={selected.durationMs} onChange={(event) => replaceStep({ ...selected, durationMs: Number(event.target.value) })} /></Label>
          <Label>Fade color<Input disabled={selected.transitionKind !== 'fade'} value={selected.color ?? ''} onChange={(event) => replaceStep({ ...selected, color: event.target.value || null })} /></Label>
          <Label className="flex items-center gap-2">Wait for completion<Switch disabled={selected.transitionKind === 'cut'} checked={selected.waitForCompletion} onCheckedChange={(waitForCompletion) => replaceStep({ ...selected, waitForCompletion })} /></Label>
          <Label className="flex items-center gap-2">Skippable<Switch checked={selected.skippable} onCheckedChange={(skippable) => replaceStep({ ...selected, skippable })} /></Label>
          <div className="space-y-2 rounded border p-2">
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => replaceStep({ ...selected, children: [...selected.children, { id: uniqueNestedId(selected.children.map((child) => child.id), 'background'), type: 'set-background', asset: null, material: null, color: '#0f172a', fit: 'cover' }] })}>Add background</Button>
              <Button size="sm" variant="outline" onClick={() => replaceStep({ ...selected, children: [...selected.children, { id: uniqueNestedId(selected.children.map((child) => child.id), 'clear-background'), type: 'clear-background' }] })}>Clear background</Button>
              <Button size="sm" variant="outline" disabled={Object.keys(project.characters).length === 0} onClick={() => {
                const characterId = Object.keys(project.characters)[0];
                if (!characterId) return;
                replaceStep({ ...selected, children: [...selected.children, { id: uniqueNestedId(selected.children.map((child) => child.id), 'actor'), type: 'actor-cue', slotId: 'actor', character: sceneCharacterRef(characterId), action: 'show', poseId: null, expressionId: null, position: 'center', offset: { x: 0, y: 0 }, scale: 1 }] });
              }}>Add actor</Button>
              <Button size="sm" variant="outline" onClick={() => replaceStep({ ...selected, children: [...selected.children, { id: uniqueNestedId(selected.children.map((child) => child.id), 'layout'), type: 'set-layout', layout: null, action: 'hide', slot: 'overlay' }] })}>Add Layout</Button>
            </div>
            {selected.children.map((child, childIndex) => {
              const updateChild = (next: SceneTransitionGroupChildData) => replaceStep({ ...selected, children: selected.children.map((item, index) => index === childIndex ? next : item) });
              return <div key={child.id} className="space-y-2 rounded border p-2">
                <div className="flex items-center gap-2"><Badge variant="outline">{title(child.type)}</Badge><Button size="sm" variant="ghost" disabled={selected.children.length === 1} onClick={() => replaceStep({ ...selected, children: selected.children.filter((_, index) => index !== childIndex) })}>Remove</Button></div>
                <Label>Child ID<Input value={child.id} onChange={(event) => updateChild({ ...child, id: event.target.value } as SceneTransitionGroupChildData)} /></Label>
                {child.type === 'set-background' && <><Label>Asset<Select value={refId(child.asset)} onValueChange={(id) => { if (id) updateChild({ ...child, asset: id === '__none__' ? null : sceneAssetRef(id) }); }}><SelectItem value="__none__">None</SelectItem>{Object.entries(project.assets).map(([id, item]) => <SelectItem key={id} value={id}>{item.label}</SelectItem>)}</Select></Label><Label>Material<Select value={refId(child.material)} onValueChange={(id) => { if (id) updateChild({ ...child, material: id === '__none__' ? null : sceneMaterialRef(id) }); }}><SelectItem value="__none__">None</SelectItem>{Object.entries(project.materials).map(([id, item]) => <SelectItem key={id} value={id}>{item.label}</SelectItem>)}</Select></Label><Label>Color<Input value={child.color ?? ''} onChange={(event) => updateChild({ ...child, color: event.target.value || null })} /></Label><Label>Fit<Select value={child.fit} onValueChange={(fit) => updateChild({ ...child, fit: fit as typeof child.fit })}>{['cover','contain','stretch','center'].map((value) => <SelectItem key={value} value={value}>{title(value)}</SelectItem>)}</Select></Label></>}
                {child.type === 'actor-cue' && <><Label>Actor slot<Input value={child.slotId} onChange={(event) => updateChild({ ...child, slotId: event.target.value })} /></Label><Label>Character<Select value={child.character.$ref.id} onValueChange={(id) => { if (id) updateChild({ ...child, character: sceneCharacterRef(id) }); }}>{Object.entries(project.characters).map(([id, item]) => <SelectItem key={id} value={id}>{item.label}</SelectItem>)}</Select></Label><Label>Action<Select value={child.action} onValueChange={(action) => updateChild({ ...child, action: action as typeof child.action })}>{['show','hide','move','pose','expression'].map((value) => <SelectItem key={value} value={value}>{title(value)}</SelectItem>)}</Select></Label><Label>Pose ID<Input value={child.poseId ?? ''} onChange={(event) => updateChild({ ...child, poseId: event.target.value || null })} /></Label><Label>Expression ID<Input value={child.expressionId ?? ''} onChange={(event) => updateChild({ ...child, expressionId: event.target.value || null })} /></Label><Label>Position<Select value={child.position} onValueChange={(position) => updateChild({ ...child, position: position as typeof child.position })}>{['left','center','right','custom'].map((value) => <SelectItem key={value} value={value}>{title(value)}</SelectItem>)}</Select></Label><Label>Offset X<Input type="number" value={child.offset.x} onChange={(event) => updateChild({ ...child, offset: { ...child.offset, x: Number(event.target.value) } })} /></Label><Label>Offset Y<Input type="number" value={child.offset.y} onChange={(event) => updateChild({ ...child, offset: { ...child.offset, y: Number(event.target.value) } })} /></Label><Label>Scale<Input type="number" min="0.01" step="0.05" value={child.scale} onChange={(event) => updateChild({ ...child, scale: Number(event.target.value) })} /></Label></>}
                {child.type === 'set-layout' && <><Label>Layout<Select value={refId(child.layout)} onValueChange={(id) => { if (id) updateChild({ ...child, layout: id === '__none__' ? null : sceneLayoutRef(id) }); }}><SelectItem value="__none__">None</SelectItem>{Object.entries(project.layouts).map(([id, item]) => <SelectItem key={id} value={id}>{item.label}</SelectItem>)}</Select></Label><Label>Action<Select value={child.action} onValueChange={(action) => updateChild({ ...child, action: action as typeof child.action })}>{['show','hide','swap'].map((value) => <SelectItem key={value} value={value}>{title(value)}</SelectItem>)}</Select></Label><Label>WorldOverlay slot<Select value={child.slot} onValueChange={(slot) => updateChild({ ...child, slot: slot as 'overlay' | 'custom' })}><SelectItem value="overlay">Overlay</SelectItem><SelectItem value="custom">Custom</SelectItem></Select></Label></>}
              </div>;
            })}
          </div>
        </>}
        {selected.type === 'comment' && <Label>Comment<textarea className="min-h-28 w-full rounded border bg-background p-2 text-sm" value={selected.text} onChange={(event) => replaceStep({ ...selected, text: event.target.value })} /></Label>}
      </div>}
      <div className="mt-6"><DiagnosticList items={diagnosticItems} emptyMessage="No scene diagnostics." /></div>
    </section>

    <DerivedPreviewPane ownerTabId={tab.id} previewMode="scene" previewDocument={previewDocument} />
  </div>;
}
