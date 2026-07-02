import { useMemo } from 'react';
import { SourceEditor } from '@/components/source/SourceEditor';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useCommandStore } from '@/commands/command-store';
import { useComfyUiStore } from '@/comfyui/comfyui-store';
import { useProjectStore } from '@/project/project-store';
import { useWorkspaceStore } from '@/stores/workspace-store';
import { parseAssetData } from '../../../shared/project-schema/authoring-assets';
import { getDefaultLayoutSetting } from '../../../shared/project-schema/authoring-layouts';
import { isAuthoringProject } from '../../../shared/project-schema/authoring-project';
import { projectSettingsFromProject, validateTypedProjectSettings } from '../../../shared/project-schema/authoring-project-settings';
import { validateAuthoringProject } from '../../../shared/project-schema/authoring-validation';
import type { WorkbenchEditorProps } from '@/workbench/editor-registry';

function valueOrNone(value: string | null | undefined) {
  return value ?? '__built_in__';
}

function nullableValue(value: string) {
  return value === '__built_in__' || value === '__none__' ? null : value;
}

function runProjectCommand(type: string, payload: unknown, label: string) {
  useCommandStore.getState().executeCommand({ type, label, payload });
}

export function ProjectSettingsEditor(_props: WorkbenchEditorProps) {
  const projectDocument = useProjectStore((state) => state.document);
  const project = isAuthoringProject(projectDocument) ? projectDocument : null;
  const settings = project ? projectSettingsFromProject(project) : null;
  const defaultLayout = project ? getDefaultLayoutSetting(project) : null;
  const diagnostics = useMemo(() => project ? validateAuthoringProject(project) : [], [project]);
  const projectSettingsDiagnostics = useMemo(() => project ? validateTypedProjectSettings(project) : [], [project]);
  const comfyUiStatus = useComfyUiStore((state) => state.status);
  const checkComfyUiConnection = useComfyUiStore((state) => state.checkConnection);

  if (!project || !settings) return <div className="p-4 text-sm text-muted-foreground">Open an authoring project to edit project settings.</div>;

  const comfyUiSettings = settings.comfyui;
  const roomEntries = Object.entries(project.rooms).map(([id, room]) => ({ id, label: room.label || id }));
  const layoutEntries = Object.entries(project.layouts).map(([id, layout]) => ({ id, label: layout.label || id }));
  const imageAssets = Object.entries(project.assets)
    .filter(([, asset]) => parseAssetData(asset.data)?.kind === 'image')
    .map(([id, asset]) => ({ id, label: asset.label || id }));
  const fontAssets = Object.entries(project.assets)
    .filter(([, asset]) => parseAssetData(asset.data)?.kind === 'font')
    .map(([id, asset]) => ({ id, label: asset.label || id }));
  const entrypointIsRoom = project.entrypoint?.collection === 'rooms' ? project.entrypoint.id : null;
  const entrypointDiagnostics = diagnostics.filter((diagnostic) => diagnostic.path.startsWith('/entrypoint'));
  const relevantDiagnostics = [...entrypointDiagnostics, ...projectSettingsDiagnostics];

  function updateMetadata(patch: { name?: string; version?: string; author?: string; description?: string }) {
    runProjectCommand('project.updateMetadata', patch, 'Update project metadata');
  }

  function setEntrypoint(roomId: string | null) {
    runProjectCommand('project.setEntrypoint', { target: roomId ? { collection: 'rooms', id: roomId } : null }, 'Set project entrypoint');
  }

  function setDefaultLayout(layoutId: string | null) {
    runProjectCommand('project.setRuntimeDefaultLayout', { layoutId }, 'Set project default layout');
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

  function setComfyUi(patch: { enabled?: boolean; serverUrl?: string; defaultWorkflowId?: string; outputSubfolder?: string }) {
    runProjectCommand('project.setComfyUi', patch, 'Update ComfyUI settings');
  }

  async function testComfyUiConnection() {
    await checkComfyUiConnection(comfyUiSettings, { showChecking: true });
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto bg-background p-4">
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
          <Card>
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

          <Card>
            <CardHeader>
              <CardTitle>Startup</CardTitle>
              <CardDescription>Runtime export currently supports room entrypoints only.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-2">
                <Label htmlFor="project-entrypoint">Entrypoint room</Label>
                <div className="flex flex-wrap gap-2">
                  <select
                    id="project-entrypoint"
                    className="h-8 min-w-64 rounded-md border border-input bg-background px-2 text-xs"
                    value={entrypointIsRoom ?? '__none__'}
                    onChange={(event) => setEntrypoint(nullableValue(event.currentTarget.value))}
                  >
                    <option value="__none__">No entrypoint</option>
                    {roomEntries.map((room) => <option key={room.id} value={room.id}>{room.label} ({room.id})</option>)}
                  </select>
                  {entrypointIsRoom ? <Button size="sm" variant="outline" onClick={() => setEntrypoint(null)}>Clear</Button> : null}
                </div>
                {roomEntries.length === 0 ? <p className="text-xs text-muted-foreground">Create a room before choosing a runtime-exportable entrypoint.</p> : null}
              </div>
              <div className="space-y-2">
                <Label>Init Lua script</Label>
                <SourceEditor className="h-40" language="lua" value={settings.startup.initScript} onChange={(initScript) => runProjectCommand('project.setStartup', { initScript }, 'Update project startup script')} />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Runtime Defaults</CardTitle>
              <CardDescription>Built-in fallback resources are used when no project resource is selected.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="default-layout">Default layout</Label>
                <select
                  id="default-layout"
                  className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
                  value={valueOrNone(defaultLayout?.$ref.id)}
                  onChange={(event) => setDefaultLayout(nullableValue(event.currentTarget.value))}
                >
                  <option value="__built_in__">Built-in default layout</option>
                  {layoutEntries.map((layout) => <option key={layout.id} value={layout.id}>{layout.label} ({layout.id})</option>)}
                </select>
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

          <Card>
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
          <Card>
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

          <Card>
            <CardHeader>
              <CardTitle>ComfyUI</CardTitle>
              <CardDescription>Configure a ComfyUI server for generated images and future image-editing workflows.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <label className="flex items-center gap-2 text-xs">
                <Switch checked={comfyUiSettings.enabled} onCheckedChange={(checked) => setComfyUi({ enabled: Boolean(checked) })} />
                Enable ComfyUI integration
              </label>
              <div className="space-y-1">
                <Label htmlFor="comfyui-server-url">Server URL</Label>
                <Input
                  id="comfyui-server-url"
                  value={comfyUiSettings.serverUrl}
                  onChange={(event) => setComfyUi({ serverUrl: event.currentTarget.value })}
                  placeholder="http://127.0.0.1:8000"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="comfyui-workflow">Default workflow</Label>
                <select
                  id="comfyui-workflow"
                  className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
                  value={comfyUiSettings.defaultWorkflowId}
                  onChange={(event) => setComfyUi({ defaultWorkflowId: event.currentTarget.value })}
                >
                  <option value="basic-text-to-image">Basic Text to Image</option>
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="comfyui-output-folder">Generated image folder</Label>
                <Input
                  id="comfyui-output-folder"
                  value={comfyUiSettings.outputSubfolder}
                  onChange={(event) => setComfyUi({ outputSubfolder: event.currentTarget.value })}
                />
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <Badge variant={comfyUiStatus.state === 'ready' ? 'default' : comfyUiStatus.state === 'error' ? 'destructive' : 'secondary'}>{comfyUiStatus.state}</Badge>
                <span className="text-muted-foreground">{comfyUiStatus.message ?? 'ComfyUI status has not been checked yet.'}</span>
                <Button size="sm" variant="outline" onClick={() => void testComfyUiConnection()}>Test Connection</Button>
              </div>
            </CardContent>
          </Card>

          <Card>
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
                <span>Default layout and font can use built-in resources.</span>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Diagnostics</CardTitle>
              <CardDescription>Project-level validation relevant to settings and export.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-xs">
              {relevantDiagnostics.length === 0 ? <p className="text-muted-foreground">No project settings diagnostics.</p> : relevantDiagnostics.map((diagnostic, index) => (
                <div key={`${diagnostic.path}-${diagnostic.message}-${index}`} className="rounded border p-2">
                  <div className="mb-1 flex items-center gap-2">
                    <Badge variant={diagnostic.severity === 'error' ? 'destructive' : diagnostic.severity === 'warning' ? 'secondary' : 'outline'}>{diagnostic.severity}</Badge>
                    <span className="font-mono text-[10px] text-muted-foreground">{diagnostic.path}</span>
                  </div>
                  <div>{diagnostic.message}</div>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
