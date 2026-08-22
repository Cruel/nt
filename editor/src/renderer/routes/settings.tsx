import { createFileRoute } from '@tanstack/react-router';
import { useCallback, useEffect, useState } from 'react';
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
  CategorizedEditorLayout,
  type CategorizedEditorCategory,
} from '@/components/CategorizedEditorLayout';
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
  comfyUiSharedUserConfigFromRuntime,
  defaultComfyUiSharedUserConfig,
} from '../../shared/comfyui';
import { buildComfyUiWorkflowsTab } from '@/workbench/editor-registry';
import { navigateToWorkbenchTarget } from '@/workbench/workbench-navigation';
import { registerWorkbenchTargetHandler } from '@/workbench/workbench-navigation';
import { useTemplateRegistryStore } from '@/export/template-registry-store';
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
  Boxes,
  Play,
  RotateCcw,
  Sun,
  WandSparkles,
} from 'lucide-react';
import type {
  ComfyUiWorkflowActiveEntry,
  ComfyUiWorkflowClassification,
} from '../../shared/comfyui-workflows';
import type {
  ExportPlatform,
  InstalledTemplate,
  UserExportConfig,
  UserSigningProfile,
} from '../../shared/project-schema/platform-export-contracts';
import {
  defaultUserExportConfig,
  signingSecretReferenceSchema,
} from '../../shared/project-schema/platform-export-contracts';

export const Route = createFileRoute('/settings')({
  component: SettingsPage,
});

export type EditorSettingsCategory =
  | 'appearance'
  | 'window'
  | 'workspace'
  | 'preview'
  | 'export'
  | 'templates'
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
  if (targetId.startsWith('settings.templates')) return 'templates';
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

type WorkflowDefaultOption = Pick<ComfyUiWorkflowActiveEntry, 'id' | 'label' | 'classification'>;

type SigningDraft = {
  originalId?: string;
  id: string;
  label: string;
  target: 'windows' | 'macos' | 'android';
  command: string;
  args: string;
  verifyCommand: string;
  verifyArgs: string;
  identity: string;
  entitlementsPath: string;
  notarizationCommand: string;
  notarizationArgs: string;
  keystorePath: string;
  keyAlias: string;
  storePasswordReference: string;
  keyPasswordReference: string;
};

function emptySigningDraft(target: SigningDraft['target']): SigningDraft {
  const label = target === 'windows' ? 'Windows' : target === 'macos' ? 'macOS' : 'Android';
  return {
    id: target,
    label,
    target,
    command: '',
    args: '[]',
    verifyCommand: '',
    verifyArgs: '[]',
    identity: '',
    entitlementsPath: '',
    notarizationCommand: '',
    notarizationArgs: '[]',
    keystorePath: '',
    keyAlias: '',
    storePasswordReference: '',
    keyPasswordReference: '',
  };
}

function signingDraftFromProfile(profile: UserSigningProfile): SigningDraft {
  const draft = emptySigningDraft(profile.target);
  if (profile.target === 'windows')
    return {
      ...draft,
      originalId: profile.id,
      id: profile.id,
      label: profile.label,
      command: profile.command,
      args: JSON.stringify(profile.args),
      verifyCommand: profile.verifyCommand,
      verifyArgs: JSON.stringify(profile.verifyArgs),
    };
  if (profile.target === 'macos')
    return {
      ...draft,
      originalId: profile.id,
      id: profile.id,
      label: profile.label,
      identity: profile.identity,
      entitlementsPath: profile.entitlementsPath ?? '',
      notarizationCommand: profile.notarizationCommand ?? '',
      notarizationArgs: JSON.stringify(profile.notarizationArgs ?? []),
    };
  return {
    ...draft,
    originalId: profile.id,
    id: profile.id,
    label: profile.label,
    keystorePath: profile.keystorePath,
    keyAlias: profile.keyAlias,
    storePasswordReference: profile.storePasswordReference,
    keyPasswordReference: profile.keyPasswordReference,
  };
}

