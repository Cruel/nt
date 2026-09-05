import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useProjectStore } from '@/project/project-store';
import type {
  AssetMetadataInspectionItem,
  AssetMetadataInspectionResponse,
  AssetProvenanceStage,
} from '../../../shared/asset-metadata-inspection';
import type { AssetData } from '../../../shared/project-schema/authoring-assets';

interface AssetEmbeddedMetadataProps {
  assetId: string;
  data: AssetData;
  onLayoutReady?: () => void;
}

export interface AssetEmbeddedMetadataTabState {
  contentHash?: string;
  filter: string;
  expandedItemIds: string[];
  promptExpanded: boolean;
  negativePromptExpanded: boolean;
  itemScroll: Record<string, { scrollTop: number; scrollLeft: number }>;
  jsonHeights: Record<string, number>;
}

export interface AssetEmbeddedMetadataHandle {
  captureTabState(): AssetEmbeddedMetadataTabState;
  restoreTabState(state: unknown): void;
}

function parseMetadataTabState(value: unknown): AssetEmbeddedMetadataTabState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.filter !== 'string' ||
    !Array.isArray(candidate.expandedItemIds) ||
    !candidate.expandedItemIds.every((item) => typeof item === 'string') ||
    typeof candidate.promptExpanded !== 'boolean' ||
    typeof candidate.negativePromptExpanded !== 'boolean' ||
    !candidate.itemScroll ||
    typeof candidate.itemScroll !== 'object' ||
    Array.isArray(candidate.itemScroll) ||
    !candidate.jsonHeights ||
    typeof candidate.jsonHeights !== 'object' ||
    Array.isArray(candidate.jsonHeights)
  )
    return null;
  const itemScroll: AssetEmbeddedMetadataTabState['itemScroll'] = {};
  for (const [id, entry] of Object.entries(candidate.itemScroll as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const scroll = entry as Record<string, unknown>;
    if (
      typeof scroll.scrollTop === 'number' &&
      Number.isFinite(scroll.scrollTop) &&
      typeof scroll.scrollLeft === 'number' &&
      Number.isFinite(scroll.scrollLeft)
    )
      itemScroll[id] = { scrollTop: scroll.scrollTop, scrollLeft: scroll.scrollLeft };
  }
  const jsonHeights: Record<string, number> = {};
  for (const [id, height] of Object.entries(candidate.jsonHeights as Record<string, unknown>)) {
    if (typeof height === 'number' && Number.isFinite(height) && height > 0)
      jsonHeights[id] = height;
  }
  return {
    ...(typeof candidate.contentHash === 'string' ? { contentHash: candidate.contentHash } : {}),
    filter: candidate.filter,
    expandedItemIds: [...candidate.expandedItemIds],
    promptExpanded: candidate.promptExpanded,
    negativePromptExpanded: candidate.negativePromptExpanded,
    itemScroll,
    jsonHeights,
  };
}

function displayedValue(value: string | number | boolean): string {
  return typeof value === 'string' ? value : String(value);
}

