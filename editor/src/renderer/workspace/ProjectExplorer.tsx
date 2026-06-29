import {
  Box,
  Clapperboard,
  File,
  FileType,
  FlaskConical,
  Folder,
  Image,
  Map,
  MessageSquare,
  Route as RouteIcon,
  ScrollText,
} from 'lucide-react';
import { useWorkspaceStore, type AssetNode } from '@/stores/workspace-store';
import { buildRawJsonTab } from '@/workbench/editor-registry';
import { useWorkbenchStore } from '@/workbench/workbench-store';

const assetIcons: Record<string, typeof File> = {
  room: FileType,
  object: Box,
  verb: RouteIcon,
  action: RouteIcon,
  map: Map,
  dialogue: MessageSquare,
  cutscene: Clapperboard,
  script: ScrollText,
  image: Image,
  asset: Image,
  test: FlaskConical,
  folder: Folder,
};

function getAssetIcon(type: AssetNode['type']) {
  return assetIcons[type] ?? File;
}

function ProjectExplorerItem({ node, depth = 0 }: { node: AssetNode; depth?: number }) {
  const selectedId = useWorkspaceStore((state) => state.selectedAssetId);
  const setSelectedId = useWorkspaceStore((state) => state.setSelectedAssetId);
  const openTab = useWorkbenchStore((state) => state.openTab);
  const Icon = getAssetIcon(node.type);
  const selectable = node.type !== 'folder' || (node.children?.length ?? 0) === 0;

  const openNode = () => {
    if (!selectable) return;
    setSelectedId(node.id);
    const tab = buildRawJsonTab(node);
    if (tab) openTab(tab);
  };

  return (
    <div>
      <button
        type="button"
        onClick={openNode}
        className={`flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left text-sm transition-colors hover:bg-accent ${
          selectedId === node.id ? 'bg-accent text-accent-foreground' : ''
        }`}
        style={{ paddingLeft: `${12 + depth * 16}px` }}
      >
        <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate">{node.label}</span>
        {node.type === 'folder' ? (
          <span className="ml-auto font-mono text-[10px] text-muted-foreground">
            {node.children?.length ?? 0}
          </span>
        ) : null}
      </button>
      {node.children?.map((child) => (
        <ProjectExplorerItem key={child.id} node={child} depth={depth + 1} />
      ))}
    </div>
  );
}

export function ProjectExplorer({ nodes }: { nodes: AssetNode[] }) {
  if (nodes.length === 0) {
    return <div className="p-3 text-xs text-muted-foreground">No project loaded.</div>;
  }
  return (
    <div className="space-y-0.5">
      {nodes.map((node) => (
        <ProjectExplorerItem key={node.id} node={node} />
      ))}
    </div>
  );
}
