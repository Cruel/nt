import { create } from 'zustand';
import { useProjectStore } from './project-store';
import { useCommandStore } from '@/commands/command-store';
import { useWorkbenchStore } from '@/workbench/workbench-store';
import type {
  ProjectSourceFile,
  ProjectSourceStructuralOperation,
  ProjectSourceStructuralResponse,
  ProjectSourceUsage,
} from '../../shared/project-source-files';
import type { EditorSourceRecoveryEntry } from '../../shared/project-schema/editor-project-state';

export interface ProjectSourceConflict {
  externalExists: boolean;
  externalText: string;
  externalContentHash: `sha256:${string}` | 'absent';
}

export interface ProjectSourceBuffer {
  text: string;
  baseText: string;
  baseContentHash: `sha256:${string}` | 'absent';
  dirty: boolean;
  conflict: ProjectSourceConflict | null;
}

interface ProjectSourceStoreState {
  projectSessionId: string | null;
  files: readonly ProjectSourceFile[];
  folders: readonly string[];
  textById: Readonly<Record<string, string>>;
  buffersById: Readonly<Record<string, ProjectSourceBuffer>>;
  loading: boolean;
  error: string | null;
  clear: () => void;
  refresh: (projectSessionId: string) => Promise<boolean>;
  reconcileExternal: (projectSessionId: string) => Promise<void>;
  restoreRecovery: (entries: Readonly<Record<string, EditorSourceRecoveryEntry>>) => void;
  setText: (sourceId: string, text: string) => void;
  flushNativeStages: () => Promise<boolean>;
  save: (sourceId: string, acceptExternalBase?: boolean) => Promise<boolean>;
  useDisk: (sourceId: string) => void;
  discard: (sourceId: string) => void;
  mutate: (operation: ProjectSourceStructuralOperation) => Promise<ProjectSourceStructuralResponse>;
  usages: (path: string) => Promise<readonly ProjectSourceUsage[]>;
}

const READ_BATCH_SIZE = 8;
const sourceRefreshesBySession = new Map<string, Promise<boolean>>();
const sourceStageTimers = new Map<string, ReturnType<typeof setTimeout>>();
const touchedNativeSources = new Set<string>();
let sourceTouchIdentity: { session: string; instance: string } | null = null;
function cancelSourceStage(sourceId: string) {
  const timer = sourceStageTimers.get(sourceId);
  if (timer) clearTimeout(timer);
  sourceStageTimers.delete(sourceId);
}

async function loadSourceSnapshot(projectSessionId: string) {
  const listed = await window.noveltea.listProjectSourceFiles({ projectSessionId });
  const textById: Record<string, string> = {};
  const contentHashById: Record<string, `sha256:${string}`> = {};
  const textFiles = listed.files.filter((file) => file.text);
  for (let index = 0; index < textFiles.length; index += READ_BATCH_SIZE) {
    const batch = textFiles.slice(index, index + READ_BATCH_SIZE);
    const response = await window.noveltea.readProjectTextSources({
      projectSessionId,
      entries: batch.map((file) => ({
        readKey: file.id,
        projectRelativePath: file.projectRelativePath,
        expectedContentHash: null,
      })),
    });
    for (const entry of response.entries) {
      if (entry.status !== 'ready') continue;
      textById[entry.readKey] = entry.text;
      contentHashById[entry.readKey] = entry.contentHash;
    }
  }
  return { ...listed, textById, contentHashById };
}

function remapBuffers(
  buffers: Readonly<Record<string, ProjectSourceBuffer>>,
  remap: Readonly<Record<string, string>>,
): Record<string, ProjectSourceBuffer> {
  const next: Record<string, ProjectSourceBuffer> = {};
  for (const [sourceId, buffer] of Object.entries(buffers))
    next[remap[sourceId] ?? sourceId] = buffer;
  return next;
}

