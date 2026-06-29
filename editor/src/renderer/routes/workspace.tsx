import { createFileRoute } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { Group, Panel, Separator as ResizeSeparator } from 'react-resizable-panels';
import { Eye, FlaskConical, Package, Play, Save, Square } from 'lucide-react';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { buildProjectTree, useWorkspaceStore } from '@/stores/workspace-store';
import { BottomPanel } from '@/workbench/BottomPanel';
import { Workbench } from '@/workbench/Workbench';
import { useBottomPanelStore } from '@/workbench/bottom-panel-store';
import { buildPrimaryPreviewTab } from '@/workbench/editor-registry';
import { useWorkbenchStore } from '@/workbench/workbench-store';
import { ProjectExplorer } from '@/workspace/ProjectExplorer';

export const Route = createFileRoute('/workspace')({
  component: WorkspacePage,
});

function WorkspacePage() {
  const [busy, setBusy] = useState(false);
  const bottomPanelVisible = useBottomPanelStore((state) => state.visible);
  const setBottomPanelVisible = useBottomPanelStore((state) => state.setVisible);
  const previewRunning = useWorkspaceStore((state) => state.previewRunning);
  const setPreviewRunning = useWorkspaceStore((state) => state.setPreviewRunning);
  const previewConnectionState = useWorkspaceStore((state) => state.previewConnectionState);
  const statusMessage = useWorkspaceStore((state) => state.statusMessage);
  const project = useWorkspaceStore((state) => state.project);
  const projectPath = useWorkspaceStore((state) => state.projectPath);
  const tests = useWorkspaceStore((state) => state.playbackTests);
  const setProjectPath = useWorkspaceStore((state) => state.setProjectPath);
  const setProjectFilePath = useWorkspaceStore((state) => state.setProjectFilePath);
  const setProject = useWorkspaceStore((state) => state.setProject);
  const setDiagnostics = useWorkspaceStore((state) => state.setDiagnostics);
  const setPlaybackTests = useWorkspaceStore((state) => state.setPlaybackTests);
  const setLastPlaybackReport = useWorkspaceStore((state) => state.setLastPlaybackReport);
  const setLastExportResult = useWorkspaceStore((state) => state.setLastExportResult);
  const setStatusMessage = useWorkspaceStore((state) => state.setStatusMessage);
  const addTimelineEntry = useWorkspaceStore((state) => state.addTimelineEntry);
  const openWorkbenchTab = useWorkbenchStore((state) => state.openTab);
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
    addTimelineEntry({
      source: 'validation',
      message: result.success ? 'Validation passed' : 'Validation reported issues',
      detail: result,
    });
  }

  async function runFirstTest() {
    if (!project || tests.length === 0) return;
    const result = await window.noveltea.runPlaybackTest(project, tests[0]!.id);
    setLastPlaybackReport(result.report ?? result);
    addTimelineEntry({
      source: 'playback',
      message: `Ran playback ${tests[0]!.id}`,
      detail: result.report ?? result,
    });
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
    addTimelineEntry({
      source: 'export',
      message: result.success ? `Exported ${outputPath}` : 'Export failed',
      detail: result,
    });
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
                openWorkbenchTab(buildPrimaryPreviewTab());
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
                openWorkbenchTab(buildPrimaryPreviewTab());
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
              variant={bottomPanelVisible ? 'secondary' : 'ghost'}
              onClick={() => setBottomPanelVisible(!bottomPanelVisible)}
            >
              <Eye className="h-4 w-4" />
            </Button>
          </div>
        }
      />
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="w-64 shrink-0 overflow-y-auto border-r bg-background p-2">
          <ProjectExplorer nodes={nodes} />
        </div>
        <div className="min-w-0 flex-1 overflow-hidden">
          <Group orientation="vertical" className="h-full w-full">
            <Panel defaultSize={bottomPanelVisible ? '70%' : '100%'} minSize="240px">
              <Workbench />
            </Panel>
            {bottomPanelVisible
              ? [
                  <ResizeSeparator
                    key="bottom-panel-resize"
                    className="h-1.5 cursor-row-resize bg-border transition-colors hover:bg-primary/40 data-[resize-handle-active]:bg-primary/50"
                  />,
                  <Panel key="bottom-panel" defaultSize="30%" minSize="180px" maxSize="70%">
                    <BottomPanel />
                  </Panel>,
                ]
              : null}
          </Group>
        </div>
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
        <span className="truncate font-mono text-[10px] text-muted-foreground">{statusMessage}</span>
      </div>
    </>
  );
}
