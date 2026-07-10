import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { PageHeader } from '@/components/page-header';
import { SourceEditor } from '@/components/source/SourceEditor';
import { codeEditorThemeLabel, codeEditorThemeOptions } from '@/components/source/source-editor-themes';
import type { CodeEditorThemeId } from '@/components/source/source-editor-theme-types';
import { listComfyUiWorkflowLibrary } from '@/comfyui/comfyui-service';
import { useComfyUiStore } from '@/comfyui/comfyui-store';
import { SUPPORTED_EDITOR_LANGUAGES, languageLabel, resolveEditorLanguage, type EditorLanguage } from '@/i18n';
import {
  usePreferencesStore,
  type Theme,
} from '@/stores/preferences-store';
import { buildComfyUiWorkflowsTab } from '@/workbench/editor-registry';
import { navigateToWorkbenchTarget } from '@/workbench/workbench-navigation';
import { ChevronLeft, ChevronRight, Code2, FolderOpen, Monitor, Moon, RotateCcw, Sun } from 'lucide-react';
import type { ComfyUiWorkflowActiveEntry, ComfyUiWorkflowRole } from '../../shared/comfyui-workflows';

export const Route = createFileRoute('/settings')({
  component: SettingsPage,
});

function ThemeOption({
  value,
  label,
  icon: Icon,
  current,
  onSelect,
}: {
  value: Theme;
  label: string;
  icon: typeof Sun;
  current: Theme;
  onSelect: (v: Theme) => void;
}) {
  const selected = current === value;
  return (
    <button
      type="button"
      onClick={() => onSelect(value)}
      className={`flex flex-col items-center gap-2 rounded-lg border p-4 transition-colors hover:bg-accent ${
        selected
          ? 'border-primary bg-accent'
          : 'border-border'
      }`}
    >
      <Icon
        className={`h-5 w-5 ${selected ? 'text-primary' : 'text-muted-foreground'}`}
      />
      <span
        className={`text-xs font-medium ${selected ? 'text-foreground' : 'text-muted-foreground'}`}
      >
        {label}
      </span>
    </button>
  );
}

const editorPreviewSource = `<div class="noveltea-layout-preview">
  <h1>NovelTea Fragment</h1>
  <p data-if="player.ready">Preview the selected editor theme.</p>
  <button id="layout-preview-counter"
    onclick="layout_preview.on_click(event, element, document)">
    Clicked 0 times
  </button>
</div>`;

type WorkflowDefaultOption = Pick<ComfyUiWorkflowActiveEntry, 'id' | 'label' | 'role'>;

function workflowDefaultOptions(
  workflows: ComfyUiWorkflowActiveEntry[],
  role: ComfyUiWorkflowRole,
  selectedId: string,
): WorkflowDefaultOption[] {
  const options = workflows.filter((workflow) => workflow.role === role);
  if (selectedId && !options.some((workflow) => workflow.id === selectedId)) {
    return [{ id: selectedId, label: selectedId, role }, ...options];
  }
  return options;
}

