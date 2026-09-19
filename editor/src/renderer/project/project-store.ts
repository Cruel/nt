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
  applyCommittedSourcePathRemap: (pathRemap: Readonly<Record<string, string>>) => boolean;
  applyCommittedMaterialShaderCopy: (
    materialId: string,
    stage: 'vertex' | 'fragment' | 'varying',
    path: string,
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

function normalizedLayoutScriptReference(value: string): string | null {
  const normalized = value.startsWith('project:/') ? value.slice('project:/'.length) : value;
  return normalized.startsWith('scripts/') ? normalized : null;
}

function remapLayoutRmlScriptReferences(
  text: string,
  pathRemap: Readonly<Record<string, string>>,
): string {
  return text.replace(
    /(<script\b[^>]*\bsrc\s*=\s*)(["'])([^"']+)\2/giu,
    (whole, prefix, quote, sourceValue) => {
      const normalized = normalizedLayoutScriptReference(String(sourceValue));
      if (!normalized) return whole;
      const mapped = pathRemap[normalized];
      if (!mapped) return whole;
      const rewritten = String(sourceValue).startsWith('project:/') ? `project:/${mapped}` : mapped;
      return `${prefix}${quote}${rewritten}${quote}`;
    },
  );
}

function applyMaterialShaderCopy(
  document: JsonValue | null,
  materialId: string,
  stage: 'vertex' | 'fragment' | 'varying',
  path: string,
): JsonValue | null {
  if (!document || typeof document !== 'object' || Array.isArray(document)) return document;
  const next = cloneJsonValue(document) as Record<string, JsonValue>;
  const materials = next.materials;
  if (!materials || typeof materials !== 'object' || Array.isArray(materials)) return document;
  const record = (materials as Record<string, JsonValue>)[materialId];
  if (!record || typeof record !== 'object' || Array.isArray(record)) return document;
  const recordValue = record as Record<string, JsonValue>;
  const data = recordValue.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return document;
  const dataValue = data as Record<string, JsonValue>;
  const shader =
    dataValue.shader && typeof dataValue.shader === 'object' && !Array.isArray(dataValue.shader)
      ? ({ ...(dataValue.shader as Record<string, JsonValue>) } as Record<string, JsonValue>)
      : {};
  shader[stage] = { kind: 'project', path };
  dataValue.shader = shader;
  return next as JsonValue;
}

function remapProjectSourcePaths(
  document: JsonValue | null,
  pathRemap: Readonly<Record<string, string>>,
): JsonValue | null {
  if (!document || typeof document !== 'object' || Array.isArray(document)) return document;
  const next = cloneJsonValue(document) as Record<string, JsonValue>;
  const materials = next.materials;
  if (materials && typeof materials === 'object' && !Array.isArray(materials)) {
    for (const record of Object.values(materials)) {
      if (!record || typeof record !== 'object' || Array.isArray(record)) continue;
      const data = (record as Record<string, JsonValue>).data;
      if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
      const shader = (data as Record<string, JsonValue>).shader;
      if (!shader || typeof shader !== 'object' || Array.isArray(shader)) continue;
      for (const source of Object.values(shader)) {
        if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
        const sourceRecord = source as Record<string, JsonValue>;
        if (sourceRecord.kind !== 'project' || typeof sourceRecord.path !== 'string') continue;
        const mapped = pathRemap[sourceRecord.path];
        if (mapped) sourceRecord.path = mapped;
      }
    }
  }
  const scripts = next.scripts;
  if (scripts && typeof scripts === 'object' && !Array.isArray(scripts)) {
    for (const record of Object.values(scripts)) {
      if (!record || typeof record !== 'object' || Array.isArray(record)) continue;
      const data = (record as Record<string, JsonValue>).data;
      if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
      const source = (data as Record<string, JsonValue>).source;
      if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
      const sourceRecord = source as Record<string, JsonValue>;
      if (sourceRecord.kind !== 'project-file' || typeof sourceRecord.path !== 'string') continue;
      const mapped = pathRemap[sourceRecord.path];
      if (mapped) sourceRecord.path = mapped;
    }
  }
  const layouts = next.layouts;
  if (layouts && typeof layouts === 'object' && !Array.isArray(layouts)) {
    for (const record of Object.values(layouts)) {
      if (!record || typeof record !== 'object' || Array.isArray(record)) continue;
      const data = (record as Record<string, JsonValue>).data;
      if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
      const dataRecord = data as Record<string, JsonValue>;
      const dependencies = dataRecord.dependencies;
      if (dependencies && typeof dependencies === 'object' && !Array.isArray(dependencies)) {
        const dependencyRecord = dependencies as Record<string, JsonValue>;
        if (Array.isArray(dependencyRecord.scripts)) {
          const remapped = dependencyRecord.scripts.map((sourcePath) =>
            typeof sourcePath === 'string' ? (pathRemap[sourcePath] ?? sourcePath) : sourcePath,
          );
          dependencyRecord.scripts = remapped.filter(
            (value, index, values) =>
              values.findIndex((candidate) => candidate === value) === index,
          );
        }
      }
      const rml = dataRecord.rml;
      if (rml && typeof rml === 'object' && !Array.isArray(rml)) {
        const rmlRecord = rml as Record<string, JsonValue>;
        if (rmlRecord.sourceMode === 'inline' && typeof rmlRecord.sourceText === 'string')
          rmlRecord.sourceText = remapLayoutRmlScriptReferences(rmlRecord.sourceText, pathRemap);
      }
    }
  }
  return next as JsonValue;
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
  applyCommittedSourcePathRemap: (pathRemap) => {
    const state = get();
    if (!state.document || !state.projectInstanceId || !state.admittedProject) return false;
    const working = remapProjectSourcePaths(state.document, pathRemap);
    const saved = remapProjectSourcePaths(state.savedDocument, pathRemap);
    const admittedWorking = admitProjectCandidate(working);
    const admittedSaved = saved ? admitProjectCandidate(saved) : null;
    if (!admittedWorking || (saved && !admittedSaved)) return false;
    const changed = !jsonValuesEqual(state.document, admittedWorking.document);
    const projectRevision = changed ? state.projectRevision + 1 : state.projectRevision;
    const scriptSourcePaths = Object.fromEntries(
      Object.entries(state.scriptSourcePaths).map(([scriptId, sourcePath]) => [
        scriptId,
        pathRemap[sourcePath] ?? sourcePath,
      ]),
    );
    set({
      document: admittedWorking.document,
      admittedProject: admittedWorking.project,
      savedDocument: admittedSaved?.document ?? saved,
      scriptSourcePaths,
      projectRevision,
      ...(changed
        ? {
            lastMutationPublication: createMutationPublication({
              previousProject: state.admittedProject,
              project: admittedWorking.project,
              projectInstanceId: state.projectInstanceId,
              projectRevision,
              kind: 'external',
              affectedPaths: ['/materials', '/scripts', '/layouts'],
            }),
          }
        : {}),
    });
    return true;
  },
  applyCommittedMaterialShaderCopy: (materialId, stage, path) => {
    const state = get();
    if (!state.document || !state.projectInstanceId || !state.admittedProject) return false;
    const working = applyMaterialShaderCopy(state.document, materialId, stage, path);
    const saved = applyMaterialShaderCopy(state.savedDocument, materialId, stage, path);
    const admittedWorking = admitProjectCandidate(working);
    const admittedSaved = saved ? admitProjectCandidate(saved) : null;
    if (!admittedWorking || (saved && !admittedSaved)) return false;
    const changed = !jsonValuesEqual(state.document, admittedWorking.document);
    const projectRevision = changed ? state.projectRevision + 1 : state.projectRevision;
    set({
      document: admittedWorking.document,
      admittedProject: admittedWorking.project,
      savedDocument: admittedSaved?.document ?? saved,
      projectRevision,
      ...(changed
        ? {
            lastMutationPublication: createMutationPublication({
              previousProject: state.admittedProject,
              project: admittedWorking.project,
              projectInstanceId: state.projectInstanceId,
              projectRevision,
              kind: 'external',
              affectedPaths: [`/materials/${materialId}/data/shader/${stage}`],
            }),
          }
        : {}),
    });
    return true;
  },
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
