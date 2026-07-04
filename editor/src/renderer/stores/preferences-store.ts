import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { CodeEditorThemeId } from '@/components/source/source-editor-theme-types';

export type Theme = 'system' | 'light' | 'dark';

interface PreferencesState {
  theme: Theme;
  codeEditorTheme: CodeEditorThemeId;
  restoreLastProjectOnStart: boolean;
  lastProjectPath: string | null;
  setTheme: (theme: Theme) => void;
  setCodeEditorTheme: (theme: CodeEditorThemeId) => void;
  setRestoreLastProjectOnStart: (restore: boolean) => void;
  setLastProjectPath: (projectPath: string | null) => void;
}

export const usePreferencesStore = create<PreferencesState>()(
  persist(
    (set) => ({
      theme: 'system',
      codeEditorTheme: 'noveltea',
      restoreLastProjectOnStart: true,
      lastProjectPath: null,
      setTheme: (theme) => set({ theme }),
      setCodeEditorTheme: (codeEditorTheme) => set({ codeEditorTheme }),
      setRestoreLastProjectOnStart: (restore) => set({ restoreLastProjectOnStart: restore }),
      setLastProjectPath: (lastProjectPath) => set({ lastProjectPath }),
    }),
    {
      name: 'noveltea-preferences',
    },
  ),
);
