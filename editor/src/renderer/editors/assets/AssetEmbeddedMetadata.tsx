import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useProjectStore } from '@/project/project-store';
import type { AssetMetadataInspectionResponse } from '../../../shared/asset-metadata-inspection';
import type { AssetData } from '../../../shared/project-schema/authoring-assets';

interface AssetEmbeddedMetadataProps {
  assetId: string;
  data: AssetData;
}

function displayedValue(value: string | number | boolean): string {
  return typeof value === 'string' ? value : String(value);
}

export function AssetEmbeddedMetadata({ assetId, data }: AssetEmbeddedMetadataProps) {
  const { t } = useTranslation('workspace');
  const projectSessionId = useProjectStore((state) => state.projectSessionId);
  const [response, setResponse] = useState<AssetMetadataInspectionResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);

  useEffect(() => {
    let canceled = false;
    setResponse(null);
    setRequestError(null);
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
      ) : response?.status === 'ready' && response.groups.length === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">{t('assetMetadata.empty')}</p>
      ) : response?.status === 'ready' ? (
        <div className="mt-3 space-y-3">
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
