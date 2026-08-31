import {
  analyzeAuthoringSources,
  collectAuthoringLuaSources,
  type AuthoringLuaSourceDescriptor,
} from '../authoring-source-analysis';
import { z } from 'zod';
import { buildAuthoringDependencyGraph } from '../authoring-dependency-graph';
import {
  assembleAuthoringDependencyGraph,
  createAuthoringDependencyGraphContributionSet,
  deriveAuthoringDependencyContributionFromPrepared,
  enumerateAuthoringDependencyContributionKeys,
} from '../authoring-dependency-graph';
import type { AuthoringDependencyGraph } from '../authoring-dependency-contracts';
import {
  publishCompiledArtifact,
  type CompiledArtifactPublicationResult,
} from '../compiled-artifact-publication';
import {
  buildProjectSearchIndex,
  type ProjectSearchExternalSource,
  type ProjectSearchIndex,
} from '../project-search/project-search-index';
import {
  AUTHORING_PROJECT_SCHEMA,
  authoringCollectionKeys,
  type AuthoringCollectionKey,
} from '../project-schema/authoring-collections';
import { entityIdSchema } from '../project-schema/authoring-common';
import { authoringProjectSchema, type AuthoringProject } from '../project-schema/authoring-project';
import { authoringLocalizationSchema } from '../project-schema/authoring-localization';
import { traitDefinitionSchema } from '../project-schema/authoring-properties';
import { authoringRecordSchemas } from '../project-schema/authoring-records';
import { validateAuthoringProject } from '../project-schema/authoring-validation';
import {
  editorChaptersStateSchema,
  emptyEditorProjectState,
  editorRecordMetadataSchema,
  editorRecordMetadataStateSchema,
  editorProjectStateSchema,
  editorTagsStateSchema,
  stripEditorProjectState,
  stripLocalEditorProjectState,
  type EditorProjectState,
} from '../project-schema/editor-project-state';
import {
  createProjectValidationDiagnostic,
  type ProjectValidationDiagnostic,
} from '../project-schema/project-validation';
import { parseAssetData } from '../project-schema/authoring-assets';
import type { LuaSourceSnapshot } from '../project-schema/authoring-lua-analysis';
import { sha256PrefixedBytes, sha256PrefixedUtf8 } from '../web-crypto';
import {
  EDITOR_LOCAL_STATE_SCHEMA,
  PROJECT_WORKSPACE_SCHEMA,
  PROJECT_WORKSPACE_SCHEMA_VERSION,
} from './project-workspace-contracts';
import {
  assertProjectWorkspacePathContained,
  type ProjectWorkspaceFileSystem,
} from './project-workspace-file-system';
import {
  PROJECT_WORKSPACE_ABSENT_REVISION,
  ProjectWorkspaceMutationError,
  type ProjectWorkspaceExpectedRevision,
  type ProjectWorkspaceTransactionTargetInput,
  ProjectWorkspaceTransactionService,
  utf8WorkspaceTransactionTarget,
} from './project-workspace-transaction';

export {
  EDITOR_LOCAL_STATE_SCHEMA,
  PROJECT_WORKSPACE_SCHEMA,
  PROJECT_WORKSPACE_SCHEMA_VERSION,
} from './project-workspace-contracts';

/* This is deliberately a distinct persistence codec.  The assembled editor state
 * remains the old in-memory shape, but no workspace file is read as that retired
 * embedded contract. */
const editorLocalStateSchema = editorProjectStateSchema
  .omit({
    schema: true,
    chapters: true,
    tags: true,
    recordMetadata: true,
  })
  .extend({
    schema: z.literal(EDITOR_LOCAL_STATE_SCHEMA),
  })
  .strict();

const workspaceManifestSchema = z
  .object({
    schema: z.literal(PROJECT_WORKSPACE_SCHEMA),
    schemaVersion: z.literal(PROJECT_WORKSPACE_SCHEMA_VERSION),
    project: authoringProjectSchema.shape.project,
    settings: authoringProjectSchema.shape.settings,
    export: authoringProjectSchema.shape.export,
    bootstrapModule: authoringProjectSchema.shape.bootstrapModule,
    entrypoint: authoringProjectSchema.shape.entrypoint,
    inventories: authoringProjectSchema.shape.inventories,
    interactableInstances: authoringProjectSchema.shape.interactableInstances,
  })
  .strict();

const trackedEditorOrganizationSchema = z
  .object({
    chapters: editorChaptersStateSchema,
    tags: editorTagsStateSchema,
    recordMetadata: editorRecordMetadataStateSchema,
  })
  .strict();

function parseTrackedEditorOrganization(value: Readonly<Record<string, unknown>>): Readonly<{
  chapters: EditorProjectState['chapters'];
  tags: EditorProjectState['tags'];
  recordMetadata: EditorProjectState['recordMetadata'];
}> | null {
  const chapters = editorChaptersStateSchema.safeParse(value.chapters);
  const tags = editorTagsStateSchema.safeParse(value.tags);
  const rawMetadata = value.recordMetadata;
  if (
    !chapters.success ||
    !tags.success ||
    !rawMetadata ||
    typeof rawMetadata !== 'object' ||
    Array.isArray(rawMetadata)
  )
    return null;

  // Validate each dynamic record level explicitly. This keeps prototype keys rejected and makes
  // the persisted editor-metadata shape independent of nested dynamic-record parser behavior.
  const recordMetadata: EditorProjectState['recordMetadata'] = {};
  for (const collection of Object.keys(rawMetadata)) {
    if (collection === '__proto__') return null;
    const rawRecords = (rawMetadata as Readonly<Record<string, unknown>>)[collection];
    if (!rawRecords || typeof rawRecords !== 'object' || Array.isArray(rawRecords)) return null;
    const records: Record<string, z.infer<typeof editorRecordMetadataSchema>> = {};
    for (const id of Object.keys(rawRecords)) {
      if (id === '__proto__') return null;
      const parsed = editorRecordMetadataSchema.safeParse(
        (rawRecords as Readonly<Record<string, unknown>>)[id],
      );
      if (!parsed.success) return null;
      records[id] = parsed.data;
    }
    recordMetadata[collection] = records;
  }
  return { chapters: chapters.data, tags: tags.data, recordMetadata };
}

export interface ProjectWorkspaceFileRevision {
  readonly contentHash: `sha256:${string}`;
  readonly byteSize: number;
}
export interface ProjectWorkspaceSaveUnitFileOwnership {
  readonly files: readonly string[];
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
  /** Persisted workspace-v1 file owners; deliberately outside AuthoringProject. */
  readonly scriptSourcePaths: Readonly<Record<string, string>>;
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
      readonly repairs: readonly never[];
      readonly contentProject: unknown;
      readonly savedContentProject: unknown;
    }
  | {
      readonly ok: false;
      readonly projectRoot: string;
      readonly manifestPath: string;
      readonly diagnostics: readonly ProjectValidationDiagnostic[];
    };

