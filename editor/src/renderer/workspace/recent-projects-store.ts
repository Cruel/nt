import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface RecentProjectEntry {
  projectPath: string;
  projectFilePath: string | null;
  label: string;
  openedAt: number;
}

interface RecentProjectsState {
  recentProjects: RecentProjectEntry[];
  addRecentProject: (entry: { projectPath: string; projectFilePath?: string | null }) => void;
  removeRecentProject: (projectPath: string) => void;
  clearRecentProjects: () => void;
}

function basename(path: string) {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

function projectLabel(projectPath: string, projectFilePath?: string | null) {
  if (projectFilePath) return basename(projectFilePath);
  return basename(projectPath);
}

export const useRecentProjectsStore = create<RecentProjectsState>()(
  persist(
    (set) => ({
      recentProjects: [],
      addRecentProject: ({ projectPath, projectFilePath = null }) =>
        set((state) => {
          const normalized = {
            projectPath,
            projectFilePath,
            label: projectLabel(projectPath, projectFilePath),
            openedAt: Date.now(),
          };
          return {
            recentProjects: [
              normalized,
              ...state.recentProjects.filter((entry) => entry.projectPath !== projectPath),
            ].slice(0, 8),
          };
        }),
      removeRecentProject: (projectPath) =>
        set((state) => ({
          recentProjects: state.recentProjects.filter((entry) => entry.projectPath !== projectPath),
        })),
      clearRecentProjects: () => set({ recentProjects: [] }),
    }),
    { name: 'noveltea-recent-projects' },
  ),
);
