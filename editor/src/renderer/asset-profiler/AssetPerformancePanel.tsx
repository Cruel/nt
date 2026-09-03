import { ChevronDown, ChevronRight, ExternalLink } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useTranslation } from 'react-i18next';
import { useCommandStore } from '@/commands/command-store';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { resolveProjectDiagnosticTarget } from '@/diagnostics/diagnostic-navigation';
import { createEditorFormatters } from '@/i18n/formatting';
import { useProjectStore } from '@/project/project-store';
import { PROJECT_SETTINGS_SAVE_UNIT_ID } from '@/project/save-unit-registry';
import { compileAuthoringProject } from '../../shared/authoring-compiler';
import {
  projectFlowPredictionIndexForTooling,
  type FlowPredictionToolingPoint,
} from '../../shared/flow-prediction-tooling';
import { isAuthoringProject } from '../../shared/project-schema/authoring-project';
import type {
  PrefetchHintAttachment,
  PrefetchHintPoint,
  PrefetchHintTarget,
} from '../../shared/project-schema/authoring-prefetch-hints';
import { buildFullGamePreviewTab } from '@/workbench/editor-registry';
import { navigateToWorkbenchTarget } from '@/workbench/workbench-navigation';
import { useWorkbenchStore } from '@/workbench/workbench-store';
import { deriveAssetProfilerIssues, type AssetProfilerIssueType } from './asset-profiler-issues';
import {
  assetProfilerAssetGpu,
  assetProfilerAssetRam,
  assetProfilerEntryUsesEstimate,
  filterAndSortAssetProfilerEntries,
  type AssetProfilerAssetSort,
  type AssetProfilerAssetStateFilter,
  type AssetProfilerAssetTypeFilter,
} from './asset-profiler-assets';
import { resolveAssetProfilerIdentityTarget } from './asset-profiler-navigation';
import {
  assetProfilerEntryKey,
  type AssetProfilerViewId,
  useAssetProfilerStore,
} from './asset-profiler-store';

type BigMemory = {
  sourceBytes: bigint;
  preparedCpuBytes: bigint;
  gpuBytes: bigint;
  audioBytes: bigint;
  temporaryBytes: bigint;
};

function Metric({
  label,
  value,
  secondary,
  tooltip,
}: {
  label: string;
  value: string;
  secondary?: string;
  tooltip: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div className="min-w-40 border-r border-b p-3 text-left last:border-r-0">
            <div className="text-[11px] text-muted-foreground">{label}</div>
            <div className="mt-1 text-lg font-semibold tabular-nums">{value}</div>
            {secondary ? (
              <div className="text-[10px] text-muted-foreground">{secondary}</div>
            ) : null}
          </div>
        }
      />
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}

function EmptyState({
  message,
  actionLabel,
  onAction,
}: {
  message: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className="flex h-full min-h-28 flex-col items-center justify-center gap-3 p-4 text-center text-xs text-muted-foreground">
      <span>{message}</span>
      {actionLabel && onAction ? (
        <Button size="sm" variant="outline" onClick={onAction}>
          {actionLabel}
        </Button>
      ) : null}
    </div>
  );
}

function predictionPointLabel(point: FlowPredictionToolingPoint) {
  switch (point.kind) {
    case 'scene-entry':
      return `scene:${point.scene.id}:entry`;
    case 'scene-step':
      return `scene:${point.scene.id}:step:${point.stepId}`;
    case 'scene-terminal':
      return `scene:${point.scene.id}:terminal`;
    case 'dialogue-entry':
      return `dialogue:${point.dialogue.id}:entry`;
    case 'dialogue-position':
      return `dialogue:${point.dialogue.id}:${point.stage}:${point.cursor}`;
    case 'dialogue-terminal':
      return `dialogue:${point.dialogue.id}:terminal`;
    case 'room-lifecycle':
      return `room:${point.room.id}:${point.stage}`;
    case 'interaction-rule':
      return `interaction:${point.interaction.id}:rule:${point.ruleId}`;
    case 'verb-default':
      return `verb:${point.verb.id}:default`;
    case 'resident-layout':
      return `layout:${point.layout.id}:resident`;
    case 'undefined-interaction':
      return 'interaction:undefined';
  }
}

function predictionDependencyLabel(dependency: { kind: string; [key: string]: unknown }) {
  const reference = Object.values(dependency).find(
    (value) => typeof value === 'object' && value !== null && 'id' in value,
  ) as { id?: string } | undefined;
  return reference?.id ? `${dependency.kind}:${reference.id}` : dependency.kind;
}

function authoringPredictionPoint(point: FlowPredictionToolingPoint): PrefetchHintPoint {
  switch (point.kind) {
    case 'scene-entry':
    case 'scene-terminal':
      return {
        kind: point.kind,
        scene: { $ref: { collection: 'scenes', id: point.scene.id } },
      };
    case 'scene-step':
      return {
        kind: 'scene-step',
        scene: { $ref: { collection: 'scenes', id: point.scene.id } },
        stepId: point.stepId,
      };
    case 'dialogue-entry':
    case 'dialogue-terminal':
      return {
        kind: point.kind,
        dialogue: { $ref: { collection: 'dialogues', id: point.dialogue.id } },
      };
    case 'dialogue-position':
      return {
        kind: 'dialogue-position',
        dialogue: { $ref: { collection: 'dialogues', id: point.dialogue.id } },
        blockId: point.blockId,
        ...(point.segmentId ? { segmentId: point.segmentId } : {}),
        ...(point.edgeId ? { edgeId: point.edgeId } : {}),
        stage: point.stage,
        cursor: point.cursor,
      };
    case 'room-lifecycle':
      return {
        kind: 'room-lifecycle',
        room: { $ref: { collection: 'rooms', id: point.room.id } },
        stage: point.stage,
      };
    case 'interaction-rule':
      return {
        kind: 'interaction-rule',
        interaction: { $ref: { collection: 'interactions', id: point.interaction.id } },
        ruleId: point.ruleId,
      };
    case 'verb-default':
      return { kind: 'verb-default', verb: { $ref: { collection: 'verbs', id: point.verb.id } } };
    case 'resident-layout':
      return {
        kind: 'resident-layout',
        layout: { $ref: { collection: 'layouts', id: point.layout.id } },
      };
    case 'undefined-interaction':
      return { kind: 'undefined-interaction' };
  }
}

