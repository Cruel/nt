import { useEffect, useMemo, useRef, useState } from 'react';
import { SourceEditor } from '@/components/source/SourceEditor';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { RecursiveConditionEditor } from '@/components/conditions/ConditionEditor';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectItem } from '@/components/ui/select';
import type { AuthoringEditorProject } from '@/editors/interactions/InteractionProgramEditor';
import { Switch } from '@/components/ui/switch';
import { useCommandStore } from '@/commands/command-store';
import { recordSaveUnitId } from '@/project/save-unit-registry';
import { DiagnosticList } from '@/diagnostics/DiagnosticList';
import { resolveProjectDiagnosticTarget } from '@/diagnostics/diagnostic-navigation';
import { DerivedPreviewPane } from '@/preview/DerivedPreviewPane';
import { useProjectStore } from '@/project/project-store';
import type { WorkbenchEditorProps } from '@/workbench/editor-registry';
import { registerWorkbenchTargetHandler } from '@/workbench/workbench-navigation';
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
import {
  defaultDialogueBlock,
  defaultDialogueData,
  defaultDialogueSegment,
  dialogueBlockTypeValues,
  dialogueCharacterRef,
  dialogueLogModeValues,
  dialoguePreviewBackgroundValues,
  dialogueSegmentTypeValues,
  parseDialogueData,
  validateDialogueData,
  type DialogueBlockData,
  type DialogueChoiceEdgeData,
  type DialogueConditionData,
  type DialogueData,
  type DialogueEdgeData,
  type DialogueEffectData,
  type DialogueLineCue,
  type DialoguePreviewBackground,
  type DialogueMediaContent,
  type DialogueMediaMutation,
  type DialogueMediaSlotData,
  type DialogueSegmentData,
  type DialogueStageMutation,
  type DialogueStageSlotData,
  type DialogueStageSlotState,
  type DialogueSequenceBlockData,
} from '../../../shared/project-schema/authoring-dialogues';
import {
  parseDialogueCueMarkup,
  serializeDialogueCueMarkup,
} from '../../../shared/project-schema/dialogue-cue-markup';
import { parseCharacterData } from '../../../shared/project-schema/authoring-characters';
import { parseSceneData } from '../../../shared/project-schema/authoring-scenes';
import {
  inlineTextContent,
  type FlowTarget,
  type TextContent,
} from '../../../shared/project-schema/authoring-flow';
import { isValidEntityId } from '../../../shared/project-schema/authoring-common';
import { isAuthoringProject } from '../../../shared/project-schema/authoring-project';
import {
  buildDialoguePreviewDocumentData,
  dialoguePreviewRevision,
} from '../../../shared/project-schema/dialogue-project';
import { DialogueGraph } from './DialogueGraph';

const DIALOGUE_EDITOR_TAB_STATE_SCHEMA = 'noveltea.editor.tab-state.dialogue';

type DialogueLineSegment = Extract<DialogueSegmentData, { type: 'line' }>;
interface DialogueLinePresentationEditorView {
  speakerExpressionId?: string;
  stage: DialogueStageMutation[];
  media: DialogueMediaMutation[];
}
type DialogueLineEditorSegment = DialogueLineSegment & {
  presentation: DialogueLinePresentationEditorView;
};
type DialogueEditorSegment =
  | Exclude<DialogueSegmentData, { type: 'line' }>
  | DialogueLineEditorSegment;

function presentationEditorView(segment: DialogueLineSegment): DialogueLinePresentationEditorView {
  const expression = segment.cues.find(
    (cue): cue is Extract<DialogueLineCue, { kind: 'speaker-expression' }> =>
      cue.kind === 'speaker-expression',
  );
  return {
    ...(expression ? { speakerExpressionId: expression.expressionId } : {}),
    stage: segment.cues
      .filter((cue): cue is Extract<DialogueLineCue, { kind: 'stage' }> => cue.kind === 'stage')
      .map((cue) => cue.mutation),
    media: segment.cues
      .filter((cue): cue is Extract<DialogueLineCue, { kind: 'media' }> => cue.kind === 'media')
      .map((cue) => cue.mutation),
  };
}

function cuesFromPresentationEditorView(
  segment: DialogueLineSegment,
  presentation: DialogueLinePresentationEditorView,
): DialogueLineCue[] {
  const retained: DialogueLineCue[] = segment.cues.filter(
    (cue) =>
      cue.kind === 'active-text' ||
      cue.kind === 'invalid-markup' ||
      cue.kind === 'gesture' ||
      cue.kind === 'voice' ||
      cue.kind === 'sound-effect' ||
      cue.kind === 'camera',
  );
  const oldStage = segment.cues.filter(
    (cue): cue is Extract<DialogueLineCue, { kind: 'stage' }> => cue.kind === 'stage',
  );
  const oldMedia = segment.cues.filter(
    (cue): cue is Extract<DialogueLineCue, { kind: 'media' }> => cue.kind === 'media',
  );
  const oldExpression = segment.cues.find(
    (cue): cue is Extract<DialogueLineCue, { kind: 'speaker-expression' }> =>
      cue.kind === 'speaker-expression',
  );
  let nextOrder = Math.max(-1, ...segment.cues.map((cue) => cue.position.order)) + 1;
  const defaultPosition = () => ({ offset: 0, order: nextOrder++ });
  if (presentation.speakerExpressionId) {
    retained.push({
      id: oldExpression?.id ?? 'speaker-expression',
      kind: 'speaker-expression',
      position: oldExpression?.position ?? defaultPosition(),
      expressionId: presentation.speakerExpressionId,
    });
  }
  presentation.stage.forEach((mutation, index) => {
    const previous = oldStage[index];
    retained.push({
      id: previous?.id ?? `stage-cue-${index + 1}`,
      kind: 'stage',
      position: previous?.position ?? defaultPosition(),
      mutation,
    });
  });
  presentation.media.forEach((mutation, index) => {
    const previous = oldMedia[index];
    retained.push({
      id: previous?.id ?? `media-cue-${index + 1}`,
      kind: 'media',
      position: previous?.position ?? defaultPosition(),
      mutation,
    });
  });
  return retained.sort(
    (left, right) =>
      left.position.offset - right.position.offset || left.position.order - right.position.order,
  );
}

interface DialogueEditorTabStatePayload {
  scroll?: ScrollViewState;
  graphViewport?: GraphViewportState;
  sourceViewStates?: SourceEditorViewStates;
  selectedBlockId?: string | null;
  selectedSegmentId?: string | null;
  graphPositions?: Record<string, { x: number; y: number }>;
  collapsedBlockIds?: string[];
  showConditions?: boolean;
  previewBackground?: DialoguePreviewBackground;
}

type DialogueEditorTabState = WorkbenchTabStatePayload & {
  schema: typeof DIALOGUE_EDITOR_TAB_STATE_SCHEMA;
  payload?: DialogueEditorTabStatePayload;
};

function parseGraphPositions(value: unknown): Record<string, { x: number; y: number }> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const result: Record<string, { x: number; y: number }> = {};
  for (const [id, position] of Object.entries(value)) {
    if (!position || typeof position !== 'object' || Array.isArray(position)) continue;
    const x = (position as { x?: unknown }).x;
    const y = (position as { y?: unknown }).y;
    if (typeof x === 'number' && Number.isFinite(x) && typeof y === 'number' && Number.isFinite(y))
      result[id] = { x, y };
  }
  return result;
}

function parseDialogueEditorTabState(
  value: WorkbenchTabStatePayload,
): DialogueEditorTabStatePayload | null {
  if (
    value.schema !== DIALOGUE_EDITOR_TAB_STATE_SCHEMA ||
    typeof value.payload !== 'object' ||
    value.payload === null ||
    Array.isArray(value.payload)
  )
    return null;
  const payload = value.payload as Record<string, unknown>;
  return {
    scroll: isScrollViewState(payload.scroll) ? payload.scroll : undefined,
    graphViewport: isGraphViewportState(payload.graphViewport) ? payload.graphViewport : undefined,
    sourceViewStates: parseSourceEditorViewStates(payload.sourceViewStates),
    selectedBlockId:
      typeof payload.selectedBlockId === 'string' || payload.selectedBlockId === null
        ? payload.selectedBlockId
        : undefined,
    selectedSegmentId:
      typeof payload.selectedSegmentId === 'string' || payload.selectedSegmentId === null
        ? payload.selectedSegmentId
        : undefined,
    graphPositions: parseGraphPositions(payload.graphPositions),
    collapsedBlockIds: Array.isArray(payload.collapsedBlockIds)
      ? payload.collapsedBlockIds.filter((id): id is string => typeof id === 'string')
      : undefined,
    showConditions:
      typeof payload.showConditions === 'boolean' ? payload.showConditions : undefined,
    previewBackground: dialoguePreviewBackgroundValues.includes(
      payload.previewBackground as DialoguePreviewBackground,
    )
      ? (payload.previewBackground as DialoguePreviewBackground)
      : undefined,
  };
}

function commitDialogue(dialogueId: string, next: DialogueData, label: string) {
  return useCommandStore.getState().executeCommand({
    type: 'dialogue.replaceData',
    label,
    payload: { dialogueId, data: next },
    originSaveUnitId: recordSaveUnitId('dialogues', dialogueId),
    persistencePolicy: 'manual-save',
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

function defaultPositions(
  blocks: readonly DialogueBlockData[],
): Record<string, { x: number; y: number }> {
  return Object.fromEntries(
    blocks.map((block, index) => [
      block.id,
      { x: (index % 3) * 240, y: Math.floor(index / 3) * 140 },
    ]),
  );
}

function refValue(ref: { $ref: { id: string } } | null | undefined) {
  return ref?.$ref.id ?? '__none__';
}

function textValue(text: TextContent): string {
  if (text.source.kind === 'inline') return text.source.text;
  if (text.source.kind === 'localized') return text.source.key;
  return text.source.source;
}

function replaceTextValue(text: TextContent, value: string): TextContent {
  if (text.source.kind === 'inline') return { ...text, source: { kind: 'inline', text: value } };
  if (text.source.kind === 'localized')
    return { ...text, source: { kind: 'localized', key: value } };
  return { ...text, source: { kind: 'lua-expression', source: value } };
}

function scalar(value: string): null | boolean | number | string {
  const trimmed = value.trim();
  if (trimmed === 'null') return null;
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed !== '' && Number.isFinite(Number(trimmed))) return Number(trimmed);
  return value;
}

function dialogueSceneInputValue(
  input: { type: 'boolean' | 'integer' | 'number' | 'string'; nullable: boolean },
  value: string,
): null | boolean | number | string | undefined {
  if (input.nullable && value === 'null') return null;
  if (input.type === 'string') return value;
  if (input.type === 'boolean') {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return undefined;
  }
  const number = Number(value);
  if (!Number.isFinite(number)) return undefined;
  if (input.type === 'integer' && !Number.isInteger(number)) return undefined;
  return number;
}

function StableIdInput({
  value,
  onCommit,
}: {
  value: string;
  onCommit: (nextId: string) => boolean;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);

  const commit = () => {
    if (draft === value) return;
    if (!onCommit(draft)) setDraft(value);
  };

  return (
    <Input
      value={draft}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
        if (event.key === 'Escape') {
          setDraft(value);
          event.currentTarget.blur();
        }
      }}
    />
  );
}

function targetValue(target: FlowTarget): string {
  return target.kind === 'return' || target.kind === 'end'
    ? target.kind
    : `${target.kind}:${target.id}`;
}

function ConditionEditor({
  condition,
  project,
  onChange,
}: {
  condition: DialogueConditionData | undefined;
  project: AuthoringEditorProject;
  onChange: (condition: DialogueConditionData | undefined) => void;
}) {
  return (
    <div className="space-y-2 rounded border p-2">
      <Label>Condition</Label>
      {condition ? (
        <>
          <RecursiveConditionEditor value={condition} project={project} onChange={onChange} />
          <Button type="button" size="sm" variant="ghost" onClick={() => onChange(undefined)}>
            Remove condition
          </Button>
        </>
      ) : (
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => onChange({ kind: 'always' })}
        >
          Add condition
        </Button>
      )}
    </div>
  );
}

function EffectsEditor({
  effects,
  variableOptions,
  onChange,
}: {
  effects: readonly DialogueEffectData[];
  variableOptions: Array<{ id: string; label: string }>;
  onChange: (effects: DialogueEffectData[]) => void;
}) {
  return (
    <div className="space-y-2 rounded border p-2">
      <div className="flex items-center justify-between gap-2">
        <Label>Effects</Label>
        <div className="flex gap-1">
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              onChange([
                ...effects,
                {
                  kind: 'set-variable',
                  variable: {
                    $ref: { collection: 'variables', id: variableOptions[0]?.id ?? 'variable' },
                  },
                  value: false,
                },
              ])
            }
          >
            Set variable
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => onChange([...effects, { kind: 'run-lua-effect', source: '-- Lua' }])}
          >
            Run Lua
          </Button>
        </div>
      </div>
      {effects.map((effect, index) => (
        <div key={`${effect.kind}:${index}`} className="space-y-2 rounded border p-2">
          {effect.kind === 'set-variable' ? (
            <>
              <Select
                value={effect.variable.$ref.id}
                onValueChange={(value) =>
                  onChange(
                    effects.map((item, itemIndex) =>
                      itemIndex === index && item.kind === 'set-variable'
                        ? {
                            ...item,
                            variable: { $ref: { collection: 'variables', id: String(value) } },
                          }
                        : item,
                    ),
                  )
                }
              >
                {variableOptions.length === 0 ? (
                  <SelectItem value="variable">Missing variable</SelectItem>
                ) : null}
                {variableOptions.map((variable) => (
                  <SelectItem key={variable.id} value={variable.id}>
                    {variable.label} ({variable.id})
                  </SelectItem>
                ))}
              </Select>
              <Input
                value={String(effect.value ?? '')}
                onChange={(event) =>
                  onChange(
                    effects.map((item, itemIndex) =>
                      itemIndex === index && item.kind === 'set-variable'
                        ? { ...item, value: scalar(event.currentTarget.value) }
                        : item,
                    ),
                  )
                }
              />
            </>
          ) : (
            <textarea
              className="min-h-24 w-full rounded border bg-background p-2 font-mono text-xs"
              value={effect.source}
              onChange={(event) =>
                onChange(
                  effects.map((item, itemIndex) =>
                    itemIndex === index && item.kind === 'run-lua-effect'
                      ? { ...item, source: event.currentTarget.value }
                      : item,
                  ),
                )
              }
            />
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={() => onChange(effects.filter((_, itemIndex) => itemIndex !== index))}
          >
            Delete effect
          </Button>
        </div>
      ))}
    </div>
  );
}

