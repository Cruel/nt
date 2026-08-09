import {
  analyzeAuthoringSources,
  collectAuthoringLuaSources,
  type AuthoringLuaSourceDescriptor,
} from '../authoring-source-analysis';
import { buildAuthoringDependencyGraph } from '../authoring-dependency-graph';
import type { AuthoringDependencyGraph } from '../authoring-dependency-contracts';
import {
  publishCompiledArtifact,
  type CompiledArtifactPublicationResult,
} from '../compiled-artifact-publication';
import {
  buildProjectSearchIndex,
  type ProjectSearchIndex,
} from '../project-search/project-search-index';
import type { AuthoringProject } from '../project-schema/authoring-project';
import type { LuaAnalysisInput } from '../project-schema/authoring-lua-analysis';
import type { LuaSourceSnapshot } from '../project-schema/authoring-lua-analysis';
import { validateAuthoringProject } from '../project-schema/authoring-validation';
import {
  decodeAuthoringProject,
  type AuthoringEnumRepair,
} from '../project-schema/decode-authoring-project';
import {
  canonicalProjectContentJson,
  parseEditorProjectStateWithDiagnostics,
  stripEditorProjectState,
  type EditorProjectState,
} from '../project-schema/editor-project-state';
import {
  collectProjectValidationDiagnostics,
  createProjectValidationDiagnostic,
  type ProjectValidationDiagnostic,
} from '../project-schema/project-validation';
import { sha256HexUtf8, sha256PrefixedUtf8 } from '../sha256';
import type { ProjectWorkspaceFileSystem } from './project-workspace-file-system';

export interface ProjectWorkspaceFileRevision {
  readonly contentHash: `sha256:${string}`;
  readonly byteSize: number;
}

export interface ProjectWorkspaceSaveUnitFileOwnership {
  readonly file: string | null;
  readonly paths: readonly string[];
}

export interface ProjectWorkspaceSnapshot {
  readonly snapshotKind: 'loaded' | 'working-copy';
  readonly projectRoot: string | null;
  readonly manifestPath: string | null;
  readonly project: AuthoringProject;
  readonly workspaceRevision: `sha256:${string}`;
  readonly sourceRevision: `sha256:${string}`;
  readonly canonicalSourceFiles: readonly string[];
  readonly fileRevisions: Readonly<Record<string, ProjectWorkspaceFileRevision>>;
  readonly saveUnitFileOwnership: Readonly<Record<string, ProjectWorkspaceSaveUnitFileOwnership>>;
  readonly externalSourceDescriptors: readonly AuthoringLuaSourceDescriptor[];
}

export interface LoadedProjectWorkspaceSnapshot extends ProjectWorkspaceSnapshot {
  readonly snapshotKind: 'loaded';
  readonly projectRoot: string;
  readonly manifestPath: string;
}

export type ProjectWorkspaceOpenResult =
  | {
      readonly ok: true;
      readonly snapshot: LoadedProjectWorkspaceSnapshot;
      readonly diagnostics: readonly ProjectValidationDiagnostic[];
      readonly editorState: EditorProjectState;
      readonly repairs: readonly AuthoringEnumRepair[];
      readonly contentFingerprint: string;
      readonly contentProject: unknown;
      readonly savedContentProject: unknown;
    }
  | {
      readonly ok: false;
      readonly projectRoot: string;
      readonly manifestPath: string;
      readonly diagnostics: readonly ProjectValidationDiagnostic[];
    };

const MONOLITHIC_MANIFEST_CANDIDATES = ['game.json', 'project.json', 'game'] as const;

export function compareProjectWorkspaceUnicodeCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left);
  const rightPoints = Array.from(right);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const difference = leftPoints[index]!.codePointAt(0)! - rightPoints[index]!.codePointAt(0)!;
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}

function freezeRecord<T>(value: Record<string, T>): Readonly<Record<string, T>> {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(value).sort(([left], [right]) =>
        compareProjectWorkspaceUnicodeCodePoints(left, right),
      ),
    ),
  );
}

