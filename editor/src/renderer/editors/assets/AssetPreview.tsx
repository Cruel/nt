import { useEffect, useState, type Ref } from 'react';
import { Badge } from '@/components/ui/badge';
import { useAssetTrashStore } from '@/assets/asset-trash-store';
import { useProjectStore } from '@/project/project-store';
import { AssetImageThumbnail } from '@/workspace/AssetImageThumbnail';
import type { AssetData } from '../../../shared/project-schema/authoring-assets';
import { AssetEmbeddedMetadata, type AssetEmbeddedMetadataHandle } from './AssetEmbeddedMetadata';

interface AssetPreviewProps {
  assetId: string;
  label: string;
  data: AssetData;
  compact?: boolean;
  metadataStateRef?: Ref<AssetEmbeddedMetadataHandle>;
  onMetadataLayoutReady?: () => void;
}

function kindLabel(kind: AssetData['kind']) {
  switch (kind) {
    case 'image':
      return 'Image';
    case 'audio':
      return 'Audio';
    case 'font':
      return 'Font';
    case 'shader-source':
      return 'Shader';
    case 'script':
      return 'Script';
    case 'text':
      return 'Text';
    case 'binary':
      return 'Binary';
    case 'data':
      return 'Data';
    default:
      return kind;
  }
}

export function AssetPreview({
  assetId,
  label,
  data,
  compact = false,
  metadataStateRef,
  onMetadataLayoutReady,
}: AssetPreviewProps) {
  const projectSessionId = useProjectStore((state) => state.projectSessionId);
  const deletedAsset = useAssetTrashStore((state) => state.deletedAssets[assetId]);
  const [assetUrl, setAssetUrl] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const canResolve =
    Boolean(projectSessionId) && (data.kind === 'audio' || (!compact && data.kind === 'image'));

  useEffect(() => {
    let canceled = false;
    setAssetUrl(null);
    setLoadError(null);
    if (!projectSessionId || !canResolve) return;
    void window.noveltea
      .resolveProjectOriginalAssetUrl(projectSessionId, assetId)
      .then((result) => {
        if (!canceled) setAssetUrl(result.ok ? result.url : null);
      })
      .catch((error) => {
        if (!canceled)
          setLoadError(error instanceof Error ? error.message : 'Asset URL could not be resolved.');
      });
    return () => {
      canceled = true;
    };
  }, [assetId, canResolve, deletedAsset, projectSessionId]);

  if (compact) {
    const imageSource =
      data.kind === 'image' && data.imageMetadata
        ? {
            assetId,
            projectRelativePath: data.source.path,
            contentHash: data.contentHash,
            width: data.imageMetadata.width,
            height: data.imageMetadata.height,
            orientation: data.imageMetadata.orientation,
            sampling: data.sampling,
          }
        : null;
    return (
      <div className="flex h-full w-full items-center justify-center overflow-hidden bg-muted/20">
        {imageSource ? (
          <AssetImageThumbnail
            label={label}
            source={imageSource}
            request={{ profile: 'card' }}
            requestMode="visible"
            className="h-full w-full rounded-none border-0"
          />
        ) : data.kind === 'audio' ? (
          <div className="flex h-full w-full flex-col items-center justify-center gap-1 p-2">
            <Badge variant="secondary" className="text-[10px]">
              audio
            </Badge>
            {assetUrl ? (
              <audio
                controls
                src={assetUrl}
                className="h-7 w-full"
                onClick={(event) => event.stopPropagation()}
              />
            ) : null}
          </div>
        ) : (
          <Badge variant="secondary" className="text-[10px]">
            {data.kind}
          </Badge>
        )}
        {data.kind === 'image' && !imageSource ? (
          <span className="px-2 text-center text-[10px] text-muted-foreground">image</span>
        ) : null}
      </div>
    );
  }

  return (
    <div className="rounded border bg-muted/20 p-4">
      <div className="flex items-center gap-2">
        <Badge variant="secondary">{data.kind}</Badge>
        <span className="truncate font-mono text-xs text-muted-foreground">{data.source.path}</span>
      </div>
      <div className="mt-4 flex min-h-48 items-center justify-center overflow-hidden rounded border bg-background">
        {data.kind === 'image' && assetUrl ? (
          <img src={assetUrl} alt={label} className="max-h-[480px] w-full object-contain" />
        ) : data.kind === 'audio' && assetUrl ? (
          <div className="w-full space-y-3 p-4">
            <div className="text-sm font-medium">{label}</div>
            <audio controls src={assetUrl} className="w-full" />
          </div>
        ) : (
          <div className="p-6 text-center text-sm text-muted-foreground">
            {loadError ??
              (canResolve
                ? `Loading ${kindLabel(data.kind).toLowerCase()} preview...`
                : `${kindLabel(data.kind)} preview is not available.`)}
          </div>
        )}
      </div>
      <AssetEmbeddedMetadata
        ref={metadataStateRef}
        assetId={assetId}
        data={data}
        onLayoutReady={onMetadataLayoutReady}
      />
      <div className="mt-3 grid gap-1 font-mono text-[11px] text-muted-foreground">
        <div>{data.source.path}</div>
        {data.byteSize !== undefined ? <div>{data.byteSize.toLocaleString()} bytes</div> : null}
        {data.contentHash ? <div className="truncate">{data.contentHash}</div> : null}
      </div>
    </div>
  );
}
