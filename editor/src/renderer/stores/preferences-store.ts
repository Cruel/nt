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

export type Theme = 'system' | 'light' | 'dark';

export interface ExportPreferences {
  defaultOutputDirectory: string;
  androidSdk: string;
  androidNdk: string;
  javaHome: string;
  cmake: string;
  windowsSigningCommand: string;
  windowsSigningArgs: string;
  windowsVerifyCommand: string;
  windowsVerifyArgs: string;
  macosSigningIdentity: string;
  macosEntitlementsPath: string;
  macosNotarizationCommand: string;
  macosNotarizationArgs: string;
  androidKeystorePath: string;
  androidKeyAlias: string;
  androidStorePasswordReference: string;
  androidKeyPasswordReference: string;
  profileOutputDirectories: Record<string, string>;
  profileTemplateTokens: Record<string, string>;
}

export const DEFAULT_EXPORT_PREFERENCES: ExportPreferences = {
  defaultOutputDirectory: '',
  androidSdk: '',
  androidNdk: '',
  javaHome: '',
  cmake: '',
  windowsSigningCommand: '',
  windowsSigningArgs: '["sign", "{executable}"]',
  windowsVerifyCommand: '',
  windowsVerifyArgs: '["verify", "{executable}"]',
  macosSigningIdentity: '',
  macosEntitlementsPath: '',
  macosNotarizationCommand: '',
  macosNotarizationArgs: '[]',
  androidKeystorePath: '',
  androidKeyAlias: '',
  androidStorePasswordReference: '',
  androidKeyPasswordReference: '',
  profileOutputDirectories: {},
  profileTemplateTokens: {},
};

export function normalizeExportPreferences(
  value: Partial<ExportPreferences> | null | undefined,
): ExportPreferences {
  return {
    ...DEFAULT_EXPORT_PREFERENCES,
    ...value,
    profileOutputDirectories: { ...value?.profileOutputDirectories },
    profileTemplateTokens: { ...value?.profileTemplateTokens },
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

interface PreferencesState {
  theme: Theme;
  language: EditorLanguage;
  codeEditorTheme: CodeEditorThemeId;
  developerMode: boolean;
  restoreLastProjectOnStart: boolean;
  showPreviewFpsCounter: boolean;
  previewFpsCap: number;
  lastProjectPath: string | null;
  defaultProjectDirectory: string | null;
  comfyUiConfig: ComfyUiConfig;
  previewDisplay: PreviewDisplayPreference;
  editorPreviewLayout: EditorPreviewLayoutPreference;
  editorPreviewSplitSizes: EditorPreviewSplitSizes;
  exportPreferences: ExportPreferences;
  setTheme: (theme: Theme) => void;
  setLanguage: (language: EditorLanguage) => void;
  setCodeEditorTheme: (theme: CodeEditorThemeId) => void;
  setDeveloperMode: (enabled: boolean) => void;
  setRestoreLastProjectOnStart: (restore: boolean) => void;
  setShowPreviewFpsCounter: (show: boolean) => void;
  setPreviewFpsCap: (cap: number) => void;
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
}

export const usePreferencesStore = create<PreferencesState>()(
  persist(
    (set) => ({
      theme: 'system',
      language: 'system',
      codeEditorTheme: 'noveltea',
      developerMode: false,
      restoreLastProjectOnStart: true,
      showPreviewFpsCounter: false,
      previewFpsCap: 0,
      lastProjectPath: null,
      defaultProjectDirectory: null,
      comfyUiConfig: defaultComfyUiConfig(),
      previewDisplay: DEFAULT_PREVIEW_DISPLAY_PREFERENCE,
      editorPreviewLayout: 'automatic',
      editorPreviewSplitSizes: DEFAULT_EDITOR_PREVIEW_SPLIT_SIZES,
      exportPreferences: DEFAULT_EXPORT_PREFERENCES,
      setTheme: (theme) => set({ theme }),
      setLanguage: (language) => set({ language }),
      setCodeEditorTheme: (codeEditorTheme) => set({ codeEditorTheme }),
      setDeveloperMode: (developerMode) => set({ developerMode }),
      setRestoreLastProjectOnStart: (restore) => set({ restoreLastProjectOnStart: restore }),
      setShowPreviewFpsCounter: (show) => set({ showPreviewFpsCounter: show }),
      setPreviewFpsCap: (previewFpsCap) =>
        set({ previewFpsCap: normalizePreviewFpsCap(previewFpsCap) }),
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
    }),
    {
      name: 'noveltea-preferences',
      merge: (persisted, current) => {
        const next = {
          ...current,
          ...(persisted && typeof persisted === 'object' ? persisted : {}),
        } as PreferencesState;
        return {
          ...next,
          previewFpsCap: normalizePreviewFpsCap(next.previewFpsCap),
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
