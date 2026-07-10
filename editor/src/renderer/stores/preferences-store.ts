import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { CodeEditorThemeId } from '@/components/source/source-editor-theme-types';
import type { EditorLanguage } from '@/i18n';
import type { ComfyUiConfig } from '../../shared/comfyui';
import { defaultComfyUiConfig, normalizeComfyUiConfig } from '../../shared/comfyui';
import { DEFAULT_PREVIEW_DISPLAY_PREFERENCE, normalizePreviewDisplayPreference, type PreviewDisplayPreference } from '../../shared/preview-display';

export type Theme = 'system' | 'light' | 'dark';

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
      setTheme: (theme) => set({ theme }),
      setLanguage: (language) => set({ language }),
      setCodeEditorTheme: (codeEditorTheme) => set({ codeEditorTheme }),
      setRestoreLastProjectOnStart: (restore) => set({ restoreLastProjectOnStart: restore }),
      setShowPreviewFpsCounter: (show) => set({ showPreviewFpsCounter: show }),
      setPreviewFpsCap: (previewFpsCap) => set({ previewFpsCap: normalizePreviewFpsCap(previewFpsCap) }),
      setLastProjectPath: (lastProjectPath) => set({ lastProjectPath }),
      setDefaultProjectDirectory: (defaultProjectDirectory) => set({ defaultProjectDirectory }),
      setComfyUiConfig: (patch) => set((state) => ({
        comfyUiConfig: normalizeComfyUiConfig({
          ...state.comfyUiConfig,
          ...patch,
        }),
      })),
      setPreviewDisplay: (previewDisplay) => set({ previewDisplay: normalizePreviewDisplayPreference(previewDisplay) }),
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
        };
      },
    },
  ),
);
