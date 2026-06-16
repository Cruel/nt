import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Theme = 'system' | 'light' | 'dark';
export type Density = 'comfortable' | 'compact';

interface PreferencesState {
  theme: Theme;
  density: Density;
  showInspectorByDefault: boolean;
  setTheme: (theme: Theme) => void;
  setDensity: (density: Density) => void;
  setShowInspectorByDefault: (show: boolean) => void;
}

export const usePreferencesStore = create<PreferencesState>()(
  persist(
    (set) => ({
      theme: 'system',
      density: 'compact',
      showInspectorByDefault: true,
      setTheme: (theme) => set({ theme }),
      setDensity: (density) => set({ density }),
      setShowInspectorByDefault: (show) => set({ showInspectorByDefault: show }),
    }),
    {
      name: 'noveltea-preferences',
    },
  ),
);
