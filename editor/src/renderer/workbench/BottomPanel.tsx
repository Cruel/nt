import { ChevronDown, ChevronUp } from 'lucide-react';
import { useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useCommandStore } from '@/commands/command-store';
import { DiagnosticList } from '@/diagnostics/DiagnosticList';
import { resolveProjectDiagnosticTarget } from '@/diagnostics/diagnostic-navigation';
import { useProjectStore } from '@/project/project-store';
import { useWorkspaceStore } from '@/stores/workspace-store';
import { usePreferencesStore } from '@/stores/preferences-store';
import { isAuthoringProject } from '../../shared/project-schema/authoring-project';
import {
  availableBottomPanelDefinitions,
  type BottomPanelId,
  resolveAvailableBottomPanelId,
  useBottomPanelStore,
} from './bottom-panel-store';
import { ReferencesPanel } from './ReferencesPanel';
import { PreviewDiagnosticsPanel } from './PreviewDiagnosticsPanel';
import { ShaderCompilePanel } from '@/shaders/ShaderCompilePanel';
import { PackageExportPanel } from '@/export/PackageExportPanel';
import { TestPlaybackPanel } from './TestPlaybackPanel';
import { TerminalPanel } from './TerminalPanel';
import { AssetPerformancePanel } from '@/asset-profiler/AssetPerformancePanel';
import { usePreviewManagerStore } from '@/preview/preview-manager-store';
import { terminalHasUnreadAttention, useTerminalAttentionStore } from './terminal-attention-store';
import { selectWindowTerminalSession } from './terminal-window-host';

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
  const { t } = useTranslation('workspace');
  const diagnostics = useWorkspaceStore((state) => state.diagnostics);
  const developerMode = usePreferencesStore((state) => state.developerMode);
  const projectDocument = useProjectStore((state) => state.document);
  const project = isAuthoringProject(projectDocument) ? projectDocument : null;
  const diagnosticItems = useMemo(
    () =>
      diagnostics.map((diagnostic) => ({
        ...diagnostic,
        target: project ? resolveProjectDiagnosticTarget(project, diagnostic) : null,
      })),
    [diagnostics, project],
  );
  if (diagnostics.length === 0) {
    return <p className="p-3 text-xs text-muted-foreground">{t('bottomPanel.empty.problems')}</p>;
  }
  return (
    <div className="p-3 text-xs">
      <DiagnosticList items={diagnosticItems} showPath={developerMode} compact />
    </div>
  );
}

