import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface RecentProjectEntry {
  projectPath: string;
  /** Read only for one browser-session cleanup of retired persisted entries. */
  projectFilePath?: string | null;
  label: string;
  openedAt: number;
}

interface RecentProjectsState {
  recentProjects: RecentProjectEntry[];
  addRecentProject: (entry: { projectPath: string; projectName?: string | null }) => void;
  removeRecentProject: (projectKey: string) => void;
  clearRecentProjects: () => void;
}

function basename(path: string) {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

export function recentProjectKey(entry: Pick<RecentProjectEntry, 'projectPath'>) {
  return entry.projectPath;
}

function projectLabel(projectPath: string, projectName?: string | null) {
  const trimmedProjectName = projectName?.trim();
  if (trimmedProjectName) return trimmedProjectName;
  return basename(projectPath);
}

export const useRecentProjectsStore = create<RecentProjectsState>()(
  persist(
    (set) => ({
      recentProjects: [],
      addRecentProject: ({ projectPath, projectName = null }) =>
        set((state) => {
          const normalized = {
            projectPath,
            label: projectLabel(projectPath, projectName),
            openedAt: Date.now(),
          };
          const normalizedKey = recentProjectKey(normalized);
          return {
            recentProjects: [
              normalized,
              ...state.recentProjects.filter((entry) => recentProjectKey(entry) !== normalizedKey),
            ].slice(0, 8),
          };
        }),
      removeRecentProject: (projectKey) =>
        set((state) => ({
          recentProjects: state.recentProjects.filter(
            (entry) => recentProjectKey(entry) !== projectKey,
          ),
        })),
      clearRecentProjects: () => set({ recentProjects: [] }),
    }),
    { name: 'noveltea-recent-projects' },
  ),
);