function authoringPredictionPointLabel(point: PrefetchHintPoint) {
  switch (point.kind) {
    case 'scene-entry':
      return `scene:${point.scene.$ref.id}:entry`;
    case 'scene-step':
      return `scene:${point.scene.$ref.id}:step:${point.stepId}`;
    case 'scene-terminal':
      return `scene:${point.scene.$ref.id}:terminal`;
    case 'dialogue-entry':
      return `dialogue:${point.dialogue.$ref.id}:entry`;
    case 'dialogue-position':
      return `dialogue:${point.dialogue.$ref.id}:${point.blockId}:${point.stage}:${point.cursor}`;
    case 'dialogue-terminal':
      return `dialogue:${point.dialogue.$ref.id}:terminal`;
    case 'room-lifecycle':
      return `room:${point.room.$ref.id}:${point.stage}`;
    case 'interaction-rule':
      return `interaction:${point.interaction.$ref.id}:rule:${point.ruleId}`;
    case 'verb-default':
      return `verb:${point.verb.$ref.id}:default`;
    case 'resident-layout':
      return `layout:${point.layout.$ref.id}:resident`;
    case 'undefined-interaction':
      return 'interaction:undefined';
  }
}

type PrefetchTargetKind = PrefetchHintTarget['kind'];

function prefetchTarget(kind: PrefetchTargetKind, id: string): PrefetchHintTarget {
  switch (kind) {
    case 'asset':
      return { kind, asset: { $ref: { collection: 'assets', id } } };
    case 'scene':
      return { kind, scene: { $ref: { collection: 'scenes', id } } };
    case 'dialogue':
      return { kind, dialogue: { $ref: { collection: 'dialogues', id } } };
    case 'room':
      return { kind, room: { $ref: { collection: 'rooms', id } } };
    case 'layout':
      return { kind, layout: { $ref: { collection: 'layouts', id } } };
  }
}

function prefetchTargetId(target: PrefetchHintTarget) {
  switch (target.kind) {
    case 'asset':
      return target.asset.$ref.id;
    case 'scene':
      return target.scene.$ref.id;
    case 'dialogue':
      return target.dialogue.$ref.id;
    case 'room':
      return target.room.$ref.id;
    case 'layout':
      return target.layout.$ref.id;
  }
}

function compiledHintTargetLabel(target: { kind: string; [key: string]: unknown }) {
  const reference = Object.values(target).find(
    (value) => typeof value === 'object' && value !== null && 'id' in value,
  ) as { id?: string } | undefined;
  return reference?.id ? `${target.kind}:${reference.id}` : target.kind;
}

