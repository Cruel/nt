import { createFileRoute } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Group, Panel } from 'react-resizable-panels';
import { Button } from '@/components/ui/button';
import { Dialog, DialogDescription, DialogFooter, DialogPopup, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PanelResizeSeparator } from '@/components/resize-separator';
import { UntrackedAssetsDialog } from '@/assets/UntrackedAssetsDialog';
import { CommandPaletteDialog } from '@/workspace/CommandPaletteDialog';
import { useAssetTrashStore } from '@/assets/asset-trash-store';
import { ComfyUiStatusIndicator } from '@/comfyui/ComfyUiStatusIndicator';
import { bestComfyUiErrorMessage, cancelComfyUiJob, editComfyUiImage, generateComfyUiImage, subscribeComfyUiProgress } from '@/comfyui/comfyui-service';
import { useComfyUiGenerationStore, type GeneratedImageRevision } from '@/comfyui/comfyui-generation-store';
import { useComfyUiQueueStore } from '@/comfyui/comfyui-queue-store';
import { useComfyUiStore } from '@/comfyui/comfyui-store';
import { useCommandStore } from '@/commands/command-store';
import { selectProjectDirty, useProjectStore } from '@/project/project-store';
import { usePreferencesStore } from '@/stores/preferences-store';
import { buildProjectTree, useWorkspaceStore } from '@/stores/workspace-store';
import { BottomPanel } from '@/workbench/BottomPanel';
import { useCloseGuardStore } from '@/workbench/close-guard-store';
import { Workbench } from '@/workbench/Workbench';
import { useBottomPanelStore } from '@/workbench/bottom-panel-store';
import { runDraftActions, useDraftDirtyStore } from '@/workbench/draft-dirty-store';
import { buildEditorProjectStateSnapshot, clearLocalEditorSessionSnapshot, mergeEditorProjectState, restoreEditorProjectState, restoreNoProjectEditorSession, saveLocalEditorSessionSnapshot } from '@/workbench/project-editor-state';
import { buildFullGamePreviewTab, buildPlatformExportTab, buildProjectSettingsTab, buildTestDetailTabForRecord } from '@/workbench/editor-registry';
import { useWorkbenchStore } from '@/workbench/workbench-store';
import { useRecentProjectsStore } from '@/workspace/recent-projects-store';
import { dispatchWorkspaceToolbarCommand, WORKSPACE_TOOLBAR_COMMAND_EVENT, type WorkspaceToolbarCommandDetail } from '@/workspace/workspace-toolbar-events';
import { isAuthoringProject } from '../../shared/project-schema/authoring-project';
import { authoringValidationSucceeded, validateAuthoringProject } from '../../shared/project-schema/authoring-validation';
import type { ToolDiagnostic } from '../../shared/editor-tooling';
import type { ProjectAssetAuditFile } from '../../shared/project-asset-audit';

export const Route = createFileRoute('/workspace')({
  component: WorkspacePage,
});

function unsupportedProjectDiagnostics(): ToolDiagnostic[] {
  return [
    {
      severity: 'error',
      path: '/',
      message: 'Unsupported project schema. Create or open a NovelTea project.',
      category: 'Project schema',
    },
  ];
}

function commandTouchedTests(paths: string[]) {
  return paths.some((path) => path === '/tests' || path.startsWith('/tests/'));
}

function projectSlug(value: string) {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : null;
}

function joinProjectPath(parent: string, child: string) {
  const separator = parent.includes('\\') && !parent.includes('/') ? '\\' : '/';
  return `${parent.replace(/[\\/]+$/, '')}${separator}${child}`;
}

function pathContainsSpaces(value: string) {
  return /\s/.test(value);
}

interface WorkspaceAlert {
  title: string;
  message: string;
}

