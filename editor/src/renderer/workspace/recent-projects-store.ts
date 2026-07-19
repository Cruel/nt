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
  addRecentProject: (entry: {
    projectPath: string;
    projectFilePath?: string | null;
    projectName?: string | null;
  }) => void;
  removeRecentProject: (projectKey: string) => void;
  clearRecentProjects: () => void;
}

function basename(path: string) {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

export function recentProjectKey(
  entry: Pick<RecentProjectEntry, 'projectPath' | 'projectFilePath'>,
) {
  return entry.projectFilePath ?? entry.projectPath;
}

function projectLabel(
  projectPath: string,
  projectFilePath?: string | null,
  projectName?: string | null,
) {
  const trimmedProjectName = projectName?.trim();
  if (trimmedProjectName) return trimmedProjectName;
  if (projectFilePath) return basename(projectFilePath);
  return basename(projectPath);
}

export const useRecentProjectsStore = create<RecentProjectsState>()(
  persist(
    (set) => ({
      recentProjects: [],
      addRecentProject: ({ projectPath, projectFilePath = null, projectName = null }) =>
        set((state) => {
          const normalized = {
            projectPath,
            projectFilePath,
            label: projectLabel(projectPath, projectFilePath, projectName),
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
