import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { createEditorFormatters } from '@/i18n/formatting';
import { buildFullGamePreviewTab } from '@/workbench/editor-registry';
import { useWorkbenchStore } from '@/workbench/workbench-store';
import { type AssetProfilerViewId, useAssetProfilerStore } from './asset-profiler-store';

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

export function AssetPerformancePanel() {
  const { t, i18n } = useTranslation('workspace');
  const format = createEditorFormatters(i18n.language);
  const openTab = useWorkbenchStore((state) => state.openTab);
  const status = useAssetProfilerStore((state) => state.status);
  const payload = useAssetProfilerStore((state) => state.payload);
  const assetCount = useAssetProfilerStore((state) => state.assetsByKey.size);
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
            <EmptyState message={t('assetProfiler.empty.issues')} />
          ) : view === 'assets' ? (
            <EmptyState
              message={
                assetCount === 0
                  ? t('assetProfiler.empty.assets')
                  : t('assetProfiler.assetsAvailable', {
                      count: format.number(BigInt(assetCount)),
                    })
              }
            />
          ) : null}
        </div>
      </div>
    </TooltipProvider>
  );
}
