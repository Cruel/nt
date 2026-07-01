import { useEffect, useState, type CSSProperties } from 'react';
import {
  Download,
  Eye,
  FilePlus2,
  FlaskConical,
  Maximize2,
  Minus,
  Package,
  Play,
  Redo2,
  Save,
  SaveAll,
  Square,
  Undo2,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Menubar,
  MenubarContent,
  MenubarItem,
  MenubarMenu,
  MenubarSeparator,
  MenubarShortcut,
  MenubarTrigger,
} from '@/components/ui/menubar';
import { Separator } from '@/components/ui/separator';
import { useCommandStore } from '@/commands/command-store';
import { selectCanSave, selectProjectDirty, useProjectStore } from '@/project/project-store';
import { useWorkspaceStore } from '@/stores/workspace-store';
import { useBottomPanelStore } from '@/workbench/bottom-panel-store';
import { useDraftDirtyStore } from '@/workbench/draft-dirty-store';
import { isAuthoringProject } from '../../shared/project-schema/authoring-project';
import { dispatchWorkspaceToolbarCommand } from '@/workspace/workspace-toolbar-events';

async function runMenuAction(action: () => Promise<unknown>) {
  try {
    await action();
  } catch (error) {
    console.error('Application menu action failed.', error);
  }
}

const dragStyle = { WebkitAppRegion: 'drag' } as CSSProperties;
const noDragStyle = { WebkitAppRegion: 'no-drag' } as CSSProperties;

function projectFileName(projectFilePath: string | null) {
  if (!projectFilePath) return 'Unsaved project';
  return projectFilePath.split(/[\\/]/).pop() || projectFilePath;
}

