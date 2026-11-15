import { create } from 'zustand';
import { useProjectStore } from './project-store';
import { useWorkbenchStore } from '@/workbench/workbench-store';
import {
  currentProjectOpenRequestGeneration,
  dispatchWorkspaceToolbarCommand,
} from '@/workspace/workspace-toolbar-events';
import type { ToolDiagnostic } from '../../shared/editor-tooling';
import type {
  CandidateRepairSource,
  CandidateRepairStatus,
} from '../../shared/project-candidate-repair';

export interface CandidateRepairEntry {
  id: string;
  root: string;
  recognition: 'strong' | 'weak';
  diagnostics: ToolDiagnostic[];
  diagnosticsNeedRefresh?: boolean;
  /** Locally parsed syntax errors for this exact unsaved buffer, not disk validation. */
  syntaxText?: string;
  syntaxDiagnostics?: ToolDiagnostic[];
  source?: CandidateRepairSource;
  buffer?: string;
  diskText?: string;
  diskSource?: CandidateRepairSource;
  error?: string;
  loading?: boolean;
  saving?: boolean;
  validatingAfterSave?: boolean;
  admitted?: boolean;
  /** A user explicitly requested an AI repair for this candidate. */
  aiRepairRequested?: boolean;
  status?: CandidateRepairStatus;
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
  load: (id: string, refresh?: boolean, validatedGeneration?: number) => Promise<void>;
  observe: (id: string) => Promise<CandidateRepairStatus | null>;
  applyStatus: (status: CandidateRepairStatus) => void;
  setBuffer: (id: string, text: string) => void;
  setSyntaxDiagnostics: (id: string, text: string, diagnostics: ToolDiagnostic[]) => void;
  useDisk: (id: string) => void;
  markAiRepairRequested: (id: string) => void;
  save: (id: string) => Promise<boolean>;
  saveAndOpen: (id: string, tabId: string) => Promise<boolean>;
}

type ReadyCandidateEntry = CandidateRepairEntry & {
  status: CandidateRepairStatus & { revision: string };
};

/** The UI may offer admission only for an unmodified, revision-checked source.
 * Main rechecks the exact native readiness token when Open is requested. */