function PredictionView() {
  const { t, i18n } = useTranslation('workspace');
  const format = createEditorFormatters(i18n.language);
  const projectDocument = useProjectStore((state) => state.document);
  const changes = useAssetProfilerStore((state) => state.changes);
  const status = useAssetProfilerStore((state) => state.status);
  const executeCommand = useCommandStore((state) => state.executeCommand);
  const project = isAuthoringProject(projectDocument) ? projectDocument : null;
  const [targetKind, setTargetKind] = useState<PrefetchTargetKind>('scene');
  const [targetId, setTargetId] = useState('');
  const [draftAttachment, setDraftAttachment] = useState<PrefetchHintAttachment | null>(null);
  const [roomId, setRoomId] = useState('');
  const [roomScope, setRoomScope] = useState<'entry-path' | 'resident'>('entry-path');
  const staticProjection = useMemo(() => {
    if (!project) return null;
    const compiled = compileAuthoringProject(project);
    if (!compiled.ok) return null;
    return projectFlowPredictionIndexForTooling(compiled.project.flowPrediction);
  }, [project]);
  const liveGeneration = useMemo(() => {
    for (let index = changes.length - 1; index >= 0; --index) {
      const change = changes[index];
      if (change.kind === 'prefetch-generation-upsert') return change.generation;
    }
    return null;
  }, [changes]);
  const targetRecords = useMemo(() => {
    if (!project) return [];
    const records =
      targetKind === 'asset'
        ? project.assets
        : targetKind === 'scene'
          ? project.scenes
          : targetKind === 'dialogue'
            ? project.dialogues
            : targetKind === 'room'
              ? project.rooms
              : project.layouts;
    return Object.values(records)
      .map((record) => ({ id: record.id, label: record.label }))
      .sort((left, right) => left.label.localeCompare(right.label));
  }, [project, targetKind]);
  const rooms = useMemo(
    () =>
      project
        ? Object.values(project.rooms)
            .map((record) => ({ id: record.id, label: record.label }))
            .sort((left, right) => left.label.localeCompare(right.label))
        : [],
    [project],
  );

  const addHint = () => {
    if (!project || !targetId || !draftAttachment) return;
    let ordinal = 1;
    let id = 'prefetch-hint';
    while (project.prefetchHints[id]) {
      ordinal += 1;
      id = `prefetch-hint-${ordinal}`;
    }
    executeCommand({
      type: 'project.addAtPath',
      label: t('assetProfiler.prediction.addHint'),
      payload: {
        path: `/prefetchHints/${id}`,
        value: { id, target: prefetchTarget(targetKind, targetId), attachment: draftAttachment },
      },
      originSaveUnitId: PROJECT_SETTINGS_SAVE_UNIT_ID,
      persistencePolicy: 'manual-save',
    });
    setDraftAttachment(null);
  };

  const removeHint = (id: string) => {
    executeCommand({
      type: 'project.removeAtPath',
      label: t('assetProfiler.prediction.removeHint'),
      payload: { path: `/prefetchHints/${id}` },
      originSaveUnitId: PROJECT_SETTINGS_SAVE_UNIT_ID,
      persistencePolicy: 'manual-save',
    });
  };

  return (
    <div className="space-y-4 p-3">
      <section>
        <div className="mb-2 flex items-center justify-between gap-2">
          <h3 className="font-medium">{t('assetProfiler.prediction.liveTitle')}</h3>
          <span className="rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground">
            {t('assetProfiler.prediction.derivedReadOnly')}
          </span>
        </div>
        {liveGeneration ? (
          <div className="overflow-x-auto rounded border">
            <table className="w-full min-w-[980px] text-left">
              <thead className="bg-muted/40 text-[10px] text-muted-foreground">
                <tr>
                  <th className="px-2 py-1.5 font-medium">
                    {t('assetProfiler.prediction.columns.prediction')}
                  </th>
                  <th className="px-2 py-1.5 font-medium">
                    {t('assetProfiler.prediction.columns.distance')}
                  </th>
                  <th className="px-2 py-1.5 font-medium">
                    {t('assetProfiler.prediction.columns.order')}
                  </th>
                  <th className="px-2 py-1.5 font-medium">
                    {t('assetProfiler.prediction.columns.priority')}
                  </th>
                  <th className="px-2 py-1.5 font-medium">
                    {t('assetProfiler.prediction.columns.cost')}
                  </th>
                  <th className="px-2 py-1.5 font-medium">
                    {t('assetProfiler.prediction.columns.asset')}
                  </th>
                  <th className="px-2 py-1.5 font-medium">
                    {t('assetProfiler.prediction.columns.reason')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {liveGeneration.predictionPlan.map((entry, index) => (
                  <tr key={`${entry.cacheKey.stableIdentity}:${index}`} className="border-t">
                    <td className="px-2 py-1.5">{entry.prediction}</td>
                    <td className="px-2 py-1.5 tabular-nums">
                      {entry.executionDistance.toString()}
                    </td>
                    <td className="px-2 py-1.5 tabular-nums">{entry.executionOrder.toString()}</td>
                    <td className="px-2 py-1.5 tabular-nums">
                      {entry.dependencyPriority.toString()}
                    </td>
                    <td className="px-2 py-1.5 text-[10px] text-muted-foreground">
                      {t('assetProfiler.prediction.costSummary', {
                        cpu: format.fileSize(BigInt(entry.estimatedCost.preparedCpuBytes)),
                        gpu: format.fileSize(BigInt(entry.estimatedCost.gpuBytes)),
                        audio: format.fileSize(BigInt(entry.estimatedCost.audioBytes)),
                        kind: entry.costEstimate,
                      })}
                    </td>
                    <td className="px-2 py-1.5 font-mono text-[10px]">
                      {entry.cacheKey.stableIdentity}
                    </td>
                    <td className="px-2 py-1.5 text-[10px] text-muted-foreground">
                      {entry.provenance
                        .map((path) =>
                          [
                            path.supplementalHintId
                              ? `authored:${path.supplementalHintId}`
                              : 'automatic',
                            path.root,
                            path.room ? `room:${path.room}` : null,
                            ...path.reasonChain,
                          ]
                            .filter(Boolean)
                            .join(' → '),
                        )
                        .join(' · ') || t('assetProfiler.prediction.runtimeRoot')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="rounded border p-3 text-muted-foreground">
            {status === 'ready'
              ? t('assetProfiler.prediction.noLiveGeneration')
              : t('assetProfiler.prediction.openPlayForLive')}
          </div>
        )}
      </section>

      <section>
        <div className="mb-2 flex items-center justify-between gap-2">
          <h3 className="font-medium">{t('assetProfiler.prediction.authoredTitle')}</h3>
          <span className="text-[10px] text-muted-foreground">
            {t('assetProfiler.prediction.authoredPersisted')}
          </span>
        </div>
        {project ? (
          <div className="space-y-2">
            {Object.values(project.prefetchHints).map((hint) => (
              <div
                key={hint.id}
                className="flex items-center justify-between gap-2 rounded border p-2"
              >
                <div className="min-w-0">
                  <div className="truncate font-medium">
                    {hint.id} → {hint.target.kind}:{prefetchTargetId(hint.target)}
                  </div>
                  <div className="truncate text-[10px] text-muted-foreground">
                    {hint.attachment.kind === 'point'
                      ? authoringPredictionPointLabel(hint.attachment.point)
                      : `room:${hint.attachment.room.$ref.id}:${hint.attachment.scope}`}
                  </div>
                </div>
                <Button size="sm" variant="ghost" onClick={() => removeHint(hint.id)}>
                  {t('assetProfiler.prediction.removeHint')}
                </Button>
              </div>
            ))}

            <div className="space-y-2 rounded border p-2">
              <div className="grid gap-2 sm:grid-cols-2">
                <Select
                  value={targetKind}
                  onValueChange={(value) => {
                    setTargetKind(String(value) as PrefetchTargetKind);
                    setTargetId('');
                  }}
                >
                  <SelectTrigger aria-label={t('assetProfiler.prediction.targetType')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(['asset', 'scene', 'dialogue', 'room', 'layout'] as const).map((kind) => (
                      <SelectItem key={kind} value={kind}>
                        {kind}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value={targetId} onValueChange={(value) => setTargetId(String(value))}>
                  <SelectTrigger aria-label={t('assetProfiler.prediction.targetRecord')}>
                    <SelectValue placeholder={t('assetProfiler.prediction.selectTarget')} />
                  </SelectTrigger>
                  <SelectContent>
                    {targetRecords.map((record) => (
                      <SelectItem key={record.id} value={record.id}>
                        {record.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Select value={roomId} onValueChange={(value) => setRoomId(String(value))}>
                  <SelectTrigger
                    className="min-w-44"
                    aria-label={t('assetProfiler.prediction.room')}
                  >
                    <SelectValue placeholder={t('assetProfiler.prediction.selectRoom')} />
                  </SelectTrigger>
                  <SelectContent>
                    {rooms.map((room) => (
                      <SelectItem key={room.id} value={room.id}>
                        {room.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  value={roomScope}
                  onValueChange={(value) => setRoomScope(String(value) as typeof roomScope)}
                >
                  <SelectTrigger
                    className="min-w-36"
                    aria-label={t('assetProfiler.prediction.roomScope')}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="entry-path">
                      {t('assetProfiler.prediction.entryPath')}
                    </SelectItem>
                    <SelectItem value="resident">
                      {t('assetProfiler.prediction.whileInRoom')}
                    </SelectItem>
                  </SelectContent>
                </Select>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!roomId}
                  onClick={() =>
                    setDraftAttachment({
                      kind: 'room',
                      room: { $ref: { collection: 'rooms', id: roomId } },
                      scope: roomScope,
                    })
                  }
                >
                  {t('assetProfiler.prediction.useRoomScope')}
                </Button>
              </div>

              <div className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
                <span>
                  {draftAttachment
                    ? draftAttachment.kind === 'room'
                      ? `room:${draftAttachment.room.$ref.id}:${draftAttachment.scope}`
                      : authoringPredictionPointLabel(draftAttachment.point)
                    : t('assetProfiler.prediction.chooseAttachment')}
                </span>
                <Button size="sm" disabled={!targetId || !draftAttachment} onClick={addHint}>
                  {t('assetProfiler.prediction.addHint')}
                </Button>
              </div>
            </div>
          </div>
        ) : null}
      </section>

      <section>
        <div className="mb-1 flex items-center justify-between gap-2">
          <h3 className="font-medium">{t('assetProfiler.prediction.staticTitle')}</h3>
          <span className="text-[10px] text-muted-foreground">
            {t('assetProfiler.prediction.derivedReadOnly')}
          </span>
        </div>
        <p className="mb-2 text-[10px] text-muted-foreground">
          {t('assetProfiler.prediction.staticNotice')}
        </p>
        {staticProjection ? (
          <div className="space-y-1">
            {staticProjection.slices.map((slice) => {
              const hasAlternatives = slice.edges.some((edge) => edge.kind === 'alternative');
              const state = slice.opaque
                ? t('assetProfiler.prediction.states.opaque')
                : hasAlternatives
                  ? t('assetProfiler.prediction.states.alternatives')
                  : t('assetProfiler.prediction.states.deterministic');
              return (
                <div
                  key={slice.index}
                  className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 rounded border p-2"
                >
                  <div className="min-w-0">
                    <div className="truncate font-medium">{predictionPointLabel(slice.point)}</div>
                    <div className="truncate text-[10px] text-muted-foreground">
                      {slice.dependencies.length
                        ? slice.dependencies.map(predictionDependencyLabel).join(', ')
                        : t('assetProfiler.prediction.noDependencies')}
                    </div>
                    <div className="truncate font-mono text-[10px] text-muted-foreground">
                      {slice.edges.length
                        ? slice.edges
                            .map((edge) => `${edge.kind}:${edge.reason}→#${edge.target}`)
                            .join(' · ')
                        : t('assetProfiler.prediction.noEdges')}
                    </div>
                  </div>
                  <div className="text-right text-[10px] text-muted-foreground">
                    <div>{state}</div>
                    <div>{slice.frontier}</div>
                    {(staticProjection.supplementalHints ?? [])
                      .filter(
                        (hint) =>
                          hint.attachment.kind === 'point' && hint.attachment.slice === slice.index,
                      )
                      .map((hint) => (
                        <div key={hint.id} className="font-mono">
                          {hint.id}→{compiledHintTargetLabel(hint.target)}
                        </div>
                      ))}
                    <Button
                      className="mt-1 h-6 px-2 text-[10px]"
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        setDraftAttachment({
                          kind: 'point',
                          point: authoringPredictionPoint(slice.point),
                        })
                      }
                    >
                      {t('assetProfiler.prediction.hintHere')}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="rounded border p-3 text-muted-foreground">
            {t('assetProfiler.prediction.noStaticIndex')}
          </div>
        )}
      </section>
    </div>
  );
}

function IssuesView() {
  const { t, i18n } = useTranslation('workspace');
  const format = createEditorFormatters(i18n.language);
  const changes = useAssetProfilerStore((state) => state.changes);
  const assetsByKey = useAssetProfilerStore((state) => state.assetsByKey);
  const query = useAssetProfilerStore((state) => state.issueQuery);
  const type = useAssetProfilerStore((state) => state.issueType);
  const expanded = useAssetProfilerStore((state) => state.expandedIssueIds);
  const setQuery = useAssetProfilerStore((state) => state.setIssueQuery);
  const setType = useAssetProfilerStore((state) => state.setIssueType);
  const toggleExpanded = useAssetProfilerStore((state) => state.toggleExpandedIssue);
  const document = useProjectStore((state) => state.document);
  const project = isAuthoringProject(document) ? document : null;
  const issues = useMemo(
    () => deriveAssetProfilerIssues(changes, assetsByKey),
    [assetsByKey, changes],
  );
  const filtered = issues.filter((issue) => {
    if (type !== 'all' && issue.type !== type) return false;
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return true;
    return [
      issue.displayIdentity,
      issue.stableIdentity,
      issue.diagnosticCode,
      issue.phase,
      ...issue.children.flatMap((child) => [
        child.displayIdentity,
        child.stableIdentity,
        child.diagnosticCode,
      ]),
    ]
      .filter(Boolean)
      .some((value) => String(value).toLocaleLowerCase().includes(needle));
  });
  const issueTypes: Array<'all' | AssetProfilerIssueType> = [
    'all',
    'load-failed',
    'asset-wait',
    'prefetch-blocked',
    'reloaded',
  ];
  return (
    <div className="p-3">
      <div className="mb-3 flex flex-wrap gap-2">
        <Input
          className="h-8 min-w-48 flex-1"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('assetProfiler.issues.search')}
          aria-label={t('assetProfiler.issues.search')}
        />
        <Select value={type} onValueChange={(value) => setType(String(value))}>
          <SelectTrigger className="h-8 min-w-48" aria-label={t('assetProfiler.issues.filter')}>
            <SelectValue>{t(`assetProfiler.issues.types.${type}`)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {issueTypes.map((value) => (
              <SelectItem key={value} value={value}>
                {t(`assetProfiler.issues.types.${value}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {filtered.length === 0 ? (
        <EmptyState message={t('assetProfiler.empty.issues')} />
      ) : (
        <div className="space-y-2">
          {filtered.map((issue) => {
            const isExpanded = expanded.includes(issue.id);
            const path = issue.diagnostic?.jsonPointer || issue.diagnostic?.sourcePath || '';
            const diagnosticTarget =
              project && path.startsWith('/')
                ? resolveProjectDiagnosticTarget(project, path)
                : null;
            const target =
              diagnosticTarget ??
              (project
                ? resolveAssetProfilerIdentityTarget(
                    project,
                    issue.assetType,
                    issue.displayIdentity,
                  )
                : null);
            const targetLabel = diagnosticTarget
              ? t('assetProfiler.issues.openDiagnostic')
              : t('assetProfiler.issues.openAsset', {
                  asset: issue.displayIdentity ?? issue.stableIdentity ?? '',
                });
            return (
              <div key={issue.id} className="rounded border">
                <div className="flex items-start gap-2 p-2">
                  <button
                    type="button"
                    className="mt-0.5"
                    onClick={() => toggleExpanded(issue.id)}
                    aria-expanded={isExpanded}
                    aria-label={t(
                      isExpanded
                        ? 'assetProfiler.issues.collapseIssue'
                        : 'assetProfiler.issues.expandIssue',
                    )}
                  >
                    {isExpanded ? (
                      <ChevronDown className="size-4" />
                    ) : (
                      <ChevronRight className="size-4" />
                    )}
                  </button>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={
                          issue.severity === 'error'
                            ? 'font-medium text-destructive'
                            : 'font-medium'
                        }
                      >
                        {t(`assetProfiler.issues.types.${issue.type}`)}
                      </span>
                      {issue.displayIdentity ? (
                        <span className="truncate font-mono text-[10px] text-muted-foreground">
                          {issue.displayIdentity}
                        </span>
                      ) : null}
                    </div>
                    <div className="text-[10px] text-muted-foreground">
                      {issue.durationNs !== null ? format.durationNs(issue.durationNs) : null}
                      {issue.phase ? ` · ${t(`assetProfiler.issues.phases.${issue.phase}`)}` : null}
                      {issue.children.length
                        ? ` · ${t('assetProfiler.issues.assetCount', { count: format.number(BigInt(issue.children.length)) })}`
                        : null}
                    </div>
                  </div>
                  {target ? (
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      onClick={() => navigateToWorkbenchTarget(target)}
                      aria-label={targetLabel}
                    >
                      <ExternalLink className="size-3" />
                    </Button>
                  ) : null}
                </div>
                {isExpanded ? (
                  <div className="space-y-2 border-t p-2">
                    {issue.diagnosticCode ? (
                      <div className="font-mono text-[10px]">{issue.diagnosticCode}</div>
                    ) : null}
                    {issue.children.map((child) => {
                      const childTarget = project
                        ? resolveAssetProfilerIdentityTarget(
                            project,
                            child.assetType,
                            child.displayIdentity,
                          )
                        : null;
                      return (
                        <div key={child.id} className="rounded bg-muted/35 p-2">
                          <div className="flex items-start justify-between gap-2">
                            <span className="min-w-0 truncate">
                              {child.displayIdentity}
                              {child.assetType
                                ? ` · ${t(`assetProfiler.assetTypes.${child.assetType}`)}`
                                : ''}
                            </span>
                            <div className="flex shrink-0 items-center gap-1">
                              <span>{t(`assetProfiler.issues.childResults.${child.result}`)}</span>
                              {childTarget ? (
                                <Button
                                  size="icon-sm"
                                  variant="ghost"
                                  onClick={() => navigateToWorkbenchTarget(childTarget)}
                                  aria-label={t('assetProfiler.issues.openAsset', {
                                    asset: child.displayIdentity,
                                  })}
                                >
                                  <ExternalLink className="size-3" />
                                </Button>
                              ) : null}
                            </div>
                          </div>
                          {child.result === 'load-failed' && child.prefetchClassification ? (
                            <div className="text-[10px] text-muted-foreground">
                              {t('assetProfiler.issues.prefetchDetail', {
                                result: t(
                                  `assetProfiler.issues.childResults.${child.prefetchClassification}`,
                                ),
                              })}
                            </div>
                          ) : null}
                          {child.diagnosticCode ? (
                            <div className="font-mono text-[10px] text-muted-foreground">
                              {child.diagnosticCode}
                            </div>
                          ) : null}
                          {child.stageDetails.map((detail, index) => (
                            <div
                              key={`${detail.kind}-${index}`}
                              className="text-[10px] text-muted-foreground"
                            >
                              {t(`assetProfiler.issues.stages.${detail.kind}`)} ·{' '}
                              {format.durationNs(detail.durationNs)}
                              {detail.failed ? ` · ${t('assetProfiler.issues.failed')}` : ''}
                              {detail.diagnosticCode ? ` · ${detail.diagnosticCode}` : ''}
                            </div>
                          ))}
                        </div>
                      );
                    })}
                    {issue.stageDetails.map((detail, index) => (
                      <div
                        key={`${detail.kind}-${index}`}
                        className="text-[10px] text-muted-foreground"
                      >
                        {t(`assetProfiler.issues.stages.${detail.kind}`)} ·{' '}
                        {format.durationNs(detail.durationNs)}
                        {detail.failed ? ` · ${t('assetProfiler.issues.failed')}` : ''}
                        {detail.diagnosticCode ? ` · ${detail.diagnosticCode}` : ''}
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function AssetsView() {
  const { t, i18n } = useTranslation('workspace');
  const format = createEditorFormatters(i18n.language);
  const entries = useAssetProfilerStore((state) => state.assetsByKey);
  const query = useAssetProfilerStore((state) => state.assetQuery);
  const state = useAssetProfilerStore((store) => store.assetState);
  const type = useAssetProfilerStore((store) => store.assetType);
  const sort = useAssetProfilerStore((store) => store.assetSort);
  const expanded = useAssetProfilerStore((store) => store.expandedAssetIds);
  const setQuery = useAssetProfilerStore((store) => store.setAssetQuery);
  const setState = useAssetProfilerStore((store) => store.setAssetState);
  const setType = useAssetProfilerStore((store) => store.setAssetType);
  const setSort = useAssetProfilerStore((store) => store.setAssetSort);
  const toggleExpanded = useAssetProfilerStore((store) => store.toggleExpandedAsset);
  const document = useProjectStore((store) => store.document);
  const project = isAuthoringProject(document) ? document : null;
  const filtered = useMemo(
    () =>
      filterAndSortAssetProfilerEntries(
        entries.values(),
        query,
        state as AssetProfilerAssetStateFilter,
        type as AssetProfilerAssetTypeFilter,
        sort as AssetProfilerAssetSort,
      ),
    [entries, query, sort, state, type],
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 36,
    getItemKey: (index) => assetProfilerEntryKey(filtered[index]!),
    overscan: 8,
    initialRect: { width: 920, height: 400 },
  });
  const virtualRows = rowVirtualizer.getVirtualItems();
  const paddingTop = virtualRows.length > 0 ? virtualRows[0]!.start : 0;
  const paddingBottom =
    virtualRows.length > 0
      ? rowVirtualizer.getTotalSize() - virtualRows[virtualRows.length - 1]!.end
      : 0;
  const stateFilters: AssetProfilerAssetStateFilter[] = [
    'all',
    'in-use',
    'prefetched',
    'cached',
    'loading',
    'finishing',
    'blocked',
    'failed',
    'reloaded',
  ];
  const typeFilters: AssetProfilerAssetTypeFilter[] = [
    'all',
    'image',
    'audio',
    'font',
    'shader',
    'material',
  ];
  const sorts: AssetProfilerAssetSort[] = [
    'default',
    'identity',
    'state',
    'asset-ram',
    'loading-memory',
    'asset-gpu',
    'reload-count',
  ];

  return (
    <div className="flex h-full min-h-0 flex-col p-3">
      <div className="mb-3 flex shrink-0 flex-wrap gap-2">
        <Input
          className="h-8 min-w-48 flex-1"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('assetProfiler.assets.search')}
          aria-label={t('assetProfiler.assets.search')}
        />
        <Select value={state} onValueChange={(value) => setState(String(value))}>
          <SelectTrigger
            className="h-8 min-w-44"
            aria-label={t('assetProfiler.assets.stateFilter')}
          >
            <SelectValue>{t(`assetProfiler.assets.states.${state}`)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {stateFilters.map((value) => (
              <SelectItem key={value} value={value}>
                {t(`assetProfiler.assets.states.${value}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={type} onValueChange={(value) => setType(String(value))}>
          <SelectTrigger className="h-8 min-w-36" aria-label={t('assetProfiler.assets.typeFilter')}>
            <SelectValue>
              {type === 'all'
                ? t('assetProfiler.assets.types.all')
                : t(`assetProfiler.assetTypes.${type}`)}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {typeFilters.map((value) => (
              <SelectItem key={value} value={value}>
                {value === 'all'
                  ? t('assetProfiler.assets.types.all')
                  : t(`assetProfiler.assetTypes.${value}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={sort} onValueChange={(value) => setSort(String(value))}>
          <SelectTrigger className="h-8 min-w-44" aria-label={t('assetProfiler.assets.sortLabel')}>
            <SelectValue>{t(`assetProfiler.assets.sorts.${sort}`)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {sorts.map((value) => (
              <SelectItem key={value} value={value}>
                {t(`assetProfiler.assets.sorts.${value}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {filtered.length === 0 ? (
        <EmptyState message={t('assetProfiler.empty.assets')} />
      ) : (
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto rounded border">
          <table className="w-full min-w-[920px] text-left">
            <thead className="sticky top-0 z-10 bg-muted text-[10px] text-muted-foreground">
              <tr>
                <th className="w-8 px-2 py-1.5" />
                <th className="px-2 py-1.5 font-medium">
                  {t('assetProfiler.assets.columns.identity')}
                </th>
                <th className="px-2 py-1.5 font-medium">
                  {t('assetProfiler.assets.columns.type')}
                </th>
                <th className="px-2 py-1.5 font-medium">
                  {t('assetProfiler.assets.columns.state')}
                </th>
                <th className="px-2 py-1.5 font-medium">
                  {t('assetProfiler.assets.columns.assetRam')}
                </th>
                <th className="px-2 py-1.5 font-medium">
                  {t('assetProfiler.assets.columns.loading')}
                </th>
                <th className="px-2 py-1.5 font-medium">{t('assetProfiler.assets.columns.gpu')}</th>
                <th className="px-2 py-1.5 font-medium">
                  {t('assetProfiler.assets.columns.reason')}
                </th>
                <th className="w-8 px-2 py-1.5" />
              </tr>
            </thead>
            <tbody>
              {paddingTop > 0 ? (
                <tr aria-hidden="true">
                  <td colSpan={9} style={{ height: paddingTop }} />
                </tr>
              ) : null}
              {virtualRows.map((virtualRow) => {
                const entry = filtered[virtualRow.index]!;
                const id = assetProfilerEntryKey(entry);
                const isExpanded = expanded.includes(id);
                const estimated = assetProfilerEntryUsesEstimate(entry);
                const target = project
                  ? resolveAssetProfilerIdentityTarget(
                      project,
                      entry.assetType,
                      entry.displayIdentity,
                    )
                  : null;
                return (
                  <tr
                    key={virtualRow.key}
                    ref={rowVirtualizer.measureElement}
                    data-index={virtualRow.index}
                    className="border-t align-top"
                  >
                    <td className="px-2 py-1.5">
                      <button
                        type="button"
                        onClick={() => toggleExpanded(id)}
                        aria-expanded={isExpanded}
                        aria-label={t(
                          isExpanded
                            ? 'assetProfiler.assets.collapseDetails'
                            : 'assetProfiler.assets.expandDetails',
                        )}
                      >
                        {isExpanded ? (
                          <ChevronDown className="size-4" />
                        ) : (
                          <ChevronRight className="size-4" />
                        )}
                      </button>
                    </td>
                    <td className="max-w-72 px-2 py-1.5">
                      <div className="truncate">{entry.displayIdentity}</div>
                      {entry.reloadCount > 0n ? (
                        <div className="text-[10px] text-muted-foreground">
                          {t('assetProfiler.assets.reloaded', {
                            count: format.number(entry.reloadCount),
                          })}
                        </div>
                      ) : null}
                      {isExpanded ? (
                        <div className="mt-2 space-y-1 font-mono text-[10px] text-muted-foreground">
                          <div>{entry.cacheKey.stableIdentity}</div>
                          <div>
                            {t('assetProfiler.assets.sourceGeneration', {
                              value: format.number(entry.cacheKey.sourceGeneration),
                            })}
                          </div>
                          <div>
                            {t('assetProfiler.assets.origin', {
                              value: t(`assetProfiler.assets.origins.${entry.requestOrigin}`),
                            })}
                          </div>
                          <div>
                            {t('assetProfiler.assets.claimed', {
                              value: entry.completedPrefetchClaimed
                                ? t('common:booleans.yes')
                                : t('common:booleans.no'),
                            })}
                          </div>
                          <div>
                            {t('assetProfiler.assets.removable', {
                              value: entry.removable
                                ? t('common:booleans.yes')
                                : t('common:booleans.no'),
                            })}
                          </div>
                          {entry.diagnostics.map((diagnostic, index) => (
                            <div key={`${diagnostic.code}-${index}`} className="text-destructive">
                              {diagnostic.code}
                              {diagnostic.message ? ` · ${diagnostic.message}` : ''}
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </td>
                    <td className="px-2 py-1.5">
                      {t(`assetProfiler.assetTypes.${entry.assetType}`)}
                    </td>
                    <td className="px-2 py-1.5">
                      {t(`assetProfiler.assets.states.${entry.state}`)}
                    </td>
                    <td className="px-2 py-1.5 tabular-nums">
                      {format.fileSize(assetProfilerAssetRam(entry))}
                      {estimated ? ` ${t('assetProfiler.assets.estimated')}` : ''}
                    </td>
                    <td className="px-2 py-1.5 tabular-nums">
                      {format.fileSize(entry.loadingMemoryBytes)}
                    </td>
                    <td className="px-2 py-1.5 tabular-nums">
                      {format.fileSize(assetProfilerAssetGpu(entry))}
                      {estimated ? ` ${t('assetProfiler.assets.estimated')}` : ''}
                    </td>
                    <td className="px-2 py-1.5">
                      {t(`assetProfiler.assets.reasons.${entry.retentionReason}`)}
                    </td>
                    <td className="px-2 py-1.5">
                      {target ? (
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          onClick={() => navigateToWorkbenchTarget(target)}
                          aria-label={t('assetProfiler.assets.openAsset', {
                            asset: entry.displayIdentity,
                          })}
                        >
                          <ExternalLink className="size-3" />
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
              {paddingBottom > 0 ? (
                <tr aria-hidden="true">
                  <td colSpan={9} style={{ height: paddingBottom }} />
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function AssetPerformancePanel() {
  const { t, i18n } = useTranslation('workspace');
  const format = createEditorFormatters(i18n.language);
  const openTab = useWorkbenchStore((state) => state.openTab);
  const status = useAssetProfilerStore((state) => state.status);
  const payload = useAssetProfilerStore((state) => state.payload);
  const error = useAssetProfilerStore((state) => state.error);
  const historyGapNotice = useAssetProfilerStore((state) => state.historyGapNotice);
  const simulationPolicy = useAssetProfilerStore((state) => state.simulationPolicy);
  const view = useAssetProfilerStore((state) => state.selectedView);
  const setView = useAssetProfilerStore((state) => state.setSelectedView);

  const stateMessage =
    status === 'disconnected'
      ? t('assetProfiler.states.disconnected')
      : status === 'unsupported'
        ? t('assetProfiler.states.unsupported')
        : status === 'loading'
          ? t('assetProfiler.states.loading')
          : status === 'error'
            ? (error ?? t('assetProfiler.states.error'))
            : null;

  const memory = payload?.memory;
  const outcomes = payload?.outcomes;
  const current = memory?.current;
  const peak = memory?.peak;
  const budget = memory?.policy?.budget as BigMemory | undefined;
  const coverageDenominator = outcomes
    ? outcomes.readyBeforeUse + outcomes.loadedTooLate + outcomes.notPrefetched
    : 0n;

  const usage = (value: bigint, limit: bigint) => {
    const percent = format.percentRatio(value, limit);
    return limit === 0n
      ? '—'
      : `${format.fileSize(value)} / ${format.fileSize(limit)}${percent ? ` · ${percent}` : ''}`;
  };

  return (
    <TooltipProvider>
      <div className="flex h-full min-h-0 flex-col text-xs">
        <div className="flex h-9 shrink-0 items-center gap-1 border-b px-2">
          {(['overview', 'prediction', 'issues', 'assets'] as AssetProfilerViewId[]).map((id) => (
            <button
              key={id}
              type="button"
              className={`rounded px-2 py-1 ${view === id ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-accent'}`}
              onClick={() => setView(id)}
            >
              {t(`assetProfiler.tabs.${id}`)}
            </button>
          ))}
          {stateMessage && payload ? (
            <span className="ml-auto text-[10px] text-muted-foreground">{stateMessage}</span>
          ) : null}
        </div>
        {historyGapNotice ? (
          <div className="shrink-0 border-b bg-muted/40 px-3 py-1.5 text-[10px] text-muted-foreground">
            {t('assetProfiler.states.historyGap')}
          </div>
        ) : null}
        <div
          className={`min-h-0 flex-1 ${view === 'assets' ? 'overflow-hidden' : 'overflow-auto'}`}
        >
          {view === 'prediction' ? (
            <PredictionView />
          ) : !payload ? (
            <EmptyState
              message={stateMessage ?? t('assetProfiler.states.loading')}
              actionLabel={
                status === 'disconnected' ? t('assetProfiler.actions.openPlay') : undefined
              }
              onAction={
                status === 'disconnected' ? () => openTab(buildFullGamePreviewTab()) : undefined
              }
            />
          ) : view === 'overview' && current && peak && outcomes ? (
            <div>
              {simulationPolicy ? (
                <div className="border-b bg-muted/20 px-3 py-2 text-[11px]">
                  <span className="text-muted-foreground">
                    {t('assetProfiler.simulation.label')}:{' '}
                  </span>
                  <span className="font-medium">
                    {t(`assetProfiler.simulation.targets.${simulationPolicy.target}`)} ·{' '}
                    {simulationPolicy.label}
                  </span>
                  <span className="ml-2 text-muted-foreground">
                    {t('assetProfiler.simulation.peakEpoch')}
                  </span>
                </div>
              ) : null}
              <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6">
                <Metric
                  label={t('assetProfiler.metrics.assetRam')}
                  value={format.fileSize(current.assetRamBytes)}
                  secondary={t('assetProfiler.peak', {
                    value: format.fileSize(peak.assetRamBytes),
                  })}
                  tooltip={t('assetProfiler.tooltips.assetRam')}
                />
                <Metric
                  label={t('assetProfiler.metrics.loadingMemory')}
                  value={format.fileSize(current.asset.temporaryBytes)}
                  secondary={t('assetProfiler.peak', {
                    value: format.fileSize(peak.asset.temporaryBytes),
                  })}
                  tooltip={t('assetProfiler.tooltips.loadingMemory')}
                />
                <Metric
                  label={t('assetProfiler.metrics.assetGpu')}
                  value={format.fileSize(current.asset.gpuBytes)}
                  secondary={t('assetProfiler.peak', {
                    value: format.fileSize(peak.asset.gpuBytes),
                  })}
                  tooltip={t('assetProfiler.tooltips.assetGpu')}
                />
                <Metric
                  label={t('assetProfiler.metrics.totalGpu')}
                  value={
                    current.totalGpuResourceBytes === null
                      ? '—'
                      : format.fileSize(current.totalGpuResourceBytes)
                  }
                  secondary={
                    peak.totalGpuResourceBytes === null
                      ? undefined
                      : t('assetProfiler.peak', {
                          value: format.fileSize(peak.totalGpuResourceBytes),
                        })
                  }
                  tooltip={t('assetProfiler.tooltips.totalGpu')}
                />
                <Metric
                  label={t('assetProfiler.metrics.readyBeforeUse')}
                  value={format.percentRatio(outcomes.readyBeforeUse, coverageDenominator) ?? '—'}
                  tooltip={t('assetProfiler.tooltips.readyBeforeUse')}
                />
                <Metric
                  label={t('assetProfiler.metrics.assetWaits')}
                  value={format.number(outcomes.assetWaitCount)}
                  secondary={format.durationNs(outcomes.assetWaitTimeNs)}
                  tooltip={t('assetProfiler.tooltips.assetWaits')}
                />
              </div>
              <section className="p-3">
                <h3 className="mb-2 font-medium">{t('assetProfiler.sections.budgets')}</h3>
                <div className="overflow-x-auto rounded border">
                  <table className="w-full min-w-[620px] text-left">
                    <thead className="bg-muted/40 text-[10px] text-muted-foreground">
                      <tr>
                        <th className="px-2 py-1.5 font-medium">
                          {t('assetProfiler.columns.domain')}
                        </th>
                        <th className="px-2 py-1.5 font-medium">
                          {t('assetProfiler.columns.current')}
                        </th>
                        <th className="px-2 py-1.5 font-medium">
                          {t('assetProfiler.columns.peak')}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {budget
                        ? (
                            [
                              ['sourceBytes', 'source'],
                              ['preparedCpuBytes', 'preparedCpu'],
                              ['audioBytes', 'audio'],
                              ['temporaryBytes', 'temporary'],
                              ['gpuBytes', 'gpu'],
                            ] as const
                          ).map(([key, label]) => (
                            <tr key={key} className="border-t">
                              <td className="px-2 py-1.5">{t(`assetProfiler.budgets.${label}`)}</td>
                              <td className="px-2 py-1.5 tabular-nums">
                                {usage(current.asset[key], budget[key])}
                              </td>
                              <td className="px-2 py-1.5 tabular-nums">
                                {usage(peak.asset[key], budget[key])}
                              </td>
                            </tr>
                          ))
                        : null}
                      {budget
                        ? (
                            [
                              ['sourceBytes', 'source'],
                              ['preparedCpuBytes', 'preparedCpu'],
                              ['audioBytes', 'audio'],
                              ['gpuBytes', 'gpu'],
                            ] as const
                          ).map(([key, label]) => {
                            const allowance =
                              (budget[key] *
                                BigInt(memory.policy.budget.prefetchAllowancePercent)) /
                              100n;
                            return (
                              <tr key={`prefetch-${key}`} className="border-t">
                                <td className="px-2 py-1.5">
                                  {t('assetProfiler.budgets.prefetchAllowance', {
                                    domain: t(`assetProfiler.budgets.${label}`),
                                  })}
                                </td>
                                <td className="px-2 py-1.5 tabular-nums">
                                  {usage(current.warm[key], allowance)}
                                </td>
                                <td className="px-2 py-1.5 text-muted-foreground">—</td>
                              </tr>
                            );
                          })
                        : null}
                    </tbody>
                  </table>
                </div>
              </section>
              <section className="grid gap-4 px-3 pb-3 md:grid-cols-3">
                <div>
                  <h3 className="mb-2 font-medium">
                    {t('assetProfiler.sections.totalGpuDetails')}
                  </h3>
                  {(
                    [
                      ['ordinaryTextureBytes', 'ordinaryTextures'],
                      ['renderTargetBytes', 'renderTargets'],
                    ] as const
                  ).map(([key, label]) => (
                    <div key={key} className="grid grid-cols-[1fr_auto_auto] gap-3 border-b py-1">
                      <span>{t(`assetProfiler.gpuDetails.${label}`)}</span>
                      <span className="tabular-nums">
                        {current.rendererEstimate[key] === null
                          ? '—'
                          : format.fileSize(current.rendererEstimate[key])}
                      </span>
                      <span className="tabular-nums text-muted-foreground">
                        {peak.rendererEstimate[key] === null
                          ? '—'
                          : format.fileSize(peak.rendererEstimate[key])}
                      </span>
                    </div>
                  ))}
                </div>
                <div>
                  <h3 className="mb-2 font-medium">{t('assetProfiler.sections.assetStates')}</h3>
                  {Object.entries(memory.assetCounts).map(([key, value]) => (
                    <div key={key} className="flex justify-between border-b py-1">
                      <span>{t(`assetProfiler.assetStates.${key}`)}</span>
                      <span className="tabular-nums">{format.number(value as bigint)}</span>
                    </div>
                  ))}
                </div>
                <div>
                  <h3 className="mb-2 font-medium">
                    {t('assetProfiler.sections.prefetchOutcomes')}
                  </h3>
                  {(
                    [
                      'readyBeforeUse',
                      'loadedTooLate',
                      'notPrefetched',
                      'blockedByMemoryLimit',
                      'prefetchedButUnused',
                      'reloadedAfterRemoval',
                    ] as const
                  ).map((key) => (
                    <div key={key} className="flex justify-between border-b py-1">
                      <span>{t(`assetProfiler.outcomes.${key}`)}</span>
                      <span className="tabular-nums">{format.number(outcomes[key])}</span>
                    </div>
                  ))}
                </div>
              </section>
            </div>
          ) : view === 'issues' ? (
            <IssuesView />
          ) : view === 'assets' ? (
            <AssetsView />
          ) : null}
        </div>
      </div>
    </TooltipProvider>
  );
}
