import { createFileRoute } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import {
  useWorkspaceStore,
  buildProjectTree,
  type AssetNode,
} from '@/stores/workspace-store';
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
  ScrollText,
  Image,
  Folder,
  File,
  Box,
  Route as RouteIcon,
  Map,
  MessageSquare,
  Clapperboard,
  FlaskConical,
  Package,
} from 'lucide-react';

export const Route = createFileRoute('/workspace')({
  component: WorkspacePage,
});

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getAssetIcon(type: AssetNode['type']) {
  return assetIcons[type] ?? File;
}

function selectedRecord(project: unknown, selected: AssetNode | null) {
  if (!selected?.collection || !selected.entityId || !isRecord(project)) return null;
  const collection = project[selected.collection];
  if (!isRecord(collection)) return null;
  return collection[selected.entityId] ?? null;
}

function findNode(nodes: AssetNode[], id: string | null): AssetNode | null {
  if (!id) return null;
  for (const node of nodes) {
    if (node.id === id) return node;
    const child = findNode(node.children ?? [], id);
    if (child) return child;
  }
  return null;
}

function AssetTreeItem({ node, depth = 0 }: { node: AssetNode; depth?: number }) {
  const selectedId = useWorkspaceStore((s) => s.selectedAssetId);
  const setSelectedId = useWorkspaceStore((s) => s.setSelectedAssetId);
  const Icon = getAssetIcon(node.type);
  const selectable = node.type !== 'folder' || (node.children?.length ?? 0) === 0;

  return (
    <div>
      <button
        type="button"
        onClick={() => selectable && setSelectedId(node.id)}
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
        <AssetTreeItem key={child.id} node={child} depth={depth + 1} />
      ))}
    </div>
  );
}

function AssetTree({ nodes }: { nodes: AssetNode[] }) {
  return <div className="space-y-0.5">{nodes.map((node) => <AssetTreeItem key={node.id} node={node} />)}</div>;
}

function DiagnosticsPanel() {
  const diagnostics = useWorkspaceStore((s) => s.diagnostics);
  if (diagnostics.length === 0) {
    return <p className="text-xs text-muted-foreground">No validation diagnostics.</p>;
  }
  return (
    <div className="space-y-2">
      {diagnostics.map((diagnostic, index) => (
        <div key={`${diagnostic.path}-${index}`} className="rounded border p-2 text-xs">
          <div className="flex items-center gap-2">
            <Badge variant={diagnostic.severity === 'error' ? 'destructive' : 'secondary'}>
              {diagnostic.severity}
            </Badge>
            <span className="font-mono text-muted-foreground">{diagnostic.path || '/'}</span>
          </div>
          <div className="mt-1">{diagnostic.message}</div>
        </div>
      ))}
    </div>
  );
}