function remapFiles(
  files: readonly ProjectSourceFile[],
  remap: Readonly<Record<string, string>>,
): ProjectSourceFile[] {
  return files.map((file) => {
    const nextId = remap[file.id];
    if (!nextId) return file;
    return {
      ...file,
      id: nextId,
      displayPath: nextId,
      projectRelativePath: nextId,
    };
  });
}

function mergeSnapshot(
  state: ProjectSourceStoreState,
  loaded: Awaited<ReturnType<typeof loadSourceSnapshot>>,
  preserveDirty: boolean,
) {
  const incomingById = new Map(loaded.files.map((file) => [file.id, file]));
  const buffersById: Record<string, ProjectSourceBuffer> = {};
  const files = [...loaded.files];

  for (const file of loaded.files) {
    if (!file.text) continue;
    const incomingText = loaded.textById[file.id] ?? '';
    const incomingHash = loaded.contentHashById[file.id] ?? file.contentHash ?? 'absent';
    const prior = state.buffersById[file.id];
    if (preserveDirty && prior?.dirty) {
      const changedExternally = prior.baseContentHash !== incomingHash;
      buffersById[file.id] = {
        ...prior,
        conflict: changedExternally
          ? {
              externalExists: true,
              externalText: incomingText,
              externalContentHash: incomingHash,
            }
          : prior.conflict,
      };
    } else {
      buffersById[file.id] = {
        text: incomingText,
        baseText: incomingText,
        baseContentHash: incomingHash,
        dirty: false,
        conflict: null,
      };
    }
  }

  if (preserveDirty) {
    for (const [sourceId, prior] of Object.entries(state.buffersById)) {
      if (!prior.dirty || incomingById.has(sourceId)) continue;
      const priorFile = state.files.find((file) => file.id === sourceId);
      if (priorFile && !files.some((file) => file.id === sourceId)) files.push(priorFile);
      buffersById[sourceId] = {
        ...prior,
        conflict: {
          externalExists: false,
          externalText: '',
          externalContentHash: 'absent',
        },
      };
    }
  }

  const textById = Object.fromEntries(
    Object.entries(buffersById).map(([sourceId, buffer]) => [sourceId, buffer.text]),
  );
  return {
    files: files.sort((a, b) => a.displayPath.localeCompare(b.displayPath)),
    folders: loaded.folders ?? [],
    buffersById,
    textById,
  };
}

