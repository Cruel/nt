import { create } from 'zustand';
import type { ProjectLoadPayload, ProjectSaveMetadata } from './project-types';
import { cloneJsonValue, jsonValuesEqual, toJsonValue, type JsonValue } from './json-value';
import type { EditorProjectState } from '../../shared/project-schema/editor-project-state';
import { stripEditorProjectState } from '../../shared/project-schema/editor-project-state';
import type { ProjectMutationPublication } from '../../shared/authoring-dependency-contracts';
import type { StructurallyAdmittedAuthoringProject } from '../../shared/project-schema/structurally-admitted-authoring-project';
import type { JsonPointer } from './json-pointer';
import {
  admitProjectCandidate,
  createMutationPublication,
  createProjectInstanceId,
  type ProjectMutationKind,
} from './project-publication';

interface ProjectStoreState {
  document: JsonValue | null;
  admittedProject: StructurallyAdmittedAuthoringProject | null;
  savedDocument: JsonValue | null;
  projectInstanceId: string | null;
  projectRevision: number;
  lastMutationPublication: ProjectMutationPublication<StructurallyAdmittedAuthoringProject> | null;
  projectPath: string | null;
  projectFilePath: string | null;
  projectReadSessionId: string | null;
  historyCursor: number;
  isSaving: boolean;
  lastSaveError: string | null;
  loadProjectDocument: (payload: ProjectLoadPayload) => boolean;
  loadUnsavedProjectDocument: (document: unknown) => boolean;
  clearProject: () => void;
  replaceDocumentFromCommand: (
    document: JsonValue,
    historyCursor: number,
    mutation?: { kind: ProjectMutationKind; affectedPaths: readonly JsonPointer[] },
  ) => boolean;
  setHistoryCursor: (historyCursor: number) => void;
  markSaved: (metadata?: ProjectSaveMetadata) => void;
  markEditorMetadataPersisted: (editorState: EditorProjectState) => void;
  setSaving: (saving: boolean) => void;
  setSaveError: (error: string | null) => void;
}

function normalizeDocument(document: unknown): JsonValue | null {
  return document === null || document === undefined ? null : toJsonValue(document);
}

export const useProjectStore = create<ProjectStoreState>()((set, get) => ({
  document: null,
  admittedProject: null,
  savedDocument: null,
  projectInstanceId: null,
  projectRevision: 0,
  lastMutationPublication: null,
  projectPath: null,
  projectFilePath: null,
  projectReadSessionId: null,
  historyCursor: -1,
  isSaving: false,
  lastSaveError: null,
  loadProjectDocument: ({
    document,
    savedDocument,
    projectPath,
    projectFilePath,
    projectReadSessionId = null,
  }) => {
    const admitted = admitProjectCandidate(document);
    if (!admitted) return false;
    const projectInstanceId = createProjectInstanceId();
    const projectRevision = 1;
    set({
      document: admitted.document,
      admittedProject: admitted.project,
      savedDocument: normalizeDocument(savedDocument === undefined ? document : savedDocument),
      projectInstanceId,
      projectRevision,
      lastMutationPublication: createMutationPublication({
        previousProject: null,
        project: admitted.project,
        projectInstanceId,
        projectRevision,
        kind: 'load',
        affectedPaths: ['/'],
      }),
      projectPath,
      projectFilePath,
      projectReadSessionId,
      historyCursor: -1,
      isSaving: false,
      lastSaveError: null,
    });
    return true;
  },
  loadUnsavedProjectDocument: (document) => {
    const admitted = admitProjectCandidate(document);
    if (!admitted) return false;
    const projectInstanceId = createProjectInstanceId();
    const projectRevision = 1;
    set({
      document: admitted.document,
      admittedProject: admitted.project,
      savedDocument: null,
      projectInstanceId,
      projectRevision,
      lastMutationPublication: createMutationPublication({
        previousProject: null,
        project: admitted.project,
        projectInstanceId,
        projectRevision,
        kind: 'load',
        affectedPaths: ['/'],
      }),
      projectPath: null,
      projectFilePath: null,
      projectReadSessionId: null,
      historyCursor: 0,
      isSaving: false,
      lastSaveError: null,
    });
    return true;
  },
  clearProject: () =>
    set({
      document: null,
      admittedProject: null,
      savedDocument: null,
      projectInstanceId: null,
      projectRevision: 0,
      lastMutationPublication: null,
      projectPath: null,
      projectFilePath: null,
      projectReadSessionId: null,
      historyCursor: -1,
      isSaving: false,
      lastSaveError: null,
    }),
  replaceDocumentFromCommand: (document, historyCursor, mutation) => {
    const state = get();
    const admitted = admitProjectCandidate(document);
    if (!admitted || !state.projectInstanceId || !state.admittedProject) return false;
    const contentEqual = jsonValuesEqual(
      stripEditorProjectState(state.document),
      stripEditorProjectState(admitted.document),
    );
    if (contentEqual) {
      set({ document: admitted.document, historyCursor });
      return true;
    }
    const projectRevision = state.projectRevision + 1;
    const kind = mutation?.kind ?? 'replace';
    const affectedPaths = mutation?.affectedPaths ?? ['/'];
    set({
      document: admitted.document,
      admittedProject: admitted.project,
      historyCursor,
      projectRevision,
      lastMutationPublication: createMutationPublication({
        previousProject: state.admittedProject,
        project: admitted.project,
        projectInstanceId: state.projectInstanceId,
        projectRevision,
        kind,
        affectedPaths,
      }),
    });
    return true;
  },
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
      document: state.document,
      savedDocument,
      projectPath: metadata?.projectPath ?? state.projectPath,
      projectFilePath: metadata?.projectFilePath ?? state.projectFilePath,
      isSaving: false,
      lastSaveError: null,
    });
  },
  markEditorMetadataPersisted: (editorState) => {
    const state = get();
    const serializedEditorState = JSON.parse(JSON.stringify(editorState)) as JsonValue;
    const replaceEditor = (document: JsonValue | null): JsonValue | null => {
      if (!document || typeof document !== 'object' || Array.isArray(document)) return document;
      return { ...cloneJsonValue(document), editor: serializedEditorState };
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
