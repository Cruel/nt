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
import { installComfyUiStarterWorkflows, listComfyUiWorkflows } from '@/comfyui/comfyui-service';
import { useProjectStore } from '@/project/project-store';
import { SearchSelectorDialog } from '@/workspace/SearchSelectorDialog';
import { buildCommandPaletteItems, filterSelectorItems } from '@/workspace/command-palette-search';
import { ComfyUiWorkflowImportDialog } from './ComfyUiWorkflowImportDialog';
import type { ComfyUiWorkflowListEntry } from '../../../shared/comfyui-workflows';
import { parseAssetData } from '../../../shared/project-schema/authoring-assets';
import { getSystemLayoutSetting, systemLayoutRoleValues, type SystemLayoutRole } from '../../../shared/project-schema/authoring-layouts';
import { isAuthoringProject } from '../../../shared/project-schema/authoring-project';
import { projectSettingsFromProject, validateTypedProjectSettings } from '../../../shared/project-schema/authoring-project-settings';
import { validateAuthoringProject } from '../../../shared/project-schema/authoring-validation';
import type { WorkbenchEditorProps } from '@/workbench/editor-registry';
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
  'load-menu': 'Load menu',
  'settings-menu': 'Settings menu',
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
  const entrypointItems = useMemo(() => filterSelectorItems(selectorItems, { collections: ['rooms', 'scenes', 'dialogues', 'scripts'], includeActions: false }), [selectorItems]);
  const layoutItems = useMemo(() => filterSelectorItems(selectorItems, { collections: ['layouts'], includeActions: false }), [selectorItems]);
  const [workflowMessage, setWorkflowMessage] = useState<string | null>(null);
  const [workflowDiagnostics, setWorkflowDiagnostics] = useState<Array<{ severity: 'error' | 'warning' | 'info'; path: string; message: string }>>([]);
  const [workflowEntries, setWorkflowEntries] = useState<ComfyUiWorkflowListEntry[]>([]);
  const [workflowImportOpen, setWorkflowImportOpen] = useState(false);
  const [workflowRepairEntry, setWorkflowRepairEntry] = useState<ComfyUiWorkflowListEntry | null>(null);
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
      setWorkflowDiagnostics([]);
      setWorkflowEntries([]);
      return;
    }
    let canceled = false;
    void listComfyUiWorkflows(projectFilePath).then((response) => {
      if (!canceled) {
        setWorkflowDiagnostics(response.diagnostics);
        setWorkflowEntries(response.entries ?? []);
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
  const entrypointIsRoom = project.entrypoint?.collection === 'rooms' ? project.entrypoint.id : null;
  const entrypointRecord = project.entrypoint ? project[project.entrypoint.collection]?.[project.entrypoint.id] : null;
  const entrypointDiagnostics = diagnostics.filter((diagnostic) => diagnostic.path.startsWith('/entrypoint'));
  const relevantDiagnostics = [...entrypointDiagnostics, ...projectSettingsDiagnostics];
  const relevantDiagnosticItems = relevantDiagnostics.map((diagnostic) => ({
    ...diagnostic,
    target: resolveProjectDiagnosticTarget(project, diagnostic.path),
  }));

  function updateMetadata(patch: { name?: string; version?: string; author?: string; description?: string }) {
    runProjectCommand('project.updateMetadata', patch, 'Update project metadata');
  }

  function setEntrypoint(target: { collection: string; id: string } | null) {
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

  async function refreshWorkflows() {
    if (!projectFilePath) return;
    const response = await listComfyUiWorkflows(projectFilePath);
    setWorkflowDiagnostics(response.diagnostics);
    setWorkflowEntries(response.entries ?? []);
  }

  async function installStarterWorkflows() {
    if (!projectFilePath) {
      setWorkflowMessage('Save the project before installing starter workflows.');
      return;
    }
    const response = await installComfyUiStarterWorkflows(projectFilePath);
    setWorkflowDiagnostics(response.diagnostics);
    setWorkflowMessage(response.success ? `Copied ${response.copied.length} file${response.copied.length === 1 ? '' : 's'}; skipped ${response.skipped.length} existing file${response.skipped.length === 1 ? '' : 's'}.` : response.error ?? 'Failed to install starter workflows.');
    await refreshWorkflows();
  }

  function revealWorkflowsFolder() {
    if (!projectFilePath) return;
    const workflowsFolder = `${projectFilePath.replace(/[/\\][^/\\]*$/u, '')}/workflows`;
    void window.noveltea.showItemInFolder(workflowsFolder);
  }

  function openRepair(entry: ComfyUiWorkflowListEntry) {
    setWorkflowRepairEntry(entry);
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
                <Label>Project title</Label>
                <Input value={project.project.name} onChange={(event) => updateMetadata({ name: event.currentTarget.value })} />
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
                        ? `${entrypointRecord.label || project.entrypoint.id} (${project.entrypoint.collection}/${project.entrypoint.id})`
                        : t('selectors.none.entrypoint')}
                    </span>
                  </Button>
                  {project.entrypoint ? <Button size="sm" variant="outline" onClick={() => setEntrypoint(null)}>{t('selectors.clear')}</Button> : null}
                </div>
                {roomEntries.length === 0 ? <p className="text-xs text-muted-foreground">Create a room before choosing a runtime-exportable entrypoint.</p> : null}
              </div>
              <div className="space-y-2">
                <Label>Init Lua script</Label>
                <SourceEditor ref={sourceEditors.refFor('startupInitScript')} className="h-40" language="lua" value={settings.startup.initScript} onChange={(initScript) => runProjectCommand('project.setStartup', { initScript }, 'Update project startup script')} />
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
              <CardTitle>App / Package Identity</CardTitle>
              <CardDescription>Project icon is stored now and can feed package/platform icons later.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              <Label htmlFor="project-icon">Project icon</Label>
              <select
                id="project-icon"
                className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
                value={settings.app.icon?.$ref.id ?? '__none__'}
                onChange={(event) => setProjectIcon(nullableValue(event.currentTarget.value))}
              >
                <option value="__none__">No project icon</option>
                {imageAssets.map((asset) => <option key={asset.id} value={asset.id}>{asset.label} ({asset.id})</option>)}
              </select>
            </CardContent>
          </Card>

          <Card id="project-settings-comfyui" data-workbench-anchor="projectSettings.comfyuiWorkflows">
            <CardHeader>
              <CardTitle>ComfyUI Workflows</CardTitle>
              <CardDescription>Install and validate project-local workflow files. Connection settings are editor preferences.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-2 rounded border p-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="text-xs font-medium">Project workflows</div>
                    <div className="text-xs text-muted-foreground">Install bundled starters or import a ComfyUI API workflow export.</div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" onClick={() => setWorkflowImportOpen(true)}>Import Workflow</Button>
                    <Button size="sm" variant="outline" onClick={() => void installStarterWorkflows()}>Save Built-in Workflows to Project</Button>
                  </div>
                </div>
                {workflowMessage ? <div className="text-xs text-muted-foreground">{workflowMessage}</div> : null}
                <div className="overflow-x-auto rounded border">
                  <table className="w-full min-w-[720px] text-left text-xs">
                    <thead className="border-b bg-muted/40 text-muted-foreground">
                      <tr>
                        <th className="px-2 py-1 font-medium">Status</th>
                        <th className="px-2 py-1 font-medium">Label</th>
                        <th className="px-2 py-1 font-medium">Role</th>
                        <th className="px-2 py-1 font-medium">ID</th>
                        <th className="px-2 py-1 font-medium">Workflow</th>
                        <th className="px-2 py-1 font-medium">Manifest</th>
                        <th className="px-2 py-1 font-medium">Diagnostics</th>
                        <th className="px-2 py-1 font-medium">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {workflowEntries.map((entry) => (
                        <tr key={entry.manifestFile} className="border-b last:border-b-0">
                          <td className="px-2 py-1 align-top">
                            <Badge variant={entry.status === 'invalid' ? 'destructive' : entry.status === 'warning' ? 'secondary' : 'outline'}>{entry.status}</Badge>
                          </td>
                          <td className="max-w-40 truncate px-2 py-1 align-top">{entry.label ?? 'Invalid manifest'}</td>
                          <td className="px-2 py-1 align-top font-mono text-[10px] text-muted-foreground">{entry.role ?? '-'}</td>
                          <td className="max-w-32 truncate px-2 py-1 align-top font-mono text-[10px] text-muted-foreground">{entry.id ?? '-'}</td>
                          <td className="max-w-36 truncate px-2 py-1 align-top font-mono text-[10px] text-muted-foreground">{entry.workflowFile ?? '-'}</td>
                          <td className="max-w-36 truncate px-2 py-1 align-top font-mono text-[10px] text-muted-foreground">{entry.manifestFile}</td>
                          <td className="px-2 py-1 align-top">{entry.diagnostics.length ? `${entry.diagnostics.length} issue${entry.diagnostics.length === 1 ? '' : 's'}` : 'None'}</td>
                          <td className="px-2 py-1 align-top">
                            <div className="flex flex-wrap gap-1">
                              <Button size="sm" variant="outline" disabled={!entry.repairable || !entry.workflowJsonText || !entry.definition} onClick={() => openRepair(entry)}>Repair</Button>
                              <Button size="sm" variant="outline" onClick={revealWorkflowsFolder}>Reveal in Folder</Button>
                            </div>
                          </td>
                        </tr>
                      ))}
                      {workflowEntries.length === 0 ? (
                        <tr><td colSpan={8} className="px-2 py-3 text-center text-muted-foreground">No project workflows installed.</td></tr>
                      ) : null}
                    </tbody>
                  </table>
                </div>
                {workflowDiagnostics.length > 0 ? <div className="space-y-1">{workflowDiagnostics.map((diagnostic, index) => {
                  const entry = workflowEntries.find((item) => diagnostic.path.includes(item.manifestFile));
                  return (
                    <div key={`${diagnostic.path}-${diagnostic.message}-${index}`} className="rounded border p-1.5 text-xs">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant={diagnostic.severity === 'error' ? 'destructive' : diagnostic.severity === 'warning' ? 'secondary' : 'outline'}>{diagnostic.severity}</Badge>
                        <span className="font-mono text-[10px] text-muted-foreground">{diagnostic.path}</span>
                        {entry?.repairable && entry.workflowJsonText && entry.definition ? <Button size="sm" variant="outline" onClick={() => openRepair(entry)}>Repair</Button> : null}
                      </div>
                      <div className="mt-1">{diagnostic.message}</div>
                    </div>
                  );
                })}</div> : <div className="text-xs text-muted-foreground">No workflow diagnostics.</div>}
              </div>
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
        selectedId={project.entrypoint ? `record:${project.entrypoint.collection}:${project.entrypoint.id}` : null}
        onSelect={(item) => {
          if (!item.collection || !item.entityId) return;
          setEntrypoint({ collection: item.collection, id: item.entityId });
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
      <ComfyUiWorkflowImportDialog
        open={workflowImportOpen}
        projectFilePath={projectFilePath}
        onOpenChange={setWorkflowImportOpen}
        onImported={async (message, diagnostics) => {
          setWorkflowMessage(message);
          setWorkflowDiagnostics(diagnostics);
          await refreshWorkflows();
        }}
      />
      <ComfyUiWorkflowImportDialog
        open={!!workflowRepairEntry}
        projectFilePath={projectFilePath}
        repairEntry={workflowRepairEntry}
        onOpenChange={(open) => {
          if (!open) setWorkflowRepairEntry(null);
        }}
        onImported={async (message, diagnostics) => {
          setWorkflowMessage(message);
          setWorkflowDiagnostics(diagnostics);
          await refreshWorkflows();
        }}
      />
    </div>
  );
}