export interface ProjectWorkspaceOpenOptions {
  readonly recoverTransactions?: boolean;
}

export function compareProjectWorkspaceUnicodeCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (character) => character.codePointAt(0)!);
  const rightPoints = Array.from(right, (character) => character.codePointAt(0)!);
  for (let index = 0; index < Math.min(leftPoints.length, rightPoints.length); index += 1) {
    const difference = leftPoints[index]! - rightPoints[index]!;
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}
const sortKeys = <T>(value: Record<string, T>) =>
  Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => compareProjectWorkspaceUnicodeCodePoints(a, b)),
  ) as Record<string, T>;
type CanonicalSchema = {
  readonly _zod?: { readonly def?: unknown };
  safeParse?(value: unknown): { readonly success: boolean };
};

function schemaDefinition(
  schema: CanonicalSchema | undefined,
): Record<string, unknown> | undefined {
  const definition = schema?._zod?.def;
  return definition && typeof definition === 'object'
    ? (definition as Record<string, unknown>)
    : undefined;
}

function objectShape(schema: CanonicalSchema): Record<string, CanonicalSchema> | undefined {
  const definition = schemaDefinition(schema);
  return definition?.type === 'object'
    ? (definition.shape as Record<string, CanonicalSchema>)
    : undefined;
}

function literalValues(schema: CanonicalSchema | undefined): readonly unknown[] | undefined {
  const definition = schemaDefinition(schema);
  if (definition?.type === 'literal') return definition.values as readonly unknown[];
  if (
    definition?.type === 'optional' ||
    definition?.type === 'nullable' ||
    definition?.type === 'default' ||
    definition?.type === 'catch' ||
    definition?.type === 'readonly' ||
    definition?.type === 'nonoptional'
  )
    return literalValues(definition.innerType as CanonicalSchema);
  return undefined;
}

function matchingUnionSchema(
  value: unknown,
  options: readonly CanonicalSchema[],
  discriminator?: unknown,
): CanonicalSchema | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const object = value as Record<string, unknown>;
  if (typeof discriminator === 'string') {
    const matched = options.find((option) =>
      literalValues(objectShape(option)?.[discriminator])?.includes(object[discriminator]),
    );
    if (matched) return matched;
  }
  const parsed = options.filter((option) => option.safeParse?.(value).success);
  if (parsed.length > 0) return parsed[0];
  const structurallyMatched = options.filter((option) => {
    const shape = objectShape(option);
    return shape !== undefined && Object.keys(object).every((key) => key in shape);
  });
  return structurallyMatched.length === 1 ? structurallyMatched[0] : undefined;
}

/**
 * A schema object is an ordered product; a Zod record (and an untyped JSON value)
 * is a dictionary.  Keeping that distinction at the codec boundary avoids a
 * parent-key convention that inevitably misses newly added maps.
 */
function canonicalize(value: unknown, schema?: CanonicalSchema): unknown {
  const definition = schemaDefinition(schema);
  const type = definition?.type;
  if (type === 'optional' || type === 'nullable' || type === 'default' || type === 'catch')
    return canonicalize(value, definition?.innerType as CanonicalSchema);
  if (type === 'readonly' || type === 'nonoptional')
    return canonicalize(value, definition?.innerType as CanonicalSchema);
  if (type === 'pipe') return canonicalize(value, definition?.out as CanonicalSchema);
  if (type === 'lazy') {
    const getter = definition?.getter;
    return typeof getter === 'function'
      ? canonicalize(value, (getter as () => CanonicalSchema)())
      : canonicalize(value);
  }
  if (type === 'array') {
    const element = definition?.element as CanonicalSchema;
    return Array.isArray(value) ? value.map((item) => canonicalize(item, element)) : value;
  }
  if (type === 'record') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const item = definition?.valueType as CanonicalSchema;
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => compareProjectWorkspaceUnicodeCodePoints(left, right))
        .map(([key, nested]) => [key, canonicalize(nested, item)]),
    );
  }
  if (type === 'union' || type === 'discriminatedUnion') {
    const options = (definition?.options ?? []) as readonly CanonicalSchema[];
    return canonicalize(value, matchingUnionSchema(value, options, definition?.discriminator));
  }
  if (type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const shape = definition?.shape as Record<string, CanonicalSchema>;
    const object = value as Record<string, unknown>;
    const known = Object.keys(shape)
      .filter((key) => object[key] !== undefined)
      .map((key) => [key, canonicalize(object[key], shape[key])] as const);
    const unknown = Object.keys(object)
      .filter((key) => !(key in shape) && object[key] !== undefined)
      .sort(compareProjectWorkspaceUnicodeCodePoints)
      .map((key) => [key, canonicalize(object[key])] as const);
    return Object.fromEntries([...known, ...unknown]);
  }
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareProjectWorkspaceUnicodeCodePoints(left, right))
      .map(([key, nested]) => [key, canonicalize(nested)]),
  );
}

const canonicalJson = (value: unknown, schema?: CanonicalSchema): string =>
  `${JSON.stringify(canonicalize(value, schema), null, 2)}\n`;
const relative = (value: string) => value.replaceAll('\\', '/');
const knownCollections = new Set<string>(authoringCollectionKeys);
const workspaceError = (
  root: string,
  manifest: string,
  message: string,
  path = '/',
  code = 'authoring.workspace.invalid',
): ProjectWorkspaceOpenResult => ({
  ok: false,
  projectRoot: root,
  manifestPath: manifest,
  diagnostics: [
    createProjectValidationDiagnostic({
      code,
      severity: 'error',
      category: 'Project workspace',
      path,
      message,
      boundaries: ['authoring'],
      ownerPaths: [path],
    }),
  ],
});
const isSafeRelativePath = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  !value.includes('\\') &&
  !value.startsWith('/') &&
  !/^[A-Za-z]:/.test(value) &&
  value.split('/').every((part) => part && part !== '.' && part !== '..');
const hasExactKeys = (value: unknown, keys: readonly string[]) =>
  !!value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value as Record<string, unknown>)
    .sort(compareProjectWorkspaceUnicodeCodePoints)
    .join('\0') === [...keys].sort(compareProjectWorkspaceUnicodeCodePoints).join('\0');
const layoutFile = (id: string, channel: 'rml' | 'rcss' | 'lua') =>
  `records/layouts/${id}/layout.${channel}`;
