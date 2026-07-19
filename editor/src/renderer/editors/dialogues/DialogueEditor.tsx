import { useEffect, useMemo, useRef, useState } from 'react';
import { SourceEditor } from '@/components/source/SourceEditor';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectItem } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useCommandStore } from '@/commands/command-store';
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
  type DialoguePreviewBackground,
  type DialogueSegmentData,
  type DialogueSequenceBlockData,
} from '../../../shared/project-schema/authoring-dialogues';
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

const DIALOGUE_EDITOR_TAB_STATE_SCHEMA = 'noveltea.editor.tab-state.dialogue.v2';

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
  return useCommandStore
    .getState()
    .executeCommand({ type: 'dialogue.replaceData', label, payload: { dialogueId, data: next } });
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

function conditionFromKind(
  kind: string,
  variableId: string | undefined,
): DialogueConditionData | undefined {
  if (kind === 'none') return undefined;
  if (kind === 'always') return { kind: 'always' };
  if (kind === 'lua-predicate') return { kind: 'lua-predicate', source: 'return true' };
  return {
    kind: 'variable-comparison',
    variable: { $ref: { collection: 'variables', id: variableId ?? 'variable' } },
    operator: 'equal',
    value: false,
  };
}

function ConditionEditor({
  condition,
  variableOptions,
  onChange,
}: {
  condition: DialogueConditionData | undefined;
  variableOptions: Array<{ id: string; label: string }>;
  onChange: (condition: DialogueConditionData | undefined) => void;
}) {
  return (
    <div className="space-y-2 rounded border p-2">
      <Label>Condition</Label>
      <Select
        value={condition?.kind ?? 'none'}
        onValueChange={(value) =>
          onChange(conditionFromKind(String(value), variableOptions[0]?.id))
        }
      >
        <SelectItem value="none">None</SelectItem>
        <SelectItem value="always">Always</SelectItem>
        <SelectItem value="variable-comparison">Variable comparison</SelectItem>
        <SelectItem value="lua-predicate">Lua predicate</SelectItem>
      </Select>
      {condition?.kind === 'lua-predicate' ? (
        <textarea
          className="min-h-24 w-full rounded border bg-background p-2 font-mono text-xs"
          value={condition.source}
          onChange={(event) => onChange({ ...condition, source: event.currentTarget.value })}
        />
      ) : null}
      {condition?.kind === 'variable-comparison' ? (
        <>
          <Select
            value={condition.variable.$ref.id}
            onValueChange={(value) =>
              onChange({
                ...condition,
                variable: { $ref: { collection: 'variables', id: String(value) } },
              })
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
          <Select
            value={condition.operator}
            onValueChange={(value) =>
              onChange({ ...condition, operator: value as typeof condition.operator })
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
                {operator}
              </SelectItem>
            ))}
          </Select>
          {!['truthy', 'falsy'].includes(condition.operator) ? (
            <Input
              value={String(condition.value ?? '')}
              onChange={(event) =>
                onChange({ ...condition, value: scalar(event.currentTarget.value) })
              }
            />
          ) : null}
        </>
      ) : null}
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
        captureTabState: () => ({
          schema: DIALOGUE_EDITOR_TAB_STATE_SCHEMA,
          schemaVersion: 2,
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
  const activeSegment =
    activeBlock?.type === 'sequence'
      ? (activeBlock.segments.find((segment) => segment.id === selectedSegmentId) ??
        activeBlock.segments[0] ??
        null)
      : null;
  const characters = Object.entries(project.characters).map(([id, character]) => ({
    id,
    label: character.label,
  }));
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
    const segment = defaultDialogueSegment(type, id);
    replaceBlock({ ...block, segments: [...block.segments, segment] });
    setSelectedSegmentId(id);
  }

  function replaceSegment(block: DialogueSequenceBlockData, segment: DialogueSegmentData) {
    replaceBlock({
      ...block,
      segments: block.segments.map((candidate) =>
        candidate.id === segment.id ? segment : candidate,
      ),
    });
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
    replaceSegment(block, defaultDialogueSegment(type, segment.id));
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
          Dialogue data is invalid; editable V2 defaults are shown.
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
                      value={textValue(activeSegment.text)}
                      onChange={(value) =>
                        replaceSegment(activeBlock, {
                          ...activeSegment,
                          text: replaceTextValue(activeSegment.text, value),
                        })
                      }
                    />
                  )}
                  <ConditionEditor
                    condition={activeSegment.condition}
                    variableOptions={variables}
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
                    variableOptions={variables}
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
                      variableOptions={variables}
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
