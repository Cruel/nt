import { useEffect, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Maximize2,
  Minus,
  Redo2,
  Save,
  Square,
  Undo2,
  X,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogDescription, DialogPopup, DialogTitle } from '@/components/ui/dialog';
import {
  Menubar,
  MenubarContent,
  MenubarItem,
  MenubarMenu,
  MenubarSeparator,
  MenubarShortcut,
  MenubarSub,
  MenubarSubContent,
  MenubarSubTrigger,
  MenubarTrigger,
} from '@/components/ui/menubar';
import { useCommandStore } from '@/commands/command-store';
import { selectProjectDirty, useProjectStore } from '@/project/project-store';
import { useDraftDirtyStore } from '@/workbench/draft-dirty-store';
import { recentProjectKey, useRecentProjectsStore } from '@/workspace/recent-projects-store';
import { dispatchWorkspaceToolbarCommand } from '@/workspace/workspace-toolbar-events';
import { useWorkbenchStore } from '@/workbench/workbench-store';
import type { AppInfo } from '../../shared/electron-api';

async function runMenuAction(action: () => Promise<unknown>) {
  try {
    await action();
  } catch (error) {
    console.error('Application menu action failed.', error);
  }
}

const dragStyle = { WebkitAppRegion: 'drag' } as CSSProperties;
const noDragStyle = { WebkitAppRegion: 'no-drag' } as CSSProperties;