const recordFile = (collection: AuthoringCollectionKey, id: string) =>
  collection === 'layouts'
    ? `records/layouts/${id}/layout.json`
    : `records/${collection}/${id}.json`;

export function assetSourcePaths(project: AuthoringProject): string[] {
  const paths = new Set<string>();
  for (const record of Object.values(project.assets)) {
    const asset = parseAssetData(record.data);
    if (!asset || !isSafeRelativePath(asset.source.path))
      throw new Error('Asset source path is not a safe project-relative path.');
    paths.add(asset.source.path);
  }
  return [...paths].sort(compareProjectWorkspaceUnicodeCodePoints);
}

async function aggregateRevision(
  revisions: Readonly<Record<string, ProjectWorkspaceFileRevision>>,
) {
  // Keep the revision projection explicit and iterative so ordering and captured values are easy
  // to audit across CLI hosts.
  const pairs: [string, string][] = [];
  for (const file of Object.keys(revisions).sort(compareProjectWorkspaceUnicodeCodePoints))
    pairs.push([file, revisions[file]!.contentHash]);
  return sha256PrefixedUtf8(JSON.stringify(pairs));
}

async function readWorkspaceFileRevision(
  fileSystem: ProjectWorkspaceFileSystem,
  projectRoot: string,
  file: string,
): Promise<ProjectWorkspaceFileRevision | null> {
  try {
    const absolute = fileSystem.joinPath(projectRoot, file);
    await assertProjectWorkspacePathContained(fileSystem, projectRoot, absolute);
    const cached = await fileSystem.readCachedFileRevision?.(absolute);
    if (cached) return cached;
    return await fileSystem.readFileRevision(absolute);
  } catch {
    return null;
  }
}

function ownershipFor(
  project: AuthoringProject,
  scriptSourcePaths: Readonly<Record<string, string>> = {},
): Readonly<Record<string, ProjectWorkspaceSaveUnitFileOwnership>> {
  const result: Record<string, ProjectWorkspaceSaveUnitFileOwnership> = {
    'project:settings': {
      files: ['project.json'],
      paths: [
        '/project',
        '/settings',
        '/bootstrapModule',
        '/entrypoint',
        '/inventories',
        '/interactableInstances',
        '/export/assetMemoryPolicies',
      ],
    },
    'collection:traits': { files: ['traits.json'], paths: ['/traits'] },
    'project:localization': { files: ['localization.json'], paths: ['/localization'] },
    'project:chapters': {
      files: ['editor.json'],
      paths: ['/editor/chapters'],
    },
    'project:tags': { files: ['editor.json'], paths: ['/editor/tags'] },
    'project:platform-export-profiles': {
      files: ['project.json'],
      paths: ['/export/runtime', '/export/profiles'],
    },
    'editor:organization': {
      files: ['editor.json'],
      paths: ['/editor/chapters', '/editor/tags', '/editor/recordMetadata'],
    },
    'editor:state': {
      files: ['.noveltea/editor/state.json'],
      paths: [
        '/editor/recovery',
        '/editor/workbench',
        '/editor/explorer',
        '/editor/bottomPanel',
        '/editor/tabStatesById',
        '/editor/draftsByKey',
      ],
    },
  };
  for (const collection of authoringCollectionKeys) {
    const collectionFiles: string[] = [];
    for (const id of Object.keys(project[collection]).sort(
      compareProjectWorkspaceUnicodeCodePoints,
    )) {
      const files = [recordFile(collection, id)];
      if (collection === 'layouts') {
        const data = project.layouts[id]!.data;
        if (data.rml.sourceMode === 'inline') files.push(layoutFile(id, 'rml'));
        if (data.rcss.sourceMode === 'inline') files.push(layoutFile(id, 'rcss'));
        if (data.lua.sourceMode === 'inline') files.push(layoutFile(id, 'lua'));
      } else if (collection === 'scripts') {
        const source = project.scripts[id]!.data.source;
        if (source.kind === 'inline-lua') files.push(scriptSourcePaths[id] ?? `scripts/${id}.lua`);
      }
      files.push('editor.json');
      result[`record:${collection}:${id}`] = {
        files: Object.freeze([...new Set(files)].sort(compareProjectWorkspaceUnicodeCodePoints)),
        paths: [`/${collection}/${id}`, `/editor/recordMetadata/${collection}/${id}`],
      };
      collectionFiles.push(...files);
    }
    result[`collection:${collection}`] = {
      files: Object.freeze(
        [...new Set(collectionFiles)].sort(compareProjectWorkspaceUnicodeCodePoints),
      ),
      paths: [`/${collection}`, `/editor/recordMetadata/${collection}`],
    };
  }
  result['workflow:play-recorder'] = result['collection:tests']!;
  result['workflow:shader-compiled-output'] = result['collection:shaders']!;
  return Object.freeze(sortKeys(result));
}

export function projectWorkspaceSaveUnitFileOwnership(
  project: AuthoringProject,
  scriptSourcePaths: Readonly<Record<string, string>> = {},
): Readonly<Record<string, ProjectWorkspaceSaveUnitFileOwnership>> {
  return ownershipFor(project, scriptSourcePaths);
}

function externalDescriptors(
  project: AuthoringProject,
  scriptSourcePaths: Readonly<Record<string, string>> = {},
): readonly AuthoringLuaSourceDescriptor[] {
  return collectAuthoringLuaSources(project).map((descriptor) => {
    const match = descriptor.sourcePath.match(/^\/(scripts|layouts)\/([^/]+)/);
    if (!match || descriptor.sourceAssetId || descriptor.inlineText === undefined)
      return descriptor;
    const [, collection, id] = match;
    if (collection === 'scripts')
      return {
        ...descriptor,
        sourceUrl: `project:/${scriptSourcePaths[id] ?? `scripts/${id}.lua`}`,
        inlineText:
          project.scripts[id]?.data &&
          (project.scripts[id].data as { source?: { source?: string } }).source?.source,
      };
    const channel = descriptor.sourcePath.includes('/rml/')
      ? 'rml'
      : descriptor.sourcePath.includes('/lua/')
        ? 'lua'
        : null;
    const layoutData = project.layouts[id]?.data as unknown as Record<
      string,
      { sourceText?: string }
    >;
    return channel
      ? {
          ...descriptor,
          sourceUrl: `project:/${layoutFile(id, channel)}`,
          inlineText: layoutData[channel]?.sourceText,
        }
      : descriptor;
  });
}