function WorkspaceTopToolbar() {
  const project = useProjectStore((state) => state.document);
  const projectFilePath = useProjectStore((state) => state.projectFilePath);
  const projectDirty = useProjectStore(selectProjectDirty);
  const canSave = useProjectStore(selectCanSave);
  const isSaving = useProjectStore((state) => state.isSaving);
  const autosaveEnabled = useProjectStore((state) => state.autosaveEnabled);
  const previewRunning = useWorkspaceStore((state) => state.previewRunning);
  const tests = useWorkspaceStore((state) => state.playbackTests);
  const bottomPanelVisible = useBottomPanelStore((state) => state.visible);
  const commandHistory = useCommandStore((state) => state.history);
  const draftEntries = useDraftDirtyStore((state) => state.entriesByKey);
  const hasDraftDirty = Object.values(draftEntries).some((entry) => entry.dirty);
  const saveDirty = projectDirty || hasDraftDirty;
  const canUndo = commandHistory.cursor >= 0 && !commandHistory.activeTransaction;
  const canRedo = commandHistory.cursor < commandHistory.entries.length - 1 && !commandHistory.activeTransaction;
  const isAuthoring = isAuthoringProject(project);

  if (!project) return null;

  return (
    <div className="flex min-w-0 items-center gap-1" style={noDragStyle}>
      <span className="mr-2 max-w-48 truncate font-mono text-[11px] text-muted-foreground" title={projectFilePath ?? 'Unsaved project'}>
        {projectFileName(projectFilePath)}
      </span>
      <Button size="xs" variant="outline" onClick={() => dispatchWorkspaceToolbarCommand('new-project')} title="New Project">
        <FilePlus2 className="h-3.5 w-3.5" />
        New
      </Button>
      <Button size="xs" variant="outline" onClick={() => dispatchWorkspaceToolbarCommand('open-project')}>
        Open
      </Button>
      <Button size="xs" variant="ghost" onClick={() => dispatchWorkspaceToolbarCommand('validate')}>
        Validate
      </Button>
      <Button size="icon-xs" variant="ghost" onClick={() => dispatchWorkspaceToolbarCommand('import-assets')} title="Import assets">
        <Download className="h-3.5 w-3.5" />
      </Button>
      <Button size="icon-xs" variant="ghost" onClick={() => dispatchWorkspaceToolbarCommand('run-first-test')} disabled={isAuthoring || tests.length === 0} title="Playback is disabled for authoring projects until conversion exists">
        <FlaskConical className="h-3.5 w-3.5" />
      </Button>
      <Button size="icon-xs" variant="ghost" onClick={() => dispatchWorkspaceToolbarCommand('export-package')} disabled={isAuthoring} title="Export is disabled for authoring projects until conversion exists">
        <Package className="h-3.5 w-3.5" />
      </Button>
      <Separator orientation="vertical" className="mx-1 h-4" />
      <Button size="icon-xs" variant={previewRunning ? 'secondary' : 'ghost'} onClick={() => dispatchWorkspaceToolbarCommand('preview-play')} title="Run preview">
        <Play className="h-3.5 w-3.5" />
      </Button>
      <Button size="icon-xs" variant={!previewRunning ? 'secondary' : 'ghost'} onClick={() => dispatchWorkspaceToolbarCommand('preview-stop')} title="Stop preview">
        <Square className="h-3.5 w-3.5" />
      </Button>
      <Button size="icon-xs" variant="ghost" onClick={() => dispatchWorkspaceToolbarCommand('undo')} disabled={!canUndo} title="Undo">
        <Undo2 className="h-3.5 w-3.5" />
      </Button>
      <Button size="icon-xs" variant="ghost" onClick={() => dispatchWorkspaceToolbarCommand('redo')} disabled={!canRedo} title="Redo">
        <Redo2 className="h-3.5 w-3.5" />
      </Button>
      <Button size="icon-xs" variant={saveDirty ? 'secondary' : 'ghost'} onClick={() => dispatchWorkspaceToolbarCommand('save')} disabled={(!canSave && !hasDraftDirty) || isSaving} title="Save">
        <Save className="h-3.5 w-3.5" />
      </Button>
      <Button size="icon-xs" variant="ghost" onClick={() => dispatchWorkspaceToolbarCommand('save-as')} disabled={isSaving} title="Save As">
        <SaveAll className="h-3.5 w-3.5" />
      </Button>
      <Button size="xs" variant={autosaveEnabled ? 'secondary' : 'ghost'} onClick={() => dispatchWorkspaceToolbarCommand('toggle-autosave')} disabled={!projectFilePath} title="Toggle autosave">
        Autosave
      </Button>
      <Separator orientation="vertical" className="mx-1 h-4" />
      <Button size="icon-xs" variant={bottomPanelVisible ? 'secondary' : 'ghost'} onClick={() => dispatchWorkspaceToolbarCommand('toggle-bottom-panel')} title="Toggle bottom panel">
        <Eye className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

export function AppMenuBar() {
  const [frameless, setFrameless] = useState(false);
  const project = useProjectStore((state) => state.document);

  useEffect(() => {
    let mounted = true;
    void window.noveltea.getAppInfo().then((info) => {
      if (mounted) setFrameless(info.frameless);
    });
    return () => {
      mounted = false;
    };
  }, []);

  return (
    <div
      className="flex h-8 shrink-0 items-center border-b bg-background pl-2"
      style={frameless ? dragStyle : undefined}
    >
      <div className="mr-2 flex items-center">
        <span className="flex h-5 w-5 items-center justify-center rounded bg-primary text-[9px] font-bold text-primary-foreground">
          NT
        </span>
      </div>
      <Menubar
        aria-label="Application menu"
        className="h-6 min-w-0 border-0 bg-transparent p-0 shadow-none"
        style={frameless ? noDragStyle : undefined}
      >
        <MenubarMenu>
          <MenubarTrigger>File</MenubarTrigger>
          <MenubarContent className="min-w-56">
            <MenubarItem onClick={() => dispatchWorkspaceToolbarCommand('new-project')}>New Project<MenubarShortcut>Ctrl+N</MenubarShortcut></MenubarItem>
            <MenubarItem onClick={() => dispatchWorkspaceToolbarCommand('open-project')}>Open Project…<MenubarShortcut>Ctrl+O</MenubarShortcut></MenubarItem>
            <MenubarItem disabled={!project} onClick={() => dispatchWorkspaceToolbarCommand('close-project')}>Close Project</MenubarItem>
            <MenubarSeparator />
            <MenubarItem onClick={() => dispatchWorkspaceToolbarCommand('save')}>Save<MenubarShortcut>Ctrl+S</MenubarShortcut></MenubarItem>
            <MenubarItem onClick={() => dispatchWorkspaceToolbarCommand('save-as')}>Save As…<MenubarShortcut>Ctrl+Shift+S</MenubarShortcut></MenubarItem>
            <MenubarSeparator />
            <MenubarItem onClick={() => dispatchWorkspaceToolbarCommand('export-package')}>Package Export…</MenubarItem>
          </MenubarContent>
        </MenubarMenu>

        <MenubarMenu>
          <MenubarTrigger>Edit</MenubarTrigger>
          <MenubarContent className="min-w-52">
            <MenubarItem onClick={() => dispatchWorkspaceToolbarCommand('undo')}>Undo<MenubarShortcut>Ctrl+Z</MenubarShortcut></MenubarItem>
            <MenubarItem onClick={() => dispatchWorkspaceToolbarCommand('redo')}>Redo<MenubarShortcut>Ctrl+Y</MenubarShortcut></MenubarItem>
            <MenubarSeparator />
            <MenubarItem disabled>Cut<MenubarShortcut>Ctrl+X</MenubarShortcut></MenubarItem>
            <MenubarItem disabled>Copy<MenubarShortcut>Ctrl+C</MenubarShortcut></MenubarItem>
            <MenubarItem disabled>Paste<MenubarShortcut>Ctrl+V</MenubarShortcut></MenubarItem>
          </MenubarContent>
        </MenubarMenu>

        <MenubarMenu>
          <MenubarTrigger>View</MenubarTrigger>
          <MenubarContent className="min-w-52">
            <MenubarItem onClick={() => void runMenuAction(() => window.noveltea.resetZoom())}>
              Actual Size<MenubarShortcut>Ctrl+0</MenubarShortcut>
            </MenubarItem>
            <MenubarItem onClick={() => void runMenuAction(() => window.noveltea.zoomIn())}>
              Zoom In<MenubarShortcut>Ctrl++</MenubarShortcut>
            </MenubarItem>
            <MenubarItem onClick={() => void runMenuAction(() => window.noveltea.zoomOut())}>
              Zoom Out<MenubarShortcut>Ctrl+-</MenubarShortcut>
            </MenubarItem>
            <MenubarSeparator />
            <MenubarItem disabled>Command Palette…<MenubarShortcut>Ctrl+Shift+P</MenubarShortcut></MenubarItem>
            <MenubarItem onClick={() => dispatchWorkspaceToolbarCommand('toggle-bottom-panel')}>Toggle Bottom Panel</MenubarItem>
          </MenubarContent>
        </MenubarMenu>

        <MenubarMenu>
          <MenubarTrigger>Window</MenubarTrigger>
          <MenubarContent className="min-w-52">
            <MenubarItem onClick={() => void runMenuAction(() => window.noveltea.toggleMaximizeAppWindow())}>
              Toggle Maximize
            </MenubarItem>
            <MenubarItem onClick={() => void runMenuAction(() => window.noveltea.minimizeAppWindow())}>
              Minimize
            </MenubarItem>
          </MenubarContent>
        </MenubarMenu>

        <MenubarMenu>
          <MenubarTrigger>Help</MenubarTrigger>
          <MenubarContent className="min-w-52">
            <MenubarItem disabled>NovelTea Documentation</MenubarItem>
            <MenubarItem disabled>About NovelTea</MenubarItem>
          </MenubarContent>
        </MenubarMenu>
      </Menubar>

      <div className="flex min-w-0 flex-1 justify-center px-3">
        <WorkspaceTopToolbar />
      </div>

      {frameless && (
        <div className="flex h-full shrink-0 items-center" style={noDragStyle}>
          <Button
            aria-label="Minimize window"
            className="h-8 w-10 rounded-none border-0 bg-transparent hover:bg-muted"
            size="icon"
            variant="ghost"
            onClick={() => void runMenuAction(() => window.noveltea.minimizeAppWindow())}
          >
            <Minus />
          </Button>
          <Button
            aria-label="Maximize window"
            className="h-8 w-10 rounded-none border-0 bg-transparent hover:bg-muted"
            size="icon"
            variant="ghost"
            onClick={() => void runMenuAction(() => window.noveltea.toggleMaximizeAppWindow())}
          >
            <Square className="size-3" />
            <Maximize2 className="sr-only" />
          </Button>
          <Button
            aria-label="Close window"
            className="h-8 w-10 rounded-none border-0 bg-transparent hover:bg-destructive/20 hover:text-destructive"
            size="icon"
            variant="ghost"
            onClick={() => void runMenuAction(() => window.noveltea.requestAppWindowExit())}
          >
            <X />
          </Button>
        </div>
      )}
    </div>
  );
}
