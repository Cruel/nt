import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { CodeEditorThemeId } from '@/components/source/source-editor-theme-types';
import type { EditorLanguage } from '@/i18n';
import type { ComfyUiConfig } from '../../shared/comfyui';
import { defaultComfyUiConfig, normalizeComfyUiServerUrl } from '../../shared/comfyui';

export type Theme = 'system' | 'light' | 'dark';

interface PreferencesState {
  theme: Theme;
  language: EditorLanguage;
  codeEditorTheme: CodeEditorThemeId;
  restoreLastProjectOnStart: boolean;
  showPreviewFpsCounter: boolean;
  lastProjectPath: string | null;
  defaultProjectDirectory: string | null;
  comfyUiConfig: ComfyUiConfig;
  setTheme: (theme: Theme) => void;
  setLanguage: (language: EditorLanguage) => void;
  setCodeEditorTheme: (theme: CodeEditorThemeId) => void;
  setRestoreLastProjectOnStart: (restore: boolean) => void;
  setShowPreviewFpsCounter: (show: boolean) => void;
  setLastProjectPath: (projectPath: string | null) => void;
  setDefaultProjectDirectory: (projectDirectory: string | null) => void;
  setComfyUiConfig: (patch: Partial<ComfyUiConfig>) => void;
}

export const usePreferencesStore = create<PreferencesState>()(
  persist(
    (set) => ({
      theme: 'system',
      language: 'system',
      codeEditorTheme: 'noveltea',
      restoreLastProjectOnStart: true,
      showPreviewFpsCounter: false,
      lastProjectPath: null,
      defaultProjectDirectory: null,
      comfyUiConfig: defaultComfyUiConfig(),
      setTheme: (theme) => set({ theme }),
      setLanguage: (language) => set({ language }),
      setCodeEditorTheme: (codeEditorTheme) => set({ codeEditorTheme }),
      setRestoreLastProjectOnStart: (restore) => set({ restoreLastProjectOnStart: restore }),
      setShowPreviewFpsCounter: (show) => set({ showPreviewFpsCounter: show }),
      setLastProjectPath: (lastProjectPath) => set({ lastProjectPath }),
      setDefaultProjectDirectory: (defaultProjectDirectory) => set({ defaultProjectDirectory }),
      setComfyUiConfig: (patch) => set((state) => ({
        comfyUiConfig: {
          ...state.comfyUiConfig,
          ...patch,
          serverUrl: patch.serverUrl === undefined ? state.comfyUiConfig.serverUrl : normalizeComfyUiServerUrl(patch.serverUrl),
        },
      })),
    }),
    {
      name: 'noveltea-preferences',
    },
  ),
);