function externalSearchSources(
  project: AuthoringProject,
  descriptors: readonly AuthoringLuaSourceDescriptor[],
): readonly ProjectSearchExternalSource[] {
  const sources = new Map<string, ProjectSearchExternalSource>();
  for (const descriptor of descriptors) {
    if (
      !descriptor.sourceUrl.startsWith('project:/') ||
      descriptor.inlineText === undefined ||
      descriptor.semanticOwner.kind !== 'record' ||
      (descriptor.semanticOwner.collection !== 'layouts' &&
        descriptor.semanticOwner.collection !== 'scripts')
    )
      continue;
    sources.set(descriptor.sourceUrl, {
      sourceUrl: descriptor.sourceUrl,
      text: descriptor.inlineText,
      sourceKind: descriptor.sourceKind,
      collection: descriptor.semanticOwner.collection,
      entityId: descriptor.semanticOwner.id,
    });
  }
  for (const [id, record] of Object.entries(project.layouts)) {
    const rcss = record.data.rcss;
    if (rcss.sourceMode !== 'inline') continue;
    const sourceUrl = `project:/${layoutFile(id, 'rcss')}`;
    sources.set(sourceUrl, {
      sourceUrl,
      text: rcss.sourceText,
      sourceKind: 'rcss',
      collection: 'layouts',
      entityId: id,
    });
  }
  return Object.freeze(
    [...sources.values()].sort((a, b) => a.sourceUrl.localeCompare(b.sourceUrl)),
  );
}

/** Projection is the only writer for tracked workspace files. */
export function projectWorkspaceFiles(
  project: AuthoringProject,
  editorState: EditorProjectState,
  scriptSourcePaths: Readonly<Record<string, string>> = {},
): Readonly<Record<string, string>> {
  const files: Record<string, string> = {};
  files['project.json'] = canonicalJson(
    {
      schema: PROJECT_WORKSPACE_SCHEMA,
      schemaVersion: PROJECT_WORKSPACE_SCHEMA_VERSION,
      project: project.project,
      settings: project.settings,
      export: project.export,
      bootstrapModule: project.bootstrapModule,
      entrypoint: project.entrypoint,
      inventories: project.inventories,
      interactableInstances: project.interactableInstances,
    },
    workspaceManifestSchema,
  );
  files['traits.json'] = canonicalJson(
    project.traits,
    z.record(entityIdSchema, traitDefinitionSchema),
  );
  files['localization.json'] = canonicalJson(project.localization, authoringLocalizationSchema);
  files['editor.json'] = canonicalJson(
    {
      chapters: editorState.chapters,
      tags: editorState.tags,
      recordMetadata: editorState.recordMetadata,
    },
    trackedEditorOrganizationSchema,
  );
  for (const collection of authoringCollectionKeys)
    for (const [id, original] of Object.entries(project[collection]).sort(([a], [b]) =>
      compareProjectWorkspaceUnicodeCodePoints(a, b),
    )) {
      const record = structuredClone(original) as Record<string, unknown>;
      if (collection === 'layouts') {
        const data = record.data as Record<string, Record<string, unknown>>;
        for (const channel of ['rml', 'rcss', 'lua'] as const) {
          const source = data[channel]!;
          if (source.sourceMode === 'inline') {
            files[layoutFile(id, channel)] =
              typeof source.sourceText === 'string' ? source.sourceText : '';
            data[channel] = { sourceMode: 'file' };
          } else if (source.sourceMode === 'asset')
            data[channel] = { sourceMode: 'asset', sourceAsset: source.sourceAsset };
          else data[channel] = { sourceMode: 'none' };
        }
      }
      if (collection === 'scripts') {
        const data = record.data as {
          source: { kind: string; source?: string; path?: string };
        };
        if (data.source.kind === 'inline-lua') {
          const file = scriptSourcePaths[id] ?? `scripts/${id}.lua`;
          files[file] = data.source.source ?? '';
          data.source = { kind: 'file', path: file };
        }
      }
      files[recordFile(collection, id)] = canonicalJson(record, authoringRecordSchemas[collection]);
    }
  return sortKeys(files);
}

export function projectWorkspaceLocalStateFile(editorState: EditorProjectState): string {
  const {
    chapters: _chapters,
    tags: _tags,
    recordMetadata: _recordMetadata,
    schema: _schema,
    ...local
  } = editorState;
  return canonicalJson({
    schema: EDITOR_LOCAL_STATE_SCHEMA,
    ...local,
  });
}

export async function createProjectWorkspaceSnapshot(
  project: AuthoringProject,
  scriptSourcePaths: Readonly<Record<string, string>> = {},
): Promise<ProjectWorkspaceSnapshot> {
  const trackedProject = stripLocalEditorProjectState(project);
  const hash = await sha256PrefixedUtf8(canonicalJson(trackedProject, authoringProjectSchema));
  return Object.freeze({
    snapshotKind: 'working-copy',
    projectRoot: null,
    manifestPath: null,
    project,
    workspaceRevision: hash,
    sourceRevision: hash,
    canonicalSourceFiles: Object.freeze([]),
    fileRevisions: Object.freeze({}),
    saveUnitFileOwnership: ownershipFor(project, scriptSourcePaths),
    externalSourceDescriptors: externalDescriptors(project, scriptSourcePaths),
    scriptSourcePaths: Object.freeze(sortKeys({ ...scriptSourcePaths })),
  });
}

export interface ProjectWorkspaceWriteOptions {
  readonly transactionId?: string;
  readonly expectedFileRevisions?: Readonly<Record<string, ProjectWorkspaceExpectedRevision>>;
  readonly targetFiles?: readonly string[];
  readonly operationLabel?: string;
  readonly extraTargets?: readonly ProjectWorkspaceTransactionTargetInput[];
  readonly preflightSnapshot?: LoadedProjectWorkspaceSnapshot;
  /** Active editor sessions already own coherent state and can adopt the committed projection. */
  readonly refreshAfterCommit?: boolean;
}

export class ProjectWorkspaceService {
  private readonly transactions: ProjectWorkspaceTransactionService;