function OutputPanel() {
  const { t } = useTranslation('workspace');
  const timeline = useWorkspaceStore((state) => state.timeline);
  if (timeline.length === 0) {
    return <p className="p-3 text-xs text-muted-foreground">{t('bottomPanel.empty.output')}</p>;
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
  const { t } = useTranslation('workspace');
  const lastPreviewEvent = useWorkspaceStore((state) => state.lastPreviewEvent);
  return <JsonBlock value={lastPreviewEvent} empty={t('bottomPanel.empty.previewEvents')} />;
}

function CommandHistoryPanel() {
  const { t } = useTranslation('workspace');
  const history = useCommandStore((state) => state.history);
  const lastDiagnostics = useCommandStore((state) => state.lastDiagnostics);
  const projectDocument = useProjectStore((state) => state.document);
  const project = isAuthoringProject(projectDocument) ? projectDocument : null;
  const lastDiagnosticItems = useMemo(
    () =>
      lastDiagnostics.map((diagnostic) => ({
        severity: diagnostic.severity,
        message: diagnostic.message,
        path: diagnostic.path,
        category: diagnostic.commandType,
        target: project ? resolveProjectDiagnosticTarget(project, diagnostic.path) : null,
      })),
    [lastDiagnostics, project],
  );
  if (history.entries.length === 0 && lastDiagnostics.length === 0) {
    return (
      <p className="p-3 text-xs text-muted-foreground">{t('bottomPanel.empty.commandHistory')}</p>
    );
  }
  return (
    <div className="space-y-2 p-3">
      {lastDiagnostics.length > 0 ? (
        <div className="rounded border p-2 text-xs">
          <div className="mb-1 font-medium">{t('bottomPanel.lastCommandDiagnostics')}</div>
          <DiagnosticList items={lastDiagnosticItems} />
        </div>
      ) : null}
      {history.entries.map((entry, index) => (
        <div
          key={entry.id}
          className={`rounded border p-2 text-xs ${index === history.cursor ? 'bg-accent/50' : ''}`}
        >
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

function PanelContent({ panelId }: { panelId: BottomPanelId }) {
  switch (panelId) {
    case 'problems':
      return <ProblemsPanel />;
    case 'output':
      return <OutputPanel />;
    case 'preview-events':
      return <PreviewEventsPanel />;
    case 'preview-diagnostics':
      return <PreviewDiagnosticsPanel />;
    case 'test-playback':
      return <TestPlaybackPanel />;
    case 'references':
      return <ReferencesPanel />;
    case 'shader-compile':
      return <ShaderCompilePanel />;
    case 'package-export':
      return <PackageExportPanel />;
    case 'asset-performance':
      return <AssetPerformancePanel />;
    case 'command-history':
      return <CommandHistoryPanel />;
    case 'terminal':
      return <TerminalPanel />;
  }
}

export function BottomPanel() {
  const { t } = useTranslation('workspace');
  const visible = useBottomPanelStore((state) => state.visible);
  const activePanelId = useBottomPanelStore((state) => state.activePanelId);
  const setActivePanelId = useBottomPanelStore((state) => state.setActivePanelId);
  const setVisible = useBottomPanelStore((state) => state.setVisible);
  const toggleVisible = useBottomPanelStore((state) => state.toggleVisible);
  const diagnostics = useWorkspaceStore((state) => state.diagnostics);
  const hasProject = useProjectStore((state) => state.document !== null);
  const availabilityContext = { hasProject };
  const availablePanels = availableBottomPanelDefinitions(availabilityContext);
  const resolvedActivePanelId = resolveAvailableBottomPanelId(activePanelId, availabilityContext);
  const terminalAttention = useTerminalAttentionStore((state) => state.attentionBySession);
  const terminalHasUnread = terminalHasUnreadAttention(terminalAttention);
  const previewErrorCount = usePreviewManagerStore((state) =>
    state.diagnosticOrder.reduce(
      (count, id) => count + (state.diagnosticsById[id]?.severity === 'error' ? 1 : 0),
      0,
    ),
  );
  const terminalVisible = visible && resolvedActivePanelId === 'terminal';

  useEffect(() => {
    useTerminalAttentionStore.getState().setPanelVisible(terminalVisible);
  }, [terminalVisible]);

  useEffect(
    () =>
      window.noveltea.onTerminalEvent((event) => {
        if (event.kind !== 'attention') return;
        const newlyUnread = useTerminalAttentionStore
          .getState()
          .receiveAttention(event.sessionId, event.attention);
        if (newlyUnread && usePreferencesStore.getState().terminal.desktopNotifications) {
          void window.noveltea.showTerminalNotification({
            sessionId: event.sessionId,
            kind: event.attention.kind,
          });
        }
      }),
    [],
  );

  useEffect(
    () =>
      window.noveltea.onTerminalNotificationClick(({ sessionId }) => {
        const attentionStore = useTerminalAttentionStore.getState();
        attentionStore.acknowledgeSelectionChange(sessionId);
        attentionStore.setSelectedSessionId(sessionId);
        setActivePanelId('terminal');
        void selectWindowTerminalSession(sessionId);
      }),
    [setActivePanelId],
  );

  function selectPanel(panelId: BottomPanelId) {
    if (visible && resolvedActivePanelId === panelId) {
      setVisible(false);
      return;
    }
    setActivePanelId(panelId);
  }

  return (
    <div className="@container flex h-full min-h-0 flex-col border-t bg-background">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b px-2">
        {availablePanels.map((panel) => (
          <button
            key={panel.id}
            type="button"
            onClick={() => selectPanel(panel.id)}
            className={`rounded px-2 py-1 text-xs transition-colors hover:bg-accent ${
              resolvedActivePanelId === panel.id
                ? 'bg-accent text-accent-foreground'
                : 'text-muted-foreground'
            }`}
          >
            {t(panel.labelKey)}
            {panel.id === 'problems' && diagnostics.length > 0 ? (
              <span className="ml-1 rounded bg-muted px-1 font-mono text-[10px]">
                {diagnostics.length}
              </span>
            ) : null}
            {panel.id === 'preview-diagnostics' && previewErrorCount > 0 ? (
              <span
                className="ml-1 rounded bg-destructive px-1 font-mono text-[10px] text-destructive-foreground"
                aria-label={`${previewErrorCount} preview error${previewErrorCount === 1 ? '' : 's'}`}
                data-preview-diagnostics-error-count
              >
                {previewErrorCount}
              </span>
            ) : null}
            {panel.id === 'terminal' && terminalHasUnread ? (
              <span
                className="ml-1 inline-block size-1.5 rounded-full bg-current align-middle"
                aria-label={t('terminal.needsAttention')}
                data-terminal-aggregate-unread
              />
            ) : null}
          </button>
        ))}
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto h-7 w-7 p-0"
          onClick={toggleVisible}
          title={t('bottomPanel.toggle')}
        >
          {visible ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
        </Button>
      </div>
      {visible && resolvedActivePanelId ? (
        <div className="min-h-0 flex-1 overflow-auto">
          <PanelContent panelId={resolvedActivePanelId} />
        </div>
      ) : null}
    </div>
  );
}
