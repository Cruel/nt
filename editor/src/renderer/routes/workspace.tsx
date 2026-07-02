import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Group, Panel, Separator as ResizeSeparator } from 'react-resizable-panels';
import { Button } from '@/components/ui/button';
import { Dialog, DialogDescription, DialogPopup, DialogTitle } from '@/components/ui/dialog';
import { useCommandStore } from '@/commands/command-store';
import { selectProjectDirty, useProjectStore } from '@/project/project-store';
import { usePreferencesStore } from '@/stores/preferences-store';
import { buildProjectTree, useWorkspaceStore } from '@/stores/workspace-store';
import { BottomPanel } from '@/workbench/BottomPanel';
import { Workbench } from '@/workbench/Workbench';
import { useBottomPanelStore } from '@/workbench/bottom-panel-store';
import { runDraftActions, useDraftDirtyStore } from '@/workbench/draft-dirty-store';
import { buildEditorProjectStateSnapshot, clearLocalEditorSessionSnapshot, mergeEditorProjectState, restoreEditorProjectState, restoreNoProjectEditorSession, saveLocalEditorSessionSnapshot } from '@/workbench/project-editor-state';
import { buildPrimaryPreviewTab, buildProjectSettingsTab, buildTestDetailTabForRecord } from '@/workbench/editor-registry';
import { useWorkbenchStore } from '@/workbench/workbench-store';
import { PackageExportDialog } from '@/export/PackageExportDialog';
import { useRecentProjectsStore } from '@/workspace/recent-projects-store';
import { WORKSPACE_TOOLBAR_COMMAND_EVENT, type WorkspaceToolbarCommandDetail } from '@/workspace/workspace-toolbar-events';
import { createAuthoringProject, isAuthoringProject } from '../../shared/project-schema/authoring-project';
import { authoringValidationSucceeded, validateAuthoringProject } from '../../shared/project-schema/authoring-validation';
import type { ToolDiagnostic } from '../../shared/editor-tooling';

export const Route = createFileRoute('/workspace')({
  component: WorkspacePage,
});

function unsupportedProjectDiagnostics(): ToolDiagnostic[] {
  return [
    {
      severity: 'error',
      path: '/',
      message: 'Unsupported project schema. Create or open a NovelTea authoring project.',
      category: 'authoring-schema',
    },
  ];
}

function commandTouchedTests(paths: string[]) {
  return paths.some((path) => path === '/tests' || path.startsWith('/tests/'));
}

interface WorkspaceAlert {
  title: string;
  message: string;
}

