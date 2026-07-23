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

interface PreferencesState {
  theme: Theme;
  language: EditorLanguage;
  codeEditorTheme: CodeEditorThemeId;
  restoreLastProjectOnStart: boolean;
  showPreviewFpsCounter: boolean;
  previewFpsCap: number;
  lastProjectPath: string | null;
  defaultProjectDirectory: string | null;
  comfyUiConfig: ComfyUiConfig;
  previewDisplay: PreviewDisplayPreference;
  exportPreferences: ExportPreferences;
  setTheme: (theme: Theme) => void;
  setLanguage: (language: EditorLanguage) => void;
  setCodeEditorTheme: (theme: CodeEditorThemeId) => void;
  setRestoreLastProjectOnStart: (restore: boolean) => void;
  setShowPreviewFpsCounter: (show: boolean) => void;
  setPreviewFpsCap: (cap: number) => void;
  setLastProjectPath: (projectPath: string | null) => void;
  setDefaultProjectDirectory: (projectDirectory: string | null) => void;
  setComfyUiConfig: (patch: Partial<ComfyUiConfig>) => void;
  setPreviewDisplay: (preference: PreviewDisplayPreference) => void;
  setExportPreferences: (patch: Partial<ExportPreferences>) => void;
}

export const usePreferencesStore = create<PreferencesState>()(
  persist(
    (set) => ({
      theme: 'system',
      language: 'system',
      codeEditorTheme: 'noveltea',
      restoreLastProjectOnStart: true,
      showPreviewFpsCounter: false,
      previewFpsCap: 0,
      lastProjectPath: null,
      defaultProjectDirectory: null,
      comfyUiConfig: defaultComfyUiConfig(),
      previewDisplay: DEFAULT_PREVIEW_DISPLAY_PREFERENCE,
      exportPreferences: DEFAULT_EXPORT_PREFERENCES,
      setTheme: (theme) => set({ theme }),
      setLanguage: (language) => set({ language }),
      setCodeEditorTheme: (codeEditorTheme) => set({ codeEditorTheme }),
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
          exportPreferences: normalizeExportPreferences(next.exportPreferences),
        };
      },
    },
  ),
);