export const useProjectSourceStore = create<ProjectSourceStoreState>()((set, get) => ({
  projectSessionId: null,
  files: [],
  folders: [],
  textById: {},
  buffersById: {},
  loading: false,
  error: null,
  clear: () => {
    for (const sourceId of sourceStageTimers.keys()) cancelSourceStage(sourceId);
    touchedNativeSources.clear();
    sourceTouchIdentity = null;
    set({
      projectSessionId: null,
      files: [],
      folders: [],
      textById: {},
      buffersById: {},
      loading: false,
      error: null,
    });
  },
  refresh: (projectSessionId) => {
    const inFlight = sourceRefreshesBySession.get(projectSessionId);
    if (inFlight) return inFlight;

    const preserveDirty = get().projectSessionId === projectSessionId;
    set({ projectSessionId, loading: true, error: null });
    const refresh = (async () => {
      try {
        const loaded = await loadSourceSnapshot(projectSessionId);
        if (get().projectSessionId !== projectSessionId) return false;
        set((state) => ({
          ...mergeSnapshot(state, loaded, preserveDirty),
          loading: false,
          error: null,
        }));
        return true;
      } catch (error) {
        if (get().projectSessionId !== projectSessionId) return false;
        set({
          loading: false,
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
    })();
    sourceRefreshesBySession.set(projectSessionId, refresh);
    void refresh.finally(() => {
      if (sourceRefreshesBySession.get(projectSessionId) === refresh)
        sourceRefreshesBySession.delete(projectSessionId);
    });
    return refresh;
  },
  reconcileExternal: async (projectSessionId) => {
    if (get().projectSessionId !== projectSessionId) return;
    try {
      const loaded = await loadSourceSnapshot(projectSessionId);
      if (get().projectSessionId !== projectSessionId) return;
      set((state) => ({ ...mergeSnapshot(state, loaded, true), error: null }));
    } catch (error) {
      if (get().projectSessionId !== projectSessionId) return;
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },
  restoreRecovery: (entries) =>
    set((state) => {
      const files = [...state.files];
      const buffersById = { ...state.buffersById };
      const textById = { ...state.textById };
      for (const [sourceId, recovered] of Object.entries(entries)) {
        const current = buffersById[sourceId];
        if (!files.some((file) => file.id === sourceId)) {
          files.push({ ...recovered.file, text: true });
        }
        if (current && current.baseContentHash === recovered.baseContentHash) {
          buffersById[sourceId] = {
            text: recovered.text,
            baseText: current.text,
            baseContentHash: current.baseContentHash,
            dirty: recovered.text !== current.text,
            conflict: null,
          };
        } else {
          buffersById[sourceId] = {
            text: recovered.text,
            baseText: recovered.baseText,
            baseContentHash: recovered.baseContentHash as ProjectSourceBuffer['baseContentHash'],
            dirty: true,
            conflict: current
              ? {
                  externalExists: true,
                  externalText: current.text,
                  externalContentHash: current.baseContentHash,
                }
              : {
                  externalExists: false,
                  externalText: '',
                  externalContentHash: 'absent',
                },
          };
        }
        textById[sourceId] = recovered.text;
      }
      return {
        files: files.sort((a, b) => a.displayPath.localeCompare(b.displayPath)),
        buffersById,
        textById,
      };
    }),
  setText: (sourceId, text) => {
    if (!get().buffersById[sourceId]) return;
    set((state) => {
      const prior = state.buffersById[sourceId];
      if (!prior) return state;
      const buffer = { ...prior, text, dirty: text !== prior.baseText };
      return {
        buffersById: { ...state.buffersById, [sourceId]: buffer },
        textById: { ...state.textById, [sourceId]: text },
      };
    });
    if (useCommandStore.getState().nativeWorkingRevision === null) return;
    const session = get().projectSessionId;
    const project = useProjectStore.getState();
    const revision = project.projectRevision;
    const instance = project.projectInstanceId;
    if (!session || !instance) return;
    if (
      sourceTouchIdentity?.session !== session ||
      sourceTouchIdentity.instance !== instance
    ) {
      for (const stale of sourceStageTimers.keys()) cancelSourceStage(stale);
      touchedNativeSources.clear();
      sourceTouchIdentity = { session, instance };
    }
    touchedNativeSources.add(sourceId);
    cancelSourceStage(sourceId);
    // Coalesce high-frequency editor typing. The Save operation itself
    // re-stages the latest buffer under the same serialized native queue, so
    // a trailing timer can never be required to make a Save durable.
    const timer = setTimeout(() => {
      sourceStageTimers.delete(sourceId);
      const current = get();
      const latestProject = useProjectStore.getState();
      if (
        current.projectSessionId !== session ||
        latestProject.projectInstanceId !== instance ||
        latestProject.projectRevision !== revision
      ) return;
      const buffer = current.buffersById[sourceId];
      if (!buffer) return;
      void useCommandStore.getState().stageNativeTextAsync(
        sourceId, buffer.text, buffer.baseContentHash, revision,
      ).then((result) => {
        if (!result.ok && get().projectSessionId === session)
          set({ error: result.diagnostics[0]?.message ?? 'Native source staging failed.' });
      });
    }, 150);
    sourceStageTimers.set(sourceId, timer);
  },
  flushNativeStages: async () => {
    if (useCommandStore.getState().nativeWorkingRevision === null) return true;
    const state = get();
    const project = useProjectStore.getState();
    if (touchedNativeSources.size === 0) return true;
    if (
      sourceTouchIdentity?.session !== state.projectSessionId ||
      sourceTouchIdentity.instance !== project.projectInstanceId
    ) {
      for (const stale of sourceStageTimers.keys()) cancelSourceStage(stale);
      touchedNativeSources.clear();
      sourceTouchIdentity = null;
      return true;
    }
    if (!state.projectSessionId || !project.projectInstanceId) return false;
    const initialInstance = project.projectInstanceId;
    const initialSession = state.projectSessionId;
    for (const sourceId of touchedNativeSources) cancelSourceStage(sourceId);
    // Stages already in flight are serialized by the shared native Project
    // queue; append a final exact-text submission for each locally touched
    // source before allowing validation/preview/Test consumers to proceed.
    for (const sourceId of [...touchedNativeSources].sort()) {
      const current = get();
      const workingProject = useProjectStore.getState();
      if (
        current.projectSessionId !== initialSession ||
        workingProject.projectInstanceId !== initialInstance
      ) return false;
      const buffer = current.buffersById[sourceId];
      if (!buffer) continue;
      const result = await useCommandStore.getState().stageNativeTextAsync(
        sourceId,
        buffer.text,
        buffer.baseContentHash,
        workingProject.projectRevision,
      );
      if (!result.ok) {
        if (get().projectSessionId === initialSession)
          set({ error: result.diagnostics[0]?.message ?? 'Native source staging failed.' });
        return false;
      }
    }
    return true;
  },
  save: async (sourceId, acceptExternalBase = false) => {
    cancelSourceStage(sourceId);
    const state = get();
    const projectSessionId = state.projectSessionId;
    const buffer = state.buffersById[sourceId];
    if (!projectSessionId || !buffer) return false;
    const expectedRevision =
      acceptExternalBase && buffer.conflict
        ? buffer.conflict.externalContentHash
        : buffer.baseContentHash;
    const submittedText = buffer.text;
    const nativeMode = useCommandStore.getState().nativeWorkingRevision !== null;
    const nativeResult = nativeMode
      ? await useCommandStore.getState().saveNativeTextAsync(
          sourceId,
          submittedText,
          expectedRevision,
          useProjectStore.getState().projectRevision,
        )
      : null;
    const result = nativeResult
      ? {
          success: nativeResult.ok,
          contentHash: nativeResult.contentHash as `sha256:${string}` | undefined,
          error: nativeResult.error,
        }
      : await window.noveltea.writeProjectSource({
          projectSessionId,
          sourceId,
          expectedRevision,
          text: submittedText,
        });
    if (get().projectSessionId !== projectSessionId) return false;
    if (!result.success || !result.contentHash) {
      set({ error: result.error ?? 'Source save failed.' });
      return false;
    }
    set((current) => {
      const latest = current.buffersById[sourceId];
      if (!latest) return current;
      const next: ProjectSourceBuffer = {
        text: latest.text,
        baseText: submittedText,
        baseContentHash: result.contentHash!,
        dirty: latest.text !== submittedText,
        conflict: null,
      };
      return {
        buffersById: { ...current.buffersById, [sourceId]: next },
        textById: { ...current.textById, [sourceId]: next.text },
        files: current.files.map((file) =>
          file.id === sourceId ? { ...file, contentHash: result.contentHash } : file,
        ),
        error: null,
      };
    });
    return true;
  },
  useDisk: (sourceId) =>
    set((state) => {
      const buffer = state.buffersById[sourceId];
      const conflict = buffer?.conflict;
      if (!buffer || !conflict) return state;
      if (!conflict.externalExists) {
        const { [sourceId]: _buffer, ...buffersById } = state.buffersById;
        const { [sourceId]: _text, ...textById } = state.textById;
        return {
          files: state.files.filter((file) => file.id !== sourceId),
          buffersById,
          textById,
        };
      }
      const next: ProjectSourceBuffer = {
        text: conflict.externalText,
        baseText: conflict.externalText,
        baseContentHash: conflict.externalContentHash,
        dirty: false,
        conflict: null,
      };
      return {
        buffersById: { ...state.buffersById, [sourceId]: next },
        textById: { ...state.textById, [sourceId]: next.text },
      };
    }),
  discard: (sourceId) => {
    const state = get();
    const buffer = state.buffersById[sourceId];
    if (!buffer) return;
    if (buffer.conflict) {
      state.useDisk(sourceId);
      return;
    }
    set({
      buffersById: {
        ...state.buffersById,
        [sourceId]: { ...buffer, text: buffer.baseText, dirty: false },
      },
      textById: { ...state.textById, [sourceId]: buffer.baseText },
    });
  },
  mutate: async (operation) => {
    const state = get();
    const originalProjectInstanceId = useProjectStore.getState().projectInstanceId;
    if (!state.projectSessionId)
      return { ok: false, success: false, error: 'No active Project source session.' };
    if (
      operation.kind === 'move' &&
      (useCommandStore.getState().persistencePending ||
        useCommandStore.getState().history.activeTransaction)
    )
      return { ok: false, success: false, error: 'Finish the active edit before moving files.' };
    const expectedRevisions = Object.fromEntries(
      state.files.flatMap((file) => {
        const affectedPath =
          operation.kind === 'move'
            ? operation.fromPath
            : operation.kind === 'delete'
              ? operation.path
              : null;
        if (!affectedPath || !(file.id === affectedPath || file.id.startsWith(`${affectedPath}/`)))
          return [];
        const buffer = state.buffersById[file.id];
        const revision = buffer?.baseContentHash ?? file.contentHash;
        return revision ? [[file.id, revision] as const] : [];
      }),
    );
    const result = await window.noveltea.mutateProjectSources({
      projectSessionId: state.projectSessionId,
      operation,
      expectedRevisions,
    });
    if (!result.success) {
      set({ error: result.error ?? 'Source operation failed.' });
      return result;
    }
    if (
      get().projectSessionId !== state.projectSessionId ||
      useProjectStore.getState().projectInstanceId !== originalProjectInstanceId
    )
      return result;
    if (operation.kind === 'material-shader-copy' && result.createdSourceIds?.[0]) {
      useProjectStore
        .getState()
        .applyCommittedMaterialShaderCopy(
          operation.materialId,
          operation.stage,
          result.createdSourceIds[0],
        );
    }
    if (result.pathRemap) {
      const remapped = useProjectStore.getState().applyCommittedSourcePathRemap(result.pathRemap);
      if (remapped && Object.keys(result.pathRemap).length > 0)
        useCommandStore.getState().invalidateHistoryAfterCommittedFileMove();
      useWorkbenchStore.getState().remapSourceTabs(result.pathRemap);
      set((current) => ({
        files: remapFiles(current.files, result.pathRemap!),
        buffersById: remapBuffers(current.buffersById, result.pathRemap!),
        textById: Object.fromEntries(
          Object.entries(remapBuffers(current.buffersById, result.pathRemap!)).map(
            ([sourceId, buffer]) => [sourceId, buffer.text],
          ),
        ),
        error: null,
      }));
    }
    await get().refresh(state.projectSessionId);
    return result;
  },
  usages: async (pathValue) => {
    const projectSessionId = get().projectSessionId;
    if (!projectSessionId) return [];
    return (await window.noveltea.projectSourceUsages({ projectSessionId, path: pathValue }))
      .usages;
  },
}));

/** Native consumers must not observe an unflushed debounced text edit.
 * Drain the same per-Project native mutation queue before taking a revision
 * for Play, Validation or authored Tests. */
export async function flushNativeProjectSources(): Promise<void> {
  if (!(await useProjectSourceStore.getState().flushNativeStages()))
    throw new Error(
      useProjectSourceStore.getState().error ??
      'Native source staging did not accept every pending text edit.',
    );
}

export function findProjectSourceByAssetId(
  files: readonly ProjectSourceFile[],
  assetId: string,
): ProjectSourceFile | null {
  return files.find((file) => file.assetIds?.includes(assetId)) ?? null;
}
