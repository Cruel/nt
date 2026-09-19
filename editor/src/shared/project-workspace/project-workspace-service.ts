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
  createAuthoringDependencyGraphContributionSet,
  deriveAuthoringDependencyContributionFromPrepared,
  enumerateAuthoringDependencyContributionKeys,
  findAuthoringDependencyOwnersByPath,
} from '../authoring-dependency-graph';
import type {
  AuthoringDependencyGraph,
  AuthoringDependencyGraphContribution,
  AuthoringDependencyGraphContributionSet,
  AuthoringDependencyGraphDiagnostic,
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
import { escapeJsonPointerSegment } from '../json-pointer';
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
  readonly parsedJsonSources: number;
  readonly reusedJsonSources: number;
  readonly readTextSources: number;
  readonly reusedTextSources: number;
  readonly projectedJsonSources: number;
  readonly wholeProjectSchemaParses: number;
}

export interface ProjectWorkspaceDependencyWork {
  readonly derivedContributions: number;
  readonly reusedContributions: number;
  readonly analyzedOwners: number;
  readonly reusedSourceAnalyses: number;
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

async function buildWorkspaceSourceAnalysisSnapshot(
  fileSystem: ProjectWorkspaceFileSystem,
  snapshot: ProjectWorkspaceSnapshot,
  contributionKeys?: ReadonlySet<string>,
): Promise<{
  sources: LuaSourceSnapshot<AuthoringDependencyGraphDiagnostic>;
  externalSourceRevisions: ReadonlyMap<string, ProjectWorkspaceFileRevision>;
}> {
  const entries = new Map<string, LuaSourceSnapshotEntry<AuthoringDependencyGraphDiagnostic>>();
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
  return {
    sources: { entriesByAssetId: entries },
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

function projectWorkspaceFile(
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
  if (translation)
    return canonicalJson(
      project.localization.translations[translation[1]!] ?? {},
      localizationTranslationSchema,
    );
  const localizedAssets = /^i18n\/assets\/([^/]+)\.json$/u.exec(file);
  if (localizedAssets)
    return canonicalJson(
      project.localization.assets[localizedAssets[1]!] ?? {},
      localizationAssetsLocaleFragmentSchema,
    );
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
  /** Semantic mutation ownership used by resident-session dependency safety. */
  readonly saveUnitIds?: readonly string[];
  readonly affectedPaths?: readonly string[];
  readonly preflightSnapshot?: LoadedProjectWorkspaceSnapshot;
  /** Active editor sessions already own coherent state and can adopt the committed projection. */
  readonly refreshAfterCommit?: boolean;
}

export class ProjectWorkspaceService {
  private readonly snapshotValidators = new WeakMap<
    ProjectWorkspaceSnapshot,
    (project: AuthoringProject) => readonly ProjectValidationDiagnostic[]
  >();
  private readonly snapshotDependencyReuse = new WeakMap<
    ProjectWorkspaceSnapshot,
    ProjectWorkspaceReusableDependencyState
  >();
  private readonly snapshotDependencyAnalysis = new WeakMap<
    ProjectWorkspaceSnapshot,
    ProjectWorkspaceDependencyAnalysis
  >();
  private readonly snapshotSourceOwnerIndexes = new WeakMap<
    ProjectWorkspaceSnapshot,
    SourceOwnerPathIndex
  >();
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
  async reconcileExistingSources(
    base: Extract<ProjectWorkspaceOpenResult, { ok: true }>,
    changedPaths: readonly string[],
  ): Promise<ProjectWorkspaceOpenResult | null> {
    if (changedPaths.length === 0) return base;
    let project = base.snapshot.project;
    const fileRevisions = { ...base.snapshot.fileRevisions };
    const sourceContributions = { ...base.sourceContributions };
    const changedOwnerPaths = new Map<string, readonly string[]>();
    const changedTextSources = new Map<string, string>();
    let parsedJsonSources = 0;
    let readTextSources = 0;

    for (const relativePath of [...new Set(changedPaths)].sort(
      compareProjectWorkspaceUnicodeCodePoints,
    )) {
      if (!base.sourceContributions[relativePath]) return null;
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
        const scriptSourceId = Object.entries(base.snapshot.scriptSourcePaths).find(
          ([, sourcePath]) => sourcePath === relativePath,
        )?.[0];

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
              translations: { ...project.localization.translations, [locale]: parsed.data },
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
              assets: { ...project.localization.assets, [locale]: parsed.data },
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
            if (!prior || source?.kind !== 'file' || source.path !== priorPath) return null;
            const priorSource = prior.data.source;
            if (priorSource.kind !== 'inline-lua') return null;
            (raw.data as { source: unknown }).source = {
              kind: 'inline-lua',
              source: priorSource.source,
            };
          }
          const parsed = authoringRecordSchemas[collection].safeParse(raw);
          if (!parsed.success || parsed.data.id !== id) return null;
          project = {
            ...project,
            [collection]: { ...project[collection], [id]: parsed.data },
          } as AuthoringProject;
        } else if (layoutSourceMatch) {
          const id = layoutSourceMatch[1]!;
          const channel = layoutSourceMatch[2] as 'rml' | 'rcss' | 'lua';
          const prior = project.layouts[id];
          if (!prior || prior.data[channel].sourceMode !== 'inline') return null;
          project = {
            ...project,
            layouts: {
              ...project.layouts,
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
          };
        } else if (scriptSourceId) {
          const prior = project.scripts[scriptSourceId];
          if (!prior || prior.data.source.kind !== 'inline-lua') return null;
          project = {
            ...project,
            scripts: {
              ...project.scripts,
              [scriptSourceId]: {
                ...prior,
                data: { ...prior.data, source: { kind: 'inline-lua', source: text } },
              },
            },
          };
        } else return null;

        fileRevisions[relativePath] = revision;
        const ownerPaths = sourceContributionOwnerPaths(
          relativePath,
          base.snapshot.scriptSourcePaths,
        );
        changedOwnerPaths.set(relativePath, ownerPaths);
        if (relativePath.endsWith('.json')) {
          parsedJsonSources += 1;
          const normalizedText = projectWorkspaceFile(
            project,
            project.editor,
            base.snapshot.scriptSourcePaths,
            relativePath,
          );
          if (normalizedText === undefined) return null;
          sourceContributions[relativePath] = Object.freeze({
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
      } catch {
        return null;
      }
    }

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
    const validation = validateAdmittedAuthoringProject(project, {
      contributions: base.validationContributions,
      changedSourcePaths: new Set(changedPaths),
      resolveInputs: (paths) => {
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
      },
    });
    const changedLocalDiagnostics = sourceLocalDiagnostics(
      validation.diagnostics,
      changedOwnerPaths,
    );
    for (const [relativePath, ownerPaths] of changedOwnerPaths) {
      const contribution = sourceContributions[relativePath]!;
      sourceContributions[relativePath] = Object.freeze({
        ...contribution,
        ownerPaths,
        localDiagnostics: Object.freeze([...(changedLocalDiagnostics.get(relativePath) ?? [])]),
      });
    }

    const workspaceRevision = await aggregateRevision(fileRevisions);
    const snapshot: LoadedProjectWorkspaceSnapshot = Object.freeze({
      snapshotKind: 'loaded',
      projectRoot: base.snapshot.projectRoot,
      manifestPath: base.snapshot.manifestPath,
      project,
      workspaceRevision,
      sourceRevision: workspaceRevision,
      canonicalSourceFiles: base.snapshot.canonicalSourceFiles,
      fileRevisions: Object.freeze(fileRevisions),
      saveUnitFileOwnership: base.snapshot.saveUnitFileOwnership,
      externalSourceDescriptors: Object.freeze(
        base.snapshot.externalSourceDescriptors.map((descriptor) => {
          const sourcePath = descriptor.sourceUrl.startsWith('project:/')
            ? descriptor.sourceUrl.slice('project:/'.length)
            : null;
          const text = sourcePath ? changedTextSources.get(sourcePath) : undefined;
          return text === undefined
            ? descriptor
            : Object.freeze({ ...descriptor, inlineText: text });
        }),
      ),
      scriptSourcePaths: base.snapshot.scriptSourcePaths,
    });
    this.snapshotValidators.set(snapshot, () => validation.diagnostics);
    this.snapshotSourceOwnerIndexes.set(snapshot, sourceOwnerPathIndex);
    const dependencyReuse = this.snapshotDependencyReuse.get(base.snapshot);
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
    const contentProject = stripEditorProjectState(project);
    return {
      ok: true,
      snapshot,
      diagnostics: validation.diagnostics,
      editorState: project.editor,
      repairs: [],
      contentProject,
      savedContentProject: contentProject,
      sourceContributions: Object.freeze(sourceContributions),
      validationContributions: validation.contributions,
      validationWork: validation.work,
      sourceWork: {
        parsedJsonSources,
        reusedJsonSources: 0,
        readTextSources,
        reusedTextSources: 0,
        projectedJsonSources: 0,
        wholeProjectSchemaParses: 0,
      },
    };
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
    const files = projectWorkspaceFiles(
      committedSnapshot.project,
      committedSnapshot.project.editor,
      committedSnapshot.scriptSourcePaths,
    );
    const sourceContributions = { ...base.sourceContributions };
    const changedOwnerPaths = new Map<string, readonly string[]>();
    let parsedJsonSources = 0;
    let readTextSources = 0;

    for (const relativePath of [...new Set(changedPaths)].sort(
      compareProjectWorkspaceUnicodeCodePoints,
    )) {
      const prior = base.sourceContributions[relativePath];
      const text = files[relativePath];
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
    const validation = validateAdmittedAuthoringProject(committedSnapshot.project, {
      contributions: base.validationContributions,
      changedSourcePaths: new Set(changedPaths),
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
    this.snapshotSourceOwnerIndexes.set(committedSnapshot, sourceOwnerPathIndex);
    const dependencyReuse = this.snapshotDependencyReuse.get(base.snapshot);
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

    const contentProject = stripEditorProjectState(committedSnapshot.project);
    return {
      ok: true,
      snapshot: committedSnapshot,
      diagnostics: validation.diagnostics,
      editorState: committedSnapshot.project.editor,
      repairs: [],
      contentProject,
      savedContentProject: contentProject,
      sourceContributions: Object.freeze(sourceContributions),
      validationContributions: validation.contributions,
      validationWork: validation.work,
      sourceWork: {
        parsedJsonSources,
        reusedJsonSources: 0,
        readTextSources,
        reusedTextSources: 0,
        projectedJsonSources: 0,
        wholeProjectSchemaParses: 0,
      },
    };
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
            parsedJsonSources: 0,
            reusedJsonSources: 0,
            readTextSources: 0,
            reusedTextSources: 0,
            projectedJsonSources: 0,
            wholeProjectSchemaParses: 0,
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
                    text = await readTextSource(source.path);
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
          const workspaceRevision = await aggregateRevision(fileRevisions);
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
            externalSourceDescriptors: externalDescriptors(decodedProject, scriptSourcePaths),
            scriptSourcePaths: Object.freeze(sortKeys(scriptSourcePaths)),
          });
          // Workspace admission has already run the authoritative semantic validation over this
          // exact admitted Project generation. Compiler/preflight callers consume that immutable
          // diagnostic product instead of rerunning the same Project-wide checks under a second
          // namespace.
          this.snapshotValidators.set(snapshot, () => validationDiagnostics);
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
      },
    };
    this.snapshotDependencyAnalysis.set(snapshot, result);
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
    ? snapshot.externalSourceDescriptors.filter((descriptor) =>
        contributionKeys.has(descriptor.contributionKey),
      )
    : snapshot.externalSourceDescriptors;
export const buildProjectWorkspaceSearchIndex = (snapshot: ProjectWorkspaceSnapshot) =>
  buildProjectSearchIndex(snapshot.project, {
    externalSources: externalSearchSources(snapshot.project, snapshot.externalSourceDescriptors),
  });