function formattedJson(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

function metadataSearchText(namespace: string, metadataItem: AssetMetadataInspectionItem): string {
  return `${namespace}\n${metadataItem.key}\n${displayedValue(metadataItem.value)}`.toLocaleLowerCase();
}

function provenanceSource(stage: AssetProvenanceStage): string | null {
  if (stage.model && stage.tool) return `${stage.model.label} · via ${stage.tool.label}`;
  return stage.model?.label ?? stage.tool?.label ?? stage.provider?.label ?? null;
}

function copyText(value: string) {
  void navigator.clipboard?.writeText(value);
}

function isLongRecognizedText(value: string): boolean {
  return value.length > 240 || value.split(/\r?\n/).length > 4;
}

export const AssetEmbeddedMetadata = forwardRef<
  AssetEmbeddedMetadataHandle,
  AssetEmbeddedMetadataProps
>(function AssetEmbeddedMetadata({ assetId, data, onLayoutReady }, ref) {
  const { t } = useTranslation('workspace');
  const projectSessionId = useProjectStore((state) => state.projectSessionId);
  const [response, setResponse] = useState<AssetMetadataInspectionResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [promptExpanded, setPromptExpanded] = useState(false);
  const [negativePromptExpanded, setNegativePromptExpanded] = useState(false);
  const [filter, setFilter] = useState('');
  const [expandedItemIds, setExpandedItemIds] = useState<Set<string>>(() => new Set());
  const itemViewRefs = useRef(new Map<string, HTMLElement>());
  const jsonViewRefs = useRef(new Map<string, HTMLTextAreaElement>());
  const pendingRestoreRef = useRef<AssetEmbeddedMetadataTabState | null>(null);

  useImperativeHandle(
    ref,
    () => ({
      captureTabState: () => {
        const itemScroll: AssetEmbeddedMetadataTabState['itemScroll'] = {};
        for (const [id, element] of itemViewRefs.current) {
          if (!expandedItemIds.has(id)) continue;
          itemScroll[id] = { scrollTop: element.scrollTop, scrollLeft: element.scrollLeft };
        }
        const jsonHeights: Record<string, number> = {};
        for (const [id, element] of jsonViewRefs.current) {
          if (!expandedItemIds.has(id)) continue;
          jsonHeights[id] = element.getBoundingClientRect().height || element.offsetHeight;
        }
        return {
          ...(data.contentHash ? { contentHash: data.contentHash } : {}),
          filter,
          expandedItemIds: [...expandedItemIds],
          promptExpanded,
          negativePromptExpanded,
          itemScroll,
          jsonHeights,
        };
      },
      restoreTabState: (value) => {
        const state = parseMetadataTabState(value);
        if (
          !state ||
          typeof data.contentHash !== 'string' ||
          state.contentHash !== data.contentHash
        ) {
          pendingRestoreRef.current = null;
          setFilter('');
          setExpandedItemIds(new Set());
          setPromptExpanded(false);
          setNegativePromptExpanded(false);
          return;
        }
        pendingRestoreRef.current = state;
        setFilter(state.filter);
        setExpandedItemIds(new Set(state.expandedItemIds));
        setPromptExpanded(state.promptExpanded);
        setNegativePromptExpanded(state.negativePromptExpanded);
      },
    }),
    [data.contentHash, expandedItemIds, filter, negativePromptExpanded, promptExpanded],
  );

  useEffect(() => {
    let canceled = false;
    setResponse(null);
    setRequestError(null);
    setPromptExpanded(false);
    setNegativePromptExpanded(false);
    setFilter('');
    setExpandedItemIds(new Set());
    pendingRestoreRef.current = null;
    setLoading(Boolean(projectSessionId));
    if (!projectSessionId) return;
    void window.noveltea
      .inspectProjectAssetMetadata(projectSessionId, assetId)
      .then((result) => {
        if (canceled) return;
        setResponse(result);
        setLoading(false);
      })
      .catch((error) => {
        if (canceled) return;
        setRequestError(error instanceof Error ? error.message : '');
        setLoading(false);
      });
    return () => {
      canceled = true;
    };
  }, [assetId, data.contentHash, data.kind, projectSessionId]);

  useEffect(() => {
    const state = pendingRestoreRef.current;
    if (!state || typeof data.contentHash !== 'string' || state.contentHash !== data.contentHash)
      return;
    const pendingItemScroll = { ...state.itemScroll };
    for (const [id, scroll] of Object.entries(pendingItemScroll)) {
      const element = itemViewRefs.current.get(id);
      if (!element) continue;
      element.scrollTop = scroll.scrollTop;
      element.scrollLeft = scroll.scrollLeft;
      delete pendingItemScroll[id];
    }
    const pendingJsonHeights = { ...state.jsonHeights };
    for (const [id, height] of Object.entries(pendingJsonHeights)) {
      const element = jsonViewRefs.current.get(id);
      if (!element) continue;
      element.style.height = `${height}px`;
      delete pendingJsonHeights[id];
    }
    if (Object.keys(pendingItemScroll).length === 0 && Object.keys(pendingJsonHeights).length === 0)
      pendingRestoreRef.current = null;
    else
      pendingRestoreRef.current = {
        ...state,
        itemScroll: pendingItemScroll,
        jsonHeights: pendingJsonHeights,
      };
  }, [data.contentHash, expandedItemIds, filter, response]);

  // Run after inner scroll/height restoration so the outer editor sees the final layout.
  useEffect(() => {
    if (!loading && (response !== null || requestError !== null || !projectSessionId))
      onLayoutReady?.();
  });

  return (
    <section
      className="mt-4 rounded border bg-background p-3"
      data-testid="asset-embedded-metadata"
    >
      <h3 className="text-sm font-medium">{t('assetMetadata.title')}</h3>
      {loading ? (
        <p className="mt-2 text-xs text-muted-foreground">{t('assetMetadata.loading')}</p>
      ) : requestError !== null ? (
        <p className="mt-2 text-xs text-destructive">
          {requestError || t('assetMetadata.failure')}
        </p>
      ) : response?.ok === false ? (
        <p className="mt-2 text-xs text-destructive">
          {response.message || t('assetMetadata.failure')}
        </p>
      ) : response?.status === 'unsupported' ? (
        <p className="mt-2 text-xs text-muted-foreground">{t('assetMetadata.unsupported')}</p>
      ) : response?.status === 'ready' &&
        response.groups.length === 0 &&
        !response.provenance &&
        !response.generation &&
        !response.workflowMetadata?.length &&
        !response.warnings?.length ? (
        <p className="mt-2 text-xs text-muted-foreground">{t('assetMetadata.empty')}</p>
      ) : response?.status === 'ready' ? (
        <div className="mt-3 space-y-3">
          {response.workflowMetadata?.map((workflow) => (
            <div
              key={`${workflow.tool.id}:${workflow.kind}`}
              className="rounded border bg-muted/20 p-2 text-xs font-medium text-foreground"
            >
              {t('assetMetadata.workflowMetadata', { tool: workflow.tool.label })}
            </div>
          ))}
          {response.warnings?.map((warning) => (
            <div
              key={warning}
              className="rounded border border-warning/40 bg-warning/10 p-2 text-xs text-foreground"
            >
              {t(`assetMetadata.warnings.${warning}`)}
            </div>
          ))}
          {response.provenance ? (
            <div className="rounded border bg-muted/20 p-2">
              <div className="space-y-1">
                {response.provenance.stages.map((stage) => {
                  const source = provenanceSource(stage);
                  return source ? (
                    <div key={stage.id} className="text-xs font-medium text-foreground">
                      {t(`assetMetadata.provenance.${stage.role}`, { source })}
                    </div>
                  ) : null;
                })}
              </div>
              {response.c2pa ? (
                <div className="mt-1 text-[11px] text-muted-foreground">
                  {t(`assetMetadata.provenance.trust.${response.c2pa.trust}`)}
                </div>
              ) : null}
            </div>
          ) : null}
          {response.generation ? (
            <div className="space-y-2 rounded border bg-muted/10 p-2">
              {response.generation.prompt !== undefined ? (
                <div>
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-[11px] font-semibold">
                      {t('assetMetadata.generation.prompt')}
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2 text-[10px]"
                      onClick={() => copyText(response.generation!.prompt!)}
                    >
                      {t('assetMetadata.generation.copy')}
                    </Button>
                  </div>
                  <div
                    className={`mt-1 whitespace-pre-wrap text-xs text-foreground ${!promptExpanded && isLongRecognizedText(response.generation.prompt) ? 'max-h-20 overflow-hidden' : ''}`}
                  >
                    {response.generation.prompt}
                  </div>
                  {isLongRecognizedText(response.generation.prompt) ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="mt-1 h-6 px-2 text-[10px]"
                      onClick={() => setPromptExpanded((expanded) => !expanded)}
                    >
                      {t(
                        promptExpanded
                          ? 'assetMetadata.generation.showLess'
                          : 'assetMetadata.generation.showMore',
                      )}
                    </Button>
                  ) : null}
                </div>
              ) : null}
              {response.generation.negativePrompt !== undefined ? (
                <div>
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-[11px] font-semibold">
                      {t('assetMetadata.generation.negativePrompt')}
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2 text-[10px]"
                      onClick={() => copyText(response.generation!.negativePrompt!)}
                    >
                      {t('assetMetadata.generation.copy')}
                    </Button>
                  </div>
                  <div
                    className={`mt-1 whitespace-pre-wrap text-xs text-foreground ${!negativePromptExpanded && isLongRecognizedText(response.generation.negativePrompt) ? 'max-h-20 overflow-hidden' : ''}`}
                  >
                    {response.generation.negativePrompt || t('assetMetadata.generation.none')}
                  </div>
                  {isLongRecognizedText(response.generation.negativePrompt) ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="mt-1 h-6 px-2 text-[10px]"
                      onClick={() => setNegativePromptExpanded((expanded) => !expanded)}
                    >
                      {t(
                        negativePromptExpanded
                          ? 'assetMetadata.generation.showLess'
                          : 'assetMetadata.generation.showMore',
                      )}
                    </Button>
                  ) : null}
                </div>
              ) : null}
              {response.generation.facts.length > 0 ? (
                <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                  {response.generation.facts.map((fact) => (
                    <span key={fact.id}>
                      <span className="font-medium text-foreground">
                        {t(`assetMetadata.generation.facts.${fact.id}`)}:
                      </span>{' '}
                      {fact.value}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
          {response.groups.length > 0 ? (
            <Input
              value={filter}
              onChange={(event) => setFilter(event.currentTarget.value)}
              placeholder={t('assetMetadata.filter')}
              aria-label={t('assetMetadata.filter')}
              className="h-8 text-xs"
            />
          ) : null}
          {response.groups.map((group) => {
            const normalizedFilter = filter.trim().toLocaleLowerCase();
            const visibleItems = normalizedFilter
              ? group.items.filter((metadataItem) =>
                  metadataSearchText(group.namespace, metadataItem).includes(normalizedFilter),
                )
              : group.items;
            if (visibleItems.length === 0) return null;
            return (
              <div key={group.id} className="space-y-1">
                <div className="text-[11px] font-semibold text-foreground">{group.namespace}</div>
                <div className="divide-y rounded border">
                  {visibleItems.map((metadataItem) => {
                    const expanded = expandedItemIds.has(metadataItem.id);
                    const rawValue = displayedValue(metadataItem.value);
                    const canExpand =
                      typeof metadataItem.value === 'string' &&
                      metadataItem.valueKind !== 'binary' &&
                      metadataItem.valueKind !== 'limited' &&
                      (metadataItem.valueKind === 'json' ||
                        rawValue.length > 80 ||
                        rawValue.includes('\n'));
                    const collapsedValue =
                      metadataItem.valueKind === 'binary'
                        ? t('assetMetadata.binary', { bytes: metadataItem.byteSize ?? 0 })
                        : metadataItem.valueKind === 'limited'
                          ? metadataItem.byteSize !== undefined
                            ? t('assetMetadata.limited', { bytes: metadataItem.byteSize })
                            : t('assetMetadata.limitedUnknown')
                          : rawValue;
                    return (
                      <div key={metadataItem.id} className="min-w-0 px-2 py-1 text-[11px]">
                        <div className="grid min-w-0 grid-cols-[minmax(5rem,auto)_minmax(0,1fr)] gap-3">
                          <span className="truncate font-mono font-medium text-foreground">
                            {metadataItem.key}
                          </span>
                          <button
                            type="button"
                            aria-disabled={!canExpand}
                            className={`min-w-0 select-text truncate text-left font-mono text-muted-foreground ${canExpand ? 'cursor-pointer' : 'cursor-text'}`}
                            title={collapsedValue}
                            aria-expanded={canExpand ? expanded : undefined}
                            onClick={() => {
                              if (!canExpand) return;
                              setExpandedItemIds((current) => {
                                const next = new Set(current);
                                if (next.has(metadataItem.id)) next.delete(metadataItem.id);
                                else next.add(metadataItem.id);
                                return next;
                              });
                            }}
                          >
                            {collapsedValue}
                          </button>
                        </div>
                        {expanded && canExpand ? (
                          <div className="mt-2 space-y-1">
                            <div className="flex justify-end">
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                className="h-6 px-2 text-[10px]"
                                onClick={() => copyText(rawValue)}
                              >
                                {t('assetMetadata.copy')}
                              </Button>
                            </div>
                            {metadataItem.valueKind === 'json' ? (
                              <textarea
                                ref={(element) => {
                                  if (element) {
                                    jsonViewRefs.current.set(metadataItem.id, element);
                                    itemViewRefs.current.set(metadataItem.id, element);
                                  } else {
                                    jsonViewRefs.current.delete(metadataItem.id);
                                    itemViewRefs.current.delete(metadataItem.id);
                                  }
                                }}
                                readOnly
                                value={formattedJson(rawValue)}
                                aria-label={`${metadataItem.key} JSON`}
                                className="h-40 min-h-24 w-full resize-y overflow-auto rounded border bg-background p-2 font-mono text-[11px] text-foreground"
                              />
                            ) : (
                              <div
                                ref={(element) => {
                                  if (element) itemViewRefs.current.set(metadataItem.id, element);
                                  else itemViewRefs.current.delete(metadataItem.id);
                                }}
                                aria-label={`${metadataItem.key} value`}
                                className="max-h-40 overflow-auto whitespace-pre-wrap rounded border bg-background p-2 font-mono text-[11px] text-foreground"
                              >
                                {rawValue}
                              </div>
                            )}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      ) : !projectSessionId ? (
        <p className="mt-2 text-xs text-muted-foreground">{t('assetMetadata.failure')}</p>
      ) : null}
    </section>
  );
});
