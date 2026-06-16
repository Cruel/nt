import { createFileRoute } from '@tanstack/react-router';
import { useWorkspaceStore, mockAssetTree, type AssetNode } from '@/stores/workspace-store';
import { EnginePreview } from '@/components/engine-preview';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import {
  Play,
  Square,
  Save,
  Eye,
  FileType,
  Users,
  ScrollText,
  Image,
  Music,
  Folder,
  File,
} from 'lucide-react';

export const Route = createFileRoute('/workspace')({
  component: WorkspacePage,
});

const assetIcons: Record<string, typeof File> = {
  scene: FileType,
  character: Users,
  script: ScrollText,
  image: Image,
  audio: Music,
  folder: Folder,
};

function getAssetIcon(type: AssetNode['type']) {
  return assetIcons[type] ?? File;
}

function AssetTreeItem({
  node,
  depth = 0,
}: {
  node: AssetNode;
  depth?: number;
}) {
  const selectedId = useWorkspaceStore((s) => s.selectedAssetId);
  const setSelectedId = useWorkspaceStore((s) => s.setSelectedAssetId);
  const Icon = getAssetIcon(node.type);

  return (
    <div>
      <button
        type="button"
        onClick={() => setSelectedId(node.id)}
        className={`flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left text-sm transition-colors hover:bg-accent ${
          selectedId === node.id ? 'bg-accent text-accent-foreground' : ''
        }`}
        style={{ paddingLeft: `${12 + depth * 16}px` }}
      >
        <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate">{node.label}</span>
      </button>
      {node.children?.map((child) => (
        <AssetTreeItem key={child.id} node={child} depth={depth + 1} />
      ))}
    </div>
  );
}

function AssetTree({ nodes }: { nodes: AssetNode[] }) {
  return (
    <div className="space-y-0.5">
      {nodes.map((node) => (
        <AssetTreeItem key={node.id} node={node} />
      ))}
    </div>
  );
}

