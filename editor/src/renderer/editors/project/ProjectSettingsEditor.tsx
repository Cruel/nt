import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SourceEditor } from '@/components/source/SourceEditor';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { DiagnosticList } from '@/diagnostics/DiagnosticList';
import { resolveProjectDiagnosticTarget } from '@/diagnostics/diagnostic-navigation';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useCommandStore } from '@/commands/command-store';
import { listComfyUiWorkflowLibrary } from '@/comfyui/comfyui-service';
import { useProjectStore } from '@/project/project-store';
import { SearchSelectorDialog } from '@/workspace/SearchSelectorDialog';
import { buildCommandPaletteItems, filterSelectorItems } from '@/workspace/command-palette-search';
import { parseAssetData } from '../../../shared/project-schema/authoring-assets';
import { getSystemLayoutSetting, systemLayoutRoleValues, type SystemLayoutRole } from '../../../shared/project-schema/authoring-layouts';
import { isAuthoringProject } from '../../../shared/project-schema/authoring-project';
import { DEFAULT_PROJECT_DISPLAY_SETTINGS, projectSettingsFromProject, validateTypedProjectSettings, type ProjectAppSettings, type ProjectDisplaySettings } from '../../../shared/project-schema/authoring-project-settings';
import { validateAuthoringProject } from '../../../shared/project-schema/authoring-validation';
import { buildComfyUiWorkflowsTab, type WorkbenchEditorProps } from '@/workbench/editor-registry';
import { navigateToWorkbenchTarget } from '@/workbench/workbench-navigation';
import {
  captureScrollViewState,
  captureSourceEditorViewStates,
  isScrollViewState,
  parseSourceEditorViewStates,
  restoreScrollViewState,
  restoreSourceEditorViewStates,
  useSourceEditorViewStateRefs,
  useWorkbenchEditorTabState,
  type ScrollViewState,
  type SourceEditorViewStates,
  type WorkbenchTabStatePayload,
} from '@/workbench/workbench-tab-state';

const PROJECT_SETTINGS_EDITOR_TAB_STATE_SCHEMA = 'noveltea.editor.tab-state.project-settings';

interface ProjectSettingsEditorTabStatePayload {
  scroll?: ScrollViewState;
  sourceViewStates?: SourceEditorViewStates;
}

type ProjectSettingsEditorTabState = WorkbenchTabStatePayload & {
  schema: typeof PROJECT_SETTINGS_EDITOR_TAB_STATE_SCHEMA;
  payload?: ProjectSettingsEditorTabStatePayload;
};

function parseProjectSettingsEditorTabState(value: WorkbenchTabStatePayload): ProjectSettingsEditorTabStatePayload | null {
  if (value.schema !== PROJECT_SETTINGS_EDITOR_TAB_STATE_SCHEMA || typeof value.payload !== 'object' || value.payload === null || Array.isArray(value.payload)) return null;
  const payload = value.payload as Record<string, unknown>;
  return {
    scroll: isScrollViewState(payload.scroll) ? payload.scroll : undefined,
    sourceViewStates: parseSourceEditorViewStates(payload.sourceViewStates),
  };
}

function valueOrNone(value: string | null | undefined) {
  return value ?? '__built_in__';
}

function systemLayoutSelectedId(role: SystemLayoutRole, layoutId: string | null | undefined) {
  return layoutId ? `record:layouts:${layoutId}` : `system-layout-built-in:${role}`;
}

function nullableValue(value: string) {
  return value === '__built_in__' || value === '__none__' ? null : value;
}

function runProjectCommand(type: string, payload: unknown, label: string) {
  return useCommandStore.getState().executeCommand({ type, label, payload });
}

const systemLayoutRoleLabels: Record<SystemLayoutRole, string> = {
  title: 'Title screen',
  'game-hud': 'Game HUD',
  'pause-menu': 'Pause menu',
  'save-menu': 'Save menu',
  'load-menu': 'Load menu',
  'settings-menu': 'Settings menu',
  'text-log': 'Text log',
  modal: 'Modal dialog',
  'debug-overlay': 'Debug overlay',
};

