import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { PageHeader } from '@/components/page-header';
import {
  SettingsCategoryLayout,
  type SettingsCategory,
} from '@/components/settings/SettingsCategoryLayout';
import { SourceEditor } from '@/components/source/SourceEditor';
import {
  codeEditorThemeLabel,
  codeEditorThemeOptions,
} from '@/components/source/source-editor-themes';
import type { CodeEditorThemeId } from '@/components/source/source-editor-theme-types';
import { listComfyUiWorkflowLibrary } from '@/comfyui/comfyui-service';
import { useComfyUiStore } from '@/comfyui/comfyui-store';
import {
  SUPPORTED_EDITOR_LANGUAGES,
  languageLabel,
  resolveEditorLanguage,
  type EditorLanguage,
} from '@/i18n';
import {
  selectEditorPreferencesAreDefaults,
  usePreferencesStore,
  type Theme,
} from '@/stores/preferences-store';
import type { EditorPreviewLayoutPreference } from '@/components/editor-preview-layout';
import type { RmlUiRasterSnapMode } from '../../shared/preview-protocol';
import {
  buildComfyUiWorkflowsTab,
  buildPlatformExportProfilesTab,
} from '@/workbench/editor-registry';
import { navigateToWorkbenchTarget } from '@/workbench/workbench-navigation';
import { registerWorkbenchTargetHandler } from '@/workbench/workbench-navigation';
import {
  AppWindow,
  ChevronLeft,
  ChevronRight,
  Code2,
  FolderKanban,
  FolderOpen,
  Monitor,
  Moon,
  PackageOpen,
  Palette,
  Play,
  RotateCcw,
  Sun,
  WandSparkles,
} from 'lucide-react';
import type {
  ComfyUiWorkflowActiveEntry,
  ComfyUiWorkflowRole,
} from '../../shared/comfyui-workflows';

export const Route = createFileRoute('/settings')({
  component: SettingsPage,
});

export type EditorSettingsCategory =
  | 'appearance'
  | 'window'
  | 'workspace'
  | 'preview'
  | 'export'
  | 'comfyui';

