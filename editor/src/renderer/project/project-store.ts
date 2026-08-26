import { create } from 'zustand';
import type { ProjectLoadPayload, ProjectSaveMetadata } from './project-types';
import { cloneJsonValue, jsonValuesEqual, toJsonValue, type JsonValue } from './json-value';
import type { EditorProjectState } from '../../shared/project-schema/editor-project-state';
import {
  parseEditorProjectState,
  stripLocalEditorProjectState,
} from '../../shared/project-schema/editor-project-state';
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
  projectSessionId: string | null;
  scriptSourcePaths: Readonly<Record<string, string>>;
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
  publishExternalReconciliation: (payload: {
    document: JsonValue;
    savedDocument: JsonValue;
    scriptSourcePaths: Readonly<Record<string, string>>;
    affectedPaths: readonly JsonPointer[];
  }) => boolean;
  refreshWorkspaceSources: (payload: {
    scriptSourcePaths: Readonly<Record<string, string>>;
  }) => void;
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
  projectSessionId: null,
  scriptSourcePaths: {},
  historyCursor: -1,
  isSaving: false,
  lastSaveError: null,
  loadProjectDocument: ({
    document,
    savedDocument,
    projectPath,
    projectFilePath,
    projectSessionId = null,
    scriptSourcePaths = {},
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
      projectSessionId,
      scriptSourcePaths,
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
      projectSessionId: null,
      scriptSourcePaths: {},
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
      projectSessionId: null,
      scriptSourcePaths: {},
      historyCursor: -1,
      isSaving: false,
      lastSaveError: null,
    }),
  replaceDocumentFromCommand: (document, historyCursor, mutation) => {
    const state = get();
    const admitted = admitProjectCandidate(document);
    if (!admitted || !state.projectInstanceId || !state.admittedProject) return false;
    const contentEqual = jsonValuesEqual(
      stripLocalEditorProjectState(state.document),
      stripLocalEditorProjectState(admitted.document),
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
  publishExternalReconciliation: (payload) => {
    const state = get();
    const admitted = admitProjectCandidate(payload.document);
    if (!admitted || !state.projectInstanceId || !state.admittedProject) return false;
    const projectRevision = state.projectRevision + 1;
    set({
      document: admitted.document,
      admittedProject: admitted.project,
      savedDocument: cloneJsonValue(payload.savedDocument),
      projectRevision,
      lastMutationPublication: createMutationPublication({
        previousProject: state.admittedProject,
        project: admitted.project,
        projectInstanceId: state.projectInstanceId,
        projectRevision,
        kind: 'external',
        affectedPaths: payload.affectedPaths.length > 0 ? payload.affectedPaths : ['/'],
      }),
      scriptSourcePaths: payload.scriptSourcePaths,
      lastSaveError: null,
    });
    return true;
  },
  refreshWorkspaceSources: ({ scriptSourcePaths }) => set({ scriptSourcePaths }),
  setHistoryCursor: (historyCursor) => set({ historyCursor }),
  markSaved: (metadata) => {
    const state = get();
    const savedDocument = metadata
      ? 'document' in metadata
        ? normalizeDocument(metadata.document)
        : state.savedDocument
      : state.document === null
        ? null
        : cloneJsonValue(state.document);
    set({
      document: state.document,
      savedDocument,
      projectPath: metadata?.projectPath ?? state.projectPath,
      projectFilePath: metadata?.projectFilePath ?? state.projectFilePath,
      scriptSourcePaths: metadata?.scriptSourcePaths ?? state.scriptSourcePaths,
      isSaving: false,
      lastSaveError: null,
    });
  },
  markEditorMetadataPersisted: (editorState) => {
    const state = get();
    const replaceLocalEditorState = (document: JsonValue | null): JsonValue | null => {
      if (!document || typeof document !== 'object' || Array.isArray(document)) return document;
      const currentEditor = parseEditorProjectState((document as Record<string, unknown>).editor);
      const serializedEditorState = JSON.parse(
        JSON.stringify({
          ...editorState,
          // These fields are tracked in editor.json and are content, not local metadata. Preserve
          // each document's own baseline so a local-state flush cannot silently mark them saved.
          chapters: currentEditor.chapters,
          tags: currentEditor.tags,
          recordMetadata: currentEditor.recordMetadata,
        }),
      ) as JsonValue;
      return { ...cloneJsonValue(document), editor: serializedEditorState };
    };
    set({
      document: replaceLocalEditorState(state.document),
      savedDocument: replaceLocalEditorState(state.savedDocument),
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
