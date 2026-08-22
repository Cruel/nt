import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { CodeEditorThemeId } from '@/components/source/source-editor-theme-types';
import type { EditorLanguage } from '@/i18n';
import type { ComfyUiConfig } from '../../shared/comfyui';
import { defaultComfyUiConfig, normalizeComfyUiConfig } from '../../shared/comfyui';
import {
  DEFAULT_PREVIEW_DISPLAY_PREFERENCE,
  normalizePreviewDisplayPreference,
  type PreviewDisplayPreference,
} from '../../shared/preview-display';
import {
  normalizeEditorPreviewLayoutPreference,
  type EditorPreviewLayoutPreference,
} from '@/components/editor-preview-layout';
import {
  normalizeRmlUiRasterSnapMode,
  type RmlUiRasterSnapMode,
} from '../../shared/preview-protocol';

export type Theme = 'system' | 'light' | 'dark';

export interface ExportPreferences {
  defaultOutputDirectory: string;
  selectedProfileIds: Record<string, string>;
  profileOutputDirectories: Record<string, string>;
  profileTemplateTokens: Record<string, string>;
  profileSigningProfileIds: Record<string, string>;
}

export const DEFAULT_EXPORT_PREFERENCES: ExportPreferences = {
  defaultOutputDirectory: '',
  selectedProfileIds: {},
  profileOutputDirectories: {},
  profileTemplateTokens: {},
  profileSigningProfileIds: {},
};

export function normalizeExportPreferences(
  value: Partial<ExportPreferences> | null | undefined,
): ExportPreferences {
  return {
    ...DEFAULT_EXPORT_PREFERENCES,
    ...value,
    selectedProfileIds: { ...value?.selectedProfileIds },
    profileOutputDirectories: { ...value?.profileOutputDirectories },
    profileTemplateTokens: { ...value?.profileTemplateTokens },
    profileSigningProfileIds: { ...value?.profileSigningProfileIds },
  };
}

export function normalizePreviewFpsCap(value: number) {
  return Number.isFinite(value) ? Math.min(1000, Math.max(0, Math.trunc(value))) : 0;
}

export interface EditorPreviewSplitSizes {
  vertical: number | null;
  horizontal: number | null;
}

export const DEFAULT_EDITOR_PREVIEW_SPLIT_SIZES: EditorPreviewSplitSizes = {
  vertical: null,
  horizontal: null,
};

export function normalizeEditorPreviewSplitSizes(
  value: Partial<EditorPreviewSplitSizes> | null | undefined,
): EditorPreviewSplitSizes {
  const normalize = (size: unknown) =>
    typeof size === 'number' && Number.isFinite(size) && size > 0 && size < 100 ? size : null;
  return {
    vertical: normalize(value?.vertical),
    horizontal: normalize(value?.horizontal),
  };
}

type EditorLocalComfyUiPreferences = Pick<ComfyUiConfig, 'enabled' | 'connectionCheckIntervalMs'>;

function editorLocalComfyUiPreferences(config: ComfyUiConfig): EditorLocalComfyUiPreferences {
  return {
    enabled: config.enabled,
    connectionCheckIntervalMs: config.connectionCheckIntervalMs,
  };
}

export interface ResettableEditorPreferences {
  theme: Theme;
  language: EditorLanguage;
  codeEditorTheme: CodeEditorThemeId;
  developerMode: boolean;
  restoreLastProjectOnStart: boolean;
  showPreviewFpsCounter: boolean;
  previewFpsCap: number;
  previewRmlUiRasterSnap: RmlUiRasterSnapMode;
  defaultProjectDirectory: string | null;
  comfyUiConfig: ComfyUiConfig;
  previewDisplay: PreviewDisplayPreference;
  editorPreviewLayout: EditorPreviewLayoutPreference;
  editorPreviewSplitSizes: EditorPreviewSplitSizes;
  exportPreferences: ExportPreferences;
}

interface PreferencesState extends ResettableEditorPreferences {
  lastProjectPath: string | null;
  setTheme: (theme: Theme) => void;
  setLanguage: (language: EditorLanguage) => void;
  setCodeEditorTheme: (theme: CodeEditorThemeId) => void;
  setDeveloperMode: (enabled: boolean) => void;
  setRestoreLastProjectOnStart: (restore: boolean) => void;
  setShowPreviewFpsCounter: (show: boolean) => void;
  setPreviewFpsCap: (cap: number) => void;
  setPreviewRmlUiRasterSnap: (mode: RmlUiRasterSnapMode) => void;
  setLastProjectPath: (projectPath: string | null) => void;
  setDefaultProjectDirectory: (projectDirectory: string | null) => void;
  setComfyUiConfig: (patch: Partial<ComfyUiConfig>) => void;
  setPreviewDisplay: (preference: PreviewDisplayPreference) => void;
  setEditorPreviewLayout: (preference: EditorPreviewLayoutPreference) => void;
  setEditorPreviewSplitSize: (
    orientation: keyof EditorPreviewSplitSizes,
    previewSize: number,
  ) => void;
  setExportPreferences: (patch: Partial<ExportPreferences>) => void;
  resetToDefaults: () => void;
}

export function createDefaultEditorPreferences(): ResettableEditorPreferences {
  return {
    theme: 'system',
    language: 'system',
    codeEditorTheme: 'noveltea',
    developerMode: false,
    restoreLastProjectOnStart: true,
    showPreviewFpsCounter: false,
    previewFpsCap: 0,
    previewRmlUiRasterSnap: 'all',
    defaultProjectDirectory: null,
    comfyUiConfig: defaultComfyUiConfig(),
    previewDisplay: { ...DEFAULT_PREVIEW_DISPLAY_PREFERENCE },
    editorPreviewLayout: 'automatic',
    editorPreviewSplitSizes: { ...DEFAULT_EDITOR_PREVIEW_SPLIT_SIZES },
    exportPreferences: normalizeExportPreferences(DEFAULT_EXPORT_PREFERENCES),
  };
}

