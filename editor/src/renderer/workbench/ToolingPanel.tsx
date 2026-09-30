import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { useToolingActivityStore } from './tooling-activity-store';
import type { ToolingActivityLayer, ToolingActivityStatus } from '../../shared/tooling-activity';

export function ToolingPanel() {
  const { t } = useTranslation('workspace');
  const records = useToolingActivityStore((state) => state.records);
  const clear = useToolingActivityStore((state) => state.clear);
  const [layer, setLayer] = useState<'all' | ToolingActivityLayer>('all');
  const [status, setStatus] = useState<'all' | ToolingActivityStatus>('all');
  const [query, setQuery] = useState('');
  const [frozen, setFrozen] = useState(false);
  const [frozenRecords, setFrozenRecords] = useState(records);
  const [autoscroll, setAutoscroll] = useState(true);
  const listRef = useRef<HTMLDivElement | null>(null);
  const visibleRecords = frozen ? frozenRecords : records;
  const filteredRecords = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return visibleRecords.filter((record) => {
      if (layer !== 'all' && record.layer !== layer) return false;
      if (status !== 'all' && record.status !== status) return false;
      if (!needle) return true;
      return `${record.layer} ${record.operation} ${record.status} ${record.detail ?? ''}`
        .toLocaleLowerCase()
        .includes(needle);
    });
  }, [layer, query, status, visibleRecords]);

  useEffect(() => {
    if (!autoscroll || frozen || !listRef.current) return;
    listRef.current.scrollTop = 0;
  }, [autoscroll, filteredRecords, frozen]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b p-2">
        <select
          aria-label={t('bottomPanel.tooling.layerLabel')}
          className="h-7 rounded border bg-background px-2 text-xs"
          value={layer}
          onChange={(event) => setLayer(event.target.value as typeof layer)}
        >
          <option value="all">{t('bottomPanel.tooling.layers.all')}</option>
          <option value="ipc">{t('bottomPanel.tooling.layers.ipc')}</option>
          <option value="native">{t('bottomPanel.tooling.layers.native')}</option>
        </select>
        <select
          aria-label={t('bottomPanel.tooling.statusLabel')}
          className="h-7 rounded border bg-background px-2 text-xs"
          value={status}
          onChange={(event) => setStatus(event.target.value as typeof status)}
        >
          <option value="all">{t('bottomPanel.tooling.statuses.all')}</option>
          <option value="success">{t('bottomPanel.tooling.statuses.success')}</option>
          <option value="error">{t('bottomPanel.tooling.statuses.error')}</option>
        </select>
        <input
          aria-label={t('bottomPanel.tooling.textFilterLabel')}
          className="h-7 min-w-40 flex-1 rounded border bg-background px-2 text-xs"
          placeholder={t('bottomPanel.tooling.filterPlaceholder')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Button
          size="sm"
          variant={frozen ? 'secondary' : 'outline'}
          className="h-7"
          aria-pressed={frozen}
          onClick={() => {
            if (!frozen) setFrozenRecords(records);
            setFrozen((value) => !value);
          }}
        >
          {frozen ? t('bottomPanel.tooling.unfreeze') : t('bottomPanel.tooling.freeze')}
        </Button>
        <Button
          size="sm"
          variant={autoscroll ? 'secondary' : 'outline'}
          className="h-7"
          aria-pressed={autoscroll}
          onClick={() => setAutoscroll((value) => !value)}
        >
          {t('bottomPanel.tooling.autoscroll')}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7"
          onClick={() => {
            clear();
            setFrozenRecords([]);
          }}
        >
          {t('bottomPanel.tooling.clear')}
        </Button>
      </div>
      {frozen ? (
        <div className="shrink-0 border-b px-2 py-1 text-[11px] text-muted-foreground">
          {t('bottomPanel.tooling.frozen')}
        </div>
      ) : null}
      <div ref={listRef} className="min-h-0 flex-1 overflow-auto">
        {filteredRecords.length === 0 ? (
          <p className="px-3 py-2 text-xs text-muted-foreground">
            {records.length === 0
              ? t('bottomPanel.empty.tooling')
              : t('bottomPanel.tooling.noMatches')}
          </p>
        ) : null}
        {filteredRecords.map((record) => (
          <div
            key={`${record.layer}:${record.id}`}
            className="flex h-7 min-w-0 items-center gap-2 border-b px-2 text-[11px]"
            title={`${record.operation}${record.detail ? ` · ${record.detail}` : ''}`}
          >
            <span
              className={`shrink-0 font-medium ${
                record.status === 'error' ? 'text-destructive' : 'text-foreground'
              }`}
            >
              {t(`bottomPanel.tooling.statuses.${record.status}`)}
            </span>
            <span className="w-12 shrink-0 text-muted-foreground">
              {t(`bottomPanel.tooling.layers.${record.layer}`)}
            </span>
            <span className="min-w-0 shrink truncate font-mono font-medium">
              {record.operation}
            </span>
            {record.detail ? (
              <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground">
                {record.detail}
              </span>
            ) : (
              <span className="min-w-0 flex-1" />
            )}
            <span className="shrink-0 whitespace-nowrap font-mono text-[10px] text-muted-foreground">
              {record.durationMs} ms
            </span>
            <span className="w-[4.75rem] shrink-0 whitespace-nowrap text-right font-mono text-[10px] text-muted-foreground">
              {new Date(record.startedAt).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
              })}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
