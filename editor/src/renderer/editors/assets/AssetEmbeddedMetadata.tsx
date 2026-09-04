import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { useProjectStore } from '@/project/project-store';
import type {
  AssetMetadataInspectionResponse,
  AssetProvenanceStage,
} from '../../../shared/asset-metadata-inspection';
import type { AssetData } from '../../../shared/project-schema/authoring-assets';

interface AssetEmbeddedMetadataProps {
  assetId: string;
  data: AssetData;
}

function displayedValue(value: string | number | boolean): string {
  return typeof value === 'string' ? value : String(value);
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

export function AssetEmbeddedMetadata({ assetId, data }: AssetEmbeddedMetadataProps) {
  const { t } = useTranslation('workspace');
  const projectSessionId = useProjectStore((state) => state.projectSessionId);
  const [response, setResponse] = useState<AssetMetadataInspectionResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [promptExpanded, setPromptExpanded] = useState(false);
  const [negativePromptExpanded, setNegativePromptExpanded] = useState(false);

  useEffect(() => {
    let canceled = false;
    setResponse(null);
    setRequestError(null);
    setPromptExpanded(false);
    setNegativePromptExpanded(false);
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
        !response.generation ? (
        <p className="mt-2 text-xs text-muted-foreground">{t('assetMetadata.empty')}</p>
      ) : response?.status === 'ready' ? (
        <div className="mt-3 space-y-3">
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
          {response.groups.map((group) => (
            <div key={group.id} className="space-y-1">
              <div className="text-[11px] font-semibold text-foreground">{group.namespace}</div>
              <div className="divide-y rounded border">
                {group.items.map((metadataItem) => (
                  <div
                    key={metadataItem.id}
                    className="grid min-w-0 grid-cols-[minmax(5rem,auto)_minmax(0,1fr)] gap-3 px-2 py-1 text-[11px]"
                  >
                    <span className="truncate font-mono font-medium text-foreground">
                      {metadataItem.key}
                    </span>
                    <span
                      className="truncate font-mono text-muted-foreground"
                      title={displayedValue(metadataItem.value)}
                    >
                      {displayedValue(metadataItem.value)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : !projectSessionId ? (
        <p className="mt-2 text-xs text-muted-foreground">{t('assetMetadata.failure')}</p>
      ) : null}
    </section>
  );
}
