import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Theme = 'system' | 'light' | 'dark';
export type Density = 'comfortable' | 'compact';

interface PreferencesState {
  theme: Theme;
  density: Density;
  showInspectorByDefault: boolean;
  restoreLastProjectOnStart: boolean;
  lastProjectPath: string | null;
  setTheme: (theme: Theme) => void;
  setDensity: (density: Density) => void;
  setShowInspectorByDefault: (show: boolean) => void;
  setRestoreLastProjectOnStart: (restore: boolean) => void;
  setLastProjectPath: (projectPath: string | null) => void;
}

export const usePreferencesStore = create<PreferencesState>()(
  persist(
    (set) => ({
      theme: 'system',
      density: 'compact',
      showInspectorByDefault: true,
      restoreLastProjectOnStart: true,
      lastProjectPath: null,
      setTheme: (theme) => set({ theme }),
      setDensity: (density) => set({ density }),
      setShowInspectorByDefault: (show) => set({ showInspectorByDefault: show }),
      setRestoreLastProjectOnStart: (restore) => set({ restoreLastProjectOnStart: restore }),
      setLastProjectPath: (lastProjectPath) => set({ lastProjectPath }),
    }),
    {
      name: 'noveltea-preferences',
    },
  ),
);
