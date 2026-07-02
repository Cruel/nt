import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useProjectStore } from '@/project/project-store';
import type { AssetData } from '../../../shared/project-schema/authoring-assets';

interface AssetPreviewProps {
  assetId: string;
  label: string;
  data: AssetData;
  compact?: boolean;
}

function kindLabel(kind: AssetData['kind']) {
  switch (kind) {
    case 'image': return 'Image';
    case 'audio': return 'Audio';
    case 'font': return 'Font';
    case 'shader-source': return 'Shader';
    case 'script': return 'Script';
    case 'text': return 'Text';
    case 'binary': return 'Binary';
    case 'data': return 'Data';
    default: return kind;
  }
}

export function AssetPreview({ label, data, compact = false }: AssetPreviewProps) {
  const projectFilePath = useProjectStore((state) => state.projectFilePath);
  const [assetUrl, setAssetUrl] = useState<string | null>(null);
  const [absolutePath, setAbsolutePath] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const canResolve = Boolean(projectFilePath) && (data.kind === 'image' || data.kind === 'audio');

  useEffect(() => {
    let canceled = false;
    setAssetUrl(null);
    setAbsolutePath(null);
    setLoadError(null);
    if (!projectFilePath || !canResolve) return;
    void window.noveltea.resolveProjectAssetUrl(projectFilePath, data.source.path)
      .then((result) => {
        if (!canceled) {
          setAssetUrl(result?.url ?? null);
          setAbsolutePath(result?.absolutePath ?? null);
        }
      })
      .catch((error) => {
        if (!canceled) setLoadError(error instanceof Error ? error.message : 'Asset URL could not be resolved.');
      });
    return () => { canceled = true; };
  }, [canResolve, data.source.path, projectFilePath]);

  if (compact) {
    return (
      <div className="flex h-full w-full items-center justify-center overflow-hidden bg-muted/20">
        {data.kind === 'image' && assetUrl ? (
          <img src={assetUrl} alt={label} className="h-full w-full object-cover" loading="lazy" />
        ) : data.kind === 'audio' ? (
          <div className="flex h-full w-full flex-col items-center justify-center gap-1 p-2">
            <Badge variant="secondary" className="text-[10px]">audio</Badge>
            {assetUrl ? <audio controls src={assetUrl} className="h-7 w-full" onClick={(event) => event.stopPropagation()} /> : null}
          </div>
        ) : (
          <Badge variant="secondary" className="text-[10px]">{data.kind}</Badge>
        )}
        {data.kind === 'image' && !assetUrl ? <span className="px-2 text-center text-[10px] text-muted-foreground">image</span> : null}
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
            {loadError ?? (canResolve ? `Loading ${kindLabel(data.kind).toLowerCase()} preview...` : `${kindLabel(data.kind)} preview is not available.`)}
          </div>
        )}
      </div>
      <div className="mt-3 grid gap-1 font-mono text-[11px] text-muted-foreground">
        <div>{data.source.path}</div>
        {data.byteSize !== undefined ? <div>{data.byteSize.toLocaleString()} bytes</div> : null}
        {data.contentHash ? <div className="truncate">{data.contentHash}</div> : null}
      </div>
      {absolutePath ? (
        <Button size="sm" variant="ghost" className="mt-3 h-7" onClick={() => void window.noveltea.showItemInFolder(absolutePath)}>
          Show in folder
        </Button>
      ) : null}
    </div>
  );
}
