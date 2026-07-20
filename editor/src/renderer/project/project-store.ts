import { create } from 'zustand';
import type { ProjectLoadPayload, ProjectSaveMetadata } from './project-types';
import { cloneJsonValue, jsonValuesEqual, toJsonValue, type JsonValue } from './json-value';
import type { EditorProjectState } from '../../shared/project-schema/editor-project-state';

interface ProjectStoreState {
  document: JsonValue | null;
  savedDocument: JsonValue | null;
  projectPath: string | null;
  projectFilePath: string | null;
  historyCursor: number;
  savedHistoryCursor: number;
  isSaving: boolean;
  lastSaveError: string | null;
  loadProjectDocument: (payload: ProjectLoadPayload) => void;
  loadUnsavedProjectDocument: (document: JsonValue | unknown) => void;
  clearProject: () => void;
  replaceDocumentFromCommand: (document: JsonValue, historyCursor: number) => void;
  setHistoryCursor: (historyCursor: number) => void;
  markSaved: (metadata?: ProjectSaveMetadata) => void;
  markEditorMetadataPersisted: (editorState: EditorProjectState) => void;
  setSaving: (saving: boolean) => void;
  setSaveError: (error: string | null) => void;
}

function normalizeDocument(document: JsonValue | unknown | null): JsonValue | null {
  return document === null || document === undefined ? null : toJsonValue(document);
}

export const useProjectStore = create<ProjectStoreState>()((set, get) => ({
  document: null,
  savedDocument: null,
  projectPath: null,
  projectFilePath: null,
  historyCursor: -1,
  savedHistoryCursor: -1,
  isSaving: false,
  lastSaveError: null,
  loadProjectDocument: ({ document, savedDocument, projectPath, projectFilePath }) =>
    set({
      document: normalizeDocument(document),
      savedDocument: normalizeDocument(savedDocument === undefined ? document : savedDocument),
      projectPath,
      projectFilePath,
      historyCursor: -1,
      savedHistoryCursor: -1,
      isSaving: false,
      lastSaveError: null,
    }),
  loadUnsavedProjectDocument: (document) =>
    set({
      document: normalizeDocument(document),
      savedDocument: null,
      projectPath: null,
      projectFilePath: null,
      historyCursor: 0,
      savedHistoryCursor: -1,
      isSaving: false,
      lastSaveError: null,
    }),
  clearProject: () =>
    set({
      document: null,
      savedDocument: null,
      projectPath: null,
      projectFilePath: null,
      historyCursor: -1,
      savedHistoryCursor: -1,
      isSaving: false,
      lastSaveError: null,
    }),
  replaceDocumentFromCommand: (document, historyCursor) =>
    set({ document: cloneJsonValue(document), historyCursor }),
  setHistoryCursor: (historyCursor) => set({ historyCursor }),
  markSaved: (metadata) => {
    const state = get();
    const savedDocument =
      metadata && 'document' in metadata
        ? normalizeDocument(metadata.document)
        : state.document === null
          ? null
          : cloneJsonValue(state.document);
    set({
      document: state.document === null ? null : cloneJsonValue(state.document),
      savedDocument,
      savedHistoryCursor: state.historyCursor,
      projectPath: metadata?.projectPath ?? state.projectPath,
      projectFilePath: metadata?.projectFilePath ?? state.projectFilePath,
      isSaving: false,
      lastSaveError: null,
    });
  },
  markEditorMetadataPersisted: (editorState) => {
    const state = get();
    const replaceEditor = (document: JsonValue | null): JsonValue | null => {
      if (!document || typeof document !== 'object' || Array.isArray(document)) return document;
      return { ...cloneJsonValue(document), editor: toJsonValue(editorState) };
    };
    set({
      document: replaceEditor(state.document),
      savedDocument: replaceEditor(state.savedDocument),
    });
  },
  setSaving: (isSaving) => set({ isSaving }),
  setSaveError: (lastSaveError) => set({ lastSaveError, isSaving: false }),
}));

export function selectProjectDirty(state: Pick<ProjectStoreState, 'document' | 'savedDocument'>) {
  return (
    state.document !== null &&
    (state.savedDocument === null || !jsonValuesEqual(state.document, state.savedDocument))
  );
}

export function selectCanSave(
  state: Pick<ProjectStoreState, 'document' | 'projectFilePath' | 'isSaving'>,
) {
  return state.document !== null && !!state.projectFilePath && !state.isSaving;
}
