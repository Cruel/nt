import { create } from 'zustand';
import type { ToolDiagnostic } from '../../shared/editor-tooling';
import type { CandidateRepairSource } from '../../shared/project-candidate-repair';

export interface CandidateRepairEntry {
  id: string;
  root: string;
  recognition: 'strong' | 'weak';
  diagnostics: ToolDiagnostic[];
  source?: CandidateRepairSource;
  buffer?: string;
  diskText?: string;
  diskSource?: CandidateRepairSource;
  error?: string;
  loading?: boolean;
  saving?: boolean;
  admitted?: boolean;
}

interface CandidateRepairStore {
  entries: Record<string, CandidateRepairEntry>;
  release: (id: string) => void;
  revokeRoot: (root: string) => void;
  register: (
    id: string,
    root: string,
    recognition: 'strong' | 'weak',
    diagnostics: ToolDiagnostic[],
  ) => void;
  load: (id: string, refresh?: boolean) => Promise<void>;
  setBuffer: (id: string, text: string) => void;
  useDisk: (id: string) => void;
  save: (id: string) => Promise<boolean>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const useCandidateRepairStore = create<CandidateRepairStore>()((set, get) => ({
  entries: {},
  release: (id) =>
    set((state) => ({
      entries: Object.fromEntries(Object.entries(state.entries).filter(([key]) => key !== id)),
    })),
  revokeRoot: (root) =>
    set((state) => ({
      entries: Object.fromEntries(
        Object.entries(state.entries).map(([id, entry]) => [
          id,
          entry.root === root ? { ...entry, admitted: true } : entry,
        ]),
      ),
    })),
  register: (id, root, recognition, diagnostics) =>
    set((state) => ({
      entries: {
        ...state.entries,
        [id]: {
          ...state.entries[id],
          id,
          root,
          recognition,
          diagnostics,
          admitted: false,
        },
      },
    })),
  load: async (id, refresh = false) => {
    const prior = get().entries[id];
    if (!prior || prior.loading || (prior.source && !refresh)) return;
    set((state) => ({ entries: { ...state.entries, [id]: { ...prior, loading: true } } }));
    try {
      const source = await window.noveltea.readRepairCandidate(id);
      set((state) => {
        const entry = state.entries[id];
        if (!entry) return state;
        const dirty = entry.source && entry.buffer !== entry.source.text;
        return {
          entries: {
            ...state.entries,
            [id]: {
              ...entry,
              source: dirty ? entry.source : source,
              buffer: dirty ? entry.buffer : source.text,
              diskSource: dirty && entry.source?.revision !== source.revision ? source : undefined,
              diskText:
                dirty && entry.source?.revision !== source.revision ? source.text : undefined,
              error:
                dirty && entry.source?.revision !== source.revision
                  ? 'The disk source changed. Keep your current edits, then explicitly use disk and reapply them before saving.'
                  : undefined,
              loading: false,
            },
          },
        };
      });
    } catch (error) {
      set((state) => {
        const entry = state.entries[id];
        return entry
          ? {
              entries: {
                ...state.entries,
                [id]: { ...entry, loading: false, error: errorMessage(error) },
              },
            }
          : state;
      });
    }
  },
  setBuffer: (id, buffer) =>
    set((state) => {
      const entry = state.entries[id];
      return entry ? { entries: { ...state.entries, [id]: { ...entry, buffer } } } : state;
    }),
  useDisk: (id) =>
    set((state) => {
      const entry = state.entries[id];
      if (!entry?.diskSource) return state;
      return {
        entries: {
          ...state.entries,
          [id]: {
            ...entry,
            source: entry.diskSource,
            buffer: entry.diskSource.text,
            diskSource: undefined,
            diskText: undefined,
            error: undefined,
          },
        },
      };
    }),
  save: async (id) => {
    const entry = get().entries[id];
    if (
      !entry?.source ||
      entry.buffer === undefined ||
      entry.saving ||
      entry.diskSource ||
      entry.admitted
    )
      return false;
    if (entry.buffer === entry.source.text) return true;
    set((state) => ({
      entries: { ...state.entries, [id]: { ...entry, saving: true, error: undefined } },
    }));
    try {
      const source = await window.noveltea.saveRepairCandidate(
        id,
        entry.source.revision,
        entry.buffer,
      );
      set((state) => {
        const latest = state.entries[id];
        return latest
          ? {
              entries: {
                ...state.entries,
                [id]: {
                  ...latest,
                  source,
                  saving: false,
                  error: undefined,
                  diskText: undefined,
                  // The user may continue typing while the physical Save is in flight.
                  buffer: latest.buffer === entry.buffer ? source.text : latest.buffer,
                },
              },
            }
          : state;
      });
      return get().entries[id]?.buffer === get().entries[id]?.source?.text;
    } catch (error) {
      set((state) => {
        const latest = state.entries[id];
        return latest
          ? {
              entries: {
                ...state.entries,
                [id]: { ...latest, saving: false, error: errorMessage(error) },
              },
            }
          : state;
      });
      return false;
    }
  },
}));
