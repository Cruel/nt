import { useMemo, useRef, useState } from 'react';
import { EnginePreview } from '@/components/engine-preview';
import { SourceEditor } from '@/components/source/SourceEditor';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectItem } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useCommandStore } from '@/commands/command-store';
import { useProjectStore } from '@/project/project-store';
import {
  defaultDialogueData,
  dialogueBlockTypeValues,
  dialogueCharacterRef,
  dialogueEdgeKindValues,
  dialogueLogModeValues,
  dialoguePreviewBackgroundValues,
  dialogueSegmentTypeValues,
  dialogueTextModeValues,
  parseDialogueData,
  validateDialogueData,
  type DialogueBlockData,
  type DialogueData,
  type DialogueEdgeData,
  type DialogueSegmentData,
} from '../../../shared/project-schema/authoring-dialogues';
import { isAuthoringProject } from '../../../shared/project-schema/authoring-project';
import { buildDialoguePreviewDocumentData, dialoguePreviewRevision } from '../../../shared/project-schema/dialogue-project';
import type { WorkbenchEditorProps } from '@/workbench/editor-registry';
import {
  captureScrollViewState,
  captureSourceEditorViewStates,
  isGraphViewportState,
  isScrollViewState,
  parseSourceEditorViewStates,
  restoreScrollViewState,
  restoreSourceEditorViewStates,
  useSourceEditorViewStateRefs,
  useWorkbenchEditorTabState,
  type GraphViewportState,
  type ScrollViewState,
  type SourceEditorViewStates,
  type WorkbenchTabStatePayload,
} from '@/workbench/workbench-tab-state';
import { DialogueGraph } from './DialogueGraph';

const DIALOGUE_EDITOR_TAB_STATE_SCHEMA = 'noveltea.editor.tab-state.dialogue';

interface DialogueEditorTabStatePayload {
  scroll?: ScrollViewState;
  graphViewport?: GraphViewportState;
  sourceViewStates?: SourceEditorViewStates;
}

type DialogueEditorTabState = WorkbenchTabStatePayload & {
  schema: typeof DIALOGUE_EDITOR_TAB_STATE_SCHEMA;
  payload?: DialogueEditorTabStatePayload;
};

function parseDialogueEditorTabState(value: WorkbenchTabStatePayload): DialogueEditorTabStatePayload | null {
  if (value.schema !== DIALOGUE_EDITOR_TAB_STATE_SCHEMA || typeof value.payload !== 'object' || value.payload === null || Array.isArray(value.payload)) return null;
  const payload = value.payload as Record<string, unknown>;
  return {
    scroll: isScrollViewState(payload.scroll) ? payload.scroll : undefined,
    graphViewport: isGraphViewportState(payload.graphViewport) ? payload.graphViewport : undefined,
    sourceViewStates: parseSourceEditorViewStates(payload.sourceViewStates),
  };
}