function ownershipFor(
  project: AuthoringProject,
  manifestFile: string | null,
): Readonly<Record<string, ProjectWorkspaceSaveUnitFileOwnership>> {
  const ownership: Record<string, ProjectWorkspaceSaveUnitFileOwnership> = {
    'project:settings': {
      file: manifestFile,
      paths: ['/project', '/settings', '/startupHook', '/entrypoint'],
    },
    'project:properties': { file: manifestFile, paths: ['/properties'] },
    'project:localization': { file: manifestFile, paths: ['/localization'] },
    'editor:state': { file: manifestFile, paths: ['/editor'] },
  };
  for (const [collection, records] of Object.entries(project)) {
    if (!records || typeof records !== 'object' || Array.isArray(records)) continue;
    if (
      ![
        'assets',
        'characters',
        'dialogues',
        'interactables',
        'interactions',
        'layouts',
        'maps',
        'materials',
        'rooms',
        'scenes',
        'scripts',
        'shaders',
        'tests',
        'variables',
        'verbs',
      ].includes(collection)
    )
      continue;
    for (const id of Object.keys(records).sort(compareProjectWorkspaceUnicodeCodePoints))
      ownership[`record:${collection}:${id}`] = {
        file: manifestFile,
        paths: [`/${collection}/${id}`],
      };
  }
  return freezeRecord(
    Object.fromEntries(
      Object.entries(ownership).map(([key, value]) => [
        key,
        Object.freeze({ ...value, paths: Object.freeze([...value.paths]) }),
      ]),
    ),
  );
}

/**
 * Adapts an already assembled working project to the same deterministic
 * snapshot contract. Renderer state remains the owner of that working value.
 */
export function createProjectWorkspaceSnapshot(
  project: AuthoringProject,
): ProjectWorkspaceSnapshot {
  const source = canonicalProjectContentJson(project);
  const sourceHash = sha256PrefixedUtf8(source);
  return Object.freeze({
    snapshotKind: 'working-copy',
    projectRoot: null,
    manifestPath: null,
    project,
    workspaceRevision: sourceHash,
    sourceRevision: sourceHash,
    canonicalSourceFiles: Object.freeze([]),
    fileRevisions: freezeRecord<ProjectWorkspaceFileRevision>({}),
    saveUnitFileOwnership: ownershipFor(project, null),
    externalSourceDescriptors: collectAuthoringLuaSources(project),
  });
}

export function publishProjectWorkspaceSnapshot(
  snapshot: ProjectWorkspaceSnapshot,
): CompiledArtifactPublicationResult {
  return publishCompiledArtifact(snapshot.project);
}

export function analyzeProjectWorkspaceSources(
  snapshot: ProjectWorkspaceSnapshot,
  ...args: Parameters<typeof analyzeAuthoringSources> extends [AuthoringProject, ...infer T]
    ? T
    : never
) {
  return analyzeAuthoringSources(snapshot.project, ...args);
}

export function collectProjectWorkspaceLuaSources(
  snapshot: ProjectWorkspaceSnapshot,
  contributionKeys?: Parameters<typeof collectAuthoringLuaSources>[1],
) {
  return collectAuthoringLuaSources(snapshot.project, contributionKeys);
}

export function buildProjectWorkspaceSearchIndex(
  snapshot: ProjectWorkspaceSnapshot,
): ProjectSearchIndex {
  return buildProjectSearchIndex(snapshot.project);
}

function unsupportedSchema(projectRoot: string, manifestPath: string): ProjectWorkspaceOpenResult {
  return {
    ok: false,
    projectRoot,
    manifestPath,
    diagnostics: [
      createProjectValidationDiagnostic({
        code: 'authoring.schema.unsupported',
        severity: 'error',
        category: 'authoring.unsupported_schema',
        path: '/schema',
        message: 'Project must use the current NovelTea authoring project schema.',
        boundaries: ['authoring', 'runtime-package'],
        ownerPaths: ['/schema'],
      }),
    ],
  };
}

export class ProjectWorkspaceService {
  constructor(private readonly fileSystem: ProjectWorkspaceFileSystem) {}