export function ProjectSettingsEditor({ tab }: WorkbenchEditorProps) {
  const { t } = useTranslation('workspace');
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sourceEditors = useSourceEditorViewStateRefs<'startupInitScript'>();
  const projectDocument = useProjectStore((state) => state.document);
  const projectFilePath = useProjectStore((state) => state.projectFilePath);
  const project = isAuthoringProject(projectDocument) ? projectDocument : null;
  const settings = project ? projectSettingsFromProject(project) : null;
  const diagnostics = useMemo(() => project ? validateAuthoringProject(project) : [], [project]);
  const projectSettingsDiagnostics = useMemo(() => project ? validateTypedProjectSettings(project) : [], [project]);
  const selectorItems = useMemo(() => buildCommandPaletteItems(project, t), [project, t]);
  const entrypointItems = useMemo(() => filterSelectorItems(selectorItems, { collections: ['rooms', 'scenes', 'dialogues'], includeActions: false }), [selectorItems]);
  const layoutItems = useMemo(() => filterSelectorItems(selectorItems, { collections: ['layouts'], includeActions: false }), [selectorItems]);
  const [workflowSummary, setWorkflowSummary] = useState({ activeCount: 0, projectCount: 0, invalidProjectCount: 0 });
  const [workflowSummaryMessage, setWorkflowSummaryMessage] = useState<string | null>(null);
  const [entrypointSelectorOpen, setEntrypointSelectorOpen] = useState(false);
  const [systemLayoutSelectorRole, setSystemLayoutSelectorRole] = useState<SystemLayoutRole | null>(null);

  useWorkbenchEditorTabState<ProjectSettingsEditorTabState>(tab.id, useMemo(() => ({
    captureTabState: () => ({
      schema: PROJECT_SETTINGS_EDITOR_TAB_STATE_SCHEMA,
      schemaVersion: 1,
      payload: {
        scroll: captureScrollViewState(scrollRef.current),
        sourceViewStates: captureSourceEditorViewStates(sourceEditors.refs.current),
      },
    }),
    restoreTabState: (state: ProjectSettingsEditorTabState) => {
      const parsed = parseProjectSettingsEditorTabState(state);
      if (!parsed) return;
      window.requestAnimationFrame(() => {
        restoreScrollViewState(scrollRef.current, parsed.scroll);
        restoreSourceEditorViewStates(sourceEditors.refs.current, parsed.sourceViewStates);
      });
    },
  }), [sourceEditors.refs]));

  useEffect(() => {
    if (!projectFilePath) {
      setWorkflowSummary({ activeCount: 0, projectCount: 0, invalidProjectCount: 0 });
      return;
    }
    let canceled = false;
    void listComfyUiWorkflowLibrary({ projectFilePath, includeOverridden: true }).then((response) => {
      if (!canceled) {
        const projectSource = response.summary.sources.find((source) => source.source === 'project');
        setWorkflowSummary({
          activeCount: response.summary.activeCount,
          projectCount: projectSource?.workflowCount ?? 0,
          invalidProjectCount: response.entries.filter((entry) => entry.source === 'project' && entry.offlineStatus === 'invalid').length,
        });
        setWorkflowSummaryMessage(response.error ?? null);
      }
    });
    return () => { canceled = true; };
  }, [projectFilePath]);

  if (!project || !settings) return <div className="p-4 text-sm text-muted-foreground">Open an authoring project to edit project settings.</div>;

  const roomEntries = Object.entries(project.rooms).map(([id, room]) => ({ id, label: room.label || id }));
  const imageAssets = Object.entries(project.assets)
    .filter(([, asset]) => parseAssetData(asset.data)?.kind === 'image')
    .map(([id, asset]) => ({ id, label: asset.label || id }));
  const fontAssets = Object.entries(project.assets)
    .filter(([, asset]) => parseAssetData(asset.data)?.kind === 'font')
    .map(([id, asset]) => ({ id, label: asset.label || id }));
  const entrypointIsRoom = project.entrypoint?.kind === 'room' ? project.entrypoint.id : null;
  const entrypointCollection = project.entrypoint ? `${project.entrypoint.kind}s` as const : null;
  const entrypointRecord = project.entrypoint && entrypointCollection ? project[entrypointCollection][project.entrypoint.id] : null;
  const entrypointDiagnostics = diagnostics.filter((diagnostic) => diagnostic.path.startsWith('/entrypoint'));
  const relevantDiagnostics = [...entrypointDiagnostics, ...projectSettingsDiagnostics];
  const relevantDiagnosticItems = relevantDiagnostics.map((diagnostic) => ({
    ...diagnostic,
    target: resolveProjectDiagnosticTarget(project, diagnostic.path),
  }));

  function updateMetadata(patch: { name?: string; version?: string; author?: string; description?: string }) {
    runProjectCommand('project.updateMetadata', patch, 'Update project metadata');
  }

  function setEntrypoint(target: { kind: 'room' | 'scene' | 'dialogue'; id: string } | null) {
    runProjectCommand('project.setEntrypoint', { target }, 'Set project entrypoint');
  }

  function setSystemLayout(role: SystemLayoutRole, layoutId: string | null) {
    runProjectCommand('project.setSystemLayout', { role, layoutId }, 'Set project system layout');
  }

  function setDefaultFont(assetId: string | null) {
    runProjectCommand('project.setDefaultFont', { assetId }, 'Set project default font');
  }

  function setTitleScreen(patch: { titleImageId?: string | null; showProjectTitle?: boolean; showAuthor?: boolean; subtitle?: string; startLabel?: string }) {
    runProjectCommand('project.setTitleScreen', patch, 'Update title screen settings');
  }

  function setProjectIcon(assetId: string | null) {
    runProjectCommand('project.setIcon', { assetId }, 'Set project icon');
  }

  function setAppIdentity(patch: Partial<ProjectAppSettings>) {
    runProjectCommand('project.replaceAtPath', { path: '/settings/app', value: { ...settings!.app, ...patch } }, 'Update app identity');
  }

  function setDisplay(display: ProjectDisplaySettings) {
    runProjectCommand('project.setDisplay', display, 'Update project display');
  }

  function setRoomNavigationTransition(patch: Partial<{ kind: 'cut' | 'fade' | 'dissolve'; durationMs: number; color: string | null; skippable: boolean }>) {
    runProjectCommand('project.replaceAtPath', {
      path: '/settings/presentation/roomNavigationTransition',
      value: { ...settings!.presentation.roomNavigationTransition, ...patch },
    }, 'Update default room navigation transition');
  }

  function openWorkflowManager() {
    navigateToWorkbenchTarget({ tab: buildComfyUiWorkflowsTab() });
  }

  return (
    <div ref={scrollRef} className="flex h-full min-h-0 flex-col overflow-auto bg-background p-4" data-project-settings-editor-scroll>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-lg font-semibold">Project Settings</h2>
            <Badge variant="outline">{project.project.id}</Badge>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">Game metadata, startup entrypoint, runtime defaults, title screen options, and package-facing identity.</p>
        </div>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-[1fr_360px]">
        <div className="space-y-4">
          <Card data-workbench-anchor="projectSettings.metadata">
            <CardHeader>
              <CardTitle>Metadata</CardTitle>
              <CardDescription>Project identity used by the editor, package metadata, and built-in title UI.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="project-title">Project title</Label>
                <Input id="project-title" value={project.project.name} onChange={(event) => updateMetadata({ name: event.currentTarget.value })} />
              </div>
              <div className="space-y-1">
                <Label>Version</Label>
                <Input value={project.project.version} onChange={(event) => updateMetadata({ version: event.currentTarget.value })} />
              </div>
              <div className="space-y-1">
                <Label>Author</Label>
                <Input value={project.project.author} onChange={(event) => updateMetadata({ author: event.currentTarget.value })} />
              </div>
              <div className="space-y-1">
                <Label>Project ID</Label>
                <Input value={project.project.id} readOnly className="font-mono text-[11px] text-muted-foreground" />
              </div>
              <div className="space-y-1 md:col-span-2">
                <Label>Description</Label>
                <Input value={project.project.description} onChange={(event) => updateMetadata({ description: event.currentTarget.value })} />
              </div>
            </CardContent>
          </Card>

          <Card data-workbench-anchor="projectSettings.startup">
            <CardHeader>
              <CardTitle>Startup</CardTitle>
              <CardDescription>{t('selectors.entrypoint.description')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-2">
                <Label>Project entrypoint</Label>
                <div className="flex flex-wrap gap-2">
                  <Button type="button" variant="outline" className="h-8 min-w-64 justify-start px-2 text-left text-xs font-normal" onClick={() => setEntrypointSelectorOpen(true)}>
                    <span className="truncate">
                      {project.entrypoint && entrypointRecord
                        ? `${entrypointRecord.label || project.entrypoint.id} (${project.entrypoint.kind}/${project.entrypoint.id})`
                        : t('selectors.none.entrypoint')}
                    </span>
                  </Button>
                  {project.entrypoint ? <Button size="sm" variant="outline" onClick={() => setEntrypoint(null)}>{t('selectors.clear')}</Button> : null}
                </div>
                {roomEntries.length === 0 ? <p className="text-xs text-muted-foreground">Create a room before choosing a runtime-exportable entrypoint.</p> : null}
              </div>
              <div className="space-y-2">
                <Label>Init Lua script</Label>
                <SourceEditor ref={sourceEditors.refFor('startupInitScript')} className="h-40" language="lua" value={project.startupHook?.source ?? ''} onChange={(initScript) => runProjectCommand('project.setStartup', { initScript }, 'Update project startup script')} />
              </div>
            </CardContent>
          </Card>

          <Card data-workbench-anchor="projectSettings.runtime">
            <CardHeader>
              <CardTitle>Runtime Defaults</CardTitle>
              <CardDescription>Built-in fallback resources are used when no project resource is selected.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 md:grid-cols-2">
              <div className="space-y-2 md:col-span-2">
                <div>
                  <Label>System layouts</Label>
                  <p className="mt-1 text-xs text-muted-foreground">Override individual engine UI roles. Leaving a role built-in keeps the engine-provided layout for that role.</p>
                </div>
                <div className="grid gap-2 md:grid-cols-2">
                  {systemLayoutRoleValues.map((role) => {
                    const selected = project ? getSystemLayoutSetting(project, role) : null;
                    const selectedLayoutId = selected?.$ref.id ?? null;
                    const selectedLayout = selectedLayoutId ? project.layouts[selectedLayoutId] : null;
                    return (
                      <div key={role} className="space-y-1">
                        <Label>{systemLayoutRoleLabels[role]}</Label>
                        <div className="flex gap-2">
                          <Button type="button" variant="outline" className="h-8 min-w-0 flex-1 justify-start px-2 text-left text-xs font-normal" onClick={() => setSystemLayoutSelectorRole(role)}>
                            <span className="truncate">{selectedLayoutId ? `${selectedLayout?.label || selectedLayoutId} (${selectedLayoutId})` : `Built-in ${systemLayoutRoleLabels[role].toLowerCase()}`}</span>
                          </Button>
                          {selectedLayoutId ? <Button type="button" size="sm" variant="outline" onClick={() => setSystemLayout(role, null)}>{t('selectors.clear')}</Button> : null}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
              <div className="space-y-1">
                <Label htmlFor="default-font">Default font</Label>
                <select
                  id="default-font"
                  className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
                  value={valueOrNone(settings.text.defaultFont?.$ref.id)}
                  onChange={(event) => setDefaultFont(nullableValue(event.currentTarget.value))}
                >
                  <option value="__built_in__">Built-in default font</option>
                  {fontAssets.map((asset) => <option key={asset.id} value={asset.id}>{asset.label} ({asset.id})</option>)}
                </select>
              </div>
            </CardContent>
          </Card>

          <Card data-workbench-anchor="projectSettings.display">
            <CardHeader>
              <CardTitle>Display</CardTitle>
              <CardDescription>Constrain the game viewport aspect; this does not set a fixed rendering resolution.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="display-aspect-preset">Aspect ratio</Label>
                <select
                  id="display-aspect-preset"
                  className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
                  value={['16:9', '16:10', '4:3', '3:2', '21:9'].includes(`${settings.display.aspectRatio.width}:${settings.display.aspectRatio.height}`) ? `${settings.display.aspectRatio.width}:${settings.display.aspectRatio.height}` : 'custom'}
                  onChange={(event) => {
                    if (event.currentTarget.value === 'custom') return;
                    const [width, height] = event.currentTarget.value.split(':').map(Number);
                    setDisplay({ ...settings.display, aspectRatio: { width, height } });
                  }}
                >
                  {['16:9', '16:10', '4:3', '3:2', '21:9'].map((ratio) => <option key={ratio} value={ratio}>{ratio}</option>)}
                  <option value="custom">Custom</option>
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="display-orientation">Orientation</Label>
                <select id="display-orientation" className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs" value={settings.display.orientation} onChange={(event) => setDisplay({ ...settings.display, orientation: event.currentTarget.value as ProjectDisplaySettings['orientation'] })}>
                  <option value="landscape">Landscape</option>
                  <option value="portrait">Portrait</option>
                </select>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1"><Label>Ratio width</Label><Input type="number" min={1} max={10000} value={settings.display.aspectRatio.width} onChange={(event) => { const width = Number(event.currentTarget.value); if (Number.isInteger(width) && width > 0) setDisplay({ ...settings.display, aspectRatio: { ...settings.display.aspectRatio, width } }); }} /></div>
                <div className="space-y-1"><Label>Ratio height</Label><Input type="number" min={1} max={10000} value={settings.display.aspectRatio.height} onChange={(event) => { const height = Number(event.currentTarget.value); if (Number.isInteger(height) && height > 0) setDisplay({ ...settings.display, aspectRatio: { ...settings.display.aspectRatio, height } }); }} /></div>
              </div>
              <div className="space-y-1">
                <Label htmlFor="display-bar-color">Presentation bar color</Label>
                <Input id="display-bar-color" type="color" value={settings.display.barColor} onChange={(event) => setDisplay({ ...settings.display, barColor: event.currentTarget.value })} />
              </div>
              <div className="flex items-center text-xs text-muted-foreground">
                Effective ratio: {settings.display.orientation === 'landscape' ? `${settings.display.aspectRatio.width}:${settings.display.aspectRatio.height}` : `${settings.display.aspectRatio.height}:${settings.display.aspectRatio.width}`} {settings.display.orientation}
              </div>
              <div className="flex justify-end"><Button type="button" size="sm" variant="outline" onClick={() => setDisplay({ ...DEFAULT_PROJECT_DISPLAY_SETTINGS })}>Reset to default</Button></div>
            </CardContent>
          </Card>

          <Card data-workbench-anchor="projectSettings.titleScreen">
            <CardHeader>
              <CardTitle>Title Screen</CardTitle>
              <CardDescription>Values consumed by the built-in title/menu layout.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="title-image">Title image</Label>
                <select
                  id="title-image"
                  className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
                  value={settings.titleScreen.titleImage?.$ref.id ?? '__none__'}
                  onChange={(event) => setTitleScreen({ titleImageId: nullableValue(event.currentTarget.value) })}
                >
                  <option value="__none__">No title image</option>
                  {imageAssets.map((asset) => <option key={asset.id} value={asset.id}>{asset.label} ({asset.id})</option>)}
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="start-label">Start label</Label>
                <Input id="start-label" value={settings.titleScreen.startLabel} onChange={(event) => setTitleScreen({ startLabel: event.currentTarget.value })} />
              </div>
              <label className="flex items-center gap-2 text-xs">
                <Switch checked={settings.titleScreen.showProjectTitle} onCheckedChange={(checked) => setTitleScreen({ showProjectTitle: Boolean(checked) })} />
                Show project title
              </label>
              <label className="flex items-center gap-2 text-xs">
                <Switch checked={settings.titleScreen.showAuthor} onCheckedChange={(checked) => setTitleScreen({ showAuthor: Boolean(checked) })} />
                Show author name
              </label>
              <div className="space-y-1 md:col-span-2">
                <Label>Subtitle</Label>
                <Input value={settings.titleScreen.subtitle} onChange={(event) => setTitleScreen({ subtitle: event.currentTarget.value })} />
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-4">
          <Card data-workbench-anchor="projectSettings.packageIdentity">
            <CardHeader>
              <CardTitle>App Identity</CardTitle>
              <CardDescription>Stable identity and branding used by platform exports. Changing IDs after release can disconnect installed apps and saves.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3">
              <div className="space-y-1"><Label htmlFor="app-display-name">Display name</Label><Input id="app-display-name" value={settings.app.displayName} onChange={(event) => setAppIdentity({ displayName: event.currentTarget.value })} /></div>
              <div className="space-y-1"><Label htmlFor="app-short-name">Short name</Label><Input id="app-short-name" value={settings.app.shortName ?? ''} onChange={(event) => setAppIdentity({ shortName: event.currentTarget.value || undefined })} /></div>
              <div className="space-y-1"><Label htmlFor="app-id">Application ID</Label><Input id="app-id" className="font-mono text-[11px]" value={settings.app.applicationId} onChange={(event) => setAppIdentity({ applicationId: event.currentTarget.value })} /></div>
              <div className="space-y-1"><Label htmlFor="save-namespace">Save namespace</Label><Input id="save-namespace" className="font-mono text-[11px]" value={settings.app.saveNamespace} onChange={(event) => setAppIdentity({ saveNamespace: event.currentTarget.value })} /></div>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1"><Label htmlFor="app-version">Version name</Label><Input id="app-version" value={settings.app.versionName} onChange={(event) => setAppIdentity({ versionName: event.currentTarget.value })} /></div>
                <div className="space-y-1"><Label htmlFor="app-build">Build number</Label><Input id="app-build" type="number" min={1} value={settings.app.buildNumber ?? ''} onChange={(event) => setAppIdentity({ buildNumber: event.currentTarget.value ? Number(event.currentTarget.value) : undefined })} /></div>
              </div>
              <div className="space-y-1"><Label htmlFor="app-locale">Default locale</Label><Input id="app-locale" placeholder="en-US" value={settings.app.defaultLocale ?? ''} onChange={(event) => setAppIdentity({ defaultLocale: event.currentTarget.value || undefined })} /></div>
              <div className="space-y-1"><Label htmlFor="app-publisher">Publisher</Label><Input id="app-publisher" value={settings.app.publisher ?? ''} onChange={(event) => setAppIdentity({ publisher: event.currentTarget.value || undefined })} /></div>
              <div className="space-y-1"><Label htmlFor="project-icon">Project icon</Label><select id="project-icon" className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs" value={settings.app.icon?.$ref.id ?? '__none__'} onChange={(event) => setProjectIcon(nullableValue(event.currentTarget.value))}><option value="__none__">No project icon</option>{imageAssets.map((asset) => <option key={asset.id} value={asset.id}>{asset.label} ({asset.id})</option>)}</select></div>
              <div className="space-y-1"><Label htmlFor="launch-image">Launch image</Label><select id="launch-image" className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs" value={settings.app.launchImage?.$ref.id ?? '__none__'} onChange={(event) => setAppIdentity({ launchImage: nullableValue(event.currentTarget.value) ? { $ref: { collection: 'assets', id: event.currentTarget.value } } : null })}><option value="__none__">No launch image</option>{imageAssets.map((asset) => <option key={asset.id} value={asset.id}>{asset.label} ({asset.id})</option>)}</select></div>
              <div className="grid grid-cols-3 gap-2">
                {([['Theme', 'themeColor'], ['Accent', 'accentColor'], ['Launch', 'launchBackgroundColor']] as const).map(([label, key]) => <div key={key} className="space-y-1"><Label>{label} color</Label><Input type="color" value={settings.app[key] ?? '#000000'} onChange={(event) => setAppIdentity({ [key]: event.currentTarget.value })} /></div>)}
              </div>
              <details className="space-y-2 text-xs"><summary className="cursor-pointer font-medium">Platform identifier overrides</summary><div className="grid gap-2 pt-2"><Label htmlFor="android-app-id">Android application ID</Label><Input id="android-app-id" className="font-mono text-[11px]" value={settings.app.android.applicationId ?? ''} onChange={(event) => setAppIdentity({ android: { ...settings.app.android, applicationId: event.currentTarget.value || undefined } })} /><Label htmlFor="apple-bundle-id">Apple bundle ID</Label><Input id="apple-bundle-id" className="font-mono text-[11px]" value={settings.app.desktop.appleBundleId ?? ''} onChange={(event) => setAppIdentity({ desktop: { ...settings.app.desktop, appleBundleId: event.currentTarget.value || undefined } })} /><Label htmlFor="linux-desktop-id">Linux desktop ID</Label><Input id="linux-desktop-id" className="font-mono text-[11px]" value={settings.app.desktop.linuxDesktopId ?? ''} onChange={(event) => setAppIdentity({ desktop: { ...settings.app.desktop, linuxDesktopId: event.currentTarget.value || undefined } })} /><Label htmlFor="windows-identity">Windows identity</Label><Input id="windows-identity" value={settings.app.desktop.windowsIdentity ?? ''} onChange={(event) => setAppIdentity({ desktop: { ...settings.app.desktop, windowsIdentity: event.currentTarget.value || undefined } })} /></div></details>
            </CardContent>
          </Card>

          <Card id="project-settings-comfyui" data-workbench-anchor="projectSettings.comfyuiWorkflows">
            <CardHeader>
              <CardTitle>{t('comfyuiWorkflows.title')}</CardTitle>
              <CardDescription>{t('comfyuiWorkflows.description')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid gap-2 text-xs">
                <div className="flex items-center justify-between gap-2 rounded border px-3 py-2">
                  <span className="text-muted-foreground">{t('comfyuiWorkflows.summary.active')}</span>
                  <Badge variant="secondary">{workflowSummary.activeCount}</Badge>
                </div>
                <div className="flex items-center justify-between gap-2 rounded border px-3 py-2">
                  <span className="text-muted-foreground">{t('comfyuiWorkflows.summary.project')}</span>
                  <Badge variant="outline">{workflowSummary.projectCount}</Badge>
                </div>
                <div className="flex items-center justify-between gap-2 rounded border px-3 py-2">
                  <span className="text-muted-foreground">{t('comfyuiWorkflows.summary.invalidProject')}</span>
                  <Badge variant={workflowSummary.invalidProjectCount > 0 ? 'destructive' : 'outline'}>{workflowSummary.invalidProjectCount}</Badge>
                </div>
                {workflowSummaryMessage ? <div className="rounded border p-2 text-muted-foreground">{workflowSummaryMessage}</div> : null}
                <Button size="sm" variant="outline" onClick={openWorkflowManager}>{t('comfyuiWorkflows.actions.manage')}</Button>
              </div>
            </CardContent>
          </Card>

          <Card data-workbench-anchor="projectSettings.roomNavigationTransition">
            <CardHeader>
              <CardTitle>Room navigation transition</CardTitle>
              <CardDescription>Project fallback used when neither a request nor the selected exit supplies a transition.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1"><Label>Kind</Label><select className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs" value={settings.presentation.roomNavigationTransition.kind} onChange={(event) => setRoomNavigationTransition({ kind: event.currentTarget.value as typeof settings.presentation.roomNavigationTransition.kind })}><option value="cut">cut</option><option value="fade">fade</option><option value="dissolve">dissolve</option></select></div>
              <div className="space-y-1"><Label>Duration (ms)</Label><Input type="number" min={0} value={settings.presentation.roomNavigationTransition.durationMs} onChange={(event) => setRoomNavigationTransition({ durationMs: Number(event.currentTarget.value) })} /></div>
              <div className="space-y-1"><Label>Fade color</Label><Input value={settings.presentation.roomNavigationTransition.color ?? ''} onChange={(event) => setRoomNavigationTransition({ color: event.currentTarget.value || null })} /></div>
              <label className="flex items-center gap-2"><Switch checked={settings.presentation.roomNavigationTransition.skippable} onCheckedChange={(checked) => setRoomNavigationTransition({ skippable: checked })} />Skippable</label>
            </CardContent>
          </Card>

          <Card data-workbench-anchor="projectSettings.exportReadiness">
            <CardHeader>
              <CardTitle>Export Readiness</CardTitle>
              <CardDescription>Package export currently requires a room entrypoint.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-xs">
              <div className="flex items-center gap-2">
                <Badge variant={entrypointIsRoom ? 'default' : 'destructive'}>{entrypointIsRoom ? 'ready' : 'missing'}</Badge>
                <span>{entrypointIsRoom ? `Entrypoint room: ${entrypointIsRoom}` : 'Choose an entrypoint room before exporting.'}</span>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant="secondary">built-in fallback</Badge>
                <span>System layouts and font can use built-in resources.</span>
              </div>
            </CardContent>
          </Card>

          <Card data-workbench-anchor="projectSettings.diagnostics">
            <CardHeader>
              <CardTitle>Diagnostics</CardTitle>
              <CardDescription>Project-level validation relevant to settings and export.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-xs">
              <DiagnosticList items={relevantDiagnosticItems} emptyMessage="No project settings diagnostics." />
            </CardContent>
          </Card>
        </div>
      </div>
      <SearchSelectorDialog
        open={entrypointSelectorOpen}
        title={t('selectors.entrypoint.title')}
        placeholder={t('selectors.entrypoint.placeholder')}
        emptyMessage={t('selectors.entrypoint.empty')}
        items={entrypointItems}
        selectedId={project.entrypoint ? `record:${project.entrypoint.kind}s:${project.entrypoint.id}` : null}
        onSelect={(item) => {
          if (!item.collection || !item.entityId) return;
          if (item.collection === 'rooms' || item.collection === 'scenes' || item.collection === 'dialogues') {
            setEntrypoint({ kind: item.collection.slice(0, -1) as 'room' | 'scene' | 'dialogue', id: item.entityId });
          }
        }}
        onOpenChange={setEntrypointSelectorOpen}
      />
      <SearchSelectorDialog
        open={!!systemLayoutSelectorRole}
        title={systemLayoutSelectorRole ? `Choose ${systemLayoutRoleLabels[systemLayoutSelectorRole]}` : 'Choose system layout'}
        placeholder="Search layouts..."
        emptyMessage="No layouts found."
        items={layoutItems}
        selectedId={systemLayoutSelectorRole ? systemLayoutSelectedId(systemLayoutSelectorRole, getSystemLayoutSetting(project, systemLayoutSelectorRole)?.$ref.id) : null}
        onSelect={(item) => {
          if (!systemLayoutSelectorRole || !item.entityId) return;
          setSystemLayout(systemLayoutSelectorRole, item.entityId);
        }}
        onOpenChange={(open) => setSystemLayoutSelectorRole(open ? systemLayoutSelectorRole : null)}
      />
    </div>
  );
}