function TimelinePanel() {
  const timeline = useWorkspaceStore((s) => s.timeline);
  if (timeline.length === 0) {
    return <p className="text-xs text-muted-foreground">No runtime outputs yet.</p>;
  }
  return (
    <div className="space-y-2">
      {timeline.slice(0, 8).map((entry) => (
        <div key={entry.id} className="rounded border p-2 text-xs">
          <div className="flex items-center gap-2">
            <Badge variant="outline">{entry.source}</Badge>
            <span>{entry.message}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function InspectorPanel({ nodes }: { nodes: AssetNode[] }) {
  const project = useWorkspaceStore((s) => s.project);
  const selectedAssetId = useWorkspaceStore((s) => s.selectedAssetId);
  const selectedRuntimeObjectId = useWorkspaceStore((s) => s.selectedRuntimeObjectId);
  const lastPreviewEvent = useWorkspaceStore((s) => s.lastPreviewEvent);
  const inspectorVisible = useWorkspaceStore((s) => s.inspectorVisible);
  const selected = findNode(nodes, selectedAssetId);
  const record = selectedRecord(project, selected);

  if (!inspectorVisible) return null;

  return (
    <div className="w-80 shrink-0 overflow-y-auto border-l bg-background">
      <div className="flex h-10 items-center border-b px-3">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Inspector
        </span>
      </div>
      <div className="space-y-4 p-3">
        {selectedRuntimeObjectId ? (
          <div className="space-y-2">
            <div className="text-xs text-muted-foreground">Runtime Object</div>
            <div className="text-sm font-medium">{selectedRuntimeObjectId}</div>
            {lastPreviewEvent?.type === 'object-clicked' ? (
              <div className="font-mono text-xs text-muted-foreground">
                pointer {lastPreviewEvent.pointerPosition.x.toFixed(2)},{' '}
                {lastPreviewEvent.pointerPosition.y.toFixed(2)}
              </div>
            ) : null}
            <Separator />
          </div>
        ) : null}

        {selected ? (
          <div className="space-y-3">
            <div>
              <div className="text-xs text-muted-foreground">Selection</div>
              <div className="text-sm font-medium">{selected.entityId ?? selected.label}</div>
              <Badge variant="outline" className="mt-1 font-mono text-xs">
                {selected.collection ?? selected.type}
              </Badge>
            </div>
            <pre className="max-h-72 overflow-auto rounded bg-muted p-2 font-mono text-[11px]">
              {JSON.stringify(record ?? selected, null, 2)}
            </pre>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">Select an entity, test, or runtime object to inspect.</p>
        )}

        <Separator />
        <div>
          <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Diagnostics
          </div>
          <DiagnosticsPanel />
        </div>
        <Separator />
        <div>
          <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Timeline
          </div>
          <TimelinePanel />
        </div>
      </div>
    </div>
  );
}

function WorkspacePage() {
  const [busy, setBusy] = useState(false);
  const inspectorVisible = useWorkspaceStore((s) => s.inspectorVisible);
  const setInspectorVisible = useWorkspaceStore((s) => s.setInspectorVisible);
  const previewRunning = useWorkspaceStore((s) => s.previewRunning);
  const setPreviewRunning = useWorkspaceStore((s) => s.setPreviewRunning);
  const previewConnectionState = useWorkspaceStore((s) => s.previewConnectionState);
  const statusMessage = useWorkspaceStore((s) => s.statusMessage);
  const project = useWorkspaceStore((s) => s.project);
  const projectPath = useWorkspaceStore((s) => s.projectPath);
  const tests = useWorkspaceStore((s) => s.playbackTests);
  const setProjectPath = useWorkspaceStore((s) => s.setProjectPath);
  const setProjectFilePath = useWorkspaceStore((s) => s.setProjectFilePath);
  const setProject = useWorkspaceStore((s) => s.setProject);
  const setDiagnostics = useWorkspaceStore((s) => s.setDiagnostics);
  const setPlaybackTests = useWorkspaceStore((s) => s.setPlaybackTests);
  const setLastPlaybackReport = useWorkspaceStore((s) => s.setLastPlaybackReport);
  const setLastExportResult = useWorkspaceStore((s) => s.setLastExportResult);
  const setStatusMessage = useWorkspaceStore((s) => s.setStatusMessage);
  const addTimelineEntry = useWorkspaceStore((s) => s.addTimelineEntry);
  const nodes = useMemo(() => buildProjectTree(project, tests), [project, tests]);

  async function openProject() {
    const dir = await window.noveltea.selectProjectDirectory();
    if (!dir) return;
    setBusy(true);
    try {
      const loaded = await window.noveltea.openProject(dir);
      setProjectPath(loaded.projectPath);
      setProjectFilePath(loaded.projectFilePath);
      setProject(loaded.project ?? null);
      setDiagnostics(loaded.diagnostics ?? []);
      if (loaded.project) {
        const listed = await window.noveltea.listPlaybackTests(loaded.project);
        setPlaybackTests(listed.tests ?? []);
      }
      setStatusMessage(loaded.success ? 'Project loaded' : loaded.error ?? 'Project loaded with diagnostics');
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : 'Project open failed');
    } finally {
      setBusy(false);
    }
  }

  async function validate() {
    if (!project) return;
    const result = await window.noveltea.validateProject(project);
    setDiagnostics(result.diagnostics ?? []);
    addTimelineEntry({ source: 'validation', message: result.success ? 'Validation passed' : 'Validation reported issues', detail: result });
  }

  async function runFirstTest() {
    if (!project || tests.length === 0) return;
    const result = await window.noveltea.runPlaybackTest(project, tests[0]!.id);
    setLastPlaybackReport(result.report ?? result);
    addTimelineEntry({ source: 'playback', message: `Ran playback ${tests[0]!.id}`, detail: result.report ?? result });
    setStatusMessage(result.ok ? `Playback ${tests[0]!.id} complete` : result.error ?? 'Playback failed');
  }

  async function exportRuntimePackage() {
    if (!project || !projectPath) return;
    const outputPath = `${projectPath.replace(/\/+$/, '')}/export.ntpkg`;
    const result = await window.noveltea.exportPackage(project, outputPath, {
      kind: 'runtime',
      projectName: 'NovelTea Export',
      projectVersion: '1.0',
    });
    setLastExportResult(result);
    addTimelineEntry({ source: 'export', message: result.success ? `Exported ${outputPath}` : 'Export failed', detail: result });
    setStatusMessage(result.success ? `Exported ${outputPath}` : result.error ?? 'Export failed');
  }

  return (
    <>
      <PageHeader
        title="Workspace"
        description={projectPath ?? 'Open a NovelTea project to inspect, validate, preview, and export it'}
        actions={
          <div className="flex items-center gap-1">
            <Button size="sm" variant="outline" onClick={openProject} disabled={busy}>
              Open
            </Button>
            <Button size="sm" variant="ghost" onClick={validate} disabled={!project}>
              Validate
            </Button>
            <Button size="sm" variant="ghost" onClick={runFirstTest} disabled={!project || tests.length === 0}>
              <FlaskConical className="h-4 w-4" />
            </Button>
            <Button size="sm" variant="ghost" onClick={exportRuntimePackage} disabled={!project}>
              <Package className="h-4 w-4" />
            </Button>
            <Separator orientation="vertical" className="mx-1 h-5" />
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
            <Button size="sm" variant="ghost" disabled={!project}>
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
        <div className="w-64 shrink-0 overflow-y-auto border-r bg-background p-2">
          {nodes.length > 0 ? (
            <AssetTree nodes={nodes} />
          ) : (
            <div className="p-3 text-xs text-muted-foreground">No project loaded.</div>
          )}
        </div>
        <div className="flex-1 overflow-hidden">
          <EnginePreview />
        </div>
        <InspectorPanel nodes={nodes} />
      </div>
      <div className="flex h-7 items-center border-t bg-muted/30 px-3">
        <span className="font-mono text-[10px] text-muted-foreground">
          {nodes.reduce((count, node) => count + (node.children?.length ?? 0), 0)} records
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