export function candidateReadyToOpen(
  entry: CandidateRepairEntry | undefined,
): entry is ReadyCandidateEntry {
  return Boolean(
    entry &&
    !entry.admitted &&
    !entry.loading &&
    !entry.saving &&
    !entry.validatingAfterSave &&
    !entry.diskSource &&
    !entry.diagnosticsNeedRefresh &&
    !entry.error &&
    entry.source &&
    entry.buffer === entry.source.text &&
    entry.status?.ready &&
    entry.status.revision,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The Problems panel and YAML editor must display the same text revision.
 * Native checks are authoritative for the saved candidate, while local YAML
 * parsing gives provisional feedback for the unsaved buffer. */
export function candidateVisibleDiagnostics(entry: CandidateRepairEntry): ToolDiagnostic[] {
  const dirty = Boolean(entry.source && entry.buffer !== entry.source.text);
  const currentSyntax =
    entry.syntaxText === entry.buffer && entry.syntaxDiagnostics ? entry.syntaxDiagnostics : null;
  const native = entry.diagnosticsNeedRefresh
    ? []
    : entry.diagnostics.filter(
        (item) =>
          item.category !== 'Project source syntax' &&
          (!dirty || (item.sourcePath !== undefined && item.sourcePath !== 'project.yaml')),
      );
  // Keep independently diagnosed saved files visible while editing the
  // manifest; only manifest errors and generic native admission wrappers
  // become stale when its local buffer changes.
  if (currentSyntax) return [...currentSyntax, ...native];
  if (dirty || entry.diagnosticsNeedRefresh) return native;
  return entry.diagnostics;
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
          entry.root === root ? { ...entry, admitted: true, status: undefined } : entry,
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
          diagnosticsNeedRefresh: false,
          admitted: false,
          aiRepairRequested: false,
          status: undefined,
        },
      },
    })),
  observe: async (id) => {
    try {
      const status = await window.noveltea.observeRepairCandidate(id);
      if (status) get().applyStatus(status);
      return status;
    } catch (error) {
      set((state) => {
        const entry = state.entries[id];
        return entry && !entry.admitted
          ? { entries: { ...state.entries, [id]: { ...entry, error: errorMessage(error) } } }
          : state;
      });
      return null;
    }
  },
  applyStatus: (status) => {
    const entry = get().entries[status.id];
    if (!entry || entry.admitted || (entry.status && status.generation < entry.status.generation))
      return;
    set((state) => {
      const current = state.entries[status.id];
      return current && !current.admitted
        ? {
            entries: {
              ...state.entries,
              [status.id]: {
                ...current,
                status,
                diagnostics: status.diagnostics,
                // A completed native check supersedes the diagnostics made
                // stale by a preceding source Save or external change.
                diagnosticsNeedRefresh: false,
              },
            },
          }
        : state;
    });
    void get().load(status.id, true, status.generation);
  },
  load: async (id, refresh = false, validatedGeneration?: number) => {
    const prior = get().entries[id];
    if (!prior || prior.admitted || prior.loading || (prior.source && !refresh)) return;
    set((state) => ({ entries: { ...state.entries, [id]: { ...prior, loading: true } } }));
    try {
      const source = await window.noveltea.readRepairCandidate(id);
      set((state) => {
        const entry = state.entries[id];
        if (!entry || entry.admitted) return state;
        const dirty = entry.source && entry.buffer !== entry.source.text;
        const changed = Boolean(entry.source && entry.source.revision !== source.revision);
        // A source refresh initiated by this exact native validation can keep
        // its freshly checked diagnostics. Manual or older refreshes cannot.
        const validated =
          validatedGeneration !== undefined && entry.status?.generation === validatedGeneration;
        return {
          entries: {
            ...state.entries,
            [id]: {
              ...entry,
              source: dirty ? entry.source : source,
              buffer: dirty ? entry.buffer : source.text,
              diagnostics: changed && !validated ? [] : entry.diagnostics,
              diagnosticsNeedRefresh: changed && !validated ? true : entry.diagnosticsNeedRefresh,
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
        return entry && !entry.admitted
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
      if (!entry || entry.buffer === buffer) return state;
      return { entries: { ...state.entries, [id]: { ...entry, buffer } } };
    }),
  setSyntaxDiagnostics: (id, text, diagnostics) =>
    set((state) => {
      const entry = state.entries[id];
      // A scheduled parse may finish after another edit, disk refresh or close.
      if (!entry || entry.admitted || entry.buffer !== text) return state;
      return {
        entries: {
          ...state.entries,
          [id]: { ...entry, syntaxText: text, syntaxDiagnostics: diagnostics },
        },
      };
    }),
  markAiRepairRequested: (id) =>
    set((state) => {
      const entry = state.entries[id];
      return entry && !entry.admitted
        ? { entries: { ...state.entries, [id]: { ...entry, aiRepairRequested: true } } }
        : state;
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
            diagnostics: [],
            diagnosticsNeedRefresh: true,
            diskSource: undefined,
            diskText: undefined,
            error: undefined,
          },
        },
      };
    }),
  saveAndOpen: async (id, tabId) => {
    const entry = get().entries[id];
    if (
      !entry?.source ||
      entry.buffer === undefined ||
      entry.saving ||
      entry.validatingAfterSave ||
      entry.diskSource ||
      entry.admitted
    )
      return false;

    // A physical Save explicitly authorizes admission of this candidate, but
    // neither a background watcher check nor a later tab/project switch does.
    const text = entry.buffer;
    const hasUnsavedEdits = text !== entry.source.text;
    const generation = entry.status?.generation ?? -1;
    const openRequestGeneration = currentProjectOpenRequestGeneration();
    const sameOpenRequest = () => currentProjectOpenRequestGeneration() === openRequestGeneration;
    const projectBefore = useProjectStore.getState();
    const sameProject = () => {
      const current = useProjectStore.getState();
      return (
        current.projectInstanceId === projectBefore.projectInstanceId &&
        current.projectSessionId === projectBefore.projectSessionId &&
        current.projectPath === projectBefore.projectPath &&
        current.projectFilePath === projectBefore.projectFilePath
      );
    };
    const sameTab = () => {
      const state = useWorkbenchStore.getState();
      return (
        state.tabsById[tabId]?.resource?.sourceId === id &&
        state.groupsById[state.activeGroupId]?.activeTabId === tabId
      );
    };
    if (!sameTab()) return false;
    let abandoned = false;
    const cancelIfMoved = () => {
      if (!sameProject() || !sameTab() || !sameOpenRequest()) abandoned = true;
    };
    const unsubscribeProject = useProjectStore.subscribe(cancelIfMoved);
    const unsubscribeTabs = useWorkbenchStore.subscribe(cancelIfMoved);
    try {
      if (
        (hasUnsavedEdits && !(await get().save(id))) ||
        abandoned ||
        !sameProject() ||
        !sameTab() ||
        !sameOpenRequest()
      )
        return false;
      const saved = get().entries[id];
      if (
        !saved ||
        saved.source?.text !== text ||
        saved.buffer !== text ||
        saved.diskSource ||
        saved.error
      )
        return false;

      // Native readiness already reflects the saved source tree. For a clean
      // candidate, reuse its revision-bound token rather than repeating a
      // full native validation. Main independently verifies the fingerprint
      // before admission; local YAML syntax alone never grants readiness.
      const openReadyCandidate = (readyRevision: string) => {
        // Save already authorizes Open; don't present a second AI-ready modal
        // while the explicitly requested Project admission is in flight.
        set((state) => {
          const current = state.entries[id];
          return current
            ? {
                entries: {
                  ...state.entries,
                  [id]: { ...current, aiRepairRequested: false },
                },
              }
            : state;
        });
        dispatchWorkspaceToolbarCommand({
          command: 'open-project',
          projectPath: entry.root,
          repairCandidateId: id,
          readyRevision,
        });
      };
      const ready = !hasUnsavedEdits && !saved.diagnosticsNeedRefresh ? saved.status : undefined;
      if (ready?.ready && ready.revision && ready.id === id) {
        openReadyCandidate(ready.revision);
        return true;
      }

      set((state) => {
        const current = state.entries[id];
        return current
          ? { entries: { ...state.entries, [id]: { ...current, validatingAfterSave: true } } }
          : state;
      });
      let checked = await get().observe(id);
      const afterFirstCheck = get().entries[id];
      if (
        !checked &&
        !abandoned &&
        sameProject() &&
        sameTab() &&
        sameOpenRequest() &&
        afterFirstCheck?.source?.text === text &&
        afterFirstCheck.buffer === text &&
        !afterFirstCheck.error &&
        !afterFirstCheck.diskSource
      )
        checked = await get().observe(id);
      const current = get().entries[id];
      if (
        abandoned ||
        !sameProject() ||
        !sameTab() ||
        !sameOpenRequest() ||
        !checked?.ready ||
        !checked.revision ||
        checked.id !== id ||
        (hasUnsavedEdits ? checked.generation <= generation : checked.generation < generation) ||
        !current ||
        current.admitted ||
        current.saving ||
        current.diskSource ||
        current.error ||
        current.source?.text !== text ||
        current.buffer !== text ||
        current.diagnosticsNeedRefresh ||
        current.status?.generation !== checked.generation ||
        current.status.revision !== checked.revision
      )
        return true; // The physical Save succeeded even when admission is not ready.
      openReadyCandidate(checked.revision);
      return true;
    } finally {
      set((state) => {
        const current = state.entries[id];
        return current
          ? { entries: { ...state.entries, [id]: { ...current, validatingAfterSave: false } } }
          : state;
      });
      unsubscribeProject();
      unsubscribeTabs();
    }
  },
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
                  diagnostics: [],
                  diagnosticsNeedRefresh: true,
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
      // A watcher event is not guaranteed to arrive before stale-CAS refusal.
      // Refresh the disk comparison automatically; never discard the buffer.
      if (/manifest changed (?:on disk|during Save)/iu.test(errorMessage(error)))
        await get().load(id, true);
      return false;
    }
  },
}));
