import { ChevronDown, ChevronUp } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useCommandStore } from '@/commands/command-store';
import { useWorkspaceStore } from '@/stores/workspace-store';
import {
  bottomPanelDefinitions,
  type BottomPanelId,
  useBottomPanelStore,
} from './bottom-panel-store';

function JsonBlock({ value, empty }: { value: unknown; empty: string }) {
  if (value === null || value === undefined) {
    return <p className="p-3 text-xs text-muted-foreground">{empty}</p>;
  }
  return (
    <pre className="overflow-auto p-3 font-mono text-[11px] leading-relaxed">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function ProblemsPanel() {
  const diagnostics = useWorkspaceStore((state) => state.diagnostics);
  if (diagnostics.length === 0) {
    return <p className="p-3 text-xs text-muted-foreground">No validation diagnostics.</p>;
  }
  return (
    <div className="space-y-2 p-3">
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

function OutputPanel() {
  const timeline = useWorkspaceStore((state) => state.timeline);
  if (timeline.length === 0) {
    return <p className="p-3 text-xs text-muted-foreground">No output entries yet.</p>;
  }
  return (
    <div className="space-y-2 p-3">
      {timeline.map((entry) => (
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

function PreviewEventsPanel() {
  const lastPreviewEvent = useWorkspaceStore((state) => state.lastPreviewEvent);
  return <JsonBlock value={lastPreviewEvent} empty="No preview events yet." />;
}

function TestPlaybackPanel() {
  const lastPlaybackReport = useWorkspaceStore((state) => state.lastPlaybackReport);
  return <JsonBlock value={lastPlaybackReport} empty="No playback report yet." />;
}

function PackageExportPanel() {
  const lastExportResult = useWorkspaceStore((state) => state.lastExportResult);
  return <JsonBlock value={lastExportResult} empty="No package export result yet." />;
}

function CommandHistoryPanel() {
  const history = useCommandStore((state) => state.history);
  const lastDiagnostics = useCommandStore((state) => state.lastDiagnostics);
  if (history.entries.length === 0 && lastDiagnostics.length === 0) {
    return <p className="p-3 text-xs text-muted-foreground">No project commands yet.</p>;
  }
  return (
    <div className="space-y-2 p-3">
      {lastDiagnostics.length > 0 ? (
        <div className="rounded border p-2 text-xs">
          <div className="mb-1 font-medium">Last command diagnostics</div>
          {lastDiagnostics.map((diagnostic, index) => (
            <div key={`${diagnostic.message}-${index}`} className="flex gap-2">
              <Badge variant={diagnostic.severity === 'error' ? 'destructive' : 'secondary'}>
                {diagnostic.severity}
              </Badge>
              <span className="font-mono text-muted-foreground">{diagnostic.path ?? '/'}</span>
              <span>{diagnostic.message}</span>
            </div>
          ))}
        </div>
      ) : null}
      {history.entries.map((entry, index) => (
        <div key={entry.id} className={`rounded border p-2 text-xs ${index === history.cursor ? 'bg-accent/50' : ''}`}>
          <div className="flex items-center gap-2">
            <Badge variant={index <= history.cursor ? 'default' : 'outline'}>{index}</Badge>
            <span className="font-medium">{entry.label}</span>
            <span className="font-mono text-[10px] text-muted-foreground">{entry.type}</span>
          </div>
          <div className="mt-1 truncate font-mono text-[10px] text-muted-foreground">
            {entry.affectedPaths.join(', ') || '/'}
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyPanel({ label }: { label: string }) {
  return <p className="p-3 text-xs text-muted-foreground">{label}</p>;
}

function PanelContent({ panelId }: { panelId: BottomPanelId }) {
  switch (panelId) {
    case 'problems':
      return <ProblemsPanel />;
    case 'output':
      return <OutputPanel />;
    case 'preview-events':
      return <PreviewEventsPanel />;
    case 'test-playback':
      return <TestPlaybackPanel />;
    case 'shader-compile':
      return <EmptyPanel label="Shader compile diagnostics will appear here once the shader/material editor is implemented." />;
    case 'package-export':
      return <PackageExportPanel />;
    case 'command-history':
      return <CommandHistoryPanel />;
  }
}

export function BottomPanel() {
  const visible = useBottomPanelStore((state) => state.visible);
  const activePanelId = useBottomPanelStore((state) => state.activePanelId);
  const setActivePanelId = useBottomPanelStore((state) => state.setActivePanelId);
  const toggleVisible = useBottomPanelStore((state) => state.toggleVisible);
  const diagnostics = useWorkspaceStore((state) => state.diagnostics);

  return (
    <div className="flex h-full min-h-0 flex-col border-t bg-background">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b px-2">
        {bottomPanelDefinitions.map((panel) => (
          <button
            key={panel.id}
            type="button"
            onClick={() => setActivePanelId(panel.id)}
            className={`rounded px-2 py-1 text-xs transition-colors hover:bg-accent ${
              activePanelId === panel.id ? 'bg-accent text-accent-foreground' : 'text-muted-foreground'
            }`}
          >
            {panel.label}
            {panel.id === 'problems' && diagnostics.length > 0 ? (
              <span className="ml-1 rounded bg-muted px-1 font-mono text-[10px]">
                {diagnostics.length}
              </span>
            ) : null}
          </button>
        ))}
        <Button size="sm" variant="ghost" className="ml-auto h-7 w-7 p-0" onClick={toggleVisible}>
          {visible ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
        </Button>
      </div>
      {visible ? (
        <div className="min-h-0 flex-1 overflow-auto">
          <PanelContent panelId={activePanelId} />
        </div>
      ) : null}
    </div>
  );
}