function workflowDefaultOptions(
  workflows: ComfyUiWorkflowActiveEntry[],
  classification: ComfyUiWorkflowClassification,
  selectedId: string,
): WorkflowDefaultOption[] {
  const options = workflows.filter(
    (workflow) => workflow.classification === classification && workflow.runnable,
  );
  if (selectedId && !options.some((workflow) => workflow.id === selectedId)) {
    return [{ id: selectedId, label: selectedId, classification }, ...options];
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
  const [userExportConfig, setUserExportConfig] = useState<UserExportConfig | null>(null);
  const [userExportConfigLoaded, setUserExportConfigLoaded] = useState(false);
  const installedTemplates = useTemplateRegistryStore((state) => state.templates);
  const ensureTemplatesLoaded = useTemplateRegistryStore((state) => state.ensureLoaded);
  const refreshTemplates = useTemplateRegistryStore((state) => state.refresh);
  const [signingDraft, setSigningDraft] = useState<SigningDraft | null>(null);
  const [signingDraftError, setSigningDraftError] = useState<string | null>(null);
  const [localActiveCategory, setLocalActiveCategory] =
    useState<EditorSettingsCategory>('appearance');
  const activeCategory = controlledActiveCategory ?? localActiveCategory;
  const setActiveCategory = useCallback(
    (category: EditorSettingsCategory) => {
      setLocalActiveCategory(category);
      onActiveCategoryChange?.(category);
    },
    [onActiveCategoryChange],
  );
  const [resetDialogOpen, setResetDialogOpen] = useState(false);
  const [clearCacheDialogOpen, setClearCacheDialogOpen] = useState(false);
  const [clearCacheBusy, setClearCacheBusy] = useState(false);
  const [clearCacheFeedback, setClearCacheFeedback] = useState<{
    kind: 'success' | 'error';
    message: string;
  } | null>(null);

  const clearEditorCache = useCallback(async () => {
    setClearCacheBusy(true);
    setClearCacheFeedback(null);
    try {
      const result = await window.noveltea.clearEditorCache();
      if (result.ok) {
        setClearCacheFeedback({
          kind: 'success',
          message: t('settings:workspace.cache.success'),
        });
        setClearCacheDialogOpen(false);
      } else {
        setClearCacheFeedback({
          kind: 'error',
          message: t('settings:workspace.cache.failure'),
        });
      }
    } catch {
      setClearCacheFeedback({
        kind: 'error',
        message: t('settings:workspace.cache.failure'),
      });
    } finally {
      setClearCacheBusy(false);
    }
  }, [t]);
  const categories: CategorizedEditorCategory<EditorSettingsCategory>[] = [
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
      id: 'templates',
      label: t('settings:categories.templates'),
      description: t('settings:categories.templatesDescription'),
      icon: Boxes,
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
  const exportConfigAtDefaults =
    userExportConfigLoaded &&
    userExportConfig !== null &&
    JSON.stringify(userExportConfig) === JSON.stringify(defaultUserExportConfig());
  const settingsAtDefaults =
    userExportConfigLoaded &&
    nativeFrameLoaded &&
    preferencesAtDefaults &&
    nativeFrame === nativeFrameDefault &&
    exportConfigAtDefaults;
  const effectiveProjectDirectory = defaultProjectDirectory ?? appDefaultProjectDirectory;
  const comfyUiDefaultClassifications = Array.from(
    new Set([
      ...comfyUiWorkflows.flatMap((workflow) =>
        workflow.classification ? [workflow.classification] : [],
      ),
      ...Object.keys(comfyUiConfig.defaultWorkflows),
    ]),
  ).sort((left, right) => left.localeCompare(right));

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
  }, [setActiveCategory, tabId]);

  useEffect(() => {
    let mounted = true;
    void window.noveltea.loadUserExportConfig().then((config) => {
      if (!mounted) return;
      setUserExportConfig(config);
      setUserExportConfigLoaded(true);
    });
    void ensureTemplatesLoaded().catch(() => []);
    return () => {
      mounted = false;
    };
  }, [ensureTemplatesLoaded]);

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
    if ('serverUrl' in patch || 'requestTimeoutMs' in patch || 'defaultWorkflows' in patch) {
      try {
        void window.noveltea
          .saveComfyUiUserConfig(comfyUiSharedUserConfigFromRuntime(nextConfig))
          .catch(() => undefined);
      } catch {
        // Keep an in-progress editor value local until it forms a valid shared configuration.
      }
    }
    if (!wasEnabled && nextConfig.enabled) {
      void useComfyUiStore
        .getState()
        .checkConnection(useComfyUiStore.getState().config, { showChecking: true });
    }
  }

  function updateDefaultWorkflow(
    classification: ComfyUiWorkflowClassification,
    workflowId: string,
  ) {
    updateComfyUiConfig({
      defaultWorkflows: {
        ...comfyUiConfig.defaultWorkflows,
        [classification]: workflowId,
      },
    });
  }

  function comfyUiClassificationLabel(classification: string) {
    if (classification === 'image.generate') return t('settings:comfyui.defaultWorkflow');
    if (classification === 'image.edit') return t('settings:comfyui.defaultEditWorkflow');
    return classification;
  }

  function openComfyUiWorkflows() {
    navigateToWorkbenchTarget({ tab: buildComfyUiWorkflowsTab() });
  }

  async function saveSharedExportConfig(next: UserExportConfig) {
    const saved = await window.noveltea.saveUserExportConfig(next);
    setUserExportConfig(saved);
  }

  function updateToolchain(field: keyof UserExportConfig['toolchains'], value: string) {
    if (!userExportConfig) return;
    const next: UserExportConfig = {
      ...userExportConfig,
      toolchains: {
        ...userExportConfig.toolchains,
        [field]: value || undefined,
      },
    };
    setUserExportConfig(next);
    void saveSharedExportConfig(next);
  }

  function parseArgumentList(value: string, label: string): string[] {
    const parsed = JSON.parse(value || '[]') as unknown;
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
      throw new Error(t('settings:exportSettings.argumentArrayError', { label }));
    }
    return parsed;
  }

  async function saveSigningDraft() {
    if (!userExportConfig || !signingDraft) return;
    const id = signingDraft.id.trim();
    const label = signingDraft.label.trim();
    if (!id || !label) {
      setSigningDraftError(t('settings:exportSettings.idNameRequired'));
      return;
    }
    if (
      userExportConfig.signingProfiles.some(
        (profile) => profile.id === id && profile.id !== signingDraft.originalId,
      )
    ) {
      setSigningDraftError(t('settings:exportSettings.duplicateId'));
      return;
    }
    try {
      let profile: UserSigningProfile;
      if (signingDraft.target === 'windows') {
        if (!signingDraft.command.trim() || !signingDraft.verifyCommand.trim())
          throw new Error(t('settings:exportSettings.windowsCommandsRequired'));
        profile = {
          id,
          label,
          target: 'windows',
          command: signingDraft.command.trim(),
          args: parseArgumentList(signingDraft.args, t('settings:exportSettings.signingArguments')),
          verifyCommand: signingDraft.verifyCommand.trim(),
          verifyArgs: parseArgumentList(
            signingDraft.verifyArgs,
            t('settings:exportSettings.verificationArguments'),
          ),
        };
      } else if (signingDraft.target === 'macos') {
        if (!signingDraft.identity.trim())
          throw new Error(t('settings:exportSettings.macIdentityRequired'));
        profile = {
          id,
          label,
          target: 'macos',
          identity: signingDraft.identity.trim(),
          ...(signingDraft.entitlementsPath.trim()
            ? { entitlementsPath: signingDraft.entitlementsPath.trim() }
            : {}),
          ...(signingDraft.notarizationCommand.trim()
            ? {
                notarizationCommand: signingDraft.notarizationCommand.trim(),
                notarizationArgs: parseArgumentList(
                  signingDraft.notarizationArgs,
                  t('settings:exportSettings.notarizationArguments'),
                ),
              }
            : {}),
        };
      } else {
        if (
          !signingDraft.keystorePath.trim() ||
          !signingDraft.keyAlias.trim() ||
          !signingDraft.storePasswordReference.trim() ||
          !signingDraft.keyPasswordReference.trim()
        )
          throw new Error(t('settings:exportSettings.androidRequired'));
        const storePasswordReference = signingSecretReferenceSchema.parse(
          signingDraft.storePasswordReference,
        );
        const keyPasswordReference = signingSecretReferenceSchema.parse(
          signingDraft.keyPasswordReference,
        );
        profile = {
          id,
          label,
          target: 'android',
          keystorePath: signingDraft.keystorePath.trim(),
          keyAlias: signingDraft.keyAlias.trim(),
          storePasswordReference,
          keyPasswordReference,
        };
      }
      const profiles = userExportConfig.signingProfiles.filter(
        (item) => item.id !== signingDraft.originalId,
      );
      await saveSharedExportConfig({
        ...userExportConfig,
        signingProfiles: [...profiles, profile],
      });
      setSigningDraft(null);
      setSigningDraftError(null);
    } catch (error) {
      setSigningDraftError(error instanceof Error ? error.message : String(error));
    }
  }

  async function deleteSigningProfile(id: string) {
    if (!userExportConfig) return;
    if (!window.confirm(t('settings:exportSettings.deleteSigningConfirm'))) return;
    await saveSharedExportConfig({
      ...userExportConfig,
      signingProfiles: userExportConfig.signingProfiles.filter((item) => item.id !== id),
    });
  }

  async function installTemplateFromSettings() {
    const archivePath = await window.noveltea.selectTemplateArchivePath();
    if (!archivePath) return;
    let installed = await window.noveltea.installPlayerTemplate({
      archivePath,
      origin: archivePath,
    });
    if (
      !installed.success &&
      installed.diagnostics.some((item) => item.message.includes('already installed')) &&
      window.confirm(t('settings:exportSettings.replaceTemplateConfirm'))
    ) {
      installed = await window.noveltea.installPlayerTemplate({
        archivePath,
        origin: archivePath,
        force: true,
      });
    }
    if (installed.success) await refreshTemplates();
  }

  async function deleteInstalledTemplate(template: InstalledTemplate) {
    if (
      !window.confirm(
        t('settings:exportSettings.deleteTemplateConfirm', {
          template: `${template.descriptor.templateId}@${template.descriptor.buildId}`,
        }),
      )
    )
      return;
    await window.noveltea.removePlayerTemplate(
      template.descriptor.templateId,
      template.descriptor.buildId,
    );
    await refreshTemplates();
  }

  async function chooseDefaultExportDirectory() {
    const directory = await window.noveltea.selectDirectory({
      title: t('settings:exportSettings.selectDefaultOutputTitle'),
      defaultPath: exportPreferences.defaultOutputDirectory || null,
    });
    if (directory) setExportPreferences({ defaultOutputDirectory: directory });
  }

  async function testComfyUiConnection() {
    const config = useComfyUiStore.getState().config;
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

  async function resetAllSettings() {
    if (!userExportConfigLoaded) return;
    const defaultExportConfig = defaultUserExportConfig();
    await saveSharedExportConfig(defaultExportConfig);
    await window.noveltea.saveComfyUiUserConfig(defaultComfyUiSharedUserConfig());
    resetPreferencesToDefaults();
    setDefaultProjectDirectoryError(null);
    useComfyUiStore.getState().hydrateFromPreferences();
    updateNativeFrame(nativeFrameDefault);
    setResetDialogOpen(false);
  }

  return (
    <CategorizedEditorLayout
      categories={categories}
      activeCategory={activeCategory}
      onCategoryChange={setActiveCategory}
      navigationLabel={t('settings:categories.navigationLabel')}
      showActiveDescription={false}
      sidebarFooter={
        <Button
          className="w-full justify-start"
          variant="ghost"
          disabled={!userExportConfigLoaded || settingsAtDefaults}
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
              <div
                className="grid gap-2 border-t pt-4"
                data-workbench-anchor="settings.workspace.cache"
              >
                <div className="flex items-start justify-between gap-6">
                  <div>
                    <Label>{t('settings:workspace.cache.title')}</Label>
                    <p className="text-xs text-muted-foreground">
                      {t('settings:workspace.cache.description')}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={clearCacheBusy}
                    onClick={() => {
                      setClearCacheFeedback(null);
                      setClearCacheDialogOpen(true);
                    }}
                  >
                    {clearCacheBusy
                      ? t('settings:workspace.cache.clearing')
                      : t('settings:workspace.cache.action')}
                  </Button>
                </div>
                {clearCacheFeedback ? (
                  <p
                    className={
                      clearCacheFeedback.kind === 'error'
                        ? 'text-xs text-destructive'
                        : 'text-xs text-muted-foreground'
                    }
                  >
                    {clearCacheFeedback.message}
                  </p>
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
            <CardTitle>{t('settings:exportSettings.title')}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-5">
            <div className="grid gap-2">
              <div>
                <Label htmlFor="default-export-directory">
                  {t('settings:exportSettings.defaultOutputDirectory')}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {t('settings:exportSettings.defaultOutputDescription')}
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
                  {t('settings:exportSettings.browse')}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  aria-label={t('settings:exportSettings.resetDefaultOutput')}
                  onClick={() => setExportPreferences({ defaultOutputDirectory: '' })}
                >
                  <RotateCcw />
                </Button>
              </div>
            </div>

            <div className="grid gap-3 rounded-md border p-3">
              <div>
                <Label>{t('settings:exportSettings.platformToolchains')}</Label>
                <p className="text-xs text-muted-foreground">
                  {t('settings:exportSettings.platformToolchainsDescription')}
                </p>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                {(
                  [
                    ['androidSdk', t('settings:exportSettings.androidSdk'), 'ANDROID_HOME'],
                    ['androidNdk', t('settings:exportSettings.androidNdk'), 'NDK root'],
                    ['javaHome', t('settings:exportSettings.javaHome'), 'JAVA_HOME'],
                    ['cmake', t('settings:exportSettings.cmake'), 'cmake executable or directory'],
                  ] as const
                ).map(([field, label, placeholder]) => (
                  <div key={field} className="space-y-1">
                    <Label htmlFor={`export-${field}`}>{label}</Label>
                    <Input
                      id={`export-${field}`}
                      className="font-mono text-[11px]"
                      value={userExportConfig?.toolchains[field] ?? ''}
                      onChange={(event) => updateToolchain(field, event.currentTarget.value)}
                      placeholder={placeholder}
                    />
                  </div>
                ))}
              </div>
            </div>

            <div
              className="grid gap-3 rounded-md border p-3"
              data-workbench-anchor="settings.export.signing"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <Label>{t('settings:exportSettings.signingConfigurations')}</Label>
                  <p className="text-xs text-muted-foreground">
                    {t('settings:exportSettings.signingDescription')}
                  </p>
                </div>
                <div className="flex gap-2">
                  {(['windows', 'macos', 'android'] as const).map((target) => (
                    <Button
                      key={target}
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        const draft = emptySigningDraft(target);
                        let index = 2;
                        const base = draft.id;
                        while (
                          userExportConfig?.signingProfiles.some((item) => item.id === draft.id)
                        )
                          draft.id = `${base}-${index++}`;
                        draft.label =
                          draft.id === base ? draft.label : `${draft.label} (${index - 1})`;
                        setSigningDraft(draft);
                        setSigningDraftError(null);
                      }}
                    >
                      {target === 'macos'
                        ? t('settings:exportSettings.addMacos')
                        : target === 'windows'
                          ? t('settings:exportSettings.addWindows')
                          : t('settings:exportSettings.addAndroid')}
                    </Button>
                  ))}
                </div>
              </div>

              {(userExportConfig?.signingProfiles ?? [])
                .slice()
                .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }))
                .map((profile) => (
                  <div
                    key={profile.id}
                    className="flex items-center justify-between gap-3 rounded border p-3"
                  >
                    <div className="min-w-0">
                      <div className="font-medium">{profile.label}</div>
                      <div className="font-mono text-xs text-muted-foreground">
                        {profile.id} · {profile.target}
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setSigningDraft(signingDraftFromProfile(profile));
                          setSigningDraftError(null);
                        }}
                      >
                        {t('settings:exportSettings.edit')}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => void deleteSigningProfile(profile.id)}
                      >
                        {t('settings:exportSettings.delete')}
                      </Button>
                    </div>
                  </div>
                ))}

              {signingDraft ? (
                <div className="grid gap-3 rounded border bg-muted/20 p-3">
                  <div className="grid gap-3 md:grid-cols-2">
                    <div className="space-y-1">
                      <Label>{t('settings:exportSettings.configurationId')}</Label>
                      <Input
                        value={signingDraft.id}
                        onChange={(event) =>
                          setSigningDraft({ ...signingDraft, id: event.currentTarget.value })
                        }
                      />
                    </div>
                    <div className="space-y-1">
                      <Label>{t('settings:exportSettings.name')}</Label>
                      <Input
                        value={signingDraft.label}
                        onChange={(event) =>
                          setSigningDraft({ ...signingDraft, label: event.currentTarget.value })
                        }
                      />
                    </div>
                  </div>

                  {signingDraft.target === 'windows' ? (
                    <div className="grid gap-3 md:grid-cols-2">
                      <div className="space-y-1">
                        <Label>{t('settings:exportSettings.signingCommand')}</Label>
                        <Input
                          value={signingDraft.command}
                          onChange={(event) =>
                            setSigningDraft({ ...signingDraft, command: event.currentTarget.value })
                          }
                          placeholder="signtool"
                        />
                      </div>
                      <div className="space-y-1">
                        <Label>{t('settings:exportSettings.signingArguments')}</Label>
                        <Input
                          value={signingDraft.args}
                          onChange={(event) =>
                            setSigningDraft({ ...signingDraft, args: event.currentTarget.value })
                          }
                          placeholder='["sign", "{executable}"]'
                        />
                      </div>
                      <div className="space-y-1">
                        <Label>{t('settings:exportSettings.verificationCommand')}</Label>
                        <Input
                          value={signingDraft.verifyCommand}
                          onChange={(event) =>
                            setSigningDraft({
                              ...signingDraft,
                              verifyCommand: event.currentTarget.value,
                            })
                          }
                          placeholder="signtool"
                        />
                      </div>
                      <div className="space-y-1">
                        <Label>{t('settings:exportSettings.verificationArguments')}</Label>
                        <Input
                          value={signingDraft.verifyArgs}
                          onChange={(event) =>
                            setSigningDraft({
                              ...signingDraft,
                              verifyArgs: event.currentTarget.value,
                            })
                          }
                          placeholder='["verify", "/pa", "{executable}"]'
                        />
                      </div>
                    </div>
                  ) : signingDraft.target === 'macos' ? (
                    <div className="grid gap-3 md:grid-cols-2">
                      <div className="space-y-1 md:col-span-2">
                        <Label>{t('settings:exportSettings.signingIdentity')}</Label>
                        <Input
                          value={signingDraft.identity}
                          onChange={(event) =>
                            setSigningDraft({
                              ...signingDraft,
                              identity: event.currentTarget.value,
                            })
                          }
                          placeholder="Developer ID Application: …"
                        />
                      </div>
                      <div className="space-y-1">
                        <Label>{t('settings:exportSettings.entitlementsFile')}</Label>
                        <Input
                          value={signingDraft.entitlementsPath}
                          onChange={(event) =>
                            setSigningDraft({
                              ...signingDraft,
                              entitlementsPath: event.currentTarget.value,
                            })
                          }
                        />
                      </div>
                      <div className="space-y-1">
                        <Label>{t('settings:exportSettings.notarizationCommand')}</Label>
                        <Input
                          value={signingDraft.notarizationCommand}
                          onChange={(event) =>
                            setSigningDraft({
                              ...signingDraft,
                              notarizationCommand: event.currentTarget.value,
                            })
                          }
                        />
                      </div>
                      <div className="space-y-1 md:col-span-2">
                        <Label>{t('settings:exportSettings.notarizationArguments')}</Label>
                        <Input
                          value={signingDraft.notarizationArgs}
                          onChange={(event) =>
                            setSigningDraft({
                              ...signingDraft,
                              notarizationArgs: event.currentTarget.value,
                            })
                          }
                        />
                      </div>
                    </div>
                  ) : (
                    <div className="grid gap-3 md:grid-cols-2">
                      <div className="space-y-1 md:col-span-2">
                        <Label>{t('settings:exportSettings.keystorePath')}</Label>
                        <Input
                          value={signingDraft.keystorePath}
                          onChange={(event) =>
                            setSigningDraft({
                              ...signingDraft,
                              keystorePath: event.currentTarget.value,
                            })
                          }
                        />
                      </div>
                      <div className="space-y-1">
                        <Label>{t('settings:exportSettings.keyAlias')}</Label>
                        <Input
                          value={signingDraft.keyAlias}
                          onChange={(event) =>
                            setSigningDraft({
                              ...signingDraft,
                              keyAlias: event.currentTarget.value,
                            })
                          }
                        />
                      </div>
                      <div className="space-y-1">
                        <Label>{t('settings:exportSettings.storePasswordReference')}</Label>
                        <Input
                          value={signingDraft.storePasswordReference}
                          onChange={(event) =>
                            setSigningDraft({
                              ...signingDraft,
                              storePasswordReference: event.currentTarget.value,
                            })
                          }
                          placeholder="env:NOVELTEA_ANDROID_STORE_PASSWORD"
                        />
                      </div>
                      <div className="space-y-1">
                        <Label>{t('settings:exportSettings.keyPasswordReference')}</Label>
                        <Input
                          value={signingDraft.keyPasswordReference}
                          onChange={(event) =>
                            setSigningDraft({
                              ...signingDraft,
                              keyPasswordReference: event.currentTarget.value,
                            })
                          }
                          placeholder="env:NOVELTEA_ANDROID_KEY_PASSWORD"
                        />
                      </div>
                    </div>
                  )}

                  {signingDraftError ? (
                    <p className="text-xs text-destructive">{signingDraftError}</p>
                  ) : null}
                  <div className="flex justify-end gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => {
                        setSigningDraft(null);
                        setSigningDraftError(null);
                      }}
                    >
                      {t('settings:exportSettings.cancel')}
                    </Button>
                    <Button type="button" onClick={() => void saveSigningDraft()}>
                      {t('settings:exportSettings.saveConfiguration')}
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
          </CardContent>
        </Card>
      ) : null}

      {activeCategory === 'templates' ? (
        <Card size="sm" data-workbench-anchor="settings.templates">
          <CardHeader className="gap-0">
            <CardTitle>{t('settings:exportSettings.templates.title')}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="flex items-center justify-between gap-4">
              <p className="text-sm text-muted-foreground">
                {t('settings:exportSettings.templates.description')}
              </p>
              <Button type="button" variant="outline" onClick={installTemplateFromSettings}>
                {t('settings:exportSettings.templates.install')}
              </Button>
            </div>
            {installedTemplates.length === 0 ? (
              <div className="rounded border border-dashed p-8 text-center text-sm text-muted-foreground">
                {t('settings:exportSettings.templates.none')}
              </div>
            ) : (
              <div className="grid gap-4">
                {(['windows', 'linux', 'macos', 'web', 'android'] as ExportPlatform[]).map(
                  (platform) => {
                    const items = installedTemplates
                      .filter((item) => item.descriptor.platform === platform)
                      .sort(
                        (a, b) =>
                          a.descriptor.templateId.localeCompare(b.descriptor.templateId) ||
                          a.descriptor.buildId.localeCompare(b.descriptor.buildId),
                      );
                    if (items.length === 0) return null;
                    return (
                      <div key={platform} className="grid gap-2">
                        <div className="text-sm font-medium">
                          {platform === 'macos'
                            ? 'macOS'
                            : platform === 'web'
                              ? 'Web'
                              : platform === 'android'
                                ? 'Android'
                                : platform === 'windows'
                                  ? 'Windows'
                                  : 'Linux'}
                        </div>
                        {items.map((template) => (
                          <div
                            key={`${template.descriptor.templateId}/${template.descriptor.buildId}`}
                            className="flex items-center justify-between gap-4 rounded border p-3"
                          >
                            <div className="min-w-0">
                              <div className="font-medium">
                                {template.descriptor.templateId}@{template.descriptor.buildId}
                              </div>
                              <div className="text-xs text-muted-foreground">
                                {template.descriptor.architecture} ·{' '}
                                {template.descriptor.buildFlavor}
                                {template.status === 'corrupted'
                                  ? ` · ${t('settings:exportSettings.templates.corrupted')}`
                                  : template.entry.trust === 'official'
                                    ? ` · ${t('settings:exportSettings.templates.official')}`
                                    : ` · ${t('settings:exportSettings.templates.local')}`}
                              </div>
                            </div>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={() => void deleteInstalledTemplate(template)}
                            >
                              {t('settings:exportSettings.templates.delete')}
                            </Button>
                          </div>
                        ))}
                      </div>
                    );
                  },
                )}
              </div>
            )}
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
              <div className="grid gap-4">
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
                {comfyUiDefaultClassifications.length > 0 ? (
                  <div className="grid gap-3 md:grid-cols-2">
                    {comfyUiDefaultClassifications.map((classification) => {
                      const selectedId = comfyUiConfig.defaultWorkflows[classification] ?? '';
                      const options = workflowDefaultOptions(
                        comfyUiWorkflows,
                        classification,
                        selectedId,
                      );
                      const selectedAvailable = comfyUiWorkflows.some(
                        (workflow) =>
                          workflow.classification === classification &&
                          workflow.runnable &&
                          workflow.id === selectedId,
                      );
                      const inputId = `comfyui-default-${classification.replace(/[^A-Za-z0-9_-]/g, '-')}`;
                      return (
                        <div key={classification} className="space-y-1">
                          <Label htmlFor={inputId}>
                            {comfyUiClassificationLabel(classification)}
                          </Label>
                          <select
                            id={inputId}
                            className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm outline-none transition-colors focus-visible:ring-1 focus-visible:ring-ring"
                            value={selectedId}
                            onChange={(event) =>
                              updateDefaultWorkflow(classification, event.currentTarget.value)
                            }
                          >
                            {!selectedId ? <option value="">Not configured</option> : null}
                            {options.length > 0 ? (
                              options.map((workflow) => (
                                <option key={workflow.id} value={workflow.id}>
                                  {workflow.label}
                                </option>
                              ))
                            ) : selectedId ? null : (
                              <option value="" disabled>
                                {t('settings:comfyui.noWorkflows')}
                              </option>
                            )}
                          </select>
                          {selectedId && !selectedAvailable ? (
                            <p className="text-xs text-destructive">
                              Configured workflow '{selectedId}' is currently unavailable.
                            </p>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                ) : null}
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
      <Dialog open={clearCacheDialogOpen} onOpenChange={setClearCacheDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('settings:workspace.cache.dialog.title')}</DialogTitle>
            <DialogDescription>
              {t('settings:workspace.cache.dialog.description')}
            </DialogDescription>
          </DialogHeader>
          {clearCacheFeedback?.kind === 'error' ? (
            <p className="text-sm text-destructive">{clearCacheFeedback.message}</p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={clearCacheBusy}
              onClick={() => setClearCacheDialogOpen(false)}
            >
              {t('common:actions.cancel')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={clearCacheBusy}
              onClick={() => void clearEditorCache()}
            >
              {clearCacheBusy
                ? t('settings:workspace.cache.clearing')
                : t('settings:workspace.cache.dialog.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </CategorizedEditorLayout>
  );
}