  async discover(projectPath: string): Promise<{ projectRoot: string; manifestPath: string }> {
    const absolute = this.fileSystem.resolvePath(projectPath);
    const inputKind = await this.fileSystem.inspect(absolute);
    if (inputKind === 'file')
      return { projectRoot: this.fileSystem.dirname(absolute), manifestPath: absolute };
    for (const candidate of MONOLITHIC_MANIFEST_CANDIDATES) {
      const manifestPath = this.fileSystem.joinPath(absolute, candidate);
      if ((await this.fileSystem.inspect(manifestPath)) === 'file')
        return { projectRoot: absolute, manifestPath };
    }
    return { projectRoot: absolute, manifestPath: this.fileSystem.joinPath(absolute, 'game.json') };
  }

  async open(projectPath: string): Promise<ProjectWorkspaceOpenResult> {
    const discovered = await this.discover(projectPath);
    let source: string;
    try {
      source = await this.fileSystem.readText(discovered.manifestPath);
    } catch {
      return unsupportedSchema(discovered.projectRoot, discovered.manifestPath);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(source) as unknown;
    } catch {
      return unsupportedSchema(discovered.projectRoot, discovered.manifestPath);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return unsupportedSchema(discovered.projectRoot, discovered.manifestPath);

    const savedContentProject = stripEditorProjectState(parsed);
    const contentFingerprint = sha256HexUtf8(canonicalProjectContentJson(savedContentProject));
    const parsedEditor = parseEditorProjectStateWithDiagnostics(
      (parsed as Record<string, unknown>).editor,
      contentFingerprint,
    );
    const decoded = decodeAuthoringProject(savedContentProject);
    if (!decoded.project || decoded.structuralDiagnostics.length > 0) {
      return {
        ok: false,
        ...discovered,
        diagnostics: collectProjectValidationDiagnostics(
          decoded.structuralDiagnostics,
          parsedEditor.diagnostics,
        ),
      };
    }
    const semanticDiagnostics = validateAuthoringProject(decoded.project);
    const sourceHash = sha256PrefixedUtf8(source);
    const manifestFile = this.fileSystem.relativePath(
      discovered.projectRoot,
      discovered.manifestPath,
    );
    const canonicalSourceFiles = Object.freeze([manifestFile]);
    const fileRevisions = freezeRecord({
      [manifestFile]: Object.freeze({
        contentHash: sourceHash,
        byteSize: new TextEncoder().encode(source).byteLength,
      }),
    });
    const snapshot: LoadedProjectWorkspaceSnapshot = Object.freeze({
      snapshotKind: 'loaded',
      projectRoot: discovered.projectRoot,
      manifestPath: discovered.manifestPath,
      project: decoded.project,
      workspaceRevision: sourceHash,
      sourceRevision: sourceHash,
      canonicalSourceFiles,
      fileRevisions,
      saveUnitFileOwnership: ownershipFor(decoded.project, manifestFile),
      externalSourceDescriptors: collectAuthoringLuaSources(decoded.project),
    });
    return {
      ok: true,
      snapshot,
      diagnostics: collectProjectValidationDiagnostics(
        decoded.semanticDiagnostics,
        semanticDiagnostics,
        parsedEditor.diagnostics,
      ),
      editorState: parsedEditor.state,
      repairs: decoded.repairs,
      contentFingerprint,
      contentProject: stripEditorProjectState(decoded.project),
      savedContentProject,
    };
  }

  publishCompiledArtifact(snapshot: ProjectWorkspaceSnapshot): CompiledArtifactPublicationResult {
    return publishProjectWorkspaceSnapshot(snapshot);
  }

  buildDependencyGraph(
    snapshot: ProjectWorkspaceSnapshot,
    luaAnalysis: LuaAnalysisInput = { mode: 'disabled' },
  ): AuthoringDependencyGraph {
    return buildAuthoringDependencyGraph(snapshot.project, luaAnalysis);
  }

  analyzeSources(snapshot: ProjectWorkspaceSnapshot, sources: LuaSourceSnapshot) {
    return analyzeProjectWorkspaceSources(snapshot, sources);
  }

  createSearchIndex(snapshot: ProjectWorkspaceSnapshot): ProjectSearchIndex {
    return buildProjectWorkspaceSearchIndex(snapshot);
  }
}
