import { cloneJsonValue, type JsonValue } from '@/project/json-value';
import { useDraftDirtyStore, serializeDraftDirtyState } from './draft-dirty-store';
import { useLocalEditorSessionStore } from './local-editor-session-store';
import { createInitialWorkbenchState } from './workbench-model';
import { useWorkbenchStore } from './workbench-store';
import {
  emptyEditorProjectState,
  parseEditorProjectState,
  type EditorProjectState,
} from '../../shared/project-schema/editor-project-state';

export function buildEditorProjectStateSnapshot(): EditorProjectState {
  const workbench = useWorkbenchStore.getState().serializeProjectWorkbench();
  const draftsByKey = serializeDraftDirtyState(useDraftDirtyStore.getState());
  return {
    ...emptyEditorProjectState(),
    workbench: workbench ?? undefined,
    tabStatesById: {},
    draftsByKey,
  };
}

export function mergeEditorProjectState(project: JsonValue, editorState: EditorProjectState): JsonValue {
  const cloned = cloneJsonValue(project);
  if (typeof cloned !== 'object' || cloned === null || Array.isArray(cloned)) return cloned;
  return {
    ...cloned,
    editor: editorState,
  } as JsonValue;
}

export function editorProjectStateFromProject(project: unknown): EditorProjectState {
  if (typeof project !== 'object' || project === null || Array.isArray(project)) return emptyEditorProjectState();
  return parseEditorProjectState((project as Record<string, unknown>).editor);
}

export function saveLocalEditorSessionSnapshot(projectFilePath: string | null) {
  useLocalEditorSessionStore.getState().saveShellWorkbench(
    projectFilePath,
    useWorkbenchStore.getState().serializeShellWorkbench(),
  );
}

export function clearLocalEditorSessionSnapshot() {
  useLocalEditorSessionStore.getState().clearShellWorkbench();
}

export function restoreNoProjectEditorSession() {
  const localShellSession = useLocalEditorSessionStore.getState().shellSession;
  if (localShellSession?.projectFilePath !== null) return;
  useWorkbenchStore.getState().restoreShellWorkbench(
    localShellSession.shellWorkbench,
    {},
    createInitialWorkbenchState(),
  );
}

export function restoreEditorProjectState(project: JsonValue, projectFilePath: string | null) {
  const editorState = editorProjectStateFromProject(project);
  const projectWorkbench = useWorkbenchStore.getState().restoreProjectWorkbench(editorState.workbench, project);
  useDraftDirtyStore.getState().restoreSerializedDrafts(editorState.draftsByKey ?? {});
  const localShellSession = useLocalEditorSessionStore.getState().shellSession;
  if (localShellSession?.projectFilePath === projectFilePath) {
    useWorkbenchStore.getState().restoreShellWorkbench(localShellSession.shellWorkbench, project, projectWorkbench);
  }
}
