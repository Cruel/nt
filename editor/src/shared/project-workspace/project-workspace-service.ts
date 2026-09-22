import {
  analyzeAuthoringSources,
  collectAuthoringLuaSources,
  collectAuthoringSourceRequirements,
  type AuthoringLuaSourceDescriptor,
} from '../authoring-source-analysis';
import { z } from 'zod';
import { buildAuthoringDependencyGraph } from '../authoring-dependency-graph';
import {
  assembleAuthoringDependencyGraph,
  authoringDependencyReverseImpactClosure,
  buildAuthoringLuaSymbolProjection,
  createAuthoringDependencyGraphContributionSet,
  deriveAuthoringDependencyContributionFromPrepared,
  enumerateAuthoringDependencyContributionKeys,
  findAuthoringDependencyOwnersByPath,
  localizationMessageContributionKey,
  patchAuthoringDependencyGraph,
  projectFieldContributionKey,
  recordContributionKey,
  replaceAuthoringDependencyGraphContributions,
  traitDefinitionContributionKey,
} from '../authoring-dependency-graph';
import type {
  AuthoringDependencyGraph,
  AuthoringDependencyGraphContribution,
  AuthoringDependencyGraphContributionSet,
  AuthoringDependencyGraphDiagnostic,
  AuthoringDependencyNode,
  AuthoringDependencyNodeKey,
} from '../authoring-dependency-contracts';
import {
  publishCompiledArtifact,
  type CompiledArtifactPublicationResult,
} from '../compiled-artifact-publication';
import {
  preflightAdmittedAuthoringProject,
  type AuthoringPreflightResult,
} from '../authoring-compiler';
import {
  buildProjectSearchIndex,
  type ProjectSearchExternalSource,
  type ProjectSearchIndex,
} from '../project-search/project-search-index';
import {
  AUTHORING_PROJECT_SCHEMA,
  authoringCollectionKeys,
  isAuthoringCollectionKey,
  type AuthoringCollectionKey,
} from '../project-schema/authoring-collections';
import { entityIdSchema } from '../project-schema/authoring-common';
import { authoringProjectSchema, type AuthoringProject } from '../project-schema/authoring-project';
import { migrateLegacyAssetMemoryPolicyPercentages } from '../project-schema/platform-export-contracts';
import {
  authoringLocalizationSchema,
  authoringMessageSchema,
  hasSubstantiveLocalizationWork,
  localeDefinitionSchema,
  localeIdSchema,
  localizationAssetTargetSchema,
  localizationTranslationSchema,
  messageIdSchema,
  orphanedLocalizationMessageSchema,
  sourceMessageTrackingEntrySchema,
  type AuthoringLocalization,
} from '../project-schema/authoring-localization';
import { traitDefinitionSchema } from '../project-schema/authoring-properties';
import { authoringRecordSchemas } from '../project-schema/authoring-records';
import {
  validateAdmittedAuthoringProject,
  validateAuthoringProject,
} from '../project-schema/authoring-validation';
import type {
  AuthoringValidationContribution,
  AuthoringValidationReuse,
  AuthoringValidationWork,
} from '../project-schema/authoring-validation-contributions';
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
import { parseJsonPointer } from '../json-pointer';
import {
  createProjectValidationDiagnostic,
  type ProjectValidationDiagnostic,
} from '../project-schema/project-validation';
import { parseAssetData } from '../project-schema/authoring-assets';
import type {
  AuthoringSourceAnalysisArtifact,
  LuaSourceSnapshot,
  LuaSourceSnapshotEntry,
} from '../project-schema/authoring-lua-analysis';
import { escapeJsonPointerSegment, type JsonPointer } from '../json-pointer';
import { sha256PrefixedBytes, sha256PrefixedUtf8 } from '../web-crypto';
import {
  overlayReadonlyArray,
  overlayReadonlyMap,
  overlayReadonlyRecord as overlayRecord,
} from '../bounded-structural-sharing';
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

const traitsWorkspaceSchema = z.record(entityIdSchema, traitDefinitionSchema);

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
type ProjectWorkspaceSourceContributionBase = Readonly<{
  path: string;
  contentHash: `sha256:${string}`;
  byteSize: number;
  schemaValid: true;
  ownerPaths: readonly string[];
  localDiagnostics: readonly ProjectValidationDiagnostic[];
}>;
export type ProjectWorkspaceSourceContribution =
  | (ProjectWorkspaceSourceContributionBase &
      Readonly<{
        kind: 'json';
        parsed: unknown;
      }>)
  | (ProjectWorkspaceSourceContributionBase &
      Readonly<{
        kind: 'text';
        text: string;
      }>);
export type ProjectWorkspaceSourceContributions = Readonly<
  Record<string, ProjectWorkspaceSourceContribution>
>;
export interface ProjectWorkspaceSourceWork {
  /** Physical authored files whose contents were reread for this semantic generation. */
  readonly authoredFilesReread: number;
  readonly parsedJsonSources: number;
  readonly reusedJsonSources: number;
  readonly readTextSources: number;
  readonly reusedTextSources: number;
  readonly projectedJsonSources: number;
  readonly wholeProjectSchemaParses: number;
  /** Structural counters used to keep hot resident reconciliation complexity visible. */
  readonly fullProjectTraversals: number;
  readonly fullProjectProjections: number;
  readonly foregroundSerializations: number;
  /** Bytes serialized synchronously on the foreground semantic path. */
  readonly foregroundSerializedBytes: number;
  /** Whether this generation changed inputs that can affect localization font coverage. */
  readonly localizationCoverageInputsChanged: boolean;
}

export interface ProjectWorkspaceDependencyWork {
  readonly derivedContributions: number;
  readonly reusedContributions: number;
  readonly analyzedOwners: number;
  readonly reusedSourceAnalyses: number;
  /** Complete dependency-key enumeration/graph assembly passes performed for this request. */
  readonly fullProjectTraversals: number;
}
export interface ProjectWorkspaceDependencyAnalysis {
  readonly graph: AuthoringDependencyGraph;
  readonly contributions: AuthoringDependencyGraphContributionSet;
  readonly sourceAnalyses: ReadonlyMap<
    string,
    readonly AuthoringSourceAnalysisArtifact<AuthoringDependencyGraphDiagnostic>[]
  >;
  readonly sourcePathsByContributionKey: ReadonlyMap<string, readonly string[]>;
  readonly externalSourceRevisions: ReadonlyMap<string, ProjectWorkspaceFileRevision>;
  readonly work: ProjectWorkspaceDependencyWork;
}
export interface ProjectWorkspaceReusableDependencyState {
  readonly contributions?: readonly AuthoringDependencyGraphContribution[];
  readonly sourceAnalyses?: ReadonlyMap<
    string,
    readonly AuthoringSourceAnalysisArtifact<AuthoringDependencyGraphDiagnostic>[]
  >;
  readonly externalSourceRevisions?: ReadonlyMap<string, ProjectWorkspaceFileRevision>;
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
      readonly sourceContributions: ProjectWorkspaceSourceContributions;
      readonly validationContributions: readonly AuthoringValidationContribution[];
      readonly validationWork: AuthoringValidationWork;
      readonly sourceWork: ProjectWorkspaceSourceWork;
    }
  | {
      readonly ok: false;
      readonly projectRoot: string;
      readonly manifestPath: string;
      readonly diagnostics: readonly ProjectValidationDiagnostic[];
    };

export interface ProjectWorkspaceOpenOptions {
  readonly recoverTransactions?: boolean;
  readonly reusableSourceContributions?: ProjectWorkspaceSourceContributions;
  readonly reusableValidationContributions?: readonly AuthoringValidationContribution[];
  readonly reusableDependencyState?: ProjectWorkspaceReusableDependencyState;
}

function lazyDetachedProject(project: AuthoringProject): () => unknown {
  let resolved = false;
  let value: unknown;
  return () => {
    if (!resolved) {
      value = stripEditorProjectState(project);
      resolved = true;
    }
    return value;
  };
}

function withLazyOpenContent<T extends object>(
  result: T,
  project: AuthoringProject,
): T & Readonly<{ contentProject: unknown; savedContentProject: unknown }> {
  const content = lazyDetachedProject(project);
  Object.defineProperties(result, {
    contentProject: { enumerable: true, get: content },
    savedContentProject: { enumerable: true, get: content },
  });
  return result as T & Readonly<{ contentProject: unknown; savedContentProject: unknown }>;
}