export function selectEditorPreferencesAreDefaults(state: ResettableEditorPreferences): boolean {
  const defaults = createDefaultEditorPreferences();
  return (
    state.theme === defaults.theme &&
    state.language === defaults.language &&
    state.codeEditorTheme === defaults.codeEditorTheme &&
    state.developerMode === defaults.developerMode &&
    state.restoreLastProjectOnStart === defaults.restoreLastProjectOnStart &&
    state.showPreviewFpsCounter === defaults.showPreviewFpsCounter &&
    state.previewFpsCap === defaults.previewFpsCap &&
    state.previewRmlUiRasterSnap === defaults.previewRmlUiRasterSnap &&
    state.defaultProjectDirectory === defaults.defaultProjectDirectory &&
    state.editorPreviewLayout === defaults.editorPreviewLayout &&
    JSON.stringify(state.comfyUiConfig) === JSON.stringify(defaults.comfyUiConfig) &&
    JSON.stringify(state.previewDisplay) === JSON.stringify(defaults.previewDisplay) &&
    JSON.stringify(state.editorPreviewSplitSizes) ===
      JSON.stringify(defaults.editorPreviewSplitSizes) &&
    JSON.stringify(state.exportPreferences) === JSON.stringify(defaults.exportPreferences)
  );
}

export const usePreferencesStore = create<PreferencesState>()(
  persist(
    (set) => ({
      ...createDefaultEditorPreferences(),
      lastProjectPath: null,
      setTheme: (theme) => set({ theme }),
      setLanguage: (language) => set({ language }),
      setCodeEditorTheme: (codeEditorTheme) => set({ codeEditorTheme }),
      setDeveloperMode: (developerMode) => set({ developerMode }),
      setRestoreLastProjectOnStart: (restore) => set({ restoreLastProjectOnStart: restore }),
      setShowPreviewFpsCounter: (show) => set({ showPreviewFpsCounter: show }),
      setPreviewFpsCap: (previewFpsCap) =>
        set({ previewFpsCap: normalizePreviewFpsCap(previewFpsCap) }),
      setPreviewRmlUiRasterSnap: (previewRmlUiRasterSnap) =>
        set({ previewRmlUiRasterSnap: normalizeRmlUiRasterSnapMode(previewRmlUiRasterSnap) }),
      setLastProjectPath: (lastProjectPath) => set({ lastProjectPath }),
      setDefaultProjectDirectory: (defaultProjectDirectory) => set({ defaultProjectDirectory }),
      setComfyUiConfig: (patch) =>
        set((state) => ({
          comfyUiConfig: normalizeComfyUiConfig({
            ...state.comfyUiConfig,
            ...patch,
          }),
        })),
      setPreviewDisplay: (previewDisplay) =>
        set({ previewDisplay: normalizePreviewDisplayPreference(previewDisplay) }),
      setEditorPreviewLayout: (editorPreviewLayout) =>
        set({ editorPreviewLayout: normalizeEditorPreviewLayoutPreference(editorPreviewLayout) }),
      setEditorPreviewSplitSize: (orientation, previewSize) =>
        set((state) => ({
          editorPreviewSplitSizes: normalizeEditorPreviewSplitSizes({
            ...state.editorPreviewSplitSizes,
            [orientation]: previewSize,
          }),
        })),
      setExportPreferences: (patch) =>
        set((state) => ({
          exportPreferences: normalizeExportPreferences({
            ...state.exportPreferences,
            ...patch,
          }),
        })),
      resetToDefaults: () => set(createDefaultEditorPreferences()),
    }),
    {
      name: 'noveltea-preferences',
      partialize: (state) => ({
        ...state,
        comfyUiConfig: editorLocalComfyUiPreferences(state.comfyUiConfig) as ComfyUiConfig,
      }),
      merge: (persisted, current) => {
        const persistedState =
          persisted && typeof persisted === 'object'
            ? (persisted as Partial<PreferencesState>)
            : {};
        const persistedComfyUi =
          persistedState.comfyUiConfig && typeof persistedState.comfyUiConfig === 'object'
            ? persistedState.comfyUiConfig
            : null;
        const next = {
          ...current,
          ...persistedState,
          comfyUiConfig: normalizeComfyUiConfig({
            ...current.comfyUiConfig,
            ...(typeof persistedComfyUi?.enabled === 'boolean'
              ? { enabled: persistedComfyUi.enabled }
              : {}),
            ...(typeof persistedComfyUi?.connectionCheckIntervalMs === 'number'
              ? { connectionCheckIntervalMs: persistedComfyUi.connectionCheckIntervalMs }
              : {}),
          }),
        } as PreferencesState;
        return {
          ...next,
          previewFpsCap: normalizePreviewFpsCap(next.previewFpsCap),
          previewRmlUiRasterSnap: normalizeRmlUiRasterSnapMode(next.previewRmlUiRasterSnap),
          comfyUiConfig: normalizeComfyUiConfig(next.comfyUiConfig),
          previewDisplay: normalizePreviewDisplayPreference(next.previewDisplay),
          editorPreviewLayout: normalizeEditorPreviewLayoutPreference(next.editorPreviewLayout),
          editorPreviewSplitSizes: normalizeEditorPreviewSplitSizes(next.editorPreviewSplitSizes),
          exportPreferences: normalizeExportPreferences(next.exportPreferences),
        };
      },
    },
  ),
);