export function WorkspacePage() {
  const [, setBusy] = useState(false);
  const [alert, setAlert] = useState<WorkspaceAlert | null>(null);
  const [packageExportOpen, setPackageExportOpen] = useState(false);
  const lastObservedCommandId = useRef<string | null>(null);
  const didAttemptStartupRestore = useRef(false);
  const completingWindowClose = useRef(false);
  const bottomPanelVisible = useBottomPanelStore((state) => state.visible);
  const setBottomPanelVisible = useBottomPanelStore((state) => state.setVisible);
  const hydrateBottomPanel = useBottomPanelStore((state) => state.hydrate);
  const setPreviewRunning = useWorkspaceStore((state) => state.setPreviewRunning);
  const previewConnectionState = useWorkspaceStore((state) => state.previewConnectionState);
  const statusMessage = useWorkspaceStore((state) => state.statusMessage);
  const project = useProjectStore((state) => state.document);
  const projectPath = useProjectStore((state) => state.projectPath);
  const projectFilePath = useProjectStore((state) => state.projectFilePath);
  const projectDirty = useProjectStore(selectProjectDirty);
  const draftEntries = useDraftDirtyStore((state) => state.entriesByKey);
  const hasDraftDirty = Object.values(draftEntries).some((entry) => entry.dirty);
  const saveDirty = projectDirty || hasDraftDirty;
  const isSaving = useProjectStore((state) => state.isSaving);
  const autosaveEnabled = useProjectStore((state) => state.autosaveEnabled);
  const loadProjectDocument = useProjectStore((state) => state.loadProjectDocument);
  const loadUnsavedProjectDocument = useProjectStore((state) => state.loadUnsavedProjectDocument);
  const clearProjectDocument = useProjectStore((state) => state.clearProject);
  const markProjectSaved = useProjectStore((state) => state.markSaved);
  const setProjectSaving = useProjectStore((state) => state.setSaving);
  const setProjectSaveError = useProjectStore((state) => state.setSaveError);
  const setAutosaveEnabled = useProjectStore((state) => state.setAutosaveEnabled);
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
  const addRecentProject = useRecentProjectsStore((state) => state.addRecentProject);
  const removeRecentProject = useRecentProjectsStore((state) => state.removeRecentProject);
  const restoreLastProjectOnStart = usePreferencesStore((state) => state.restoreLastProjectOnStart);
  const lastProjectPath = usePreferencesStore((state) => state.lastProjectPath);
  const setLastProjectPath = usePreferencesStore((state) => state.setLastProjectPath);
  const openWorkbenchTab = useWorkbenchStore((state) => state.openTab);
  const closeProjectTabs = useWorkbenchStore((state) => state.closeProjectTabs);
  const commandHistory = useCommandStore((state) => state.history);
  const lastCommandDiagnostics = useCommandStore((state) => state.lastDiagnostics);
  const undoCommand = useCommandStore((state) => state.undo);
  const executeCommand = useCommandStore((state) => state.executeCommand);
  const redoCommand = useCommandStore((state) => state.redo);
  const resetCommandHistory = useCommandStore((state) => state.resetCommandHistory);
  const nodes = useMemo(() => buildProjectTree(project, tests), [project, tests]);

  function loadAuthoringDocument(document: unknown, projectPathValue: string | null, projectFilePathValue: string | null) {
    setProjectPath(projectPathValue);
    setProjectFilePath(projectFilePathValue);
    setProject(document);
    loadProjectDocument({ document, projectPath: projectPathValue, projectFilePath: projectFilePathValue });
    resetCommandHistory();
    setPlaybackTests([]);
    if (document !== null && document !== undefined) restoreEditorProjectState(document as never, projectFilePathValue);
    const diagnostics = isAuthoringProject(document) ? validateAuthoringProject(document) : unsupportedProjectDiagnostics();
    setDiagnostics(diagnostics);
    return diagnostics;
  }

  function refreshRecentProjectEntry(document: unknown, projectPathValue?: string | null, projectFilePathValue?: string | null) {
    if (!projectPathValue && !projectFilePathValue) return;
    const entryPath = projectPathValue ?? projectPath ?? null;
    if (!entryPath) return;
    addRecentProject({
      projectPath: entryPath,
      projectFilePath: projectFilePathValue ?? null,
      projectName: isAuthoringProject(document) ? document.project.name : null,
    });
  }

  function createNewProject() {
    const next = createAuthoringProject();
    setProjectPath(null);
    setProjectFilePath(null);
    setProject(next);
    loadUnsavedProjectDocument(next);
    resetCommandHistory();
    setPlaybackTests([]);
    setDiagnostics(validateAuthoringProject(next));
    hydrateBottomPanel();
    setStatusMessage('Created unsaved authoring project');
    addTimelineEntry({ source: 'command', message: 'Created unsaved authoring project', detail: next });
  }

  async function dirtySaveProjectState(reason: 'close-project' | 'window-close') {
    const latestProject = useProjectStore.getState().document;
    const latestProjectFilePath = useProjectStore.getState().projectFilePath;
    saveLocalEditorSessionSnapshot(latestProjectFilePath ?? null);
    if (!latestProject || !latestProjectFilePath) return false;
    const projectWithEditorState = mergeEditorProjectState(latestProject, buildEditorProjectStateSnapshot());
    const result = await window.noveltea.saveProject(projectWithEditorState, latestProjectFilePath);
    if (!result.success) {
      const message = result.error ?? 'Editor state dirty save failed.';
      setStatusMessage(message);
      addTimelineEntry({ source: 'command', message, detail: result });
      return false;
    }
    refreshRecentProjectEntry(projectWithEditorState, result.projectPath ?? projectPath, result.projectFilePath ?? latestProjectFilePath);
    const message = reason === 'close-project' ? 'Saved editor state before closing project' : 'Saved editor state before closing editor';
    addTimelineEntry({ source: 'command', message, detail: result });
    return true;
  }

  async function closeProject() {
    await dirtySaveProjectState('close-project');
    clearLocalEditorSessionSnapshot();
    setLastProjectPath(null);
    clearProjectDocument();
    resetCommandHistory();
    closeProjectTabs();
    saveLocalEditorSessionSnapshot(null);
    setProjectPath(null);
    setProjectFilePath(null);
    setProject(null);
    setDiagnostics([]);
    setPlaybackTests([]);
    setLastPlaybackReport(null);
    setLastExportResult(null);
    setPreviewRunning(false);
    setBottomPanelVisible(false);
    setStatusMessage('No project loaded');
    addTimelineEntry({ source: 'command', message: 'Closed project' });
  }

  async function openProject(projectPathOverride?: string) {
    const dir = projectPathOverride ?? await window.noveltea.selectProjectDirectory();
    if (!dir) return;
    setBusy(true);
    try {
      const loaded = await window.noveltea.openProject(dir);
      if (Object.keys(useWorkbenchStore.getState().tabsById).length > 0) saveLocalEditorSessionSnapshot(loaded.projectFilePath ?? loaded.projectPath ?? null);
      const diagnostics = loadAuthoringDocument(loaded.project ?? null, loaded.projectPath, loaded.projectFilePath);
      refreshRecentProjectEntry(loaded.project, loaded.projectPath, loaded.projectFilePath);
      setLastProjectPath(loaded.projectFilePath ?? loaded.projectPath);
      setStatusMessage(
        isAuthoringProject(loaded.project)
          ? diagnostics.some((diagnostic) => diagnostic.severity === 'error')
            ? 'Authoring project loaded with diagnostics'
            : 'Authoring project loaded'
          : 'Unsupported project schema',
      );
    } catch (error) {
      clearProjectDocument();
      resetCommandHistory();
      setProjectPath(null);
      setProjectFilePath(null);
      setProject(null);
      setDiagnostics([]);
      setPlaybackTests([]);
      if (projectPathOverride) removeRecentProject(projectPathOverride);
      setStatusMessage(error instanceof Error ? error.message : 'Project open failed');
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (didAttemptStartupRestore.current || project) return;
    didAttemptStartupRestore.current = true;
    if (restoreLastProjectOnStart && lastProjectPath) {
      void openProject(lastProjectPath);
    } else {
      restoreNoProjectEditorSession();
    }
  });

  useEffect(() => window.noveltea.onAppWindowBeforeClose(() => {
    if (completingWindowClose.current) return;
    completingWindowClose.current = true;
    void dirtySaveProjectState('window-close').finally(() => {
      void window.noveltea.completeAppWindowExit();
    });
  }));

  async function saveProject(saveAs = false, reason: 'manual' | 'autosave' = 'manual') {
    if (!project) return false;
    setProjectSaving(true);
    try {
      const nonSerializableDrafts = Object.values(useDraftDirtyStore.getState().entriesByKey)
        .filter((entry) => entry.dirty && (!entry.schema || !entry.schemaVersion || entry.payload === undefined));
      if (nonSerializableDrafts.length > 0) {
        const applied = await runDraftActions(nonSerializableDrafts, 'apply');
        if (!applied) {
          const message = 'Apply local drafts before saving, or discard them.';
          setProjectSaveError(message);
          setStatusMessage(message);
          return false;
        }
      }
      const latestProject = useProjectStore.getState().document;
      if (!latestProject) return false;
      const projectWithEditorState = mergeEditorProjectState(latestProject, buildEditorProjectStateSnapshot());
      const latestProjectFilePath = useProjectStore.getState().projectFilePath;
      const result = saveAs || !latestProjectFilePath
        ? await window.noveltea.saveProjectAs(projectWithEditorState, latestProjectFilePath)
        : await window.noveltea.saveProject(projectWithEditorState, latestProjectFilePath);
      if (result.success) {
        markProjectSaved({ projectPath: result.projectPath, projectFilePath: result.projectFilePath, document: projectWithEditorState });
        refreshRecentProjectEntry(projectWithEditorState, result.projectPath ?? projectPath, result.projectFilePath ?? latestProjectFilePath);
        setProjectPath(result.projectPath ?? projectPath);
        setProjectFilePath(result.projectFilePath ?? projectFilePath);
        addTimelineEntry({ source: 'command', message: `${reason === 'autosave' ? 'Autosaved' : 'Saved'} ${result.projectFilePath ?? latestProjectFilePath}`, detail: result });
        setStatusMessage(`${reason === 'autosave' ? 'Autosaved' : 'Saved'} ${result.projectFilePath ?? latestProjectFilePath}`);
        return true;
      }
      setProjectSaveError(result.error ?? 'Save failed');
      addTimelineEntry({ source: 'command', message: result.error ?? 'Save failed', detail: result });
      setStatusMessage(result.error ?? 'Save failed');
      return false;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Save failed';
      setProjectSaveError(message);
      addTimelineEntry({ source: 'command', message, detail: error });
      setStatusMessage(message);
      return false;
    }
  }

  function undoProjectCommand() {
    const result = undoCommand();
    addTimelineEntry({ source: 'command', message: result.projectChanged ? 'Undo project command' : result.diagnostics[0]?.message ?? 'Nothing to undo', detail: result });
  }

  function redoProjectCommand() {
    const result = redoCommand();
    addTimelineEntry({ source: 'command', message: result.projectChanged ? 'Redo project command' : result.diagnostics[0]?.message ?? 'Nothing to redo', detail: result });
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.key.toLowerCase() === 's') {
        event.preventDefault();
        void saveProject(event.shiftKey);
      }
      const target = event.target as HTMLElement | null;
      const isTextInput = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if (isTextInput) return;
      if (event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) redoProjectCommand();
        else undoProjectCommand();
      } else if (event.key.toLowerCase() === 'y') {
        event.preventDefault();
        redoProjectCommand();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  useEffect(() => {
    const latest = commandHistory.entries[commandHistory.cursor];
    if (!latest || latest.id === lastObservedCommandId.current) return;
    lastObservedCommandId.current = latest.id;
    addTimelineEntry({ source: 'command', message: latest.label, detail: latest });
    setStatusMessage(latest.label);
    if (project && commandTouchedTests(latest.affectedPaths)) {
      setPlaybackTests([]);
    }
  });

  useEffect(() => {
    if (!autosaveEnabled || !saveDirty || !projectFilePath || isSaving || commandHistory.activeTransaction) return;
    if (lastCommandDiagnostics.some((diagnostic) => diagnostic.severity === 'error')) return;
    const timer = window.setTimeout(() => {
      void saveProject(false, 'autosave');
    }, 1000);
    return () => window.clearTimeout(timer);
  });

  useEffect(() => {
    if (!project) {
      setProject(null);
      setDiagnostics([]);
      return;
    }
    setProject(project);
    setDiagnostics(isAuthoringProject(project) ? validateAuthoringProject(project) : unsupportedProjectDiagnostics());
  }, [project, setProject, setDiagnostics]);

  function validate() {
    if (!project) return;
    const diagnostics = isAuthoringProject(project) ? validateAuthoringProject(project) : unsupportedProjectDiagnostics();
    setDiagnostics(diagnostics);
    addTimelineEntry({
      source: 'validation',
      message: authoringValidationSucceeded(diagnostics) ? 'Authoring validation passed' : 'Authoring validation reported issues',
      detail: diagnostics,
    });
  }

  async function importAssets() {
    if (!project) return;
    if (!projectFilePath) {
      const message = 'Save the project before importing assets.';
      setStatusMessage(message);
      setAlert({ title: 'Asset import unavailable', message });
      return;
    }
    setBusy(true);
    try {
      const result = await window.noveltea.importAssets(projectFilePath, { allowMultiple: true });
      if (!result.success || result.assets.length === 0) {
        const message = result.error ?? result.diagnostics[0]?.message ?? 'Asset import canceled.';
        setStatusMessage(message);
        if (result.error || result.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
          setAlert({ title: 'Asset import failed', message });
        }
        return;
      }
      const command = executeCommand({
        type: 'asset.importFiles',
        label: `Import ${result.assets.length} asset${result.assets.length === 1 ? '' : 's'}`,
        payload: { assets: result.assets },
      });
      const failure = command.diagnostics.find((diagnostic) => diagnostic.severity === 'error');
      if (failure) {
        setStatusMessage(failure.message);
        setAlert({ title: 'Asset import failed', message: failure.message });
      } else {
        setStatusMessage(`Imported ${result.assets.length} asset${result.assets.length === 1 ? '' : 's'}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Asset import failed.';
      setStatusMessage(message);
      setAlert({ title: 'Asset import failed', message });
    } finally {
      setBusy(false);
    }
  }

  function runFirstTest() {
    setLastPlaybackReport(null);
    const latestProject = useProjectStore.getState().document;
    if (isAuthoringProject(latestProject)) {
      const firstTest = Object.entries(latestProject.tests).sort(([left], [right]) => left.localeCompare(right))[0];
      if (!firstTest) {
        setStatusMessage('No tests exist yet. Create a test record in the Tests collection.');
        return;
      }
      const [testId, record] = firstTest;
      openWorkbenchTab(buildTestDetailTabForRecord(testId, record.label || testId));
      setStatusMessage(`Opened test ${testId}`);
      return;
    }
    if (tests.length === 0) {
      setStatusMessage('No playback tests are available.');
      return;
    }
    void window.noveltea.runPlaybackTest(latestProject, tests[0]!.id).then((result) => {
      setLastPlaybackReport(result.report ?? result);
      setStatusMessage(result.ok ? `Ran test ${tests[0]!.id}` : result.error ?? 'Test run failed');
      addTimelineEntry({ source: 'playback', message: result.ok ? `Ran test ${tests[0]!.id}` : result.error ?? 'Test run failed', detail: result });
    });
  }

  function exportRuntimePackage() {
    setLastExportResult(null);
    setPackageExportOpen(true);
    setBottomPanelVisible(true);
    useBottomPanelStore.getState().setActivePanelId('package-export');
  }

  function openProjectSettings() {
    openWorkbenchTab(buildProjectSettingsTab());
    setStatusMessage('Opened project settings');
  }

  useEffect(() => {
    function onToolbarCommand(event: Event) {
      const detail = (event as CustomEvent<WorkspaceToolbarCommandDetail>).detail;
      const command = typeof detail === 'string' ? detail : detail.command;
      switch (command) {
        case 'new-project':
          createNewProject();
          break;
        case 'open-project':
          void openProject(typeof detail === 'string' ? undefined : detail.projectPath);
          break;
        case 'close-project':
          void closeProject();
          break;
        case 'validate':
          validate();
          break;
        case 'project-settings':
          openProjectSettings();
          break;
        case 'import-assets':
          void importAssets();
          break;
        case 'run-first-test':
          runFirstTest();
          break;
        case 'export-package':
          exportRuntimePackage();
          break;
        case 'preview-play':
          openWorkbenchTab(buildPrimaryPreviewTab());
          setPreviewRunning(true);
          window.dispatchEvent(new CustomEvent('noveltea-preview-toolbar-play'));
          break;
        case 'preview-stop':
          openWorkbenchTab(buildPrimaryPreviewTab());
          setPreviewRunning(false);
          window.dispatchEvent(new CustomEvent('noveltea-preview-toolbar-stop'));
          break;
        case 'undo':
          undoProjectCommand();
          break;
        case 'redo':
          redoProjectCommand();
          break;
        case 'save':
          void saveProject(false);
          break;
        case 'save-as':
          void saveProject(true);
          break;
        case 'toggle-autosave':
          setAutosaveEnabled(!autosaveEnabled);
          break;
        case 'toggle-bottom-panel':
          if (project) setBottomPanelVisible(!bottomPanelVisible);
          break;
      }
    }

    window.addEventListener(WORKSPACE_TOOLBAR_COMMAND_EVENT, onToolbarCommand);
    return () => window.removeEventListener(WORKSPACE_TOOLBAR_COMMAND_EVENT, onToolbarCommand);
  });

  const showBottomPanel = project !== null && bottomPanelVisible;

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="min-w-0 flex-1 overflow-hidden">
          <Group orientation="vertical" className="h-full w-full">
            <Panel defaultSize={showBottomPanel ? '70%' : '100%'} minSize="240px">
              <Workbench />
            </Panel>
            {showBottomPanel
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
      <PackageExportDialog
        open={packageExportOpen}
        onOpenChange={setPackageExportOpen}
        project={isAuthoringProject(project) ? project : null}
        projectRoot={projectPath}
        projectFilePath={projectFilePath}
      />
      <Dialog open={alert !== null} onOpenChange={(open) => { if (!open) setAlert(null); }}>
        <DialogPopup>
          <DialogTitle>{alert?.title ?? 'Workspace warning'}</DialogTitle>
          <DialogDescription>{alert?.message}</DialogDescription>
          <div className="flex justify-end">
            <Button size="sm" onClick={() => setAlert(null)}>OK</Button>
          </div>
        </DialogPopup>
      </Dialog>
      <div className="flex h-7 items-center border-t bg-muted/30 px-3">
        <span className="font-mono text-[10px] text-muted-foreground">
          {nodes.reduce((count, node) => count + (node.children?.length ?? 0), 0)} records{saveDirty ? ' • dirty' : ''}{isSaving ? ' • saving' : ''}{autosaveEnabled ? ' • autosave' : ''}
        </span>
        <span className="mx-2 text-muted-foreground/30">|</span>
        <span className="font-mono text-[10px] text-muted-foreground">
          Preview {previewConnectionState}
        </span>
        <span className="mx-2 text-muted-foreground/30">|</span>
        <span className="truncate font-mono text-[10px] text-muted-foreground">{statusMessage}</span>
      </div>
    </div>
  );
}