  constructor(
    private readonly fileSystem: ProjectWorkspaceFileSystem,
    transactions?: ProjectWorkspaceTransactionService,
  ) {
    this.transactions =
      transactions ??
      new ProjectWorkspaceTransactionService(fileSystem, { isProcessAlive: async () => null }, 1);
  }
  private assertContained(root: string, candidate: string): Promise<void> {
    return assertProjectWorkspacePathContained(this.fileSystem, root, candidate);
  }
  async discover(projectRoot: string): Promise<{ projectRoot: string; manifestPath: string }> {
    const root = this.fileSystem.resolvePath(projectRoot);
    return { projectRoot: root, manifestPath: this.fileSystem.joinPath(root, 'project.json') };
  }
  open(
    projectRoot: string,
    options: ProjectWorkspaceOpenOptions = {},
  ): Promise<ProjectWorkspaceOpenResult> {
    return new Promise<ProjectWorkspaceOpenResult>((resolve, reject) => {
      void (async () => {
        try {
          const discovered = await this.discover(projectRoot);
          const complete = (result: ProjectWorkspaceOpenResult) => {
            resolve(result);
            return result;
          };
          const fail = (message: string, path?: string, code?: string) =>
            complete(
              workspaceError(discovered.projectRoot, discovered.manifestPath, message, path, code),
            );
          if (options.recoverTransactions === false) {
            const transactionRoot = this.fileSystem.joinPath(
              discovered.projectRoot,
              '.noveltea/transactions',
            );
            const pending = (await this.fileSystem.listDirectory(transactionRoot)).filter(
              (entry) => entry !== '.writer-lock',
            );
            if (pending.length > 0)
              return fail(
                'The workspace has a pending transaction that requires recovery before a read-only dry run.',
                '/.noveltea/transactions',
                'WORKSPACE_TRANSACTION_RECOVERY_CONFLICT',
              );
          } else {
            try {
              await this.transactions.recover(discovered.projectRoot);
            } catch (error) {
              if (error instanceof ProjectWorkspaceMutationError)
                return fail(error.message, '/.noveltea/transactions', error.code);
              throw error;
            }
          }
          let manifest: Record<string, unknown>;
          try {
            await this.assertContained(discovered.projectRoot, discovered.manifestPath);
            const value = JSON.parse(await this.fileSystem.readText(discovered.manifestPath));
            if (!value || typeof value !== 'object' || Array.isArray(value))
              return fail('project.json must be an object.');
            manifest = value as Record<string, unknown>;
          } catch {
            return fail(
              'Current project discovery requires a readable workspace-v1 project.json.',
              '/project.json',
            );
          }
          if (
            manifest.schema !== PROJECT_WORKSPACE_SCHEMA ||
            manifest.schemaVersion !== PROJECT_WORKSPACE_SCHEMA_VERSION
          )
            return fail('Project must use the current NovelTea workspace schema.', '/schema');
          const required = [
            'project',
            'settings',
            'export',
            'bootstrapModule',
            'entrypoint',
            'inventories',
            'interactableInstances',
          ];
          if (Object.keys(manifest).length !== 9 || !required.every((key) => key in manifest))
            return fail('project.json has an unsupported workspace-v1 shape.');
          let traits: unknown;
          let localization: unknown;
          let editor: Record<string, unknown>;
          let trackedEditor: ReturnType<typeof parseTrackedEditorOrganization>;
          try {
            await this.assertContained(
              discovered.projectRoot,
              this.fileSystem.joinPath(discovered.projectRoot, 'traits.json'),
            );
            await this.assertContained(
              discovered.projectRoot,
              this.fileSystem.joinPath(discovered.projectRoot, 'localization.json'),
            );
            await this.assertContained(
              discovered.projectRoot,
              this.fileSystem.joinPath(discovered.projectRoot, 'editor.json'),
            );
            traits = JSON.parse(
              await this.fileSystem.readText(
                this.fileSystem.joinPath(discovered.projectRoot, 'traits.json'),
              ),
            );
            localization = JSON.parse(
              await this.fileSystem.readText(
                this.fileSystem.joinPath(discovered.projectRoot, 'localization.json'),
              ),
            );
            const value = JSON.parse(
              await this.fileSystem.readText(
                this.fileSystem.joinPath(discovered.projectRoot, 'editor.json'),
              ),
            );
            if (!value || typeof value !== 'object' || Array.isArray(value))
              return fail('editor.json must be an object.', '/editor.json');
            editor = value as Record<string, unknown>;
            if (Object.keys(editor).sort().join(',') !== 'chapters,recordMetadata,tags')
              return fail(
                'editor.json must contain exactly tracked organization fields.',
                '/editor.json',
              );
            trackedEditor = parseTrackedEditorOrganization(editor);
            if (!trackedEditor)
              return fail('editor.json tracked organization fields are malformed.', '/editor.json');
          } catch {
            return fail('Required workspace fragments are missing or malformed.');
          }
          const collections = Object.fromEntries(
            authoringCollectionKeys.map((key) => [key, {}]),
          ) as Record<AuthoringCollectionKey, Record<string, unknown>>;
          const scriptSourceOwners = new Set<string>();
          const scriptRealSourceOwners = new Set<string>();
          const layoutRealSourceOwners = new Set<string>();
          const scriptSourcePaths: Record<string, string> = {};
          const recordsRoot = this.fileSystem.joinPath(discovered.projectRoot, 'records');
          if ((await this.fileSystem.inspect(recordsRoot)) !== 'missing') {
            try {
              await this.assertContained(discovered.projectRoot, recordsRoot);
            } catch {
              return fail('records/ escapes the project root.', '/records');
            }
          }
          for (const directory of await this.fileSystem.listDirectory(recordsRoot)) {
            if (!knownCollections.has(directory))
              return fail(`Unknown records collection '${directory}'.`, `/records/${directory}`);
            const collection = directory as AuthoringCollectionKey;
            const collectionPath = this.fileSystem.joinPath(recordsRoot, directory);
            try {
              await this.assertContained(discovered.projectRoot, collectionPath);
            } catch {
              return fail('Record collection escapes the project root.', `/records/${directory}`);
            }
            for (const entry of await this.fileSystem.listDirectory(collectionPath)) {
              if (collection === 'layouts') {
                const layoutPath = this.fileSystem.joinPath(collectionPath, entry);
                if ((await this.fileSystem.inspect(layoutPath)) !== 'directory')
                  return fail('Layout records must be directories.', `/records/layouts/${entry}`);
                try {
                  await this.assertContained(discovered.projectRoot, layoutPath);
                } catch {
                  return fail(
                    'Layout record escapes the project root.',
                    `/records/layouts/${entry}`,
                  );
                }
                const idOk = entityIdSchema.safeParse(entry).success;
                if (!idOk)
                  return fail(
                    'Layout path does not contain a valid record ID.',
                    `/records/layouts/${entry}`,
                  );
                const file = this.fileSystem.joinPath(layoutPath, 'layout.json');
                let raw: Record<string, unknown>;
                try {
                  await this.assertContained(discovered.projectRoot, file);
                  raw = JSON.parse(await this.fileSystem.readText(file)) as Record<string, unknown>;
                } catch {
                  return fail(
                    'Layout record is malformed.',
                    `/records/layouts/${entry}/layout.json`,
                  );
                }
                if (raw.id !== entry)
                  return fail(
                    'Layout record ID does not match its path.',
                    `/records/layouts/${entry}`,
                  );
                const data = raw.data as Record<string, Record<string, unknown>>;
                for (const channel of ['rml', 'rcss', 'lua'] as const) {
                  const source = data?.[channel];
                  if (!source || typeof source !== 'object')
                    return fail(
                      'Layout source selector is malformed.',
                      `/layouts/${entry}/data/${channel}`,
                    );
                  const companion = this.fileSystem.joinPath(layoutPath, `layout.${channel}`);
                  if (source.sourceMode === 'file') {
                    if (!hasExactKeys(source, ['sourceMode']))
                      return fail(
                        'Layout file selector has an unsupported shape.',
                        `/layouts/${entry}/data/${channel}`,
                      );
                    try {
                      await this.assertContained(discovered.projectRoot, companion);
                      const real = await this.fileSystem.realpath(companion);
                      if (layoutRealSourceOwners.has(real))
                        return fail(
                          'Two Layout channels cannot own the same companion source file.',
                          `/records/layouts/${entry}/layout.${channel}`,
                        );
                      layoutRealSourceOwners.add(real);
                      source.sourceText = await this.fileSystem.readText(companion);
                      source.sourceMode = 'inline';
                      source.sourceAsset = null;
                    } catch {
                      return fail(
                        `Missing Layout ${channel.toUpperCase()} companion source.`,
                        `/records/layouts/${entry}/layout.${channel}`,
                      );
                    }
                  } else if (source.sourceMode === 'asset') {
                    if (!hasExactKeys(source, ['sourceMode', 'sourceAsset']))
                      return fail(
                        'Layout asset selector has an unsupported shape.',
                        `/layouts/${entry}/data/${channel}`,
                      );
                    if ((await this.fileSystem.inspect(companion)) !== 'missing')
                      return fail(
                        'Layout companion exists without a file selector.',
                        `/records/layouts/${entry}/layout.${channel}`,
                      );
                    source.sourceMode = 'asset';
                    source.sourceAsset ??= null;
                  } else if (channel === 'lua' && source.sourceMode === 'none') {
                    if (!hasExactKeys(source, ['sourceMode']))
                      return fail(
                        'Layout none selector has an unsupported shape.',
                        `/layouts/${entry}/data/${channel}`,
                      );
                    if ((await this.fileSystem.inspect(companion)) !== 'missing')
                      return fail(
                        'Layout companion exists without a file selector.',
                        `/records/layouts/${entry}/layout.${channel}`,
                      );
                    source.sourceMode = 'inline';
                    source.sourceText = '';
                    source.sourceAsset = null;
                  } else
                    return fail(
                      'Layout source selector is unsupported.',
                      `/layouts/${entry}/data/${channel}`,
                    );
                }
                collections.layouts[entry] = raw;
                continue;
              }
              if (!entry.endsWith('.json'))
                return fail(
                  'Record files must use canonical .json names.',
                  `/records/${collection}/${entry}`,
                );
              const id = entry.slice(0, -5);
              if (!entityIdSchema.safeParse(id).success)
                return fail(
                  'Record path does not contain a valid ID.',
                  `/records/${collection}/${entry}`,
                );
              let raw: Record<string, unknown>;
              try {
                await this.assertContained(
                  discovered.projectRoot,
                  this.fileSystem.joinPath(collectionPath, entry),
                );
                raw = JSON.parse(
                  await this.fileSystem.readText(this.fileSystem.joinPath(collectionPath, entry)),
                ) as Record<string, unknown>;
              } catch {
                return fail('Record is malformed.', `/records/${collection}/${entry}`);
              }
              if (raw.id !== id)
                return fail(
                  'Record ID does not match its path.',
                  `/records/${collection}/${entry}`,
                );
              if (collection === 'scripts') {
                const source = (raw.data as { source?: { kind?: string; path?: unknown } }).source;
                if (source?.kind === 'file') {
                  if (
                    !isSafeRelativePath(source.path) ||
                    !source.path.startsWith('scripts/') ||
                    !source.path.endsWith('.lua')
                  )
                    return fail(
                      'Script Module file source path is invalid.',
                      `/scripts/${id}/data/source/path`,
                    );
                  if (!hasExactKeys(source, ['kind', 'path']))
                    return fail(
                      'Script Module file source has an unsupported shape.',
                      `/scripts/${id}/data/source`,
                    );
                  if (scriptSourceOwners.has(source.path))
                    return fail(
                      'Two Script Modules cannot own the same Lua source file.',
                      `/scripts/${id}/data/source/path`,
                    );
                  scriptSourceOwners.add(source.path);
                  scriptSourcePaths[id] = source.path;
                  let text: string;
                  try {
                    const absolute = this.fileSystem.joinPath(discovered.projectRoot, source.path);
                    await this.assertContained(discovered.projectRoot, absolute);
                    const real = await this.fileSystem.realpath(absolute);
                    if (
                      !relative(
                        this.fileSystem.relativePath(
                          await this.fileSystem.realpath(discovered.projectRoot),
                          real,
                        ),
                      ).startsWith('scripts/')
                    )
                      return fail('Script Module source is not in scripts/.');
                    if (scriptRealSourceOwners.has(real))
                      return fail(
                        'Two Script Modules cannot own the same Lua source file.',
                        `/scripts/${id}/data/source/path`,
                      );
                    scriptRealSourceOwners.add(real);
                    text = await this.fileSystem.readText(absolute);
                  } catch {
                    return fail(
                      'Script Module source file is missing.',
                      `/scripts/${id}/data/source/path`,
                    );
                  }
                  (raw.data as { source: unknown }).source = { kind: 'inline-lua', source: text };
                } else if (source?.kind === 'inline-lua')
                  return fail(
                    'Script Module inline Lua must be persisted as a file source.',
                    `/scripts/${id}/data/source`,
                  );
              }
              collections[collection][id] = raw;
            }
          }
          const localPath = this.fileSystem.joinPath(
            discovered.projectRoot,
            '.noveltea/editor/state.json',
          );
          let local = emptyEditorProjectState();
          try {
            const raw = JSON.parse(await this.fileSystem.readText(localPath)) as Record<
              string,
              unknown
            >;
            const parsedLocal = editorLocalStateSchema.safeParse(raw);
            if (parsedLocal.success) {
              local = {
                ...emptyEditorProjectState(),
                ...parsedLocal.data,
                schema: emptyEditorProjectState().schema,
              };
            }
          } catch {
            /* optional local state */
          }
          const candidate = {
            schema: AUTHORING_PROJECT_SCHEMA,
            ...manifest,
            traits,
            localization,
            editor: {
              ...local,
              chapters: trackedEditor.chapters,
              tags: trackedEditor.tags,
              recordMetadata: trackedEditor.recordMetadata,
            },
            ...collections,
          };
          (candidate as Record<string, unknown>).schema = AUTHORING_PROJECT_SCHEMA;
          delete (candidate as Record<string, unknown>).schemaVersion;
          const decoded = authoringProjectSchema.safeParse(candidate);
          if (!decoded.success)
            return complete({
              ok: false,
              projectRoot: discovered.projectRoot,
              manifestPath: discovered.manifestPath,
              diagnostics: validateAuthoringProject(candidate),
            });
          // Preserve the separately validated tracked editor organization after AuthoringProject
          // parsing instead of relying on a second nested dynamic-record normalization pass.
          decoded.data.editor.chapters = trackedEditor.chapters;
          decoded.data.editor.tags = trackedEditor.tags;
          decoded.data.editor.recordMetadata = trackedEditor.recordMetadata;
          const projected = projectWorkspaceFiles(
            decoded.data,
            decoded.data.editor,
            scriptSourcePaths,
          );
          try {
            // Validate Asset source paths here, but do not make binary Asset bytes part of the
            // authoring workspace revision inventory. Asset integrity has its own exact-byte
            // boundaries and changed-Asset watcher flow.
            assetSourcePaths(decoded.data);
          } catch (error) {
            return fail(error instanceof Error ? error.message : 'Asset source path is invalid.');
          }
          const canonicalSourceFiles = Object.keys(projected).sort(
            compareProjectWorkspaceUnicodeCodePoints,
          );
          const fileRevisions: Record<string, ProjectWorkspaceFileRevision> = {};
          for (const file of canonicalSourceFiles) {
            const revision = await readWorkspaceFileRevision(
              this.fileSystem,
              discovered.projectRoot,
              file,
            );
            if (revision === null)
              return fail(`Authoritative source file '${file}' is missing.`, `/${file}`);
            fileRevisions[file] = revision;
          }
          const workspaceRevision = await aggregateRevision(fileRevisions);
          const contentProject = stripEditorProjectState(decoded.data);
          const snapshot: LoadedProjectWorkspaceSnapshot = Object.freeze({
            snapshotKind: 'loaded',
            projectRoot: discovered.projectRoot,
            manifestPath: discovered.manifestPath,
            project: decoded.data,
            workspaceRevision,
            sourceRevision: workspaceRevision,
            canonicalSourceFiles: Object.freeze(canonicalSourceFiles),
            // canonicalSourceFiles is already sorted, and fileRevisions is populated
            // in that order, so preserve it without a redundant reconstruction.
            fileRevisions: Object.freeze(fileRevisions),
            saveUnitFileOwnership: ownershipFor(decoded.data, scriptSourcePaths),
            externalSourceDescriptors: externalDescriptors(decoded.data, scriptSourcePaths),
            scriptSourcePaths: Object.freeze(sortKeys(scriptSourcePaths)),
          });
          const result: ProjectWorkspaceOpenResult = {
            ok: true,
            snapshot,
            diagnostics: validateAuthoringProject(decoded.data),
            editorState: decoded.data.editor,
            repairs: [],
            contentProject,
            savedContentProject: contentProject,
          };
          return complete(result);
        } catch (error) {
          reject(error);
        }
      })();
    });
  }
  async write(
    projectRoot: string,
    expectedRevision: string,
    project: AuthoringProject,
    editorState: EditorProjectState,
    scriptSourcePathOverrides: Readonly<Record<string, string>> = {},
    options: ProjectWorkspaceWriteOptions = {},
  ): Promise<{
    workspaceRevision: string;
    snapshot: LoadedProjectWorkspaceSnapshot;
    contentProject: unknown;
  }> {
    let openedSnapshot = options.preflightSnapshot;
    if (openedSnapshot) {
      if (openedSnapshot.projectRoot !== this.fileSystem.resolvePath(projectRoot))
        throw new Error('Preflight workspace snapshot does not belong to the save target.');
    } else {
      const opened = await this.open(projectRoot);
      if (!opened.ok)
        throw new Error(opened.diagnostics[0]?.message ?? 'Workspace cannot be saved.');
      openedSnapshot = opened.snapshot;
    }
    if (!options.expectedFileRevisions && openedSnapshot.workspaceRevision !== expectedRevision)
      throw new Error('Project content changed outside the editor.');
    const projectedSourcePaths = {
      ...openedSnapshot.scriptSourcePaths,
      ...scriptSourcePathOverrides,
    };
    const projected = projectWorkspaceFiles(project, editorState, projectedSourcePaths);
    const priorProjected = projectWorkspaceFiles(
      openedSnapshot.project,
      openedSnapshot.project.editor,
      openedSnapshot.scriptSourcePaths,
    );
    const candidates = new Set([...Object.keys(priorProjected), ...Object.keys(projected)]);
    const allowed = options.targetFiles ? new Set(options.targetFiles) : candidates;
    const expected =
      options.expectedFileRevisions ??
      Object.fromEntries(
        Object.entries(openedSnapshot.fileRevisions).map(([file, revision]) => [
          file,
          revision.contentHash,
        ]),
      );
    const targets: ProjectWorkspaceTransactionTargetInput[] = [];
    for (const file of [...candidates].sort(compareProjectWorkspaceUnicodeCodePoints)) {
      if (!allowed.has(file)) continue;
      const currentText = await this.fileSystem
        .readText(this.fileSystem.joinPath(projectRoot, file))
        .catch(() => null);
      const nextText = projected[file] ?? null;
      if (currentText === nextText) continue;
      const expectedRevision = expected[file] ?? PROJECT_WORKSPACE_ABSENT_REVISION;
      targets.push(
        nextText === null
          ? { path: file, operation: 'delete', expectedRevision }
          : utf8WorkspaceTransactionTarget(file, expectedRevision, nextText),
      );
    }
    targets.push(...(options.extraTargets ?? []));
    if (targets.length > 0) {
      await this.transactions.commit(projectRoot, {
        transactionId: options.transactionId,
        operationLabel: options.operationLabel ?? 'project save',
        targets,
      });
    }
    if (options.refreshAfterCommit === false) {
      const canonicalSourceFiles = Object.keys(projected).sort(
        compareProjectWorkspaceUnicodeCodePoints,
      );
      const canonicalSourceFileSet = new Set(canonicalSourceFiles);
      const fileRevisions: Record<string, ProjectWorkspaceFileRevision> = {
        ...openedSnapshot.fileRevisions,
      };
      for (const file of Object.keys(fileRevisions))
        if (!canonicalSourceFileSet.has(file)) delete fileRevisions[file];
      for (const target of targets) {
        if (!canonicalSourceFileSet.has(target.path)) continue;
        if (target.operation === 'delete') {
          delete fileRevisions[target.path];
          continue;
        }
        const bytes = target.bytes!;
        fileRevisions[target.path] = {
          contentHash: await sha256PrefixedBytes(bytes),
          byteSize: bytes.byteLength,
        };
      }
      for (const file of canonicalSourceFiles)
        if (!fileRevisions[file])
          throw new Error(`Committed workspace omitted revision state for '${file}'.`);
      const workspaceRevision = await aggregateRevision(fileRevisions);
      const snapshot: LoadedProjectWorkspaceSnapshot = Object.freeze({
        snapshotKind: 'loaded',
        projectRoot: openedSnapshot.projectRoot,
        manifestPath: openedSnapshot.manifestPath,
        project,
        workspaceRevision,
        sourceRevision: workspaceRevision,
        canonicalSourceFiles: Object.freeze(canonicalSourceFiles),
        fileRevisions: Object.freeze(fileRevisions),
        saveUnitFileOwnership: ownershipFor(project, projectedSourcePaths),
        externalSourceDescriptors: externalDescriptors(project, projectedSourcePaths),
        scriptSourcePaths: Object.freeze(sortKeys(projectedSourcePaths)),
      });
      // The active editor session must advance remaining dirty units' per-file recovery baselines
      // against the committed snapshot before persisting local state, so its caller owns that one
      // final local-state write in this branch.
      return {
        workspaceRevision,
        snapshot,
        contentProject: stripEditorProjectState(project),
      };
    }
    const refreshed = await this.open(projectRoot);
    if (!refreshed.ok) throw new Error('Saved workspace could not be reopened.');
    await this.writeEditorLocalState(projectRoot, editorState);
    return {
      workspaceRevision: refreshed.snapshot.workspaceRevision,
      snapshot: refreshed.snapshot,
      contentProject: refreshed.contentProject,
    };
  }
  async writeEditorLocalState(projectRoot: string, editorState: EditorProjectState): Promise<void> {
    const localPath = this.fileSystem.joinPath(projectRoot, '.noveltea/editor/state.json');
    await this.assertContained(projectRoot, localPath);
    const localText = projectWorkspaceLocalStateFile(editorState);
    if ((await this.fileSystem.readText(localPath).catch(() => null)) !== localText)
      await this.fileSystem.writeTextAtomic(localPath, localText);
  }
  publishCompiledArtifact(snapshot: ProjectWorkspaceSnapshot): CompiledArtifactPublicationResult {
    return publishCompiledArtifact(snapshot.project);
  }
  buildDependencyGraph(snapshot: ProjectWorkspaceSnapshot): Promise<AuthoringDependencyGraph> {
    return buildAuthoringDependencyGraph(snapshot.project);
  }
  async buildDependencyGraphWithSources(
    snapshot: ProjectWorkspaceSnapshot,
  ): Promise<AuthoringDependencyGraph> {
    const sources: LuaSourceSnapshot = { entriesByAssetId: new Map() };
    const analyses = await this.analyzeSources(snapshot, sources);
    const descriptorsByKey = new Map<string, AuthoringLuaSourceDescriptor[]>();
    for (const descriptor of snapshot.externalSourceDescriptors) {
      const values = descriptorsByKey.get(descriptor.contributionKey) ?? [];
      values.push(descriptor);
      descriptorsByKey.set(descriptor.contributionKey, values);
    }
    return assembleAuthoringDependencyGraph(
      createAuthoringDependencyGraphContributionSet(
        enumerateAuthoringDependencyContributionKeys(snapshot.project).map((contributionKey) => {
          const contribution = deriveAuthoringDependencyContributionFromPrepared(
            snapshot.project,
            contributionKey,
            descriptorsByKey.get(contributionKey) ?? [],
            analyses.get(contributionKey) ?? [],
            true,
          );
          if (!contribution)
            throw new Error(`Unable to derive graph contribution '${contributionKey}'.`);
          return contribution;
        }),
      ),
    );
  }
  analyzeSources(
    snapshot: ProjectWorkspaceSnapshot,
    sourceSnapshot: LuaSourceSnapshot,
    limits?: Parameters<typeof analyzeAuthoringSources>[2],
    contributionKeys?: Parameters<typeof analyzeAuthoringSources>[3],
    persistentCache?: Parameters<typeof analyzeAuthoringSources>[4],
  ) {
    return analyzeAuthoringSources(
      snapshot.project,
      sourceSnapshot,
      limits,
      contributionKeys,
      persistentCache,
      collectProjectWorkspaceLuaSources(snapshot, contributionKeys),
    );
  }
  buildSearchIndex(snapshot: ProjectWorkspaceSnapshot): ProjectSearchIndex {
    return buildProjectSearchIndex(snapshot.project, {
      externalSources: externalSearchSources(snapshot.project, snapshot.externalSourceDescriptors),
    });
  }
}
export const publishProjectWorkspaceSnapshot = (snapshot: ProjectWorkspaceSnapshot) =>
  publishCompiledArtifact(snapshot.project);