function commitDialogue(dialogueId: string, next: DialogueData, label: string) {
  return useCommandStore.getState().executeCommand({
    type: 'dialogue.replaceData',
    label,
    payload: { dialogueId, data: next },
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

function refValue(ref: { $ref: { id: string } } | null | undefined) {
  return ref?.$ref.id ?? '__none__';
}

function selectedBlock(data: DialogueData) {
  return data.blocks.find((block) => block.id === data.preview.selectedBlockId)
    ?? data.blocks.find((block) => block.id === data.entryBlockId)
    ?? data.blocks[0]
    ?? null;
}

function selectedSegment(data: DialogueData, block: DialogueBlockData | null) {
  if (!block) return null;
  return block.segments.find((segment) => segment.id === data.preview.selectedSegmentId)
    ?? block.segments[0]
    ?? null;
}

function allSegmentIds(blocks: DialogueBlockData[]) {
  return blocks.flatMap((block) => block.segments.map((segment) => segment.id));
}

function fallbackSelection(blocks: DialogueBlockData[], preferredBlockId?: string | null): Pick<DialogueData['preview'], 'selectedBlockId' | 'selectedSegmentId'> {
  const block = blocks.find((item) => item.id === preferredBlockId) ?? blocks[0] ?? null;
  return { selectedBlockId: block?.id ?? null, selectedSegmentId: block?.segments[0]?.id ?? null };
}

export function DialogueEditor({ tab }: WorkbenchEditorProps) {
  const projectDocument = useProjectStore((state) => state.document);
  const dialogueId = tab.resource?.entityId;
  const project = isAuthoringProject(projectDocument) ? projectDocument : null;
  const record = dialogueId && project ? project.dialogues[dialogueId] : null;
  const parsedData = parseDialogueData(record?.data);
  const data = parsedData ?? defaultDialogueData(record?.label ?? dialogueId ?? 'Dialogue');
  const diagnostics = useMemo(() => project && record && dialogueId ? validateDialogueData(project, dialogueId, record) : [], [project, record, dialogueId]);
  const characters = project ? Object.entries(project.characters).map(([id, character]) => ({ id, label: character.label })) : [];
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const graphViewportRef = useRef<GraphViewportState | null>(null);
  const [graphViewport, setGraphViewport] = useState<GraphViewportState | null>(null);
  const sourceEditors = useSourceEditorViewStateRefs<'segmentText' | 'segmentCondition' | 'segmentScript'>();

  useWorkbenchEditorTabState<DialogueEditorTabState>(tab.id, useMemo(() => ({
    captureTabState: () => ({
      schema: DIALOGUE_EDITOR_TAB_STATE_SCHEMA,
      schemaVersion: 1,
      payload: {
        scroll: captureScrollViewState(scrollRef.current),
        graphViewport: graphViewportRef.current ?? undefined,
        sourceViewStates: captureSourceEditorViewStates(sourceEditors.refs.current),
      },
    }),
    restoreTabState: (state: DialogueEditorTabState) => {
      const parsed = parseDialogueEditorTabState(state);
      if (!parsed) return;
      graphViewportRef.current = parsed.graphViewport ?? null;
      setGraphViewport(parsed.graphViewport ?? null);
      window.requestAnimationFrame(() => {
        restoreScrollViewState(scrollRef.current, parsed.scroll);
        restoreSourceEditorViewStates(sourceEditors.refs.current, parsed.sourceViewStates);
      });
    },
  }), [sourceEditors.refs]));

  if (!dialogueId || !record || !project) return <div className="p-4 text-sm text-muted-foreground">Dialogue record not found.</div>;

  const activeDialogueId = dialogueId;
  const activeProject = project;
  const activeRecord = record;
  const activeBlock = selectedBlock(data);
  const activeSegment = selectedSegment(data, activeBlock);
  const revision = dialoguePreviewRevision(activeProject, activeDialogueId);
  const previewDocument = {
    kind: 'dialogue-preview' as const,
    recordId: activeDialogueId,
    revision,
    data: buildDialoguePreviewDocumentData(activeProject, activeDialogueId),
  };
  const outgoingEdges = activeBlock ? data.edges
    .filter((edge) => edge.fromBlockId === activeBlock.id)
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id)) : [];

  function commit(next: DialogueData, label = 'Update dialogue') {
    commitDialogue(activeDialogueId, next, label);
  }

  function patchSettings(patch: Partial<DialogueData['settings']>) {
    commit({ ...data, settings: { ...data.settings, ...patch } }, 'Update dialogue settings');
  }

  function patchPreview(patch: Partial<DialogueData['preview']>) {
    commit({ ...data, preview: { ...data.preview, ...patch } }, 'Update dialogue preview');
  }

  function replaceBlock(blockId: string, patch: Partial<DialogueBlockData>) {
    commit({ ...data, blocks: data.blocks.map((block) => block.id === blockId ? { ...block, ...patch } : block) }, 'Update dialogue block');
  }

  function addBlock(type: DialogueBlockData['type'] = 'linear') {
    const id = nextUniqueId(data.blocks.map((block) => block.id), type === 'branch' ? 'branch' : 'block');
    const block: DialogueBlockData = {
      id,
      type,
      label: type === 'branch' ? 'Branch' : 'Block',
      defaultSpeaker: null,
      segments: type === 'link' ? [] : [{
        id: nextUniqueId(allSegmentIds(data.blocks), 'line'),
        type: 'line',
        speaker: null,
        text: { mode: 'plain', source: '' },
        condition: { enabled: false, source: '' },
        script: { enabled: false, source: '' },
        flags: { showOnce: false, autosave: false, logged: true },
      }],
      link: { targetBlockId: null },
      graph: { x: 240 + data.blocks.length * 32, y: 80 + data.blocks.length * 24 },
    };
    commit({
      ...data,
      blocks: [...data.blocks, block],
      preview: { ...data.preview, selectedBlockId: id, selectedSegmentId: block.segments[0]?.id ?? null },
    }, 'Add dialogue block');
  }

  function deleteBlock(blockId: string) {
    if (data.blocks.length <= 1) return;
    const remaining = data.blocks.filter((block) => block.id !== blockId);
    const selection = fallbackSelection(remaining, data.entryBlockId === blockId ? remaining[0]?.id : data.preview.selectedBlockId);
    commit({
      ...data,
      entryBlockId: data.entryBlockId === blockId ? remaining[0]!.id : data.entryBlockId,
      blocks: remaining,
      edges: data.edges.filter((edge) => edge.fromBlockId !== blockId && edge.toBlockId !== blockId),
      preview: { ...data.preview, ...selection },
    }, 'Delete dialogue block');
  }

  function selectBlock(blockId: string) {
    const block = data.blocks.find((item) => item.id === blockId);
    if (!block) return;
    patchPreview({ selectedBlockId: block.id, selectedSegmentId: block.segments[0]?.id ?? null });
  }

  function moveBlock(blockId: string, graph: DialogueBlockData['graph']) {
    replaceBlock(blockId, { graph });
  }

  function replaceSegment(blockId: string, segmentId: string, patch: Partial<DialogueSegmentData>) {
    commit({
      ...data,
      blocks: data.blocks.map((block) => block.id === blockId ? {
        ...block,
        segments: block.segments.map((segment) => segment.id === segmentId ? { ...segment, ...patch } : segment),
      } : block),
    }, 'Update dialogue segment');
  }

  function addSegment(blockId: string, type: DialogueSegmentData['type'] = 'line') {
    const id = nextUniqueId(allSegmentIds(data.blocks), type === 'script' ? 'script' : 'line');
    const next: DialogueSegmentData = {
      id,
      type,
      speaker: null,
      text: { mode: type === 'script' ? 'lua' : 'plain', source: '' },
      condition: { enabled: false, source: '' },
      script: { enabled: false, source: '' },
      flags: { showOnce: false, autosave: false, logged: true },
    };
    commit({
      ...data,
      blocks: data.blocks.map((block) => block.id === blockId ? { ...block, segments: [...block.segments, next] } : block),
      preview: { ...data.preview, selectedBlockId: blockId, selectedSegmentId: id },
    }, 'Add dialogue segment');
  }

  function deleteSegment(blockId: string, segmentId: string) {
    const block = data.blocks.find((item) => item.id === blockId);
    if (!block || block.segments.length <= 1) return;
    const nextSegments = block.segments.filter((segment) => segment.id !== segmentId);
    commit({
      ...data,
      blocks: data.blocks.map((item) => item.id === blockId ? { ...item, segments: nextSegments } : item),
      preview: {
        ...data.preview,
        selectedBlockId: blockId,
        selectedSegmentId: data.preview.selectedSegmentId === segmentId ? nextSegments[0]!.id : data.preview.selectedSegmentId,
      },
    }, 'Delete dialogue segment');
  }

  function moveSegment(blockId: string, segmentId: string, direction: -1 | 1) {
    const block = data.blocks.find((item) => item.id === blockId);
    if (!block) return;
    const index = block.segments.findIndex((segment) => segment.id === segmentId);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= block.segments.length) return;
    const segments = [...block.segments];
    const [segment] = segments.splice(index, 1);
    segments.splice(nextIndex, 0, segment!);
    commit({ ...data, blocks: data.blocks.map((item) => item.id === blockId ? { ...item, segments } : item) }, 'Move dialogue segment');
  }

  function replaceEdge(edgeId: string, patch: Partial<DialogueEdgeData>) {
    commit({ ...data, edges: data.edges.map((edge) => edge.id === edgeId ? { ...edge, ...patch } : edge) }, 'Update dialogue choice');
  }

  function addEdge(fromBlockId: string, toBlockId: string, kind: DialogueEdgeData['kind'] = 'choice') {
    const id = nextUniqueId(data.edges.map((edge) => edge.id), kind);
    const order = data.edges.filter((edge) => edge.fromBlockId === fromBlockId && edge.kind === kind).length;
    const edge: DialogueEdgeData = {
      id,
      fromBlockId,
      toBlockId,
      kind,
      label: kind === 'choice' ? 'Choice' : '',
      order,
      condition: { enabled: false, source: '' },
      script: { enabled: false, source: '' },
    };
    commit({ ...data, edges: [...data.edges, edge] }, 'Add dialogue choice');
  }

  function deleteEdge(edgeId: string) {
    commit({ ...data, edges: data.edges.filter((edge) => edge.id !== edgeId) }, 'Delete dialogue choice');
  }

  return (
    <div ref={scrollRef} className="flex h-full min-h-0 flex-col overflow-auto bg-background p-4" data-dialogue-editor-scroll>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-lg font-semibold">{activeRecord.label}</h2>
            <Badge variant="outline">{activeDialogueId}</Badge>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">Branch map, dense dialogue blocks, segment scripts, choices, and live authoring preview.</p>
        </div>
      </div>

      {!parsedData ? <div className="mt-3 rounded border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">Dialogue data was invalid; showing editable defaults until you apply a change.</div> : null}

      <div className="mt-4 grid gap-4 xl:grid-cols-[1fr_360px]">
        <div className="space-y-4">
          <section className="grid gap-3 rounded border p-3 md:grid-cols-2 xl:grid-cols-4">
            <div className="space-y-1">
              <Label>Display name</Label>
              <Input value={data.displayName} onChange={(event) => commit({ ...data, displayName: event.currentTarget.value }, 'Update dialogue display name')} />
            </div>
            <div className="space-y-1">
              <Label>Default speaker</Label>
              <Select value={refValue(data.defaultSpeaker)} onValueChange={(value) => commit({ ...data, defaultSpeaker: value === '__none__' ? null : dialogueCharacterRef(String(value)) }, 'Update dialogue speaker')}>
                <SelectItem value="__none__">No default speaker</SelectItem>
                {characters.map((character) => <SelectItem key={character.id} value={character.id}>{character.label} ({character.id})</SelectItem>)}
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Entry block</Label>
              <Select value={data.entryBlockId} onValueChange={(value) => commit({ ...data, entryBlockId: String(value) }, 'Update dialogue entry block')}>
                {data.blocks.map((block) => <SelectItem key={block.id} value={block.id}>{block.label} ({block.id})</SelectItem>)}
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Log mode</Label>
              <Select value={data.settings.logMode} onValueChange={(value) => patchSettings({ logMode: value as DialogueData['settings']['logMode'] })}>
                {dialogueLogModeValues.map((mode) => <SelectItem key={mode} value={mode}>{mode}</SelectItem>)}
              </Select>
            </div>
            <div className="flex items-center gap-2">
              <Switch checked={data.settings.showDisabledChoices} onCheckedChange={(checked) => patchSettings({ showDisabledChoices: Boolean(checked) })} />
              <Label>Show disabled choices</Label>
            </div>
            <div className="flex items-center gap-2">
              <Switch checked={data.settings.allowDisabledChoiceSelection} onCheckedChange={(checked) => patchSettings({ allowDisabledChoiceSelection: Boolean(checked) })} />
              <Label>Allow disabled choices</Label>
            </div>
          </section>

          <section className="space-y-3 rounded border p-3">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-medium">Branch map</h3>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => addBlock('linear')}>Add Block</Button>
                <Button size="sm" variant="outline" onClick={() => addBlock('branch')}>Add Branch</Button>
              </div>
            </div>
            <DialogueGraph
              blocks={data.blocks}
              edges={data.edges}
              selectedBlockId={activeBlock?.id ?? null}
              onSelectBlock={selectBlock}
              onMoveBlock={moveBlock}
              onConnectBlocks={(fromBlockId, toBlockId) => addEdge(fromBlockId, toBlockId, 'choice')}
              viewport={graphViewport}
              onViewportChange={(viewport) => {
                graphViewportRef.current = viewport;
                setGraphViewport(viewport);
              }}
            />
          </section>

          {activeBlock ? (
            <section className="space-y-3 rounded border p-3">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <h3 className="text-sm font-medium">Block transcript</h3>
                  <p className="text-xs text-muted-foreground">Dense dialogue lives here; the graph only shows high-level branch blocks.</p>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => addSegment(activeBlock.id, 'line')}>Add Line</Button>
                  <Button size="sm" variant="outline" onClick={() => addSegment(activeBlock.id, 'script')}>Add Script</Button>
                </div>
              </div>
              <div className="space-y-2">
                {activeBlock.segments.map((segment, index) => (
                  <button
                    key={segment.id}
                    className={`w-full rounded border p-2 text-left text-sm ${segment.id === activeSegment?.id ? 'border-primary bg-primary/5' : 'bg-background'}`}
                    onClick={() => patchPreview({ selectedBlockId: activeBlock.id, selectedSegmentId: segment.id })}
                  >
                    <div className="flex items-center gap-2">
                      <Badge variant="outline">{index + 1}</Badge>
                      <span className="font-medium">{segment.type}</span>
                      <span className="text-xs text-muted-foreground">{segment.id}</span>
                    </div>
                    <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">{segment.text.source || '[empty line]'}</div>
                  </button>
                ))}
              </div>
            </section>
          ) : null}
        </div>

        <aside className="space-y-4">
          <section className="space-y-3 rounded border p-3">
            <h3 className="text-sm font-medium">Preview</h3>
            <EnginePreview chrome="minimal" previewMode="dialogue" previewDocument={previewDocument} />
            <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-1">
              <div className="space-y-1">
                <Label>Background</Label>
                <Select value={data.preview.background} onValueChange={(value) => patchPreview({ background: value as DialogueData['preview']['background'] })}>
                  {dialoguePreviewBackgroundValues.map((background) => <SelectItem key={background} value={background}>{background}</SelectItem>)}
                </Select>
              </div>
              <div className="flex items-center gap-2 pt-6">
                <Switch checked={data.preview.showConditions} onCheckedChange={(checked) => patchPreview({ showConditions: Boolean(checked) })} />
                <Label>Show condition indicators</Label>
              </div>
            </div>
          </section>

          {activeBlock ? (
            <section className="space-y-3 rounded border p-3">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-medium">Block</h3>
                <Button size="sm" variant="outline" onClick={() => deleteBlock(activeBlock.id)} disabled={data.blocks.length <= 1}>Delete</Button>
              </div>
              <div className="space-y-1">
                <Label>Block ID</Label>
                <Input value={activeBlock.id} onChange={(event) => replaceBlock(activeBlock.id, { id: event.currentTarget.value })} />
              </div>
              <div className="space-y-1">
                <Label>Label</Label>
                <Input value={activeBlock.label} onChange={(event) => replaceBlock(activeBlock.id, { label: event.currentTarget.value })} />
              </div>
              <div className="space-y-1">
                <Label>Type</Label>
                <Select value={activeBlock.type} onValueChange={(value) => replaceBlock(activeBlock.id, { type: value as DialogueBlockData['type'] })}>
                  {dialogueBlockTypeValues.map((type) => <SelectItem key={type} value={type}>{type}</SelectItem>)}
                </Select>
              </div>
              <div className="space-y-1">
                <Label>Block speaker</Label>
                <Select value={refValue(activeBlock.defaultSpeaker)} onValueChange={(value) => replaceBlock(activeBlock.id, { defaultSpeaker: value === '__none__' ? null : dialogueCharacterRef(String(value)) })}>
                  <SelectItem value="__none__">Use dialogue default</SelectItem>
                  {characters.map((character) => <SelectItem key={character.id} value={character.id}>{character.label} ({character.id})</SelectItem>)}
                </Select>
              </div>
              {activeBlock.type === 'link' ? (
                <div className="space-y-1">
                  <Label>Link target</Label>
                  <Select value={activeBlock.link.targetBlockId ?? '__none__'} onValueChange={(value) => replaceBlock(activeBlock.id, { link: { targetBlockId: value === '__none__' ? null : String(value) } })}>
                    <SelectItem value="__none__">No link target</SelectItem>
                    {data.blocks.filter((block) => block.id !== activeBlock.id).map((block) => <SelectItem key={block.id} value={block.id}>{block.label} ({block.id})</SelectItem>)}
                  </Select>
                </div>
              ) : null}
            </section>
          ) : null}

          {activeBlock && activeSegment ? (
            <section className="space-y-3 rounded border p-3">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-medium">Segment</h3>
                <div className="flex gap-1">
                  <Button size="sm" variant="outline" onClick={() => moveSegment(activeBlock.id, activeSegment.id, -1)}>Up</Button>
                  <Button size="sm" variant="outline" onClick={() => moveSegment(activeBlock.id, activeSegment.id, 1)}>Down</Button>
                  <Button size="sm" variant="outline" onClick={() => deleteSegment(activeBlock.id, activeSegment.id)} disabled={activeBlock.segments.length <= 1}>Delete</Button>
                </div>
              </div>
              <div className="space-y-1">
                <Label>Segment ID</Label>
                <Input value={activeSegment.id} onChange={(event) => replaceSegment(activeBlock.id, activeSegment.id, { id: event.currentTarget.value })} />
              </div>
              <div className="space-y-1">
                <Label>Type</Label>
                <Select value={activeSegment.type} onValueChange={(value) => replaceSegment(activeBlock.id, activeSegment.id, { type: value as DialogueSegmentData['type'] })}>
                  {dialogueSegmentTypeValues.map((type) => <SelectItem key={type} value={type}>{type}</SelectItem>)}
                </Select>
              </div>
              <div className="space-y-1">
                <Label>Speaker</Label>
                <Select value={refValue(activeSegment.speaker)} onValueChange={(value) => replaceSegment(activeBlock.id, activeSegment.id, { speaker: value === '__none__' ? null : dialogueCharacterRef(String(value)) })}>
                  <SelectItem value="__none__">Use block/default speaker</SelectItem>
                  {characters.map((character) => <SelectItem key={character.id} value={character.id}>{character.label} ({character.id})</SelectItem>)}
                </Select>
              </div>
              <div className="space-y-1">
                <Label>Text mode</Label>
                <Select value={activeSegment.text.mode} onValueChange={(value) => replaceSegment(activeBlock.id, activeSegment.id, { text: { ...activeSegment.text, mode: value as DialogueSegmentData['text']['mode'] } })}>
                  {dialogueTextModeValues.map((mode) => <SelectItem key={mode} value={mode}>{mode}</SelectItem>)}
                </Select>
              </div>
              <div className="space-y-1">
                <Label>Text</Label>
                <SourceEditor ref={sourceEditors.refFor('segmentText')} className="h-40" language={activeSegment.text.mode === 'lua' ? 'lua' : 'text'} value={activeSegment.text.source} onChange={(source) => replaceSegment(activeBlock.id, activeSegment.id, { text: { ...activeSegment.text, source } })} />
              </div>
              <div className="flex items-center gap-2">
                <Switch checked={activeSegment.condition.enabled} onCheckedChange={(checked) => replaceSegment(activeBlock.id, activeSegment.id, { condition: { ...activeSegment.condition, enabled: Boolean(checked) } })} />
                <Label>Condition</Label>
              </div>
              <SourceEditor ref={sourceEditors.refFor('segmentCondition')} className="h-28" language="lua" value={activeSegment.condition.source} onChange={(source) => replaceSegment(activeBlock.id, activeSegment.id, { condition: { ...activeSegment.condition, source } })} />
              <div className="flex items-center gap-2">
                <Switch checked={activeSegment.script.enabled} onCheckedChange={(checked) => replaceSegment(activeBlock.id, activeSegment.id, { script: { ...activeSegment.script, enabled: Boolean(checked) } })} />
                <Label>Script</Label>
              </div>
              <SourceEditor ref={sourceEditors.refFor('segmentScript')} className="h-28" language="lua" value={activeSegment.script.source} onChange={(source) => replaceSegment(activeBlock.id, activeSegment.id, { script: { ...activeSegment.script, source } })} />
              <div className="grid gap-2 text-xs">
                <label className="flex items-center gap-2"><Switch checked={activeSegment.flags.showOnce} onCheckedChange={(checked) => replaceSegment(activeBlock.id, activeSegment.id, { flags: { ...activeSegment.flags, showOnce: Boolean(checked) } })} /> Show once</label>
                <label className="flex items-center gap-2"><Switch checked={activeSegment.flags.autosave} onCheckedChange={(checked) => replaceSegment(activeBlock.id, activeSegment.id, { flags: { ...activeSegment.flags, autosave: Boolean(checked) } })} /> Autosave</label>
                <label className="flex items-center gap-2"><Switch checked={activeSegment.flags.logged} onCheckedChange={(checked) => replaceSegment(activeBlock.id, activeSegment.id, { flags: { ...activeSegment.flags, logged: Boolean(checked) } })} /> Logged</label>
              </div>
            </section>
          ) : null}

          {activeBlock ? (
            <section className="space-y-3 rounded border p-3">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-medium">Outgoing choices</h3>
                <Button size="sm" variant="outline" onClick={() => addEdge(activeBlock.id, data.blocks.find((block) => block.id !== activeBlock.id)?.id ?? activeBlock.id, 'choice')}>Add Choice</Button>
              </div>
              {outgoingEdges.length === 0 ? <div className="text-xs text-muted-foreground">No outgoing choices yet.</div> : null}
              {outgoingEdges.map((edge) => (
                <div key={edge.id} className="space-y-2 rounded border p-2">
                  <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-1">
                    <div className="space-y-1">
                      <Label>Label</Label>
                      <Input value={edge.label} onChange={(event) => replaceEdge(edge.id, { label: event.currentTarget.value })} />
                    </div>
                    <div className="space-y-1">
                      <Label>Target</Label>
                      <Select value={edge.toBlockId} onValueChange={(value) => replaceEdge(edge.id, { toBlockId: String(value) })}>
                        {data.blocks.map((block) => <SelectItem key={block.id} value={block.id}>{block.label} ({block.id})</SelectItem>)}
                      </Select>
                    </div>
                    <div className="space-y-1">
                      <Label>Kind</Label>
                      <Select value={edge.kind} onValueChange={(value) => replaceEdge(edge.id, { kind: value as DialogueEdgeData['kind'] })}>
                        {dialogueEdgeKindValues.map((kind) => <SelectItem key={kind} value={kind}>{kind}</SelectItem>)}
                      </Select>
                    </div>
                    <div className="space-y-1">
                      <Label>Order</Label>
                      <Input value={String(edge.order)} onChange={(event) => replaceEdge(edge.id, { order: Number.parseInt(event.currentTarget.value, 10) || 0 })} />
                    </div>
                  </div>
                  <Button size="sm" variant="outline" onClick={() => deleteEdge(edge.id)}>Delete Choice</Button>
                </div>
              ))}
            </section>
          ) : null}

          <section className="space-y-2 rounded border p-3">
            <h3 className="text-sm font-medium">Diagnostics</h3>
            {diagnostics.length === 0 ? <div className="text-xs text-muted-foreground">No dialogue diagnostics.</div> : null}
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