function InspectorPanel() {
  const selectedAssetId = useWorkspaceStore((s) => s.selectedAssetId);
  const selectedRuntimeObjectId = useWorkspaceStore((s) => s.selectedRuntimeObjectId);
  const lastPreviewEvent = useWorkspaceStore((s) => s.lastPreviewEvent);
  const inspectorVisible = useWorkspaceStore((s) => s.inspectorVisible);

  if (!inspectorVisible) return null;

  const runtimeClick = lastPreviewEvent?.type === 'object-clicked' ? lastPreviewEvent : null;
  const mockDetail = selectedAssetId
    ? {
        id: selectedAssetId,
        type: 'scene' as const,
        path: `project/${selectedAssetId}`,
        modified: '2025-06-15 14:32',
      }
    : null;

  return (
    <div className="w-64 shrink-0 border-l bg-background">
      <div className="flex h-10 items-center border-b px-3">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Inspector
        </span>
      </div>
      <div className="p-3">
        {mockDetail ? (
          <div className="space-y-3">
            {selectedRuntimeObjectId ? (
              <>
                <div>
                  <div className="text-xs text-muted-foreground">Runtime Object</div>
                  <div className="text-sm font-medium">{selectedRuntimeObjectId}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">Type</div>
                  <Badge variant="outline" className="mt-0.5 font-mono text-xs">
                    Demo Triangle
                  </Badge>
                </div>
                {runtimeClick ? (
                  <div className="space-y-1 font-mono text-xs text-muted-foreground">
                    <div>object x {runtimeClick.position.x.toFixed(2)}</div>
                    <div>object y {runtimeClick.position.y.toFixed(2)}</div>
                    <div>pointer x {runtimeClick.pointerPosition.x.toFixed(2)}</div>
                    <div>pointer y {runtimeClick.pointerPosition.y.toFixed(2)}</div>
                  </div>
                ) : null}
                <Separator />
              </>
            ) : null}
            <div>
              <div className="text-xs text-muted-foreground">Asset</div>
              <div className="text-sm font-medium">{mockDetail.id}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Type</div>
              <Badge variant="outline" className="mt-0.5 font-mono text-xs">
                {mockDetail.type}
              </Badge>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Path</div>
              <div className="font-mono text-xs text-muted-foreground">
                {mockDetail.path}
              </div>
            </div>
            <Separator />
            <div>
              <div className="text-xs text-muted-foreground">Last Modified</div>
              <div className="font-mono text-xs">{mockDetail.modified}</div>
            </div>
            <Button size="sm" variant="outline" className="w-full">
              Properties
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            {selectedRuntimeObjectId ? (
              <>
                <div>
                  <div className="text-xs text-muted-foreground">Runtime Object</div>
                  <div className="text-sm font-medium">{selectedRuntimeObjectId}</div>
                </div>
                <Badge variant="outline" className="font-mono text-xs">Demo Triangle</Badge>
                {runtimeClick ? (
                  <div className="space-y-1 font-mono text-xs text-muted-foreground">
                    <div>object x {runtimeClick.position.x.toFixed(2)}</div>
                    <div>object y {runtimeClick.position.y.toFixed(2)}</div>
                    <div>pointer x {runtimeClick.pointerPosition.x.toFixed(2)}</div>
                    <div>pointer y {runtimeClick.pointerPosition.y.toFixed(2)}</div>
                  </div>
                ) : null}
              </>
            ) : (
              <p className="text-xs text-muted-foreground">
                Select an asset or runtime object to inspect
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function WorkspacePage() {
  const inspectorVisible = useWorkspaceStore((s) => s.inspectorVisible);
  const setInspectorVisible = useWorkspaceStore((s) => s.setInspectorVisible);
  const previewRunning = useWorkspaceStore((s) => s.previewRunning);
  const setPreviewRunning = useWorkspaceStore((s) => s.setPreviewRunning);
  const previewConnectionState = useWorkspaceStore((s) => s.previewConnectionState);
  const statusMessage = useWorkspaceStore((s) => s.statusMessage);

  return (
    <>
      <PageHeader
        title="Workspace"
        description="Editor workspace demonstration"
        actions={
          <div className="flex items-center gap-1">
            <Button
              size="sm"
              variant={previewRunning ? 'secondary' : 'ghost'}
              onClick={() => {
                setPreviewRunning(true);
                window.dispatchEvent(new CustomEvent('noveltea-preview-toolbar-play'));
              }}
            >
              <Play className="h-4 w-4" />
            </Button>
            <Button
              size="sm"
              variant={!previewRunning ? 'secondary' : 'ghost'}
              onClick={() => {
                setPreviewRunning(false);
                window.dispatchEvent(new CustomEvent('noveltea-preview-toolbar-stop'));
              }}
            >
              <Square className="h-4 w-4" />
            </Button>
            <Button size="sm" variant="ghost">
              <Save className="h-4 w-4" />
            </Button>
            <Separator orientation="vertical" className="mx-1 h-5" />
            <Button
              size="sm"
              variant={inspectorVisible ? 'secondary' : 'ghost'}
              onClick={() => setInspectorVisible(!inspectorVisible)}
            >
              <Eye className="h-4 w-4" />
            </Button>
          </div>
        }
      />
      <div className="flex flex-1 overflow-hidden">
        <div className="flex-1 overflow-hidden">
          <EnginePreview />
        </div>
        <InspectorPanel />
      </div>
      <div className="flex h-7 items-center border-t bg-muted/30 px-3">
        <span className="font-mono text-[10px] text-muted-foreground">
          {mockAssetTree.flatMap((n) => n.children ?? []).length} assets
        </span>
        <span className="mx-2 text-muted-foreground/30">|</span>
        <span className="font-mono text-[10px] text-muted-foreground">
          Preview {previewConnectionState}
        </span>
        <span className="mx-2 text-muted-foreground/30">|</span>
        <span className="truncate font-mono text-[10px] text-muted-foreground">
          {statusMessage}
        </span>
      </div>
    </>
  );
}

export { AssetTree };
