import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { usePreviewManagerStore } from '@/preview/preview-manager-store';
import type { AssetData } from '../../../shared/project-schema/authoring-assets';

export function AssetPreview({ assetId, label, data }: { assetId: string; label: string; data: AssetData }) {
  const requestThumbnail = usePreviewManagerStore((state) => state.requestThumbnail);
  const thumbnail = requestThumbnail({
    target: { collection: 'assets', entityId: assetId, kind: data.kind, label },
    document: { kind: 'symbolic', target: { collection: 'assets', entityId: assetId, kind: data.kind }, label, revision: data.contentHash },
    revision: data.contentHash ?? data.source.path,
  });

  return (
    <div className="rounded border bg-muted/20 p-4">
      <div className="flex items-center gap-2">
        <Badge variant="secondary">{data.kind}</Badge>
        <span className="font-mono text-xs text-muted-foreground">{thumbnail.status}</span>
      </div>
      <div className="mt-4 flex h-36 items-center justify-center rounded border border-dashed bg-background text-center text-sm text-muted-foreground">
        {data.kind === 'image' ? 'Image preview will use safe project asset URLs when that IPC is available.' : `${data.kind} preview fallback`}
      </div>
      <div className="mt-3 grid gap-1 font-mono text-[11px] text-muted-foreground">
        <div>{data.source.path}</div>
        {data.byteSize !== undefined ? <div>{data.byteSize.toLocaleString()} bytes</div> : null}
        {data.contentHash ? <div className="truncate">{data.contentHash}</div> : null}
      </div>
      <Button size="sm" variant="ghost" className="mt-3 h-7" onClick={() => requestThumbnail({
        target: { collection: 'assets', entityId: assetId, kind: data.kind, label },
        document: { kind: 'symbolic', target: { collection: 'assets', entityId: assetId, kind: data.kind }, label, revision: data.contentHash },
        revision: `${data.contentHash ?? data.source.path}:manual`,
      })}>
        Refresh thumbnail request
      </Button>
    </div>
  );
}