function CodeEditorThemeDialog({
  currentTheme,
  onApply,
}: {
  currentTheme: CodeEditorThemeId;
  onApply: (theme: CodeEditorThemeId) => void;
}) {
  const { t } = useTranslation(['settings', 'common']);
  const [open, setOpen] = useState(false);
  const [draftTheme, setDraftTheme] = useState<CodeEditorThemeId>(currentTheme);
  const currentIndex = Math.max(0, codeEditorThemeOptions.findIndex((option) => option.id === draftTheme));
  const draftOption = codeEditorThemeOptions[currentIndex] ?? codeEditorThemeOptions[0]!;

  function openDialog() {
    setDraftTheme(currentTheme);
    setOpen(true);
  }

  function cycle(offset: number) {
    const nextIndex = (currentIndex + offset + codeEditorThemeOptions.length) % codeEditorThemeOptions.length;
    setDraftTheme(codeEditorThemeOptions[nextIndex]!.id);
  }

  function applyTheme() {
    onApply(draftTheme);
    setOpen(false);
  }

  return (
    <>
      <Button type="button" variant="outline" onClick={openDialog}>
        <Code2 />
        {codeEditorThemeLabel(currentTheme)}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="!max-w-[min(960px,calc(100vw-2rem))] gap-4 p-5">
          <DialogHeader>
            <DialogTitle>{t('settings:codeEditor.dialog.title')}</DialogTitle>
            <DialogDescription>
              {t('settings:codeEditor.dialog.description')}
            </DialogDescription>
          </DialogHeader>
          <div className="grid min-h-0 gap-4">
            <div className="grid gap-3 md:grid-cols-[minmax(220px,320px)_1fr] md:items-end">
              <div className="space-y-1">
                <Label>{t('settings:codeEditor.selectTheme')}</Label>
                <Select value={draftTheme} onValueChange={(value) => setDraftTheme(value as CodeEditorThemeId)}>
                  <SelectTrigger className="w-full">
                    <SelectValue>{draftOption.label}</SelectValue>
                  </SelectTrigger>
                  <SelectContent align="start" className="max-h-80">
                    {codeEditorThemeOptions.map((option) => (
                      <SelectItem key={option.id} value={option.id}>
                        <span>{option.label}</span>
                        <span className="text-muted-foreground">{option.variant}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex min-w-0 items-center gap-2">
                <div className="flex min-w-0 flex-1 items-center justify-between gap-3 rounded-md border bg-muted/30 px-3 py-2">
                  <div className="truncate text-xs font-medium">{draftOption.label}</div>
                  <div className="shrink-0 text-[11px] text-muted-foreground">{t('settings:codeEditor.dialog.position', { current: currentIndex + 1, total: codeEditorThemeOptions.length })}</div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button type="button" variant="outline" size="icon-sm" onClick={() => cycle(-1)} aria-label={t('settings:codeEditor.dialog.previousTheme')}>
                    <ChevronLeft />
                  </Button>
                  <Button type="button" variant="outline" size="icon-sm" onClick={() => cycle(1)} aria-label={t('settings:codeEditor.dialog.nextTheme')}>
                    <ChevronRight />
                  </Button>
                </div>
              </div>
            </div>
            <div className="min-h-0 min-w-0">
              <SourceEditor
                value={editorPreviewSource}
                readOnly
                language="rml"
                themeId={draftTheme}
                className="h-[420px] min-h-0 w-full"
              />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>{t('common:actions.cancel')}</Button>
            <Button type="button" onClick={applyTheme}>{t('common:actions.applyTheme')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function SettingsPage() {
  const { t } = useTranslation(['settings', 'common']);
  const theme = usePreferencesStore((s) => s.theme);
  const language = usePreferencesStore((s) => s.language);
  const codeEditorTheme = usePreferencesStore((s) => s.codeEditorTheme);
  const restoreLastProjectOnStart = usePreferencesStore((s) => s.restoreLastProjectOnStart);
  const showPreviewFpsCounter = usePreferencesStore((s) => s.showPreviewFpsCounter);
  const previewFpsCap = usePreferencesStore((s) => s.previewFpsCap);
  const previewDisplay = usePreferencesStore((s) => s.previewDisplay);
  const defaultProjectDirectory = usePreferencesStore((s) => s.defaultProjectDirectory);
  const comfyUiConfig = usePreferencesStore((s) => s.comfyUiConfig);
  const setTheme = usePreferencesStore((s) => s.setTheme);
  const setLanguage = usePreferencesStore((s) => s.setLanguage);
  const setCodeEditorTheme = usePreferencesStore((s) => s.setCodeEditorTheme);
  const setRestoreLastProjectOnStart = usePreferencesStore((s) => s.setRestoreLastProjectOnStart);
  const setShowPreviewFpsCounter = usePreferencesStore((s) => s.setShowPreviewFpsCounter);
  const setPreviewFpsCap = usePreferencesStore((s) => s.setPreviewFpsCap);
  const setPreviewDisplay = usePreferencesStore((s) => s.setPreviewDisplay);
  const setDefaultProjectDirectory = usePreferencesStore((s) => s.setDefaultProjectDirectory);
  const setComfyUiConfig = usePreferencesStore((s) => s.setComfyUiConfig);
  const comfyUiStatus = useComfyUiStore((s) => s.status);
  const checkComfyUiConnection = useComfyUiStore((s) => s.checkConnection);
  const [nativeFrame, setNativeFrame] = useState(false);
  const [nativeFrameDefault, setNativeFrameDefault] = useState(false);
  const [nativeFrameSaved, setNativeFrameSaved] = useState(false);
  const [appDefaultProjectDirectory, setAppDefaultProjectDirectory] = useState('');
  const [defaultProjectDirectoryError, setDefaultProjectDirectoryError] = useState<string | null>(null);
  const [preferredSystemLanguages, setPreferredSystemLanguages] = useState<string[]>([]);
  const [comfyUiWorkflows, setComfyUiWorkflows] = useState<ComfyUiWorkflowActiveEntry[]>([]);
  const effectiveLanguage = resolveEditorLanguage(language, preferredSystemLanguages);
  const effectiveProjectDirectory = defaultProjectDirectory ?? appDefaultProjectDirectory;
  const defaultGenerateWorkflowId = comfyUiConfig.defaultWorkflows['image.generate'] || comfyUiConfig.defaultWorkflowId;
  const defaultEditWorkflowId = comfyUiConfig.defaultWorkflows['image.edit'] || 'flux2-klein-image-edit';
  const generateWorkflowOptions = workflowDefaultOptions(comfyUiWorkflows, 'image.generate', defaultGenerateWorkflowId);
  const editWorkflowOptions = workflowDefaultOptions(comfyUiWorkflows, 'image.edit', defaultEditWorkflowId);

  useEffect(() => {
    let mounted = true;
    void window.noveltea.getAppInfo().then((info) => {
      if (!mounted) return;
      setNativeFrame(info.nativeFrame);
      setNativeFrameDefault(info.platform === 'linux');
      setPreferredSystemLanguages(info.preferredSystemLanguages);
    });
    void window.noveltea.getDefaultProjectDirectory().then((directory) => {
      if (!mounted) return;
      setAppDefaultProjectDirectory(directory);
    });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    void listComfyUiWorkflowLibrary({ includeOverridden: false }).then((library) => {
      if (!mounted) return;
      setComfyUiWorkflows(library.activeWorkflows);
    }).catch(() => {
      if (!mounted) return;
      setComfyUiWorkflows([]);
    });
    return () => {
      mounted = false;
    };
  }, []);

  function updateNativeFrame(value: boolean) {
    setNativeFrame(value);
    setNativeFrameSaved(false);
    void window.noveltea.setNativeWindowFrame(value).then((info) => {
      setNativeFrame(info.nativeFrame);
      setNativeFrameSaved(true);
    });
  }

  function updateComfyUiConfig(patch: Parameters<typeof setComfyUiConfig>[0]) {
    const wasEnabled = usePreferencesStore.getState().comfyUiConfig.enabled;
    setComfyUiConfig(patch);
    useComfyUiStore.getState().hydrateFromPreferences();
    const nextConfig = usePreferencesStore.getState().comfyUiConfig;
    if (!wasEnabled && nextConfig.enabled) {
      void useComfyUiStore.getState().checkConnection(useComfyUiStore.getState().config, { showChecking: true });
    }
  }

  function updateDefaultWorkflow(role: ComfyUiWorkflowRole, workflowId: string) {
    updateComfyUiConfig({
      defaultWorkflowId: role === 'image.generate' ? workflowId : comfyUiConfig.defaultWorkflowId,
      defaultWorkflows: {
        ...comfyUiConfig.defaultWorkflows,
        [role]: workflowId,
      },
    });
  }

  function openComfyUiWorkflows() {
    navigateToWorkbenchTarget({ tab: buildComfyUiWorkflowsTab() });
  }

  async function testComfyUiConnection() {
    const config = usePreferencesStore.getState().comfyUiConfig;
    await checkComfyUiConnection(config, { showChecking: true });
  }

  async function chooseDefaultProjectDirectory() {
    const directory = await window.noveltea.selectDirectory({
      title: t('settings:workspace.defaultProjectDirectoryDialogTitle'),
      defaultPath: effectiveProjectDirectory || null,
    });
    if (!directory) return;
    if (/\s/.test(directory)) {
      setDefaultProjectDirectoryError(t('settings:workspace.defaultProjectDirectoryNoSpaces'));
      return;
    }
    setDefaultProjectDirectoryError(null);
    setDefaultProjectDirectory(directory);
  }

  return (
    <>
      <PageHeader
        title={t('settings:page.title')}
        description={t('settings:page.description')}
      />
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-6 [&>*]:shrink-0">
        <Card data-workbench-anchor="settings.theme">
          <CardHeader>
            <CardTitle>{t('settings:theme.title')}</CardTitle>
            <CardDescription>
              {t('settings:theme.description')}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex gap-3">
              <ThemeOption
                value="system"
                label={t('settings:theme.options.system')}
                icon={Monitor}
                current={theme}
                onSelect={setTheme}
              />
              <ThemeOption
                value="light"
                label={t('settings:theme.options.light')}
                icon={Sun}
                current={theme}
                onSelect={setTheme}
              />
              <ThemeOption
                value="dark"
                label={t('settings:theme.options.dark')}
                icon={Moon}
                current={theme}
                onSelect={setTheme}
              />
            </div>
          </CardContent>
        </Card>

        <Card data-workbench-anchor="settings.codeEditor">
          <CardHeader>
            <CardTitle>{t('settings:codeEditor.title')}</CardTitle>
            <CardDescription>
              {t('settings:codeEditor.description')}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="flex items-center justify-between gap-6">
              <div>
                <Label>{t('settings:codeEditor.editorTheme')}</Label>
                <p className="text-xs text-muted-foreground">
                  {t('settings:codeEditor.editorThemeDescription')}
                </p>
              </div>
              <CodeEditorThemeDialog currentTheme={codeEditorTheme} onApply={setCodeEditorTheme} />
            </div>
          </CardContent>
        </Card>

        <Card data-workbench-anchor="settings.language">
          <CardHeader>
            <CardTitle>{t('settings:language.title')}</CardTitle>
            <CardDescription>{t('settings:language.description')}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between gap-6">
              <div>
                <Label>{t('settings:language.label')}</Label>
                {language === 'system' ? (
                  <p className="text-xs text-muted-foreground">
                    {t('settings:language.effective', { language: languageLabel(effectiveLanguage) })}
                  </p>
                ) : null}
              </div>
              <Select value={language} onValueChange={(value) => setLanguage(value as EditorLanguage)}>
                <SelectTrigger className="min-w-56">
                  <SelectValue>{t(`settings:language.options.${language}`)}</SelectValue>
                </SelectTrigger>
                <SelectContent align="end">
                  <SelectItem value="system">{t('settings:language.options.system')}</SelectItem>
                  {SUPPORTED_EDITOR_LANGUAGES.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {t(`settings:language.options.${option.value}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>

        <Card data-workbench-anchor="settings.window">
          <CardHeader>
            <CardTitle>{t('settings:window.title')}</CardTitle>
            <CardDescription>
              {t('settings:window.description')}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="grid gap-3 rounded-md border p-3 md:grid-cols-2">
              <div className="space-y-1"><Label>Display profile</Label><Select value={previewDisplay.mode} onValueChange={(mode) => setPreviewDisplay(mode === 'custom' ? { mode: 'custom', aspectRatio: { width: 16, height: 9 }, orientation: 'landscape', scaling: previewDisplay.scaling } : { mode: 'project', scaling: previewDisplay.scaling })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="project">Follow Project</SelectItem><SelectItem value="custom">Custom</SelectItem></SelectContent></Select></div>
              {previewDisplay.mode === 'custom' ? <><div className="space-y-1"><Label>Orientation</Label><Select value={previewDisplay.orientation} onValueChange={(orientation) => setPreviewDisplay({ ...previewDisplay, orientation: orientation as 'landscape' | 'portrait' })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="landscape">Landscape</SelectItem><SelectItem value="portrait">Portrait</SelectItem></SelectContent></Select></div><div className="grid grid-cols-2 gap-2"><Input aria-label="Preview ratio width" type="number" min={1} max={10000} value={previewDisplay.aspectRatio.width} onChange={(event) => { const width = Number(event.currentTarget.value); if (width > 0) setPreviewDisplay({ ...previewDisplay, aspectRatio: { ...previewDisplay.aspectRatio, width } }); }} /><Input aria-label="Preview ratio height" type="number" min={1} max={10000} value={previewDisplay.aspectRatio.height} onChange={(event) => { const height = Number(event.currentTarget.value); if (height > 0) setPreviewDisplay({ ...previewDisplay, aspectRatio: { ...previewDisplay.aspectRatio, height } }); }} /></div></> : null}
              <div className="space-y-1"><Label>Play scaling</Label><Select value={previewDisplay.scaling.play} onValueChange={(play) => setPreviewDisplay({ ...previewDisplay, scaling: { ...previewDisplay.scaling, play: play as 'responsive' | 'reference' } })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="responsive">Responsive layout test</SelectItem><SelectItem value="reference">Reference composition</SelectItem></SelectContent></Select></div>
              <div className="space-y-1"><Label>Pooled preview scaling</Label><Select value={previewDisplay.scaling.pooled} onValueChange={(pooled) => setPreviewDisplay({ ...previewDisplay, scaling: { ...previewDisplay.scaling, pooled: pooled as 'responsive' | 'reference' } })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="reference">Reference composition</SelectItem><SelectItem value="responsive">Responsive layout test</SelectItem></SelectContent></Select></div>
              <div className="space-y-1"><Label>Reference long axis</Label><Input type="number" min={320} max={4096} value={previewDisplay.scaling.referenceLongAxis} onChange={(event) => setPreviewDisplay({ ...previewDisplay, scaling: { ...previewDisplay.scaling, referenceLongAxis: Number(event.currentTarget.value) } })} /></div>
              <div className="flex items-end justify-end"><Button type="button" size="sm" variant="outline" onClick={() => setPreviewDisplay({ mode: 'project', scaling: { play: 'responsive', pooled: 'reference', referenceLongAxis: 1280 } })}>Reset to Follow Project</Button></div>
            </div>
            <div className="flex items-center justify-between gap-6">
              <div>
                <Label htmlFor="native-window-frame">{t('settings:window.nativeFrame')}</Label>
                <p className="text-xs text-muted-foreground">
                  {t('settings:window.nativeFrameDescription')}
                </p>
                {nativeFrameSaved && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t('settings:window.nativeFrameSaved')}
                  </p>
                )}
              </div>
              <Switch
                id="native-window-frame"
                checked={nativeFrame}
                onCheckedChange={updateNativeFrame}
              />
            </div>
          </CardContent>
        </Card>

        <Card data-workbench-anchor="settings.workspace">
          <CardHeader>
            <CardTitle>{t('settings:workspace.title')}</CardTitle>
            <CardDescription>
              {t('settings:workspace.description')}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="grid gap-4">
              <div className="flex items-center justify-between">
                <div>
                  <Label htmlFor="restore-last-project">{t('settings:workspace.restoreLastProject')}</Label>
                  <p className="text-xs text-muted-foreground">
                    {t('settings:workspace.restoreLastProjectDescription')}
                  </p>
                </div>
                <Switch
                  id="restore-last-project"
                  checked={restoreLastProjectOnStart}
                  onCheckedChange={setRestoreLastProjectOnStart}
                />
              </div>
              <div className="grid gap-2">
                <div>
                  <Label htmlFor="default-project-directory">{t('settings:workspace.defaultProjectDirectory')}</Label>
                  <p className="text-xs text-muted-foreground">
                    {t('settings:workspace.defaultProjectDirectoryDescription')}
                  </p>
                </div>
                <div className="flex min-w-0 items-center gap-2">
                  <Input
                    id="default-project-directory"
                    className="font-mono text-[11px]"
                    value={effectiveProjectDirectory}
                    readOnly
                  />
                  <Button type="button" variant="outline" onClick={chooseDefaultProjectDirectory}>
                    <FolderOpen />
                    {t('settings:workspace.changeDefaultProjectDirectory')}
                  </Button>
                  <Button type="button" variant="outline" size="icon" onClick={() => { setDefaultProjectDirectoryError(null); setDefaultProjectDirectory(null); }} aria-label={t('settings:workspace.resetDefaultProjectDirectory')}>
                    <RotateCcw />
                  </Button>
                </div>
                {defaultProjectDirectoryError ? <p className="text-[11px] text-destructive">{defaultProjectDirectoryError}</p> : null}
              </div>
            </div>
          </CardContent>
        </Card>

        <Card data-workbench-anchor="settings.preview">
          <CardHeader>
            <CardTitle>{t('settings:preview.title')}</CardTitle>
            <CardDescription>
              {t('settings:preview.description')}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between gap-6">
              <div>
                <Label htmlFor="show-preview-fps-counter">{t('settings:preview.showFpsCounter')}</Label>
                <p className="text-xs text-muted-foreground">
                  {t('settings:preview.showFpsCounterDescription')}
                </p>
              </div>
              <Switch
                id="show-preview-fps-counter"
                checked={showPreviewFpsCounter}
                onCheckedChange={setShowPreviewFpsCounter}
              />
            </div>
            <div className="flex items-center justify-between gap-6">
              <div>
                <Label htmlFor="preview-fps-cap">{t('settings:preview.fpsCap')}</Label>
                <p className="text-xs text-muted-foreground">
                  {t('settings:preview.fpsCapDescription')}
                </p>
              </div>
              <Input
                id="preview-fps-cap"
                className="w-24"
                type="number"
                min="0"
                max="1000"
                step="1"
                value={previewFpsCap}
                onChange={(event) => setPreviewFpsCap(Number(event.currentTarget.value))}
              />
            </div>
          </CardContent>
        </Card>

        <Card data-workbench-anchor="settings.comfyui">
          <CardHeader>
            <CardTitle>{t('settings:comfyui.title')}</CardTitle>
            <CardDescription>
              {t('settings:comfyui.description')}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4">
              <div className="flex items-center justify-between gap-6">
                <div>
                  <Label htmlFor="comfyui-enabled">{t('settings:comfyui.enabled')}</Label>
                  <p className="text-xs text-muted-foreground">
                    {t('settings:comfyui.enabledDescription')}
                  </p>
                </div>
                <Switch
                  id="comfyui-enabled"
                  checked={comfyUiConfig.enabled}
                  onCheckedChange={(enabled) => updateComfyUiConfig({ enabled: Boolean(enabled) })}
                />
              </div>
              <div className="grid gap-2 md:grid-cols-[minmax(240px,1fr)_minmax(190px,240px)_minmax(190px,240px)]">
                <div className="space-y-1">
                  <Label htmlFor="comfyui-server-url">{t('settings:comfyui.serverUrl')}</Label>
                  <Input
                    id="comfyui-server-url"
                    value={comfyUiConfig.serverUrl}
                    onChange={(event) => updateComfyUiConfig({ serverUrl: event.currentTarget.value })}
                    placeholder="http://127.0.0.1:8000"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="comfyui-default-workflow">{t('settings:comfyui.defaultWorkflow')}</Label>
                  <select
                    id="comfyui-default-workflow"
                    className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm outline-none transition-colors focus-visible:ring-1 focus-visible:ring-ring"
                    value={defaultGenerateWorkflowId}
                    onChange={(event) => updateDefaultWorkflow('image.generate', event.currentTarget.value)}
                  >
                    {generateWorkflowOptions.length > 0 ? generateWorkflowOptions.map((workflow) => (
                      <option key={workflow.id} value={workflow.id}>{workflow.label}</option>
                    )) : (
                      <option value="">{t('settings:comfyui.noWorkflows')}</option>
                    )}
                  </select>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="comfyui-default-edit-workflow">{t('settings:comfyui.defaultEditWorkflow')}</Label>
                  <select
                    id="comfyui-default-edit-workflow"
                    className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm outline-none transition-colors focus-visible:ring-1 focus-visible:ring-ring"
                    value={defaultEditWorkflowId}
                    onChange={(event) => updateDefaultWorkflow('image.edit', event.currentTarget.value)}
                  >
                    {editWorkflowOptions.length > 0 ? editWorkflowOptions.map((workflow) => (
                      <option key={workflow.id} value={workflow.id}>{workflow.label}</option>
                    )) : (
                      <option value="">{t('settings:comfyui.noWorkflows')}</option>
                    )}
                  </select>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="rounded-md border px-2 py-1 text-muted-foreground">{comfyUiStatus.state}</span>
                <span className="text-muted-foreground">{comfyUiStatus.message ?? t('settings:comfyui.statusUnknown')}</span>
                <Button type="button" size="sm" variant="outline" onClick={openComfyUiWorkflows}>
                  {t('settings:comfyui.manageWorkflows')}
                </Button>
                <Button type="button" size="sm" variant="outline" onClick={() => void testComfyUiConnection()}>
                  {t('settings:comfyui.testConnection')}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        <div className="flex justify-end">
          <Button
            variant="outline"
            onClick={() => {
              setTheme('system');
              setLanguage('system');
              setCodeEditorTheme('noveltea');
              setRestoreLastProjectOnStart(true);
              setShowPreviewFpsCounter(false);
              setDefaultProjectDirectoryError(null);
              setDefaultProjectDirectory(null);
              updateComfyUiConfig({
                enabled: false,
                serverUrl: 'http://127.0.0.1:8000',
                defaultWorkflowId: 'flux2-klein-text-to-image',
                defaultWorkflows: {
                  'image.generate': 'flux2-klein-text-to-image',
                  'image.edit': 'flux2-klein-image-edit',
                },
                requestTimeoutMs: 15000,
                connectionCheckIntervalMs: 10000,
              });
              updateNativeFrame(nativeFrameDefault);
            }}
          >
            {t('common:actions.resetToDefaults')}
          </Button>
        </div>
      </div>
    </>
  );
}