export function WorkspacePage() {
  const [, setBusy] = useState(false);
  const [alert, setAlert] = useState<WorkspaceAlert | null>(null);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [newProjectName, setNewProjectName] = useState('New Project');
  const [newProjectDirectory, setNewProjectDirectory] = useState('');
  const [newProjectDirectoryEdited, setNewProjectDirectoryEdited] = useState(false);
  const [newProjectDefaultDirectory, setNewProjectDefaultDirectory] = useState('');
  const [newProjectCreating, setNewProjectCreating] = useState(false);
  const [newProjectError, setNewProjectError] = useState<string | null>(null);
  const [untrackedAssetFiles, setUntrackedAssetFiles] = useState<ProjectAssetAuditFile[]>([]);
  const [untrackedAssetDialogOpen, setUntrackedAssetDialogOpen] = useState(false);
  const lastObservedCommandId = useRef<string | null>(null);
  const didAttemptStartupRestore = useRef(false);
  const ignoredUntrackedAssetPaths = useRef<Set<string>>(new Set());
  const lastAssetAuditProjectFilePath = useRef<string | null>(null);
  const latestProjectFilePathRef = useRef<string | null>(null);
  const completingWindowClose = useRef(false);
  const bottomPanelVisible = useBottomPanelStore((state) => state.visible);
  const bottomPanelSizePercent = useBottomPanelStore((state) => state.sizePercent);
  const setBottomPanelVisible = useBottomPanelStore((state) => state.setVisible);
  const setBottomPanelSizePercent = useBottomPanelStore((state) => state.setSizePercent);
  const checkComfyUiConnection = useComfyUiStore((state) => state.checkConnection);
  const comfyUiConfig = useComfyUiStore((state) => state.config);
  const setComfyUiProgress = useComfyUiStore((state) => state.setProgress);
  const updateComfyUiQueueProgress = useComfyUiQueueStore((state) => state.updateProgress);
  const clearComfyUiProjectQueue = useComfyUiQueueStore((state) => state.clearProject);
  const comfyUiQueueOrder = useComfyUiQueueStore((state) => state.order);
  const comfyUiJobsByPromptId = useComfyUiQueueStore((state) => state.jobsByPromptId);
  const beginComfyUiJob = useComfyUiQueueStore((state) => state.beginJob);
  const failComfyUiJob = useComfyUiQueueStore((state) => state.failJob);
  const removeComfyUiJob = useComfyUiQueueStore((state) => state.removeJob);
  const nextQueuedComfyUiJob = useComfyUiQueueStore((state) => state.nextQueuedJob);
  const appendComfyUiRevisions = useComfyUiGenerationStore((state) => state.appendRevisions);
  const clearComfyUiRevisions = useComfyUiGenerationStore((state) => state.clearProjectSession);
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
  const loadProjectDocument = useProjectStore((state) => state.loadProjectDocument);
  const clearProjectDocument = useProjectStore((state) => state.clearProject);
  const markProjectSaved = useProjectStore((state) => state.markSaved);
  const setProjectSaving = useProjectStore((state) => state.setSaving);
  const setProjectSaveError = useProjectStore((state) => state.setSaveError);
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
  const defaultProjectDirectory = usePreferencesStore((state) => state.defaultProjectDirectory);
  const setLastProjectPath = usePreferencesStore((state) => state.setLastProjectPath);
  const openWorkbenchTab = useWorkbenchStore((state) => state.openTab);
  const closeProjectTabs = useWorkbenchStore((state) => state.closeProjectTabs);
  const commandHistory = useCommandStore((state) => state.history);
  const undoCommand = useCommandStore((state) => state.undo);
  const executeCommand = useCommandStore((state) => state.executeCommand);
  const redoCommand = useCommandStore((state) => state.redo);
  const deletedAssetTrash = useAssetTrashStore((state) => state.deletedAssets);
  const forgetDeletedAsset = useAssetTrashStore((state) => state.forgetDeletedAsset);
  const clearAssetTrashProject = useAssetTrashStore((state) => state.clearProject);
  const resetCommandHistory = useCommandStore((state) => state.resetCommandHistory);
  const nodes = useMemo(() => buildProjectTree(project, tests), [project, tests]);

  useEffect(() => {
    latestProjectFilePathRef.current = projectFilePath;
  }, [projectFilePath]);

  useEffect(() => {
    if (defaultProjectDirectory) {
      setNewProjectDefaultDirectory(defaultProjectDirectory);
      return;
    }
    let mounted = true;
    void window.noveltea.getDefaultProjectDirectory().then((directory) => {
      if (mounted) setNewProjectDefaultDirectory(directory);
    });
    return () => {
      mounted = false;
    };
  }, [defaultProjectDirectory]);

  useEffect(() => {
    if (newProjectDirectoryEdited) return;
    const slug = projectSlug(newProjectName);
    if (!slug || !newProjectDefaultDirectory) return;
    setNewProjectDirectory(joinProjectPath(newProjectDefaultDirectory, slug));
  }, [newProjectDefaultDirectory, newProjectDirectoryEdited, newProjectName]);

  function loadAuthoringDocument(document: unknown, projectPathValue: string | null, projectFilePathValue: string | null) {
    setProjectPath(projectPathValue);
    setProjectFilePath(projectFilePathValue);
    setProject(document);
    loadProjectDocument({ document, projectPath: projectPathValue, projectFilePath: projectFilePathValue });
    resetCommandHistory();
    setPlaybackTests([]);
    restoreEditorProjectState(document as never, projectFilePathValue);
    const diagnostics = validateAuthoringProject(document);
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

  async function resolveNewProjectParentDirectory() {
    if (defaultProjectDirectory) return defaultProjectDirectory;
    if (newProjectDefaultDirectory) return newProjectDefaultDirectory;
    const directory = await window.noveltea.getDefaultProjectDirectory();
    setNewProjectDefaultDirectory(directory);
    return directory;
  }

  async function openNewProjectDialog() {
    const projectName = 'New Project';
    const parentDirectory = await resolveNewProjectParentDirectory();
    const slug = projectSlug(projectName) ?? 'new-project';
    setNewProjectName(projectName);
    setNewProjectDirectory(joinProjectPath(parentDirectory, slug));
    setNewProjectDirectoryEdited(false);
    setNewProjectError(null);
    setNewProjectOpen(true);
  }

  async function browseNewProjectDirectory() {
    const directory = await window.noveltea.selectDirectory({
      title: 'Select New Project Directory',
      defaultPath: newProjectDirectory || await resolveNewProjectParentDirectory(),
    });
    if (!directory) return;
    setNewProjectDirectory(directory);
    setNewProjectDirectoryEdited(true);
    setNewProjectError(null);
  }

  async function createNewProject() {
    const name = newProjectName.trim();
    const directory = newProjectDirectory.trim();
    const slug = projectSlug(name);
    if (!name) {
      setNewProjectError('Project name is required.');
      return;
    }
    if (!slug) {
      setNewProjectError('Project name must contain at least one letter or number.');
      return;
    }
    if (!directory) {
      setNewProjectError('Project directory is required.');
      return;
    }
    if (pathContainsSpaces(directory)) {
      setNewProjectError('Project paths must not contain spaces.');
      return;
    }
    setNewProjectCreating(true);
    setNewProjectError(null);
    try {
      const result = await window.noveltea.createProject({ projectName: name, projectDirectory: directory });
      if (!result.success || !result.projectFilePath) {
        setNewProjectError(result.error ?? 'Project creation failed.');
        return;
      }
      setNewProjectOpen(false);
      await openProject(result.projectFilePath);
      setStatusMessage(`Created project ${name}`);
      addTimelineEntry({ source: 'command', message: `Created project ${name}`, detail: result });
    } catch (error) {
      setNewProjectError(error instanceof Error ? error.message : 'Project creation failed.');
    } finally {
      setNewProjectCreating(false);
    }
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

  async function cancelAndClearComfyUiProjectJobs(projectFilePathValue: string | null) {
    const queueState = useComfyUiQueueStore.getState();
    const projectJobs = queueState.order
      .map((promptId) => queueState.jobsByPromptId[promptId])
      .filter((job) => job && (!projectFilePathValue || job.projectFilePath === projectFilePathValue));
    const hasRunningJob = projectJobs.some((job) => job.state === 'running' || job.state === 'finalizing');
    if (hasRunningJob) await cancelComfyUiJob(useComfyUiStore.getState().config);
    clearComfyUiProjectQueue(projectFilePathValue);
    clearComfyUiRevisions();
  }

  const runAssetAudit = useCallback(async (projectOverride: unknown = useProjectStore.getState().document) => {
    const latestProjectFilePath = useProjectStore.getState().projectFilePath;
    if (!latestProjectFilePath || !projectOverride) return;
    const result = await window.noveltea.auditProjectAssets(latestProjectFilePath, projectOverride);
    if (!result.success) {
      const message = result.error ?? result.diagnostics[0]?.message ?? 'Asset audit failed.';
      setStatusMessage(message);
      return;
    }
    if (latestProjectFilePath !== latestProjectFilePathRef.current || !useProjectStore.getState().document) return;
    const visibleFiles = result.untrackedFiles.filter((file) => !ignoredUntrackedAssetPaths.current.has(file.projectRelativePath));
    setUntrackedAssetFiles(visibleFiles);
    if (visibleFiles.length > 0) {
      setUntrackedAssetDialogOpen(true);
      setStatusMessage(`Detected ${visibleFiles.length} untracked asset file${visibleFiles.length === 1 ? '' : 's'}`);
    }
  }, [setStatusMessage]);

  async function closeProject() {
    await dirtySaveProjectState('close-project');
    await cancelAndClearComfyUiProjectJobs(projectFilePath);
    if (projectFilePath) await window.noveltea.purgeProjectTrash(projectFilePath);
    if (projectFilePath) clearAssetTrashProject(projectFilePath);
    await window.noveltea.stopProjectAssetWatcher();
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
    setBottomPanelVisible(false);
    ignoredUntrackedAssetPaths.current = new Set();
    setUntrackedAssetFiles([]);
    setUntrackedAssetDialogOpen(false);
    setStatusMessage('No project loaded');
    addTimelineEntry({ source: 'command', message: 'Closed project' });
  }

  async function openProject(projectPathOverride?: string) {
    const dir = projectPathOverride ?? await window.noveltea.selectProjectDirectory();
    if (!dir) return;
    setBusy(true);
    try {
      if (Object.keys(useWorkbenchStore.getState().tabsById).length > 0) saveLocalEditorSessionSnapshot(projectFilePath ?? null);
      await cancelAndClearComfyUiProjectJobs(projectFilePath);
      const loaded = await window.noveltea.openProject(dir);
      if (!isAuthoringProject(loaded.project)) {
        clearProjectDocument();
        resetCommandHistory();
        closeProjectTabs();
        setProjectPath(null);
        setProjectFilePath(null);
        setProject(null);
        setDiagnostics(unsupportedProjectDiagnostics());
        setPlaybackTests([]);
        setLastPlaybackReport(null);
        setLastExportResult(null);
        setLastProjectPath(null);
        setStatusMessage('Unsupported project schema');
        setAlert({
          title: 'Project format is not supported',
          message: 'This project was created with an older or unsupported NovelTea format and cannot be opened by this version of the editor.',
        });
        return;
      }
      closeProjectTabs();
      const diagnostics = loadAuthoringDocument(loaded.project, loaded.projectPath, loaded.projectFilePath);
      refreshRecentProjectEntry(loaded.project, loaded.projectPath, loaded.projectFilePath);
      setLastProjectPath(loaded.projectFilePath ?? loaded.projectPath);
      setStatusMessage(
        diagnostics.some((diagnostic) => diagnostic.severity === 'error')
          ? 'Project loaded with diagnostics'
          : 'Project loaded',
      );
    } catch (error) {
      clearProjectDocument();
      resetCommandHistory();
      closeProjectTabs();
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
    const unsubscribe = subscribeComfyUiProgress((progress) => {
      setComfyUiProgress(progress);
      updateComfyUiQueueProgress(progress);
    });
    return unsubscribe;
  }, [setComfyUiProgress, updateComfyUiQueueProgress]);

  useEffect(() => {
    const job = nextQueuedComfyUiJob();
    if (!job) return;
    beginComfyUiJob(job.promptId);
    void (async () => {
      try {
        const response = job.kind === 'generate'
          ? await generateComfyUiImage(job.config, job.request)
          : await editComfyUiImage(job.config, job.request);
        if (!response.success) throw new Error(`ComfyUI image job failed: ${bestComfyUiErrorMessage(response)}`);
        const revisions: GeneratedImageRevision[] = response.assets.map((item) => ({
          id: `${item.promptId}:${item.projectRelativePath}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
          asset: item.asset,
          promptId: item.promptId,
          workflowId: item.workflowId,
          mode: job.kind,
          prompt: item.prompt,
          seed: item.seed,
          projectRelativePath: item.projectRelativePath,
          absolutePath: item.absolutePath,
          previewUrl: item.previewUrl,
          createdAt: item.createdAt,
        }));
        for (const revision of revisions) ignoredUntrackedAssetPaths.current.add(revision.projectRelativePath);
        appendComfyUiRevisions(job.tabId, revisions);
        removeComfyUiJob(job.promptId);
      } catch (error) {
        const latest = useComfyUiQueueStore.getState().jobsByPromptId[job.promptId];
        if (latest?.state === 'interrupted') return;
        failComfyUiJob(job.promptId, error instanceof Error ? error.message : 'ComfyUI image job failed.');
      }
    })();
  }, [appendComfyUiRevisions, beginComfyUiJob, comfyUiJobsByPromptId, comfyUiQueueOrder, failComfyUiJob, nextQueuedComfyUiJob, removeComfyUiJob]);

  useEffect(() => {
    clearComfyUiProjectQueue(projectFilePath);
  }, [clearComfyUiProjectQueue, projectFilePath]);

  useEffect(() => {
    const currentProjectFilePath = projectFilePath ?? null;
    if (lastAssetAuditProjectFilePath.current !== currentProjectFilePath) {
      ignoredUntrackedAssetPaths.current = new Set();
      lastAssetAuditProjectFilePath.current = currentProjectFilePath;
    }
    if (!projectFilePath || !project) {
      void window.noveltea.stopProjectAssetWatcher();
      setUntrackedAssetFiles([]);
      setUntrackedAssetDialogOpen(false);
      return;
    }
    void window.noveltea.startProjectAssetWatcher(projectFilePath);
    void runAssetAudit(project);
    return () => { void window.noveltea.stopProjectAssetWatcher(); };
  }, [project, projectFilePath, runAssetAudit]);

  useEffect(() => window.noveltea.onProjectAssetAuditChanged((event) => {
    const latestProject = useProjectStore.getState().document;
    const latestProjectFilePath = useProjectStore.getState().projectFilePath;
    if (!latestProject || !latestProjectFilePath || event.projectFilePath !== latestProjectFilePath || latestProjectFilePathRef.current !== event.projectFilePath) return;
    void runAssetAudit(latestProject);
  }));

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
    void (async () => {
      await dirtySaveProjectState('window-close');
      await cancelAndClearComfyUiProjectJobs(projectFilePath);
      await window.noveltea.completeAppWindowExit();
    })();
  }));

  useEffect(() => window.noveltea.onEditorShortcut((command) => {
    switch (command) {
      case 'new':
        dispatchWorkspaceToolbarCommand(
          isAuthoringProject(useProjectStore.getState().document) ? 'new-entity' : 'new-project',
        );
        break;
      case 'open-project':
      case 'save':
      case 'save-as':
      case 'close-active-tab':
      case 'reopen-closed-tab':
      case 'command-palette':
      case 'toggle-bottom-panel':
        dispatchWorkspaceToolbarCommand(command);
        break;
      case 'toggle-sidebar':
        break;
    }
  }));

  async function saveProject(saveAs = false) {
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
        ? await window.noveltea.saveProjectAs(projectWithEditorState, latestProjectFilePath, latestProjectFilePath)
        : await window.noveltea.saveProject(projectWithEditorState, latestProjectFilePath);
      if (result.success) {
        markProjectSaved({ projectPath: result.projectPath, projectFilePath: result.projectFilePath, document: projectWithEditorState });
        refreshRecentProjectEntry(projectWithEditorState, result.projectPath ?? projectPath, result.projectFilePath ?? latestProjectFilePath);
        setProjectPath(result.projectPath ?? projectPath);
        setProjectFilePath(result.projectFilePath ?? projectFilePath);
        const warningCount = result.diagnostics?.filter((diagnostic) => diagnostic.severity === 'warning').length ?? 0;
        const savedMessage = `Saved ${result.projectFilePath ?? latestProjectFilePath}${warningCount > 0 ? ` (${warningCount} warning${warningCount === 1 ? '' : 's'})` : ''}`;
        addTimelineEntry({ source: 'command', message: savedMessage, detail: result });
        setStatusMessage(savedMessage);
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
      if (event.key.toLowerCase() === 'n') {
        event.preventDefault();
        if (isAuthoringProject(useProjectStore.getState().document)) {
          window.dispatchEvent(new CustomEvent(WORKSPACE_TOOLBAR_COMMAND_EVENT, { detail: 'new-entity' }));
        } else {
          void openNewProjectDialog();
        }
      } else if (event.key.toLowerCase() === 'o' && !event.shiftKey) {
        event.preventDefault();
        void openProject();
      } else if (event.key.toLowerCase() === 's') {
        event.preventDefault();
        void saveProject(event.shiftKey);
      } else if (event.key.toLowerCase() === 'w') {
        const workbench = useWorkbenchStore.getState();
        const group = workbench.groupsById[workbench.activeGroupId];
        const tabId = group?.activeTabId;
        if (group && tabId) {
          event.preventDefault();
          useCloseGuardStore.getState().requestCloseTab(group.id, tabId);
        }
      } else if (event.shiftKey && event.key.toLowerCase() === 't') {
        event.preventDefault();
        useWorkbenchStore.getState().reopenLastClosedTab();
      } else if (event.key.toLowerCase() === 'p') {
        event.preventDefault();
        setCommandPaletteOpen(true);
      }
      const target = event.target as HTMLElement | null;
      const isTextInput = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if (isTextInput) return;
      if (event.key.toLowerCase() === 'j') {
        event.preventDefault();
        setBottomPanelVisible(!useBottomPanelStore.getState().visible);
      } else if (event.key.toLowerCase() === 'z') {
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
    if (!projectFilePath || !isAuthoringProject(project)) return;
    for (const [assetId, entry] of Object.entries(deletedAssetTrash)) {
      if (entry.projectFilePath !== projectFilePath || !project.assets[assetId]) continue;
      void window.noveltea.restoreProjectAssetFiles(projectFilePath, [entry.move]).then((result) => {
        if (result.success) forgetDeletedAsset(assetId);
        else setStatusMessage(result.error ?? result.diagnostics[0]?.message ?? 'Failed to restore asset file.');
      });
    }
  }, [deletedAssetTrash, forgetDeletedAsset, project, projectFilePath, setStatusMessage]);

  useEffect(() => {
    if (!project) {
      setProject(null);
      setDiagnostics([]);
      return;
    }
    setProject(project);
    const authoringProject = isAuthoringProject(project) ? project : null;
    setDiagnostics(authoringProject ? validateAuthoringProject(authoringProject) : unsupportedProjectDiagnostics());
  }, [project, setProject, setDiagnostics]);

  useEffect(() => {
    if (!comfyUiConfig.enabled) return;
    void checkComfyUiConnection(comfyUiConfig, { showChecking: true });
    const timer = window.setInterval(() => {
      void useComfyUiStore.getState().checkConnection(useComfyUiStore.getState().config);
    }, comfyUiConfig.connectionCheckIntervalMs);
    return () => window.clearInterval(timer);
  }, [checkComfyUiConnection, comfyUiConfig]);

  function validate() {
    if (!project) return;
    const diagnostics = isAuthoringProject(project) ? validateAuthoringProject(project) : unsupportedProjectDiagnostics();
    setDiagnostics(diagnostics);
    addTimelineEntry({
      source: 'validation',
      message: authoringValidationSucceeded(diagnostics) ? 'Validation passed' : 'Validation reported issues',
      detail: diagnostics,
    });
  }

  async function importUntrackedAssets(projectRelativePaths: string[]) {
    const latestProjectFilePath = useProjectStore.getState().projectFilePath;
    if (!latestProjectFilePath || projectRelativePaths.length === 0) return;
    const result = await window.noveltea.importUntrackedProjectAssets(latestProjectFilePath, projectRelativePaths);
    if (!result.success || !result.assets?.length) {
      const message = result.error ?? result.diagnostics[0]?.message ?? 'Untracked asset import failed.';
      setStatusMessage(message);
      setAlert({ title: 'Asset import failed', message });
      return;
    }
    const command = executeCommand({
      type: 'asset.importFiles',
      label: `Import ${result.assets.length} untracked asset${result.assets.length === 1 ? '' : 's'}`,
      payload: { assets: result.assets },
    });
    const failure = command.diagnostics.find((diagnostic) => diagnostic.severity === 'error');
    if (failure) {
      setStatusMessage(failure.message);
      setAlert({ title: 'Asset import failed', message: failure.message });
      return;
    }
    setStatusMessage(`Imported ${result.assets.length} untracked asset${result.assets.length === 1 ? '' : 's'}`);
    await runAssetAudit();
  }

  async function trashUntrackedAssets(projectRelativePaths: string[]) {
    const latestProjectFilePath = useProjectStore.getState().projectFilePath;
    if (!latestProjectFilePath || projectRelativePaths.length === 0) return;
    const result = await window.noveltea.trashProjectAssetFiles(latestProjectFilePath, projectRelativePaths);
    if (!result.success) {
      const message = result.error ?? result.diagnostics[0]?.message ?? 'Failed to move selected assets to project trash.';
      setStatusMessage(message);
      setAlert({ title: 'Asset trash failed', message });
      return;
    }
    setStatusMessage(`Moved ${result.moved?.length ?? projectRelativePaths.length} asset file${projectRelativePaths.length === 1 ? '' : 's'} to project trash`);
    await runAssetAudit();
  }

  async function reopenUntrackedAssetsDialog() {
    if (untrackedAssetFiles.length > 0) setUntrackedAssetDialogOpen(true);
    await runAssetAudit();
  }

  function ignoreUntrackedAssets(projectRelativePaths: string[]) {
    ignoredUntrackedAssetPaths.current = new Set([...ignoredUntrackedAssetPaths.current, ...projectRelativePaths]);
    setUntrackedAssetFiles((files) => files.filter((file) => !projectRelativePaths.includes(file.projectRelativePath)));
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
    openWorkbenchTab(buildPlatformExportTab());
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
          void openNewProjectDialog();
          break;
        case 'new-entity':
          if (isAuthoringProject(project)) window.dispatchEvent(new CustomEvent('noveltea-open-new-entity-wizard'));
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
        case 'play-game':
          openWorkbenchTab(buildFullGamePreviewTab());
          break;
        case 'preview-play':
          openWorkbenchTab(buildFullGamePreviewTab());
          break;
        case 'preview-stop':
          openWorkbenchTab(buildFullGamePreviewTab());
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
        case 'close-active-tab': {
          const workbench = useWorkbenchStore.getState();
          const group = workbench.groupsById[workbench.activeGroupId];
          const tabId = group?.activeTabId;
          if (group && tabId) useCloseGuardStore.getState().requestCloseTab(group.id, tabId);
          break;
        }
        case 'reopen-closed-tab':
          useWorkbenchStore.getState().reopenLastClosedTab();
          break;
        case 'toggle-bottom-panel':
          if (project) setBottomPanelVisible(!bottomPanelVisible);
          break;
        case 'command-palette':
          setCommandPaletteOpen(true);
          break;
      }
    }

    window.addEventListener(WORKSPACE_TOOLBAR_COMMAND_EVENT, onToolbarCommand);
    return () => window.removeEventListener(WORKSPACE_TOOLBAR_COMMAND_EVENT, onToolbarCommand);
  });

  const trimmedNewProjectName = newProjectName.trim();
  const newProjectSlug = projectSlug(trimmedNewProjectName);
  const newProjectNameIssue = !trimmedNewProjectName
    ? 'Project name is required.'
    : !newProjectSlug
      ? 'Project name must contain at least one letter or number.'
      : null;
  const newProjectDirectoryIssue = !newProjectDirectory.trim()
    ? 'Project directory is required.'
    : pathContainsSpaces(newProjectDirectory)
      ? 'Project paths must not contain spaces.'
      : null;
  const canCreateNewProject = !newProjectNameIssue && !newProjectDirectoryIssue && !newProjectCreating;
  const showBottomPanel = project !== null && bottomPanelVisible;
  const showCollapsedBottomPanel = project !== null && !bottomPanelVisible;

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="min-w-0 flex-1 overflow-hidden">
          <Group
            key={showBottomPanel ? 'workspace-with-bottom-panel' : 'workspace-main-only'}
            orientation="vertical"
            className="h-full w-full"
            onLayoutChanged={(layout) => {
              if (showBottomPanel && typeof layout['workspace-bottom-panel'] === 'number') setBottomPanelSizePercent(layout['workspace-bottom-panel']);
            }}
          >
            <Panel id="workspace-main-panel" defaultSize={`${showBottomPanel ? 100 - bottomPanelSizePercent : 100}%`} minSize="240px">
              <Workbench />
            </Panel>
            {showBottomPanel
              ? [
                  <PanelResizeSeparator
                    key="bottom-panel-resize"
                    orientation="vertical"
                  />,
                  <Panel id="workspace-bottom-panel" key="bottom-panel" defaultSize={`${bottomPanelSizePercent}%`} minSize="180px" maxSize="70%">
                    <BottomPanel />
                  </Panel>,
                ]
              : null}
          </Group>
        </div>
      </div>
      {showCollapsedBottomPanel ? <div className="h-9 shrink-0 overflow-hidden"><BottomPanel /></div> : null}
      <Dialog open={newProjectOpen} onOpenChange={(open) => { if (!newProjectCreating) setNewProjectOpen(open); }}>
        <DialogPopup className="sm:max-w-lg">
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (canCreateNewProject) void createNewProject();
            }}
          >
            <div className="grid gap-1">
              <DialogTitle>Create NovelTea Project</DialogTitle>
            </div>
            <div className="grid gap-3">
              <div className="grid gap-1">
                <Label htmlFor="new-project-name">Project name</Label>
                <Input
                  id="new-project-name"
                  value={newProjectName}
                  onChange={(event) => {
                    setNewProjectName(event.currentTarget.value);
                    setNewProjectError(null);
                  }}
                  aria-invalid={newProjectNameIssue ? true : undefined}
                  autoFocus
                />
                {newProjectNameIssue ? <p className="text-[11px] text-destructive">{newProjectNameIssue}</p> : null}
              </div>
              <div className="grid gap-1">
                <Label htmlFor="new-project-directory">Project directory</Label>
                <div className="flex min-w-0 items-center gap-2">
                  <Input
                    id="new-project-directory"
                    className="font-mono text-[11px]"
                    value={newProjectDirectory}
                    onChange={(event) => {
                      setNewProjectDirectory(event.currentTarget.value);
                      setNewProjectDirectoryEdited(true);
                      setNewProjectError(null);
                    }}
                    aria-invalid={newProjectDirectoryIssue ? true : undefined}
                  />
                  <Button type="button" variant="outline" onClick={() => void browseNewProjectDirectory()} disabled={newProjectCreating}>
                    Browse…
                  </Button>
                </div>
                {newProjectDirectoryIssue ? <p className="text-[11px] text-destructive">{newProjectDirectoryIssue}</p> : null}
              </div>
              {newProjectError ? <p className="rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1 text-xs text-destructive">{newProjectError}</p> : null}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setNewProjectOpen(false)} disabled={newProjectCreating}>Cancel</Button>
              <Button type="submit" disabled={!canCreateNewProject}>{newProjectCreating ? 'Creating…' : 'Create Project'}</Button>
            </DialogFooter>
          </form>
        </DialogPopup>
      </Dialog>
      <CommandPaletteDialog open={commandPaletteOpen} onOpenChange={setCommandPaletteOpen} project={isAuthoringProject(project) ? project : null} onOpenTab={openWorkbenchTab} />
      <UntrackedAssetsDialog
        open={untrackedAssetDialogOpen && untrackedAssetFiles.length > 0}
        onOpenChange={setUntrackedAssetDialogOpen}
        files={untrackedAssetFiles}
        onImportSelected={importUntrackedAssets}
        onDeleteSelected={trashUntrackedAssets}
        onIgnoreSelected={ignoreUntrackedAssets}
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
          {nodes.reduce((count, node) => count + (node.children?.length ?? 0), 0)} records{saveDirty ? ' • dirty' : ''}{isSaving ? ' • saving' : ''}
        </span>
        <span className="mx-2 text-muted-foreground/30">|</span>
        <span className="font-mono text-[10px] text-muted-foreground">
          Preview {previewConnectionState}
        </span>
        <span className="mx-2 text-muted-foreground/30">|</span>
        <ComfyUiStatusIndicator />
        <span className="mx-2 text-muted-foreground/30">|</span>
        {untrackedAssetFiles.length > 0 ? (
          <button
            type="button"
            className="truncate rounded px-1 font-mono text-[10px] text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            title="Open untracked asset files"
            onClick={() => void reopenUntrackedAssetsDialog()}
          >
            {statusMessage}
          </button>
        ) : (
          <span className="truncate font-mono text-[10px] text-muted-foreground">{statusMessage}</span>
        )}
      </div>
    </div>
  );
}
