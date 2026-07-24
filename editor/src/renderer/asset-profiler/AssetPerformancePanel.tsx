import { ChevronDown, ChevronRight, ExternalLink } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
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
import { isAuthoringProject } from '../../shared/project-schema/authoring-project';
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
  const stateFilters: AssetProfilerAssetStateFilter[] = [
    'all',
    'in-use',
    'prefetched',
    'cached',
    'loading',
    'finishing',
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
    <div className="p-3">
      <div className="mb-3 flex flex-wrap gap-2">
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
        <div className="overflow-x-auto rounded border">
          <table className="w-full min-w-[920px] text-left">
            <thead className="bg-muted/40 text-[10px] text-muted-foreground">
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
              {filtered.map((entry) => {
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
                  <tr key={id} className="border-t align-top">
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
          {(['overview', 'issues', 'assets'] as AssetProfilerViewId[]).map((id) => (
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
        <div className="min-h-0 flex-1 overflow-auto">
          {!payload ? (
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