function WorkspaceTopToolbar() {
  const { t } = useTranslation('common');
  const project = useProjectStore((state) => state.document);
  const projectDirty = useProjectStore(selectProjectDirty);
  const isSaving = useProjectStore((state) => state.isSaving);
  const commandHistory = useCommandStore((state) => state.history);
  const draftEntries = useDraftDirtyStore((state) => state.entriesByKey);
  const hasDraftDirty = Object.values(draftEntries).some((entry) => entry.dirty);
  const saveDirty = projectDirty || hasDraftDirty;
  const canUndo = commandHistory.cursor >= 0 && !commandHistory.activeTransaction;
  const canRedo = commandHistory.cursor < commandHistory.entries.length - 1 && !commandHistory.activeTransaction;
  if (!project) return null;

  return (
    <div className="flex min-w-0 items-center gap-1" style={noDragStyle}>
      <span className="mr-2 max-w-64 truncate font-mono text-[11px] text-muted-foreground" title="NovelTea">
        NovelTea
      </span>
      <Button size="icon-xs" variant="ghost" onClick={() => dispatchWorkspaceToolbarCommand('undo')} disabled={!canUndo} title={t('actions.undo')}>
        <Undo2 className="h-3.5 w-3.5" />
      </Button>
      <Button size="icon-xs" variant="ghost" onClick={() => dispatchWorkspaceToolbarCommand('redo')} disabled={!canRedo} title={t('actions.redo')}>
        <Redo2 className="h-3.5 w-3.5" />
      </Button>
      <Button size="icon-xs" variant={saveDirty ? 'secondary' : 'ghost'} onClick={() => dispatchWorkspaceToolbarCommand('save')} disabled={!saveDirty || isSaving} title={t('actions.save')}>
        <Save className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

export function AppMenuBar() {
  const { t } = useTranslation(['menu', 'common']);
  const [frameless, setFrameless] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const project = useProjectStore((state) => state.document);
  const projectDirty = useProjectStore(selectProjectDirty);
  const isSaving = useProjectStore((state) => state.isSaving);
  const draftEntries = useDraftDirtyStore((state) => state.entriesByKey);
  const hasDraftDirty = Object.values(draftEntries).some((entry) => entry.dirty);
  const saveDirty = projectDirty || hasDraftDirty;
  const recentProjects = useRecentProjectsStore((state) => state.recentProjects);

  useEffect(() => {
    let mounted = true;
    void window.noveltea.getAppInfo().then((info) => {
      if (!mounted) return;
      setFrameless(info.frameless);
      setAppInfo(info);
    });
    return () => {
      mounted = false;
    };
  }, []);

  return (
    <>
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
        aria-label={t('menu:aria.applicationMenu')}
        className="h-6 min-w-0 border-0 bg-transparent p-0 shadow-none"
        style={frameless ? noDragStyle : undefined}
      >
        <MenubarMenu>
          <MenubarTrigger>{t('menu:menus.file')}</MenubarTrigger>
          <MenubarContent className="min-w-56">
            <MenubarItem onClick={() => dispatchWorkspaceToolbarCommand(project ? 'new-entity' : 'new-project')}>{project ? t('menu:items.newEntity') : t('menu:items.newProject')}<MenubarShortcut>Ctrl+N</MenubarShortcut></MenubarItem>
            <MenubarItem onClick={() => dispatchWorkspaceToolbarCommand('open-project')}>{t('menu:items.openProject')}<MenubarShortcut>Ctrl+O</MenubarShortcut></MenubarItem>
            <MenubarSub>
              <MenubarSubTrigger>{t('menu:items.recentProjects')}</MenubarSubTrigger>
              <MenubarSubContent className="min-w-72">
                {recentProjects.length === 0 ? (
                  <MenubarItem disabled>{t('menu:items.noRecentProjects')}</MenubarItem>
                ) : recentProjects.map((entry) => {
                  const projectKey = recentProjectKey(entry);
                  return (
                  <MenubarItem
                    key={projectKey}
                    onClick={() => dispatchWorkspaceToolbarCommand({ command: 'open-project', projectPath: projectKey })}
                  >
                    <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                    <MenubarShortcut className="max-w-36 truncate normal-case tracking-normal" title={projectKey}>
                      {projectKey}
                    </MenubarShortcut>
                  </MenubarItem>
                  );
                })}
              </MenubarSubContent>
            </MenubarSub>
            <MenubarItem disabled={!project} onClick={() => dispatchWorkspaceToolbarCommand('close-project')}>{t('menu:items.closeProject')}</MenubarItem>
            <MenubarSeparator />
            <MenubarItem disabled={!project || !saveDirty || isSaving} onClick={() => dispatchWorkspaceToolbarCommand('save')}>{t('common:actions.save')}<MenubarShortcut>Ctrl+S</MenubarShortcut></MenubarItem>
            <MenubarItem disabled={!project || isSaving} onClick={() => dispatchWorkspaceToolbarCommand('save-as')}>{t('common:actions.saveAs')}<MenubarShortcut>Ctrl+Shift+S</MenubarShortcut></MenubarItem>
            <MenubarSeparator />
            <MenubarItem onClick={() => dispatchWorkspaceToolbarCommand('export-package')}>{t('menu:items.packageExport')}</MenubarItem>
          </MenubarContent>
        </MenubarMenu>

        <MenubarMenu>
          <MenubarTrigger>{t('menu:menus.project')}</MenubarTrigger>
          <MenubarContent className="min-w-52">
            <MenubarItem disabled={!project} onClick={() => dispatchWorkspaceToolbarCommand('project-settings')}>{t('menu:items.projectSettings')}</MenubarItem>
            <MenubarSeparator />
            <MenubarItem disabled={!project} onClick={() => dispatchWorkspaceToolbarCommand('validate')}>{t('menu:items.validateProject')}</MenubarItem>
            <MenubarItem disabled={!project} onClick={() => dispatchWorkspaceToolbarCommand('export-package')}>{t('menu:items.packageExport')}</MenubarItem>
          </MenubarContent>
        </MenubarMenu>

        <MenubarMenu>
          <MenubarTrigger>{t('menu:menus.edit')}</MenubarTrigger>
          <MenubarContent className="min-w-52">
            <MenubarItem onClick={() => dispatchWorkspaceToolbarCommand('undo')}>{t('common:actions.undo')}<MenubarShortcut>Ctrl+Z</MenubarShortcut></MenubarItem>
            <MenubarItem onClick={() => dispatchWorkspaceToolbarCommand('redo')}>{t('common:actions.redo')}<MenubarShortcut>Ctrl+Y</MenubarShortcut></MenubarItem>
            <MenubarSeparator />
            <MenubarItem disabled>{t('common:actions.cut')}<MenubarShortcut>Ctrl+X</MenubarShortcut></MenubarItem>
            <MenubarItem disabled>{t('common:actions.copy')}<MenubarShortcut>Ctrl+C</MenubarShortcut></MenubarItem>
            <MenubarItem disabled>{t('common:actions.paste')}<MenubarShortcut>Ctrl+V</MenubarShortcut></MenubarItem>
          </MenubarContent>
        </MenubarMenu>

        <MenubarMenu>
          <MenubarTrigger>{t('menu:menus.view')}</MenubarTrigger>
          <MenubarContent className="min-w-52">
            <MenubarItem onClick={() => void runMenuAction(() => window.noveltea.resetZoom())}>
              {t('menu:items.actualSize')}<MenubarShortcut>Ctrl+0</MenubarShortcut>
            </MenubarItem>
            <MenubarItem onClick={() => void runMenuAction(() => window.noveltea.zoomIn())}>
              {t('menu:items.zoomIn')}<MenubarShortcut>Ctrl++</MenubarShortcut>
            </MenubarItem>
            <MenubarItem onClick={() => void runMenuAction(() => window.noveltea.zoomOut())}>
              {t('menu:items.zoomOut')}<MenubarShortcut>Ctrl+-</MenubarShortcut>
            </MenubarItem>
            <MenubarSeparator />
            <MenubarItem onClick={() => dispatchWorkspaceToolbarCommand('command-palette')}>{t('menu:items.commandPalette')}<MenubarShortcut>Ctrl+Shift+P</MenubarShortcut></MenubarItem>
            <MenubarItem onClick={() => dispatchWorkspaceToolbarCommand('toggle-bottom-panel')}>{t('menu:items.toggleBottomPanel')}<MenubarShortcut>Ctrl+J</MenubarShortcut></MenubarItem>
          </MenubarContent>
        </MenubarMenu>

        <MenubarMenu>
          <MenubarTrigger>{t('menu:menus.window')}</MenubarTrigger>
          <MenubarContent className="min-w-52">
            <MenubarItem onClick={() => void runMenuAction(() => window.noveltea.toggleMaximizeAppWindow())}>
              {t('menu:items.toggleMaximize')}
            </MenubarItem>
            <MenubarItem onClick={() => void runMenuAction(() => window.noveltea.minimizeAppWindow())}>
              {t('menu:aria.minimizeWindow')}
            </MenubarItem>
          </MenubarContent>
        </MenubarMenu>

        <MenubarMenu>
          <MenubarTrigger>{t('menu:menus.help')}</MenubarTrigger>
          <MenubarContent className="min-w-52">
            <MenubarItem disabled>{t('menu:items.documentation')}</MenubarItem>
            <MenubarItem onClick={() => setAboutOpen(true)}>{t('menu:items.aboutNovelTea')}</MenubarItem>
          </MenubarContent>
        </MenubarMenu>
      </Menubar>

      <div className="flex min-w-0 flex-1 justify-center px-3">
        <WorkspaceTopToolbar />
      </div>

      {frameless && (
        <div className="flex h-full shrink-0 items-center" style={noDragStyle}>
          <Button
            aria-label={t('menu:aria.minimizeWindow')}
            className="h-8 w-10 rounded-none border-0 bg-transparent hover:bg-muted"
            size="icon"
            variant="ghost"
            onClick={() => void runMenuAction(() => window.noveltea.minimizeAppWindow())}
          >
            <Minus />
          </Button>
          <Button
            aria-label={t('menu:aria.maximizeWindow')}
            className="h-8 w-10 rounded-none border-0 bg-transparent hover:bg-muted"
            size="icon"
            variant="ghost"
            onClick={() => void runMenuAction(() => window.noveltea.toggleMaximizeAppWindow())}
          >
            <Square className="size-3" />
            <Maximize2 className="sr-only" />
          </Button>
          <Button
            aria-label={t('menu:aria.closeWindow')}
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
    <Dialog open={aboutOpen} onOpenChange={setAboutOpen}>
      <DialogPopup>
        <DialogTitle>{t('menu:about.title')}</DialogTitle>
        <DialogDescription>{t('menu:about.description')}</DialogDescription>
        {appInfo ? (
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between gap-6">
              <dt className="text-muted-foreground">{t('menu:about.version')}</dt>
              <dd className="font-mono text-xs">{appInfo.version}</dd>
            </div>
            <div className="flex justify-between gap-6">
              <dt className="text-muted-foreground">{t('menu:about.electron')}</dt>
              <dd className="font-mono text-xs">{appInfo.electronVersion}</dd>
            </div>
            <div className="flex justify-between gap-6">
              <dt className="text-muted-foreground">{t('menu:about.platform')}</dt>
              <dd className="font-mono text-xs">{appInfo.platform}</dd>
            </div>
            <div className="flex justify-between gap-6">
              <dt className="text-muted-foreground">{t('menu:about.architecture')}</dt>
              <dd className="font-mono text-xs">{appInfo.arch}</dd>
            </div>
            <div className="flex justify-between gap-6">
              <dt className="text-muted-foreground">{t('menu:about.packaged')}</dt>
              <dd>
                <Badge variant={appInfo.packaged ? 'default' : 'secondary'}>
                  {appInfo.packaged ? t('common:booleans.yes') : t('common:booleans.no')}
                </Badge>
              </dd>
            </div>
          </dl>
        ) : (
          <p className="text-sm text-muted-foreground">{t('common:loading.applicationInfo')}</p>
        )}
        <div className="flex justify-end">
          <Button size="sm" onClick={() => setAboutOpen(false)}>{t('common:actions.close')}</Button>
        </div>
      </DialogPopup>
    </Dialog>
    </>
  );
}