function editorSettingsCategoryForTarget(targetId: string): EditorSettingsCategory | null {
  if (
    targetId.startsWith('settings.theme') ||
    targetId.startsWith('settings.codeEditor') ||
    targetId.startsWith('settings.language')
  )
    return 'appearance';
  if (targetId.startsWith('settings.window')) return 'window';
  if (targetId.startsWith('settings.workspace')) return 'workspace';
  if (targetId.startsWith('settings.preview')) return 'preview';
  if (targetId.startsWith('settings.export')) return 'export';
  if (targetId.startsWith('settings.comfyui')) return 'comfyui';
  return null;
}

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
      className={`flex flex-col items-center gap-1.5 rounded-lg border p-3 transition-colors hover:bg-accent ${
        selected ? 'border-primary bg-accent' : 'border-border'
      }`}
    >
      <Icon className={`h-5 w-5 ${selected ? 'text-primary' : 'text-muted-foreground'}`} />
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
  const currentIndex = Math.max(
    0,
    codeEditorThemeOptions.findIndex((option) => option.id === draftTheme),
  );
  const draftOption = codeEditorThemeOptions[currentIndex] ?? codeEditorThemeOptions[0]!;

  function openDialog() {
    setDraftTheme(currentTheme);
    setOpen(true);
  }

  function cycle(offset: number) {
    const nextIndex =
      (currentIndex + offset + codeEditorThemeOptions.length) % codeEditorThemeOptions.length;
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
            <DialogDescription>{t('settings:codeEditor.dialog.description')}</DialogDescription>
          </DialogHeader>
          <div className="grid min-h-0 gap-4">
            <div className="grid gap-3 md:grid-cols-[minmax(220px,320px)_1fr] md:items-end">
              <div className="space-y-1">
                <Label>{t('settings:codeEditor.selectTheme')}</Label>
                <Select
                  value={draftTheme}
                  onValueChange={(value) => setDraftTheme(value as CodeEditorThemeId)}
                >
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
                  <div className="shrink-0 text-[11px] text-muted-foreground">
                    {t('settings:codeEditor.dialog.position', {
                      current: currentIndex + 1,
                      total: codeEditorThemeOptions.length,
                    })}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    type="button"
                    variant="outline"
                    size="icon-sm"
                    onClick={() => cycle(-1)}
                    aria-label={t('settings:codeEditor.dialog.previousTheme')}
                  >
                    <ChevronLeft />
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon-sm"
                    onClick={() => cycle(1)}
                    aria-label={t('settings:codeEditor.dialog.nextTheme')}
                  >
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
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              {t('common:actions.cancel')}
            </Button>
            <Button type="button" onClick={applyTheme}>
              {t('common:actions.applyTheme')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function SettingsPage({
  tabId,
  activeCategory: controlledActiveCategory,
  onActiveCategoryChange,
}: {
  tabId?: string;
  activeCategory?: EditorSettingsCategory;
  onActiveCategoryChange?: (category: EditorSettingsCategory) => void;
} = {}) {
  const { t } = useTranslation(['settings', 'common']);
  const theme = usePreferencesStore((s) => s.theme);
  const language = usePreferencesStore((s) => s.language);
  const codeEditorTheme = usePreferencesStore((s) => s.codeEditorTheme);
  const developerMode = usePreferencesStore((s) => s.developerMode);
  const restoreLastProjectOnStart = usePreferencesStore((s) => s.restoreLastProjectOnStart);
  const showPreviewFpsCounter = usePreferencesStore((s) => s.showPreviewFpsCounter);
  const previewFpsCap = usePreferencesStore((s) => s.previewFpsCap);
  const previewRmlUiRasterSnap = usePreferencesStore((s) => s.previewRmlUiRasterSnap);
  const previewDisplay = usePreferencesStore((s) => s.previewDisplay);
  const editorPreviewLayout = usePreferencesStore((s) => s.editorPreviewLayout);
  const defaultProjectDirectory = usePreferencesStore((s) => s.defaultProjectDirectory);
  const comfyUiConfig = usePreferencesStore((s) => s.comfyUiConfig);
  const exportPreferences = usePreferencesStore((s) => s.exportPreferences);
  const preferencesAtDefaults = usePreferencesStore(selectEditorPreferencesAreDefaults);
  const setTheme = usePreferencesStore((s) => s.setTheme);
  const setLanguage = usePreferencesStore((s) => s.setLanguage);
  const setCodeEditorTheme = usePreferencesStore((s) => s.setCodeEditorTheme);
  const setDeveloperMode = usePreferencesStore((s) => s.setDeveloperMode);
  const setRestoreLastProjectOnStart = usePreferencesStore((s) => s.setRestoreLastProjectOnStart);
  const setShowPreviewFpsCounter = usePreferencesStore((s) => s.setShowPreviewFpsCounter);
  const setPreviewFpsCap = usePreferencesStore((s) => s.setPreviewFpsCap);
  const setPreviewRmlUiRasterSnap = usePreferencesStore((s) => s.setPreviewRmlUiRasterSnap);
  const setPreviewDisplay = usePreferencesStore((s) => s.setPreviewDisplay);
  const setEditorPreviewLayout = usePreferencesStore((s) => s.setEditorPreviewLayout);
  const setDefaultProjectDirectory = usePreferencesStore((s) => s.setDefaultProjectDirectory);
  const setComfyUiConfig = usePreferencesStore((s) => s.setComfyUiConfig);
  const setExportPreferences = usePreferencesStore((s) => s.setExportPreferences);
  const resetPreferencesToDefaults = usePreferencesStore((s) => s.resetToDefaults);
  const comfyUiStatus = useComfyUiStore((s) => s.status);
  const checkComfyUiConnection = useComfyUiStore((s) => s.checkConnection);
  const [nativeFrame, setNativeFrame] = useState(false);
  const [nativeFrameDefault, setNativeFrameDefault] = useState(false);
  const [nativeFrameLoaded, setNativeFrameLoaded] = useState(false);
  const [nativeFrameSaved, setNativeFrameSaved] = useState(false);
  const [appDefaultProjectDirectory, setAppDefaultProjectDirectory] = useState('');
  const [defaultProjectDirectoryError, setDefaultProjectDirectoryError] = useState<string | null>(
    null,
  );
  const [preferredSystemLanguages, setPreferredSystemLanguages] = useState<string[]>([]);
  const [comfyUiWorkflows, setComfyUiWorkflows] = useState<ComfyUiWorkflowActiveEntry[]>([]);
  const [localActiveCategory, setLocalActiveCategory] =
    useState<EditorSettingsCategory>('appearance');
  const activeCategory = controlledActiveCategory ?? localActiveCategory;
  const setActiveCategory = (category: EditorSettingsCategory) => {
    setLocalActiveCategory(category);
    onActiveCategoryChange?.(category);
  };
  const [resetDialogOpen, setResetDialogOpen] = useState(false);
  const categories: SettingsCategory[] = [
    {
      id: 'appearance',
      label: t('settings:categories.appearance'),
      description: t('settings:categories.appearanceDescription'),
      icon: Palette,
    },
    {
      id: 'window',
      label: t('settings:categories.window'),
      description: t('settings:window.description'),
      icon: AppWindow,
    },
    {
      id: 'workspace',
      label: t('settings:categories.workspace'),
      description: t('settings:workspace.description'),
      icon: FolderKanban,
    },
    {
      id: 'preview',
      label: t('settings:categories.preview'),
      description: t('settings:preview.description'),
      icon: Play,
    },
    {
      id: 'export',
      label: t('settings:categories.export'),
      description: t('settings:categories.exportDescription'),
      icon: PackageOpen,
    },
    {
      id: 'comfyui',
      label: t('settings:categories.comfyui'),
      description: t('settings:comfyui.description'),
      icon: WandSparkles,
    },
  ];
  const activeSettingsCategory =
    categories.find((category) => category.id === activeCategory) ?? categories[0]!;
  const effectiveLanguage = resolveEditorLanguage(language, preferredSystemLanguages);
  const settingsAtDefaults =
    nativeFrameLoaded && preferencesAtDefaults && nativeFrame === nativeFrameDefault;
  const effectiveProjectDirectory = defaultProjectDirectory ?? appDefaultProjectDirectory;
  const defaultGenerateWorkflowId =
    comfyUiConfig.defaultWorkflows['image.generate'] || comfyUiConfig.defaultWorkflowId;
  const defaultEditWorkflowId =
    comfyUiConfig.defaultWorkflows['image.edit'] || 'flux2-klein-image-edit';
  const generateWorkflowOptions = workflowDefaultOptions(
    comfyUiWorkflows,
    'image.generate',
    defaultGenerateWorkflowId,
  );
  const editWorkflowOptions = workflowDefaultOptions(
    comfyUiWorkflows,
    'image.edit',
    defaultEditWorkflowId,
  );

  useEffect(() => {
    let mounted = true;
    void window.noveltea.getAppInfo().then((info) => {
      if (!mounted) return;
      setNativeFrame(info.nativeFrame);
      setNativeFrameDefault(info.platform === 'linux');
      setNativeFrameLoaded(true);
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
    if (!tabId) return;
    return registerWorkbenchTargetHandler(tabId, 'settings', (target) => {
      if (target.id === 'settings.reset') {
        setResetDialogOpen(true);
        return true;
      }
      const category = editorSettingsCategoryForTarget(target.id);
      if (category) setActiveCategory(category);
      return false;
    });
  }, [tabId]);

  useEffect(() => {
    let mounted = true;
    void listComfyUiWorkflowLibrary({ includeOverridden: false })
      .then((library) => {
        if (!mounted) return;
        setComfyUiWorkflows(library.activeWorkflows);
      })
      .catch(() => {
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
      void useComfyUiStore
        .getState()
        .checkConnection(useComfyUiStore.getState().config, { showChecking: true });
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

  function openExportProfiles() {
    navigateToWorkbenchTarget({ tab: buildPlatformExportProfilesTab() });
  }

  async function chooseDefaultExportDirectory() {
    const directory = await window.noveltea.selectDirectory({
      title: 'Select default export directory',
      defaultPath: exportPreferences.defaultOutputDirectory || null,
    });
    if (directory) setExportPreferences({ defaultOutputDirectory: directory });
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

  function resetAllSettings() {
    resetPreferencesToDefaults();
    setDefaultProjectDirectoryError(null);
    useComfyUiStore.getState().hydrateFromPreferences();
    updateNativeFrame(nativeFrameDefault);
    setResetDialogOpen(false);
  }

  return (
    <SettingsCategoryLayout
      categories={categories}
      activeCategory={activeCategory}
      onCategoryChange={(category) => setActiveCategory(category as EditorSettingsCategory)}
      navigationLabel={t('settings:categories.navigationLabel')}
      showActiveDescription={false}
      sidebarFooter={
        <Button
          className="w-full justify-start"
          variant="ghost"
          disabled={settingsAtDefaults}
          onClick={() => setResetDialogOpen(true)}
        >
          <RotateCcw />
          {t('settings:reset.action')}
        </Button>
      }
      header={<PageHeader className="border-0 p-0" title={activeSettingsCategory.label} />}
    >
      {activeCategory === 'appearance' ? (
        <>
          <Card size="sm" data-workbench-anchor="settings.theme">
            <CardHeader className="gap-0">
              <CardTitle>{t('settings:theme.title')}</CardTitle>
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

          <Card size="sm" data-workbench-anchor="settings.codeEditor">
            <CardHeader className="gap-0">
              <CardTitle>{t('settings:codeEditor.title')}</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4">
              <div className="flex items-center justify-between gap-6">
                <div>
                  <Label>{t('settings:codeEditor.editorTheme')}</Label>
                  <p className="text-xs text-muted-foreground">
                    {t('settings:codeEditor.editorThemeDescription')}
                  </p>
                </div>
                <CodeEditorThemeDialog
                  currentTheme={codeEditorTheme}
                  onApply={setCodeEditorTheme}
                />
              </div>
            </CardContent>
          </Card>

          <Card size="sm" data-workbench-anchor="settings.language">
            <CardHeader className="gap-0">
              <CardTitle>{t('settings:language.title')}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center justify-between gap-6">
                <div>
                  <Label htmlFor="editor-language">{t('settings:language.label')}</Label>
                  {language === 'system' ? (
                    <p className="text-xs text-muted-foreground">
                      {t('settings:language.effective', {
                        language: languageLabel(effectiveLanguage),
                      })}
                    </p>
                  ) : null}
                </div>
                <Select
                  value={language}
                  onValueChange={(value) => setLanguage(value as EditorLanguage)}
                >
                  <SelectTrigger id="editor-language" className="min-w-56">
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
        </>
      ) : null}

      {activeCategory === 'window' ? (
        <Card size="sm" data-workbench-anchor="settings.window">
          <CardHeader className="gap-0">
            <CardTitle>{t('settings:window.title')}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="grid gap-3 rounded-md border p-3 md:grid-cols-2">
              <div className="space-y-1">
                <Label>{t('settings:window.previewDisplay.profile')}</Label>
                <Select
                  value={previewDisplay.mode}
                  onValueChange={(mode) =>
                    setPreviewDisplay(
                      mode === 'custom'
                        ? {
                            mode: 'custom',
                            aspectRatio: { width: 16, height: 9 },
                            orientation: 'landscape',
                          }
                        : { mode: 'project' },
                    )
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="project">
                      {t('settings:window.previewDisplay.followProject')}
                    </SelectItem>
                    <SelectItem value="custom">
                      {t('settings:window.previewDisplay.custom')}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {previewDisplay.mode === 'custom' ? (
                <>
                  <div className="space-y-1">
                    <Label>{t('settings:window.previewDisplay.orientation')}</Label>
                    <Select
                      value={previewDisplay.orientation}
                      onValueChange={(orientation) =>
                        setPreviewDisplay({
                          ...previewDisplay,
                          orientation: orientation as 'landscape' | 'portrait',
                        })
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="landscape">
                          {t('settings:window.previewDisplay.landscape')}
                        </SelectItem>
                        <SelectItem value="portrait">
                          {t('settings:window.previewDisplay.portrait')}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <Input
                      aria-label={t('settings:window.previewDisplay.ratioWidth')}
                      type="number"
                      min={1}
                      max={10000}
                      value={previewDisplay.aspectRatio.width}
                      onChange={(event) => {
                        const width = Number(event.currentTarget.value);
                        if (width > 0)
                          setPreviewDisplay({
                            ...previewDisplay,
                            aspectRatio: { ...previewDisplay.aspectRatio, width },
                          });
                      }}
                    />
                    <Input
                      aria-label={t('settings:window.previewDisplay.ratioHeight')}
                      type="number"
                      min={1}
                      max={10000}
                      value={previewDisplay.aspectRatio.height}
                      onChange={(event) => {
                        const height = Number(event.currentTarget.value);
                        if (height > 0)
                          setPreviewDisplay({
                            ...previewDisplay,
                            aspectRatio: { ...previewDisplay.aspectRatio, height },
                          });
                      }}
                    />
                  </div>
                </>
              ) : null}
              <div className="flex items-end justify-end">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setPreviewDisplay({ mode: 'project' })}
                >
                  {t('settings:window.previewDisplay.reset')}
                </Button>
              </div>
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
      ) : null}

      {activeCategory === 'workspace' ? (
        <Card size="sm" data-workbench-anchor="settings.workspace">
          <CardHeader className="gap-0">
            <CardTitle>{t('settings:workspace.title')}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="grid gap-4">
              <div className="flex items-center justify-between gap-6">
                <div>
                  <Label htmlFor="developer-mode">{t('settings:workspace.developerMode')}</Label>
                  <p className="text-xs text-muted-foreground">
                    {t('settings:workspace.developerModeDescription')}
                  </p>
                </div>
                <Switch
                  id="developer-mode"
                  checked={developerMode}
                  onCheckedChange={setDeveloperMode}
                />
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <Label htmlFor="restore-last-project">
                    {t('settings:workspace.restoreLastProject')}
                  </Label>
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
                  <Label htmlFor="default-project-directory">
                    {t('settings:workspace.defaultProjectDirectory')}
                  </Label>
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
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    onClick={() => {
                      setDefaultProjectDirectoryError(null);
                      setDefaultProjectDirectory(null);
                    }}
                    aria-label={t('settings:workspace.resetDefaultProjectDirectory')}
                  >
                    <RotateCcw />
                  </Button>
                </div>
                {defaultProjectDirectoryError ? (
                  <p className="text-[11px] text-destructive">{defaultProjectDirectoryError}</p>
                ) : null}
              </div>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {activeCategory === 'preview' ? (
        <Card size="sm" data-workbench-anchor="settings.preview">
          <CardHeader className="gap-0">
            <CardTitle>{t('settings:preview.title')}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="flex items-center justify-between gap-6">
              <div>
                <Label htmlFor="editor-preview-layout">{t('settings:preview.layoutMode')}</Label>
                <p className="text-xs text-muted-foreground">
                  {t('settings:preview.layoutModeDescription')}
                </p>
              </div>
              <Select
                value={editorPreviewLayout}
                onValueChange={(value) =>
                  setEditorPreviewLayout(value as EditorPreviewLayoutPreference)
                }
              >
                <SelectTrigger id="editor-preview-layout" className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="automatic">{t('settings:preview.layoutAutomatic')}</SelectItem>
                  <SelectItem value="vertical">{t('settings:preview.layoutVertical')}</SelectItem>
                  <SelectItem value="horizontal">
                    {t('settings:preview.layoutHorizontal')}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center justify-between gap-6">
              <div>
                <Label htmlFor="show-preview-fps-counter">
                  {t('settings:preview.showFpsCounter')}
                </Label>
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
            <div className="flex items-center justify-between gap-6">
              <div>
                <Label htmlFor="preview-rmlui-raster-snap">
                  {t('settings:preview.rmluiRasterSnap')}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {t('settings:preview.rmluiRasterSnapDescription')}
                </p>
              </div>
              <Select
                value={previewRmlUiRasterSnap}
                onValueChange={(value) => setPreviewRmlUiRasterSnap(value as RmlUiRasterSnapMode)}
              >
                <SelectTrigger id="preview-rmlui-raster-snap" className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">
                    {t('settings:preview.rmluiRasterSnapOptions.all')}
                  </SelectItem>
                  <SelectItem value="geometry">
                    {t('settings:preview.rmluiRasterSnapOptions.geometry')}
                  </SelectItem>
                  <SelectItem value="text">
                    {t('settings:preview.rmluiRasterSnapOptions.text')}
                  </SelectItem>
                  <SelectItem value="none">
                    {t('settings:preview.rmluiRasterSnapOptions.none')}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {activeCategory === 'export' ? (
        <Card size="sm" data-workbench-anchor="settings.export">
          <CardHeader className="gap-0">
            <CardTitle>Export</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-5">
            <div className="grid gap-2">
              <div>
                <Label htmlFor="default-export-directory">Default output directory</Label>
                <p className="text-xs text-muted-foreground">
                  Used as the starting location for projects that do not yet have a local output
                  choice.
                </p>
              </div>
              <div className="flex min-w-0 items-center gap-2">
                <Input
                  id="default-export-directory"
                  className="font-mono text-[11px]"
                  value={exportPreferences.defaultOutputDirectory}
                  onChange={(event) =>
                    setExportPreferences({ defaultOutputDirectory: event.currentTarget.value })
                  }
                />
                <Button type="button" variant="outline" onClick={chooseDefaultExportDirectory}>
                  <FolderOpen />
                  Browse…
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  aria-label="Reset default export directory"
                  onClick={() => setExportPreferences({ defaultOutputDirectory: '' })}
                >
                  <RotateCcw />
                </Button>
              </div>
            </div>
            <div className="grid gap-3 rounded-md border p-3 md:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="export-android-sdk">Android SDK</Label>
                <Input
                  id="export-android-sdk"
                  className="font-mono text-[11px]"
                  value={exportPreferences.androidSdk}
                  onChange={(event) =>
                    setExportPreferences({ androidSdk: event.currentTarget.value })
                  }
                  placeholder="ANDROID_HOME"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="export-android-ndk">Android NDK (optional)</Label>
                <Input
                  id="export-android-ndk"
                  className="font-mono text-[11px]"
                  value={exportPreferences.androidNdk}
                  onChange={(event) =>
                    setExportPreferences({ androidNdk: event.currentTarget.value })
                  }
                  placeholder="NDK root"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="export-java-home">Java home</Label>
                <Input
                  id="export-java-home"
                  className="font-mono text-[11px]"
                  value={exportPreferences.javaHome}
                  onChange={(event) =>
                    setExportPreferences({ javaHome: event.currentTarget.value })
                  }
                  placeholder="JAVA_HOME"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="export-cmake">CMake (optional)</Label>
                <Input
                  id="export-cmake"
                  className="font-mono text-[11px]"
                  value={exportPreferences.cmake}
                  onChange={(event) => setExportPreferences({ cmake: event.currentTarget.value })}
                  placeholder="cmake executable or directory"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="export-windows-sign-command">Windows signing command</Label>
                <Input
                  id="export-windows-sign-command"
                  className="font-mono text-[11px]"
                  value={exportPreferences.windowsSigningCommand}
                  onChange={(event) =>
                    setExportPreferences({ windowsSigningCommand: event.currentTarget.value })
                  }
                  placeholder="signtool"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="export-windows-sign-args">Windows signing arguments</Label>
                <Input
                  id="export-windows-sign-args"
                  className="font-mono text-[11px]"
                  value={exportPreferences.windowsSigningArgs}
                  onChange={(event) =>
                    setExportPreferences({ windowsSigningArgs: event.currentTarget.value })
                  }
                  placeholder='["sign", "{executable}"]'
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="export-windows-verify-command">Windows verification command</Label>
                <Input
                  id="export-windows-verify-command"
                  className="font-mono text-[11px]"
                  value={exportPreferences.windowsVerifyCommand}
                  onChange={(event) =>
                    setExportPreferences({ windowsVerifyCommand: event.currentTarget.value })
                  }
                  placeholder="signtool"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="export-windows-verify-args">Windows verification arguments</Label>
                <Input
                  id="export-windows-verify-args"
                  className="font-mono text-[11px]"
                  value={exportPreferences.windowsVerifyArgs}
                  onChange={(event) =>
                    setExportPreferences({ windowsVerifyArgs: event.currentTarget.value })
                  }
                  placeholder='["verify", "/pa", "{executable}"]'
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="export-macos-identity">macOS signing identity</Label>
                <Input
                  id="export-macos-identity"
                  value={exportPreferences.macosSigningIdentity}
                  onChange={(event) =>
                    setExportPreferences({ macosSigningIdentity: event.currentTarget.value })
                  }
                  placeholder="Developer ID Application: …"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="export-macos-entitlements">macOS entitlements file</Label>
                <Input
                  id="export-macos-entitlements"
                  className="font-mono text-[11px]"
                  value={exportPreferences.macosEntitlementsPath}
                  onChange={(event) =>
                    setExportPreferences({ macosEntitlementsPath: event.currentTarget.value })
                  }
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="export-macos-notarization-command">
                  macOS notarization command
                </Label>
                <Input
                  id="export-macos-notarization-command"
                  className="font-mono text-[11px]"
                  value={exportPreferences.macosNotarizationCommand}
                  onChange={(event) =>
                    setExportPreferences({ macosNotarizationCommand: event.currentTarget.value })
                  }
                  placeholder="xcrun"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="export-macos-notarization-args">macOS notarization arguments</Label>
                <Input
                  id="export-macos-notarization-args"
                  className="font-mono text-[11px]"
                  value={exportPreferences.macosNotarizationArgs}
                  onChange={(event) =>
                    setExportPreferences({ macosNotarizationArgs: event.currentTarget.value })
                  }
                  placeholder='["notarytool", "submit", "--wait"]'
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="export-android-keystore">Android keystore</Label>
                <Input
                  id="export-android-keystore"
                  className="font-mono text-[11px]"
                  value={exportPreferences.androidKeystorePath}
                  onChange={(event) =>
                    setExportPreferences({ androidKeystorePath: event.currentTarget.value })
                  }
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="export-android-key-alias">Android key alias</Label>
                <Input
                  id="export-android-key-alias"
                  value={exportPreferences.androidKeyAlias}
                  onChange={(event) =>
                    setExportPreferences({ androidKeyAlias: event.currentTarget.value })
                  }
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="export-android-store-password">
                  Android store password reference
                </Label>
                <Input
                  id="export-android-store-password"
                  className="font-mono text-[11px]"
                  value={exportPreferences.androidStorePasswordReference}
                  onChange={(event) =>
                    setExportPreferences({
                      androidStorePasswordReference: event.currentTarget.value,
                    })
                  }
                  placeholder="env:NOVELTEA_ANDROID_STORE_PASSWORD"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="export-android-key-password">Android key password reference</Label>
                <Input
                  id="export-android-key-password"
                  className="font-mono text-[11px]"
                  value={exportPreferences.androidKeyPasswordReference}
                  onChange={(event) =>
                    setExportPreferences({ androidKeyPasswordReference: event.currentTarget.value })
                  }
                  placeholder="env:NOVELTEA_ANDROID_KEY_PASSWORD"
                />
              </div>
            </div>
            <div className="flex items-center justify-between gap-6 rounded-md border p-3">
              <div>
                <Label>Project export profiles</Label>
                <p className="text-xs text-muted-foreground">
                  Create and edit reproducible target profiles for the currently open project.
                </p>
              </div>
              <Button type="button" variant="outline" onClick={openExportProfiles}>
                Manage Export Profiles
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {activeCategory === 'comfyui' ? (
        <Card size="sm" data-workbench-anchor="settings.comfyui">
          <CardHeader className="gap-0">
            <CardTitle>{t('settings:comfyui.title')}</CardTitle>
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
                    onChange={(event) =>
                      updateComfyUiConfig({ serverUrl: event.currentTarget.value })
                    }
                    placeholder="http://127.0.0.1:8000"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="comfyui-default-workflow">
                    {t('settings:comfyui.defaultWorkflow')}
                  </Label>
                  <select
                    id="comfyui-default-workflow"
                    className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm outline-none transition-colors focus-visible:ring-1 focus-visible:ring-ring"
                    value={defaultGenerateWorkflowId}
                    onChange={(event) =>
                      updateDefaultWorkflow('image.generate', event.currentTarget.value)
                    }
                  >
                    {generateWorkflowOptions.length > 0 ? (
                      generateWorkflowOptions.map((workflow) => (
                        <option key={workflow.id} value={workflow.id}>
                          {workflow.label}
                        </option>
                      ))
                    ) : (
                      <option value="">{t('settings:comfyui.noWorkflows')}</option>
                    )}
                  </select>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="comfyui-default-edit-workflow">
                    {t('settings:comfyui.defaultEditWorkflow')}
                  </Label>
                  <select
                    id="comfyui-default-edit-workflow"
                    className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm outline-none transition-colors focus-visible:ring-1 focus-visible:ring-ring"
                    value={defaultEditWorkflowId}
                    onChange={(event) =>
                      updateDefaultWorkflow('image.edit', event.currentTarget.value)
                    }
                  >
                    {editWorkflowOptions.length > 0 ? (
                      editWorkflowOptions.map((workflow) => (
                        <option key={workflow.id} value={workflow.id}>
                          {workflow.label}
                        </option>
                      ))
                    ) : (
                      <option value="">{t('settings:comfyui.noWorkflows')}</option>
                    )}
                  </select>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="rounded-md border px-2 py-1 text-muted-foreground">
                  {comfyUiStatus.state}
                </span>
                <span className="text-muted-foreground">
                  {comfyUiStatus.message ?? t('settings:comfyui.statusUnknown')}
                </span>
                <Button type="button" size="sm" variant="outline" onClick={openComfyUiWorkflows}>
                  {t('settings:comfyui.manageWorkflows')}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void testComfyUiConnection()}
                >
                  {t('settings:comfyui.testConnection')}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <Dialog open={resetDialogOpen} onOpenChange={setResetDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('settings:reset.dialog.title')}</DialogTitle>
            <DialogDescription>{t('settings:reset.dialog.description')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setResetDialogOpen(false)}>
              {t('common:actions.cancel')}
            </Button>
            <Button type="button" variant="destructive" onClick={resetAllSettings}>
              {t('settings:reset.dialog.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsCategoryLayout>
  );
}