export const analyzeProjectWorkspaceSources = (
  snapshot: ProjectWorkspaceSnapshot,
  sourceSnapshot: LuaSourceSnapshot,
  limits?: Parameters<typeof analyzeAuthoringSources>[2],
  contributionKeys?: Parameters<typeof analyzeAuthoringSources>[3],
  persistentCache?: Parameters<typeof analyzeAuthoringSources>[4],
) =>
  analyzeAuthoringSources(
    snapshot.project,
    sourceSnapshot,
    limits,
    contributionKeys,
    persistentCache,
    collectProjectWorkspaceLuaSources(snapshot, contributionKeys),
  );
export const collectProjectWorkspaceLuaSources = (
  snapshot: ProjectWorkspaceSnapshot,
  contributionKeys?: Parameters<typeof collectAuthoringLuaSources>[1],
) =>
  contributionKeys
    ? snapshot.externalSourceDescriptors.filter((descriptor) =>
        contributionKeys.has(descriptor.contributionKey),
      )
    : snapshot.externalSourceDescriptors;
export const buildProjectWorkspaceSearchIndex = (snapshot: ProjectWorkspaceSnapshot) =>
  buildProjectSearchIndex(snapshot.project, {
    externalSources: externalSearchSources(snapshot.project, snapshot.externalSourceDescriptors),
  });
