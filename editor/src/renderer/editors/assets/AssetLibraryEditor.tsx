import { useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { useProjectStore } from '@/project/project-store';
import { useWorkbenchStore } from '@/workbench/workbench-store';
import { buildAssetDetailTabForRecord } from '@/workbench/editor-registry';
import { parseAssetData } from '../../../shared/project-schema/authoring-assets';
import { isAuthoringProject } from '../../../shared/project-schema/authoring-project';
import { AssetPreview } from './AssetPreview';
import type { WorkbenchEditorProps } from '@/workbench/editor-registry';

export function AssetLibraryEditor(_props: WorkbenchEditorProps) {
  const projectDocument = useProjectStore((state) => state.document);
  const openTab = useWorkbenchStore((state) => state.openTab);
  const project = isAuthoringProject(projectDocument) ? projectDocument : null;
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('all');
  const assets = useMemo(() => {
    if (!project) return [];
    return Object.entries(project.assets)
      .map(([id, record]) => ({ id, record, data: parseAssetData(record.data), label: record.label || id }))
      .filter((asset) => kind === 'all' || asset.data?.kind === kind)
      .filter((asset) => !query.trim() || `${asset.id} ${asset.label} ${asset.data?.kind ?? ''}`.toLowerCase().includes(query.toLowerCase()))
      .sort((left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id));
  }, [kind, project, query]);
  const kinds = useMemo(() => [...new Set(assets.map((asset) => asset.data?.kind).filter(Boolean))].sort(), [assets]);

  if (!project) return <div className="p-4 text-sm text-muted-foreground">Open an authoring project to browse assets.</div>;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto bg-background p-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold">Assets</h2>
          <p className="text-xs text-muted-foreground">Global asset pool. Select an asset to open its detail tab.</p>
        </div>
        <Input className="h-8 w-56" value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="Search assets" />
        <select className="h-8 rounded-md border border-input bg-background px-2 text-xs" value={kind} onChange={(event) => setKind(event.currentTarget.value)}>
          <option value="all">All kinds</option>
          {kinds.map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
      </div>
      <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {assets.map((asset) => (
          <div key={asset.id} className="rounded border p-3 text-left transition-colors hover:bg-accent">
            <div className="flex items-start gap-3">
              <button
                type="button"
                className="h-20 w-20 shrink-0 overflow-hidden rounded border bg-muted/30 text-left"
                onClick={() => openTab(buildAssetDetailTabForRecord(asset.id, asset.label))}
                aria-label={`Open ${asset.label}`}
              >
                {asset.data ? <AssetPreview assetId={asset.id} label={asset.label} data={asset.data} compact /> : null}
              </button>
              <button
                type="button"
                className="min-w-0 flex-1 text-left"
                onClick={() => openTab(buildAssetDetailTabForRecord(asset.id, asset.label))}
              >
                <div className="truncate font-medium">{asset.label}</div>
                <div className="mt-1 truncate font-mono text-[10px] text-muted-foreground">{asset.id}</div>
                {asset.data ? <Badge variant="secondary" className="mt-2">{asset.data.kind}</Badge> : <Badge variant="destructive" className="mt-2">invalid</Badge>}
                <div className="mt-2 truncate text-xs text-muted-foreground">{asset.data?.source.path ?? 'Invalid asset data'}</div>
              </button>
            </div>
          </div>
        ))}
      </div>
      {assets.length === 0 ? <div className="mt-8 rounded border p-4 text-sm text-muted-foreground">No assets match the current filter.</div> : null}
    </div>
  );
}