function withLazyWriteContent<T extends object>(
  result: T,
  project: AuthoringProject,
): T & Readonly<{ contentProject: unknown }> {
  Object.defineProperty(result, 'contentProject', {
    enumerable: true,
    get: lazyDetachedProject(project),
  });
  return result as T & Readonly<{ contentProject: unknown }>;
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

const localizationPolicyFragmentSchema = z
  .object({
    sourceLocale: localeIdSchema,
    sourceLocaleLock: localeIdSchema.nullable().default(null),
    defaultLocale: localeIdSchema,
    locales: z.record(localeIdSchema, localeDefinitionSchema),
  })
  .strict();
const localizationMessagesFragmentSchema = z
  .object({
    messages: z.record(messageIdSchema, authoringMessageSchema),
    structuredMessageIds: z.record(z.string().min(1), messageIdSchema),
  })
  .strict();
const localizationUsageNotesFragmentSchema = z.record(z.string().min(1), z.string());
const localizationTrackingFragmentSchema = z.record(
  z.string().min(1),
  sourceMessageTrackingEntrySchema,
);
const localizationOrphansFragmentSchema = z.record(
  messageIdSchema,
  orphanedLocalizationMessageSchema,
);
const localizationAssetsLocaleFragmentSchema = z.record(
  z.string().min(1),
  localizationAssetTargetSchema,
);

const LOCALIZATION_POLICY_FILE = 'i18n/project.json';
const LOCALIZATION_MESSAGES_FILE = 'i18n/messages.json';
const LOCALIZATION_USAGE_NOTES_FILE = 'i18n/usage-notes.json';
const LOCALIZATION_TRACKING_FILE = 'i18n/tracking.json';
const LOCALIZATION_ORPHANS_FILE = 'i18n/orphans.json';
const localizationTranslationFile = (locale: string) => `i18n/locales/${locale}.json`;
const localizationAssetsFile = (locale: string) => `i18n/assets/${locale}.json`;

export function projectWorkspaceLocalizationFiles(
  localization: AuthoringLocalization,
): Readonly<Record<string, string>> {
  const files: Record<string, string> = {
    [LOCALIZATION_POLICY_FILE]: canonicalJson(
      {
        sourceLocale: localization.sourceLocale,
        sourceLocaleLock:
          localization.sourceLocaleLock ??
          (hasSubstantiveLocalizationWork(localization) ? localization.sourceLocale : null),
        defaultLocale: localization.defaultLocale,
        locales: localization.locales,
      },
      localizationPolicyFragmentSchema,
    ),
    [LOCALIZATION_MESSAGES_FILE]: canonicalJson(
      {
        messages: localization.messages,
        structuredMessageIds: localization.structuredMessageIds,
      },
      localizationMessagesFragmentSchema,
    ),
    [LOCALIZATION_USAGE_NOTES_FILE]: canonicalJson(
      localization.usageNotes,
      localizationUsageNotesFragmentSchema,
    ),
    [LOCALIZATION_TRACKING_FILE]: canonicalJson(
      localization.sourceMessageTracking,
      localizationTrackingFragmentSchema,
    ),
    [LOCALIZATION_ORPHANS_FILE]: canonicalJson(
      localization.orphanedMessages,
      localizationOrphansFragmentSchema,
    ),
  };
  for (const [locale, translations] of Object.entries(localization.translations))
    if (Object.keys(translations).length > 0)
      files[localizationTranslationFile(locale)] = canonicalJson(
        translations,
        localizationTranslationSchema,
      );
  for (const [locale, assets] of Object.entries(localization.assets))
    if (Object.keys(assets).length > 0)
      files[localizationAssetsFile(locale)] = canonicalJson(
        assets,
        localizationAssetsLocaleFragmentSchema,
      );
  return sortKeys(files);
}

export function projectWorkspaceChangedLocalizationFiles(
  before: AuthoringLocalization,
  after: AuthoringLocalization,
): readonly string[] {
  const previous = projectWorkspaceLocalizationFiles(before);
  const next = projectWorkspaceLocalizationFiles(after);
  return Object.freeze(
    [...new Set([...Object.keys(previous), ...Object.keys(next)])]
      .filter((file) => previous[file] !== next[file])
      .sort(compareProjectWorkspaceUnicodeCodePoints),
  );
}

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

function sourceContributionOwnerPaths(
  file: string,
  scriptSourcePaths: Readonly<Record<string, string>>,
): readonly string[] {
  if (file === 'project.json')
    return [
      '/project',
      '/settings',
      '/export',
      '/bootstrapModule',
      '/entrypoint',
      '/inventories',
      '/interactableInstances',
    ];
  if (file === 'traits.json') return ['/traits'];
  if (file === 'editor.json') return ['/editor/chapters', '/editor/tags', '/editor/recordMetadata'];
  if (file === LOCALIZATION_POLICY_FILE)
    return [
      '/localization/sourceLocale',
      '/localization/sourceLocaleLock',
      '/localization/defaultLocale',
      '/localization/locales',
    ];
  if (file === LOCALIZATION_MESSAGES_FILE)
    return ['/localization/messages', '/localization/structuredMessageIds'];
  if (file === LOCALIZATION_USAGE_NOTES_FILE) return ['/localization/usageNotes'];
  if (file === LOCALIZATION_TRACKING_FILE) return ['/localization/sourceMessageTracking'];
  if (file === LOCALIZATION_ORPHANS_FILE) return ['/localization/orphanedMessages'];
  const localeMatch = file.match(/^i18n\/locales\/([^/]+)\.json$/u);
  if (localeMatch)
    return [`/localization/translations/${escapeJsonPointerSegment(localeMatch[1]!)}`];
  const localizedAssetMatch = file.match(/^i18n\/assets\/([^/]+)\.json$/u);
  if (localizedAssetMatch)
    return [`/localization/assets/${escapeJsonPointerSegment(localizedAssetMatch[1]!)}`];

  const layoutMatch = file.match(/^records\/layouts\/([^/]+)\/layout\.(json|rml|rcss|lua)$/u);
  if (layoutMatch) {
    const id = escapeJsonPointerSegment(layoutMatch[1]!);
    const channel = layoutMatch[2]!;
    return channel === 'json' ? [`/layouts/${id}`] : [`/layouts/${id}/data/${channel}`];
  }
  const recordMatch = file.match(/^records\/([^/]+)\/([^/]+)\.json$/u);
  if (recordMatch && isAuthoringCollectionKey(recordMatch[1]!))
    return [`/${recordMatch[1]}/${escapeJsonPointerSegment(recordMatch[2]!)}`];
  for (const [id, sourcePath] of Object.entries(scriptSourcePaths))
    if (sourcePath === file) return [`/scripts/${escapeJsonPointerSegment(id)}/data/source`];
  return [];
}

function jsonPointersOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function candidateWorkspaceFilesForAffectedPath(
  project: AuthoringProject,
  scriptSourcePaths: Readonly<Record<string, string>>,
  affectedPath: string,
): readonly string[] | null {
  if (affectedPath === '/') return null;
  let segments: string[];
  try {
    segments = parseJsonPointer(affectedPath);
  } catch {
    return null;
  }
  const [head, id] = segments;
  if (!head) return null;
  if (isAuthoringCollectionKey(head)) {
    if (!id) return null;
    const files = new Set<string>([recordFile(head, id)]);
    if (head === 'layouts') {
      files.add(layoutFile(id, 'rml'));
      files.add(layoutFile(id, 'rcss'));
      files.add(layoutFile(id, 'lua'));
    } else if (head === 'scripts') {
      const candidate = project.scripts[id];
      if (candidate?.data.source.kind === 'inline-lua')
        files.add(scriptSourcePaths[id] ?? `scripts/${id}.lua`);
    }
    return [...files];
  }
  if (head === 'editor') return ['editor.json'];
  if (head === 'localization')
    return Object.keys(projectWorkspaceLocalizationFiles(project.localization));
  if (head === 'traits') return ['traits.json'];
  if (
    head === 'project' ||
    head === 'settings' ||
    head === 'export' ||
    head === 'bootstrapModule' ||
    head === 'entrypoint' ||
    head === 'inventories' ||
    head === 'interactableInstances'
  )
    return ['project.json'];
  return null;
}

export function projectWorkspaceAffectedFiles(
  snapshot: LoadedProjectWorkspaceSnapshot,
  project: AuthoringProject,
  scriptSourcePaths: Readonly<Record<string, string>>,
  affectedPaths: readonly string[],
): readonly string[] | null {
  if (affectedPaths.length === 0) return null;
  const files = new Set<string>();
  for (const affectedPath of affectedPaths) {
    for (const file of snapshot.canonicalSourceFiles) {
      if (
        sourceContributionOwnerPaths(file, snapshot.scriptSourcePaths).some((ownerPath) =>
          jsonPointersOverlap(ownerPath, affectedPath),
        )
      )
        files.add(file);
    }
    const candidateFiles = candidateWorkspaceFilesForAffectedPath(
      project,
      scriptSourcePaths,
      affectedPath,
    );
    if (!candidateFiles) return null;
    candidateFiles.forEach((file) => files.add(file));
  }
  return [...files].sort(compareProjectWorkspaceUnicodeCodePoints);
}

function jsonPointerPrefixes(path: string): string[] {
  if (path === '/') return ['/'];
  const segments = path.split('/').slice(1);
  const prefixes: string[] = [];
  let current = '';
  for (const segment of segments) {
    current += `/${segment}`;
    prefixes.push(current);
  }
  return prefixes;
}

interface SourceOwnerPathIndex {
  readonly overlappingFiles: (path: string) => readonly string[];
  readonly descendantFiles: (path: string) => readonly string[];
}

function buildSourceOwnerPathIndex(
  ownerPathsByFile: ReadonlyMap<string, readonly string[]>,
): SourceOwnerPathIndex {
  const exactOwners = new Map<string, Set<string>>();
  const descendants = new Map<string, Set<string>>();
  const add = (index: Map<string, Set<string>>, path: string, file: string) => {
    const files = index.get(path) ?? new Set<string>();
    files.add(file);
    index.set(path, files);
  };
  for (const [file, ownerPaths] of ownerPathsByFile) {
    for (const ownerPath of ownerPaths) {
      add(exactOwners, ownerPath, file);
      for (const prefix of jsonPointerPrefixes(ownerPath)) add(descendants, prefix, file);
    }
  }
  const sorted = (files: ReadonlySet<string> | undefined) =>
    [...(files ?? [])].sort(compareProjectWorkspaceUnicodeCodePoints);
  return {
    overlappingFiles: (path) => {
      const files = new Set(descendants.get(path) ?? []);
      for (const prefix of jsonPointerPrefixes(path))
        for (const file of exactOwners.get(prefix) ?? []) files.add(file);
      return sorted(files);
    },
    descendantFiles: (path) => sorted(descendants.get(path)),
  };
}

// Only diagnostics whose validator is provably confined to the owning physical source belong in a
// per-source contribution. Cross-record/reference diagnostics are retained by whole/dependency-aware
// validation instead; ownerPaths describe attribution, not the complete dependency set.
const sourceLocalValidationCodes = new Set([
  'authoring.record.id.invalid',
  'authoring.record.id.key-mismatch',
  'authoring.record.label.required',
  'authoring.project.name.required',
  'authoring.project.version.required',
]);

function sourceLocalDiagnostics(
  diagnostics: readonly ProjectValidationDiagnostic[],
  ownerPathsByFile: ReadonlyMap<string, readonly string[]>,
): ReadonlyMap<string, readonly ProjectValidationDiagnostic[]> {
  const result = new Map<string, ProjectValidationDiagnostic[]>();
  for (const diagnostic of diagnostics) {
    if (!sourceLocalValidationCodes.has(diagnostic.code) || diagnostic.ownerPaths.length === 0)
      continue;
    const candidates: { file: string; score: number }[] = [];
    for (const [file, ownerPaths] of ownerPathsByFile) {
      const diagnosticPathMatches = ownerPaths.filter((ownerPath) =>
        jsonPointersOverlap(diagnostic.path, ownerPath),
      );
      if (diagnosticPathMatches.length === 0) continue;
      let score = Math.max(...diagnosticPathMatches.map((ownerPath) => ownerPath.length));
      let complete = true;
      for (const diagnosticOwner of diagnostic.ownerPaths) {
        const matches = ownerPaths.filter((ownerPath) =>
          jsonPointersOverlap(diagnosticOwner, ownerPath),
        );
        if (matches.length === 0) {
          complete = false;
          break;
        }
        score += Math.max(...matches.map((ownerPath) => ownerPath.length));
      }
      if (complete) candidates.push({ file, score });
    }
    candidates.sort(
      (left, right) => right.score - left.score || left.file.localeCompare(right.file),
    );
    if (candidates.length === 0 || candidates[0]!.score === candidates[1]?.score) continue;
    const file = candidates[0]!.file;
    const values = result.get(file) ?? [];
    values.push(diagnostic);
    result.set(file, values);
  }
  return result;
}

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

type ProjectWorkspaceRevisionState = Readonly<{ xor: bigint; fileCount: number }>;

const snapshotRevisionStates = new WeakMap<
  ProjectWorkspaceSnapshot,
  ProjectWorkspaceRevisionState
>();

async function revisionLeaf(file: string, contentHash: string): Promise<bigint> {
  const leaf = await sha256PrefixedUtf8(`${file}\u0000${contentHash}`);
  return BigInt(`0x${leaf.slice('sha256:'.length)}`);
}

async function revisionFromState(
  state: ProjectWorkspaceRevisionState,
): Promise<`sha256:${string}`> {
  return sha256PrefixedUtf8(
    `workspace-revision-v2\u0000${state.fileCount}\u0000${state.xor.toString(16).padStart(64, '0')}`,
  );
}

async function aggregateRevisionState(
  revisions: Readonly<Record<string, ProjectWorkspaceFileRevision>>,
): Promise<Readonly<{ revision: `sha256:${string}`; state: ProjectWorkspaceRevisionState }>> {
  let xor = 0n;
  let fileCount = 0;
  for (const [file, revision] of Object.entries(revisions)) {
    xor ^= await revisionLeaf(file, revision.contentHash);
    fileCount += 1;
  }
  const state = Object.freeze({ xor, fileCount });
  return { revision: await revisionFromState(state), state };
}

async function advanceRevisionState(
  base: ProjectWorkspaceRevisionState,
  previous: Readonly<Record<string, ProjectWorkspaceFileRevision>>,
  next: Readonly<Record<string, ProjectWorkspaceFileRevision>>,
  changedPaths: readonly string[],
): Promise<Readonly<{ revision: `sha256:${string}`; state: ProjectWorkspaceRevisionState }>> {
  let xor = base.xor;
  let fileCount = base.fileCount;
  for (const path of new Set(changedPaths)) {
    const before = previous[path];
    const after = next[path];
    if (before) {
      xor ^= await revisionLeaf(path, before.contentHash);
      fileCount -= 1;
    }
    if (after) {
      xor ^= await revisionLeaf(path, after.contentHash);
      fileCount += 1;
    }
  }
  const state = Object.freeze({ xor, fileCount });
  return { revision: await revisionFromState(state), state };
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

async function buildWorkspaceSourceAnalysisSnapshot(
  fileSystem: ProjectWorkspaceFileSystem,
  snapshot: ProjectWorkspaceSnapshot,
  contributionKeys?: ReadonlySet<string>,
): Promise<{
  sources: LuaSourceSnapshot<AuthoringDependencyGraphDiagnostic>;
  externalSourceRevisions: ReadonlyMap<string, ProjectWorkspaceFileRevision>;
}> {
  const entries = new Map<string, LuaSourceSnapshotEntry<AuthoringDependencyGraphDiagnostic>>();
  const projectPathEntries = new Map<
    string,
    LuaSourceSnapshotEntry<AuthoringDependencyGraphDiagnostic>
  >();
  const externalSourceRevisions = new Map<string, ProjectWorkspaceFileRevision>();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const requiredAssetIds = contributionKeys
    ? new Set(
        [...contributionKeys].flatMap((key) =>
          collectAuthoringSourceRequirements(snapshot.project, key),
        ),
      )
    : new Set(collectAuthoringSourceRequirements(snapshot.project));
  for (const assetId of [...requiredAssetIds].sort(compareProjectWorkspaceUnicodeCodePoints)) {
    const asset = parseAssetData(snapshot.project.assets[assetId]?.data);
    const unavailable = (message: string) => {
      entries.set(assetId, {
        status: 'unavailable',
        assetId,
        expectedContentHash: asset?.contentHash ?? null,
        diagnostic: {
          severity: 'warning',
          code: 'authoring.lua.source_unavailable',
          path: `/assets/${escapeJsonPointerSegment(assetId)}/data/source`,
          message,
        },
      });
    };
    if (!asset || !isSafeRelativePath(asset.source.path)) {
      unavailable(
        `Source Asset '${assetId}' does not declare a safe project-relative source path.`,
      );
      continue;
    }
    if (!snapshot.projectRoot) {
      unavailable(
        `Source Asset '${assetId}' requires a disk-backed Project to analyze its source.`,
      );
      continue;
    }
    try {
      const absolute = fileSystem.joinPath(snapshot.projectRoot, asset.source.path);
      await assertProjectWorkspacePathContained(fileSystem, snapshot.projectRoot, absolute);
      const bytes = await fileSystem.readBytes(absolute);
      const contentHash = await sha256PrefixedBytes(bytes);
      if (asset.contentHash && asset.contentHash !== contentHash) {
        unavailable(`Source Asset '${assetId}' bytes do not match its declared content hash.`);
        continue;
      }
      const hadUtf8Bom =
        bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
      const text = decoder.decode(hadUtf8Bom ? bytes.subarray(3) : bytes);
      entries.set(assetId, {
        status: 'ready',
        assetId,
        projectRelativePath: asset.source.path,
        contentHash,
        text,
        hadUtf8Bom,
      });
      externalSourceRevisions.set(asset.source.path, {
        contentHash,
        byteSize: bytes.byteLength,
      });
    } catch {
      unavailable(`Source Asset '${assetId}' could not be read as UTF-8 project text.`);
    }
  }
  const directProjectSources = new Map<string, string>();
  const relevantDescriptors = contributionKeys
    ? descriptorsForContributionKeys(snapshot, contributionKeys)
    : snapshot.externalSourceDescriptors;
  for (const descriptor of relevantDescriptors) {
    if (
      descriptor.inlineText === undefined &&
      !descriptor.sourceAssetId &&
      descriptor.sourceUrl.startsWith('project:/')
    )
      directProjectSources.set(
        descriptor.sourceUrl.slice('project:/'.length),
        descriptor.sourcePath,
      );
    for (const [index, projectRelativePath] of (descriptor.dependencyScriptPaths ?? []).entries())
      directProjectSources.set(
        projectRelativePath,
        `/layouts/${escapeJsonPointerSegment(descriptor.layoutId ?? '')}/data/dependencies/scripts/${index}`,
      );
  }
  for (const [projectRelativePath, sourcePath] of directProjectSources) {
    const unavailable = (message: string) => {
      projectPathEntries.set(projectRelativePath, {
        status: 'unavailable',
        projectRelativePath,
        expectedContentHash: null,
        diagnostic: {
          severity: 'warning',
          code: 'authoring.lua.source_unavailable',
          path: sourcePath as JsonPointer,
          message,
        },
      });
    };
    if (!isSafeRelativePath(projectRelativePath)) {
      unavailable(
        `Project source '${String(projectRelativePath)}' is not a safe project-relative path.`,
      );
      continue;
    }
    if (!snapshot.projectRoot) {
      unavailable(
        `Project source '${String(projectRelativePath)}' requires a disk-backed Project.`,
      );
      continue;
    }
    try {
      const absolute = fileSystem.joinPath(snapshot.projectRoot, projectRelativePath);
      await assertProjectWorkspacePathContained(fileSystem, snapshot.projectRoot, absolute);
      const bytes = await fileSystem.readBytes(absolute);
      const contentHash = await sha256PrefixedBytes(bytes);
      const hadUtf8Bom =
        bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
      const text = decoder.decode(hadUtf8Bom ? bytes.subarray(3) : bytes);
      projectPathEntries.set(projectRelativePath, {
        status: 'ready',
        projectRelativePath,
        contentHash,
        text,
        hadUtf8Bom,
      });
      externalSourceRevisions.set(projectRelativePath, {
        contentHash,
        byteSize: bytes.byteLength,
      });
    } catch {
      unavailable(
        `Project source '${String(projectRelativePath)}' could not be read as UTF-8 project text.`,
      );
    }
  }
  return {
    sources: {
      entriesByAssetId: entries,
      entriesByProjectPath: projectPathEntries,
    },
    externalSourceRevisions,
  };
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
    'project:localization': {
      files: Object.keys(projectWorkspaceLocalizationFiles(project.localization)),
      paths: ['/localization'],
    },
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
        files.push(
          source.kind === 'inline-lua'
            ? (scriptSourcePaths[id] ?? `scripts/${id}.lua`)
            : source.path,
        );
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
  sourceTexts?: ReadonlyMap<string, string>,
  contributionKeys?: ReadonlySet<string>,
): readonly AuthoringLuaSourceDescriptor[] {
  return collectAuthoringLuaSources(project, contributionKeys).map((descriptor) => {
    const match = descriptor.sourcePath.match(/^\/(scripts|layouts)\/([^/]+)/);
    if (!match || descriptor.sourceAssetId) return descriptor;
    const [, collection, id] = match;
    if (collection === 'scripts') {
      const projectRelativePath =
        scriptSourcePaths[id] ??
        (descriptor.sourceUrl.startsWith('project:/')
          ? descriptor.sourceUrl.slice('project:/'.length)
          : `scripts/${id}.lua`);
      return {
        ...descriptor,
        sourceUrl: `project:/${projectRelativePath}`,
        inlineText:
          descriptor.inlineText ??
          sourceTexts?.get(projectRelativePath) ??
          (project.scripts[id]?.data &&
            (project.scripts[id].data as { source?: { source?: string } }).source?.source),
      };
    }
    if (descriptor.inlineText === undefined) return descriptor;
    const channel = descriptor.sourcePath.includes('/rml/')
      ? 'rml'
      : descriptor.sourcePath.includes('/rcss/')
        ? 'rcss'
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

export function projectWorkspaceFile(
  project: AuthoringProject,
  editorState: EditorProjectState,
  scriptSourcePaths: Readonly<Record<string, string>>,
  file: string,
): string | undefined {
  if (file === 'project.json')
    return canonicalJson(
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
  if (file === 'traits.json') return canonicalJson(project.traits, traitsWorkspaceSchema);
  if (file === 'editor.json')
    return canonicalJson(
      {
        chapters: editorState.chapters,
        tags: editorState.tags,
        recordMetadata: editorState.recordMetadata,
      },
      trackedEditorOrganizationSchema,
    );
  if (file === LOCALIZATION_POLICY_FILE)
    return canonicalJson(
      {
        sourceLocale: project.localization.sourceLocale,
        sourceLocaleLock:
          project.localization.sourceLocaleLock ??
          (hasSubstantiveLocalizationWork(project.localization)
            ? project.localization.sourceLocale
            : null),
        defaultLocale: project.localization.defaultLocale,
        locales: project.localization.locales,
      },
      localizationPolicyFragmentSchema,
    );
  if (file === LOCALIZATION_MESSAGES_FILE)
    return canonicalJson(
      {
        messages: project.localization.messages,
        structuredMessageIds: project.localization.structuredMessageIds,
      },
      localizationMessagesFragmentSchema,
    );
  if (file === LOCALIZATION_USAGE_NOTES_FILE)
    return canonicalJson(project.localization.usageNotes, localizationUsageNotesFragmentSchema);
  if (file === LOCALIZATION_TRACKING_FILE)
    return canonicalJson(
      project.localization.sourceMessageTracking,
      localizationTrackingFragmentSchema,
    );
  if (file === LOCALIZATION_ORPHANS_FILE)
    return canonicalJson(project.localization.orphanedMessages, localizationOrphansFragmentSchema);
  const translation = /^i18n\/locales\/([^/]+)\.json$/u.exec(file);
  if (translation) {
    const translations = project.localization.translations[translation[1]!] ?? {};
    return Object.keys(translations).length > 0
      ? canonicalJson(translations, localizationTranslationSchema)
      : undefined;
  }
  const localizedAssets = /^i18n\/assets\/([^/]+)\.json$/u.exec(file);
  if (localizedAssets) {
    const assets = project.localization.assets[localizedAssets[1]!] ?? {};
    return Object.keys(assets).length > 0
      ? canonicalJson(assets, localizationAssetsLocaleFragmentSchema)
      : undefined;
  }
  const layoutMatch = /^records\/layouts\/([^/]+)\/layout\.(json|rml|rcss|lua)$/u.exec(file);
  if (layoutMatch) {
    const id = layoutMatch[1]!;
    const channel = layoutMatch[2]!;
    const original = project.layouts[id];
    if (!original) return undefined;
    if (channel !== 'json') {
      const source = original.data[channel as 'rml' | 'rcss' | 'lua'];
      return source.sourceMode === 'inline' ? source.sourceText : undefined;
    }
    const record = structuredClone(original) as Record<string, unknown>;
    const data = record.data as Record<string, Record<string, unknown>>;
    for (const sourceChannel of ['rml', 'rcss', 'lua'] as const) {
      const source = data[sourceChannel]!;
      if (source.sourceMode === 'inline') data[sourceChannel] = { sourceMode: 'file' };
      else if (source.sourceMode === 'asset')
        data[sourceChannel] = { sourceMode: 'asset', sourceAsset: source.sourceAsset };
      else data[sourceChannel] = { sourceMode: 'none' };
    }
    return canonicalJson(record, authoringRecordSchemas.layouts);
  }
  const recordMatch = /^records\/([^/]+)\/([^/]+)\.json$/u.exec(file);
  if (recordMatch && isAuthoringCollectionKey(recordMatch[1]!)) {
    const collection = recordMatch[1] as AuthoringCollectionKey;
    const id = recordMatch[2]!;
    const original = project[collection][id];
    if (!original) return undefined;
    const record = structuredClone(original) as Record<string, unknown>;
    if (collection === 'scripts') {
      const data = record.data as { source: { kind: string; source?: string; path?: string } };
      if (data.source.kind === 'inline-lua') {
        const sourcePath = scriptSourcePaths[id] ?? `scripts/${id}.lua`;
        data.source = { kind: 'file', path: sourcePath };
      }
    }
    return canonicalJson(record, authoringRecordSchemas[collection]);
  }
  for (const [id, record] of Object.entries(project.scripts)) {
    const source = record.data.source;
    if (source.kind !== 'inline-lua') continue;
    if ((scriptSourcePaths[id] ?? `scripts/${id}.lua`) === file) return source.source;
  }
  return undefined;
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
  files['traits.json'] = canonicalJson(project.traits, traitsWorkspaceSchema);
  Object.assign(files, projectWorkspaceLocalizationFiles(project.localization));
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
          data.source = { kind: 'project-file', path: file };
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
  /** Semantic mutation ownership used by resident-session dependency safety. */
  readonly saveUnitIds?: readonly string[];
  readonly affectedPaths?: readonly string[];
  readonly preflightSnapshot?: LoadedProjectWorkspaceSnapshot;
  /** Active editor sessions already own coherent state and can adopt the committed projection. */
  readonly refreshAfterCommit?: boolean;
  /** Resident owners admit the exact projected candidate before the transaction publishes it. */
  readonly admitCandidateBeforeCommit?: (
    snapshot: LoadedProjectWorkspaceSnapshot,
  ) => void | Promise<void>;
}

const sharedSnapshotValidators = new WeakMap<
  ProjectWorkspaceSnapshot,
  (project: AuthoringProject) => readonly ProjectValidationDiagnostic[]
>();
type SnapshotValidationState = Readonly<{
  byKey: ReadonlyMap<string, AuthoringValidationContribution>;
  indexByKey: ReadonlyMap<string, number>;
  keysBySourcePath: ReadonlyMap<string, readonly string[]>;
  unresolvedKeys: ReadonlySet<string>;
}>;
const sharedSnapshotValidationStates = new WeakMap<
  ProjectWorkspaceSnapshot,
  SnapshotValidationState
>();
const sharedSnapshotDependencyReuse = new WeakMap<
  ProjectWorkspaceSnapshot,
  ProjectWorkspaceReusableDependencyState
>();
const sharedSnapshotDependencyAnalysis = new WeakMap<
  ProjectWorkspaceSnapshot,
  ProjectWorkspaceDependencyAnalysis
>();
type SnapshotExternalDescriptorIndex = Readonly<{
  indexesByContributionKey: ReadonlyMap<string, readonly number[]>;
  indexesByProjectPath: ReadonlyMap<string, readonly number[]>;
}>;
const sharedSnapshotExternalDescriptorIndexes = new WeakMap<
  ProjectWorkspaceSnapshot,
  SnapshotExternalDescriptorIndex
>();
type IncrementalDependencySeed = Readonly<{
  base: ProjectWorkspaceDependencyAnalysis;
  contributionKeys: ReadonlySet<string>;
  symbolProjection?: ReadonlyMap<string, readonly AuthoringDependencyNodeKey[]>;
}>;
const sharedSnapshotIncrementalDependencySeeds = new WeakMap<
  ProjectWorkspaceSnapshot,
  IncrementalDependencySeed
>();
const sharedSnapshotLuaSymbolProjections = new WeakMap<
  ProjectWorkspaceSnapshot,
  ReadonlyMap<string, readonly AuthoringDependencyNodeKey[]>
>();
const sharedSnapshotSourceOwnerIndexes = new WeakMap<
  ProjectWorkspaceSnapshot,
  SourceOwnerPathIndex
>();

function createSnapshotExternalDescriptorIndex(
  descriptors: readonly AuthoringLuaSourceDescriptor[],
): SnapshotExternalDescriptorIndex {
  const byContribution = new Map<string, number[]>();
  const byProjectPath = new Map<string, number[]>();
  descriptors.forEach((descriptor, index) => {
    const contributionIndexes = byContribution.get(descriptor.contributionKey) ?? [];
    contributionIndexes.push(index);
    byContribution.set(descriptor.contributionKey, contributionIndexes);
    if (descriptor.sourceUrl.startsWith('project:/')) {
      const projectPath = descriptor.sourceUrl.slice('project:/'.length);
      const sourceIndexes = byProjectPath.get(projectPath) ?? [];
      sourceIndexes.push(index);
      byProjectPath.set(projectPath, sourceIndexes);
    }
  });
  return Object.freeze({
    indexesByContributionKey: new Map(
      [...byContribution].map(([key, indexes]) => [key, Object.freeze(indexes)]),
    ),
    indexesByProjectPath: new Map(
      [...byProjectPath].map(([path, indexes]) => [path, Object.freeze(indexes)]),
    ),
  });
}

function descriptorsForContributionKeys(
  snapshot: ProjectWorkspaceSnapshot,
  contributionKeys: ReadonlySet<string>,
): readonly AuthoringLuaSourceDescriptor[] {
  const index = sharedSnapshotExternalDescriptorIndexes.get(snapshot);
  if (!index)
    return snapshot.externalSourceDescriptors.filter((descriptor) =>
      contributionKeys.has(descriptor.contributionKey),
    );
  const descriptorIndexes = new Set<number>();
  for (const key of contributionKeys)
    for (const descriptorIndex of index.indexesByContributionKey.get(key) ?? [])
      descriptorIndexes.add(descriptorIndex);
  return [...descriptorIndexes]
    .sort((left, right) => left - right)
    .map((descriptorIndex) => snapshot.externalSourceDescriptors[descriptorIndex]!);
}

function createSnapshotValidationState(
  contributions: readonly AuthoringValidationContribution[],
): SnapshotValidationState {
  const byKey = new Map<string, AuthoringValidationContribution>();
  const indexByKey = new Map<string, number>();
  const keysBySourcePath = new Map<string, Set<string>>();
  const unresolvedKeys = new Set<string>();
  contributions.forEach((contribution, index) => {
    byKey.set(contribution.key, contribution);
    indexByKey.set(contribution.key, index);
    if (contribution.unresolvedInputs) unresolvedKeys.add(contribution.key);
    for (const revision of contribution.sourceRevisions) {
      const keys = keysBySourcePath.get(revision.path) ?? new Set<string>();
      keys.add(contribution.key);
      keysBySourcePath.set(revision.path, keys);
    }
  });
  return Object.freeze({
    byKey,
    indexByKey,
    keysBySourcePath: new Map(
      [...keysBySourcePath].map(([path, keys]) => [path, Object.freeze([...keys].sort())]),
    ),
    unresolvedKeys,
  });
}

function recordEditIsPresentationOnly(
  before: AuthoringProject,
  after: AuthoringProject,
  relativePath: string,
): boolean {
  const match = /^records\/([^/]+)\/([^/]+)\.json$/u.exec(relativePath);
  if (!match || !isAuthoringCollectionKey(match[1]!)) return false;
  const collection = match[1] as AuthoringCollectionKey;
  const id = match[2]!;
  const beforeRecord = before[collection][id];
  const afterRecord = after[collection][id];
  if (!beforeRecord || !afterRecord) return false;
  const withoutPresentation = (record: typeof beforeRecord) => {
    const { label: _label, description: _description, ...semantic } = record;
    return semantic;
  };
  return (
    JSON.stringify(withoutPresentation(beforeRecord)) ===
    JSON.stringify(withoutPresentation(afterRecord))
  );
}

function localizationCoverageInputsChanged(
  changedSourcePaths: readonly string[],
  before: AuthoringProject,
  after: AuthoringProject,
): boolean {
  return !(
    changedSourcePaths.length > 0 &&
    changedSourcePaths.every((path) => recordEditIsPresentationOnly(before, after, path))
  );
}

function changedValidationContributionKeys(
  state: SnapshotValidationState,
  changedSourcePaths: readonly string[],
  before: AuthoringProject,
  after: AuthoringProject,
): ReadonlySet<string> {
  const keys = new Set(state.unresolvedKeys);
  for (const path of changedSourcePaths)
    for (const key of state.keysBySourcePath.get(path) ?? []) keys.add(key);
  if (
    keys.has('workspace:localization') &&
    changedSourcePaths.length > 0 &&
    changedSourcePaths.every((path) => recordEditIsPresentationOnly(before, after, path))
  )
    keys.delete('workspace:localization');
  // The editor-metadata check validates only editor.json recordMetadata membership. Existing-source
  // reconciliation cannot add/remove a record identity; traits.json is the one non-structural file
  // whose contents can change metadata target membership, so unrelated source edits can reuse it.
  if (
    keys.has('workspace:editor-metadata') &&
    changedSourcePaths.every((path) => path !== 'editor.json' && path !== 'traits.json')
  )
    keys.delete('workspace:editor-metadata');
  return keys;
}

function registryMembershipChanged(
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>,
): boolean {
  const beforeKeys = Object.keys(before);
  const afterKeys = Object.keys(after);
  return (
    beforeKeys.length !== afterKeys.length || beforeKeys.some((key) => !Object.hasOwn(after, key))
  );
}

function aggregateSemanticMembershipChanged(
  changedSourcePaths: readonly string[],
  before: AuthoringProject,
  after: AuthoringProject,
): boolean {
  if (
    changedSourcePaths.includes('traits.json') &&
    registryMembershipChanged(before.traits, after.traits)
  )
    return true;
  if (
    changedSourcePaths.includes('project.json') &&
    (registryMembershipChanged(before.interactableInstances, after.interactableInstances) ||
      before.settings.cursors.named.length !== after.settings.cursors.named.length)
  )
    return true;
  if (
    changedSourcePaths.includes(LOCALIZATION_POLICY_FILE) &&
    (before.localization.sourceLocale !== after.localization.sourceLocale ||
      registryMembershipChanged(before.localization.locales, after.localization.locales))
  )
    return true;
  if (
    changedSourcePaths.includes(LOCALIZATION_MESSAGES_FILE) &&
    registryMembershipChanged(before.localization.messages, after.localization.messages)
  )
    return true;
  for (const path of changedSourcePaths) {
    const localeMatch = /^i18n\/locales\/([^/]+)\.json$/u.exec(path);
    if (!localeMatch) continue;
    const locale = localeMatch[1]!;
    if (
      registryMembershipChanged(
        before.localization.translations[locale] ?? {},
        after.localization.translations[locale] ?? {},
      )
    )
      return true;
  }
  return false;
}

function advanceSnapshotValidationState(
  base: SnapshotValidationState,
  contributions: readonly AuthoringValidationContribution[],
  changedKeys: ReadonlySet<string>,
): SnapshotValidationState {
  const contributionChanges = new Map<string, AuthoringValidationContribution>();
  const touchedSourcePaths = new Set<string>();
  for (const key of changedKeys) {
    const index = base.indexByKey.get(key);
    const prior = base.byKey.get(key);
    if (index === undefined || !prior) continue;
    const next = contributions[index];
    if (!next || next.key !== key)
      throw new Error(`Incremental validation contribution '${key}' changed identity.`);
    contributionChanges.set(key, next);
    prior.sourceRevisions.forEach((revision) => touchedSourcePaths.add(revision.path));
    next.sourceRevisions.forEach((revision) => touchedSourcePaths.add(revision.path));
  }
  const sourceChanges = new Map<string, readonly string[]>();
  const deletedSources = new Set<string>();
  const unresolvedKeys = new Set(base.unresolvedKeys);
  for (const [key, contribution] of contributionChanges) {
    if (contribution.unresolvedInputs) unresolvedKeys.add(key);
    else unresolvedKeys.delete(key);
  }
  for (const path of touchedSourcePaths) {
    const keys = new Set(base.keysBySourcePath.get(path) ?? []);
    for (const key of changedKeys) keys.delete(key);
    for (const [key, contribution] of contributionChanges)
      if (contribution.sourceRevisions.some((revision) => revision.path === path)) keys.add(key);
    if (keys.size === 0) deletedSources.add(path);
    else sourceChanges.set(path, Object.freeze([...keys].sort()));
  }
  return Object.freeze({
    byKey: overlayReadonlyMap(base.byKey, contributionChanges),
    indexByKey: base.indexByKey,
    keysBySourcePath: overlayReadonlyMap(base.keysBySourcePath, sourceChanges, deletedSources),
    unresolvedKeys,
  });
}

function dependencyContributionKeyForNode(node: AuthoringDependencyNode): string {
  switch (node.key.kind) {
    case 'record':
      return recordContributionKey(node.key.collection, node.key.id);
    case 'nested':
      return recordContributionKey(node.key.ownerCollection, node.key.ownerId);
    case 'trait-definition':
      return traitDefinitionContributionKey(node.key.id);
    case 'localization-message':
      return localizationMessageContributionKey(node.key.locale, node.key.messageId);
    case 'project-field':
      return projectFieldContributionKey(node.key.path);
  }
}

function recordOwnerRoot(path: string): JsonPointer | null {
  const segments = parseJsonPointer(path);
  if (segments.length < 2) return null;
  const collection = segments[0]!;
  if (isAuthoringCollectionKey(collection))
    return `/${escapeJsonPointerSegment(collection)}/${escapeJsonPointerSegment(segments[1]!)}`;
  if (collection === 'traits') return `/traits/${escapeJsonPointerSegment(segments[1]!)}`;
  return null;
}

function incrementalDependencyContributionKeys(
  analysis: ProjectWorkspaceDependencyAnalysis,
  ownerPaths: ReadonlySet<string>,
): ReadonlySet<string> | null {
  const roots: AuthoringDependencyNode[] = [];
  for (const ownerPath of ownerPaths) {
    const rootPath = recordOwnerRoot(ownerPath);
    if (!rootPath) return null;
    const nodeKeys = analysis.graph.sourceNodeKeysByOwnedPath.get(rootPath);
    if (!nodeKeys || nodeKeys.length === 0) return null;
    for (const nodeKey of nodeKeys) {
      const node = analysis.graph.nodesByKey.get(nodeKey);
      if (node) roots.push(node);
    }
  }
  const impacted = new Map<string, AuthoringDependencyNode>();
  for (const root of roots) impacted.set(root.keyText, root);
  for (const node of authoringDependencyReverseImpactClosure(
    analysis.graph,
    roots.map((node) => node.key),
  ))
    impacted.set(node.keyText, node);
  return new Set([...impacted.values()].map(dependencyContributionKeyForNode));
}

export class ProjectWorkspaceService {
  private readonly snapshotValidators = sharedSnapshotValidators;
  private readonly snapshotValidationStates = sharedSnapshotValidationStates;
  private readonly snapshotDependencyReuse = sharedSnapshotDependencyReuse;
  private readonly snapshotDependencyAnalysis = sharedSnapshotDependencyAnalysis;
  private readonly snapshotIncrementalDependencySeeds = sharedSnapshotIncrementalDependencySeeds;
  private readonly snapshotLuaSymbolProjections = sharedSnapshotLuaSymbolProjections;
  private readonly snapshotExternalDescriptorIndexes = sharedSnapshotExternalDescriptorIndexes;
  private readonly snapshotSourceOwnerIndexes = sharedSnapshotSourceOwnerIndexes;
  private readonly transactions: ProjectWorkspaceTransactionService;

  constructor(
    private readonly fileSystem: ProjectWorkspaceFileSystem,
    transactions?: ProjectWorkspaceTransactionService,
  ) {
    this.transactions =
      transactions ??
      new ProjectWorkspaceTransactionService(fileSystem, { isProcessAlive: async () => null }, 1);
  }

  private affectedWorkspaceFiles(
    snapshot: LoadedProjectWorkspaceSnapshot,
    project: AuthoringProject,
    scriptSourcePaths: Readonly<Record<string, string>>,
    affectedPaths: readonly string[],
  ): readonly string[] | null {
    const sourceOwnerPathIndex = this.snapshotSourceOwnerIndexes.get(snapshot);
    if (!sourceOwnerPathIndex || affectedPaths.length === 0) return null;
    const files = new Set<string>();
    for (const affectedPath of affectedPaths) {
      for (const file of sourceOwnerPathIndex.overlappingFiles(affectedPath)) files.add(file);
      const candidateFiles = candidateWorkspaceFilesForAffectedPath(
        project,
        scriptSourcePaths,
        affectedPath,
      );
      if (!candidateFiles) return null;
      candidateFiles.forEach((file) => files.add(file));
    }
    return [...files].sort(compareProjectWorkspaceUnicodeCodePoints);
  }

  private assertContained(root: string, candidate: string): Promise<void> {
    return assertProjectWorkspacePathContained(this.fileSystem, root, candidate);
  }
  async discover(projectRoot: string): Promise<{ projectRoot: string; manifestPath: string }> {
    const root = this.fileSystem.resolvePath(projectRoot);
    return { projectRoot: root, manifestPath: this.fileSystem.joinPath(root, 'project.json') };
  }
  async reconcileExistingSources(
    base: Extract<ProjectWorkspaceOpenResult, { ok: true }>,
    changedPaths: readonly string[],
  ): Promise<ProjectWorkspaceOpenResult | null> {
    if (changedPaths.length === 0) return base;
    let project = base.snapshot.project;
    const fileRevisionChanges: Record<string, ProjectWorkspaceFileRevision> = {};
    const sourceContributionChanges: Record<string, ProjectWorkspaceSourceContribution> = {};
    const changedOwnerPaths = new Map<string, readonly string[]>();
    const changedTextSources = new Map<string, string>();
    let parsedJsonSources = 0;
    let readTextSources = 0;
    let projectedJsonSources = 0;
    let fullProjectTraversals = 0;
    const recordSemanticTraversal = () => {
      fullProjectTraversals += 1;
    };

    for (const relativePath of [...new Set(changedPaths)].sort(
      compareProjectWorkspaceUnicodeCodePoints,
    )) {
      const priorContribution = base.sourceContributions[relativePath];
      if (!priorContribution) return null;
      const absolute = this.fileSystem.joinPath(base.snapshot.projectRoot, relativePath);
      try {
        await this.assertContained(base.snapshot.projectRoot, absolute);
        const bytes = await this.fileSystem.readBytes(absolute);
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        const revision = {
          contentHash: await sha256PrefixedBytes(bytes),
          byteSize: bytes.byteLength,
        };
        const recordMatch = /^records\/([^/]+)\/([^/]+)\.json$/u.exec(relativePath);
        const layoutSourceMatch = /^records\/layouts\/([^/]+)\/layout\.(rml|rcss|lua)$/u.exec(
          relativePath,
        );
        const scriptSourceId = priorContribution.ownerPaths
          .map((path) => parseJsonPointer(path))
          .find((segments) => segments[0] === 'scripts' && segments.length >= 2)?.[1];

        if (relativePath === 'project.json') {
          const parsed = workspaceManifestSchema.safeParse(JSON.parse(text));
          if (!parsed.success) return null;
          project = {
            ...project,
            project: parsed.data.project,
            settings: parsed.data.settings,
            export: parsed.data.export,
            bootstrapModule: parsed.data.bootstrapModule,
            entrypoint: parsed.data.entrypoint,
            inventories: parsed.data.inventories,
            interactableInstances: parsed.data.interactableInstances,
          };
        } else if (relativePath === 'traits.json') {
          const parsed = traitsWorkspaceSchema.safeParse(JSON.parse(text));
          if (!parsed.success) return null;
          project = { ...project, traits: parsed.data };
        } else if (relativePath === 'editor.json') {
          const raw = JSON.parse(text) as Record<string, unknown>;
          const parsed = parseTrackedEditorOrganization(raw);
          if (!parsed) return null;
          project = { ...project, editor: { ...project.editor, ...parsed } };
        } else if (relativePath === LOCALIZATION_POLICY_FILE) {
          const parsed = localizationPolicyFragmentSchema.safeParse(JSON.parse(text));
          if (!parsed.success) return null;
          project = { ...project, localization: { ...project.localization, ...parsed.data } };
        } else if (relativePath === LOCALIZATION_MESSAGES_FILE) {
          const parsed = localizationMessagesFragmentSchema.safeParse(JSON.parse(text));
          if (!parsed.success) return null;
          project = { ...project, localization: { ...project.localization, ...parsed.data } };
        } else if (relativePath === LOCALIZATION_USAGE_NOTES_FILE) {
          const parsed = localizationUsageNotesFragmentSchema.safeParse(JSON.parse(text));
          if (!parsed.success) return null;
          project = {
            ...project,
            localization: { ...project.localization, usageNotes: parsed.data },
          };
        } else if (relativePath === LOCALIZATION_TRACKING_FILE) {
          const parsed = localizationTrackingFragmentSchema.safeParse(JSON.parse(text));
          if (!parsed.success) return null;
          project = {
            ...project,
            localization: { ...project.localization, sourceMessageTracking: parsed.data },
          };
        } else if (relativePath === LOCALIZATION_ORPHANS_FILE) {
          const parsed = localizationOrphansFragmentSchema.safeParse(JSON.parse(text));
          if (!parsed.success) return null;
          project = {
            ...project,
            localization: { ...project.localization, orphanedMessages: parsed.data },
          };
        } else if (/^i18n\/locales\/([^/]+)\.json$/u.test(relativePath)) {
          const locale = /^i18n\/locales\/([^/]+)\.json$/u.exec(relativePath)![1]!;
          const parsed = localizationTranslationSchema.safeParse(JSON.parse(text));
          if (!parsed.success || !project.localization.translations[locale]) return null;
          project = {
            ...project,
            localization: {
              ...project.localization,
              translations: overlayRecord(
                project.localization.translations,
                { [locale]: parsed.data },
                recordSemanticTraversal,
              ),
            },
          };
        } else if (/^i18n\/assets\/([^/]+)\.json$/u.test(relativePath)) {
          const locale = /^i18n\/assets\/([^/]+)\.json$/u.exec(relativePath)![1]!;
          const parsed = localizationAssetsLocaleFragmentSchema.safeParse(JSON.parse(text));
          if (!parsed.success || !project.localization.assets[locale]) return null;
          project = {
            ...project,
            localization: {
              ...project.localization,
              assets: overlayRecord(
                project.localization.assets,
                { [locale]: parsed.data },
                recordSemanticTraversal,
              ),
            },
          };
        } else if (recordMatch && isAuthoringCollectionKey(recordMatch[1]!)) {
          const collection = recordMatch[1] as AuthoringCollectionKey;
          const id = recordMatch[2]!;
          if (!project[collection][id]) return null;
          const raw = JSON.parse(text) as Record<string, unknown>;
          if (raw.id !== id) return null;
          if (collection === 'layouts') {
            const prior = project.layouts[id];
            const data = raw.data as Record<string, Record<string, unknown>>;
            if (!prior || !data) return null;
            for (const channel of ['rml', 'rcss', 'lua'] as const) {
              const selector = data[channel];
              if (!selector) return null;
              const priorSource = prior.data[channel];
              if (selector.sourceMode === 'file') {
                if (priorSource.sourceMode !== 'inline') return null;
                data[channel] = {
                  sourceMode: 'inline',
                  sourceText: priorSource.sourceText,
                  sourceAsset: null,
                };
              } else if (selector.sourceMode === 'asset') {
                if (priorSource.sourceMode !== 'asset') return null;
                data[channel] = {
                  sourceMode: 'asset',
                  sourceAsset: selector.sourceAsset ?? null,
                };
              } else if (channel === 'lua' && selector.sourceMode === 'none') {
                if (priorSource.sourceMode !== 'inline' || priorSource.sourceText !== '')
                  return null;
                data[channel] = { sourceMode: 'inline', sourceText: '', sourceAsset: null };
              } else return null;
            }
          } else if (collection === 'scripts') {
            const prior = project.scripts[id];
            const source = (raw.data as { source?: { kind?: string; path?: unknown } })?.source;
            const priorPath = base.snapshot.scriptSourcePaths[id];
            if (!prior || source?.kind !== 'project-file' || source.path !== priorPath) return null;
            const priorSource = prior.data.source;
            if (priorSource.kind !== 'project-file' || priorSource.path !== priorPath) return null;
          }
          const parsed = authoringRecordSchemas[collection].safeParse(raw);
          if (!parsed.success || parsed.data.id !== id) return null;
          project = {
            ...project,
            [collection]: overlayRecord(
              project[collection] as Readonly<Record<string, unknown>>,
              { [id]: parsed.data },
              recordSemanticTraversal,
            ),
          } as AuthoringProject;
        } else if (layoutSourceMatch) {
          const id = layoutSourceMatch[1]!;
          const channel = layoutSourceMatch[2] as 'rml' | 'rcss' | 'lua';
          const prior = project.layouts[id];
          if (!prior || prior.data[channel].sourceMode !== 'inline') return null;
          project = {
            ...project,
            layouts: overlayRecord(
              project.layouts,
              {
                [id]: {
                  ...prior,
                  data: {
                    ...prior.data,
                    [channel]: {
                      sourceMode: 'inline',
                      sourceText: text,
                      sourceAsset: null,
                    },
                  },
                },
              },
              recordSemanticTraversal,
            ),
          };
        } else if (scriptSourceId) {
          const prior = project.scripts[scriptSourceId];
          if (!prior) return null;
          if (prior.data.source.kind === 'project-file') {
            if (prior.data.source.path !== relativePath) return null;
            // The semantic Script Module continues to reference its companion file. The changed
            // text is carried by the source contribution/external descriptor below, so unrelated
            // Project records remain shared with the coherent generation.
          } else if (prior.data.source.kind === 'inline-lua') {
            project = {
              ...project,
              scripts: overlayRecord(
                project.scripts as unknown as Readonly<Record<string, typeof prior>>,
                {
                  [scriptSourceId]: {
                    ...prior,
                    data: { ...prior.data, source: { kind: 'inline-lua', source: text } },
                  },
                },
                recordSemanticTraversal,
              ) as AuthoringProject['scripts'],
            };
          } else return null;
        } else return null;

        fileRevisionChanges[relativePath] = revision;
        const ownerPaths = priorContribution.ownerPaths;
        changedOwnerPaths.set(relativePath, ownerPaths);
        if (relativePath.endsWith('.json')) {
          parsedJsonSources += 1;
          projectedJsonSources += 1;
          const normalizedText = projectWorkspaceFile(
            project,
            project.editor,
            base.snapshot.scriptSourcePaths,
            relativePath,
          );
          if (normalizedText === undefined) return null;
          sourceContributionChanges[relativePath] = Object.freeze({
            path: relativePath,
            ...revision,
            kind: 'json' as const,
            parsed: JSON.parse(normalizedText) as unknown,
            schemaValid: true as const,
            ownerPaths,
            localDiagnostics: Object.freeze([]),
          });
        } else {
          readTextSources += 1;
          changedTextSources.set(relativePath, text);
          sourceContributionChanges[relativePath] = Object.freeze({
            path: relativePath,
            ...revision,
            kind: 'text' as const,
            text,
            schemaValid: true as const,
            ownerPaths,
            localDiagnostics: Object.freeze([]),
          });
        }
      } catch {
        return null;
      }
    }

    const fileRevisions = overlayRecord(base.snapshot.fileRevisions, fileRevisionChanges);
    let sourceContributions = overlayRecord(base.sourceContributions, sourceContributionChanges);
    const sourceOwnerPathIndex =
      this.snapshotSourceOwnerIndexes.get(base.snapshot) ??
      buildSourceOwnerPathIndex(
        new Map(
          Object.entries(sourceContributions).map(([file, contribution]) => [
            file,
            contribution.ownerPaths,
          ]),
        ),
      );
    const priorValidationState = this.snapshotValidationStates.get(base.snapshot);
    const semanticMembershipChanged = aggregateSemanticMembershipChanged(
      changedPaths,
      base.snapshot.project,
      project,
    );
    if (semanticMembershipChanged) fullProjectTraversals += 1;
    const invalidValidationKeys =
      priorValidationState && !semanticMembershipChanged
        ? changedValidationContributionKeys(
            priorValidationState,
            changedPaths,
            base.snapshot.project,
            project,
          )
        : null;
    const resolveValidationInputs: AuthoringValidationReuse['resolveInputs'] = (paths) => {
      if (paths.some((path) => path === '/' || path === '/editor' || path.startsWith('/editor/')))
        return null;
      const files = new Set<string>();
      for (const path of paths) {
        const overlappingFiles = sourceOwnerPathIndex.overlappingFiles(path);
        for (const file of overlappingFiles) files.add(file);
        const collection = path.split('/')[1] ?? '';
        if (overlappingFiles.length === 0 && isAuthoringCollectionKey(collection)) {
          for (const file of sourceOwnerPathIndex.descendantFiles(`/${collection}`))
            files.add(file);
        } else if (overlappingFiles.length === 0) files.add('project.json');
      }
      return [...files].sort(compareProjectWorkspaceUnicodeCodePoints).map((path) => ({
        path,
        contentHash: fileRevisions[path]!.contentHash,
      }));
    };
    const validationReuse: AuthoringValidationReuse = semanticMembershipChanged
      ? {
          contributions: [],
          resolveInputs: resolveValidationInputs,
        }
      : {
          contributions: base.validationContributions,
          ...(priorValidationState && invalidValidationKeys
            ? {
                contributionsByKey: priorValidationState.byKey,
                changedContributionKeys: invalidValidationKeys,
                contributionIndexes: priorValidationState.indexByKey,
                baseDiagnostics: base.diagnostics,
              }
            : {}),
          changedSourcePaths: new Set(changedPaths),
          resolveInputs: resolveValidationInputs,
        };
    const validation = validateAdmittedAuthoringProject(project, validationReuse);
    const changedLocalDiagnostics = sourceLocalDiagnostics(
      validation.diagnostics,
      changedOwnerPaths,
    );
    for (const [relativePath, ownerPaths] of changedOwnerPaths) {
      const contribution =
        sourceContributionChanges[relativePath] ?? sourceContributions[relativePath]!;
      sourceContributionChanges[relativePath] = Object.freeze({
        ...contribution,
        ownerPaths,
        localDiagnostics: Object.freeze([...(changedLocalDiagnostics.get(relativePath) ?? [])]),
      });
    }
    sourceContributions = overlayRecord(base.sourceContributions, sourceContributionChanges);

    const priorRevisionState = snapshotRevisionStates.get(base.snapshot);
    const aggregate = priorRevisionState
      ? await advanceRevisionState(
          priorRevisionState,
          base.snapshot.fileRevisions,
          fileRevisions,
          changedPaths,
        )
      : await aggregateRevisionState(fileRevisions);
    const workspaceRevision = aggregate.revision;
    const priorAnalysis = this.snapshotDependencyAnalysis.get(base.snapshot);
    const impactedOwnerPaths = new Set(changedOwnerPaths.values().flatMap((paths) => [...paths]));
    const incrementalDependencyKeys =
      priorAnalysis && !semanticMembershipChanged
        ? incrementalDependencyContributionKeys(priorAnalysis, impactedOwnerPaths)
        : null;
    const priorDescriptorIndex = this.snapshotExternalDescriptorIndexes.get(base.snapshot);
    let externalSourceDescriptors = base.snapshot.externalSourceDescriptors;
    const changedRecordKeys = new Set<string>();
    for (const path of changedPaths) {
      const match = /^records\/([^/]+)\/([^/]+)\.json$/u.exec(path);
      if (match && isAuthoringCollectionKey(match[1]!))
        changedRecordKeys.add(recordContributionKey(match[1], match[2]!));
    }
    if (changedRecordKeys.size > 0) {
      if (!priorDescriptorIndex) return null;
      const keys = incrementalDependencyKeys ?? changedRecordKeys;
      const freshByKey = new Map<string, AuthoringLuaSourceDescriptor[]>();
      for (const descriptor of externalDescriptors(
        project,
        base.snapshot.scriptSourcePaths,
        changedTextSources,
        keys,
      )) {
        const descriptors = freshByKey.get(descriptor.contributionKey) ?? [];
        descriptors.push(descriptor);
        freshByKey.set(descriptor.contributionKey, descriptors);
      }
      const descriptorChanges = new Map<number, AuthoringLuaSourceDescriptor>();
      for (const key of keys) {
        const indexes = priorDescriptorIndex.indexesByContributionKey.get(key) ?? [];
        const fresh = freshByKey.get(key) ?? [];
        // Source membership/routing changes require rebuilding the descriptor indexes.
        if (indexes.length !== fresh.length) return null;
        for (let offset = 0; offset < indexes.length; offset += 1) {
          const index = indexes[offset]!;
          const previous = externalSourceDescriptors[index]!;
          const descriptor = fresh[offset]!;
          if (
            previous.sourcePath !== descriptor.sourcePath ||
            previous.sourceUrl !== descriptor.sourceUrl ||
            previous.sourceAssetId !== descriptor.sourceAssetId
          )
            return null;
          descriptorChanges.set(
            index,
            Object.freeze({
              ...descriptor,
              inlineText: descriptor.inlineText ?? previous.inlineText,
            }),
          );
        }
      }
      externalSourceDescriptors = overlayReadonlyArray(
        externalSourceDescriptors,
        descriptorChanges,
      );
    }
    if (changedTextSources.size > 0) {
      if (priorDescriptorIndex) {
        const descriptorChanges = new Map<number, AuthoringLuaSourceDescriptor>();
        for (const [sourcePath, text] of changedTextSources)
          for (const index of priorDescriptorIndex.indexesByProjectPath.get(sourcePath) ?? []) {
            const descriptor = externalSourceDescriptors[index]!;
            descriptorChanges.set(index, Object.freeze({ ...descriptor, inlineText: text }));
          }
        externalSourceDescriptors = overlayReadonlyArray(
          externalSourceDescriptors,
          descriptorChanges,
        );
      } else {
        externalSourceDescriptors = Object.freeze(
          externalSourceDescriptors.map((descriptor) => {
            const sourcePath = descriptor.sourceUrl.startsWith('project:/')
              ? descriptor.sourceUrl.slice('project:/'.length)
              : null;
            const text = sourcePath ? changedTextSources.get(sourcePath) : undefined;
            return text === undefined
              ? descriptor
              : Object.freeze({ ...descriptor, inlineText: text });
          }),
        );
      }
    }
    const snapshot: LoadedProjectWorkspaceSnapshot = Object.freeze({
      snapshotKind: 'loaded',
      projectRoot: base.snapshot.projectRoot,
      manifestPath: base.snapshot.manifestPath,
      project,
      workspaceRevision,
      sourceRevision: workspaceRevision,
      canonicalSourceFiles: base.snapshot.canonicalSourceFiles,
      fileRevisions,
      saveUnitFileOwnership: base.snapshot.saveUnitFileOwnership,
      externalSourceDescriptors,
      scriptSourcePaths: base.snapshot.scriptSourcePaths,
    });
    snapshotRevisionStates.set(snapshot, aggregate.state);
    this.snapshotExternalDescriptorIndexes.set(
      snapshot,
      priorDescriptorIndex ?? createSnapshotExternalDescriptorIndex(externalSourceDescriptors),
    );
    this.snapshotValidators.set(snapshot, () => validation.diagnostics);
    this.snapshotValidationStates.set(
      snapshot,
      priorValidationState && invalidValidationKeys && !semanticMembershipChanged
        ? advanceSnapshotValidationState(
            priorValidationState,
            validation.contributions,
            invalidValidationKeys,
          )
        : createSnapshotValidationState(validation.contributions),
    );
    this.snapshotSourceOwnerIndexes.set(snapshot, sourceOwnerPathIndex);
    if (priorAnalysis && incrementalDependencyKeys) {
      this.snapshotIncrementalDependencySeeds.set(snapshot, {
        base: priorAnalysis,
        contributionKeys: incrementalDependencyKeys,
        symbolProjection: this.snapshotLuaSymbolProjections.get(base.snapshot),
      });
    } else {
      const dependencyReuse = semanticMembershipChanged
        ? undefined
        : this.snapshotDependencyReuse.get(base.snapshot);
      if (dependencyReuse) {
        if (priorAnalysis) {
          const roots = [...impactedOwnerPaths].flatMap((path) =>
            findAuthoringDependencyOwnersByPath(priorAnalysis.graph, path),
          );
          for (const node of authoringDependencyReverseImpactClosure(
            priorAnalysis.graph,
            roots.map((node) => node.key),
          ))
            impactedOwnerPaths.add(node.owningPath);
        }
        const invalidContributionKeys = new Set(
          (dependencyReuse.contributions ?? [])
            .filter((contribution) =>
              [...impactedOwnerPaths].some((path) =>
                jsonPointersOverlap(path, contribution.ownerPath),
              ),
            )
            .map((contribution) => contribution.key),
        );
        this.snapshotDependencyReuse.set(snapshot, {
          contributions: dependencyReuse.contributions?.filter(
            (contribution) => !invalidContributionKeys.has(contribution.key),
          ),
          sourceAnalyses: dependencyReuse.sourceAnalyses
            ? new Map(
                [...dependencyReuse.sourceAnalyses].filter(
                  ([key]) => !invalidContributionKeys.has(key),
                ),
              )
            : undefined,
          externalSourceRevisions: dependencyReuse.externalSourceRevisions,
        });
      }
    }
    return withLazyOpenContent(
      {
        ok: true as const,
        snapshot,
        diagnostics: validation.diagnostics,
        editorState: project.editor,
        repairs: [],
        sourceContributions,
        validationContributions: validation.contributions,
        validationWork: validation.work,
        sourceWork: {
          authoredFilesReread: parsedJsonSources + readTextSources,
          parsedJsonSources,
          reusedJsonSources: 0,
          readTextSources,
          reusedTextSources: 0,
          projectedJsonSources,
          wholeProjectSchemaParses: 0,
          fullProjectTraversals: (priorRevisionState ? 0 : 1) + fullProjectTraversals,
          fullProjectProjections: 0,
          foregroundSerializations: 0,
          foregroundSerializedBytes: 0,
          localizationCoverageInputsChanged: localizationCoverageInputsChanged(
            changedPaths,
            base.snapshot.project,
            project,
          ),
        },
      },
      project,
    );
  }

  /**
   * Advance semantic products from a NovelTea-controlled committed snapshot without reopening the
   * Project. The committed projection is already schema-admitted by the mutation command; this
   * method rebuilds only source/validation products whose physical ownership changed.
   */
  advanceCommittedSnapshot(
    base: Extract<ProjectWorkspaceOpenResult, { ok: true }>,
    committedSnapshot: LoadedProjectWorkspaceSnapshot,
    changedPaths: readonly string[],
  ): ProjectWorkspaceOpenResult | null {
    if (base.snapshot.projectRoot !== committedSnapshot.projectRoot) return null;
    const sourceContributions = { ...base.sourceContributions };
    const changedOwnerPaths = new Map<string, readonly string[]>();
    let parsedJsonSources = 0;
    let readTextSources = 0;
    let projectedJsonSources = 0;

    for (const relativePath of [...new Set(changedPaths)].sort(
      compareProjectWorkspaceUnicodeCodePoints,
    )) {
      const prior = base.sourceContributions[relativePath];
      const text = projectWorkspaceFile(
        committedSnapshot.project,
        committedSnapshot.project.editor,
        committedSnapshot.scriptSourcePaths,
        relativePath,
      );
      const revision = committedSnapshot.fileRevisions[relativePath];
      if (text === undefined || !revision) {
        if (prior) changedOwnerPaths.set(relativePath, prior.ownerPaths);
        delete sourceContributions[relativePath];
        continue;
      }
      const ownerPaths = sourceContributionOwnerPaths(
        relativePath,
        committedSnapshot.scriptSourcePaths,
      );
      changedOwnerPaths.set(relativePath, ownerPaths);
      if (relativePath.endsWith('.json')) {
        parsedJsonSources += 1;
        projectedJsonSources += 1;
        sourceContributions[relativePath] = Object.freeze({
          path: relativePath,
          ...revision,
          kind: 'json' as const,
          parsed: JSON.parse(text) as unknown,
          schemaValid: true as const,
          ownerPaths,
          localDiagnostics: Object.freeze([]),
        });
      } else {
        readTextSources += 1;
        sourceContributions[relativePath] = Object.freeze({
          path: relativePath,
          ...revision,
          kind: 'text' as const,
          text,
          schemaValid: true as const,
          ownerPaths,
          localDiagnostics: Object.freeze([]),
        });
      }
    }

    const sourceOwnerPathIndex = buildSourceOwnerPathIndex(
      new Map(
        Object.entries(sourceContributions).map(([file, contribution]) => [
          file,
          contribution.ownerPaths,
        ]),
      ),
    );
    const semanticMembershipChanged =
      aggregateSemanticMembershipChanged(
        changedPaths,
        base.snapshot.project,
        committedSnapshot.project,
      ) ||
      changedPaths.some((path) => !base.sourceContributions[path] || !sourceContributions[path]);
    const validation = validateAdmittedAuthoringProject(committedSnapshot.project, {
      contributions: semanticMembershipChanged ? [] : base.validationContributions,
      ...(semanticMembershipChanged ? {} : { changedSourcePaths: new Set(changedPaths) }),
      resolveInputs: (paths) => {
        if (paths.some((path) => path === '/' || path === '/editor' || path.startsWith('/editor/')))
          return null;
        const resolvedFiles = new Set<string>();
        for (const path of paths) {
          const overlappingFiles = sourceOwnerPathIndex.overlappingFiles(path);
          for (const file of overlappingFiles) resolvedFiles.add(file);
          const collection = path.split('/')[1] ?? '';
          if (overlappingFiles.length === 0 && isAuthoringCollectionKey(collection)) {
            for (const file of sourceOwnerPathIndex.descendantFiles(`/${collection}`))
              resolvedFiles.add(file);
          } else if (overlappingFiles.length === 0) resolvedFiles.add('project.json');
        }
        return [...resolvedFiles].sort(compareProjectWorkspaceUnicodeCodePoints).map((path) => ({
          path,
          contentHash: committedSnapshot.fileRevisions[path]!.contentHash,
        }));
      },
    });
    const changedLocalDiagnostics = sourceLocalDiagnostics(
      validation.diagnostics,
      changedOwnerPaths,
    );
    for (const [relativePath, ownerPaths] of changedOwnerPaths) {
      const contribution = sourceContributions[relativePath];
      if (!contribution) continue;
      sourceContributions[relativePath] = Object.freeze({
        ...contribution,
        ownerPaths,
        localDiagnostics: Object.freeze([...(changedLocalDiagnostics.get(relativePath) ?? [])]),
      });
    }

    this.snapshotValidators.set(committedSnapshot, () => validation.diagnostics);
    this.snapshotValidationStates.set(
      committedSnapshot,
      createSnapshotValidationState(validation.contributions),
    );
    this.snapshotExternalDescriptorIndexes.set(
      committedSnapshot,
      createSnapshotExternalDescriptorIndex(committedSnapshot.externalSourceDescriptors),
    );
    this.snapshotSourceOwnerIndexes.set(committedSnapshot, sourceOwnerPathIndex);
    const dependencyReuse = semanticMembershipChanged
      ? undefined
      : this.snapshotDependencyReuse.get(base.snapshot);
    if (dependencyReuse) {
      const priorAnalysis = this.snapshotDependencyAnalysis.get(base.snapshot);
      const impactedOwnerPaths = new Set(changedOwnerPaths.values().flatMap((paths) => [...paths]));
      if (priorAnalysis) {
        const roots = [...impactedOwnerPaths].flatMap((path) =>
          findAuthoringDependencyOwnersByPath(priorAnalysis.graph, path),
        );
        for (const node of authoringDependencyReverseImpactClosure(
          priorAnalysis.graph,
          roots.map((node) => node.key),
        ))
          impactedOwnerPaths.add(node.owningPath);
      }
      const invalidContributionKeys = new Set(
        (dependencyReuse.contributions ?? [])
          .filter((contribution) =>
            [...impactedOwnerPaths].some((path) =>
              jsonPointersOverlap(path, contribution.ownerPath),
            ),
          )
          .map((contribution) => contribution.key),
      );
      this.snapshotDependencyReuse.set(committedSnapshot, {
        contributions: dependencyReuse.contributions?.filter(
          (contribution) => !invalidContributionKeys.has(contribution.key),
        ),
        sourceAnalyses: dependencyReuse.sourceAnalyses
          ? new Map(
              [...dependencyReuse.sourceAnalyses].filter(
                ([key]) => !invalidContributionKeys.has(key),
              ),
            )
          : undefined,
        externalSourceRevisions: dependencyReuse.externalSourceRevisions,
      });
    }

    return withLazyOpenContent(
      {
        ok: true as const,
        snapshot: committedSnapshot,
        diagnostics: validation.diagnostics,
        editorState: committedSnapshot.project.editor,
        repairs: [],
        sourceContributions: Object.freeze(sourceContributions),
        validationContributions: validation.contributions,
        validationWork: validation.work,
        sourceWork: {
          authoredFilesReread: 0,
          parsedJsonSources,
          reusedJsonSources: 0,
          readTextSources,
          reusedTextSources: 0,
          projectedJsonSources,
          wholeProjectSchemaParses: 0,
          fullProjectTraversals: 1,
          fullProjectProjections: 0,
          foregroundSerializations: 0,
          foregroundSerializedBytes: 0,
          localizationCoverageInputsChanged: localizationCoverageInputsChanged(
            changedPaths,
            base.snapshot.project,
            committedSnapshot.project,
          ),
        },
      },
      committedSnapshot.project,
    );
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
          const reusableSourceContributions = options.reusableSourceContributions ?? {};
          const textSourceValues = new Map<string, string>();
          const admittedSourcePaths = new Set<string>();
          const reusedJsonSourcePaths = new Set<string>();
          const freshJsonSourcePaths = new Set<string>();
          const sourceWork = {
            authoredFilesReread: 0,
            parsedJsonSources: 0,
            reusedJsonSources: 0,
            readTextSources: 0,
            reusedTextSources: 0,
            projectedJsonSources: 0,
            wholeProjectSchemaParses: 0,
            fullProjectTraversals: 1,
            fullProjectProjections: 0,
            foregroundSerializations: 0,
            foregroundSerializedBytes: 0,
            localizationCoverageInputsChanged: true,
          };
          let requiresFullSchemaParse = false;
          const reusableContribution = (relativePath: string) => {
            const contribution = reusableSourceContributions[relativePath];
            return contribution?.path === relativePath && contribution.schemaValid
              ? contribution
              : undefined;
          };
          const readJsonSource = async (relativePath: string): Promise<unknown> => {
            admittedSourcePaths.add(relativePath);
            const contribution = reusableContribution(relativePath);
            if (contribution?.kind === 'json') {
              sourceWork.reusedJsonSources++;
              reusedJsonSourcePaths.add(relativePath);
              const requiresMutableProjection =
                relativePath === 'project.json' ||
                /^records\/layouts\/[^/]+\/layout\.json$/u.test(relativePath) ||
                /^records\/scripts\/[^/]+\.json$/u.test(relativePath);
              return requiresMutableProjection
                ? structuredClone(contribution.parsed)
                : contribution.parsed;
            }
            sourceWork.authoredFilesReread++;
            sourceWork.parsedJsonSources++;
            freshJsonSourcePaths.add(relativePath);
            const absolute = this.fileSystem.joinPath(discovered.projectRoot, relativePath);
            await this.assertContained(discovered.projectRoot, absolute);
            return JSON.parse(await this.fileSystem.readText(absolute));
          };
          const parseJsonSource = async <Schema extends z.ZodType>(
            relativePath: string,
            schema: Schema,
          ): Promise<z.infer<Schema>> => {
            const value = await readJsonSource(relativePath);
            return reusedJsonSourcePaths.has(relativePath)
              ? (value as z.infer<Schema>)
              : schema.parse(value);
          };
          const readTextSource = async (relativePath: string): Promise<string> => {
            admittedSourcePaths.add(relativePath);
            const contribution = reusableContribution(relativePath);
            if (contribution?.kind === 'text') {
              sourceWork.reusedTextSources++;
              textSourceValues.set(relativePath, contribution.text);
              return contribution.text;
            }
            sourceWork.authoredFilesReread++;
            sourceWork.readTextSources++;
            const absolute = this.fileSystem.joinPath(discovered.projectRoot, relativePath);
            await this.assertContained(discovered.projectRoot, absolute);
            const text = await this.fileSystem.readText(absolute);
            textSourceValues.set(relativePath, text);
            return text;
          };
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
            const value = await readJsonSource('project.json');
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
          if (freshJsonSourcePaths.has('project.json')) {
            const parsedManifest = workspaceManifestSchema.safeParse(manifest);
            if (parsedManifest.success) manifest = parsedManifest.data;
            else requiresFullSchemaParse = true;
          }
          let traits: unknown;
          let localization: unknown;
          let editor: Record<string, unknown>;
          let trackedEditor: ReturnType<typeof parseTrackedEditorOrganization>;
          try {
            await this.assertContained(
              discovered.projectRoot,
              this.fileSystem.joinPath(discovered.projectRoot, 'traits.json'),
            );
            for (const file of [
              LOCALIZATION_POLICY_FILE,
              LOCALIZATION_MESSAGES_FILE,
              LOCALIZATION_USAGE_NOTES_FILE,
              LOCALIZATION_TRACKING_FILE,
              LOCALIZATION_ORPHANS_FILE,
            ])
              await this.assertContained(
                discovered.projectRoot,
                this.fileSystem.joinPath(discovered.projectRoot, file),
              );
            await this.assertContained(
              discovered.projectRoot,
              this.fileSystem.joinPath(discovered.projectRoot, 'editor.json'),
            );
            traits = await readJsonSource('traits.json');
            if (freshJsonSourcePaths.has('traits.json')) {
              const parsedTraits = traitsWorkspaceSchema.safeParse(traits);
              if (parsedTraits.success) traits = parsedTraits.data;
              else requiresFullSchemaParse = true;
            }
            const policy = await parseJsonSource(
              LOCALIZATION_POLICY_FILE,
              localizationPolicyFragmentSchema,
            );
            const messages = await parseJsonSource(
              LOCALIZATION_MESSAGES_FILE,
              localizationMessagesFragmentSchema,
            );
            const usageNotes = await parseJsonSource(
              LOCALIZATION_USAGE_NOTES_FILE,
              localizationUsageNotesFragmentSchema,
            );
            const sourceMessageTracking = await parseJsonSource(
              LOCALIZATION_TRACKING_FILE,
              localizationTrackingFragmentSchema,
            );
            const orphanedMessages = await parseJsonSource(
              LOCALIZATION_ORPHANS_FILE,
              localizationOrphansFragmentSchema,
            );
            const translations: Record<string, unknown> = {};
            const assets: Record<string, unknown> = {};
            const readLocaleChunks = async (
              directory: 'i18n/locales' | 'i18n/assets',
              schema: z.ZodType,
              target: Record<string, unknown>,
            ) => {
              const root = this.fileSystem.joinPath(discovered.projectRoot, directory);
              for (const entry of await this.fileSystem.listDirectory(root)) {
                if (!entry.endsWith('.json'))
                  throw new Error(`${directory} contains a non-JSON localization chunk.`);
                const locale = entry.slice(0, -5);
                if (!localeIdSchema.safeParse(locale).success)
                  throw new Error(`${directory} contains an invalid locale chunk '${entry}'.`);
                const absolute = this.fileSystem.joinPath(root, entry);
                await this.assertContained(discovered.projectRoot, absolute);
                const parsed = await parseJsonSource(`${directory}/${entry}`, schema);
                if (Object.keys(parsed as object).length === 0)
                  throw new Error(`${directory}/${entry} must not persist an empty sparse chunk.`);
                target[locale] = parsed;
              }
            };
            await readLocaleChunks('i18n/locales', localizationTranslationSchema, translations);
            await readLocaleChunks('i18n/assets', localizationAssetsLocaleFragmentSchema, assets);
            localization = {
              ...policy,
              ...messages,
              usageNotes,
              sourceMessageTracking,
              orphanedMessages,
              translations,
              assets,
            };
            if ([...freshJsonSourcePaths].some((file) => file.startsWith('i18n/'))) {
              const parsedLocalization = authoringLocalizationSchema.safeParse(localization);
              if (parsedLocalization.success) localization = parsedLocalization.data;
              else requiresFullSchemaParse = true;
            }
            const value = await readJsonSource('editor.json');
            if (!value || typeof value !== 'object' || Array.isArray(value))
              return fail('editor.json must be an object.', '/editor.json');
            editor = value as Record<string, unknown>;
            if (Object.keys(editor).sort().join(',') !== 'chapters,recordMetadata,tags')
              return fail(
                'editor.json must contain exactly tracked organization fields.',
                '/editor.json',
              );
            trackedEditor = reusedJsonSourcePaths.has('editor.json')
              ? (editor as NonNullable<ReturnType<typeof parseTrackedEditorOrganization>>)
              : parseTrackedEditorOrganization(editor);
            if (!trackedEditor)
              return fail('editor.json tracked organization fields are malformed.', '/editor.json');
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            return fail(`Required workspace fragments are missing or malformed: ${detail}`);
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
                  raw = (await readJsonSource(`records/layouts/${entry}/layout.json`)) as Record<
                    string,
                    unknown
                  >;
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
                const relativeRecordPath = `records/layouts/${entry}/layout.json`;
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
                      source.sourceText = await readTextSource(
                        `records/layouts/${entry}/layout.${channel}`,
                      );
                      source.sourceMode = 'inline';
                      if (channel !== 'lua') source.sourceAsset = null;
                    } catch {
                      return fail(
                        `Missing Layout ${channel.toUpperCase()} companion source.`,
                        `/records/layouts/${entry}/layout.${channel}`,
                      );
                    }
                  } else if (source.sourceMode === 'asset') {
                    if (channel === 'lua')
                      return fail(
                        'Layout Lua Asset sources are obsolete; use the Layout companion project file.',
                        `/layouts/${entry}/data/${channel}`,
                      );
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
                  } else
                    return fail(
                      'Layout source selector is unsupported.',
                      `/layouts/${entry}/data/${channel}`,
                    );
                }
                if (freshJsonSourcePaths.has(relativeRecordPath)) {
                  const parsedRecord = authoringRecordSchemas.layouts.safeParse(raw);
                  if (parsedRecord.success)
                    raw = parsedRecord.data as unknown as Record<string, unknown>;
                  else requiresFullSchemaParse = true;
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
                raw = (await readJsonSource(`records/${collection}/${entry}`)) as Record<
                  string,
                  unknown
                >;
              } catch {
                return fail('Record is malformed.', `/records/${collection}/${entry}`);
              }
              if (raw.id !== id)
                return fail(
                  'Record ID does not match its path.',
                  `/records/${collection}/${entry}`,
                );
              const relativeRecordPath = `records/${collection}/${entry}`;
              if (collection === 'scripts') {
                const source = (raw.data as { source?: { kind?: string; path?: unknown } }).source;
                if (source?.kind === 'project-file') {
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
                    await readTextSource(source.path);
                  } catch {
                    return fail(
                      'Script Module source file is missing.',
                      `/scripts/${id}/data/source/path`,
                    );
                  }
                } else if (source?.kind === 'inline-lua')
                  return fail(
                    'Script Module inline Lua must be persisted as a project-file source.',
                    `/scripts/${id}/data/source`,
                  );
              }
              if (freshJsonSourcePaths.has(relativeRecordPath)) {
                const parsedRecord = authoringRecordSchemas[collection].safeParse(raw);
                if (parsedRecord.success)
                  raw = parsedRecord.data as unknown as Record<string, unknown>;
                else requiresFullSchemaParse = true;
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
            undefinedInteractionProgram:
              authoringProjectSchema.shape.undefinedInteractionProgram.parse(undefined),
            prefetchHints: authoringProjectSchema.shape.prefetchHints.parse(undefined),
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
          migrateLegacyAssetMemoryPolicyPercentages((candidate as Record<string, unknown>).export);
          let decodedProject: AuthoringProject;
          if (reusedJsonSourcePaths.size > 0 && !requiresFullSchemaParse) {
            // Reused JSON contributions were projected from a previously normalized AuthoringProject.
            // Fresh JSON sources were normalized by their owning workspace/record schemas above, so
            // rebuilding from those fragments avoids reparsing unrelated unchanged sources.
            decodedProject = candidate as AuthoringProject;
          } else {
            sourceWork.wholeProjectSchemaParses++;
            const decoded = authoringProjectSchema.safeParse(candidate);
            if (!decoded.success)
              return complete({
                ok: false,
                projectRoot: discovered.projectRoot,
                manifestPath: discovered.manifestPath,
                diagnostics: validateAuthoringProject(candidate),
              });
            decodedProject = decoded.data;
          }
          // Preserve the separately validated tracked editor organization instead of relying on
          // nested dynamic-record normalization to reconstruct it.
          decodedProject.editor.chapters = trackedEditor.chapters;
          decodedProject.editor.tags = trackedEditor.tags;
          decodedProject.editor.recordMetadata = trackedEditor.recordMetadata;
          try {
            // Validate Asset source paths here, but do not make binary Asset bytes part of the
            // authoring workspace revision inventory. Asset integrity has its own exact-byte
            // boundaries and changed-Asset watcher flow.
            assetSourcePaths(decodedProject);
          } catch (error) {
            return fail(error instanceof Error ? error.message : 'Asset source path is invalid.');
          }
          const canonicalSourceFiles = [...admittedSourcePaths].sort(
            compareProjectWorkspaceUnicodeCodePoints,
          );
          const fileRevisions: Record<string, ProjectWorkspaceFileRevision> = {};
          for (const file of canonicalSourceFiles) {
            const reused = reusableContribution(file);
            const revision = reused
              ? { contentHash: reused.contentHash, byteSize: reused.byteSize }
              : await readWorkspaceFileRevision(this.fileSystem, discovered.projectRoot, file);
            if (revision === null)
              return fail(`Authoritative source file '${file}' is missing.`, `/${file}`);
            fileRevisions[file] = revision;
          }
          const saveUnitFileOwnership = ownershipFor(decodedProject, scriptSourcePaths);
          const ownerPathsByFile = new Map<string, readonly string[]>();
          for (const file of canonicalSourceFiles)
            ownerPathsByFile.set(
              file,
              Object.freeze(
                [...sourceContributionOwnerPaths(file, scriptSourcePaths)].sort(
                  compareProjectWorkspaceUnicodeCodePoints,
                ),
              ),
            );
          const sourceOwnerPathIndex = buildSourceOwnerPathIndex(ownerPathsByFile);
          const validationReuse: AuthoringValidationReuse = {
            contributions: options.reusableValidationContributions ?? [],
            resolveInputs: (paths) => {
              // Local editor state is intentionally outside disk-authoritative cache generations.
              if (
                paths.some(
                  (path) => path === '/' || path === '/editor' || path.startsWith('/editor/'),
                )
              )
                return null;
              const files = new Set<string>();
              for (const path of paths) {
                const overlappingFiles = sourceOwnerPathIndex.overlappingFiles(path);
                for (const file of overlappingFiles) files.add(file);
                const collection = path.split('/')[1] ?? '';
                if (overlappingFiles.length === 0 && isAuthoringCollectionKey(collection)) {
                  for (const file of sourceOwnerPathIndex.descendantFiles(`/${collection}`))
                    files.add(file);
                } else if (overlappingFiles.length === 0) {
                  files.add('project.json');
                }
              }
              return [...files].sort(compareProjectWorkspaceUnicodeCodePoints).map((path) => ({
                path,
                contentHash: fileRevisions[path]!.contentHash,
              }));
            },
          };
          const validation = validateAdmittedAuthoringProject(decodedProject, validationReuse);
          const validationDiagnostics = validation.diagnostics;
          const localDiagnosticsByFile = sourceLocalDiagnostics(
            validationDiagnostics,
            ownerPathsByFile,
          );
          const sourceContributions: Record<string, ProjectWorkspaceSourceContribution> = {};
          for (const file of canonicalSourceFiles) {
            const revision = fileRevisions[file]!;
            const ownerPaths = ownerPathsByFile.get(file) ?? [];
            const reused = reusableContribution(file);
            const localDiagnostics = reused
              ? reused.localDiagnostics
              : Object.freeze([...(localDiagnosticsByFile.get(file) ?? [])]);
            if (file.endsWith('.json')) {
              let parsed: unknown;
              if (reused?.kind === 'json') parsed = reused.parsed;
              else {
                sourceWork.projectedJsonSources++;
                const normalizedText = projectWorkspaceFile(
                  decodedProject,
                  decodedProject.editor,
                  scriptSourcePaths,
                  file,
                );
                if (normalizedText === undefined)
                  return fail(`Authoritative source file '${file}' was not projected.`, `/${file}`);
                parsed = JSON.parse(normalizedText) as unknown;
              }
              sourceContributions[file] = Object.freeze({
                path: file,
                contentHash: revision.contentHash,
                byteSize: revision.byteSize,
                kind: 'json' as const,
                parsed,
                schemaValid: true as const,
                ownerPaths,
                localDiagnostics,
              });
            } else {
              const text = textSourceValues.get(file);
              if (text === undefined)
                return fail(`Authoritative source file '${file}' was not read.`, `/${file}`);
              sourceContributions[file] = Object.freeze({
                path: file,
                contentHash: revision.contentHash,
                byteSize: revision.byteSize,
                kind: 'text' as const,
                text,
                schemaValid: true as const,
                ownerPaths,
                localDiagnostics,
              });
            }
          }
          const aggregate = await aggregateRevisionState(fileRevisions);
          const workspaceRevision = aggregate.revision;
          const contentProject = stripEditorProjectState(decodedProject);
          const snapshot: LoadedProjectWorkspaceSnapshot = Object.freeze({
            snapshotKind: 'loaded',
            projectRoot: discovered.projectRoot,
            manifestPath: discovered.manifestPath,
            project: decodedProject,
            workspaceRevision,
            sourceRevision: workspaceRevision,
            canonicalSourceFiles: Object.freeze(canonicalSourceFiles),
            // canonicalSourceFiles is already sorted, and fileRevisions is populated
            // in that order, so preserve it without a redundant reconstruction.
            fileRevisions: Object.freeze(fileRevisions),
            saveUnitFileOwnership,
            externalSourceDescriptors: externalDescriptors(
              decodedProject,
              scriptSourcePaths,
              textSourceValues,
            ),
            scriptSourcePaths: Object.freeze(sortKeys(scriptSourcePaths)),
          });
          snapshotRevisionStates.set(snapshot, aggregate.state);
          this.snapshotExternalDescriptorIndexes.set(
            snapshot,
            createSnapshotExternalDescriptorIndex(snapshot.externalSourceDescriptors),
          );
          // Workspace admission has already run the authoritative semantic validation over this
          // exact admitted Project generation. Compiler/preflight callers consume that immutable
          // diagnostic product instead of rerunning the same Project-wide checks under a second
          // namespace.
          this.snapshotValidators.set(snapshot, () => validationDiagnostics);
          this.snapshotValidationStates.set(
            snapshot,
            createSnapshotValidationState(validation.contributions),
          );
          this.snapshotSourceOwnerIndexes.set(snapshot, sourceOwnerPathIndex);
          if (options.reusableDependencyState)
            this.snapshotDependencyReuse.set(snapshot, options.reusableDependencyState);
          const result: ProjectWorkspaceOpenResult = {
            ok: true,
            snapshot,
            diagnostics: validationDiagnostics,
            editorState: decodedProject.editor,
            repairs: [],
            contentProject,
            savedContentProject: contentProject,
            sourceContributions: Object.freeze(sortKeys(sourceContributions)),
            validationContributions: validation.contributions,
            validationWork: validation.work,
            sourceWork,
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
    const affectedCandidates = options.affectedPaths
      ? this.affectedWorkspaceFiles(
          openedSnapshot,
          project,
          projectedSourcePaths,
          options.affectedPaths,
        )
      : null;
    const explicitCandidates = options.targetFiles ?? affectedCandidates;
    const fullProjection = explicitCandidates
      ? null
      : projectWorkspaceFiles(project, editorState, projectedSourcePaths);
    const candidates = new Set(
      explicitCandidates ?? [
        ...openedSnapshot.canonicalSourceFiles,
        ...Object.keys(fullProjection!),
      ],
    );
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
      const currentText = await this.fileSystem
        .readText(this.fileSystem.joinPath(projectRoot, file))
        .catch(() => null);
      const nextText =
        (fullProjection
          ? fullProjection[file]
          : projectWorkspaceFile(project, editorState, projectedSourcePaths, file)) ?? null;
      if (currentText === nextText) continue;
      const expectedRevision = expected[file] ?? PROJECT_WORKSPACE_ABSENT_REVISION;
      targets.push(
        nextText === null
          ? { path: file, operation: 'delete', expectedRevision }
          : utf8WorkspaceTransactionTarget(file, expectedRevision, nextText),
      );
    }
    targets.push(...(options.extraTargets ?? []));
    let projectedSnapshot: LoadedProjectWorkspaceSnapshot | null = null;
    if (options.refreshAfterCommit === false) {
      const canonicalSourceFileSet = fullProjection
        ? new Set(Object.keys(fullProjection))
        : new Set(openedSnapshot.canonicalSourceFiles);
      if (!fullProjection)
        for (const file of candidates) {
          const nextText = projectWorkspaceFile(project, editorState, projectedSourcePaths, file);
          if (nextText === undefined) canonicalSourceFileSet.delete(file);
          else canonicalSourceFileSet.add(file);
        }
      const canonicalSourceFiles = [...canonicalSourceFileSet].sort(
        compareProjectWorkspaceUnicodeCodePoints,
      );
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
      const aggregate = await aggregateRevisionState(fileRevisions);
      const workspaceRevision = aggregate.revision;
      projectedSnapshot = Object.freeze({
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
      snapshotRevisionStates.set(projectedSnapshot, aggregate.state);
      await options.admitCandidateBeforeCommit?.(projectedSnapshot);
    }
    if (targets.length > 0) {
      await this.transactions.commit(projectRoot, {
        transactionId: options.transactionId,
        operationLabel: options.operationLabel ?? 'project save',
        targets,
      });
    }
    if (projectedSnapshot) {
      // The active editor session must advance remaining dirty units' per-file recovery baselines
      // against the committed snapshot before persisting local state, so its caller owns that one
      // final local-state write in this branch.
      return withLazyWriteContent(
        {
          workspaceRevision: projectedSnapshot.workspaceRevision,
          snapshot: projectedSnapshot,
        },
        project,
      );
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
  preflightCompiledArtifact(snapshot: ProjectWorkspaceSnapshot): AuthoringPreflightResult {
    return preflightAdmittedAuthoringProject(
      snapshot.project,
      this.snapshotValidators.get(snapshot),
    );
  }
  publishCompiledArtifact(snapshot: ProjectWorkspaceSnapshot): CompiledArtifactPublicationResult {
    return publishCompiledArtifact(snapshot.project, this.snapshotValidators.get(snapshot));
  }
  buildDependencyGraph(snapshot: ProjectWorkspaceSnapshot): Promise<AuthoringDependencyGraph> {
    return buildAuthoringDependencyGraph(snapshot.project);
  }
  async buildDependencyGraphAnalysis(
    snapshot: ProjectWorkspaceSnapshot,
  ): Promise<ProjectWorkspaceDependencyAnalysis> {
    const cached = this.snapshotDependencyAnalysis.get(snapshot);
    if (cached) return cached;

    const incrementalSeed = this.snapshotIncrementalDependencySeeds.get(snapshot);
    if (incrementalSeed) {
      const changedKeys = incrementalSeed.contributionKeys;
      const sourceSnapshot = await buildWorkspaceSourceAnalysisSnapshot(
        this.fileSystem,
        snapshot,
        changedKeys,
      );
      const freshAnalyses =
        changedKeys.size > 0
          ? await this.analyzeSources(snapshot, sourceSnapshot.sources, undefined, changedKeys)
          : new Map<
              string,
              readonly AuthoringSourceAnalysisArtifact<AuthoringDependencyGraphDiagnostic>[]
            >();
      const descriptorsByKey = new Map<string, AuthoringLuaSourceDescriptor[]>();
      const sourcePathChanges = new Map<string, readonly string[]>();
      for (const descriptor of descriptorsForContributionKeys(snapshot, changedKeys)) {
        const values = descriptorsByKey.get(descriptor.contributionKey) ?? [];
        values.push(descriptor);
        descriptorsByKey.set(descriptor.contributionKey, values);
      }
      for (const key of changedKeys) {
        const paths = new Set<string>();
        for (const descriptor of descriptorsByKey.get(key) ?? [])
          if (descriptor.sourceUrl.startsWith('project:/'))
            paths.add(descriptor.sourceUrl.slice('project:/'.length));
        sourcePathChanges.set(
          key,
          Object.freeze([...paths].sort(compareProjectWorkspaceUnicodeCodePoints)),
        );
      }

      const analysisChanges = new Map<
        string,
        readonly AuthoringSourceAnalysisArtifact<AuthoringDependencyGraphDiagnostic>[]
      >();
      const replacements: AuthoringDependencyGraphContribution[] = [];
      const removed: string[] = [];
      for (const key of changedKeys) {
        const analyses = freshAnalyses.get(key) ?? [];
        analysisChanges.set(key, analyses);
        const contribution = deriveAuthoringDependencyContributionFromPrepared(
          snapshot.project,
          key,
          descriptorsByKey.get(key) ?? [],
          analyses,
          true,
          undefined,
          incrementalSeed.symbolProjection,
        );
        if (contribution) replacements.push(contribution);
        else removed.push(key);
      }
      const contributions = replaceAuthoringDependencyGraphContributions(
        incrementalSeed.base.contributions,
        replacements,
        removed,
      );
      const graph = patchAuthoringDependencyGraph(
        incrementalSeed.base.graph,
        incrementalSeed.base.contributions,
        contributions,
        changedKeys,
      );
      if (graph) {
        const removedKeys = new Set(removed);
        const sourceAnalyses = overlayReadonlyMap(
          incrementalSeed.base.sourceAnalyses,
          analysisChanges,
          removedKeys,
        );
        const sourcePathsByContributionKey = overlayReadonlyMap(
          incrementalSeed.base.sourcePathsByContributionKey,
          sourcePathChanges,
          removedKeys,
        );
        const externalRevisionChanges = new Map(sourceSnapshot.externalSourceRevisions);
        const externalSourceRevisions = overlayReadonlyMap(
          incrementalSeed.base.externalSourceRevisions,
          externalRevisionChanges,
        );
        const result: ProjectWorkspaceDependencyAnalysis = {
          graph,
          contributions,
          sourceAnalyses,
          sourcePathsByContributionKey,
          externalSourceRevisions,
          work: {
            derivedContributions: replacements.length,
            reusedContributions: Math.max(0, contributions.byKey.size - replacements.length),
            analyzedOwners: freshAnalyses.size,
            reusedSourceAnalyses: Math.max(0, sourceAnalyses.size - analysisChanges.size),
            fullProjectTraversals: 0,
          },
        };
        this.snapshotDependencyAnalysis.set(snapshot, result);
        if (incrementalSeed.symbolProjection)
          this.snapshotLuaSymbolProjections.set(snapshot, incrementalSeed.symbolProjection);
        return result;
      }
    }

    const reusable = this.snapshotDependencyReuse.get(snapshot);
    const contributionKeys = enumerateAuthoringDependencyContributionKeys(snapshot.project);
    const currentKeys = new Set(contributionKeys);
    const reusableContributions = new Map(
      (reusable?.contributions ?? [])
        .filter((contribution) => currentKeys.has(contribution.key))
        .map((contribution) => [contribution.key, contribution]),
    );
    const reusableAnalyses = new Map(
      [...(reusable?.sourceAnalyses ?? new Map())].filter(([key]) => currentKeys.has(key)),
    );
    const missingKeys = new Set(contributionKeys.filter((key) => !reusableContributions.has(key)));
    const analysesToRun = new Set([...missingKeys].filter((key) => !reusableAnalyses.has(key)));
    const sourceSnapshot = await buildWorkspaceSourceAnalysisSnapshot(
      this.fileSystem,
      snapshot,
      analysesToRun,
    );
    const freshAnalyses =
      analysesToRun.size > 0
        ? await this.analyzeSources(snapshot, sourceSnapshot.sources, undefined, analysesToRun)
        : new Map<
            string,
            readonly AuthoringSourceAnalysisArtifact<AuthoringDependencyGraphDiagnostic>[]
          >();
    const analyses = new Map(reusableAnalyses);
    for (const [key, value] of freshAnalyses) analyses.set(key, value);
    const descriptorsByKey = new Map<string, AuthoringLuaSourceDescriptor[]>();
    const sourcePathsByContributionKey = new Map<string, Set<string>>();
    for (const descriptor of snapshot.externalSourceDescriptors) {
      const values = descriptorsByKey.get(descriptor.contributionKey) ?? [];
      values.push(descriptor);
      descriptorsByKey.set(descriptor.contributionKey, values);
      if (descriptor.sourceUrl.startsWith('project:/')) {
        const paths = sourcePathsByContributionKey.get(descriptor.contributionKey) ?? new Set();
        paths.add(descriptor.sourceUrl.slice('project:/'.length));
        sourcePathsByContributionKey.set(descriptor.contributionKey, paths);
      }
    }
    const symbolProjection = buildAuthoringLuaSymbolProjection(snapshot.project);
    const derived: AuthoringDependencyGraphContribution[] = [];
    const allContributions = contributionKeys.map((contributionKey) => {
      const reused = reusableContributions.get(contributionKey);
      if (reused) return reused;
      const contribution = deriveAuthoringDependencyContributionFromPrepared(
        snapshot.project,
        contributionKey,
        descriptorsByKey.get(contributionKey) ?? [],
        analyses.get(contributionKey) ?? [],
        true,
        undefined,
        symbolProjection,
      );
      if (!contribution)
        throw new Error(`Unable to derive graph contribution '${contributionKey}'.`);
      derived.push(contribution);
      return contribution;
    });
    const contributions = createAuthoringDependencyGraphContributionSet(allContributions);
    const externalSourceRevisions = new Map(reusable?.externalSourceRevisions ?? []);
    for (const [path, revision] of sourceSnapshot.externalSourceRevisions)
      externalSourceRevisions.set(path, revision);
    this.snapshotDependencyReuse.set(snapshot, {
      contributions: Object.freeze([...contributions.byKey.values()]),
      sourceAnalyses: analyses,
      externalSourceRevisions,
    });
    const result: ProjectWorkspaceDependencyAnalysis = {
      graph: assembleAuthoringDependencyGraph(contributions),
      contributions,
      sourceAnalyses: analyses,
      sourcePathsByContributionKey: new Map(
        [...sourcePathsByContributionKey.entries()].map(([key, paths]) => [
          key,
          Object.freeze([...paths].sort(compareProjectWorkspaceUnicodeCodePoints)),
        ]),
      ),
      externalSourceRevisions,
      work: {
        derivedContributions: derived.length,
        reusedContributions: reusableContributions.size,
        analyzedOwners: freshAnalyses.size,
        reusedSourceAnalyses: reusableAnalyses.size,
        fullProjectTraversals: 1,
      },
    };
    this.snapshotDependencyAnalysis.set(snapshot, result);
    this.snapshotLuaSymbolProjections.set(snapshot, symbolProjection);
    return result;
  }
  async buildDependencyGraphWithSources(
    snapshot: ProjectWorkspaceSnapshot,
  ): Promise<AuthoringDependencyGraph> {
    return (await this.buildDependencyGraphAnalysis(snapshot)).graph;
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
    ? descriptorsForContributionKeys(snapshot, contributionKeys)
    : snapshot.externalSourceDescriptors;
export const buildProjectWorkspaceSearchIndex = (snapshot: ProjectWorkspaceSnapshot) =>
  buildProjectSearchIndex(snapshot.project, {
    externalSources: externalSearchSources(snapshot.project, snapshot.externalSourceDescriptors),
  });
