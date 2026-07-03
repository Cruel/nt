import { useEffect, useMemo, useState } from 'react';
import { Images, Pencil, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useCommandStore } from '@/commands/command-store';
import { useAssetTrashStore } from '@/assets/asset-trash-store';
import { useProjectStore } from '@/project/project-store';
import { useWorkbenchStore } from '@/workbench/workbench-store';
import { buildAssetDetailTabForRecord, buildImageGenerationTab } from '@/workbench/editor-registry';
import { parseAssetData, type AssetData } from '../../../shared/project-schema/authoring-assets';
import { isAuthoringProject, type AuthoringRecordBase } from '../../../shared/project-schema/authoring-project';
import { AssetPreview } from './AssetPreview';
import type { WorkbenchEditorProps } from '@/workbench/editor-registry';

interface AssetListItem {
  id: string;
  record: AuthoringRecordBase;
  data: AssetData | null;
  label: string;
}

interface AssetContextMenuState {
  asset: AssetListItem;
  x: number;
  y: number;
}

function AssetContextMenu({ state, projectFilePath, onClose }: { state: AssetContextMenuState | null; projectFilePath: string | null; onClose: () => void }) {
  const openTab = useWorkbenchStore((store) => store.openTab);
  const executeCommand = useCommandStore((store) => store.executeCommand);
  const rememberDeletedAsset = useAssetTrashStore((store) => store.rememberDeletedAsset);

  useEffect(() => {
    if (!state) return;
    const close = () => onClose();
    window.addEventListener('click', close);
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', close);
    };
  }, [onClose, state]);

  if (!state) return null;
  const { asset } = state;
  const itemClass = 'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent disabled:opacity-50';

  function deleteAsset() {
    const result = executeCommand({ type: 'asset.deleteAsset', label: `Delete ${asset.id}`, payload: { assetId: asset.id, force: true } });
    if (projectFilePath && asset.data?.source.path && !result.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
      void window.noveltea.trashProjectAssetFiles(projectFilePath, [asset.data.source.path]).then((trashResult) => {
        const move = trashResult.moved?.[0];
        if (move) rememberDeletedAsset({ assetId: asset.id, projectFilePath, move });
      });
    }
    onClose();
  }

  return (
    <div className="fixed z-50 min-w-48 rounded-md border bg-popover p-1 text-popover-foreground shadow-lg" style={{ left: state.x, top: state.y }} onClick={(event) => event.stopPropagation()}>
      <button className={itemClass} onClick={() => { openTab(buildAssetDetailTabForRecord(asset.id, asset.label)); onClose(); }}><Pencil className="h-3.5 w-3.5" /> Open</button>
      <button className={itemClass} onClick={() => { openTab(buildImageGenerationTab()); onClose(); }}><Images className="h-3.5 w-3.5" /> Generate Image</button>
      <button
        className={itemClass}
        disabled={asset.data?.kind !== 'image'}
        onClick={() => {
          if (asset.data?.kind === 'image') openTab(buildImageGenerationTab({ sourceAssetId: asset.id, sourceProjectRelativePath: asset.data.source.path, mode: 'edit' }));
          onClose();
        }}
      >
        <Images className="h-3.5 w-3.5" /> Edit Image with ComfyUI
      </button>
      <div className="my-1 h-px bg-border" />
      <button className={`${itemClass} text-destructive`} onClick={deleteAsset}><Trash2 className="h-3.5 w-3.5" /> Delete</button>
    </div>
  );
}

export function AssetLibraryEditor(_props: WorkbenchEditorProps) {
  const projectDocument = useProjectStore((state) => state.document);
  const projectFilePath = useProjectStore((state) => state.projectFilePath);
  const openTab = useWorkbenchStore((state) => state.openTab);
  const project = isAuthoringProject(projectDocument) ? projectDocument : null;
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('all');
  const [contextMenu, setContextMenu] = useState<AssetContextMenuState | null>(null);
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
        <Button size="sm" className="h-8 gap-2" onClick={() => openTab(buildImageGenerationTab())}><Images className="h-3.5 w-3.5" /> Generate Image</Button>
        <Input className="h-8 w-56" value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="Search assets" />
        <select className="h-8 rounded-md border border-input bg-background px-2 text-xs" value={kind} onChange={(event) => setKind(event.currentTarget.value)}>
          <option value="all">All kinds</option>
          {kinds.map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
      </div>
      <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {assets.map((asset) => (
          <div
            key={asset.id}
            className="rounded border p-3 text-left transition-colors hover:bg-accent"
            onContextMenu={(event) => { event.preventDefault(); setContextMenu({ asset, x: event.clientX, y: event.clientY }); }}
          >
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
      <AssetContextMenu state={contextMenu} projectFilePath={projectFilePath} onClose={() => setContextMenu(null)} />
      {assets.length === 0 ? <div className="mt-8 rounded border p-4 text-sm text-muted-foreground">No assets match the current filter.</div> : null}
    </div>
  );
}
