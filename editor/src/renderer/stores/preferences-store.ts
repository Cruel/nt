import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { CodeEditorThemeId } from '@/components/source/source-editor-theme-types';
import type { EditorLanguage } from '@/i18n';

export type Theme = 'system' | 'light' | 'dark';

interface PreferencesState {
  theme: Theme;
  language: EditorLanguage;
  codeEditorTheme: CodeEditorThemeId;
  restoreLastProjectOnStart: boolean;
  showPreviewFpsCounter: boolean;
  lastProjectPath: string | null;
  setTheme: (theme: Theme) => void;
  setLanguage: (language: EditorLanguage) => void;
  setCodeEditorTheme: (theme: CodeEditorThemeId) => void;
  setRestoreLastProjectOnStart: (restore: boolean) => void;
  setShowPreviewFpsCounter: (show: boolean) => void;
  setLastProjectPath: (projectPath: string | null) => void;
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
      setTheme: (theme) => set({ theme }),
      setLanguage: (language) => set({ language }),
      setCodeEditorTheme: (codeEditorTheme) => set({ codeEditorTheme }),
      setRestoreLastProjectOnStart: (restore) => set({ restoreLastProjectOnStart: restore }),
      setShowPreviewFpsCounter: (show) => set({ showPreviewFpsCounter: show }),
      setLastProjectPath: (lastProjectPath) => set({ lastProjectPath }),
    }),
    {
      name: 'noveltea-preferences',
    },
  ),
);