export function DialogueEditor({ tab }: WorkbenchEditorProps) {
  const projectDocument = useProjectStore((state) => state.document);
  const dialogueId = tab.resource?.entityId;
  const project = isAuthoringProject(projectDocument) ? projectDocument : null;
  const record = dialogueId && project ? project.dialogues[dialogueId] : null;
  const parsedData = parseDialogueData(record?.data);
  const data = parsedData ?? defaultDialogueData(record?.label ?? dialogueId ?? 'Dialogue');
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const graphViewportRef = useRef<GraphViewportState | null>(null);
  const [graphViewport, setGraphViewport] = useState<GraphViewportState | null>(null);
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(data.entryBlockId);
  const initialSequence = data.blocks.find(
    (block): block is DialogueSequenceBlockData =>
      block.id === data.entryBlockId && block.type === 'sequence',
  );
  const [selectedSegmentId, setSelectedSegmentId] = useState<string | null>(
    initialSequence?.segments[0]?.id ?? null,
  );
  const [graphPositions, setGraphPositions] = useState<Record<string, { x: number; y: number }>>(
    () => defaultPositions(data.blocks),
  );
  const [collapsedBlockIds, setCollapsedBlockIds] = useState<Set<string>>(new Set());
  const [showConditions, setShowConditions] = useState(true);
  const [previewBackground, setPreviewBackground] = useState<DialoguePreviewBackground>('dark');
  const sourceEditors = useSourceEditorViewStateRefs<'segmentText' | 'segmentLua'>();

  const diagnostics = useMemo(
    () =>
      project && record && dialogueId ? validateDialogueData(project, dialogueId, record) : [],
    [project, record, dialogueId],
  );
  const diagnosticItems = useMemo(
    () =>
      diagnostics.map((item) => ({
        ...item,
        target: project ? resolveProjectDiagnosticTarget(project, item.path) : null,
      })),
    [diagnostics, project],
  );

  useWorkbenchEditorTabState<DialogueEditorTabState>(
    tab.id,
    useMemo(
      () => ({
        schema: DIALOGUE_EDITOR_TAB_STATE_SCHEMA,
        captureTabState: () => ({
          schema: DIALOGUE_EDITOR_TAB_STATE_SCHEMA,
          payload: {
            scroll: captureScrollViewState(scrollRef.current),
            graphViewport: graphViewportRef.current ?? undefined,
            sourceViewStates: captureSourceEditorViewStates(sourceEditors.refs.current),
            selectedBlockId,
            selectedSegmentId,
            graphPositions,
            collapsedBlockIds: [...collapsedBlockIds],
            showConditions,
            previewBackground,
          },
        }),
        restoreTabState: (state: DialogueEditorTabState) => {
          const parsed = parseDialogueEditorTabState(state);
          if (!parsed) return;
          graphViewportRef.current = parsed.graphViewport ?? null;
          setGraphViewport(parsed.graphViewport ?? null);
          if (parsed.selectedBlockId !== undefined) setSelectedBlockId(parsed.selectedBlockId);
          if (parsed.selectedSegmentId !== undefined)
            setSelectedSegmentId(parsed.selectedSegmentId);
          if (parsed.graphPositions) setGraphPositions(parsed.graphPositions);
          if (parsed.collapsedBlockIds) setCollapsedBlockIds(new Set(parsed.collapsedBlockIds));
          if (parsed.showConditions !== undefined) setShowConditions(parsed.showConditions);
          if (parsed.previewBackground) setPreviewBackground(parsed.previewBackground);
          window.requestAnimationFrame(() => {
            restoreScrollViewState(scrollRef.current, parsed.scroll);
            restoreSourceEditorViewStates(sourceEditors.refs.current, parsed.sourceViewStates);
          });
        },
      }),
      [
        collapsedBlockIds,
        graphPositions,
        previewBackground,
        selectedBlockId,
        selectedSegmentId,
        showConditions,
        sourceEditors.refs,
      ],
    ),
  );

  useEffect(() => {
    const block =
      data.blocks.find((candidate) => candidate.id === selectedBlockId) ??
      data.blocks.find((candidate) => candidate.id === data.entryBlockId) ??
      data.blocks[0] ??
      null;
    if (block?.id !== selectedBlockId) setSelectedBlockId(block?.id ?? null);
    const segment =
      block?.type === 'sequence'
        ? (block.segments.find((candidate) => candidate.id === selectedSegmentId) ??
          block.segments[0] ??
          null)
        : null;
    if (segment?.id !== selectedSegmentId) setSelectedSegmentId(segment?.id ?? null);
    setGraphPositions((current) => {
      const defaults = defaultPositions(data.blocks);
      const next = Object.fromEntries(
        data.blocks.map((candidate) => [
          candidate.id,
          current[candidate.id] ?? defaults[candidate.id]!,
        ]),
      );
      return JSON.stringify(next) === JSON.stringify(current) ? current : next;
    });
  }, [data, selectedBlockId, selectedSegmentId]);

  useEffect(
    () =>
      registerWorkbenchTargetHandler(tab.id, 'dialogue.block', (target) => {
        const id = target.id.slice('dialogue.block.'.length);
        const block = data.blocks.find((candidate) => candidate.id === id);
        if (!block) return false;
        setSelectedBlockId(id);
        setSelectedSegmentId(block.type === 'sequence' ? (block.segments[0]?.id ?? null) : null);
        return false;
      }),
    [data.blocks, tab.id],
  );

  useEffect(
    () =>
      registerWorkbenchTargetHandler(tab.id, 'dialogue.segment', (target) => {
        const id = target.id.slice('dialogue.segment.'.length);
        const block = data.blocks.find(
          (candidate) =>
            candidate.type === 'sequence' &&
            candidate.segments.some((segment) => segment.id === id),
        );
        if (!block) return false;
        setSelectedBlockId(block.id);
        setSelectedSegmentId(id);
        return false;
      }),
    [data.blocks, tab.id],
  );

  useEffect(
    () =>
      registerWorkbenchTargetHandler(tab.id, 'dialogue.edge', (target) => {
        const id = target.id.slice('dialogue.edge.'.length);
        const edge = data.edges.find((candidate) => candidate.id === id);
        if (!edge) return false;
        setSelectedBlockId(edge.fromBlockId);
        setSelectedSegmentId(null);
        return false;
      }),
    [data.edges, tab.id],
  );

  if (!dialogueId || !record || !project)
    return <div className="p-4 text-sm text-muted-foreground">Dialogue record not found.</div>;
  const activeDialogueId = dialogueId;

  const activeBlock =
    data.blocks.find((block) => block.id === selectedBlockId) ??
    data.blocks.find((block) => block.id === data.entryBlockId) ??
    data.blocks[0] ??
    null;
  const selectedSegment =
    activeBlock?.type === 'sequence'
      ? (activeBlock.segments.find((segment) => segment.id === selectedSegmentId) ??
        activeBlock.segments[0] ??
        null)
      : null;
  const activeSegment: DialogueEditorSegment | null =
    selectedSegment?.type === 'line'
      ? { ...selectedSegment, presentation: presentationEditorView(selectedSegment) }
      : selectedSegment;
  const characters = Object.entries(project.characters).map(([id, character]) => ({
    id,
    label: character.label,
  }));
  const imageAssets = Object.entries(project.assets)
    .filter(([, asset]) =>
      Boolean(
        asset.data &&
        typeof asset.data === 'object' &&
        'kind' in asset.data &&
        asset.data.kind === 'image',
      ),
    )
    .map(([id, asset]) => ({ id, label: asset.label }));
  const audioAssets = Object.entries(project.assets)
    .filter(([, asset]) =>
      Boolean(
        asset.data &&
        typeof asset.data === 'object' &&
        'kind' in asset.data &&
        asset.data.kind === 'audio',
      ),
    )
    .map(([id, asset]) => ({ id, label: asset.label }));
  const variables = Object.entries(project.variables).map(([id, variable]) => ({
    id,
    label: variable.label,
  }));
  const runtimeBlocks = data.blocks.filter((block) => block.type !== 'comment');
  const outgoingEdges = activeBlock
    ? data.edges.filter((edge) => edge.fromBlockId === activeBlock.id)
    : [];
  const previewDocument = {
    kind: 'dialogue-preview' as const,
    recordId: dialogueId,
    revision: dialoguePreviewRevision(project, dialogueId),
    data: buildDialoguePreviewDocumentData(project, dialogueId, {
      selectedBlockId: activeBlock?.id,
      selectedSegmentId: activeSegment?.id,
      showConditions,
      background: previewBackground,
    }),
  };

  function commit(next: DialogueData, label = 'Update dialogue') {
    commitDialogue(activeDialogueId, next, label);
  }

  function selectBlock(id: string) {
    const block = data.blocks.find((candidate) => candidate.id === id);
    setSelectedBlockId(id);
    setSelectedSegmentId(block?.type === 'sequence' ? (block.segments[0]?.id ?? null) : null);
  }

  function addBlock(type: DialogueBlockData['type']) {
    const id = nextUniqueId(
      data.blocks.map((block) => block.id),
      type,
    );
    let block = defaultDialogueBlock(type, id);
    if (block.type === 'redirect')
      block = { ...block, targetBlockId: runtimeBlocks[0]?.id ?? data.entryBlockId };
    const edges =
      block.type === 'choice'
        ? [
            ...data.edges,
            {
              id: nextUniqueId(
                data.edges.map((edge) => edge.id),
                'choice',
              ),
              kind: 'choice' as const,
              fromBlockId: id,
              toBlockId: runtimeBlocks[0]?.id ?? data.entryBlockId,
              label: inlineTextContent('Choice'),
              effects: [],
              logged: true,
              autosaveSafePoint: false,
            },
          ]
        : data.edges;
    commit({ ...data, blocks: [...data.blocks, block], edges }, 'Add dialogue block');
    setSelectedBlockId(id);
    setSelectedSegmentId(block.type === 'sequence' ? (block.segments[0]?.id ?? null) : null);
    setGraphPositions((positions) => ({
      ...positions,
      [id]: { x: 240 + data.blocks.length * 28, y: 80 + data.blocks.length * 24 },
    }));
  }

  function renameBlock(oldId: string, newId: string) {
    if (newId === oldId) return true;
    if (!isValidEntityId(newId) || data.blocks.some((block) => block.id === newId)) return false;
    const blocks = data.blocks.map((block): DialogueBlockData => {
      const renamed = block.id === oldId ? { ...block, id: newId } : block;
      return renamed.type === 'redirect' && renamed.targetBlockId === oldId
        ? { ...renamed, targetBlockId: newId }
        : renamed;
    });
    const edges = data.edges.map((edge) => ({
      ...edge,
      fromBlockId: edge.fromBlockId === oldId ? newId : edge.fromBlockId,
      toBlockId: edge.toBlockId === oldId ? newId : edge.toBlockId,
    }));
    commit(
      {
        ...data,
        entryBlockId: data.entryBlockId === oldId ? newId : data.entryBlockId,
        blocks,
        edges,
      },
      'Rename dialogue block',
    );
    setSelectedBlockId(newId);
    setGraphPositions((positions) => {
      const next = { ...positions, [newId]: positions[oldId] ?? { x: 0, y: 0 } };
      delete next[oldId];
      return next;
    });
    return true;
  }

  function changeBlockType(block: DialogueBlockData, type: DialogueBlockData['type']) {
    if (block.type === type) return;
    const fallbackBlock = runtimeBlocks.find((candidate) => candidate.id !== block.id) ?? null;
    if ((type === 'redirect' || type === 'comment') && !fallbackBlock) return;
    let replacement = defaultDialogueBlock(type, block.id, block.label);
    if (replacement.type === 'redirect')
      replacement = { ...replacement, targetBlockId: fallbackBlock!.id };
    const retainedEdges = data.edges
      .filter((edge) => edge.fromBlockId !== block.id)
      .map((edge) =>
        replacement.type === 'comment' && edge.toBlockId === block.id
          ? { ...edge, toBlockId: fallbackBlock!.id }
          : edge,
      );
    const edges =
      replacement.type === 'choice'
        ? [
            ...retainedEdges,
            {
              id: nextUniqueId(
                retainedEdges.map((edge) => edge.id),
                'choice',
              ),
              kind: 'choice' as const,
              fromBlockId: block.id,
              toBlockId: fallbackBlock?.id ?? block.id,
              label: inlineTextContent('Choice'),
              effects: [],
              logged: true,
              autosaveSafePoint: false,
            },
          ]
        : retainedEdges;
    commit(
      {
        ...data,
        entryBlockId:
          replacement.type === 'comment' && data.entryBlockId === block.id
            ? fallbackBlock!.id
            : data.entryBlockId,
        blocks: data.blocks.map((candidate): DialogueBlockData => {
          if (candidate.id === block.id) return replacement;
          if (
            replacement.type === 'comment' &&
            candidate.type === 'redirect' &&
            candidate.targetBlockId === block.id
          ) {
            return { ...candidate, targetBlockId: fallbackBlock!.id };
          }
          return candidate;
        }),
        edges,
      },
      'Change dialogue block type',
    );
    setSelectedSegmentId(
      replacement.type === 'sequence' ? (replacement.segments[0]?.id ?? null) : null,
    );
  }

  function replaceBlock(block: DialogueBlockData) {
    commit(
      {
        ...data,
        blocks: data.blocks.map((candidate) => (candidate.id === block.id ? block : candidate)),
      },
      'Update dialogue block',
    );
  }

  function deleteBlock(id: string) {
    if (data.blocks.length <= 1) return;
    const deleted = data.blocks.find((block) => block.id === id);
    if (deleted?.type !== 'comment' && runtimeBlocks.length <= 1) return;
    const remaining = data.blocks.filter((block) => block.id !== id);
    const fallback = remaining.find((block) => block.type !== 'comment') ?? remaining[0]!;
    const blocks = remaining.map(
      (block): DialogueBlockData =>
        block.type === 'redirect' && block.targetBlockId === id
          ? { ...block, targetBlockId: fallback.id }
          : block,
    );
    commit(
      {
        ...data,
        entryBlockId: data.entryBlockId === id ? fallback.id : data.entryBlockId,
        blocks,
        edges: data.edges
          .filter((edge) => edge.fromBlockId !== id)
          .map((edge) => (edge.toBlockId === id ? { ...edge, toBlockId: fallback.id } : edge)),
      },
      'Delete dialogue block',
    );
    selectBlock(fallback.id);
  }

  function addSegment(block: DialogueSequenceBlockData, type: DialogueSegmentData['type']) {
    const ids = data.blocks.flatMap((candidate) =>
      candidate.type === 'sequence' ? candidate.segments.map((segment) => segment.id) : [],
    );
    const id = nextUniqueId(ids, type === 'line' ? 'line' : type);
    let segment = defaultDialogueSegment(type, id);
    if (segment.type === 'call-scene') {
      const firstSceneId = Object.keys(project?.scenes ?? {})[0];
      if (firstSceneId)
        segment = { ...segment, scene: { $ref: { collection: 'scenes', id: firstSceneId } } };
    }
    replaceBlock({ ...block, segments: [...block.segments, segment] });
    setSelectedSegmentId(id);
  }

  function replaceSegment(
    block: DialogueSequenceBlockData,
    segment: DialogueSegmentData | DialogueLineEditorSegment,
  ) {
    let canonical: DialogueSegmentData = segment;
    if (segment.type === 'line' && 'presentation' in segment) {
      const { presentation, ...line } = segment;
      canonical = {
        ...line,
        cues: cuesFromPresentationEditorView(line, presentation),
      };
    }
    replaceBlock({
      ...block,
      segments: block.segments.map((candidate) =>
        candidate.id === canonical.id ? canonical : candidate,
      ),
    });
  }

  function replaceLineCues(
    block: DialogueSequenceBlockData,
    segment: DialogueLineEditorSegment,
    cues: DialogueLineCue[],
  ) {
    const { presentation: _, ...line } = segment;
    replaceSegment(block, { ...line, cues });
  }

  function replaceLineCueAt(
    block: DialogueSequenceBlockData,
    segment: DialogueLineEditorSegment,
    cueIndex: number,
    cue: DialogueLineCue,
  ) {
    replaceLineCues(
      block,
      segment,
      segment.cues.map((candidate, index) => (index === cueIndex ? cue : candidate)),
    );
  }

  function renameSegment(block: DialogueSequenceBlockData, oldId: string, newId: string) {
    const ids = data.blocks.flatMap((candidate) =>
      candidate.type === 'sequence' ? candidate.segments.map((segment) => segment.id) : [],
    );
    if (newId === oldId) return true;
    if (!isValidEntityId(newId) || ids.includes(newId)) return false;
    replaceBlock({
      ...block,
      segments: block.segments.map((segment) =>
        segment.id === oldId ? { ...segment, id: newId } : segment,
      ),
    });
    setSelectedSegmentId(newId);
    return true;
  }

  function changeSegmentType(
    block: DialogueSequenceBlockData,
    segment: DialogueSegmentData,
    type: DialogueSegmentData['type'],
  ) {
    if (segment.type === type) return;
    let replacement = defaultDialogueSegment(type, segment.id);
    if (replacement.type === 'call-scene') {
      const firstSceneId = Object.keys(project?.scenes ?? {})[0];
      if (firstSceneId)
        replacement = {
          ...replacement,
          scene: { $ref: { collection: 'scenes', id: firstSceneId } },
        };
    }
    replaceSegment(block, replacement);
  }

  function moveSegment(block: DialogueSequenceBlockData, id: string, direction: -1 | 1) {
    const index = block.segments.findIndex((segment) => segment.id === id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= block.segments.length) return;
    const segments = [...block.segments];
    const [segment] = segments.splice(index, 1);
    segments.splice(target, 0, segment!);
    replaceBlock({ ...block, segments });
  }

  function addEdge(fromBlockId: string, toBlockId: string) {
    const source = data.blocks.find((block) => block.id === fromBlockId);
    if (!source || source.type === 'comment') return;
    if (source.type === 'redirect') {
      replaceBlock({ ...source, targetBlockId: toBlockId });
      return;
    }
    if (source.type === 'sequence') {
      const edge: DialogueEdgeData = {
        id: nextUniqueId(
          data.edges.map((candidate) => candidate.id),
          'next',
        ),
        kind: 'next',
        fromBlockId,
        toBlockId,
      };
      commit(
        {
          ...data,
          edges: [...data.edges.filter((candidate) => candidate.fromBlockId !== fromBlockId), edge],
        },
        'Set dialogue next edge',
      );
      return;
    }
    const edge: DialogueChoiceEdgeData = {
      id: nextUniqueId(
        data.edges.map((candidate) => candidate.id),
        'choice',
      ),
      kind: 'choice',
      fromBlockId,
      toBlockId,
      label: inlineTextContent('Choice'),
      effects: [],
      logged: true,
      autosaveSafePoint: false,
    };
    commit({ ...data, edges: [...data.edges, edge] }, 'Add dialogue choice');
  }

  function replaceEdge(edge: DialogueEdgeData) {
    commit(
      {
        ...data,
        edges: data.edges.map((candidate) => (candidate.id === edge.id ? edge : candidate)),
      },
      'Update dialogue edge',
    );
  }

  function renameEdge(oldId: string, newId: string) {
    if (newId === oldId) return true;
    if (!isValidEntityId(newId) || data.edges.some((edge) => edge.id === newId)) return false;
    commit(
      {
        ...data,
        edges: data.edges.map((edge) => (edge.id === oldId ? { ...edge, id: newId } : edge)),
      },
      'Rename dialogue edge',
    );
    return true;
  }

  function moveEdge(id: string, direction: -1 | 1) {
    const indexes = data.edges
      .map((edge, index) => ({ edge, index }))
      .filter(({ edge }) => edge.fromBlockId === activeBlock?.id);
    const localIndex = indexes.findIndex(({ edge }) => edge.id === id);
    const target = localIndex + direction;
    if (localIndex < 0 || target < 0 || target >= indexes.length) return;
    const edges = [...data.edges];
    const first = indexes[localIndex]!.index;
    const second = indexes[target]!.index;
    [edges[first], edges[second]] = [edges[second]!, edges[first]!];
    commit({ ...data, edges }, 'Reorder dialogue choice');
  }

  function updateCompletion(value: string) {
    const [kind, id] = value.split(':');
    const completion: FlowTarget =
      kind === 'return' || kind === 'end'
        ? { kind }
        : { kind: kind as 'scene' | 'dialogue' | 'room', id: id! };
    commit({ ...data, completion }, 'Update dialogue completion');
  }

  function defaultStageState(characterId?: string): DialogueStageSlotState | null {
    const id = characterId ?? characters[0]?.id;
    if (!id) return null;
    const character = parseCharacterData(project?.characters[id]?.data);
    if (!character) return null;
    const profile = character.profiles.find(
      (candidate) => candidate.id === character.defaults.profileId,
    );
    if (!profile) return null;
    return {
      character: dialogueCharacterRef(id),
      profileId: profile.id,
      poseId: profile.defaultPoseId,
      expressionId: character.defaults.expressionId,
      appearanceId: character.defaults.appearanceId,
      position: 'center',
      offset: { x: 0, y: 0 },
      scale: 1,
      visible: true,
    };
  }

  function defaultCharacterMedia(characterId?: string): DialogueMediaContent | null {
    const state = defaultStageState(characterId);
    return state
      ? {
          kind: 'character',
          character: state.character,
          profileId: state.profileId,
          poseId: state.poseId,
          expressionId: state.expressionId,
          appearanceId: state.appearanceId,
        }
      : null;
  }

  function addStageSlot() {
    const id = nextUniqueId(
      data.stageSlots.map((slot) => slot.id),
      'stage',
    );
    const slot: DialogueStageSlotData = {
      id,
      label: `Stage ${data.stageSlots.length + 1}`,
      speakerSync: true,
      initial: null,
    };
    commit({ ...data, stageSlots: [...data.stageSlots, slot] }, 'Add dialogue Stage Slot');
  }

  function addMediaSlot() {
    const id = nextUniqueId(
      data.mediaSlots.map((slot) => slot.id),
      'media',
    );
    const slot: DialogueMediaSlotData = {
      id,
      label: `Media ${data.mediaSlots.length + 1}`,
      initial: null,
      visible: true,
    };
    commit({ ...data, mediaSlots: [...data.mediaSlots, slot] }, 'Add dialogue Media Slot');
  }

  function removeStageSlot(slotId: string) {
    const blocks = data.blocks.map(
      (block): DialogueBlockData =>
        block.type !== 'sequence'
          ? block
          : {
              ...block,
              segments: block.segments.map((segment) =>
                segment.type !== 'line'
                  ? segment
                  : {
                      ...segment,
                      cues: segment.cues.filter(
                        (cue) =>
                          !(
                            (cue.kind === 'stage' || cue.kind === 'gesture') &&
                            (cue.kind === 'stage' ? cue.mutation.slotId : cue.slotId) === slotId
                          ),
                      ),
                    },
              ),
            },
    );
    commit(
      { ...data, stageSlots: data.stageSlots.filter((slot) => slot.id !== slotId), blocks },
      'Remove dialogue Stage Slot',
    );
  }

  function removeMediaSlot(slotId: string) {
    const blocks = data.blocks.map(
      (block): DialogueBlockData =>
        block.type !== 'sequence'
          ? block
          : {
              ...block,
              segments: block.segments.map((segment) =>
                segment.type !== 'line'
                  ? segment
                  : {
                      ...segment,
                      cues: segment.cues.filter(
                        (cue) => !(cue.kind === 'media' && cue.mutation.slotId === slotId),
                      ),
                    },
              ),
            },
    );
    commit(
      { ...data, mediaSlots: data.mediaSlots.filter((slot) => slot.id !== slotId), blocks },
      'Remove dialogue Media Slot',
    );
  }

  return (
    <div
      ref={scrollRef}
      className="flex h-full min-h-0 flex-col overflow-auto bg-background p-4"
      data-dialogue-editor-scroll
    >
      <div className="flex items-center gap-2">
        <h2 className="text-lg font-semibold">{record.label}</h2>
        <Badge variant="outline">{dialogueId}</Badge>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Strict Sequence, Choice, Redirect, and Comment graph with typed transcript and completion
        behavior.
      </p>
      {!parsedData ? (
        <div className="mt-3 rounded border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
          Dialogue data is invalid; editable current defaults are shown.
        </div>
      ) : null}

      <div className="mt-4 grid gap-4 xl:grid-cols-[1fr_380px]">
        <div className="space-y-4">
          <section
            className="grid gap-3 rounded border p-3 md:grid-cols-2 xl:grid-cols-3"
            data-workbench-anchor="dialogue.summary"
          >
            <Label>
              Display name
              <Input
                value={data.displayName}
                onChange={(event) =>
                  commit(
                    { ...data, displayName: event.currentTarget.value },
                    'Update dialogue display name',
                  )
                }
              />
            </Label>
            <Label>
              Default speaker
              <Select
                value={refValue(data.defaultSpeaker)}
                onValueChange={(value) =>
                  commit(
                    {
                      ...data,
                      defaultSpeaker:
                        value === '__none__' ? null : dialogueCharacterRef(String(value)),
                    },
                    'Update dialogue speaker',
                  )
                }
              >
                <SelectItem value="__none__">No default speaker</SelectItem>
                {characters.map((character) => (
                  <SelectItem key={character.id} value={character.id}>
                    {character.label} ({character.id})
                  </SelectItem>
                ))}
              </Select>
            </Label>
            <Label>
              Entry block
              <Select
                value={data.entryBlockId}
                onValueChange={(value) =>
                  commit({ ...data, entryBlockId: String(value) }, 'Update dialogue entry block')
                }
              >
                {runtimeBlocks.map((block) => (
                  <SelectItem key={block.id} value={block.id}>
                    {block.label} ({block.id})
                  </SelectItem>
                ))}
              </Select>
            </Label>
            <Label>
              Log mode
              <Select
                value={data.settings.logMode}
                onValueChange={(value) =>
                  commit(
                    {
                      ...data,
                      settings: {
                        ...data.settings,
                        logMode: value as DialogueData['settings']['logMode'],
                      },
                    },
                    'Update dialogue settings',
                  )
                }
              >
                {dialogueLogModeValues.map((mode) => (
                  <SelectItem key={mode} value={mode}>
                    {mode}
                  </SelectItem>
                ))}
              </Select>
            </Label>
            <label className="flex items-center gap-2 pt-6">
              <Switch
                checked={data.settings.showDisabledChoices}
                onCheckedChange={(checked) =>
                  commit(
                    {
                      ...data,
                      settings: { ...data.settings, showDisabledChoices: Boolean(checked) },
                    },
                    'Update dialogue settings',
                  )
                }
              />{' '}
              Show disabled choices
            </label>
            <Label>
              Completion
              <Select
                value={targetValue(data.completion)}
                onValueChange={(value) => updateCompletion(String(value))}
              >
                <SelectItem value="end">End</SelectItem>
                <SelectItem value="return">Return</SelectItem>
                {Object.entries(project.scenes).map(([id, item]) => (
                  <SelectItem key={`scene:${id}`} value={`scene:${id}`}>
                    Scene: {item.label}
                  </SelectItem>
                ))}
                {Object.entries(project.dialogues).map(([id, item]) => (
                  <SelectItem key={`dialogue:${id}`} value={`dialogue:${id}`}>
                    Dialogue: {item.label}
                  </SelectItem>
                ))}
                {Object.entries(project.rooms).map(([id, item]) => (
                  <SelectItem key={`room:${id}`} value={`room:${id}`}>
                    Room: {item.label}
                  </SelectItem>
                ))}
              </Select>
            </Label>
          </section>

          <section
            className="space-y-3 rounded border p-3"
            data-workbench-anchor="dialogue.presentation"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-medium">Dialogue presentation</h3>
                <p className="text-xs text-muted-foreground">
                  Stage Slots are stable Character occurrences. Media Slots are positioned by the
                  Dialogue Layout.
                </p>
              </div>
              <div className="flex gap-1">
                <Button size="sm" variant="outline" onClick={addStageSlot}>
                  Add Stage Slot
                </Button>
                <Button size="sm" variant="outline" onClick={addMediaSlot}>
                  Add Media Slot
                </Button>
              </div>
            </div>

            {data.stageSlots.length > 0 ? (
              <div className="space-y-2">
                <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Stage Slots
                </h4>
                {data.stageSlots.map((slot, slotIndex) => (
                  <div key={slot.id} className="space-y-2 rounded border p-2">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline">{slot.id}</Badge>
                      <Input
                        value={slot.label}
                        aria-label={`Stage Slot ${slot.id} label`}
                        onChange={(event) => {
                          const stageSlots = data.stageSlots.map((candidate, index) =>
                            index === slotIndex
                              ? { ...candidate, label: event.currentTarget.value }
                              : candidate,
                          );
                          commit({ ...data, stageSlots }, 'Update dialogue Stage Slot');
                        }}
                      />
                      <Button size="sm" variant="outline" onClick={() => removeStageSlot(slot.id)}>
                        Remove
                      </Button>
                    </div>
                    <div className="flex flex-wrap gap-4 text-xs">
                      <label className="flex items-center gap-2">
                        <Switch
                          checked={slot.speakerSync}
                          onCheckedChange={(checked) => {
                            const stageSlots = data.stageSlots.map((candidate, index) =>
                              index === slotIndex
                                ? { ...candidate, speakerSync: Boolean(checked) }
                                : candidate,
                            );
                            commit({ ...data, stageSlots }, 'Update Stage Slot speaker sync');
                          }}
                        />
                        Speaker sync
                      </label>
                      <label className="flex items-center gap-2">
                        <Switch
                          checked={slot.initial !== null}
                          disabled={characters.length === 0}
                          onCheckedChange={(checked) => {
                            const stageSlots = data.stageSlots.map((candidate, index) =>
                              index === slotIndex
                                ? {
                                    ...candidate,
                                    initial: checked ? defaultStageState() : null,
                                  }
                                : candidate,
                            );
                            commit({ ...data, stageSlots }, 'Update Stage Slot initial state');
                          }}
                        />
                        Initial occurrence
                      </label>
                    </div>
                    {slot.initial ? (
                      <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
                        <Label>
                          Character
                          <Select
                            value={slot.initial.character.$ref.id}
                            onValueChange={(value) => {
                              const replacement = defaultStageState(String(value));
                              if (!replacement) return;
                              const stageSlots = data.stageSlots.map((candidate, index) =>
                                index === slotIndex
                                  ? { ...candidate, initial: replacement }
                                  : candidate,
                              );
                              commit({ ...data, stageSlots }, 'Update Stage Slot Character');
                            }}
                          >
                            {characters.map((character) => (
                              <SelectItem key={character.id} value={character.id}>
                                {character.label} ({character.id})
                              </SelectItem>
                            ))}
                          </Select>
                        </Label>
                        <Label>
                          Profile
                          <Input
                            value={slot.initial.profileId}
                            onChange={(event) => {
                              const initial = {
                                ...slot.initial!,
                                profileId: event.currentTarget.value,
                              };
                              const stageSlots = data.stageSlots.map((candidate, index) =>
                                index === slotIndex ? { ...candidate, initial } : candidate,
                              );
                              commit({ ...data, stageSlots }, 'Update Stage Slot profile');
                            }}
                          />
                        </Label>
                        <Label>
                          Pose
                          <Input
                            value={slot.initial.poseId}
                            onChange={(event) => {
                              const initial = {
                                ...slot.initial!,
                                poseId: event.currentTarget.value,
                              };
                              const stageSlots = data.stageSlots.map((candidate, index) =>
                                index === slotIndex ? { ...candidate, initial } : candidate,
                              );
                              commit({ ...data, stageSlots }, 'Update Stage Slot pose');
                            }}
                          />
                        </Label>
                        <Label>
                          Expression
                          <Input
                            value={slot.initial.expressionId}
                            onChange={(event) => {
                              const initial = {
                                ...slot.initial!,
                                expressionId: event.currentTarget.value,
                              };
                              const stageSlots = data.stageSlots.map((candidate, index) =>
                                index === slotIndex ? { ...candidate, initial } : candidate,
                              );
                              commit({ ...data, stageSlots }, 'Update Stage Slot expression');
                            }}
                          />
                        </Label>
                        <Label>
                          Appearance
                          <Input
                            value={slot.initial.appearanceId ?? ''}
                            placeholder="none"
                            onChange={(event) => {
                              const value = event.currentTarget.value.trim();
                              const initial = {
                                ...slot.initial!,
                                appearanceId: value || null,
                              };
                              const stageSlots = data.stageSlots.map((candidate, index) =>
                                index === slotIndex ? { ...candidate, initial } : candidate,
                              );
                              commit({ ...data, stageSlots }, 'Update Stage Slot appearance');
                            }}
                          />
                        </Label>
                        <Label>
                          Position
                          <Select
                            value={slot.initial.position}
                            onValueChange={(value) => {
                              const initial = {
                                ...slot.initial!,
                                position: value as DialogueStageSlotState['position'],
                              };
                              const stageSlots = data.stageSlots.map((candidate, index) =>
                                index === slotIndex ? { ...candidate, initial } : candidate,
                              );
                              commit({ ...data, stageSlots }, 'Update Stage Slot position');
                            }}
                          >
                            <SelectItem value="left">left</SelectItem>
                            <SelectItem value="center">center</SelectItem>
                            <SelectItem value="right">right</SelectItem>
                          </Select>
                        </Label>
                        <Label>
                          Scale
                          <Input
                            type="number"
                            min="0.01"
                            step="0.05"
                            value={slot.initial.scale}
                            onChange={(event) => {
                              const scale = Number(event.currentTarget.value);
                              if (!Number.isFinite(scale) || scale <= 0) return;
                              const initial = { ...slot.initial!, scale };
                              const stageSlots = data.stageSlots.map((candidate, index) =>
                                index === slotIndex ? { ...candidate, initial } : candidate,
                              );
                              commit({ ...data, stageSlots }, 'Update Stage Slot scale');
                            }}
                          />
                        </Label>
                        <label className="flex items-center gap-2 pt-6">
                          <Switch
                            checked={slot.initial.visible}
                            onCheckedChange={(checked) => {
                              const initial = { ...slot.initial!, visible: Boolean(checked) };
                              const stageSlots = data.stageSlots.map((candidate, index) =>
                                index === slotIndex ? { ...candidate, initial } : candidate,
                              );
                              commit({ ...data, stageSlots }, 'Update Stage Slot visibility');
                            }}
                          />
                          Visible
                        </label>
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : null}

            {data.mediaSlots.length > 0 ? (
              <div className="space-y-2">
                <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Media Slots
                </h4>
                {data.mediaSlots.map((slot, slotIndex) => (
                  <div key={slot.id} className="space-y-2 rounded border p-2">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline">{slot.id}</Badge>
                      <Input
                        value={slot.label}
                        aria-label={`Media Slot ${slot.id} label`}
                        onChange={(event) => {
                          const mediaSlots = data.mediaSlots.map((candidate, index) =>
                            index === slotIndex
                              ? { ...candidate, label: event.currentTarget.value }
                              : candidate,
                          );
                          commit({ ...data, mediaSlots }, 'Update dialogue Media Slot');
                        }}
                      />
                      <Button size="sm" variant="outline" onClick={() => removeMediaSlot(slot.id)}>
                        Remove
                      </Button>
                    </div>
                    <div className="grid gap-2 md:grid-cols-3">
                      <Label>
                        Initial content
                        <Select
                          value={slot.initial?.kind ?? '__none__'}
                          onValueChange={(value) => {
                            let initial: DialogueMediaContent | null = null;
                            if (value === 'character') initial = defaultCharacterMedia();
                            if (value === 'image' && imageAssets[0])
                              initial = {
                                kind: 'image',
                                asset: { $ref: { collection: 'assets', id: imageAssets[0].id } },
                              };
                            const mediaSlots = data.mediaSlots.map((candidate, index) =>
                              index === slotIndex ? { ...candidate, initial } : candidate,
                            );
                            commit({ ...data, mediaSlots }, 'Update Media Slot content');
                          }}
                        >
                          <SelectItem value="__none__">None</SelectItem>
                          <SelectItem value="character" disabled={characters.length === 0}>
                            Character
                          </SelectItem>
                          <SelectItem value="image" disabled={imageAssets.length === 0}>
                            Image
                          </SelectItem>
                        </Select>
                      </Label>
                      {slot.initial?.kind === 'image' ? (
                        <Label>
                          Image
                          <Select
                            value={slot.initial.asset.$ref.id}
                            onValueChange={(value) => {
                              const initial: DialogueMediaContent = {
                                kind: 'image',
                                asset: { $ref: { collection: 'assets', id: String(value) } },
                              };
                              const mediaSlots = data.mediaSlots.map((candidate, index) =>
                                index === slotIndex ? { ...candidate, initial } : candidate,
                              );
                              commit({ ...data, mediaSlots }, 'Update Media Slot image');
                            }}
                          >
                            {imageAssets.map((asset) => (
                              <SelectItem key={asset.id} value={asset.id}>
                                {asset.label} ({asset.id})
                              </SelectItem>
                            ))}
                          </Select>
                        </Label>
                      ) : null}
                      {slot.initial?.kind === 'character' ? (
                        <Label>
                          Character
                          <Select
                            value={slot.initial.character.$ref.id}
                            onValueChange={(value) => {
                              const initial = defaultCharacterMedia(String(value));
                              if (!initial) return;
                              const mediaSlots = data.mediaSlots.map((candidate, index) =>
                                index === slotIndex ? { ...candidate, initial } : candidate,
                              );
                              commit({ ...data, mediaSlots }, 'Update Media Slot Character');
                            }}
                          >
                            {characters.map((character) => (
                              <SelectItem key={character.id} value={character.id}>
                                {character.label} ({character.id})
                              </SelectItem>
                            ))}
                          </Select>
                        </Label>
                      ) : null}
                      <label className="flex items-center gap-2 pt-6">
                        <Switch
                          checked={slot.visible}
                          onCheckedChange={(checked) => {
                            const mediaSlots = data.mediaSlots.map((candidate, index) =>
                              index === slotIndex
                                ? { ...candidate, visible: Boolean(checked) }
                                : candidate,
                            );
                            commit({ ...data, mediaSlots }, 'Update Media Slot visibility');
                          }}
                        />
                        Visible
                      </label>
                    </div>
                    {slot.initial?.kind === 'character' ? (
                      <div className="grid gap-2 md:grid-cols-4">
                        {(['profileId', 'poseId', 'expressionId'] as const).map((field) => (
                          <Label key={field}>
                            {field === 'profileId'
                              ? 'Profile'
                              : field === 'poseId'
                                ? 'Pose'
                                : 'Expression'}
                            <Input
                              value={slot.initial?.kind === 'character' ? slot.initial[field] : ''}
                              onChange={(event) => {
                                if (slot.initial?.kind !== 'character') return;
                                const initial: DialogueMediaContent = {
                                  ...slot.initial,
                                  [field]: event.currentTarget.value,
                                };
                                const mediaSlots = data.mediaSlots.map((candidate, index) =>
                                  index === slotIndex ? { ...candidate, initial } : candidate,
                                );
                                commit({ ...data, mediaSlots }, 'Update Media Slot Character');
                              }}
                            />
                          </Label>
                        ))}
                        <Label>
                          Appearance
                          <Input
                            value={slot.initial.appearanceId ?? ''}
                            placeholder="none"
                            onChange={(event) => {
                              if (slot.initial?.kind !== 'character') return;
                              const value = event.currentTarget.value.trim();
                              const initial: DialogueMediaContent = {
                                ...slot.initial,
                                appearanceId: value || null,
                              };
                              const mediaSlots = data.mediaSlots.map((candidate, index) =>
                                index === slotIndex ? { ...candidate, initial } : candidate,
                              );
                              commit({ ...data, mediaSlots }, 'Update Media Slot Character');
                            }}
                          />
                        </Label>
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : null}
          </section>

          <section className="space-y-3 rounded border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-medium">Branch map</h3>
              <div className="flex flex-wrap gap-1">
                {dialogueBlockTypeValues.map((type) => (
                  <Button key={type} size="sm" variant="outline" onClick={() => addBlock(type)}>
                    Add {type}
                  </Button>
                ))}
              </div>
            </div>
            <DialogueGraph
              blocks={data.blocks}
              edges={data.edges}
              positions={graphPositions}
              selectedBlockId={activeBlock?.id ?? null}
              onSelectBlock={selectBlock}
              onMoveBlock={(id, position) =>
                setGraphPositions((positions) => ({ ...positions, [id]: position }))
              }
              onConnectBlocks={addEdge}
              viewport={graphViewport}
              onViewportChange={(viewport) => {
                graphViewportRef.current = viewport;
                setGraphViewport(viewport);
              }}
            />
          </section>

          {activeBlock?.type === 'sequence' && !collapsedBlockIds.has(activeBlock.id) ? (
            <section className="space-y-3 rounded border p-3">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <h3 className="text-sm font-medium">Block transcript</h3>
                  <p className="text-xs text-muted-foreground">
                    Lines and Lua stay dense inside Sequence blocks.
                  </p>
                </div>
                <div className="flex gap-1">
                  {dialogueSegmentTypeValues.map((type) => (
                    <Button
                      key={type}
                      size="sm"
                      variant="outline"
                      onClick={() => addSegment(activeBlock, type)}
                    >
                      Add {type}
                    </Button>
                  ))}
                </div>
              </div>
              {activeBlock.segments.map((segment, index) => (
                <button
                  key={segment.id}
                  data-workbench-anchor={`dialogue.segment.${segment.id}`}
                  className={`w-full rounded border p-2 text-left text-sm ${segment.id === activeSegment?.id ? 'border-primary bg-primary/5' : ''}`}
                  onClick={() => setSelectedSegmentId(segment.id)}
                >
                  <Badge variant="outline">{index + 1}</Badge>{' '}
                  <span className="font-medium">{segment.type}</span>{' '}
                  <span className="text-xs text-muted-foreground">{segment.id}</span>
                </button>
              ))}
            </section>
          ) : null}
        </div>

        <aside className="space-y-4">
          <section className="space-y-3 rounded border p-3">
            <h3 className="text-sm font-medium">Preview</h3>
            <div className="h-72 overflow-hidden rounded border bg-background">
              <DerivedPreviewPane
                ownerTabId={tab.id}
                previewMode="dialogue"
                previewDocument={previewDocument}
              />
            </div>
            <Label>
              Background
              <Select
                value={previewBackground}
                onValueChange={(value) => setPreviewBackground(value as DialoguePreviewBackground)}
              >
                {dialoguePreviewBackgroundValues.map((background) => (
                  <SelectItem key={background} value={background}>
                    {background}
                  </SelectItem>
                ))}
              </Select>
            </Label>
            <label className="flex items-center gap-2">
              <Switch
                checked={showConditions}
                onCheckedChange={(checked) => setShowConditions(Boolean(checked))}
              />{' '}
              Show condition indicators
            </label>
          </section>

          {activeBlock ? (
            <section
              className="space-y-3 rounded border p-3"
              data-workbench-anchor={`dialogue.block.${activeBlock.id}`}
            >
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium">Block</h3>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={
                    data.blocks.length <= 1 ||
                    (activeBlock.type !== 'comment' && runtimeBlocks.length <= 1)
                  }
                  onClick={() => deleteBlock(activeBlock.id)}
                >
                  Delete
                </Button>
              </div>
              <Label>
                Block ID
                <StableIdInput
                  value={activeBlock.id}
                  onCommit={(nextId) => renameBlock(activeBlock.id, nextId)}
                />
              </Label>
              <Label>
                Label
                <Input
                  value={activeBlock.label}
                  onChange={(event) =>
                    replaceBlock({
                      ...activeBlock,
                      label: event.currentTarget.value,
                    } as DialogueBlockData)
                  }
                />
              </Label>
              <Label>
                Type
                <Select
                  value={activeBlock.type}
                  onValueChange={(value) =>
                    changeBlockType(activeBlock, value as DialogueBlockData['type'])
                  }
                >
                  {dialogueBlockTypeValues.map((type) => (
                    <SelectItem key={type} value={type}>
                      {type}
                    </SelectItem>
                  ))}
                </Select>
              </Label>
              {activeBlock.type === 'sequence' ? (
                <>
                  <Label>
                    Block speaker
                    <Select
                      value={refValue(activeBlock.defaultSpeaker)}
                      onValueChange={(value) =>
                        replaceBlock({
                          ...activeBlock,
                          defaultSpeaker:
                            value === '__none__' ? null : dialogueCharacterRef(String(value)),
                        })
                      }
                    >
                      <SelectItem value="__none__">Use dialogue default</SelectItem>
                      {characters.map((character) => (
                        <SelectItem key={character.id} value={character.id}>
                          {character.label}
                        </SelectItem>
                      ))}
                    </Select>
                  </Label>
                  <Button
                    variant="outline"
                    onClick={() =>
                      setCollapsedBlockIds((ids) => {
                        const next = new Set(ids);
                        if (next.has(activeBlock.id)) next.delete(activeBlock.id);
                        else next.add(activeBlock.id);
                        return next;
                      })
                    }
                  >
                    {collapsedBlockIds.has(activeBlock.id)
                      ? 'Expand transcript'
                      : 'Collapse transcript'}
                  </Button>
                </>
              ) : null}
              {activeBlock.type === 'redirect' ? (
                <Label>
                  Redirect target
                  <Select
                    value={activeBlock.targetBlockId}
                    onValueChange={(value) =>
                      replaceBlock({ ...activeBlock, targetBlockId: String(value) })
                    }
                  >
                    {runtimeBlocks
                      .filter((block) => block.id !== activeBlock.id)
                      .map((block) => (
                        <SelectItem key={block.id} value={block.id}>
                          {block.label}
                        </SelectItem>
                      ))}
                  </Select>
                </Label>
              ) : null}
              {activeBlock.type === 'comment' ? (
                <Label>
                  Comment
                  <textarea
                    className="min-h-24 w-full rounded border bg-background p-2 text-sm"
                    value={activeBlock.text}
                    onChange={(event) =>
                      replaceBlock({ ...activeBlock, text: event.currentTarget.value })
                    }
                  />
                </Label>
              ) : null}
            </section>
          ) : null}

          {activeBlock?.type === 'sequence' && activeSegment ? (
            <section className="space-y-3 rounded border p-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium">Segment</h3>
                <div className="flex gap-1">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => moveSegment(activeBlock, activeSegment.id, -1)}
                  >
                    Up
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => moveSegment(activeBlock, activeSegment.id, 1)}
                  >
                    Down
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      replaceBlock({
                        ...activeBlock,
                        segments: activeBlock.segments.filter(
                          (segment) => segment.id !== activeSegment.id,
                        ),
                      })
                    }
                  >
                    Delete
                  </Button>
                </div>
              </div>
              <Label>
                Segment ID
                <StableIdInput
                  value={activeSegment.id}
                  onCommit={(nextId) => renameSegment(activeBlock, activeSegment.id, nextId)}
                />
              </Label>
              <Label>
                Type
                <Select
                  value={activeSegment.type}
                  onValueChange={(value) =>
                    changeSegmentType(
                      activeBlock,
                      activeSegment,
                      value as DialogueSegmentData['type'],
                    )
                  }
                >
                  {dialogueSegmentTypeValues.map((type) => (
                    <SelectItem key={type} value={type}>
                      {type}
                    </SelectItem>
                  ))}
                </Select>
              </Label>
              {activeSegment.type === 'line' ? (
                <>
                  <Label>
                    Speaker
                    <Select
                      value={refValue(activeSegment.speaker)}
                      onValueChange={(value) =>
                        replaceSegment(activeBlock, {
                          ...activeSegment,
                          speaker:
                            value === '__none__' ? null : dialogueCharacterRef(String(value)),
                        })
                      }
                    >
                      <SelectItem value="__none__">Use block/default speaker</SelectItem>
                      {characters.map((character) => (
                        <SelectItem key={character.id} value={character.id}>
                          {character.label}
                        </SelectItem>
                      ))}
                    </Select>
                  </Label>
                  <Label>
                    Text source
                    <Select
                      value={activeSegment.text.source.kind}
                      onValueChange={(value) => {
                        const kind = String(value);
                        replaceSegment(activeBlock, {
                          ...activeSegment,
                          text: {
                            ...activeSegment.text,
                            source:
                              kind === 'localized'
                                ? { kind, key: 'text-key' }
                                : kind === 'lua-expression'
                                  ? { kind, source: 'return ""' }
                                  : { kind: 'inline', text: '' },
                          },
                        });
                      }}
                    >
                      <SelectItem value="inline">Inline</SelectItem>
                      <SelectItem value="localized">Localized</SelectItem>
                      <SelectItem value="lua-expression">Lua expression</SelectItem>
                    </Select>
                  </Label>
                  <Label>
                    Markup
                    <Select
                      value={activeSegment.text.markup}
                      onValueChange={(value) =>
                        replaceSegment(activeBlock, {
                          ...activeSegment,
                          text: { ...activeSegment.text, markup: value as TextContent['markup'] },
                        })
                      }
                    >
                      <SelectItem value="plain">Plain</SelectItem>
                      <SelectItem value="active-text">ActiveText</SelectItem>
                    </Select>
                  </Label>
                  {activeSegment.text.source.kind === 'localized' ? (
                    <Input
                      value={textValue(activeSegment.text)}
                      onChange={(event) =>
                        replaceSegment(activeBlock, {
                          ...activeSegment,
                          text: replaceTextValue(activeSegment.text, event.currentTarget.value),
                        })
                      }
                    />
                  ) : (
                    <SourceEditor
                      ref={sourceEditors.refFor('segmentText')}
                      className="h-40"
                      language={
                        activeSegment.text.source.kind === 'lua-expression' ? 'lua' : 'text'
                      }
                      value={
                        activeSegment.text.source.kind === 'inline'
                          ? serializeDialogueCueMarkup(
                              activeSegment.text.source.text,
                              activeSegment.cues,
                            )
                          : textValue(activeSegment.text)
                      }
                      onChange={(value) => {
                        if (activeSegment.text.source.kind !== 'inline') {
                          replaceSegment(activeBlock, {
                            ...activeSegment,
                            text: replaceTextValue(activeSegment.text, value),
                          });
                          return;
                        }
                        const parsed = parseDialogueCueMarkup(value);
                        const { presentation: _, ...line } = activeSegment;
                        replaceSegment(activeBlock, {
                          ...line,
                          text: {
                            ...line.text,
                            source: { kind: 'inline', text: parsed.text },
                          },
                          cues: parsed.cues,
                        });
                      }}
                    />
                  )}
                  <div className="space-y-2 rounded border p-2">
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <h4 className="text-xs font-medium">Cue timeline</h4>
                        <p className="text-xs text-muted-foreground">
                          Offsets are Unicode code-point positions in the plain line text. Order
                          resolves cues at the same offset.
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-1">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={audioAssets.length === 0}
                          onClick={() => {
                            const existingIds = data.blocks.flatMap((block) =>
                              block.type === 'sequence'
                                ? block.segments.flatMap((segment) =>
                                    segment.type === 'line'
                                      ? segment.cues.map((cue) => cue.id)
                                      : [],
                                  )
                                : [],
                            );
                            const cue: DialogueLineCue = {
                              id: nextUniqueId(existingIds, 'voice-cue'),
                              kind: 'voice',
                              position: {
                                offset: 0,
                                order:
                                  Math.max(
                                    -1,
                                    ...activeSegment.cues.map((item) => item.position.order),
                                  ) + 1,
                              },
                              asset: { $ref: { collection: 'assets', id: audioAssets[0]!.id } },
                              pausePolicy: 'gameplay',
                              gain: 1,
                              pan: 0,
                              waitForCompletion: false,
                              skipBehavior: 'stop',
                            };
                            replaceLineCues(activeBlock, activeSegment, [
                              ...activeSegment.cues,
                              cue,
                            ]);
                          }}
                        >
                          Add Voice
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={audioAssets.length === 0}
                          onClick={() => {
                            const existingIds = data.blocks.flatMap((block) =>
                              block.type === 'sequence'
                                ? block.segments.flatMap((segment) =>
                                    segment.type === 'line'
                                      ? segment.cues.map((cue) => cue.id)
                                      : [],
                                  )
                                : [],
                            );
                            const cue: DialogueLineCue = {
                              id: nextUniqueId(existingIds, 'sfx-cue'),
                              kind: 'sound-effect',
                              position: {
                                offset: 0,
                                order:
                                  Math.max(
                                    -1,
                                    ...activeSegment.cues.map((item) => item.position.order),
                                  ) + 1,
                              },
                              asset: { $ref: { collection: 'assets', id: audioAssets[0]!.id } },
                              pausePolicy: 'gameplay',
                              gain: 1,
                              pan: 0,
                              waitForCompletion: false,
                              causality: 'disposable',
                              synchronized: false,
                              skipBehavior: 'suppress',
                            };
                            replaceLineCues(activeBlock, activeSegment, [
                              ...activeSegment.cues,
                              cue,
                            ]);
                          }}
                        >
                          Add SFX
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            const existingIds = data.blocks.flatMap((block) =>
                              block.type === 'sequence'
                                ? block.segments.flatMap((segment) =>
                                    segment.type === 'line'
                                      ? segment.cues.map((cue) => cue.id)
                                      : [],
                                  )
                                : [],
                            );
                            const cue: DialogueLineCue = {
                              id: nextUniqueId(existingIds, 'camera-cue'),
                              kind: 'camera',
                              position: {
                                offset: 0,
                                order:
                                  Math.max(
                                    -1,
                                    ...activeSegment.cues.map((item) => item.position.order),
                                  ) + 1,
                              },
                              emphasis: {
                                kind: 'shake',
                                amplitude: { x: 8, y: 8 },
                                frequencyHz: 12,
                                durationMs: 250,
                                skippable: true,
                                waitForCompletion: false,
                              },
                            };
                            replaceLineCues(activeBlock, activeSegment, [
                              ...activeSegment.cues,
                              cue,
                            ]);
                          }}
                        >
                          Add Camera
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={data.stageSlots.length === 0}
                          onClick={() => {
                            const existingIds = data.blocks.flatMap((block) =>
                              block.type === 'sequence'
                                ? block.segments.flatMap((segment) =>
                                    segment.type === 'line'
                                      ? segment.cues.map((cue) => cue.id)
                                      : [],
                                  )
                                : [],
                            );
                            const cue: DialogueLineCue = {
                              id: nextUniqueId(existingIds, 'gesture-cue'),
                              kind: 'gesture',
                              position: {
                                offset: 0,
                                order:
                                  Math.max(
                                    -1,
                                    ...activeSegment.cues.map((item) => item.position.order),
                                  ) + 1,
                              },
                              slotId: data.stageSlots[0]!.id,
                              gestureId: 'gesture',
                              waitForCompletion: false,
                              skippable: true,
                            };
                            replaceLineCues(activeBlock, activeSegment, [
                              ...activeSegment.cues,
                              cue,
                            ]);
                          }}
                        >
                          Add Gesture
                        </Button>
                      </div>
                    </div>
                    {activeSegment.cues.length === 0 ? (
                      <p className="text-xs text-muted-foreground">No inline cues.</p>
                    ) : null}
                    {activeSegment.cues.map((cue, cueIndex) => (
                      <div key={cue.id} className="space-y-2 rounded border p-2">
                        <div className="grid gap-2 md:grid-cols-[1fr_8rem_8rem_auto]">
                          <Label>
                            Cue ID / kind
                            <Input value={`${cue.id} · ${cue.kind}`} readOnly />
                          </Label>
                          <Label>
                            Offset
                            <Input
                              type="number"
                              min="0"
                              value={cue.position.offset}
                              onChange={(event) => {
                                const offset = Number(event.currentTarget.value);
                                if (!Number.isInteger(offset) || offset < 0) return;
                                replaceLineCues(
                                  activeBlock,
                                  activeSegment,
                                  activeSegment.cues.map((candidate, index) =>
                                    index === cueIndex
                                      ? {
                                          ...candidate,
                                          position: { ...candidate.position, offset },
                                        }
                                      : candidate,
                                  ),
                                );
                              }}
                            />
                          </Label>
                          <Label>
                            Order
                            <Input
                              type="number"
                              min="0"
                              value={cue.position.order}
                              onChange={(event) => {
                                const order = Number(event.currentTarget.value);
                                if (!Number.isInteger(order) || order < 0) return;
                                replaceLineCues(
                                  activeBlock,
                                  activeSegment,
                                  activeSegment.cues.map((candidate, index) =>
                                    index === cueIndex
                                      ? { ...candidate, position: { ...candidate.position, order } }
                                      : candidate,
                                  ),
                                );
                              }}
                            />
                          </Label>
                          <Button
                            size="sm"
                            variant="outline"
                            className="self-end"
                            onClick={() =>
                              replaceLineCues(
                                activeBlock,
                                activeSegment,
                                activeSegment.cues.filter((_, index) => index !== cueIndex),
                              )
                            }
                          >
                            Remove
                          </Button>
                        </div>
                        {cue.kind === 'gesture' ? (
                          <div className="space-y-2">
                            <div className="grid gap-2 md:grid-cols-2">
                              <Label>
                                Stage Slot
                                <Select
                                  value={cue.slotId}
                                  onValueChange={(value) =>
                                    replaceLineCueAt(activeBlock, activeSegment, cueIndex, {
                                      ...cue,
                                      slotId: String(value),
                                    })
                                  }
                                >
                                  {data.stageSlots.map((slot) => (
                                    <SelectItem key={slot.id} value={slot.id}>
                                      {slot.label} ({slot.id})
                                    </SelectItem>
                                  ))}
                                </Select>
                              </Label>
                              <Label>
                                Gesture ID
                                <Input
                                  value={cue.gestureId}
                                  onChange={(event) =>
                                    replaceLineCueAt(activeBlock, activeSegment, cueIndex, {
                                      ...cue,
                                      gestureId: event.currentTarget.value,
                                    })
                                  }
                                />
                              </Label>
                            </div>
                            <div className="flex flex-wrap gap-4 text-xs">
                              <Label className="flex items-center gap-2">
                                <Switch
                                  checked={cue.waitForCompletion}
                                  onCheckedChange={(checked) =>
                                    replaceLineCueAt(activeBlock, activeSegment, cueIndex, {
                                      ...cue,
                                      waitForCompletion: Boolean(checked),
                                    })
                                  }
                                />
                                Wait for completion
                              </Label>
                              <Label className="flex items-center gap-2">
                                <Switch
                                  checked={cue.skippable}
                                  onCheckedChange={(checked) =>
                                    replaceLineCueAt(activeBlock, activeSegment, cueIndex, {
                                      ...cue,
                                      skippable: Boolean(checked),
                                    })
                                  }
                                />
                                Skippable
                              </Label>
                            </div>
                          </div>
                        ) : null}
                        {cue.kind === 'voice' || cue.kind === 'sound-effect' ? (
                          <div className="space-y-2">
                            <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
                              <Label>
                                Audio Asset
                                <Select
                                  value={cue.asset.$ref.id}
                                  onValueChange={(value) =>
                                    replaceLineCueAt(activeBlock, activeSegment, cueIndex, {
                                      ...cue,
                                      asset: {
                                        $ref: { collection: 'assets', id: String(value) },
                                      },
                                    })
                                  }
                                >
                                  {audioAssets.map((asset) => (
                                    <SelectItem key={asset.id} value={asset.id}>
                                      {asset.label} ({asset.id})
                                    </SelectItem>
                                  ))}
                                </Select>
                              </Label>
                              <Label>
                                Pause Policy
                                <Select
                                  value={cue.pausePolicy}
                                  onValueChange={(value) =>
                                    replaceLineCueAt(activeBlock, activeSegment, cueIndex, {
                                      ...cue,
                                      pausePolicy: value as typeof cue.pausePolicy,
                                    })
                                  }
                                >
                                  <SelectItem value="gameplay">Gameplay</SelectItem>
                                  <SelectItem value="owner">Owner</SelectItem>
                                  <SelectItem value="unscaled">Unscaled</SelectItem>
                                </Select>
                              </Label>
                              <Label>
                                Gain
                                <Input
                                  type="number"
                                  min="0"
                                  max="1"
                                  step="0.05"
                                  value={cue.gain}
                                  onChange={(event) => {
                                    const gain = Number(event.currentTarget.value);
                                    if (!Number.isFinite(gain) || gain < 0 || gain > 1) return;
                                    replaceLineCueAt(activeBlock, activeSegment, cueIndex, {
                                      ...cue,
                                      gain,
                                    });
                                  }}
                                />
                              </Label>
                              <Label>
                                Pan
                                <Input
                                  type="number"
                                  min="-1"
                                  max="1"
                                  step="0.05"
                                  value={cue.pan}
                                  onChange={(event) => {
                                    const pan = Number(event.currentTarget.value);
                                    if (!Number.isFinite(pan) || pan < -1 || pan > 1) return;
                                    replaceLineCueAt(activeBlock, activeSegment, cueIndex, {
                                      ...cue,
                                      pan,
                                    });
                                  }}
                                />
                              </Label>
                            </div>
                            <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
                              <Label>
                                Skip Behavior
                                <Select
                                  value={cue.skipBehavior}
                                  onValueChange={(value) => {
                                    const skipBehavior = value as typeof cue.skipBehavior;
                                    if (cue.kind === 'sound-effect' && skipBehavior === 'play') {
                                      replaceLineCueAt(activeBlock, activeSegment, cueIndex, {
                                        ...cue,
                                        skipBehavior,
                                        causality: 'causal',
                                      });
                                      return;
                                    }
                                    replaceLineCueAt(activeBlock, activeSegment, cueIndex, {
                                      ...cue,
                                      skipBehavior,
                                    });
                                  }}
                                >
                                  <SelectItem value="stop">Stop</SelectItem>
                                  <SelectItem value="suppress">Suppress</SelectItem>
                                  <SelectItem value="play">Play on skip</SelectItem>
                                </Select>
                              </Label>
                              {cue.kind === 'sound-effect' ? (
                                <Label>
                                  Causality
                                  <Select
                                    value={cue.causality}
                                    onValueChange={(value) => {
                                      const causality = value as typeof cue.causality;
                                      if (
                                        causality === 'disposable' &&
                                        (cue.waitForCompletion ||
                                          cue.synchronized ||
                                          cue.skipBehavior === 'play')
                                      )
                                        return;
                                      replaceLineCueAt(activeBlock, activeSegment, cueIndex, {
                                        ...cue,
                                        causality,
                                      });
                                    }}
                                  >
                                    <SelectItem value="causal">Causal</SelectItem>
                                    <SelectItem value="disposable">Disposable</SelectItem>
                                  </Select>
                                </Label>
                              ) : null}
                              <Label className="flex items-end gap-2 pb-2">
                                <Switch
                                  checked={cue.waitForCompletion}
                                  onCheckedChange={(checked) => {
                                    const waitForCompletion = Boolean(checked);
                                    replaceLineCueAt(
                                      activeBlock,
                                      activeSegment,
                                      cueIndex,
                                      cue.kind === 'sound-effect' && waitForCompletion
                                        ? { ...cue, waitForCompletion, causality: 'causal' }
                                        : { ...cue, waitForCompletion },
                                    );
                                  }}
                                />
                                Wait for completion
                              </Label>
                              {cue.kind === 'sound-effect' ? (
                                <Label className="flex items-end gap-2 pb-2">
                                  <Switch
                                    checked={cue.synchronized}
                                    onCheckedChange={(checked) => {
                                      const synchronized = Boolean(checked);
                                      replaceLineCueAt(activeBlock, activeSegment, cueIndex, {
                                        ...cue,
                                        synchronized,
                                        ...(synchronized ? { causality: 'causal' as const } : {}),
                                      });
                                    }}
                                  />
                                  Synchronized
                                </Label>
                              ) : null}
                            </div>
                          </div>
                        ) : null}
                        {cue.kind === 'camera' ? (
                          <div className="space-y-2">
                            <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
                              <Label>
                                Emphasis
                                <Select
                                  value={cue.emphasis.kind}
                                  onValueChange={(value) => {
                                    const kind = String(value);
                                    const common = {
                                      durationMs: cue.emphasis.durationMs,
                                      skippable: cue.emphasis.skippable,
                                      waitForCompletion: cue.emphasis.waitForCompletion,
                                    };
                                    const emphasis: typeof cue.emphasis =
                                      kind === 'punch'
                                        ? {
                                            kind: 'punch',
                                            translation: { x: 0, y: 0 },
                                            zoomDelta: 0.1,
                                            rotationDegrees: 0,
                                            ...common,
                                          }
                                        : kind === 'flash'
                                          ? {
                                              kind: 'flash',
                                              color: '#ffffff',
                                              opacity: 1,
                                              ...common,
                                            }
                                          : {
                                              kind: 'shake',
                                              amplitude: { x: 8, y: 8 },
                                              frequencyHz: 12,
                                              ...common,
                                            };
                                    replaceLineCueAt(activeBlock, activeSegment, cueIndex, {
                                      ...cue,
                                      emphasis,
                                    });
                                  }}
                                >
                                  <SelectItem value="shake">Shake</SelectItem>
                                  <SelectItem value="punch">Punch</SelectItem>
                                  <SelectItem value="flash">Flash</SelectItem>
                                </Select>
                              </Label>
                              <Label>
                                Duration (ms)
                                <Input
                                  type="number"
                                  min="1"
                                  value={cue.emphasis.durationMs}
                                  onChange={(event) => {
                                    const durationMs = Number(event.currentTarget.value);
                                    if (!Number.isInteger(durationMs) || durationMs <= 0) return;
                                    replaceLineCueAt(activeBlock, activeSegment, cueIndex, {
                                      ...cue,
                                      emphasis: { ...cue.emphasis, durationMs },
                                    });
                                  }}
                                />
                              </Label>
                              <Label className="flex items-end gap-2 pb-2">
                                <Switch
                                  checked={cue.emphasis.waitForCompletion}
                                  onCheckedChange={(checked) =>
                                    replaceLineCueAt(activeBlock, activeSegment, cueIndex, {
                                      ...cue,
                                      emphasis: {
                                        ...cue.emphasis,
                                        waitForCompletion: Boolean(checked),
                                      },
                                    })
                                  }
                                />
                                Wait for completion
                              </Label>
                              <Label className="flex items-end gap-2 pb-2">
                                <Switch
                                  checked={cue.emphasis.skippable}
                                  onCheckedChange={(checked) =>
                                    replaceLineCueAt(activeBlock, activeSegment, cueIndex, {
                                      ...cue,
                                      emphasis: {
                                        ...cue.emphasis,
                                        skippable: Boolean(checked),
                                      },
                                    })
                                  }
                                />
                                Skippable
                              </Label>
                            </div>
                            {cue.emphasis.kind === 'shake' ? (
                              <div className="grid gap-2 md:grid-cols-3">
                                <Label>
                                  Amplitude X
                                  <Input
                                    type="number"
                                    value={cue.emphasis.amplitude.x}
                                    onChange={(event) => {
                                      if (cue.emphasis.kind !== 'shake') return;
                                      const x = Number(event.currentTarget.value);
                                      if (!Number.isFinite(x)) return;
                                      replaceLineCueAt(activeBlock, activeSegment, cueIndex, {
                                        ...cue,
                                        emphasis: {
                                          ...cue.emphasis,
                                          amplitude: { ...cue.emphasis.amplitude, x },
                                        },
                                      });
                                    }}
                                  />
                                </Label>
                                <Label>
                                  Amplitude Y
                                  <Input
                                    type="number"
                                    value={cue.emphasis.amplitude.y}
                                    onChange={(event) => {
                                      if (cue.emphasis.kind !== 'shake') return;
                                      const y = Number(event.currentTarget.value);
                                      if (!Number.isFinite(y)) return;
                                      replaceLineCueAt(activeBlock, activeSegment, cueIndex, {
                                        ...cue,
                                        emphasis: {
                                          ...cue.emphasis,
                                          amplitude: { ...cue.emphasis.amplitude, y },
                                        },
                                      });
                                    }}
                                  />
                                </Label>
                                <Label>
                                  Frequency (Hz)
                                  <Input
                                    type="number"
                                    min="0.01"
                                    step="0.5"
                                    value={cue.emphasis.frequencyHz}
                                    onChange={(event) => {
                                      if (cue.emphasis.kind !== 'shake') return;
                                      const frequencyHz = Number(event.currentTarget.value);
                                      if (!Number.isFinite(frequencyHz) || frequencyHz <= 0) return;
                                      replaceLineCueAt(activeBlock, activeSegment, cueIndex, {
                                        ...cue,
                                        emphasis: { ...cue.emphasis, frequencyHz },
                                      });
                                    }}
                                  />
                                </Label>
                              </div>
                            ) : null}
                            {cue.emphasis.kind === 'punch' ? (
                              <div className="grid gap-2 md:grid-cols-4">
                                <Label>
                                  Translation X
                                  <Input
                                    type="number"
                                    value={cue.emphasis.translation.x}
                                    onChange={(event) => {
                                      if (cue.emphasis.kind !== 'punch') return;
                                      const x = Number(event.currentTarget.value);
                                      if (!Number.isFinite(x)) return;
                                      replaceLineCueAt(activeBlock, activeSegment, cueIndex, {
                                        ...cue,
                                        emphasis: {
                                          ...cue.emphasis,
                                          translation: { ...cue.emphasis.translation, x },
                                        },
                                      });
                                    }}
                                  />
                                </Label>
                                <Label>
                                  Translation Y
                                  <Input
                                    type="number"
                                    value={cue.emphasis.translation.y}
                                    onChange={(event) => {
                                      if (cue.emphasis.kind !== 'punch') return;
                                      const y = Number(event.currentTarget.value);
                                      if (!Number.isFinite(y)) return;
                                      replaceLineCueAt(activeBlock, activeSegment, cueIndex, {
                                        ...cue,
                                        emphasis: {
                                          ...cue.emphasis,
                                          translation: { ...cue.emphasis.translation, y },
                                        },
                                      });
                                    }}
                                  />
                                </Label>
                                <Label>
                                  Zoom Delta
                                  <Input
                                    type="number"
                                    step="0.05"
                                    value={cue.emphasis.zoomDelta}
                                    onChange={(event) => {
                                      if (cue.emphasis.kind !== 'punch') return;
                                      const zoomDelta = Number(event.currentTarget.value);
                                      if (!Number.isFinite(zoomDelta)) return;
                                      replaceLineCueAt(activeBlock, activeSegment, cueIndex, {
                                        ...cue,
                                        emphasis: { ...cue.emphasis, zoomDelta },
                                      });
                                    }}
                                  />
                                </Label>
                                <Label>
                                  Rotation
                                  <Input
                                    type="number"
                                    step="0.5"
                                    value={cue.emphasis.rotationDegrees}
                                    onChange={(event) => {
                                      if (cue.emphasis.kind !== 'punch') return;
                                      const rotationDegrees = Number(event.currentTarget.value);
                                      if (!Number.isFinite(rotationDegrees)) return;
                                      replaceLineCueAt(activeBlock, activeSegment, cueIndex, {
                                        ...cue,
                                        emphasis: { ...cue.emphasis, rotationDegrees },
                                      });
                                    }}
                                  />
                                </Label>
                              </div>
                            ) : null}
                            {cue.emphasis.kind === 'flash' ? (
                              <div className="grid gap-2 md:grid-cols-2">
                                <Label>
                                  Color
                                  <Input
                                    value={cue.emphasis.color}
                                    onChange={(event) => {
                                      if (cue.emphasis.kind !== 'flash') return;
                                      const color = event.currentTarget.value;
                                      if (!color) return;
                                      replaceLineCueAt(activeBlock, activeSegment, cueIndex, {
                                        ...cue,
                                        emphasis: { ...cue.emphasis, color },
                                      });
                                    }}
                                  />
                                </Label>
                                <Label>
                                  Opacity
                                  <Input
                                    type="number"
                                    min="0"
                                    max="1"
                                    step="0.05"
                                    value={cue.emphasis.opacity}
                                    onChange={(event) => {
                                      if (cue.emphasis.kind !== 'flash') return;
                                      const opacity = Number(event.currentTarget.value);
                                      if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1)
                                        return;
                                      replaceLineCueAt(activeBlock, activeSegment, cueIndex, {
                                        ...cue,
                                        emphasis: { ...cue.emphasis, opacity },
                                      });
                                    }}
                                  />
                                </Label>
                              </div>
                            ) : null}
                          </div>
                        ) : null}
                        {cue.kind === 'invalid-markup' ? (
                          <p className="text-xs text-destructive">{cue.message}</p>
                        ) : null}
                      </div>
                    ))}
                  </div>
                  <div className="space-y-2 rounded border p-2">
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <h4 className="text-xs font-medium">Line presentation</h4>
                        <p className="text-xs text-muted-foreground">
                          Mutations are retained. Empty update fields preserve the current slot
                          value.
                        </p>
                      </div>
                      <div className="flex gap-1">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={data.stageSlots.length === 0}
                          onClick={() => {
                            const mutation: DialogueStageMutation = {
                              slotId: data.stageSlots[0]!.id,
                              action: 'update',
                            };
                            replaceSegment(activeBlock, {
                              ...activeSegment,
                              presentation: {
                                ...activeSegment.presentation,
                                stage: [...activeSegment.presentation.stage, mutation],
                              },
                            });
                          }}
                        >
                          Add Stage mutation
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={data.mediaSlots.length === 0}
                          onClick={() => {
                            const mutation: DialogueMediaMutation = {
                              slotId: data.mediaSlots[0]!.id,
                              action: 'update',
                            };
                            replaceSegment(activeBlock, {
                              ...activeSegment,
                              presentation: {
                                ...activeSegment.presentation,
                                media: [...activeSegment.presentation.media, mutation],
                              },
                            });
                          }}
                        >
                          Add Media mutation
                        </Button>
                      </div>
                    </div>
                    <Label>
                      Speaker expression override
                      <Input
                        value={activeSegment.presentation.speakerExpressionId ?? ''}
                        placeholder="preserve current expression"
                        onChange={(event) => {
                          const value = event.currentTarget.value.trim();
                          replaceSegment(activeBlock, {
                            ...activeSegment,
                            presentation: {
                              ...activeSegment.presentation,
                              ...(value
                                ? { speakerExpressionId: value }
                                : (() => {
                                    const { speakerExpressionId: _, ...rest } =
                                      activeSegment.presentation;
                                    return rest;
                                  })()),
                            },
                          });
                        }}
                      />
                    </Label>
                    {activeSegment.presentation.stage.map((mutation, mutationIndex) => (
                      <div key={`stage-${mutationIndex}`} className="space-y-2 rounded border p-2">
                        <div className="grid gap-2 md:grid-cols-[1fr_1fr_auto]">
                          <Label>
                            Stage Slot
                            <Select
                              value={mutation.slotId}
                              onValueChange={(value) => {
                                const stage = activeSegment.presentation.stage.map(
                                  (candidate, index) =>
                                    index === mutationIndex
                                      ? { ...candidate, slotId: String(value) }
                                      : candidate,
                                );
                                replaceSegment(activeBlock, {
                                  ...activeSegment,
                                  presentation: { ...activeSegment.presentation, stage },
                                });
                              }}
                            >
                              {data.stageSlots.map((slot) => (
                                <SelectItem key={slot.id} value={slot.id}>
                                  {slot.label} ({slot.id})
                                </SelectItem>
                              ))}
                            </Select>
                          </Label>
                          <Label>
                            Action
                            <Select
                              value={mutation.action}
                              onValueChange={(value) => {
                                const action = value as DialogueStageMutation['action'];
                                const next: DialogueStageMutation =
                                  action === 'clear'
                                    ? { slotId: mutation.slotId, action }
                                    : { ...mutation, action };
                                const stage = activeSegment.presentation.stage.map(
                                  (candidate, index) =>
                                    index === mutationIndex ? next : candidate,
                                );
                                replaceSegment(activeBlock, {
                                  ...activeSegment,
                                  presentation: { ...activeSegment.presentation, stage },
                                });
                              }}
                            >
                              {['update', 'show', 'hide', 'clear'].map((action) => (
                                <SelectItem key={action} value={action}>
                                  {action}
                                </SelectItem>
                              ))}
                            </Select>
                          </Label>
                          <Button
                            size="sm"
                            variant="outline"
                            className="self-end"
                            onClick={() => {
                              const stage = activeSegment.presentation.stage.filter(
                                (_, index) => index !== mutationIndex,
                              );
                              replaceSegment(activeBlock, {
                                ...activeSegment,
                                presentation: { ...activeSegment.presentation, stage },
                              });
                            }}
                          >
                            Remove
                          </Button>
                        </div>
                        {mutation.action !== 'clear' ? (
                          <div className="grid gap-2 md:grid-cols-2">
                            <Label>
                              Character
                              <Select
                                value={mutation.character?.$ref.id ?? '__preserve__'}
                                onValueChange={(value) => {
                                  const stage = activeSegment.presentation.stage.map(
                                    (candidate, index): DialogueStageMutation => {
                                      if (index !== mutationIndex) return candidate;
                                      if (value === '__preserve__') {
                                        const { character: _, ...rest } = candidate;
                                        return rest;
                                      }
                                      return {
                                        ...candidate,
                                        character: dialogueCharacterRef(String(value)),
                                      };
                                    },
                                  );
                                  replaceSegment(activeBlock, {
                                    ...activeSegment,
                                    presentation: { ...activeSegment.presentation, stage },
                                  });
                                }}
                              >
                                <SelectItem value="__preserve__">Preserve</SelectItem>
                                {characters.map((character) => (
                                  <SelectItem key={character.id} value={character.id}>
                                    {character.label}
                                  </SelectItem>
                                ))}
                              </Select>
                            </Label>
                            {(['profileId', 'poseId', 'expressionId'] as const).map((field) => (
                              <Label key={field}>
                                {field === 'profileId'
                                  ? 'Profile'
                                  : field === 'poseId'
                                    ? 'Pose'
                                    : 'Expression'}
                                <Input
                                  value={mutation[field] ?? ''}
                                  placeholder="preserve"
                                  onChange={(event) => {
                                    const value = event.currentTarget.value.trim();
                                    const stage = activeSegment.presentation.stage.map(
                                      (candidate, index): DialogueStageMutation => {
                                        if (index !== mutationIndex) return candidate;
                                        if (!value) {
                                          const next = { ...candidate };
                                          delete next[field];
                                          return next;
                                        }
                                        return { ...candidate, [field]: value };
                                      },
                                    );
                                    replaceSegment(activeBlock, {
                                      ...activeSegment,
                                      presentation: { ...activeSegment.presentation, stage },
                                    });
                                  }}
                                />
                              </Label>
                            ))}
                            <Label>
                              Appearance
                              <Input
                                value={mutation.appearanceId ?? ''}
                                placeholder="preserve; use 'none' to clear"
                                onChange={(event) => {
                                  const value = event.currentTarget.value.trim();
                                  const stage = activeSegment.presentation.stage.map(
                                    (candidate, index): DialogueStageMutation => {
                                      if (index !== mutationIndex) return candidate;
                                      if (!value) {
                                        const { appearanceId: _, ...rest } = candidate;
                                        return rest;
                                      }
                                      return {
                                        ...candidate,
                                        appearanceId: value === 'none' ? null : value,
                                      };
                                    },
                                  );
                                  replaceSegment(activeBlock, {
                                    ...activeSegment,
                                    presentation: { ...activeSegment.presentation, stage },
                                  });
                                }}
                              />
                            </Label>
                            <Label>
                              Position
                              <Select
                                value={mutation.position ?? '__preserve__'}
                                onValueChange={(value) => {
                                  const stage = activeSegment.presentation.stage.map(
                                    (candidate, index): DialogueStageMutation => {
                                      if (index !== mutationIndex) return candidate;
                                      if (value === '__preserve__') {
                                        const { position: _, ...rest } = candidate;
                                        return rest;
                                      }
                                      return {
                                        ...candidate,
                                        position: value as DialogueStageMutation['position'],
                                      };
                                    },
                                  );
                                  replaceSegment(activeBlock, {
                                    ...activeSegment,
                                    presentation: { ...activeSegment.presentation, stage },
                                  });
                                }}
                              >
                                <SelectItem value="__preserve__">Preserve</SelectItem>
                                <SelectItem value="left">left</SelectItem>
                                <SelectItem value="center">center</SelectItem>
                                <SelectItem value="right">right</SelectItem>
                              </Select>
                            </Label>
                            <Label>
                              Offset X
                              <Input
                                type="number"
                                value={mutation.offset?.x ?? ''}
                                placeholder="preserve"
                                onChange={(event) => {
                                  const x = Number(event.currentTarget.value);
                                  if (!Number.isFinite(x)) return;
                                  const stage = activeSegment.presentation.stage.map(
                                    (candidate, index): DialogueStageMutation =>
                                      index === mutationIndex
                                        ? {
                                            ...candidate,
                                            offset: { x, y: candidate.offset?.y ?? 0 },
                                          }
                                        : candidate,
                                  );
                                  replaceSegment(activeBlock, {
                                    ...activeSegment,
                                    presentation: { ...activeSegment.presentation, stage },
                                  });
                                }}
                              />
                            </Label>
                            <Label>
                              Offset Y
                              <Input
                                type="number"
                                value={mutation.offset?.y ?? ''}
                                placeholder="preserve"
                                onChange={(event) => {
                                  const y = Number(event.currentTarget.value);
                                  if (!Number.isFinite(y)) return;
                                  const stage = activeSegment.presentation.stage.map(
                                    (candidate, index): DialogueStageMutation =>
                                      index === mutationIndex
                                        ? {
                                            ...candidate,
                                            offset: { x: candidate.offset?.x ?? 0, y },
                                          }
                                        : candidate,
                                  );
                                  replaceSegment(activeBlock, {
                                    ...activeSegment,
                                    presentation: { ...activeSegment.presentation, stage },
                                  });
                                }}
                              />
                            </Label>
                            <Label>
                              Scale
                              <Input
                                type="number"
                                min="0.01"
                                step="0.05"
                                value={mutation.scale ?? ''}
                                placeholder="preserve"
                                onChange={(event) => {
                                  const scale = Number(event.currentTarget.value);
                                  if (!Number.isFinite(scale) || scale <= 0) return;
                                  const stage = activeSegment.presentation.stage.map(
                                    (candidate, index): DialogueStageMutation =>
                                      index === mutationIndex ? { ...candidate, scale } : candidate,
                                  );
                                  replaceSegment(activeBlock, {
                                    ...activeSegment,
                                    presentation: { ...activeSegment.presentation, stage },
                                  });
                                }}
                              />
                            </Label>
                          </div>
                        ) : null}
                      </div>
                    ))}
                    {activeSegment.presentation.media.map((mutation, mutationIndex) => (
                      <div key={`media-${mutationIndex}`} className="space-y-2 rounded border p-2">
                        <div className="grid gap-2 md:grid-cols-[1fr_1fr_auto]">
                          <Label>
                            Media Slot
                            <Select
                              value={mutation.slotId}
                              onValueChange={(value) => {
                                const media = activeSegment.presentation.media.map(
                                  (candidate, index) =>
                                    index === mutationIndex
                                      ? { ...candidate, slotId: String(value) }
                                      : candidate,
                                );
                                replaceSegment(activeBlock, {
                                  ...activeSegment,
                                  presentation: { ...activeSegment.presentation, media },
                                });
                              }}
                            >
                              {data.mediaSlots.map((slot) => (
                                <SelectItem key={slot.id} value={slot.id}>
                                  {slot.label} ({slot.id})
                                </SelectItem>
                              ))}
                            </Select>
                          </Label>
                          <Label>
                            Action
                            <Select
                              value={mutation.action}
                              onValueChange={(value) => {
                                const action = value as DialogueMediaMutation['action'];
                                const next: DialogueMediaMutation =
                                  action === 'clear'
                                    ? { slotId: mutation.slotId, action }
                                    : { ...mutation, action };
                                const media = activeSegment.presentation.media.map(
                                  (candidate, index) =>
                                    index === mutationIndex ? next : candidate,
                                );
                                replaceSegment(activeBlock, {
                                  ...activeSegment,
                                  presentation: { ...activeSegment.presentation, media },
                                });
                              }}
                            >
                              {['update', 'show', 'hide', 'clear'].map((action) => (
                                <SelectItem key={action} value={action}>
                                  {action}
                                </SelectItem>
                              ))}
                            </Select>
                          </Label>
                          <Button
                            size="sm"
                            variant="outline"
                            className="self-end"
                            onClick={() => {
                              const media = activeSegment.presentation.media.filter(
                                (_, index) => index !== mutationIndex,
                              );
                              replaceSegment(activeBlock, {
                                ...activeSegment,
                                presentation: { ...activeSegment.presentation, media },
                              });
                            }}
                          >
                            Remove
                          </Button>
                        </div>
                        {mutation.action === 'update' ? (
                          <div className="grid gap-2 md:grid-cols-2">
                            <Label>
                              Content
                              <Select
                                value={mutation.content?.kind ?? '__preserve__'}
                                onValueChange={(value) => {
                                  const media = activeSegment.presentation.media.map(
                                    (candidate, index): DialogueMediaMutation => {
                                      if (index !== mutationIndex) return candidate;
                                      if (value === '__preserve__') {
                                        const { content: _, ...rest } = candidate;
                                        return rest;
                                      }
                                      if (value === 'character') {
                                        const content = defaultCharacterMedia();
                                        return content ? { ...candidate, content } : candidate;
                                      }
                                      const asset = imageAssets[0];
                                      return asset
                                        ? {
                                            ...candidate,
                                            content: {
                                              kind: 'image',
                                              asset: {
                                                $ref: { collection: 'assets', id: asset.id },
                                              },
                                            },
                                          }
                                        : candidate;
                                    },
                                  );
                                  replaceSegment(activeBlock, {
                                    ...activeSegment,
                                    presentation: { ...activeSegment.presentation, media },
                                  });
                                }}
                              >
                                <SelectItem value="__preserve__">Preserve</SelectItem>
                                <SelectItem value="character" disabled={characters.length === 0}>
                                  Character
                                </SelectItem>
                                <SelectItem value="image" disabled={imageAssets.length === 0}>
                                  Image
                                </SelectItem>
                              </Select>
                            </Label>
                            {mutation.content?.kind === 'image' ? (
                              <Label>
                                Image
                                <Select
                                  value={mutation.content.asset.$ref.id}
                                  onValueChange={(value) => {
                                    const media = activeSegment.presentation.media.map(
                                      (candidate, index): DialogueMediaMutation =>
                                        index === mutationIndex
                                          ? {
                                              ...candidate,
                                              content: {
                                                kind: 'image',
                                                asset: {
                                                  $ref: {
                                                    collection: 'assets',
                                                    id: String(value),
                                                  },
                                                },
                                              },
                                            }
                                          : candidate,
                                    );
                                    replaceSegment(activeBlock, {
                                      ...activeSegment,
                                      presentation: { ...activeSegment.presentation, media },
                                    });
                                  }}
                                >
                                  {imageAssets.map((asset) => (
                                    <SelectItem key={asset.id} value={asset.id}>
                                      {asset.label}
                                    </SelectItem>
                                  ))}
                                </Select>
                              </Label>
                            ) : null}
                            {mutation.content?.kind === 'character' ? (
                              <Label>
                                Character
                                <Select
                                  value={mutation.content.character.$ref.id}
                                  onValueChange={(value) => {
                                    const content = defaultCharacterMedia(String(value));
                                    if (!content) return;
                                    const media = activeSegment.presentation.media.map(
                                      (candidate, index): DialogueMediaMutation =>
                                        index === mutationIndex
                                          ? { ...candidate, content }
                                          : candidate,
                                    );
                                    replaceSegment(activeBlock, {
                                      ...activeSegment,
                                      presentation: { ...activeSegment.presentation, media },
                                    });
                                  }}
                                >
                                  {characters.map((character) => (
                                    <SelectItem key={character.id} value={character.id}>
                                      {character.label}
                                    </SelectItem>
                                  ))}
                                </Select>
                              </Label>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                  <ConditionEditor
                    condition={activeSegment.condition}
                    project={project}
                    onChange={(condition) =>
                      replaceSegment(activeBlock, { ...activeSegment, condition })
                    }
                  />
                  <EffectsEditor
                    effects={activeSegment.effects}
                    variableOptions={variables}
                    onChange={(effects) =>
                      replaceSegment(activeBlock, { ...activeSegment, effects })
                    }
                  />
                  <label className="flex items-center gap-2">
                    <Switch
                      checked={activeSegment.showOnce}
                      onCheckedChange={(checked) =>
                        replaceSegment(activeBlock, {
                          ...activeSegment,
                          showOnce: Boolean(checked),
                        })
                      }
                    />{' '}
                    Show once
                  </label>
                  <label className="flex items-center gap-2">
                    <Switch
                      checked={activeSegment.logged}
                      onCheckedChange={(checked) =>
                        replaceSegment(activeBlock, { ...activeSegment, logged: Boolean(checked) })
                      }
                    />{' '}
                    Logged
                  </label>
                  <label className="flex items-center gap-2">
                    <Switch
                      checked={activeSegment.autosaveSafePoint}
                      onCheckedChange={(checked) =>
                        replaceSegment(activeBlock, {
                          ...activeSegment,
                          autosaveSafePoint: Boolean(checked),
                        })
                      }
                    />{' '}
                    Autosave safe point
                  </label>
                </>
              ) : null}
              {activeSegment.type === 'run-lua' ? (
                <>
                  <SourceEditor
                    ref={sourceEditors.refFor('segmentLua')}
                    className="h-40"
                    language="lua"
                    value={activeSegment.source}
                    onChange={(source) => replaceSegment(activeBlock, { ...activeSegment, source })}
                  />
                  <label className="flex items-center gap-2">
                    <Switch
                      checked={activeSegment.mayYield}
                      onCheckedChange={(checked) =>
                        replaceSegment(activeBlock, {
                          ...activeSegment,
                          mayYield: Boolean(checked),
                        })
                      }
                    />{' '}
                    May yield
                  </label>
                  <ConditionEditor
                    condition={activeSegment.condition}
                    project={project}
                    onChange={(condition) =>
                      replaceSegment(activeBlock, { ...activeSegment, condition })
                    }
                  />
                </>
              ) : null}
              {activeSegment.type === 'call-scene' ? (
                <>
                  <Label>
                    Child Scene
                    <Select
                      value={activeSegment.scene.$ref.id}
                      onValueChange={(sceneId) =>
                        replaceSegment(activeBlock, {
                          ...activeSegment,
                          scene: { $ref: { collection: 'scenes', id: String(sceneId) } },
                          inputs: [],
                        })
                      }
                    >
                      {Object.entries(project.scenes).map(([id, scene]) => (
                        <SelectItem key={id} value={id}>
                          {scene.label}
                        </SelectItem>
                      ))}
                    </Select>
                  </Label>
                  <Label>
                    Caller UI while child runs
                    <Select
                      value={activeSegment.uiPolicy}
                      onValueChange={(uiPolicy) =>
                        replaceSegment(activeBlock, {
                          ...activeSegment,
                          uiPolicy: uiPolicy as typeof activeSegment.uiPolicy,
                        })
                      }
                    >
                      <SelectItem value="conceal">Conceal Dialogue UI</SelectItem>
                      <SelectItem value="preserve">Preserve Dialogue UI</SelectItem>
                    </Select>
                  </Label>
                  <div className="space-y-2 rounded border p-2">
                    <span className="text-xs font-medium">Input bindings</span>
                    {(
                      parseSceneData(project.scenes[activeSegment.scene.$ref.id]?.data)?.inputs ??
                      []
                    ).map((input) => {
                      const binding = activeSegment.inputs.find(
                        (candidate) => candidate.inputId === input.id,
                      );
                      return (
                        <Label key={input.id}>
                          {input.label} ({input.type})
                          <Input
                            value={binding?.value === undefined ? '' : String(binding.value)}
                            placeholder={input.nullable ? 'null' : input.id}
                            onChange={(event) => {
                              const value = dialogueSceneInputValue(input, event.target.value);
                              const inputs = activeSegment.inputs.filter(
                                (candidate) => candidate.inputId !== input.id,
                              );
                              if (value !== undefined) inputs.push({ inputId: input.id, value });
                              replaceSegment(activeBlock, { ...activeSegment, inputs });
                            }}
                          />
                        </Label>
                      );
                    })}
                  </div>
                  <ConditionEditor
                    condition={activeSegment.condition}
                    project={project}
                    onChange={(condition) =>
                      replaceSegment(activeBlock, { ...activeSegment, condition })
                    }
                  />
                </>
              ) : null}
              {activeSegment.type === 'handoff' ? (
                <>
                  <label className="flex items-center gap-2">
                    <Switch
                      checked={activeSegment.payload !== undefined}
                      onCheckedChange={(checked) =>
                        replaceSegment(activeBlock, {
                          ...activeSegment,
                          ...(checked ? { payload: null } : { payload: undefined }),
                        })
                      }
                    />{' '}
                    Include typed payload
                  </label>
                  {activeSegment.payload !== undefined ? (
                    <Label>
                      Payload
                      <Input
                        value={String(activeSegment.payload)}
                        onChange={(event) =>
                          replaceSegment(activeBlock, {
                            ...activeSegment,
                            payload: scalar(event.currentTarget.value),
                          })
                        }
                      />
                    </Label>
                  ) : null}
                  <p className="text-xs text-muted-foreground">
                    Handoff resumes the next sequential Event in the directly awaiting Scene. No
                    authored routing ID is used.
                  </p>
                  <ConditionEditor
                    condition={activeSegment.condition}
                    project={project}
                    onChange={(condition) =>
                      replaceSegment(activeBlock, { ...activeSegment, condition })
                    }
                  />
                </>
              ) : null}
              {activeSegment.type === 'comment' ? (
                <textarea
                  className="min-h-24 w-full rounded border bg-background p-2 text-sm"
                  value={activeSegment.text}
                  onChange={(event) =>
                    replaceSegment(activeBlock, {
                      ...activeSegment,
                      text: event.currentTarget.value,
                    })
                  }
                />
              ) : null}
            </section>
          ) : null}

          {activeBlock?.type === 'sequence' ? (
            <section className="space-y-2 rounded border p-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium">Next</h3>
                {outgoingEdges.length === 0 ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      addEdge(
                        activeBlock.id,
                        runtimeBlocks.find((block) => block.id !== activeBlock.id)?.id ??
                          activeBlock.id,
                      )
                    }
                  >
                    Add next
                  </Button>
                ) : null}
              </div>
              {outgoingEdges.map((edge) => (
                <div
                  key={edge.id}
                  className="space-y-2 rounded border p-2"
                  data-workbench-anchor={`dialogue.edge.${edge.id}`}
                >
                  <Label>
                    Edge ID
                    <StableIdInput
                      value={edge.id}
                      onCommit={(nextId) => renameEdge(edge.id, nextId)}
                    />
                  </Label>
                  <Label>
                    Target
                    <Select
                      value={edge.toBlockId}
                      onValueChange={(value) => replaceEdge({ ...edge, toBlockId: String(value) })}
                    >
                      {runtimeBlocks.map((block) => (
                        <SelectItem key={block.id} value={block.id}>
                          {block.label}
                        </SelectItem>
                      ))}
                    </Select>
                  </Label>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      commit(
                        {
                          ...data,
                          edges: data.edges.filter((candidate) => candidate.id !== edge.id),
                        },
                        'Delete dialogue edge',
                      )
                    }
                  >
                    Delete
                  </Button>
                </div>
              ))}
            </section>
          ) : null}

          {activeBlock?.type === 'choice' ? (
            <section className="space-y-3 rounded border p-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium">Choices</h3>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    addEdge(
                      activeBlock.id,
                      runtimeBlocks.find((block) => block.id !== activeBlock.id)?.id ??
                        activeBlock.id,
                    )
                  }
                >
                  Add choice
                </Button>
              </div>
              {outgoingEdges.map((edge, index) =>
                edge.kind === 'choice' ? (
                  <div
                    key={edge.id}
                    className="space-y-2 rounded border p-2"
                    data-workbench-anchor={`dialogue.edge.${edge.id}`}
                  >
                    <div className="flex gap-1">
                      <Button size="sm" variant="outline" onClick={() => moveEdge(edge.id, -1)}>
                        Up
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => moveEdge(edge.id, 1)}>
                        Down
                      </Button>
                    </div>
                    <Label>
                      Edge ID
                      <StableIdInput
                        value={edge.id}
                        onCommit={(nextId) => renameEdge(edge.id, nextId)}
                      />
                    </Label>
                    <Label>
                      Label
                      <Input
                        value={textValue(edge.label)}
                        onChange={(event) =>
                          replaceEdge({
                            ...edge,
                            label: replaceTextValue(edge.label, event.currentTarget.value),
                          })
                        }
                      />
                    </Label>
                    <Label>
                      Target
                      <Select
                        value={edge.toBlockId}
                        onValueChange={(value) =>
                          replaceEdge({ ...edge, toBlockId: String(value) })
                        }
                      >
                        {runtimeBlocks.map((block) => (
                          <SelectItem key={block.id} value={block.id}>
                            {block.label}
                          </SelectItem>
                        ))}
                      </Select>
                    </Label>
                    <ConditionEditor
                      condition={edge.condition}
                      project={project}
                      onChange={(condition) => replaceEdge({ ...edge, condition })}
                    />
                    <EffectsEditor
                      effects={edge.effects}
                      variableOptions={variables}
                      onChange={(effects) => replaceEdge({ ...edge, effects })}
                    />
                    <label className="flex items-center gap-2">
                      <Switch
                        checked={edge.logged}
                        onCheckedChange={(checked) =>
                          replaceEdge({ ...edge, logged: Boolean(checked) })
                        }
                      />{' '}
                      Logged
                    </label>
                    <label className="flex items-center gap-2">
                      <Switch
                        checked={edge.autosaveSafePoint}
                        onCheckedChange={(checked) =>
                          replaceEdge({ ...edge, autosaveSafePoint: Boolean(checked) })
                        }
                      />{' '}
                      Autosave safe point
                    </label>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={outgoingEdges.length <= 1}
                      onClick={() =>
                        commit(
                          {
                            ...data,
                            edges: data.edges.filter((candidate) => candidate.id !== edge.id),
                          },
                          'Delete dialogue choice',
                        )
                      }
                    >
                      Delete choice {index + 1}
                    </Button>
                  </div>
                ) : null,
              )}
            </section>
          ) : null}

          <section
            className="space-y-2 rounded border p-3"
            data-workbench-anchor="dialogue.diagnostics"
          >
            <h3 className="text-sm font-medium">Diagnostics</h3>
            <DiagnosticList items={diagnosticItems} emptyMessage="No dialogue diagnostics." />
          </section>
        </aside>
      </div>
    </div>
  );
}
